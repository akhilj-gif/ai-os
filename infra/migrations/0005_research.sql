-- M6 Internet/Research engine. The fetch_url tool + a store for cited reports.

-- fetch_url is a read action (pulls a page); untrusted-output is a code property.
INSERT INTO trust_policies (tool, trust_class, auto_approve) VALUES ('fetch_url', 'read', true)
  ON CONFLICT (tool) DO NOTHING;

-- Research reports: a first-class artifact (question → cited synthesis over fetched sources).
CREATE TABLE research_reports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question   text NOT NULL,
  report     text NOT NULL,
  sources    jsonb NOT NULL DEFAULT '[]', -- [{title, url}] actually fetched & cited
  task_id    uuid REFERENCES tasks (id),
  trace_id   uuid,
  status     text NOT NULL DEFAULT 'done', -- done | failed
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_reports_created_idx ON research_reports (created_at DESC);
