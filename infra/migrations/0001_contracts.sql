-- The 5 data contracts (blueprint §4.3). These schemas ARE the architecture —
-- every layer above them can be rewritten cheaply if these are right.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE task_status AS ENUM ('draft','planning','running','paused','awaiting_approval','done','failed');
CREATE TYPE task_origin AS ENUM ('user','schedule','trigger');
CREATE TYPE step_kind   AS ENUM ('reason','tool','approval','subtask');
CREATE TYPE step_status AS ENUM ('pending','running','done','failed','skipped');
CREATE TYPE trust_class AS ENUM ('read','write','irreversible','spend');
CREATE TYPE approver    AS ENUM ('user','policy');
CREATE TYPE memory_type AS ENUM ('episodic','semantic','preference','procedural','project','document');

-- 1/5 Task — durable unit of work; state lives here, never only in a process (principle 7)
CREATE TABLE tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal        text NOT NULL,
  status      task_status NOT NULL DEFAULT 'draft',
  budget      jsonb NOT NULL DEFAULT '{"tokens": null, "cost_usd": null}',
  spent       jsonb NOT NULL DEFAULT '{"tokens": 0, "cost_usd": 0}',
  created_by  task_origin NOT NULL DEFAULT 'user',
  trace_id    uuid NOT NULL,
  checkpoints jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_status_idx ON tasks (status);
CREATE INDEX tasks_trace_idx  ON tasks (trace_id);

-- 2/5 Step — one node of a task's DAG
CREATE TABLE steps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  kind       step_kind NOT NULL,
  depends_on uuid[] NOT NULL DEFAULT '{}',
  status     step_status NOT NULL DEFAULT 'pending',
  input      jsonb,
  output     jsonb,
  model_used text,
  tokens     integer,
  retries    integer NOT NULL DEFAULT 0,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX steps_task_idx ON steps (task_id);

-- 3/5 ToolCall — every tool invocation, trust-classified BEFORE execution (§8.1);
-- with trace_events this forms the append-only audit log (§8.4)
CREATE TABLE tool_calls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id     uuid NOT NULL REFERENCES steps (id) ON DELETE CASCADE,
  tool        text NOT NULL,
  args        jsonb NOT NULL DEFAULT '{}',
  result      jsonb,
  trust_class trust_class NOT NULL,
  approved_by approver,
  sandbox_id  text,
  duration_ms integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_step_idx ON tool_calls (step_id);

-- 4/5 MemoryRecord — typed memory with provenance, confidence, expiry,
-- and auditable supersession instead of silent overwrites (§7.2).
-- `embedding` is dimensionless until the embedding model is chosen (ADR pending);
-- the ANN index lands in the same migration as that decision.
CREATE TABLE memory_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type              memory_type NOT NULL,
  content           text NOT NULL,
  embedding         vector,
  source            jsonb NOT NULL, -- {task_id?, tool_call_id?, user_stated?}
  confidence        real NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  superseded_by     uuid REFERENCES memory_records (id)
);
CREATE INDEX memory_type_idx   ON memory_records (type) WHERE superseded_by IS NULL;
CREATE INDEX memory_active_idx ON memory_records (last_confirmed_at) WHERE superseded_by IS NULL;

-- 5/5 TraceEvent — everything is inspectable (principle 6); append-only
CREATE TABLE trace_events (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trace_id  uuid NOT NULL,
  span_id   uuid NOT NULL,
  task_id   uuid,
  component text NOT NULL,
  event     text NOT NULL,
  payload   jsonb NOT NULL DEFAULT '{}',
  ts        timestamptz NOT NULL DEFAULT now(),
  cost      numeric(12, 6)
);
CREATE INDEX trace_events_trace_idx ON trace_events (trace_id);
CREATE INDEX trace_events_task_idx  ON trace_events (task_id) WHERE task_id IS NOT NULL;
