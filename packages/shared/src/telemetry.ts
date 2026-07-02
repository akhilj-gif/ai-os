// Minimal tracing substrate: every request/task gets a trace_id, every event is
// appended to trace_events (principle 6: everything is inspectable).
// LLM-specific spans additionally go to Langfuse via @ai-os/model-router.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export const newTraceId = (): string => randomUUID();
export const newSpanId = (): string => randomUUID();

export interface TraceEventInput {
  traceId: string;
  spanId?: string;
  taskId?: string | null;
  component: string;
  event: string;
  payload?: Record<string, unknown>;
  cost?: number | null;
}

export class TraceStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Append-only write. Throws on failure — callers that must not block on
   *  telemetry (e.g. HTTP hooks) should use recordSafe. */
  async record(e: TraceEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO trace_events (trace_id, span_id, task_id, component, event, payload, cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        e.traceId,
        e.spanId ?? newSpanId(),
        e.taskId ?? null,
        e.component,
        e.event,
        JSON.stringify(e.payload ?? {}),
        e.cost ?? null,
      ],
    );
  }

  /** Fire-and-forget variant: never throws, logs to stderr instead. */
  recordSafe(e: TraceEventInput): void {
    void this.record(e).catch((err) =>
      console.error('[telemetry] trace_events write failed:', err?.message ?? err),
    );
  }
}
