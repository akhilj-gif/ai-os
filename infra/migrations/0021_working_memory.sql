-- Memory OS Phase 4: Working Memory — session-scoped scratch for the "current
-- task" (variables, choices, active context) that should persist across turns
-- within a session but is NOT long-term knowledge. Key-value per session; the
-- Forgetting Engine sweeps stale rows. Distinct from memory_records on purpose:
-- this is volatile short-term memory, not the durable cognitive store.
CREATE TABLE IF NOT EXISTS working_memory (
  session_id uuid NOT NULL,
  key        text NOT NULL,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, key)
);
CREATE INDEX IF NOT EXISTS working_memory_updated_idx ON working_memory (updated_at);
