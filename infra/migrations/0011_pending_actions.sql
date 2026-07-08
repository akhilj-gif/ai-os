-- Chat approval flow: when the ReAct chat loop wants an approval-required tool
-- (irreversible/spend, e.g. whatsapp_send_message), it can't auto-run it and it
-- can't collect approval mid-loop — so it QUEUES the exact call here and ends the
-- turn telling the user. The user approves in the app; the API then executes the
-- EXACT args they saw. Auto mutating tools never come here (still hard-blocked
-- under untrusted context) — so injected content can never auto-trigger a send;
-- the human seeing the exact args is the injection check for approval-required ones.
CREATE TABLE pending_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           uuid REFERENCES tasks (id),
  session_id        uuid,
  tool              text NOT NULL,
  args              jsonb NOT NULL DEFAULT '{}',
  trust_class       text NOT NULL,
  untrusted_context boolean NOT NULL DEFAULT false, -- was external/untrusted content in context when proposed?
  status            text NOT NULL DEFAULT 'pending', -- pending | executed | failed | rejected
  result            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz
);
CREATE INDEX pending_actions_pending_idx ON pending_actions (created_at DESC) WHERE status = 'pending';
