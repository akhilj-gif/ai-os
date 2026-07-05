// M4 graph-engine smoke test: multi-step plan, approval barrier (halt→approve→run),
// reject, pause/resume, and exactly-once idempotent resume. Run on a reliable model:
//   MODEL_PROVIDER=groq MODEL_EXECUTION=openai/gpt-oss-120b MODEL_ROUTING=openai/gpt-oss-120b tsx packages/kernel/src/graph-smoke.ts
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import pg from 'pg';
import { ToolRegistry } from '@ai-os/tools';
import { planAndStart, runGraph, pauseTask, resumeTask, decideApproval } from './graph.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const stepStatuses = async (taskId: string) =>
  (await pool.query<{ title: string; kind: string; status: string }>(`SELECT title, kind, status FROM steps WHERE task_id=$1 ORDER BY created_at`, [taskId])).rows;
const toolCallCount = async (taskId: string, tool: string) =>
  (await pool.query(`SELECT count(*) c FROM tool_calls tc JOIN steps s ON s.id=tc.step_id WHERE s.task_id=$1 AND tc.tool=$2`, [taskId, tool])).rows[0].c;

// A no-op irreversible tool so the trust gate forces an approval barrier.
let published = 0;
function reg(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({ name: 'publish_public', description: 'Publish text publicly (irreversible).', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, execute: async () => { published++; return { published: true }; } });
  return r;
}
await pool.query(
  `INSERT INTO trust_policies (tool, trust_class, auto_approve) VALUES ('publish_public','irreversible',false)
   ON CONFLICT (tool) DO UPDATE SET trust_class='irreversible', auto_approve=false`,
);

// ---- Test A: approval flow (halt → approve → run, exactly once) ----
console.log('\n[A] approval flow');
published = 0;
const a = await planAndStart(pool, { goal: 'Write a one-line announcement that the Q3 report is ready, then publish it publicly with the publish_public tool.', registry: reg() });
check('A: halts at awaiting_approval', a.status === 'awaiting_approval', `status=${a.status}`);
check('A: publish did NOT run before approval', published === 0, `published=${published}`);
const approvalStep = (await pool.query<{ id: string }>(`SELECT id FROM steps WHERE task_id=$1 AND kind='approval' AND (approval->>'status')='pending' LIMIT 1`, [a.taskId])).rows[0];
check('A: an approval step is pending', !!approvalStep);
if (approvalStep) {
  const done = await decideApproval(pool, a.taskId, approvalStep.id, 'approved', undefined, { registry: reg() });
  check('A: completes after approval', done.status === 'done', `status=${done.status}`);
  check('A: publish ran exactly once', published === 1, `published=${published}`);
  check('A: final text present', !!done.text, done.text?.slice(0, 60));
}

// ---- Test B: reject → task failed, tool never runs ----
console.log('\n[B] reject flow');
published = 0;
const b = await planAndStart(pool, { goal: 'Draft a thank-you note and publish it publicly using publish_public.', registry: reg() });
const bStep = (await pool.query<{ id: string }>(`SELECT id FROM steps WHERE task_id=$1 AND kind='approval' AND (approval->>'status')='pending' LIMIT 1`, [b.taskId])).rows[0];
if (bStep) {
  const rej = await decideApproval(pool, b.taskId, bStep.id, 'rejected', 'no thanks');
  check('B: task failed after reject', rej.status === 'failed', `status=${rej.status}`);
  check('B: publish never ran', published === 0, `published=${published}`);
} else check('B: had an approval step', false);

// ---- Test C: exactly-once idempotent resume (closes FC-019) ----
console.log('\n[C] exactly-once resume');
const cCalls = await toolCallCount(a.taskId, 'publish_public');
await runGraph(pool, a.taskId, { registry: reg() }); // re-drive a DONE task
const cCalls2 = await toolCallCount(a.taskId, 'publish_public');
check('C: re-running a done graph does not re-execute the tool', String(cCalls) === String(cCalls2), `${cCalls} -> ${cCalls2}`);

// ---- Test D: pause / resume (deterministic, hand-built 2-step chain) ----
console.log('\n[D] pause / resume');
const dTask = (await pool.query<{ id: string }>(`INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ('smoke pause', 'running', 'user', gen_random_uuid()) RETURNING id`, [])).rows[0]!.id;
const s1 = (await pool.query<{ id: string }>(`INSERT INTO steps (task_id, kind, title, local_id, status, input) VALUES ($1,'reason','say one','d1','pending','{"instruction":"Reply with the single word ONE."}') RETURNING id`, [dTask])).rows[0]!.id;
await pool.query(`INSERT INTO steps (task_id, kind, title, local_id, status, input, depends_on) VALUES ($1,'reason','say two','d2','pending','{"instruction":"Reply with the single word TWO."}', ARRAY[$2]::uuid[])`, [dTask, s1]);
await pauseTask(pool, dTask);
const paused = await runGraph(pool, dTask, { registry: reg() });
check('D: runGraph returns paused', paused.status === 'paused', `status=${paused.status}`);
check('D: no step ran while paused', (await stepStatuses(dTask)).every((s) => s.status === 'pending'));
const resumed = await resumeTask(pool, dTask, { registry: reg() });
check('D: resumes to done', resumed.status === 'done', `status=${resumed.status}`);
check('D: both steps ran', (await stepStatuses(dTask)).every((s) => s.status === 'done'));

// ---- report + cleanup ----
console.log('\ngraph A steps:', (await stepStatuses(a.taskId)).map((s) => `${s.kind}:${s.status}`).join(', '));
const aErrs = (await pool.query<{ title: string; error: string }>(`SELECT title, error FROM steps WHERE task_id=$1 AND error IS NOT NULL`, [a.taskId])).rows;
for (const e of aErrs) console.log(`  step "${e.title}" error: ${e.error?.slice(0, 200)}`);
await pool.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [[a.taskId, b.taskId, dTask]]);
await pool.query(`DELETE FROM trust_policies WHERE tool='publish_public'`);
await pool.end();
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
