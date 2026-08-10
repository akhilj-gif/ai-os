// M7 scheduler substrate (ADR-0010): a durable Postgres-backed job scheduler in
// the same thin-build style as the task graph (ADR-0007) — jobs are rows, a tick is
// a transaction, everything lands in trace_events. The core is a pure-ish
// `tick(pool, {now, executors})`: timers just call it, tests inject `now` — so every
// scheduling guarantee is provable deterministically with ZERO model quota.
//
// Unattended-run semantics (the load-bearing decisions):
// - Jobs are FIXED PIPELINES (briefing/watch/reflect in jobs.ts), never open agent
//   loops: nobody is watching an unattended run, so mutating tools are simply not
//   reachable; the only output channel is the notifications table.
// - Quota survival: a run failing on INFRA_* (rate limit / network) is recorded
//   `deferred` — not failed — and retried in ~15m. Free-tier exhaustion delays the
//   morning briefing; it never silently kills it.
// - Missed runs (API was down past a 2h grace): recorded `missed`, NOT executed —
//   a 5-hour-late "morning" briefing is noise, and honesty beats pretending.
// - Zombie runs (process died mid-run): reaped to `failed` after 30m, unblocking
//   the job — the scheduler's analog of resume-on-boot.
import type pg from 'pg';
import { newTraceId, TraceStore } from '@ai-os/shared';

export type Schedule =
  | { kind: 'daily'; time: string } // 'HH:MM' in tz
  | { kind: 'interval'; minutes: number }
  | { kind: 'once'; at: string }; // ISO instant

export interface JobRow {
  id: string;
  name: string;
  kind: string;
  schedule: Schedule;
  payload: Record<string, unknown>;
  state: Record<string, unknown>;
  enabled: boolean;
  next_run_at: Date | null;
}

export interface ExecutorResult {
  summary: string;
  output?: unknown;
  notify?: { title: string; body: string; kind?: string };
  statePatch?: Record<string, unknown>; // merged into jobs.state on success
}
export type JobExecutor = (pool: pg.Pool, job: JobRow, ctx: ExecutorContext) => Promise<ExecutorResult>;
export interface ExecutorContext {
  runId: string;
  traceId: string;
  now: Date;
  registry?: unknown; // ToolRegistry — untyped here to keep the substrate tool-free
}

const GRACE_MS = 2 * 3600_000; // due longer ago than this (API down) → missed, not executed
const ZOMBIE_MS = 30 * 60_000; // running longer than this → process died mid-run, reap
const DEFER_MS = 15 * 60_000; // retry delay after an INFRA (quota/network) failure
const FAIL_RETRY_MS = 5 * 60_000; // base retry delay after a real failure
const MAX_FAIL_RETRIES = 3; // then fall back to the natural cadence
const ALERT_STREAK = 2; // consecutive failures before the user is told (then every 5th)

const TZ = () => process.env.AIOS_TZ ?? 'Asia/Kolkata';

function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!) - date.getTime();
}

/** Next fire instant strictly after `from` (null = never again, e.g. spent once-jobs). */
export function computeNextRun(schedule: Schedule, from: Date, tz = TZ()): Date | null {
  if (schedule.kind === 'interval') {
    const min = Math.max(1, Math.floor(schedule.minutes));
    return new Date(from.getTime() + min * 60_000);
  }
  if (schedule.kind === 'once') {
    const at = new Date(schedule.at);
    return at.getTime() > from.getTime() ? at : null;
  }
  // daily HH:MM in tz: try the HH:MM of "today in tz" and of "tomorrow", first one after `from`.
  const m = /^(\d{1,2}):(\d{2})$/.exec(schedule.time);
  if (!m) throw new Error(`bad daily time "${schedule.time}" (want HH:MM)`);
  const [hh, mm] = [Number(m[1]), Number(m[2])];
  for (const dayDelta of [0, 1]) {
    const probe = new Date(from.getTime() + dayDelta * 24 * 3600_000);
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(probe); // YYYY-MM-DD
    const [y, mo, d] = ymd.split('-').map(Number);
    const naive = Date.UTC(y!, mo! - 1, d!, hh, mm);
    const fire = new Date(naive - tzOffsetMs(tz, new Date(naive)));
    if (fire.getTime() > from.getTime()) return fire;
  }
  throw new Error('computeNextRun(daily): no occurrence found (unreachable)');
}

export interface TickReport {
  reaped: number;
  claimed: number;
  ran: Array<{ job: string; runId: string; status: 'done' | 'failed' | 'deferred' }>;
  missed: string[];
  skippedRunning: string[];
}

export interface TickOptions {
  now?: Date;
  executors?: Record<string, JobExecutor>;
  registry?: unknown;
  /** Test isolation (FC-024): when set, this tick sees ONLY jobs whose name starts
   *  with the prefix. Smokes tick with injected clocks against the shared jobs
   *  table — without this scoping, a fake future `now` claims REAL jobs, marks
   *  them missed with future timestamps, and silently skips their real runs. */
  namePrefix?: string;
}

const isInfra = (msg: string) => /INFRA_RATELIMIT|INFRA_NETWORK|quota|rate.?limit|\b429\b/i.test(msg);

/** One scheduler pass. Safe to call concurrently (claims use FOR UPDATE SKIP LOCKED). */
export async function tick(pool: pg.Pool, opts: TickOptions = {}): Promise<TickReport> {
  const now = opts.now ?? new Date();
  const trace = new TraceStore(pool);
  const report: TickReport = { reaped: 0, claimed: 0, ran: [], missed: [], skippedRunning: [] };

  const prefix = opts.namePrefix ? `${opts.namePrefix}%` : '%';

  // 1. Reap zombie runs so a crashed process can't wedge its job forever.
  const reaped = await pool.query(
    `UPDATE job_runs r SET status='failed', finished_at=$1, error='zombie: process died mid-run (reaped by scheduler)'
     FROM jobs j WHERE j.id = r.job_id AND j.name LIKE $3 AND r.status='running' AND r.started_at < $2 RETURNING r.job_id`,
    [now, new Date(now.getTime() - ZOMBIE_MS), prefix],
  );
  report.reaped = reaped.rowCount ?? 0;

  // 2. Claim due jobs: mark missed-or-running and advance next_run_at IN the claim
  //    transaction, so a concurrent tick can never double-fire the same due-ness.
  const client = await pool.connect();
  const toRun: Array<{ job: JobRow; runId: string; traceId: string }> = [];
  try {
    await client.query('BEGIN');
    const due = await client.query<JobRow & { running_count: string }>(
      `SELECT j.*, (SELECT count(*) FROM job_runs r WHERE r.job_id = j.id AND r.status='running') AS running_count
       FROM jobs j
       WHERE j.enabled AND j.next_run_at IS NOT NULL AND j.next_run_at <= $1 AND j.name LIKE $2
       ORDER BY j.next_run_at
       FOR UPDATE OF j SKIP LOCKED`,
      [now, prefix],
    );
    for (const job of due.rows) {
      if (Number(job.running_count) > 0) {
        report.skippedRunning.push(job.name); // previous run still live — no overlap
        continue;
      }
      const next = computeNextRun(job.schedule, now);
      const lateMs = now.getTime() - new Date(job.next_run_at!).getTime();
      if (lateMs > GRACE_MS) {
        await client.query(
          `INSERT INTO job_runs (job_id, status, started_at, finished_at, error) VALUES ($1,'missed',$2,$2,$3)`,
          [job.id, now, `due ${Math.round(lateMs / 60000)}m ago (past ${GRACE_MS / 60000}m grace) — skipped, next occurrence scheduled`],
        );
        await client.query(`UPDATE jobs SET next_run_at=$2, enabled=(enabled AND $3), updated_at=$4 WHERE id=$1`, [job.id, next, next !== null, now]);
        report.missed.push(job.name);
        continue;
      }
      const traceId = newTraceId();
      const run = await client.query<{ id: string }>(
        `INSERT INTO job_runs (job_id, status, started_at, trace_id) VALUES ($1,'running',$2,$3) RETURNING id`,
        [job.id, now, traceId],
      );
      await client.query(`UPDATE jobs SET next_run_at=$2, enabled=(enabled AND $3), updated_at=$4 WHERE id=$1`, [job.id, next, next !== null, now]);
      toRun.push({ job, runId: run.rows[0]!.id, traceId });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  report.claimed = toRun.length;

  // 3. Execute claimed jobs (outside the claim txn; sequential — automation is low-QPS).
  const executors = { ...(opts.executors ?? {}) };
  for (const { job, runId, traceId } of toRun) {
    const exec = executors[job.kind];
    await trace.record({ traceId, component: 'scheduler', event: 'job.started', payload: { job: job.name, kind: job.kind, runId } });
    if (!exec) {
      await pool.query(`UPDATE job_runs SET status='failed', finished_at=$2, error=$3 WHERE id=$1`, [runId, now, `no executor for kind "${job.kind}"`]);
      report.ran.push({ job: job.name, runId, status: 'failed' });
      continue;
    }
    try {
      const res = await exec(pool, job, { runId, traceId, now, registry: opts.registry });
      if (res.notify) {
        await pool.query(`INSERT INTO notifications (kind, title, body, job_id) VALUES ($1,$2,$3,$4)`, [
          res.notify.kind ?? job.kind, res.notify.title, res.notify.body, job.id,
        ]);
      }
      const statePatch = { ...(res.statePatch ?? {}), failStreak: 0 };
      await pool.query(`UPDATE jobs SET state = state || $2::jsonb, updated_at=$3 WHERE id=$1`, [job.id, JSON.stringify(statePatch), now]);
      await pool.query(`UPDATE job_runs SET status='done', finished_at=$2, output=$3 WHERE id=$1`, [runId, now, JSON.stringify({ summary: res.summary, ...(res.output !== undefined ? { output: res.output } : {}) })]);
      await trace.record({ traceId, component: 'scheduler', event: 'job.done', payload: { job: job.name, notified: !!res.notify } });
      report.ran.push({ job: job.name, runId, status: 'done' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isInfra(msg)) {
        // Quota/network — the world's fault, not the job's. Defer and retry soon;
        // never advance failStreak, never give up the schedule.
        const retryAt = new Date(now.getTime() + DEFER_MS);
        await pool.query(`UPDATE job_runs SET status='deferred', finished_at=$2, error=$3 WHERE id=$1`, [runId, now, msg.slice(0, 500)]);
        await pool.query(
          `UPDATE jobs SET next_run_at = LEAST(COALESCE(next_run_at, $2), $2), updated_at=$3 WHERE id=$1 AND enabled`,
          [job.id, retryAt, now],
        );
        await trace.record({ traceId, component: 'scheduler', event: 'job.deferred', payload: { job: job.name, retryAt: retryAt.toISOString() } });
        report.ran.push({ job: job.name, runId, status: 'deferred' });
      } else {
        const streak = (Number(job.state?.failStreak) || 0) + 1;
        await pool.query(`UPDATE job_runs SET status='failed', finished_at=$2, error=$3 WHERE id=$1`, [runId, now, msg.slice(0, 500)]);
        await pool.query(`UPDATE jobs SET state = state || $2::jsonb, updated_at=$3 WHERE id=$1`, [job.id, JSON.stringify({ failStreak: streak }), now]);
        if (streak <= MAX_FAIL_RETRIES) {
          const retryAt = new Date(now.getTime() + FAIL_RETRY_MS * streak);
          await pool.query(
            `UPDATE jobs SET next_run_at = LEAST(COALESCE(next_run_at, $2), $2), updated_at=$3 WHERE id=$1 AND enabled`,
            [job.id, retryAt, now],
          );
        } // past the retry budget: keep the natural next_run_at — no tight loop
        // TELL THE USER. Nothing did before: the "Anthropic pricing" watch failed
        // 9 times and then decayed into 18 'missed' runs over 14 days in complete
        // silence. Alert on the 2nd consecutive failure (once), then every 5th, so
        // a dying automation is visible without becoming spam. Notifications are
        // already delivered to the UI and (when paired) the WhatsApp self-chat.
        if (streak === ALERT_STREAK || (streak > ALERT_STREAK && streak % 5 === 0)) {
          await pool.query(`INSERT INTO notifications (kind, title, body, job_id) VALUES ('job-failure',$1,$2,$3)`, [
            `Automation failing: ${job.name}`,
            `${streak} consecutive failures. Latest error: ${msg.slice(0, 300)}`,
            job.id,
          ]);
        }
        await trace.record({ traceId, component: 'scheduler', event: 'job.failed', payload: { job: job.name, streak, error: msg.slice(0, 200) } });
        report.ran.push({ job: job.name, runId, status: 'failed' });
      }
    }
  }
  return report;
}

/** Production entry: poll-tick forever. Returns a stop function. `registry` may be
 *  a FACTORY — resolved fresh each tick, so pack enable/disable (M9) applies to
 *  future runs without a restart. */
export function startScheduler(
  pool: pg.Pool,
  opts: { intervalMs?: number; executors: Record<string, JobExecutor>; registry?: unknown | (() => unknown); onTick?: (r: TickReport) => void },
): () => void {
  const intervalMs = opts.intervalMs ?? Number(process.env.SCHEDULER_POLL_MS ?? 30_000);
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // a slow tick must not stack another on top
    running = true;
    tick(pool, { executors: opts.executors, registry: typeof opts.registry === 'function' ? (opts.registry as () => unknown)() : opts.registry })
      .then((r) => {
        if (r.claimed || r.reaped || r.missed.length) opts.onTick?.(r);
      })
      .catch((err) => console.error('[scheduler] tick failed:', err instanceof Error ? err.message : err))
      .finally(() => (running = false));
  }, intervalMs);
  timer.unref?.(); // never keep the process alive just to poll
  return () => clearInterval(timer);
}

/** Create a job (validating the schedule) and stamp its first next_run_at. */
export async function createJob(
  pool: pg.Pool,
  opts: { name: string; kind: string; schedule: Schedule; payload?: Record<string, unknown>; enabled?: boolean; now?: Date },
): Promise<JobRow> {
  const now = opts.now ?? new Date();
  const next = computeNextRun(opts.schedule, now); // throws on a malformed schedule
  if (next === null) throw new Error('schedule never fires (once-schedule in the past?)');
  const { rows } = await pool.query<JobRow>(
    `INSERT INTO jobs (name, kind, schedule, payload, enabled, next_run_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [opts.name, opts.kind, JSON.stringify(opts.schedule), JSON.stringify(opts.payload ?? {}), opts.enabled ?? true, next],
  );
  return rows[0]!;
}
