-- M12a (ADR-0015): remote-control channel state. One row per channel
-- ('whatsapp' today); cursor holds the poller's watermark + recently seen /
-- announced ids so a restart never replays old self-chat notes as commands.
CREATE TABLE IF NOT EXISTS remote_channels (
  channel    text PRIMARY KEY,
  cursor     jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_id uuid REFERENCES sessions(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
