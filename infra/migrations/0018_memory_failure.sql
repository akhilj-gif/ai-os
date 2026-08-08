-- Experiential memory (Memory OS Phase 1): the OS learns from task execution.
-- 'episodic' already exists and is already recalled by the Context Engine, but
-- nothing ever wrote one. Add a 'failure' kind so a failed task becomes durable
-- knowledge (cause + prevention) that surfaces on similar future tasks — the
-- differentiator general chat assistants can't build (they don't run the tasks).
-- PG16: ADD VALUE runs fine inside the migration txn as long as the new value
-- isn't USED in the same txn (it isn't — only capture code written later uses it).
ALTER TYPE memory_type ADD VALUE IF NOT EXISTS 'failure';
