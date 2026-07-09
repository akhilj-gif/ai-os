-- whatsapp_search_contacts (dogfooding gap 2026-07-09): the bridge always had an
-- address-book /contacts endpoint, but no tool exposed it — when the recent-chats
-- search missed a name ("Sanju" chat fell out of the bridge cache), the model
-- dead-ended and asked the user for a raw JID. Read-class (display names are
-- untrusted content, flagged on the ToolDef) and auto — searching a name is not
-- an action. The pack manifest carries the same policy for fresh installs; this
-- migration backfills the already-installed pack.
INSERT INTO trust_policies (tool, trust_class, auto_approve) VALUES ('whatsapp_search_contacts', 'read', true)
  ON CONFLICT (tool) DO NOTHING;
