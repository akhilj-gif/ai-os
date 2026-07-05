-- M4 Task Graph (blueprint §4.2, ADR-0007). The steps table already has the DAG
-- primitives (kind, depends_on, status, input, output); add human labels, approval
-- state, and task-level control signals for pause/redirect.

-- Human-readable step label + a local planner id (so depends_on can be authored
-- against stable local ids and mapped to uuids at persist time; kept for audit).
ALTER TABLE steps ADD COLUMN title text;
ALTER TABLE steps ADD COLUMN local_id text;

-- Approval steps: the decision lives here. {status: pending|approved|rejected,
-- decided_by, note, decided_at}. NULL for non-approval steps.
ALTER TABLE steps ADD COLUMN approval jsonb;

-- Which tool a `tool` step should call, and with what args (planner output).
-- (input already holds free-form step input; tool/tool_args make tool steps explicit.)
ALTER TABLE steps ADD COLUMN tool text;
ALTER TABLE steps ADD COLUMN tool_args jsonb;

CREATE INDEX steps_status_idx ON steps (task_id, status);

-- Task-level control: a directive the user injects mid-run (redirect), consumed at
-- the next step boundary and folded into a replan. plan_goal keeps the original ask.
ALTER TABLE tasks ADD COLUMN pending_directive text;
