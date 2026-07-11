// M16 — the Coordinator (Akhil: "a smart coordinator that controls the entire
// system... watches quotas, service health, stuck tasks... proactively tells
// me when something needs attention"). Same thin-build style as the scheduler
// (ADR-0010): a pure-ish `tick(pool, opts)`, timers just call it, tests inject
// `now` — every guarantee is provable deterministically with zero model quota.
//
// AUTHORITY BOUNDARY (Akhil's explicit choice, 2026-07-11 — "the smart
// coordinator", not the emergency-override version): the Coordinator watches
// and can retry/reroute/notify, but it NEVER bypasses the trust gate. Its only
// "action" is re-invoking the SAME durable resume path boot-resume already
// trusts (checkpoint/plan continuation — any approval-gated step inside a
// resumed task still queues exactly as before); everything else it does is
// pure observation + notification. It cannot approve a pending_action, cannot
// spend, cannot send. If this boundary is ever revisited, that is a deliberate
// product decision, not a default to slide into.
//
// Four watches per tick:
//  1. STUCK tasks — running/planning with no observable progress for a while.
//     Unlike boot-resume (every running/planning row IS orphaned — the
//     process just restarted), a LIVE task might just be legitimately slow
//     (multi-round rate-limit backoff has been observed taking several
//     minutes) — the time threshold is what tells "stuck" from "working".
//     Resume is DELEGATED (opts.resumeStuckTask) — this module doesn't know
//     about pack registries or agent/graph/plain routing, exactly like the
//     scheduler doesn't know what a "briefing" is.
//  2. PROVIDER health — recent task failures shaped like provider exhaustion
//     (isRateLimitPressure, shared with jobs.ts's actExecutor) crossing a
//     threshold in a rolling window → "the model provider looks degraded".
//  3. APPROVAL backlog — pending_actions sitting unattended a while →
//     reminder only; the Coordinator cannot decide these, only surface them.
//  4. JOB failure streaks — a scheduled automation failing repeatedly →
//     reminder only; the scheduler already owns retry/backoff.
import type pg from 'pg';
import { newTraceId, TraceStore } from '@ai-os/shared';
import { isRateLimitPressure } from './agents.js';

export interface StuckTaskFinding {
  id: string;
  goal: string;
  status: string;
  minutesStuck: number;
}
export interface ApprovalBacklogFinding {
  id: string;
  taskId: string | null;
  tool: string;
  minutesWaiting: number;
}
export interface JobStreakFinding {
  id: string;
  name: string;
  failStreak: number;
}
export interface ProviderHealthFinding {
  failuresInWindow: number;
  windowMinutes: number;
  sample: string;
}

export interface CoordinatorReport {
  stuckTasks: StuckTaskFinding[];
  /** Task ids the Coordinator actually asked resumeStuckTask to continue this tick
   *  (excludes ones skipped by the notify-cooldown — already being handled). */
  resumedTaskIds: string[];
  providerDegraded: ProviderHealthFinding | null;
  approvalBacklog: ApprovalBacklogFinding[];
  jobStreaks: JobStreakFinding[];
  /** subkind:entityId pairs that produced a FRESH notification this tick
   *  (cooldown-suppressed repeats are not listed here, but still counted above). */
  notified: string[];
}

export interface CoordinatorOptions {
  now?: Date;
  /** Test isolation: this tick's task/job queries see ONLY rows whose
   *  goal/name starts with this prefix (the scheduler-smoke FC-024 lesson —
   *  an injected `now` must never touch real production rows). */
  taskGoalPrefix?: string;
  jobNamePrefix?: string;
  stuckMinutes?: number;
  providerWindowMinutes?: number;
  providerFailureThreshold?: number;
  approvalBacklogMinutes?: number;
  jobFailStreakThreshold?: number;
  /** Minimum gap between repeat notifications for the SAME finding (same
   *  subkind+entity) — also doubles as "don't re-resume a task we just
   *  resumed a moment ago" (a resumed task may take a few minutes to move
   *  off 'running'; re-invoking resumeStuckTask on it meanwhile would risk a
   *  duplicate concurrent run of the same task). */
  notifyCooldownMinutes?: number;
  /** Actually continue ONE stuck task — the caller (server.ts) owns shape
   *  routing (plain/graph/agent), reusing the exact function boot-resume
   *  trusts. Omit to run observe-only (detect + notify, never act). Must not
   *  reject (the caller's resumeTaskById already catches internally). */
  resumeStuckTask?: (taskId: string) => void | Promise<void>;
  /** Source of recent failure texts for provider-health detection. Defaults
   *  to a real trace_events scan. Injectable because trace_events has no
   *  natural prefix column to scope test fixtures by — tests supply a stub
   *  list instead of touching real rows. */
  recentFailureTexts?: (pool: pg.Pool, sinceMs: number) => Promise<string[]>;
}

const DEFAULTS = {
  stuckMinutes: 10,
  providerWindowMinutes: 15,
  providerFailureThreshold: 3,
  approvalBacklogMinutes: 20,
  jobFailStreakThreshold: 2,
  notifyCooldownMinutes: 20,
};

async function defaultRecentFailureTexts(pool: pg.Pool, sinceMs: number): Promise<string[]> {
  const { rows } = await pool.query<{ payload: { error?: string } }>(
    `SELECT payload FROM trace_events
     WHERE event IN ('task.failed','agents.plan_failed','propose.failed')
       AND ts > now() - ($1 || ' milliseconds')::interval
     ORDER BY ts DESC LIMIT 200`,
    [String(sinceMs)],
  );
  return rows.map((r) => r.payload?.error ?? '').filter(Boolean);
}

/** Has a Coordinator notification for this exact finding fired within the
 *  cooldown? Keyed by subkind+entityId (stored in notifications.meta) so
 *  re-detecting the SAME problem doesn't spam, but a DIFFERENT task/job still
 *  gets its own notice immediately. */
async function recentlyNotified(pool: pg.Pool, subkind: string, entityId: string, cooldownMs: number, now: Date): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM notifications
     WHERE meta->>'subkind' = $1 AND meta->>'entityId' = $2 AND created_at > $3::timestamptz - ($4 || ' milliseconds')::interval
     LIMIT 1`,
    [subkind, entityId, now, String(cooldownMs)],
  );
  return (rowCount ?? 0) > 0;
}

async function notify(pool: pg.Pool, o: { subkind: string; entityId: string; title: string; body: string; now: Date }): Promise<void> {
  // created_at is stamped EXPLICITLY from the (possibly injected/test) clock —
  // relying on the column's `now()` default would silently compare cooldowns
  // against real wall-clock time even when a tick is given a fake `now`,
  // making the cooldown untestable (caught live: past-cooldown re-notify
  // checks failed because the "old" notification's real timestamp was always
  // "now", never actually in the past relative to the injected clock).
  await pool.query(`INSERT INTO notifications (kind, title, body, meta, created_at) VALUES ('coordinator', $1, $2, $3::jsonb, $4)`, [
    o.title,
    o.body,
    JSON.stringify({ subkind: o.subkind, entityId: o.entityId }),
    o.now,
  ]);
}

/** One Coordinator pass. Safe to call on a plain interval — every write is a
 *  single-row insert/update, no cross-tick state held in memory (the cooldown
 *  lives in the notifications table itself, so a process restart doesn't
 *  cause a burst of repeat notifications). */
export async function tick(pool: pg.Pool, opts: CoordinatorOptions = {}): Promise<CoordinatorReport> {
  const now = opts.now ?? new Date();
  const cfg = { ...DEFAULTS, ...opts };
  const trace = new TraceStore(pool);
  const report: CoordinatorReport = { stuckTasks: [], resumedTaskIds: [], providerDegraded: null, approvalBacklog: [], jobStreaks: [], notified: [] };
  const taskPrefix = opts.taskGoalPrefix ? `${opts.taskGoalPrefix}%` : '%';
  const jobPrefix = opts.jobNamePrefix ? `${opts.jobNamePrefix}%` : '%';
  const cooldownMs = cfg.notifyCooldownMinutes * 60_000;

  // 1. STUCK TASKS ------------------------------------------------------------
  const stuckCutoff = new Date(now.getTime() - cfg.stuckMinutes * 60_000);
  const stuck = await pool.query<{ id: string; goal: string; status: string; trace_id: string; last_activity: Date }>(
    `SELECT t.id, t.goal, t.status::text, t.trace_id,
            GREATEST(t.updated_at, COALESCE((SELECT max(s.updated_at) FROM steps s WHERE s.task_id = t.id), t.updated_at)) AS last_activity
     FROM tasks t
     WHERE t.status IN ('running','planning') AND t.goal LIKE $2
       AND GREATEST(t.updated_at, COALESCE((SELECT max(s.updated_at) FROM steps s WHERE s.task_id = t.id), t.updated_at)) < $1
     ORDER BY t.created_at`,
    [stuckCutoff, taskPrefix],
  );
  for (const row of stuck.rows) {
    const minutesStuck = Math.round((now.getTime() - row.last_activity.getTime()) / 60_000);
    report.stuckTasks.push({ id: row.id, goal: row.goal, status: row.status, minutesStuck });
    trace.recordSafe({ traceId: row.trace_id, taskId: row.id, component: 'coordinator', event: 'coordinator.stuck_task', payload: { minutesStuck } });
    if (await recentlyNotified(pool, 'stuck_task', row.id, cooldownMs, now)) continue; // already resumed/notified recently — don't pile on
    if (opts.resumeStuckTask) {
      await Promise.resolve(opts.resumeStuckTask(row.id));
      report.resumedTaskIds.push(row.id);
    }
    const body = opts.resumeStuckTask
      ? `"${row.goal.slice(0, 100)}" hadn't made progress for ${minutesStuck} min — I resumed it from its last checkpoint.`
      : `"${row.goal.slice(0, 100)}" hasn't made progress for ${minutesStuck} min — it may be stuck.`;
    await notify(pool, { subkind: 'stuck_task', entityId: row.id, title: '🔧 Task looked stuck', body, now });
    report.notified.push(`stuck_task:${row.id}`);
  }

  // 2. PROVIDER HEALTH ---------------------------------------------------------
  const fetchFailures = opts.recentFailureTexts ?? defaultRecentFailureTexts;
  const recentTexts = await fetchFailures(pool, cfg.providerWindowMinutes * 60_000);
  const pressureTexts = recentTexts.filter((t) => isRateLimitPressure(t));
  if (pressureTexts.length >= cfg.providerFailureThreshold) {
    report.providerDegraded = { failuresInWindow: pressureTexts.length, windowMinutes: cfg.providerWindowMinutes, sample: pressureTexts[0]!.slice(0, 200) };
    if (!(await recentlyNotified(pool, 'provider_health', 'model-provider', cooldownMs, now))) {
      await notify(pool, {
        subkind: 'provider_health',
        entityId: 'model-provider',
        title: '⚠ Model provider looks degraded',
        body: `${pressureTexts.length} provider-exhaustion failures in the last ${cfg.providerWindowMinutes} min. Tasks needing larger requests (research, web search) are most likely to be affected right now.`,
        now,
      });
      report.notified.push('provider_health:model-provider');
    }
  }

  // 3. APPROVAL BACKLOG (observe + remind ONLY — the Coordinator cannot decide
  //    these; only the user can approve/reject a pending_action) ---------------
  const backlogCutoff = new Date(now.getTime() - cfg.approvalBacklogMinutes * 60_000);
  const backlog = await pool.query<{ id: string; task_id: string | null; tool: string; created_at: Date }>(
    `SELECT pa.id, pa.task_id, pa.tool, pa.created_at
     FROM pending_actions pa LEFT JOIN tasks t ON t.id = pa.task_id
     WHERE pa.status = 'pending' AND pa.created_at < $1 AND (t.goal LIKE $2 OR t.goal IS NULL)
     ORDER BY pa.created_at`,
    [backlogCutoff, taskPrefix],
  );
  for (const row of backlog.rows) {
    const minutesWaiting = Math.round((now.getTime() - row.created_at.getTime()) / 60_000);
    report.approvalBacklog.push({ id: row.id, taskId: row.task_id, tool: row.tool, minutesWaiting });
  }
  if (report.approvalBacklog.length > 0 && !(await recentlyNotified(pool, 'approval_backlog', 'pending', cooldownMs, now))) {
    const oldest = report.approvalBacklog[0]!;
    await notify(pool, {
      subkind: 'approval_backlog',
      entityId: 'pending',
      title: `⏳ ${report.approvalBacklog.length} approval${report.approvalBacklog.length === 1 ? '' : 's'} waiting`,
      body: `Oldest: ${oldest.tool} queued ${oldest.minutesWaiting} min ago. Nothing runs until you decide.`,
      now,
    });
    report.notified.push('approval_backlog:pending');
  }

  // 4. JOB FAILURE STREAKS (observe + remind ONLY — the scheduler already owns
  //    retry/backoff for these; this just surfaces a pattern to the user) -----
  const jobs = await pool.query<{ id: string; name: string; state: { failStreak?: number } }>(
    `SELECT id, name, state FROM jobs WHERE enabled AND name LIKE $1`,
    [jobPrefix],
  );
  for (const job of jobs.rows) {
    const failStreak = Number(job.state?.failStreak) || 0;
    if (failStreak < cfg.jobFailStreakThreshold) continue;
    report.jobStreaks.push({ id: job.id, name: job.name, failStreak });
    if (await recentlyNotified(pool, 'job_streak', job.id, cooldownMs, now)) continue;
    await notify(pool, {
      subkind: 'job_streak',
      entityId: job.id,
      title: `🔁 Automation "${job.name}" keeps failing`,
      body: `${failStreak} failures in a row. It will keep retrying on its own schedule, but you may want to look at it.`,
      now,
    });
    report.notified.push(`job_streak:${job.id}`);
  }

  trace.recordSafe({
    traceId: newTraceId(),
    component: 'coordinator',
    event: 'coordinator.tick',
    payload: { stuck: report.stuckTasks.length, resumed: report.resumedTaskIds.length, providerDegraded: !!report.providerDegraded, backlog: report.approvalBacklog.length, jobStreaks: report.jobStreaks.length },
  });
  return report;
}

/** Production entry: poll-tick forever. Mirrors startScheduler exactly.
 *  `resumeStuckTask` and `registry`-dependent concerns stay the caller's job —
 *  this module never imports packs/tools, same layering as the scheduler. */
export function startCoordinator(
  pool: pg.Pool,
  opts: { intervalMs?: number; resumeStuckTask?: (taskId: string) => void | Promise<void>; onTick?: (r: CoordinatorReport) => void } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? Number(process.env.COORDINATOR_POLL_MS ?? 60_000);
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // a slow tick must not stack another on top
    running = true;
    tick(pool, { resumeStuckTask: opts.resumeStuckTask })
      .then((r) => opts.onTick?.(r)) // caller decides what's log-worthy vs. just freshness bookkeeping
      .catch((err) => console.error('[coordinator] tick failed:', err instanceof Error ? err.message : err))
      .finally(() => (running = false));
  }, intervalMs);
  timer.unref?.(); // never keep the process alive just to poll
  return () => clearInterval(timer);
}
