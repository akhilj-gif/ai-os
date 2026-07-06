# ADR-0011: Automatic provider failover on infra failures

**Status:** accepted (2026-07-06) · **Scope:** model-router

## Context

The OS runs on free-tier quotas (Gemini daily caps, Groq per-model limits). M7's
scheduler already survives quota exhaustion by deferring runs — but a deferred
07:30 briefing arrives hours late whenever Gemini's cap was spent the previous
evening. There is a second configured provider sitting idle when that happens.

## Decision

`callModel()` and `chat()` walk a **failover chain** instead of a single provider:

- **Chain**: all configured providers in the existing priority order
  (anthropic > xai > gemini > groq). Setting `MODEL_PROVIDER` PINS a
  single-element chain — no failover — so evals and baselines stay
  deterministic and model-specific.
- **What fails over**: only infra-class failures — our `INFRA_RATELIMIT` /
  `INFRA_NETWORK` markers plus SDK errors with status 429/503/413/529.
  Bad requests, auth, and schema errors surface immediately: they would fail
  identically on every provider, and retrying them elsewhere hides bugs.
- **Immediately**: non-final providers get ONE retry round (key rotation, no
  backoff sleeps); only the last provider in the chain gets the full patient
  4-round backoff. Measured failover latency in the smoke: **26ms**.
- **Model names**: `MODEL_*` overrides apply to the PRIMARY only; a fallback
  provider uses its own role defaults (a pinned model name belongs to one
  provider's catalog — `openai/gpt-oss-120b` means nothing to Gemini).
- **Embeddings do not fail over** (ADR-0006): vectors from a different model
  live in a different space; a rate-limited embed stays a retry/defer.

## Consequences

- The morning briefing (and every executor/graph/research call) now lands on
  whichever free tier is alive, on time — directly protecting the M7 soak's
  "zero babysitting" criterion.
- Chat quality may vary across providers on failover days (gemini-2.5-flash vs
  llama-3.3-70b). Accepted: availability beats consistency for a personal OS,
  and pinning remains one env var away.
- Verified by `failover-smoke.ts` (22/22, deterministic, no real network):
  chain selection under env permutations, infra-vs-not classification, and the
  full loop with a stubbed network edge (Gemini 429 → Groq serves in <3s;
  Gemini 400 → surfaces, Groq untouched).
