# ADR-0022: Pack Forge — the OS writes its own capability packs

**Status:** accepted (2026-07-18) · **Scope:** packs, api · **Milestone:** M20

## Context

Akhil picked "self-extending toolset" as the first beyond-Claude-Code feature:
ask for a capability in chat ("I need a Spotify tool") and the OS builds it.
Claude Code *uses* tools; this OS now *grows* them. The M6 coding-loop
discipline applies unchanged: generate → deterministic verifier → repair →
the ground truth is the verifier, never the model's claim.

## Decision

**Pipeline** (`packages/packs/src/forge.ts` + `dynamic.ts`):
`pack_forge` (chat tool, write/auto — staging is inert) or `POST /packs/forge`
→ planning-tier model writes ONE self-contained module against `FORGE_GUIDE`
→ **safety scan** → dynamic import → **manifest validation** → staged as
`packs-dynamic/<name>.pack.mts` (gitignored per-install state, source
reviewable via `GET /packs/staged`) → **human gate**: `pack_install` (chat,
irreversible/never-auto → the approval card) or `POST
/packs/staged/:name/install` → policies + `capability_packs` row → registry
recomposed live, no restart. On boot, `loadEnabledPacks` re-loads enabled
dynamic packs from disk — **re-running the scan every load**, so a tampered
staged file disables gracefully instead of executing.

**Trust model (v1, stated honestly).** Generated code runs in-process once
installed — there is no in-process sandbox. The gates, in order:

1. **Static scan, allowlist posture**: no imports of any kind (global `fetch`/
   `JSON`/`Date`/`Math`/`URL` only), no `process`/`require`/`eval`/`Function`/
   `globalThis`/`node:`/prototype tampering, size-capped, must be exactly one
   `export default {…}`. A scan can be fooled in principle — hence gates 2–4.
2. **Human install approval** — the source is staged and reviewable first;
   nothing executes before install.
3. **Trust FLOOR baked in at load** (not trusting the manifest): every
   generated tool gets `untrustedOutput=true` (its output latches §8.3 — it
   can never trigger auto-mutations) and `autoApprove=false` (every call
   queues for one-click approval). The pack's claimed `trustClass` is recorded
   but cannot grant autonomy.
4. **Graduation is the user's act**: relaxing a tool to auto happens per-tool
   in /settings (`PUT /policies/:tool`) after the pack has earned trust —
   policies are data (§8.1), no new UI needed.

**Deliberately v2:** secrets/API keys for generated packs (needs a broker
design — v1 forges keyless-API packs only and says so in `requires`),
generated eval suites gym-gating each pack, and wiring the fabrication guard's
inverse (the model answering from parametric knowledge while its queued call
sits pending — see Consequences).

## Consequences

- **Verified deterministically** (`forge-smoke.ts`, 23/23, no model): every
  scan rejection class, staging, name-collision + tool-prefix rules, the
  floor, install rows, registry composition, forged-tool execution,
  boot-reload from disk, and the tamper re-scan.
- **Verified live, full circle (2026-07-18):** `POST /packs/forge` with a
  dictionary request → the model's round-1 attempt FAILED the verifier and the
  repair loop fixed it (rounds: 2 — the discipline working, not a formality)
  → staged source reviewed (clean: keyless API, `AbortSignal.timeout`, error
  handling, honest `read` claim) → installed → chat "define serendipity"
  correctly QUEUED per the floor → policy graduated via `PUT /policies` →
  "define petrichor" → **real 862 ms call to dictionaryapi.dev in the
  `tool_calls` audit**, reply built from the tool result.
- Known v1 quirk (observed live): while a generated read-tool is still
  floor-gated, the model may answer from its own knowledge and leave the
  queued call orphaned. Acceptable for v1 (the answer is labeled by neither
  guard); ties into the graduated-trust feature (idea #11) for a real fix.
- `packs-dynamic/` is per-installation state like `.auth/` — gitignored;
  the audit trail is the install task row + policy rows + reviewable source.
