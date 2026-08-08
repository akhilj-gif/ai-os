-- Tier 2-C: Standing agents — long-horizon goals the OS advances on its own,
-- one safe (read-only) step at a time, between sessions. Each goal keeps a
-- running progress log; a cadence gate stops it from churning every tick.
CREATE TABLE IF NOT EXISTS standing_goals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal            text NOT NULL,
  status          text NOT NULL DEFAULT 'active',   -- active | paused | done
  cadence_minutes int  NOT NULL DEFAULT 360,        -- min gap between auto-advances
  progress        text NOT NULL DEFAULT '',         -- appended running log of steps taken
  steps           int  NOT NULL DEFAULT 0,
  last_advanced_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS standing_goals_active_idx ON standing_goals (status, last_advanced_at);
