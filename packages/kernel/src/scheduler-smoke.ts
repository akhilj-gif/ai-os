// Deterministic scheduler checks (NO model). Proves the ADR-0010 unattended-run
// guarantees with stub executors and an INJECTED clock: exactly-once claiming,
// quota-deferral (INFRA never kills a job), failure backoff with a retry budget,
// missed-run honesty, zombie reaping, overlap guard, once-jobs disabling, and the
// watch pipeline's change-detection with a fake fetch. Same discipline as
// trust 15/15 · sandbox 7/7 · coding 10/10. Run: tsx packages/kernel/src/scheduler-smoke.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { computeNextRun, createJob, tick as rawTick, type JobExecutor } from './scheduler.js';
import { watchExecutor } from './jobs.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const P = 'smoketest-'; // all rows namespaced for cleanup
// FC-024: every tick here is scoped to smoketest- jobs. An injected FUTURE clock
// (e.g. 2026-07-07) would otherwise claim the user's REAL jobs, stamp them
// `missed` with a future timestamp, and silently skip their real runs.
const tick: typeof rawTick = (poolArg, opts = {}) => rawTick(poolArg, { namePrefix: P, ...opts });
await pool.query(`DELETE FROM jobs WHERE name LIKE $1`, [P + '%']); // stale runs cascade

// ---------------------------------------------------------------- computeNextRun
console.log('— computeNextRun (pure, tz-aware) —');
const tz = 'Asia/Kolkata'; // UTC+5:30, no DST
// 07:30 IST == 02:00 UTC. From 05:00 UTC (=10:30 IST, past it) → tomorrow 02:00 UTC.
const n1 = computeNextRun({ kind: 'daily', time: '07:30' }, new Date('2026-07-06T05:00:00Z'), tz);
check('daily: past today\'s time → tomorrow', n1?.toISOString() === '2026-07-07T02:00:00.000Z', n1?.toISOString());
// From 00:00 UTC (=05:30 IST, before 07:30) → today 02:00 UTC.
const n2 = computeNextRun({ kind: 'daily', time: '07:30' }, new Date('2026-07-06T00:00:00Z'), tz);
check('daily: before today\'s time → today', n2?.toISOString() === '2026-07-06T02:00:00.000Z', n2?.toISOString());
// Exactly AT the fire instant → strictly after → tomorrow (no double-fire on the boundary).
const n3 = computeNextRun({ kind: 'daily', time: '07:30' }, new Date('2026-07-06T02:00:00Z'), tz);
check('daily: at the boundary → strictly next', n3?.toISOString() === '2026-07-07T02:00:00.000Z', n3?.toISOString());
const n4 = computeNextRun({ kind: 'interval', minutes: 30 }, new Date('2026-07-06T05:00:00Z'), tz);
check('interval: from + N minutes', n4?.toISOString() === '2026-07-06T05:30:00.000Z', n4?.toISOString());
check('once in the future → that instant', computeNextRun({ kind: 'once', at: '2026-08-01T00:00:00Z' }, new Date('2026-07-06T00:00:00Z'), tz)?.toISOString() === '2026-08-01T00:00:00.000Z');
check('once in the past → null (never)', computeNextRun({ kind: 'once', at: '2026-01-01T00:00:00Z' }, new Date('2026-07-06T00:00:00Z'), tz) === null);

// ------------------------------------------------------------------ tick basics
console.log('\n— exactly-once claiming + notifications —');
const T0 = new Date('2026-07-06T02:00:00Z');
let okRuns = 0;
const stubOk: JobExecutor = async () => {
  okRuns++;
  return { summary: 'ok', notify: { title: P + 'hello', body: 'notified' } };
};
const jOk = await createJob(pool, { name: P + 'ok', kind: 'stub-ok', schedule: { kind: 'daily', time: '07:30' }, now: new Date('2026-07-06T00:00:00Z') });
// due at T0 exactly; tick at T0
const r1 = await tick(pool, { now: T0, executors: { 'stub-ok': stubOk } });
check('due job claimed and run', r1.claimed === 1 && okRuns === 1, `claimed=${r1.claimed} runs=${okRuns}`);
check('run recorded done', r1.ran[0]?.status === 'done');
const r2 = await tick(pool, { now: T0, executors: { 'stub-ok': stubOk } });
check('second tick at same instant: NOT re-run (exactly-once)', r2.claimed === 0 && okRuns === 1, `claimed=${r2.claimed}`);
const jOkRow = (await pool.query(`SELECT next_run_at, state FROM jobs WHERE id=$1`, [jOk.id])).rows[0]!;
check('next_run_at advanced to tomorrow', new Date(jOkRow.next_run_at).toISOString() === '2026-07-07T02:00:00.000Z', new Date(jOkRow.next_run_at).toISOString());
check('failStreak reset on success', jOkRow.state.failStreak === 0);
const notif = await pool.query(`SELECT * FROM notifications WHERE title=$1`, [P + 'hello']);
check('notification written', notif.rowCount === 1 && notif.rows[0].read === false);

console.log('\n— quota deferral: INFRA failure never kills the job —');
const stubInfra: JobExecutor = async () => {
  throw new Error('INFRA_RATELIMIT 429 (gemini): quota exceeded');
};
const jInfra = await createJob(pool, { name: P + 'infra', kind: 'stub-infra', schedule: { kind: 'daily', time: '07:30' }, now: new Date('2026-07-06T00:00:00Z') });
const r3 = await tick(pool, { now: T0, executors: { 'stub-infra': stubInfra } });
check('run recorded deferred (not failed)', r3.ran[0]?.status === 'deferred');
const jInfraRow = (await pool.query(`SELECT enabled, next_run_at, state FROM jobs WHERE id=$1`, [jInfra.id])).rows[0]!;
check('job still enabled', jInfraRow.enabled === true);
check('retry pulled in to +15m (not tomorrow)', new Date(jInfraRow.next_run_at).toISOString() === '2026-07-06T02:15:00.000Z', new Date(jInfraRow.next_run_at).toISOString());
check('failStreak NOT advanced by infra', !jInfraRow.state.failStreak, JSON.stringify(jInfraRow.state));

console.log('\n— real-failure backoff with a retry budget —');
const stubFail: JobExecutor = async () => {
  throw new Error('boom: executor bug');
};
const jFail = await createJob(pool, { name: P + 'fail', kind: 'stub-fail', schedule: { kind: 'daily', time: '07:30' }, now: new Date('2026-07-06T00:00:00Z') });
const rf1 = await tick(pool, { now: T0, executors: { 'stub-fail': stubFail } });
let jf = (await pool.query(`SELECT next_run_at, state FROM jobs WHERE id=$1`, [jFail.id])).rows[0]!;
check('failure #1: failed + retry at +5m', rf1.ran[0]?.status === 'failed' && new Date(jf.next_run_at).toISOString() === '2026-07-06T02:05:00.000Z', new Date(jf.next_run_at).toISOString());
check('failStreak=1', jf.state.failStreak === 1);
await tick(pool, { now: new Date('2026-07-06T02:05:00Z'), executors: { 'stub-fail': stubFail } }); // #2 → +10m
await tick(pool, { now: new Date('2026-07-06T02:15:00Z'), executors: { 'stub-fail': stubFail } }); // #3 → +15m
const rf4 = await tick(pool, { now: new Date('2026-07-06T02:30:00Z'), executors: { 'stub-fail': stubFail } }); // #4: budget spent
jf = (await pool.query(`SELECT next_run_at, state FROM jobs WHERE id=$1`, [jFail.id])).rows[0]!;
check('failure #4: budget spent → natural cadence (tomorrow), no tight loop', rf4.ran[0]?.status === 'failed' && new Date(jf.next_run_at).toISOString() === '2026-07-07T02:00:00.000Z', `streak=${jf.state.failStreak} next=${new Date(jf.next_run_at).toISOString()}`);

console.log('\n— missed-run honesty (API was down past grace) —');
let missedRuns = 0;
const stubMissed: JobExecutor = async () => {
  missedRuns++;
  return { summary: 'should not execute' };
};
const jMiss = await createJob(pool, { name: P + 'missed', kind: 'stub-missed', schedule: { kind: 'daily', time: '07:30' }, now: new Date('2026-07-06T00:00:00Z') });
// due 02:00, tick at 05:30 (3.5h late > 2h grace)
const rm = await tick(pool, { now: new Date('2026-07-06T05:30:00Z'), executors: { 'stub-missed': stubMissed } });
check('recorded missed, NOT executed', rm.missed.includes(P + 'missed') && missedRuns === 0, `missed=${rm.missed.length} execs=${missedRuns}`);
const missRun = await pool.query(`SELECT status FROM job_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 1`, [jMiss.id]);
check("job_runs row says 'missed'", missRun.rows[0]?.status === 'missed');
const jMissRow = (await pool.query(`SELECT next_run_at FROM jobs WHERE id=$1`, [jMiss.id])).rows[0]!;
check('rescheduled to the NEXT natural occurrence', new Date(jMissRow.next_run_at).toISOString() === '2026-07-07T02:00:00.000Z');
// within grace → executes (a briefing 30m late is still a briefing)
const jLate = await createJob(pool, { name: P + 'late', kind: 'stub-missed', schedule: { kind: 'daily', time: '07:30' }, now: new Date('2026-07-06T00:00:00Z') });
await tick(pool, { now: new Date('2026-07-06T02:30:00Z'), executors: { 'stub-missed': stubMissed } });
check('within grace (30m late) → still executes', missedRuns === 1, `execs=${missedRuns}`);
void jLate;

console.log('\n— zombie reaping + overlap guard —');
const jZ = await createJob(pool, { name: P + 'zombie', kind: 'stub-ok', schedule: { kind: 'interval', minutes: 60 }, now: T0 });
// a run stuck 'running' for 40m (process died) — tick must reap it
await pool.query(`INSERT INTO job_runs (job_id, status, started_at) VALUES ($1,'running',$2)`, [jZ.id, new Date('2026-07-06T02:20:00Z')]);
const rz = await tick(pool, { now: new Date('2026-07-06T03:00:00Z'), executors: {} });
const zRun = await pool.query(`SELECT status, error FROM job_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 1`, [jZ.id]);
check('zombie run reaped to failed', rz.reaped >= 1 && zRun.rows[0]?.status === 'failed', zRun.rows[0]?.error?.slice(0, 40));
// overlap: a FRESH running run → due job is skipped, not double-started
const jOv = await createJob(pool, { name: P + 'overlap', kind: 'stub-ok', schedule: { kind: 'interval', minutes: 5 }, now: new Date('2026-07-06T02:00:00Z') });
await pool.query(`INSERT INTO job_runs (job_id, status, started_at) VALUES ($1,'running',$2)`, [jOv.id, new Date('2026-07-06T02:04:00Z')]);
const ro = await tick(pool, { now: new Date('2026-07-06T02:06:00Z'), executors: { 'stub-ok': stubOk } });
check('fresh running run → skipped (no overlap)', ro.skippedRunning.includes(P + 'overlap') && ro.claimed === 0, `skipped=${ro.skippedRunning.length}`);

console.log('\n— once-jobs and disabled jobs —');
const jOnce = await createJob(pool, { name: P + 'once', kind: 'stub-ok', schedule: { kind: 'once', at: '2026-07-06T02:00:00Z' }, now: new Date('2026-07-06T00:00:00Z') });
await tick(pool, { now: T0, executors: { 'stub-ok': stubOk } });
const jOnceRow = (await pool.query(`SELECT enabled, next_run_at FROM jobs WHERE id=$1`, [jOnce.id])).rows[0]!;
check('once-job ran then disabled itself', jOnceRow.enabled === false && jOnceRow.next_run_at === null);
const before = okRuns;
await createJob(pool, { name: P + 'disabled', kind: 'stub-ok', schedule: { kind: 'interval', minutes: 1 }, enabled: false, now: new Date('2026-07-06T00:00:00Z') });
await tick(pool, { now: new Date('2026-07-07T00:00:00Z'), executors: { 'stub-ok': stubOk } });
const disRuns = await pool.query(`SELECT count(*) FROM job_runs r JOIN jobs j ON j.id=r.job_id WHERE j.name=$1`, [P + 'disabled']);
check('disabled job never runs', Number(disRuns.rows[0].count) === 0 && okRuns >= before);

console.log('\n— watch pipeline: change detection with a fake fetch (no network) —');
let content = 'price: 100';
const fakeRegistry = {
  get: (name: string) =>
    name === 'fetch_url' ? { execute: async () => ({ title: 'page', text: content }) } : undefined,
};
const jW = await createJob(pool, { name: P + 'watch', kind: 'watch', schedule: { kind: 'interval', minutes: 30 }, payload: { url: 'https://example.com/x' }, now: new Date('2026-07-06T00:00:00Z') });
const notifCount = async () => Number((await pool.query(`SELECT count(*) FROM notifications WHERE job_id=$1`, [jW.id])).rows[0].count);
await tick(pool, { now: new Date('2026-07-06T00:30:00Z'), executors: { watch: watchExecutor }, registry: fakeRegistry });
check('first run: baseline captured, NO notification', (await notifCount()) === 0);
await tick(pool, { now: new Date('2026-07-06T01:00:00Z'), executors: { watch: watchExecutor }, registry: fakeRegistry });
check('unchanged content: NO notification (no false alarm)', (await notifCount()) === 0);
content = 'price: 80';
await tick(pool, { now: new Date('2026-07-06T01:30:00Z'), executors: { watch: watchExecutor }, registry: fakeRegistry });
check('changed content: notification fired', (await notifCount()) === 1);
const wNotif = await pool.query(`SELECT title, body FROM notifications WHERE job_id=$1`, [jW.id]);
check('alert carries the url + new content', wNotif.rows[0].body.includes('https://example.com/x') && wNotif.rows[0].body.includes('price: 80'));
const wState = (await pool.query(`SELECT state FROM jobs WHERE id=$1`, [jW.id])).rows[0]!;
check('lastHash cursor updated', typeof wState.state.lastHash === 'string' && wState.state.lastHash.length === 64);

// cleanup
await pool.query(`DELETE FROM notifications WHERE job_id IN (SELECT id FROM jobs WHERE name LIKE $1) OR title LIKE $1`, [P + '%']);
await pool.query(`DELETE FROM jobs WHERE name LIKE $1`, [P + '%']);
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
await pool.end();
process.exit(fail ? 1 : 0);
