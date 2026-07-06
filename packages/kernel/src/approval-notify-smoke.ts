// Deterministic check (NO model): approvals are answerable from notifications
// (M8). Seeds a task whose only step is an approval gate → runGraph halts at the
// barrier AND pushes an approval notification (deduped across re-entrant runs) →
// deciding consumes the notification (read) and completes the task. The reject
// path consumes it too. Run: tsx packages/kernel/src/approval-notify-smoke.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { runGraph, decideApproval } from './graph.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

async function seed(goal: string): Promise<{ taskId: string; stepId: string }> {
  const t = (await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1,'running','user',gen_random_uuid()) RETURNING id`,
    [goal],
  )).rows[0]!;
  const s = (await pool.query<{ id: string }>(
    `INSERT INTO steps (task_id, kind, title, local_id, status) VALUES ($1,'approval','Approve the smoke gate','a1','pending') RETURNING id`,
    [t.id],
  )).rows[0]!;
  return { taskId: t.id, stepId: s.id };
}
const notifs = async (stepId: string) =>
  (await pool.query(`SELECT read FROM notifications WHERE meta->>'stepId' = $1`, [stepId])).rows as Array<{ read: boolean }>;

console.log('— approve path —');
const a = await seed('smoketest-notify: approve path');
const r1 = await runGraph(pool, a.taskId);
check('runGraph halts at the approval barrier', r1.status === 'awaiting_approval', r1.status);
let n = await notifs(a.stepId);
check('approval notification pushed (unread)', n.length === 1 && n[0]!.read === false, `count=${n.length}`);
await runGraph(pool, a.taskId); // re-entrant call must not duplicate
n = await notifs(a.stepId);
check('re-entrant runGraph does NOT duplicate the notification', n.length === 1, `count=${n.length}`);
const r2 = await decideApproval(pool, a.taskId, a.stepId, 'approved');
check('approve → task completes', r2.status === 'done', r2.status);
n = await notifs(a.stepId);
check('decision consumed the notification (read)', n.length === 1 && n[0]!.read === true);

console.log('\n— reject path —');
const b = await seed('smoketest-notify: reject path');
await runGraph(pool, b.taskId);
const r3 = await decideApproval(pool, b.taskId, b.stepId, 'rejected', 'not today');
check('reject → task failed', r3.status === 'failed', r3.status);
const nb = await notifs(b.stepId);
check('rejected decision also consumed the notification', nb.length === 1 && nb[0]!.read === true);

// cleanup (notifications reference no FK to steps; delete by meta)
await pool.query(`DELETE FROM notifications WHERE meta->>'stepId' = ANY($1::text[])`, [[a.stepId, b.stepId]]);
await pool.query(`DELETE FROM tasks WHERE goal LIKE 'smoketest-notify:%'`);
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
await pool.end();
process.exit(fail ? 1 : 0);
