-- Trust-gate invariant, enforced by the database (2026-08-12, sharp-edges hunt).
--
-- ONLY 'spend' (money) is a PERMANENT exception to auto-approval — see the
-- Tier 3 "graduated trust" comment above POST /trust/promote in
-- apps/api/src/server.ts: irreversible tools are MEANT to become promotable
-- after demonstrated trust (3 clean approvals) — that is the entire point of
-- the feature (read/write tools are already auto-approved by default and need
-- no promotion). An earlier draft of this migration also blocked
-- 'irreversible' unconditionally, which was an over-correction caught by a
-- second, independent sharp-edges pass re-reviewing this same commit: it would
-- have made graduated trust permanently non-functional (nothing would ever be
-- left to promote). Narrowed to 'spend' before this ever ran on a real database.
--
-- The rule "spend can never auto-approve, and irreversible needs earned trust"
-- was previously enforced only at two HTTP handlers, opportunistically:
--   - POST /trust/promote checked only trust_class = 'spend', and never
--     re-checked its own advertised "3 approvals, 0 rejections" precondition
--     for irreversible tools — any caller could promote any non-spend tool
--     with zero approval history at all.
--   - PUT /policies/:tool checked only 'spend', and only when trustClass AND
--     autoApprove arrived in the SAME request — but the real shipped Settings
--     UI (apps/web/app/settings/page.tsx) sends them as two SEPARATE requests
--     (one per control), so toggling auto-approve on a 'write' tool and later
--     reclassifying that same tool to 'spend' via the dropdown persists
--     trust_class='spend', auto_approve=true through two ordinary clicks — no
--     malice, no API trickery, just the app working as shipped.
-- Both endpoints are now fixed in application code (a shared hasEarnedTrust()
-- check). This CHECK constraint is the backstop for 'spend' specifically —
-- the one invariant that must hold no matter which endpoint, or which future
-- endpoint, touches this table.
UPDATE trust_policies SET auto_approve = false WHERE auto_approve AND trust_class = 'spend';

ALTER TABLE trust_policies
  ADD CONSTRAINT trust_policies_no_auto_approve_spend
  CHECK (NOT (auto_approve AND trust_class = 'spend'));
