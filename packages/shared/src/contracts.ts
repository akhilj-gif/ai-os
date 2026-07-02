// The 5 data contracts (blueprint §4.3) — canonical runtime schemas.
// Postgres DDL lives in infra/migrations/0001_contracts.sql; keep the two in sync.
import { z } from 'zod';

export const TaskStatus = z.enum([
  'draft',
  'planning',
  'running',
  'paused',
  'awaiting_approval',
  'done',
  'failed',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskOrigin = z.enum(['user', 'schedule', 'trigger']);
export type TaskOrigin = z.infer<typeof TaskOrigin>;

export const StepKind = z.enum(['reason', 'tool', 'approval', 'subtask']);
export type StepKind = z.infer<typeof StepKind>;

export const StepStatus = z.enum(['pending', 'running', 'done', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatus>;

// Trust classes (blueprint §8.1) — every tool call is classified BEFORE execution.
export const TrustClass = z.enum(['read', 'write', 'irreversible', 'spend']);
export type TrustClass = z.infer<typeof TrustClass>;

export const MemoryType = z.enum([
  'episodic',
  'semantic',
  'preference',
  'procedural',
  'project',
  'document',
]);
export type MemoryType = z.infer<typeof MemoryType>;

export const Budget = z.object({
  tokens: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
});
export type Budget = z.infer<typeof Budget>;

export const Spent = z.object({
  tokens: z.number().int(),
  cost_usd: z.number(),
});
export type Spent = z.infer<typeof Spent>;

export const Checkpoint = z.object({
  step_id: z.uuid(),
  label: z.string(),
  at: z.iso.datetime(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

// 1/5
export const Task = z.object({
  id: z.uuid(),
  goal: z.string(),
  status: TaskStatus,
  budget: Budget,
  spent: Spent,
  created_by: TaskOrigin,
  trace_id: z.uuid(),
  checkpoints: z.array(Checkpoint),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Task = z.infer<typeof Task>;

// 2/5
export const Step = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  kind: StepKind,
  depends_on: z.array(z.uuid()),
  status: StepStatus,
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  model_used: z.string().nullable(),
  tokens: z.number().int().nullable(),
  retries: z.number().int(),
  error: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Step = z.infer<typeof Step>;

// 3/5
export const ToolCall = z.object({
  id: z.uuid(),
  step_id: z.uuid(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown().nullable(),
  trust_class: TrustClass,
  approved_by: z.enum(['user', 'policy']).nullable(),
  sandbox_id: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  created_at: z.coerce.date(),
});
export type ToolCall = z.infer<typeof ToolCall>;

// 4/5 — provenance is mandatory: a memory without a source is invalid by construction (§7.2)
export const MemorySource = z
  .object({
    task_id: z.uuid().optional(),
    tool_call_id: z.uuid().optional(),
    user_stated: z.boolean().optional(),
  })
  .refine(
    (s) => s.task_id !== undefined || s.tool_call_id !== undefined || s.user_stated === true,
    { message: 'MemorySource must cite a task, a tool call, or an explicit user statement' },
  );
export type MemorySource = z.infer<typeof MemorySource>;

export const MemoryRecord = z.object({
  id: z.uuid(),
  type: MemoryType,
  content: z.string(),
  embedding: z.array(z.number()).nullable(),
  source: MemorySource,
  confidence: z.number().min(0).max(1),
  created_at: z.coerce.date(),
  last_confirmed_at: z.coerce.date(),
  expires_at: z.coerce.date().nullable(),
  superseded_by: z.uuid().nullable(),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;

// 5/5
export const TraceEvent = z.object({
  trace_id: z.uuid(),
  span_id: z.uuid(),
  task_id: z.uuid().nullable(),
  component: z.string(),
  event: z.string(),
  payload: z.record(z.string(), z.unknown()),
  ts: z.coerce.date(),
  cost: z.number().nullable(),
});
export type TraceEvent = z.infer<typeof TraceEvent>;
