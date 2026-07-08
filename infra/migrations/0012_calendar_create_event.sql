-- calendar_create_event (real gap found via dogfooding: the OS had no way to
-- actually schedule a meeting — only calendar_list existed). Undoable ("write" per
-- the blueprint's own action-classes table) but approval-required: it's visible to
-- real attendees, and a pending approval is what lets the tool fire reliably even
-- in a task that already read calendar_list/gmail_list beforehand (non-auto tools
-- are queued for the user's approval BEFORE the structural untrusted-content gate
-- is ever consulted — see packages/kernel/src/executor.ts queuePendingAction).
INSERT INTO trust_policies (tool, trust_class, auto_approve) VALUES ('calendar_create_event', 'write', false)
  ON CONFLICT (tool) DO NOTHING;
