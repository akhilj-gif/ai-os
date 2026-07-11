-- M14b (ADR-0017): the travel decision engine's preferences as DATA — one
-- editable/learnable row. The mobility decision engine reads this to rank and
-- recommend; the learning loop or a settings UI can update it over time, so the
-- agent's judgement improves without code changes. Single row (id=true).
CREATE TABLE IF NOT EXISTS mobility_prefs (
  id         boolean PRIMARY KEY DEFAULT true,
  prefs      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mobility_prefs_singleton CHECK (id)
);
