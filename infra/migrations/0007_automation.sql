-- M7 Automation & Proactivity (ADR-0010): a durable Postgres-backed scheduler.
-- Jobs are rows; every execution is a job_runs row; every user-facing output of an
-- unattended run is a notifications row (the ONLY output channel — automation jobs
-- are fixed read-only pipelines, they never reach mutating tools).

CREATE TABLE jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL,                    -- briefing | watch | reflect (executor key)
  schedule    jsonb NOT NULL,                   -- {kind:'daily',time:'HH:MM'} | {kind:'interval',minutes:N} | {kind:'once',at:iso}
  payload     jsonb NOT NULL DEFAULT '{}',      -- executor input (watch: {url})
  state       jsonb NOT NULL DEFAULT '{}',      -- executor cursor (watch: lastHash) + failStreak
  enabled     boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,                      -- null = never (once-jobs after firing)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due_idx ON jobs (next_run_at) WHERE enabled;

CREATE TABLE job_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'running',  -- running | done | failed | deferred | missed
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  output      jsonb,
  error       text,
  trace_id    uuid
);
CREATE INDEX job_runs_job_idx ON job_runs (job_id, started_at DESC);

-- Proactivity surface: briefings and watch-alerts land here; the UI shows them.
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL DEFAULT 'info',      -- briefing | watch | info
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  job_id     uuid REFERENCES jobs (id) ON DELETE SET NULL,
  read       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread_idx ON notifications (created_at DESC) WHERE NOT read;
