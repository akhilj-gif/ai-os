// M16 Coordinator — deterministic checks against a REAL Postgres (no model):
// stuck-task detection + delegated resume, provider-health thresholding,
// approval backlog, job failure streaks, and the notify-cooldown that both
// stops spam AND prevents double-resuming a task that's already being handled.
// Same discipline as scheduler-smoke (namePrefix scoping — an injected clock
// must never touch real rows) + act-smoke (stubbed runner/callback).
// Run: npx tsx packages/kernel/src/coordinator-smoke.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { tick as rawTick } from './coordinator.js';
import { createJob } from './scheduler.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const P = 'smoketest-coordinator-';
// Scope every tick to this run's own fixtures — the FC-024 lesson from
// scheduler-smoke: an injected `now` must never claim/act on real rows.
const tick: typeof rawTick = (poolArg, opts = {}) => rawTick(poolArg, { taskGoalPrefix: P, jobNamePrefix: P, ...opts });
const T = (s: string) => new Date(s);
const T0 = T('2026-07-11T12:00:00Z');

async function cleanup(): Promise<void> {
  // pending_actions.task_id has NO cascade (unlike steps) — must go first.
  await pool.query(`DELETE FROM pending_actions WHERE task_id IN (SELECT id FROM tasks WHERE goal LIKE $1)`, [`${P}%`]);
  await pool.query(`DELETE FROM tasks WHERE goal LIKE $1`, [`${P}%`]); // cascades steps
  await pool.query(`DELETE FROM jobs WHERE name LIKE $1`, [`${P}%`]);
  // Task/job-scoped notifications carry the prefix in BODY (stuck_task, via
  // the task goal) or TITLE (job_streak, via the job name) — match both, not
  // just body (an earlier version only matched body, so a job_streak leftover
  // survived indefinitely and silently poisoned every later run's cooldown
  // check — caught live, see below).
  await pool.query(`DELETE FROM notifications WHERE kind='coordinator' AND (body LIKE $1 OR title LIKE $1)`, [`%${P}%`]);
  // approval_backlog/provider_health use FIXED, non-task/job-scoped entityIds
  // BY DESIGN (one recurring aggregate reminder, not per-item spam) — there is
  // no prefix to match them by. A timestamp-window heuristic doesn't work
  // either: a fictional "past" T0 test clock (this file uses noon on today's
  // date) is inherently EARLIER than any leftover's REAL wall-clock created_at
  // from a same-day-but-later test run, so `created_at > T0 - cooldown` is
  // ALWAYS true for such a leftover — it silently suppresses this run's own
  // notification forever (the actual bug this test suite caught: a crashed
  // early run's leftover approval_backlog notification made every subsequent
  // run's "does it notify" assertion fail, with no code bug at all). Clearing
  // these two subkinds unconditionally is a safe, low-stakes tradeoff for a
  // dev smoke test — it only drops a regenerable reminder PING (the
  // underlying pending_actions row / failure signal is untouched), never real
  // task/job history; a genuine backlog just re-notifies on its next tick.
  await pool.query(`DELETE FROM notifications WHERE kind='coordinator' AND meta->>'subkind' IN ('approval_backlog','provider_health')`);
}
await cleanup();

async function makeTask(goalSuffix: string, opts: { status?: string; updatedMinutesAgo?: number; stepMinutesAgo?: number | null } = {}): Promise<string> {
  const goal = `${P}${goalSuffix}`;
  const updatedAt = new Date(T0.getTime() - (opts.updatedMinutesAgo ?? 0) * 60_000);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id, updated_at) VALUES ($1,$2,'user',gen_random_uuid(),$3) RETURNING id`,
    [goal, opts.status ?? 'running', updatedAt],
  );
  const id = rows[0]!.id;
  if (opts.stepMinutesAgo != null) {
    const stepAt = new Date(T0.getTime() - opts.stepMinutesAgo * 60_000);
    await pool.query(`INSERT INTO steps (task_id, kind, status, updated_at) VALUES ($1,'reason','done',$2)`, [id, stepAt]);
  }
  return id;
}

console.log('— stuck tasks: detection —');
{
  const stuckId = await makeTask('stuck-1', { updatedMinutesAgo: 15 }); // stale, no steps at all
  const freshId = await makeTask('fresh-1', { updatedMinutesAgo: 1 }); // recently touched
  const r = await tick(pool, { now: T0, stuckMinutes: 10 });
  const ids = r.stuckTasks.map((s) => s.id);
  check('stale task (15 min, no steps) flagged stuck', ids.includes(stuckId));
  check('fresh task (1 min) NOT flagged', !ids.includes(freshId));
  const stuckFinding = r.stuckTasks.find((s) => s.id === stuckId)!;
  check('minutesStuck reported correctly (~15)', Math.abs(stuckFinding.minutesStuck - 15) <= 1, String(stuckFinding.minutesStuck));
}

console.log('\n— stuck tasks: a recent STEP counts as progress, even if the task row itself is stale —');
{
  // task.updated_at is old, but a step updated recently → genuinely working, not stuck.
  const busyId = await makeTask('busy-1', { updatedMinutesAgo: 20, stepMinutesAgo: 1 });
  const r = await tick(pool, { now: T0, stuckMinutes: 10 });
  check('task with a recent step is NOT flagged stuck despite a stale task row', !r.stuckTasks.some((s) => s.id === busyId));
}

console.log('\n— stuck tasks: delegated resume (observe-only vs. auto-resume) —');
{
  const id1 = await makeTask('resume-observeonly', { updatedMinutesAgo: 30 });
  const observeOnly = await tick(pool, { now: T0, stuckMinutes: 10 }); // no resumeStuckTask
  check('observe-only mode: reports the finding', observeOnly.stuckTasks.some((s) => s.id === id1));
  check('observe-only mode: NEVER calls resume (resumedTaskIds empty)', observeOnly.resumedTaskIds.length === 0 || !observeOnly.resumedTaskIds.includes(id1));

  const resumed: string[] = [];
  const id2 = await makeTask('resume-active', { updatedMinutesAgo: 30 });
  const acted = await tick(pool, { now: new Date(T0.getTime() + 60_000), stuckMinutes: 10, resumeStuckTask: async (taskId) => { resumed.push(taskId); } });
  check('auto-resume mode: delegate function was invoked with the stuck task id', resumed.includes(id2));
  check('auto-resume mode: resumedTaskIds reflects it', acted.resumedTaskIds.includes(id2));
}

console.log('\n— stuck tasks: cooldown prevents double-resume + notification spam —');
{
  const resumed: string[] = [];
  const id = await makeTask('cooldown-1', { updatedMinutesAgo: 30 });
  const r1 = await tick(pool, { now: T0, stuckMinutes: 10, notifyCooldownMinutes: 20, resumeStuckTask: async (t) => { resumed.push(t); } });
  check('first tick resumes the stuck task', resumed.filter((x) => x === id).length === 1);
  check('first tick sends a fresh notification', r1.notified.includes(`stuck_task:${id}`));
  // A SECOND tick moments later, task STILL looks stuck (test doesn't actually
  // fix it) — must NOT resume it again (risk: duplicate concurrent run of the
  // same task) and must NOT re-notify within the cooldown.
  const r2 = await tick(pool, { now: new Date(T0.getTime() + 5 * 60_000), stuckMinutes: 10, notifyCooldownMinutes: 20, resumeStuckTask: async (t) => { resumed.push(t); } });
  check('still reported as stuck (visibility preserved)', r2.stuckTasks.some((s) => s.id === id));
  check('but NOT resumed a second time within the cooldown', resumed.filter((x) => x === id).length === 1);
  check('and NOT re-notified within the cooldown', !r2.notified.includes(`stuck_task:${id}`));
  // Past the cooldown window, it's fair game again.
  const r3 = await tick(pool, { now: new Date(T0.getTime() + 25 * 60_000), stuckMinutes: 10, notifyCooldownMinutes: 20, resumeStuckTask: async (t) => { resumed.push(t); } });
  check('past the cooldown, resume is attempted again', resumed.filter((x) => x === id).length === 2);
  check('past the cooldown, a fresh notification fires', r3.notified.includes(`stuck_task:${id}`));
}

console.log('\n— provider health —');
{
  const below = await tick(pool, { now: T0, providerFailureThreshold: 3, recentFailureTexts: async () => ['⚠ rate-limited right now', '⚠ rate-limited right now'] });
  check('below threshold (2 of 3): not degraded', below.providerDegraded === null);
  const atThreshold = await tick(pool, {
    now: T0,
    providerFailureThreshold: 3,
    recentFailureTexts: async () => ['⚠ ...rate-limited right now.', '⚠ ...reaching the AI model provider...', 'INFRA_RATELIMIT 429 (groq)', 'ordinary unrelated failure text'],
  });
  check('at/above threshold (3 of 4 pressure-shaped): degraded', atThreshold.providerDegraded?.failuresInWindow === 3, JSON.stringify(atThreshold.providerDegraded));
  check('a fresh provider-health notification fires', atThreshold.notified.includes('provider_health:model-provider'));
  const again = await tick(pool, { now: new Date(T0.getTime() + 60_000), providerFailureThreshold: 3, recentFailureTexts: async () => ['x', 'y', 'z'].map(() => 'rate-limited right now') });
  check('still reported as degraded on the very next tick (finding is not cooldown-gated, only the notification is)', again.providerDegraded !== null);
  check('but the repeat notification is cooldown-suppressed', !again.notified.includes('provider_health:model-provider'));
}

console.log('\n— approval backlog (observe + remind ONLY — never decided) —');
{
  const taskId = await makeTask('backlog-task', { status: 'awaiting_approval', updatedMinutesAgo: 1 });
  const oldAt = new Date(T0.getTime() - 30 * 60_000);
  await pool.query(`INSERT INTO pending_actions (task_id, tool, args, trust_class, created_at) VALUES ($1,'whatsapp_send_message','{}','irreversible',$2)`, [taskId, oldAt]);
  const freshTaskId = await makeTask('backlog-fresh', { status: 'awaiting_approval', updatedMinutesAgo: 1 });
  await pool.query(`INSERT INTO pending_actions (task_id, tool, args, trust_class, created_at) VALUES ($1,'browser_act','{}','irreversible',$2)`, [freshTaskId, T0]);

  const r = await tick(pool, { now: T0, approvalBacklogMinutes: 20 });
  check('old pending_action flagged as backlog', r.approvalBacklog.some((b) => b.taskId === taskId));
  check('fresh pending_action NOT flagged', !r.approvalBacklog.some((b) => b.taskId === freshTaskId));
  check('a backlog notification fires', r.notified.includes('approval_backlog:pending'));
  // The Coordinator must NEVER touch pending_actions.status — only observe.
  const still = (await pool.query(`SELECT status FROM pending_actions WHERE task_id=$1`, [taskId])).rows[0]!;
  check('the pending action itself is untouched (still pending — Coordinator never decides)', still.status === 'pending');
}

console.log('\n— job failure streaks (observe + remind ONLY — scheduler still owns retry/backoff) —');
{
  await createJob(pool, { name: `${P}flaky`, kind: 'watch', schedule: { kind: 'interval', minutes: 60 }, payload: { url: 'https://example.com' }, now: T0 });
  await pool.query(`UPDATE jobs SET state = state || '{"failStreak":3}'::jsonb WHERE name=$1`, [`${P}flaky`]);
  await createJob(pool, { name: `${P}healthy`, kind: 'watch', schedule: { kind: 'interval', minutes: 60 }, payload: { url: 'https://example.com' }, now: T0 });
  await pool.query(`UPDATE jobs SET state = state || '{"failStreak":1}'::jsonb WHERE name=$1`, [`${P}healthy`]);

  const r = await tick(pool, { now: T0, jobFailStreakThreshold: 2 });
  check('job with failStreak≥threshold flagged', r.jobStreaks.some((j) => j.name === `${P}flaky` && j.failStreak === 3));
  check('job below threshold NOT flagged', !r.jobStreaks.some((j) => j.name === `${P}healthy`));
  check('a job-streak notification fires', r.notified.some((n) => n.startsWith('job_streak:')));
}

await cleanup();
await pool.end();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
