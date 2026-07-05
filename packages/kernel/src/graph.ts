// Task-Graph Executor / durable driver (blueprint §4.2, ADR-0007). Persists a
// plan as `steps` rows and drives them: runnable steps (deps done) execute —
// independent ones in parallel — until the graph is done, failed, paused, or
// awaiting_approval. Re-entrant: re-reads state each call and SKIPS done steps,
// so a crash/resume never re-runs a completed side-effecting step (closes FC-019).
import type pg from 'pg';
import { TraceStore, newTraceId } from '@ai-os/shared';
import { callModel } from '@ai-os/model-router';
import { buildRegistry, type ToolRegistry } from '@ai-os/tools';
import { TrustGate, redactForAudit } from '@ai-os/trust';
import { systemPrompt } from './prompts.js';
import { assembleMemoryContext } from './context.js';
import { makePlan, type PlannedStep } from './planner.js';

const MAX_PARALLEL = 3;

interface StepRow {
  id: string;
  kind: string;
  title: string | null;
  local_id: string | null;
  depends_on: string[];
  status: string;
  input: { instruction?: string } | null;
  output: unknown;
  tool: string | null;
  tool_args: Record<string, unknown> | null;
  approval: { status?: string; note?: string } | null;
}

export interface GraphResult {
  taskId: string;
  status: 'done' | 'failed' | 'paused' | 'awaiting_approval' | 'clarify';
  text?: string;
  clarify?: string;
  awaiting?: Array<{ stepId: string; title: string }>;
}

/** Plan a goal and start executing its graph. */
export async function planAndStart(
  pool: pg.Pool,
  opts: { goal: string; registry?: ToolRegistry },
): Promise<GraphResult> {
  const traceId = newTraceId();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1, 'planning', 'user', $2) RETURNING id`,
    [opts.goal, traceId],
  );
  const taskId = rows[0]!.id;
  const trace = new TraceStore(pool);
  await trace.record({ traceId, taskId, component: 'planner', event: 'plan.started' });

  let plan;
  try {
    plan = await makePlan(pool, { taskId, traceId, goal: opts.goal, registry: opts.registry });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
    await trace.record({ traceId, taskId, component: 'planner', event: 'plan.failed', payload: { error: msg } });
    return { taskId, status: 'failed', text: `Planning failed: ${msg}` };
  }

  if (plan.clarify) {
    await pool.query(
      `INSERT INTO steps (task_id, kind, title, status, output) VALUES ($1, 'reason', 'clarification', 'done', $2)`,
      [taskId, JSON.stringify({ clarify: plan.clarify })],
    );
    await pool.query(`UPDATE tasks SET status='paused', updated_at=now() WHERE id=$1`, [taskId]);
    await trace.record({ traceId, taskId, component: 'planner', event: 'plan.clarify', payload: { question: plan.clarify } });
    return { taskId, status: 'clarify', clarify: plan.clarify };
  }

  await persistPlan(pool, taskId, plan.steps);
  await trace.record({ traceId, taskId, component: 'planner', event: 'plan.ready', payload: { steps: plan.steps.length } });
  return runGraph(pool, taskId, { registry: opts.registry });
}

/** Insert planned steps, mapping local_id → uuid for depends_on. */
async function persistPlan(pool: pg.Pool, taskId: string, steps: PlannedStep[]): Promise<void> {
  const idMap = new Map<string, string>();
  for (const s of steps) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO steps (task_id, kind, title, local_id, status, input, tool, tool_args, approval)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8) RETURNING id`,
      [
        taskId,
        s.kind,
        s.title,
        s.local_id,
        JSON.stringify({ instruction: s.instruction }),
        s.tool ?? null,
        s.tool_args ? JSON.stringify(s.tool_args) : null,
        s.kind === 'approval' ? JSON.stringify({ status: 'pending' }) : null,
      ],
    );
    idMap.set(s.local_id, rows[0]!.id);
  }
  for (const s of steps) {
    const deps = (s.depends_on ?? []).map((d) => idMap.get(d)).filter((x): x is string => !!x);
    if (deps.length) {
      await pool.query(`UPDATE steps SET depends_on = $2::uuid[] WHERE id = $1`, [idMap.get(s.local_id), deps]);
    }
  }
}

/** Drive (or resume) the graph to its next stable state. */
export async function runGraph(pool: pg.Pool, taskId: string, opts: { registry?: ToolRegistry } = {}): Promise<GraphResult> {
  const trace = new TraceStore(pool);
  const registry = opts.registry ?? buildRegistry();
  const gate = new TrustGate(pool);

  const taskRow = (await pool.query<{ goal: string; trace_id: string; status: string; pending_directive: string | null; spent: { tokens: number } }>(
    `SELECT goal, trace_id, status, pending_directive, spent FROM tasks WHERE id=$1`,
    [taskId],
  )).rows[0];
  if (!taskRow) throw new Error(`no such task: ${taskId}`);
  const traceId = taskRow.trace_id;
  if (taskRow.status === 'paused') return { taskId, status: 'paused' };

  // Consume a mid-run directive (redirect): inject into remaining steps' context.
  let directive = taskRow.pending_directive ?? '';
  if (directive) {
    await pool.query(`UPDATE tasks SET pending_directive = NULL WHERE id=$1`, [taskId]);
    await trace.record({ traceId, taskId, component: 'kernel', event: 'task.redirected', payload: { directive } });
  }

  await pool.query(`UPDATE tasks SET status='running', updated_at=now() WHERE id=$1`, [taskId]);
  let totalTokens = 0;

  for (let guard = 0; guard < 100; guard++) {
    // Re-check pause each loop so a pause during execution takes effect promptly.
    const st = (await pool.query<{ status: string }>(`SELECT status FROM tasks WHERE id=$1`, [taskId])).rows[0]!;
    if (st.status === 'paused') return { taskId, status: 'paused' };

    const steps = (await pool.query<StepRow>(
      `SELECT id, kind, title, local_id, depends_on, status, input, output, tool, tool_args, approval FROM steps WHERE task_id=$1`,
      [taskId],
    )).rows;
    const byId = new Map(steps.map((s) => [s.id, s]));
    const depsDone = (s: StepRow) => s.depends_on.every((d) => byId.get(d)?.status === 'done');
    const pending = steps.filter((s) => s.status === 'pending' && depsDone(s));

    // Partition runnable steps into executables and approval/trust barriers.
    const executables: StepRow[] = [];
    const barriers: StepRow[] = [];
    for (const s of pending) {
      if (s.kind === 'approval') {
        const a = s.approval?.status ?? 'pending';
        if (a === 'approved') executables.push(s);
        else if (a === 'rejected') {
          await pool.query(`UPDATE steps SET status='failed', error='rejected by user', updated_at=now() WHERE id=$1`, [s.id]);
        } else barriers.push(s);
      } else if (s.kind === 'tool' && s.tool) {
        const decision = await gate.classify(s.tool);
        if (decision.autoApprove) {
          executables.push(s);
        } else {
          // Non-auto (irreversible/spend): cleared to run ONLY if a gating approval
          // dependency has been approved. Otherwise it's a barrier (halt). Since the
          // step is runnable, its deps are already 'done'; we additionally require
          // that at least one of them is an APPROVED approval step.
          const cleared = s.depends_on.some((d) => {
            const dep = byId.get(d);
            return dep?.kind === 'approval' && dep.status === 'done' && dep.approval?.status === 'approved';
          });
          if (cleared) executables.push(s);
          else barriers.push(s);
        }
      } else {
        executables.push(s);
      }
    }

    if (executables.length === 0) {
      if (barriers.length > 0) {
        await pool.query(`UPDATE tasks SET status='awaiting_approval', updated_at=now() WHERE id=$1`, [taskId]);
        await trace.record({ traceId, taskId, component: 'trust', event: 'task.awaiting_approval', payload: { steps: barriers.map((b) => b.title) } });
        return { taskId, status: 'awaiting_approval', awaiting: barriers.map((b) => ({ stepId: b.id, title: b.title ?? b.kind })) };
      }
      break; // nothing runnable → finalize below
    }

    // Run this batch (independent by construction) with bounded parallelism.
    for (let i = 0; i < executables.length; i += MAX_PARALLEL) {
      const batch = executables.slice(i, i + MAX_PARALLEL);
      const results = await Promise.all(
        batch.map((s) => executeStep(pool, { step: s, byId, taskId, traceId, directive, goal: taskRow.goal, registry, gate })),
      );
      totalTokens += results.reduce((a, b) => a + b, 0);
    }
    directive = ''; // applied once, to the first batch after a redirect
  }

  // Finalize: all runnable work is done (or failed).
  const finalSteps = (await pool.query<StepRow>(`SELECT id, kind, title, depends_on, status, output FROM steps WHERE task_id=$1`, [taskId])).rows;
  if (finalSteps.some((s) => s.status === 'failed')) {
    await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
    await trace.record({ traceId, taskId, component: 'kernel', event: 'task.failed', payload: { failedSteps: finalSteps.filter((s) => s.status === 'failed').map((s) => s.title) } });
    return { taskId, status: 'failed', text: 'A step failed.' };
  }
  const text = finalText(finalSteps);
  await pool.query(
    `UPDATE tasks SET status='done', spent = jsonb_set(spent, '{tokens}', to_jsonb((spent->>'tokens')::int + $2::int)), updated_at=now() WHERE id=$1`,
    [taskId, totalTokens],
  );
  await trace.record({ traceId, taskId, component: 'kernel', event: 'task.done', payload: { steps: finalSteps.length, tokens: totalTokens } });
  return { taskId, status: 'done', text };
}

/** The final answer = the terminal reason step's text (steps nothing depends on). */
function finalText(steps: StepRow[]): string {
  const depended = new Set(steps.flatMap((s) => s.depends_on));
  const terminals = steps.filter((s) => !depended.has(s.id) && s.status === 'done');
  const reasonTerminal = [...terminals].reverse().find((s) => s.kind === 'reason' && (s.output as { text?: string })?.text);
  if (reasonTerminal) return (reasonTerminal.output as { text: string }).text;
  const anyReason = [...steps].reverse().find((s) => s.kind === 'reason' && (s.output as { text?: string })?.text);
  return anyReason ? (anyReason.output as { text: string }).text : 'Task complete.';
}

async function executeStep(
  pool: pg.Pool,
  ctx: {
    step: StepRow;
    byId: Map<string, StepRow>;
    taskId: string;
    traceId: string;
    directive: string;
    goal: string;
    registry: ToolRegistry;
    gate: TrustGate;
  },
): Promise<number> {
  const { step, byId, taskId, traceId } = ctx;
  const trace = new TraceStore(pool);
  await pool.query(`UPDATE steps SET status='running', updated_at=now() WHERE id=$1`, [step.id]);

  // Approved approval step → just mark done (barrier lifted).
  if (step.kind === 'approval') {
    await pool.query(`UPDATE steps SET status='done', updated_at=now() WHERE id=$1`, [step.id]);
    await trace.record({ traceId, taskId, component: 'trust', event: 'approval.cleared', payload: { step: step.title } });
    return 0;
  }

  const priorContext = step.depends_on
    .map((d) => byId.get(d))
    .filter((s): s is StepRow => !!s)
    .map((s) => `- ${s.title}: ${JSON.stringify((s.output as { text?: string })?.text ?? s.output)?.slice(0, 800)}`)
    .join('\n');
  const instruction = step.input?.instruction ?? step.title ?? '';

  try {
    if (step.kind === 'tool' && step.tool) {
      const decision = await ctx.gate.classify(step.tool);
      const tool = ctx.registry.get(step.tool);
      const started = Date.now();
      let result: unknown;
      if (!tool) result = { error: `unknown tool: ${step.tool}` };
      else {
        try {
          result = await tool.execute(step.tool_args ?? {}, { pool, taskId });
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      await pool.query(
        `INSERT INTO tool_calls (step_id, tool, args, result, trust_class, approved_by, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [step.id, step.tool, redactForAudit(JSON.stringify(step.tool_args ?? {})), redactForAudit(JSON.stringify(result)), decision.trustClass, decision.autoApprove ? 'policy' : 'user', Date.now() - started],
      );
      await pool.query(`UPDATE steps SET status='done', output=$2, updated_at=now() WHERE id=$1`, [step.id, JSON.stringify({ result })]);
      await trace.record({ traceId, taskId, component: 'executor', event: 'step.tool', payload: { tool: step.tool, title: step.title } });
      return 0;
    }

    // reason step — pure synthesis. It has NO tools; other steps handle tool
    // actions. Be explicit, or a tool-eager model (gpt-oss) will emit a tool call
    // that the provider rejects (tool_choice=none) — a real integration failure.
    const resp = await callModel({
      role: 'execution',
      system: `${systemPrompt()}\n\nYou are executing ONE reasoning/writing step of a larger plan. Produce ONLY this step's text output, as prose. Do NOT call, invoke, or emit any tool call — tool actions are separate steps handled elsewhere.`,
      prompt: [
        ctx.directive ? `IMPORTANT mid-run directive from the user: ${ctx.directive}` : '',
        `Overall goal (for context only — do not act on tool mentions here): ${ctx.goal}`,
        priorContext ? `Results so far:\n${priorContext}` : '',
        `Your step (write the output for this): ${instruction}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      maxTokens: 1200,
      traceId,
      taskId,
      name: `step:${step.title ?? 'reason'}`,
    });
    await pool.query(`UPDATE steps SET status='done', output=$2, model_used=$3, tokens=$4, updated_at=now() WHERE id=$1`, [
      step.id,
      JSON.stringify({ text: resp.text }),
      resp.model,
      resp.usage.inputTokens + resp.usage.outputTokens,
    ]);
    await trace.record({ traceId, taskId, component: 'executor', event: 'step.reason', payload: { title: step.title } });
    return resp.usage.inputTokens + resp.usage.outputTokens;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pool.query(`UPDATE steps SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [step.id, msg]);
    await trace.record({ traceId, taskId, component: 'executor', event: 'step.failed', payload: { title: step.title, error: msg } });
    return 0;
  }
}

// ---- control operations (pause / resume / redirect / approve) ----

export async function pauseTask(pool: pg.Pool, taskId: string): Promise<void> {
  await pool.query(`UPDATE tasks SET status='paused', updated_at=now() WHERE id=$1 AND status IN ('running','planning','awaiting_approval')`, [taskId]);
}

export async function redirectTask(pool: pg.Pool, taskId: string, directive: string): Promise<void> {
  await pool.query(`UPDATE tasks SET pending_directive=$2, updated_at=now() WHERE id=$1`, [taskId, directive]);
}

export async function resumeTask(pool: pg.Pool, taskId: string, opts: { registry?: ToolRegistry } = {}): Promise<GraphResult> {
  await pool.query(`UPDATE tasks SET status='running', updated_at=now() WHERE id=$1 AND status='paused'`, [taskId]);
  return runGraph(pool, taskId, opts);
}

export async function decideApproval(
  pool: pg.Pool,
  taskId: string,
  stepId: string,
  decision: 'approved' | 'rejected',
  note?: string,
  opts: { registry?: ToolRegistry } = {},
): Promise<GraphResult> {
  await pool.query(
    `UPDATE steps SET approval = jsonb_build_object('status',$3::text,'note',$4::text,'decided_at',now()), updated_at=now()
     WHERE id=$1 AND task_id=$2 AND kind='approval'`,
    [stepId, taskId, decision, note ?? null],
  );
  return runGraph(pool, taskId, opts);
}
