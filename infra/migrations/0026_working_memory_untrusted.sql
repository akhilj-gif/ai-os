-- Working-memory provenance (2026-08-13, memory-poisoning audit).
--
-- wm_set is trustClass 'read' and auto-approved, but it WRITES durable rows, so
-- the §8.3 gate (which only blocks write/irreversible/spend) never stopped it
-- persisting attacker-authored text while untrusted content was in context. Then
-- wm_get read it straight back as ordinary trusted tool output.
--
-- memory_records got this for free because its `source` column is JSONB; this
-- table stores plain columns, so the flag needs to be real. Default false means
-- every existing row keeps its current meaning (first-party), and the column is
-- only ever SET from the executor's live latch — never from model-supplied args,
-- so a compromised model cannot mark its own writes as clean.
ALTER TABLE working_memory
  ADD COLUMN IF NOT EXISTS untrusted boolean NOT NULL DEFAULT false;
