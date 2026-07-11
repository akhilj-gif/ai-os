# ADR-0019: Capability-based model routing

**Status:** accepted (2026-07-11) · **Scope:** model-router

## Context

ADR-0011 gave every call the same failover chain (anthropic > xai > gemini >
groq) regardless of what the call was actually for. That was fine with three
free-tier providers, but it meant Gemini absorbed 100% of unpinned traffic —
research/web-search included — even though those calls have nothing to do
with Gemini specifically, while a fourth provider (NVIDIA NIM, open-model
catalog) sat completely unused once added. Akhil, after the 2026-07-11
failover-outage fix, asked directly for something smarter: *"Analyze each
task and route it to the best model based on its capabilities... The routing
should be dynamic, extensible, and configurable — not hardcoded to always use
one provider first."*

## Decision

`callModel()`/`chat()` classify each call into a **capability** and pick the
failover chain for THAT capability, instead of one fixed chain for everything:

- **Capabilities** (`Capability` type): `workspace` (Google Workspace/Gmail/
  Calendar/Drive/Search/Vision), `coding` (coding/general chat/open-source
  reasoning — also the catch-all when nothing else matches, per Akhil's own
  wording), `fast` (ultra-low-latency/simple — the kernel's own internal
  `routing`-role calls).
- **Classification is free** — no extra model round-trip. Tool names already
  on the call are the strongest signal (`gmail_*`/`calendar_*`/`web_search`/
  `fetch_url` → workspace, `code_exec` → coding); prompt/message text is the
  fallback for `callModel()` callers, which have no tools field at all;
  `role: 'routing'` always short-circuits to `fast`.
- **Per-capability chains are data**, not fixed logic — `CAPABILITY_CHAINS: 
  Record<Capability, ProviderName[]>` in `model-router/src/index.ts`. Adding a
  4th bucket or reordering one is a config edit, not a rewrite. This is the
  "configurable, extensible" part of the ask.
- **Premium providers (anthropic/xai) still win unconditionally** when
  configured, ahead of any capability chain — this predates capability
  routing (ADR-0011) and stays orthogonal to it.
- **`MODEL_PROVIDER` still PINS** a single-element chain, capability ignored
  entirely — evals/baselines stay deterministic (unchanged from ADR-0011).
- **Callers can override** via an optional `capability` field on
  `ModelCallInput`/`ChatInput` when they already know better than the
  classifier; every existing call site works unchanged (auto-classified).
- **NVIDIA NIM added as a 4th provider** (`NVIDIA_API_KEY`, OpenAI-compatible,
  `https://integrate.api.nvidia.com/v1`) — the "coding/general/open-source
  reasoning" leg. Models confirmed live 2026-07-11: `meta/llama-3.1-8b-
  instruct` (routing tier) and `meta/llama-3.1-70b-instruct` (execution/
  planning tiers); swap in a stronger model once you've verified it the same
  way — the catalog changes without notice.
- Everything below the chain-selection point is unchanged: infra-failure
  detection (`isInfraFailure`), immediate failover with one fast retry round
  on non-final providers, `MODEL_*` name overrides applying to the primary
  only, embeddings/transcription/synthesis staying provider-pinned (ADR-0006).

## Consequences

- A workspace/search/vision task now defaults to Gemini; a coding/general-chat
  task now defaults to NVIDIA; the kernel's own cheap classification calls
  default to Groq — instead of every unpinned call landing on Gemini first.
  This is a deliberate behavior change, not a regression: the whole point was
  to stop hardcoding one provider first.
- `failover-smoke.ts`'s pre-existing "unpinned chain" assertions changed
  their expected order to match (nvidia unconfigured in that env → `coding`
  bucket resolves to `groq,gemini`, not `gemini,groq`); the stubbed-network
  end-to-end block now pins `capability: 'workspace'` explicitly so it keeps
  proving the failover MECHANISM (429 → next provider serves; 400 → surfaces,
  no failover) independent of which bucket is the default.
- Verified `failover-smoke.ts` **27/27** (was 22/22 — added capability-chain-
  order and classifier assertions, updated the two default-order assertions,
  all other assertions unchanged). Full regression sweep (act/agents/
  approval-notify/context/coordinator/graph/learning/remote/scheduler/trust/
  packs smokes) unaffected, 11/11 suites green. Live end-to-end against real
  providers: a calendar+search prompt served by `gemini-2.5-flash`, a Python-
  debugging prompt served by `meta/llama-3.1-70b-instruct` (NVIDIA), a
  routing-role classification prompt served by `llama-3.1-8b-instant` (Groq)
  — all three through the same `callModel()` real callers use, then reconfirmed
  through the live `/chat` endpoint after a restart.
