-- M11 checkpoint-resume: the orchestration PLAN persists on the parent task
-- ({subtasks, children: {subtaskId: childTaskId}}), written in the SAME
-- transaction that creates the child rows. A restart mid-orchestration resumes
-- the existing children (terminal ones reuse their recorded results, running
-- ones continue from their own executor checkpoints) instead of re-planning —
-- re-planning duplicated children live 2026-07-10. NULL = not an orchestration
-- (or a legacy pre-0015 run, which the boot guard still fails honestly).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_plan jsonb;
