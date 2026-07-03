// M0 exit check (kept as a permanent smoke test): a durable Task row → a traced
// model call → TraceEvents in Postgres → a Langfuse trace.
import type pg from 'pg';
import { TraceStore, newTraceId } from '@ai-os/shared';
import { callModel, flushTelemetry } from '@ai-os/model-router';

export interface HelloResult {
  taskId: string;
  traceId: string;
  status: 'done' | 'failed';
  text: string | null;
  model?: string;
  error?: string;
}

export async function runHelloWorldTask(pool: pg.Pool): Promise<HelloResult> {
  const traceId = newTraceId();
  const trace = new TraceStore(pool);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id)
     VALUES ('hello world — M0 skeleton check', 'running', 'user', $1)
     RETURNING id`,
    [traceId],
  );
  const taskId = rows[0]!.id;
  await trace.record({ traceId, taskId, component: 'kernel', event: 'task.started' });

  try {
    const result = await callModel({
      role: 'routing', // cheapest tier — this is a smoke test, not reasoning
      system: 'You are the kernel of a personal AI Operating System booting for the first time.',
      prompt: 'Confirm you are alive in one short sentence.',
      maxTokens: 100,
      traceId,
      taskId,
      name: 'hello-world',
    });
    const tokens = result.usage.inputTokens + result.usage.outputTokens;
    await pool.query(
      `UPDATE tasks
       SET status = 'done',
           spent = jsonb_set(spent, '{tokens}', to_jsonb($2::int)),
           updated_at = now()
       WHERE id = $1`,
      [taskId, tokens],
    );
    await trace.record({
      traceId,
      taskId,
      component: 'kernel',
      event: 'task.done',
      payload: { model: result.model, tokens },
    });
    return { taskId, traceId, status: 'done', text: result.text, model: result.model };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE tasks SET status = 'failed', updated_at = now() WHERE id = $1`,
      [taskId],
    );
    await trace.record({
      traceId,
      taskId,
      component: 'kernel',
      event: 'task.failed',
      payload: { error: message },
    });
    return { taskId, traceId, status: 'failed', text: null, error: message };
  } finally {
    await flushTelemetry().catch(() => {});
  }
}
