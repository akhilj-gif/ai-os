-- M1 Walking Skeleton: chat sessions, OAuth token store, trust policies.

-- Sessions persist (M1 exit requirement); Session Manager owns these (blueprint §4.2)
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL DEFAULT 'main',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text NOT NULL,
  task_id    uuid REFERENCES tasks (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_session_idx ON messages (session_id, created_at);
CREATE INDEX messages_task_idx ON messages (task_id) WHERE task_id IS NOT NULL;

-- One row per connected provider. The secrets broker replaces this at M5 (ADR-0001 #5).
CREATE TABLE oauth_tokens (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                text NOT NULL UNIQUE,
  account_email           text,
  refresh_token           text NOT NULL,
  access_token            text,
  access_token_expires_at timestamptz,
  scopes                  text[] NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Policies are data, not code (§8.1). A tool with no row here is treated as
-- irreversible and refused (fail closed) — see @ai-os/trust.
CREATE TABLE trust_policies (
  tool         text PRIMARY KEY,
  trust_class  trust_class NOT NULL,
  auto_approve boolean NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO trust_policies (tool, trust_class, auto_approve) VALUES
  ('web_search',         'read',  true),
  ('workspace_list',     'read',  true),
  ('workspace_read',     'read',  true),
  ('workspace_write',    'write', true),
  ('gmail_list',         'read',  true),
  ('gmail_read',         'read',  true),
  ('gmail_create_draft', 'write', true),  -- draft only; a send tool does not exist in M1
  ('calendar_list',      'read',  true);
