// Graph recovery smoke. Needs Postgres; deliberately needs NO model quota:
//   tsx packages/kernel/src/graph-recovery-smoke.ts
//
// Steps are inserted directly rather than planned, because the behaviour under
// test IS rate-limit handling — routing these through a live planner would make
// the suite fail for exactly the reason it exists to fix.
//
// WHAT THIS PINS. Measured on the live DB 2026-09-19: 135 failed steps, 115 of
// them transient (429 / timeout / `fetch failed`), 130 of them `reason` steps
// with no side effects. The driver retried none of them — it wrote
// status='failed' and the task died with the literal text "A step failed.",
// 151 times. Every check below is one sentence of that going away, except the
// ones marked SAFETY, which pin the failures that must STILL be terminal.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import pg from 'pg';
import { ToolRegistry, type ToolDef } from '@ai-os/tools';
import { runGraph } from './graph.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

const GROQ_LONG =
  'INFRA_RATELIMIT 429 (groq): {"error":{"message":"Rate limit reached on tokens per day (TPD): Limit 200000, Used 199005. Please try again in 15m17.136s.","code":"rate_limit_exceeded"}}';
const FLAKY = 'fetch failed';

// Register tool trust classes once. `write` auto-approves so it RUNS (no
// barrier) while still counting as mutating — which is the case that must not
// be retried.
for (const [tool, cls, auto] of [
  ['probe_read', 'read', true],
  ['probe_write', 'write', true],
] as const) {
  await pool.query(
    `INSERT INTO trust_policies (tool, trust_class, auto_approve) VALUES ($1,$2,$3)
     ON CONFLICT (tool) DO UPDATE SET trust_class=EXCLUDED.trust_class, auto_approve=EXCLUDED.auto_approve`,
    [tool, cls, auto],
  );
}

/** A tool that fails `failTimes` times with `error`, then succeeds. */
function flakyTool(
  name: string,
  failTimes: number,
  error: string,
  mode: 'throw' | 'return' = 'throw',
): { def: ToolDef; calls: () => number } {
  let calls = 0;
  const def: ToolDef = {
    name,
    description: 'test probe',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      calls++;
      if (calls <= failTimes) {
        if (mode === 'return') return { error };
        throw new Error(error);
      }
      return { ok: true, calls };
    },
  };
  return { def, calls: () => calls };
}
const reg = (...defs: ToolDef[]): ToolRegistry => {
  const r = new ToolRegistry();
  for (const d of defs) r.register(d);
  return r;
};

const created: string[] = [];
/** Build a one-tool-step task without going near the planner. */
async function mkTask(goal: string, tool: string, status = 'pending'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1,'running','user', gen_random_uuid()) RETURNING id`,
    [goal],
  );
  const taskId = rows[0]!.id;
  created.push(taskId);
  await pool.query(
    `INSERT INTO steps (task_id, kind, title, local_id, status, input, tool, tool_args)
     VALUES ($1,'tool',$2,'s1',$3,$4,$5,'{}'::jsonb)`,
    [taskId, `run ${tool}`, status, JSON.stringify({ instruction: 'run the probe' }), tool],
  );
  return taskId;
}
const step = async (taskId: string) =>
  (
    await pool.query<{ status: string; retries: number; retry_at: Date | null; error: string | null }>(
      `SELECT status, retries, retry_at, error FROM steps WHERE task_id=$1`,
      [taskId],
    )
  ).rows[0]!;
const taskStatus = async (taskId: string) =>
  (await pool.query<{ status: string }>(`SELECT status FROM tasks WHERE id=$1`, [taskId])).rows[0]!.status;

try {
  console.log('— A transient failure is waited out, not fatal —');
  const a = flakyTool('probe_read', 2, FLAKY);
  const ta = await mkTask('recovery A', 'probe_read');
  const ra = await runGraph(pool, ta, { registry: reg(a.def) });
  check('the task completes despite two failures', ra.status === 'done', `${ra.status}: ${ra.text?.slice(0, 60)}`);
  check('...because the step was actually retried', a.calls() === 3, `${a.calls()} calls`);
  check('...and the attempts were recorded (the column that was never written)', (await step(ta)).retries === 2, String((await step(ta)).retries));

  console.log('\n— B a long rate limit PARKS the task instead of killing it —');
  const b = flakyTool('probe_read', 99, GROQ_LONG);
  const tb = await mkTask('recovery B', 'probe_read');
  const rb = await runGraph(pool, tb, { registry: reg(b.def) });
  const sb = await step(tb);
  check('runGraph reports waiting, not failed', rb.status === 'waiting', rb.status);
  check('...the task stays running so the Coordinator will resume it', (await taskStatus(tb)) === 'running', await taskStatus(tb));
  check('...a retry time was set from the number the provider gave', !!sb.retry_at && sb.retry_at.getTime() > Date.now(), String(sb.retry_at));
  check('...roughly 15 minutes out, as Groq said', !!sb.retry_at && Math.abs(sb.retry_at.getTime() - Date.now() - 917136) < 120_000, String(sb.retry_at));
  check('...and the user is told it resumes itself', /resumes in about/.test(rb.text ?? ''), (rb.text ?? '').slice(0, 90));
  // It must NOT keep hammering the provider it was just throttled by.
  check('...without hammering: capped attempts, not one per millisecond', b.calls() <= 3, `${b.calls()} calls`);

  console.log('\n— C a parked step wakes up and finishes the task —');
  await pool.query(`UPDATE steps SET retry_at = now() - interval '1 minute' WHERE task_id=$1`, [tb]);
  const c = flakyTool('probe_read', 0, FLAKY); // the quota has "cleared"
  const rc = await runGraph(pool, tb, { registry: reg(c.def) });
  check('the same task now completes on its own', rc.status === 'done', `${rc.status}: ${rc.text?.slice(0, 60)}`);
  check('...the park marker is cleared', (await step(tb)).retry_at === null);
  check('...and nothing was lost — the step really ran', c.calls() === 1, `${c.calls()} calls`);

  console.log('\n— D SAFETY: a MUTATING tool is never re-fired —');
  const d = flakyTool('probe_write', 1, FLAKY); // would SUCCEED on attempt 2
  const td = await mkTask('recovery D', 'probe_write');
  const rd = await runGraph(pool, td, { registry: reg(d.def) });
  // The error looks transient and one more call would have worked, which is
  // exactly the temptation: a send that throws may already have sent.
  check('called exactly ONCE, though a retry would have succeeded', d.calls() === 1, `${d.calls()} calls`);
  check('...and the task fails honestly rather than double-sending', rd.status === 'failed', rd.status);

  console.log('\n— E a tool that RETURNS an error is a failure, not a success —');
  const e = flakyTool('probe_read', 99, 'the upstream said no', 'return');
  const te = await mkTask('recovery E', 'probe_read');
  const re = await runGraph(pool, te, { registry: reg(e.def) });
  // This is the bug that made tasks report success with their work undone: the
  // driver computed `failed` and then wrote status='done' regardless.
  check('the step is recorded failed, not done', (await step(te)).status === 'failed', (await step(te)).status);
  check('...so the task does not claim success', re.status !== 'done', re.status);

  console.log('\n— F the failure says WHICH step and WHY —');
  check('no longer the bare string "A step failed."', re.text !== 'A step failed.', (re.text ?? '').slice(0, 70));
  check('...it names the step', /run probe_read/.test(re.text ?? ''));
  check('...and quotes the real error', /upstream said no/.test(re.text ?? ''));

  console.log('\n— G a step orphaned by a crash is reclaimed, not deadlocked —');
  const g = flakyTool('probe_read', 0, FLAKY);
  const tg = await mkTask('recovery G', 'probe_read', 'running');
  await pool.query(`UPDATE steps SET updated_at = now() - interval '30 minutes' WHERE task_id=$1`, [tg]);
  const rg = await runGraph(pool, tg, { registry: reg(g.def) });
  check('the crashed step runs instead of blocking forever', rg.status === 'done', rg.status);
  check('...and it really executed', g.calls() === 1, `${g.calls()} calls`);

  console.log('\n— H SAFETY: a live step is NOT stolen from a concurrent run —');
  const h = flakyTool('probe_read', 0, FLAKY);
  const th = await mkTask('recovery H', 'probe_read', 'running'); // fresh, i.e. actively running
  const rh = await runGraph(pool, th, { registry: reg(h.def) });
  // Only steps stale by >15min are reclaimed; a step another process is running
  // right now must be left alone, or the same side effect happens twice.
  check('a freshly-running step is left alone', h.calls() === 0, `${h.calls()} calls`);
  check('...and the task does not falsely report done', rh.status !== 'done', rh.status);
} finally {
  if (created.length) {
    await pool.query(`DELETE FROM steps WHERE task_id = ANY($1::uuid[])`, [created]);
    await pool.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [created]);
  }
  await pool.end();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
