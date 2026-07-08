-- M10 Learning Loop (ADR-0014). The OS improves itself: failure signals →
-- LLM-proposed playbook → GYM-VERIFIED → adopted (only if no regression) or queued.
-- Every proposed improvement is a row here — the change, its evidence (the gym
-- verdict), and its fate — so self-improvement is fully auditable and reversible.
CREATE TABLE improvements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL,                       -- failed-tasks | eval-regression | failure-corpus | manual
  rationale   text NOT NULL,                        -- the model's root-cause / why-this-helps
  artifact    jsonb NOT NULL,                        -- the proposed change: {kind:'playbook', subject, content}
  status      text NOT NULL DEFAULT 'proposed',      -- proposed | verifying | adopted | rejected | queued
  verdict     jsonb,                                 -- gym result: {regressed, adopt, detail, ...}
  memory_id   uuid,                                  -- the procedural memory created iff adopted
  task_id     uuid REFERENCES tasks (id),            -- the learning-cycle task (provenance)
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX improvements_status_idx ON improvements (status, created_at DESC);
