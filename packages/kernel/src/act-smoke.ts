// M12b act-executor smoke — deterministic, NO model (ADR-0015). The runner is
// stubbed (coding-loop Proposer style); the trigger gating, task creation,
// taint, notify shape, and INFRA re-raise are the load-bearing guarantees
// proven here. Same discipline as scheduler-smoke 31/31.
// Run: npx tsx packages/kernel/src/act-smoke.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { createJob, tick as rawTick } from './scheduler.js';
import { makeActExecutor, type ActRunner } from './jobs.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const P = 'smoketest-act-';
const tick: typeof rawTick = (p, o = {}) => rawTick(p, { namePrefix: P, ...o });
await pool.query(`DELETE FROM jobs WHERE name LIKE $1`, [P + '%']);
await pool.query(`DELETE FROM tasks WHERE goal LIKE $1`, [P + '%']);

// A fake fetch_url tool with switchable page content (watch-mode trigger).
let pageText = 'v1 of the page';
const registry = {
  get: (name: string) =>
    name === 'fetch_url'
      ? { execute: async () => ({ title: 'page', text: pageText }) }
      : undefined,
  list: () => [],
};

// Stubbed runner: records what it was called with; resolves the task honestly.
const calls: Array<{ taskId: string; extraSystem?: string; initialUntrusted: boolean }> = [];
let runnerResult: { status: 'done' | 'failed' | 'awaiting_approval'; text: string } = { status: 'done', text: 'acted: drafted the summary' };
const stubRunner: ActRunner = async (p, taskId, o) => {
  calls.push({ taskId, extraSystem: o.extraSystem, initialUntrusted: o.initialUntrusted });
  await p.query(`UPDATE tasks SET status=$2, updated_at=now() WHERE id=$1`, [taskId, runnerResult.status === 'awaiting_approval' ? 'awaiting_approval' : runnerResult.status]);
  return runnerResult;
};
const executors = { act: makeActExecutor(stubRunner) };

const T = (s: string) => new Date(s);

console.log('— act: validation —');
{
  const j = await createJob(pool, { name: P + 'nogoal', kind: 'act', schedule: { kind: 'interval', minutes: 60 }, payload: {}, now: T('2026-07-06T00:00:00Z') });
  const r = await tick(pool, { now: T('2026-07-06T01:00:00Z'), executors, registry });
  check('missing goal → failed run', r.ran.find((x) => x.job === j.name)?.status === 'failed');
}

console.log('\n— act without url: fires every schedule tick —');
{
  await createJob(pool, { name: P + 'cron', kind: 'act', schedule: { kind: 'interval', minutes: 60 }, payload: { goal: P + 'cron-goal: summarize my day' }, now: T('2026-07-06T00:00:00Z') });
  const r = await tick(pool, { now: T('2026-07-06T01:00:00Z'), executors, registry });
  check('cron act ran done', r.ran.some((x) => x.job === P + 'cron' && x.status === 'done'));
  const task = (await pool.query(`SELECT created_by::text, status::text FROM tasks WHERE goal LIKE $1`, [P + 'cron-goal%'])).rows[0];
  check('task row created with trigger origin', task?.created_by === 'trigger', JSON.stringify(task));
  check('pure-cron goal is NOT tainted (user-authored)', calls.at(-1)!.initialUntrusted === false && calls.at(-1)!.extraSystem === undefined);
  const notif = (await pool.query(`SELECT title, body FROM notifications WHERE kind='act' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  check('act notification written with task link', !!notif && notif.title.includes(P + 'cron') && notif.body.includes('task '), notif?.title);
}

console.log('\n— act with url: baseline → no-change → change —');
{
  // Earlier sections' interval jobs stay due on every later tick — disable
  // them so this section's call counting is theirs alone.
  await pool.query(`UPDATE jobs SET enabled=false WHERE name LIKE $1 AND name NOT LIKE $2`, [P + '%', P + 'watch%']);
  await createJob(pool, { name: P + 'watch', kind: 'act', schedule: { kind: 'interval', minutes: 60 }, payload: { goal: P + 'watch-goal: draft a change summary', url: 'https://example.com/x' }, now: T('2026-07-06T00:00:00Z') });
  const before = calls.length;
  const r1 = await tick(pool, { now: T('2026-07-06T01:00:00Z'), executors, registry });
  check('first fire captures baseline, does NOT act', r1.ran.some((x) => x.job === P + 'watch' && x.status === 'done') && calls.length === before);

  const r2 = await tick(pool, { now: T('2026-07-06T02:00:00Z'), executors, registry });
  check('unchanged page → no act', r2.ran.some((x) => x.job === P + 'watch' && x.status === 'done') && calls.length === before);
  const noTask = (await pool.query(`SELECT count(*) AS n FROM tasks WHERE goal LIKE $1`, [P + 'watch-goal%'])).rows[0];
  check('no task rows for baseline/no-change', Number(noTask.n) === 0);

  pageText = 'v2 — THE PAGE CHANGED';
  const r3 = await tick(pool, { now: T('2026-07-06T03:00:00Z'), executors, registry });
  check('changed page → acts', r3.ran.some((x) => x.job === P + 'watch' && x.status === 'done') && calls.length === before + 1);
  const c = calls.at(-1)!;
  check('changed content enters TAINTED', c.initialUntrusted === true);
  check('trigger context is banner-framed in extraSystem', !!c.extraSystem && c.extraSystem.startsWith('[UNTRUSTED-DERIVED CONTENT') && c.extraSystem.includes('THE PAGE CHANGED'));
  const task = (await pool.query(`SELECT created_by::text FROM tasks WHERE goal LIKE $1`, [P + 'watch-goal%'])).rows[0];
  check('act task row created (trigger origin)', task?.created_by === 'trigger');

  // Same hash again → back to no-change.
  const r4 = await tick(pool, { now: T('2026-07-06T04:00:00Z'), executors, registry });
  check('stable after the change → no re-act', r4.ran.some((x) => x.job === P + 'watch' && x.status === 'done') && calls.length === before + 1);
}

console.log('\n— act result handling —');
{
  await pool.query(`UPDATE jobs SET enabled=false WHERE name LIKE $1`, [P + '%']);
  runnerResult = { status: 'awaiting_approval', text: 'Queued whatsapp_send_message for your approval.' };
  await createJob(pool, { name: P + 'approval', kind: 'act', schedule: { kind: 'interval', minutes: 60 }, payload: { goal: P + 'approval-goal: send the digest' }, now: T('2026-07-06T00:00:00Z') });
  await tick(pool, { now: T('2026-07-06T01:00:00Z'), executors, registry });
  const notif = (await pool.query(`SELECT title FROM notifications WHERE kind='act' AND title LIKE $1 ORDER BY created_at DESC LIMIT 1`, [`%${P}approval%`])).rows[0];
  check('awaiting_approval surfaces as "needs your approval"', !!notif && notif.title.includes('needs your approval'), notif?.title);

  runnerResult = { status: 'failed', text: '⚠ I couldn’t finish that — the AI model provider is rate-limited right now.' };
  await createJob(pool, { name: P + 'quota', kind: 'act', schedule: { kind: 'interval', minutes: 60 }, payload: { goal: P + 'quota-goal: x y z' }, now: T('2026-07-06T00:00:00Z') });
  const r = await tick(pool, { now: T('2026-07-06T01:00:00Z'), executors, registry });
  check('rate-limited result re-raised as INFRA → deferred, not failed', r.ran.find((x) => x.job === P + 'quota')?.status === 'deferred');

  runnerResult = { status: 'failed', text: 'Task exceeded its iteration budget (12).' };
  await createJob(pool, { name: P + 'realfail', kind: 'act', schedule: { kind: 'interval', minutes: 60 }, payload: { goal: P + 'realfail-goal: x' }, now: T('2026-07-06T00:00:00Z') });
  const rf = await tick(pool, { now: T('2026-07-06T01:00:00Z'), executors, registry });
  check('a real behavioral failure stays done-with-failed-task (not deferred)', rf.ran.find((x) => x.job === P + 'realfail')?.status === 'done');
}

// Cleanup: remove smoke rows so the live world stays clean.
await pool.query(`DELETE FROM jobs WHERE name LIKE $1`, [P + '%']);
await pool.query(`DELETE FROM tasks WHERE goal LIKE $1`, [P + '%']);
await pool.query(`DELETE FROM notifications WHERE kind='act' AND (title LIKE $1 OR body LIKE $1)`, [`%${P}%`]);
await pool.end();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
