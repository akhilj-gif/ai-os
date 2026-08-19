// pnpm os:trace <taskId|traceId>   ·   pnpm os:trace --recent [n]
//
// Reconstructs ONE incident end to end: the task, every reasoning/tool step in
// order with durations and trust decisions, the trace events around them, any
// approval it queued, and the memories it wrote.
//
// WHY. The OS already persists everything needed to answer "what actually
// happened at 3pm" — `tasks`, `steps`, `trace_events` and `pending_actions` are
// all keyed by trace_id/task_id. But that timeline was only reachable through the
// dashboard, so from a terminal the honest answer to "why did that fail" was
// grepping a 43MB log. This is the join, on the command line, in one screen.
//
// Secrets: tool args and results are already redacted at write time by
// redactForAudit (§8.2) before they reach `steps`, so what is printed here is
// what the audit log holds. Values are truncated for width, not for safety.
import pg from 'pg';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { C } from './ops.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(root, '.env') });

const args = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });

const clip = (s: unknown, n = 110): string => {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? null);
  if (!t) return '';
  const flat = t.replace(/\s+/g, ' ');
  return flat.length > n ? flat.slice(0, n) + C.dim('…') : flat;
};
const ms = (n: number | null): string => (n === null || n === undefined ? '' : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const statusColor = (s: string): string => (s === 'done' || s === 'ok' ? C.green(s) : s === 'failed' || s === 'error' ? C.red(s) : s === 'pending' || s === 'running' ? C.yellow(s) : C.dim(s));

async function recent(n: number): Promise<void> {
  // Failures first — that is what you are almost always here for.
  const { rows } = await pool.query<{ id: string; trace_id: string; status: string; goal: string; created_by: string; t: string; untrusted: boolean }>(
    `SELECT id, trace_id, status, goal, created_by, to_char(updated_at,'MM-DD HH24:MI') AS t, untrusted
       FROM tasks
      ORDER BY (status = 'failed') DESC, updated_at DESC
      LIMIT $1`,
    [n],
  );
  if (!rows.length) {
    console.log(C.dim('\n  no tasks recorded yet\n'));
    return;
  }
  console.log(C.bold(`\nrecent tasks (failures first)\n`));
  for (const r of rows) {
    const flag = r.untrusted ? C.yellow(' [untrusted]') : '';
    console.log(`  ${r.t}  ${statusColor(r.status).padEnd(18)} ${C.dim(r.created_by.padEnd(8))} ${clip(r.goal, 64)}${flag}`);
    console.log(`      ${C.dim('pnpm os:trace ' + r.id)}`);
  }
  console.log();
}

async function one(id: string): Promise<void> {
  // Accept either a task id or a trace id — during an incident you rarely know
  // which one you are holding.
  const { rows: tasks } = await pool.query<{
    id: string;
    trace_id: string;
    goal: string;
    status: string;
    created_by: string;
    untrusted: boolean;
    created_at: string;
    updated_at: string;
    parent_task_id: string | null;
    tokens: string | null;
    cost: string | null;
  }>(
    // spent is jsonb {tokens, cost_usd} — there is no total_tokens column.
    `SELECT id, trace_id, goal, status, created_by, untrusted,
            to_char(created_at,'YYYY-MM-DD HH24:MI:SS') AS created_at,
            to_char(updated_at,'YYYY-MM-DD HH24:MI:SS') AS updated_at,
            parent_task_id, spent->>'tokens' AS tokens, spent->>'cost_usd' AS cost
       FROM tasks WHERE id::text = $1 OR trace_id::text = $1
      ORDER BY created_at`,
    [id],
  );
  if (!tasks.length) {
    console.log(C.red(`\n  no task or trace matches ${id}\n`) + C.dim('  try: pnpm os:trace --recent\n'));
    return;
  }

  for (const t of tasks) {
    console.log(C.bold(`\ntask ${t.id}`));
    console.log(`  goal      ${clip(t.goal, 140)}`);
    console.log(`  status    ${statusColor(t.status)}   ${C.dim(`by ${t.created_by}`)}${t.untrusted ? '   ' + C.yellow('UNTRUSTED CONTEXT WAS IN SCOPE') : ''}`);
    console.log(`  window    ${t.created_at} → ${t.updated_at}${Number(t.tokens) ? C.dim(`   ${t.tokens} tokens`) : ''}${Number(t.cost) ? C.dim(`   $${t.cost}`) : ''}`);
    console.log(`  trace     ${C.dim(t.trace_id)}${t.parent_task_id ? `   ${C.dim('child of ' + t.parent_task_id)}` : ''}`);

    // --- the step timeline: the actual answer to "what happened" ------------
    // steps has no duration_ms and no trust_class: duration is derived from the
    // created/updated pair the executor stamps, and the approval verdict lives in
    // the `approval` jsonb. `output`, not `result`.
    const { rows: steps } = await pool.query<{
      idx: string;
      kind: string;
      tool: string | null;
      status: string;
      approval: string | null;
      model_used: string | null;
      tokens: number | null;
      retries: number | null;
      duration_ms: string | null;
      tool_args: unknown;
      output: unknown;
      error: string | null;
      t: string;
    }>(
      `SELECT row_number() OVER (ORDER BY created_at)::text AS idx,
              kind, tool, status, approval->>'status' AS approval,
              model_used, tokens, retries,
              round(extract(epoch FROM (updated_at - created_at)) * 1000)::text AS duration_ms,
              tool_args, output, error, to_char(created_at,'HH24:MI:SS') AS t
         FROM steps WHERE task_id = $1 ORDER BY created_at`,
      [t.id],
    );
    if (!steps.length) {
      console.log(C.dim('\n  (no steps — the task never got past creation)'));
    } else {
      console.log(C.bold(`\n  steps (${steps.length})`));
      for (const s of steps) {
        const label = s.tool ? `${s.kind}:${s.tool}` : s.kind;
        // Trust class and approver are the security-relevant columns: they show
        // whether an action was auto-run or human-approved.
        const appr = s.approval ? C.dim(` [approval:${s.approval}]`) : '';
        const meta = [s.model_used, s.tokens ? `${s.tokens}tok` : '', s.retries ? `${s.retries} retry` : ''].filter(Boolean).join(' ');
        console.log(`   ${String(s.idx).padStart(3)}. ${s.t}  ${statusColor(s.status).padEnd(18)} ${label}${appr}  ${C.dim(ms(Number(s.duration_ms)))} ${C.dim(meta)}`);
        if (s.tool_args) console.log(`        ${C.dim('args  ')}${clip(s.tool_args)}`);
        if (s.error) console.log(`        ${C.red('error ')}${clip(s.error)}`);
        else if (s.output) console.log(`        ${C.dim('output')} ${clip(s.output)}`);
      }
    }

    // --- approvals this task queued ---------------------------------------
    const { rows: pend } = await pool.query<{ tool: string; status: string; trust_class: string; untrusted: boolean; t: string }>(
      `SELECT tool, status, trust_class, untrusted_context AS untrusted, to_char(created_at,'HH24:MI:SS') AS t
         FROM pending_actions WHERE task_id = $1 ORDER BY created_at`,
      [t.id],
    );
    if (pend.length) {
      console.log(C.bold('\n  approvals'));
      for (const p of pend) {
        console.log(`   ${p.t}  ${statusColor(p.status).padEnd(18)} ${p.tool} ${C.dim(`[${p.trust_class}]`)}${p.untrusted ? ' ' + C.yellow('(prepared under untrusted content)') : ''}`);
      }
    }

    // --- memories written, so you can see what it learned -----------------
    const { rows: mem } = await pool.query<{ type: string; content: string; confidence: string; untrusted: boolean }>(
      `SELECT type, content, confidence::text, COALESCE((source->>'untrusted')::boolean, false) AS untrusted
         FROM memory_records WHERE source->>'task_id' = $1 ORDER BY created_at LIMIT 12`,
      [t.id],
    );
    if (mem.length) {
      console.log(C.bold(`\n  memories written (${mem.length})`));
      for (const m of mem) {
        console.log(`   ${m.type.padEnd(11)} ${C.dim('conf ' + m.confidence)}${m.untrusted ? ' ' + C.yellow('UNTRUSTED') : ''}  ${clip(m.content, 90)}`);
      }
    }
  }

  // --- trace events, shared across every task on this trace ---------------
  const traceId = tasks[0]!.trace_id;
  const { rows: ev } = await pool.query<{ component: string; event: string; payload: unknown; t: string }>(
    `SELECT component, event, payload, to_char(ts,'HH24:MI:SS') AS t
       FROM trace_events WHERE trace_id = $1 ORDER BY ts LIMIT 60`,
    [traceId],
  );
  if (ev.length) {
    console.log(C.bold(`\n  trace events (${ev.length})`));
    for (const e of ev) {
      console.log(`   ${e.t}  ${C.dim(e.component.padEnd(10))} ${e.event.padEnd(24)} ${clip(e.payload, 70)}`);
    }
  }
  console.log();
}

try {
  if (!args.length) {
    console.log(C.dim('\n  usage: pnpm os:trace <taskId|traceId>   ·   pnpm os:trace --recent [n]\n'));
    await recent(12);
  } else if (args[0] === '--recent') {
    await recent(Number(args[1] ?? 12));
  } else {
    await one(args[0]!);
  }
} finally {
  await pool.end();
}
