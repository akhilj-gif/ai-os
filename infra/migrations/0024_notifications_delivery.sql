-- Tier 2-B: proactive delivery. Track which notifications have been pushed to
-- the user's WhatsApp self-chat so the OS can reach out first (morning briefing,
-- watch alerts, autopilot summaries) without re-sending. Delivery is gated by
-- the `proactive_delivery` setting and only fires when the bridge is paired.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivered_wa boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS notifications_undelivered_idx ON notifications (created_at) WHERE delivered_wa = false;
