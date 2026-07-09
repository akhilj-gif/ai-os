-- M11: multi-agent orchestration ("the Brain").
-- parent_task_id: a subtask spawned by the orchestrator is a REAL task row (so
-- checkpoints, steps, trust gating, approvals and tracing all work unchanged),
-- linked to the orchestrating parent. Cascade: deleting a parent removes its
-- children (children are meaningless without the orchestration that made them).
-- untrusted: persists the executor's in-memory untrustedInContext latch at task
-- end, so the orchestrator can PROPAGATE the §8.3 taint across agents — if the
-- researcher read the web, the writer that consumes its output starts tainted.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS parent_task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS untrusted boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_task_id);
-- Subtasks are created BY the orchestrator, not by the user/scheduler.
ALTER TYPE task_origin ADD VALUE IF NOT EXISTS 'agent';
