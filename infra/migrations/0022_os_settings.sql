-- Tier 2: runtime OS settings (key-value). Small toggles the OS reads at
-- runtime — first user: `autopilot` (off | read) for graduated-trust autonomy,
-- and `proactive_delivery` (off | on) for pushing briefings to WhatsApp. A
-- plain KV table, not per-feature columns, so new toggles need no migration.
CREATE TABLE IF NOT EXISTS os_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO os_settings (key, value) VALUES ('autopilot', 'off'), ('proactive_delivery', 'off')
  ON CONFLICT (key) DO NOTHING;
