// Executor Loop (blueprint §4.2): runs steps — assemble context → call model →
// gate + dispatch tools → record — until the model produces a final answer.
// Durable by checkpointing the message state into tasks.checkpoints after every
// iteration: kill the process at any point and runTask(taskId) resumes from the
// last checkpoint (M1 exit criterion). Planner/task-graph arrive in M4; at M1
// every task is a single sequential loop.
import type pg from 'pg';
import { TraceStore } from '@ai-os/shared';
import { chat, type ChatMessage } from '@ai-os/model-router';
import { buildRegistry, type ToolRegistry } from '@ai-os/tools';
import { TrustGate } from '@ai-os/trust';
import { systemPrompt } from './prompts.js';

const MAX_ITERATIONS = 12;
const KEEP_CHECKPOINTS = 3;
const TOOL_RESULT_MAX_CHARS = 12000;

interface CheckpointRecord {
  step_id: string | null;
  label: string;
  at: string;
  state: { messages: ChatMessage[] };
}

async function saveCheckpoint(
  pool: pg.Pool,
  taskId: string,
  stepId: string | null,
  label: string,
  messages: ChatMessage[],
): Promise<void> {
  const cp: CheckpointRecord = {
    step_id: stepId,
    label,
    at: new Date().toISOString(),
    state: { messages },
  };
  // append, keeping only the newest KEEP_CHECKPOINTS to bound row size
  await pool.query(
    `UPDATE tasks
     SET checkpoints = (
       SELECT COALESCE(jsonb_agg(c), '[]'::jsonb) FROM (
         SELECT c FROM jsonb_array_elements(checkpoints || $2::jsonb) AS c
         ORDER BY c->>'at' DESC LIMIT $3
       ) latest(c)
     ),
     updated_at = now()
     WHERE id = $1`,
    [taskId, JSON.stringify([cp]), KEEP_CHECKPOINTS],
  );
}

export interface TaskRunResult {
  taskId: string;
  status: 'done' | 'failed';
  text: string;
}

export interface RunTaskOptions {
  /** Override the tool registry — used by the eval gym to inject mocked tools. */
  registry?: ToolRegistry;
}

/** Run (or resume) a task to completion. Idempotent on restart. */
export async function runTask(
  pool: pg.Pool,
  taskId: string,
  opts: RunTaskOptions = {},
): Promise<TaskRunResult> {
  const trace = new TraceStore(pool);
  const { rows } = await pool.query<{
    goal: string;
    trace_id: string;
    checkpoints: CheckpointRecord[];
    status: string;
  }>(`SELECT goal, trace_id, checkpoints, status FROM tasks WHERE id = $1`, [taskId]);
  const task = rows[0];
  if (!task) throw new Error(`no such task: ${taskId}`);
  const traceId = task.trace_id;

  let messages: ChatMessage[];
  const lastCp = task.checkpoints?.[0]; // stored newest-first by saveCheckpoint
  if (lastCp?.state?.messages?.length) {
    messages = lastCp.state.messages;
    await trace.record({ traceId, taskId, component: 'kernel', event: 'task.resumed', payload: { from: lastCp.label } });
  } else {
    messages = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: task.goal },
    ];
    await trace.record({ traceId, taskId, component: 'kernel', event: 'task.started' });
  }
  await pool.query(`UPDATE tasks SET status = 'running', updated_at = now() WHERE id = $1`, [taskId]);

  const registry = opts.registry ?? buildRegistry();
  const gate = new TrustGate(pool);
  const toolDefs = registry.list();
  let totalTokens = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const stepRes = await pool.query<{ id: string }>(
      `INSERT INTO steps (task_id, kind, status, input)
       VALUES ($1, 'reason', 'running', $2) RETURNING id`,
      [taskId, JSON.stringify({ iteration: iter, messageCount: messages.length })],
    );
    const stepId = stepRes.rows[0]!.id;

    let resp;
    try {
      resp = await chat({ role: 'execution', messages, tools: toolDefs, traceId, taskId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await pool.query(`UPDATE steps SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [stepId, msg]);
      await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
      await trace.record({ traceId, taskId, component: 'kernel', event: 'task.failed', payload: { error: msg } });
      return { taskId, status: 'failed', text: `Task failed: ${msg}` };
    }

    totalTokens += resp.usage.inputTokens + resp.usage.outputTokens;
    await pool.query(
      `UPDATE steps SET status='done', model_used=$2, tokens=$3,
         output=$4, updated_at=now() WHERE id=$1`,
      [
        stepId,
        resp.model,
        resp.usage.inputTokens + resp.usage.outputTokens,
        JSON.stringify({ text: resp.message.content, toolCalls: resp.toolCalls.map((t) => t.name) }),
      ],
    );
    messages.push(resp.message);

    if (!resp.toolCalls.length) {
      const text = resp.message.content ?? '';
      await saveCheckpoint(pool, taskId, stepId, 'final', messages);
      await pool.query(
        `UPDATE tasks SET status='done',
           spent = jsonb_set(spent, '{tokens}', to_jsonb((spent->>'tokens')::int + $2::int)),
           updated_at = now() WHERE id = $1`,
        [taskId, totalTokens],
      );
      await trace.record({ traceId, taskId, component: 'kernel', event: 'task.done', payload: { iterations: iter + 1, tokens: totalTokens } });
      return { taskId, status: 'done', text };
    }

    for (const tc of resp.toolCalls) {
      const decision = await gate.classify(tc.name);
      const started = Date.now();
      let result: unknown;
      let approvedBy: 'policy' | null = null;

      if (!decision.autoApprove) {
        // M1 has no approval flow — refuse and let the model adapt (fail closed).
        result = {
          error: `Tool "${tc.name}" is ${decision.trustClass} class and requires approval; approval flows arrive in M4. Refused.`,
        };
      } else {
        approvedBy = 'policy';
        const tool = registry.get(tc.name);
        if (!tool) {
          result = { error: `unknown tool: ${tc.name}` };
        } else {
          try {
            result = await tool.execute(tc.args, { pool, taskId });
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
        }
      }

      const durationMs = Date.now() - started;
      await pool.query(
        `INSERT INTO tool_calls (step_id, tool, args, result, trust_class, approved_by, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [stepId, tc.name, JSON.stringify(tc.args), JSON.stringify(result), decision.trustClass, approvedBy, durationMs],
      );
      await trace.record({
        traceId,
        taskId,
        component: 'executor',
        event: 'tool.executed',
        payload: { tool: tc.name, trustClass: decision.trustClass, durationMs, refused: !decision.autoApprove },
      });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, TOOL_RESULT_MAX_CHARS),
      });
    }
    // Checkpoint at END of the iteration (not per tool): the OpenAI message format
    // requires every tool_call in an assistant turn to be answered before the next
    // turn, so a mid-loop checkpoint would resume with a malformed request.
    // CONSEQUENCE — at-least-once execution (FC-019): if the process dies AFTER a
    // side-effecting tool ran but BEFORE this checkpoint, resume re-runs the tool.
    // Only gmail_create_draft is non-idempotent today (workspace_write overwrites),
    // and it becomes approval-gated at M5. Exactly-once lands with the M4 durable
    // workflow engine (Temporal/Inngest); do NOT hand-roll dedup here.
    await saveCheckpoint(pool, taskId, stepId, `iteration-${iter}`, messages);
  }

  await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
  await trace.record({ traceId, taskId, component: 'kernel', event: 'task.failed', payload: { error: 'iteration budget exceeded' } });
  return { taskId, status: 'failed', text: 'Task exceeded its iteration budget (12).' };
}

/** Find tasks orphaned mid-run (server killed) and resume them. Returns their ids.
 *  Eval-gym tasks are excluded: their mocked registries don't survive a restart,
 *  and resuming them against real tools would be wrong (and for injection cases,
 *  dangerous). A crashed eval run is simply marked failed. */
export async function findOrphanedTasks(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    `UPDATE tasks SET status='failed', updated_at=now()
     WHERE status IN ('running','planning') AND goal LIKE '[eval:%'`,
  );
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM tasks WHERE status IN ('running', 'planning') ORDER BY created_at ASC`,
  );
  return rows.map((r) => r.id);
}
