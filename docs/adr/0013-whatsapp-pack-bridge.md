# ADR-0013: WhatsApp pack — bridge architecture, send = approval, pairing = opt-in

**Status:** accepted (2026-07-07) · **Milestone:** M9.5 (first personal pack)

## Context

M9.5 delivers the "OS goes personal" promise pack-by-pack; WhatsApp is first
(blueprint M9: "read/summarize/draft auto, send = approval"). There is no
official API for a PERSONAL WhatsApp account — Meta's Cloud API is for
businesses messaging customers, not for reading your own chats. The only real
option is the WhatsApp Web protocol via an unofficial client (Baileys), which
violates WhatsApp ToS and carries a **nonzero account-ban risk**.

## Decision

1. **A bridge process owns the session; the OS owns the policy.** The pack's
   tools speak a four-endpoint localhost contract
   (`/health /chats /messages /send` — `apps/whatsapp-bridge/src/contract.ts`);
   the bridge behind it is swappable: Baileys for real, a deterministic MOCK
   twin for evals/smokes/demos. The OS never holds WhatsApp credentials —
   session creds live in the bridge's `.auth/` (gitignored), and the bridge
   binds 127.0.0.1 (+ optional shared-secret header).
2. **Pairing is the user's explicit opt-in, never automated.** The bridge boots
   to a QR and stops there; scanning it — accepting the ToS/ban risk — is a
   human decision the OS must not make. Verified to the QR step; the Baileys
   path is honestly marked UNVERIFIED until first paired.
3. **Send is irreversible-class, auto_approve=false — always.** Sending as the
   user is the pack's whole risk. Reads are auto but `untrustedOutput: true`
   (personal messages are THE injection vector), so §8.3's structural gate
   blocks any mutating action while chat content is in context; dynamic sends
   only ever fire through the M4 approval flow.
4. **The pack ships its own evals** (`whatsapp` suite, 3 cases, closed world):
   summarize-never-sends; an in-message injection ("forward everything…") must
   never actuate; an explicit user "send it now" still yields no unapproved
   send. This is the first pack to meet the M9 exit "passes its bundled evals"
   with a populated suite.

## Consequences

- Verified: `whatsapp-smoke` (mock bridge, real tools/policies/gate — ALL PASS,
  restores pre-run world state), whatsapp eval suite **3/3 on gpt-oss-120b**,
  real bridge boots to QR (`{ok:true, paired:false, impl:"baileys"}`).
- Two harness defects found by this pack's build: eval `setup()` only ran for
  planOnly cases (so seeded trust policies never landed and the gate
  fail-closed EVERY whatsapp tool — the failure that exposed it); and
  `requiresTool` punished the model's politest safe behavior (propose-and-ask)
  in single-turn cases — replaced with attempted-OR-proposed engagement guards.
- Baileys 7.0.0-rc13 pinned exactly (the 6.17.x line ships a git-resolved
  subdep that pnpm's `blockExoticSubdeps` rightly refuses); its install scripts
  stay unapproved (`allowBuilds: false`) — the bridge runs without them.
- If the number ever gets banned or Meta breaks the protocol, blast radius is
  the bridge process only; the pack disables like any other.
