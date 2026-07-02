# ADR-0002 — Alternative dev model providers (Grok, Gemini)

**Date:** 2026-07-02 · **Status:** Accepted (amended same day — see Addendum)

## Context

M0's exit criterion needs a real traced model call, but there is no Anthropic API key available
yet. xAI's API exposes an Anthropic-compatible Messages endpoint (`https://api.x.ai`), so the
existing `@anthropic-ai/sdk` client works against it with only a `baseURL` + key change.

## Decision

The model router resolves its provider from the environment: `ANTHROPIC_API_KEY` → Anthropic
(preferred when present), else `XAI_API_KEY` → xAI with Grok defaults
(routing: `grok-4-fast-non-reasoning`, execution: `grok-4-fast-reasoning`, planning: `grok-4`).
`MODEL_*` env vars override either table. No second SDK, no second code path — this is exactly
the swappability the router exists for (blueprint §4.2: the router owns model selection, never
prompt content).

## Consequences

- Dev/testing can run on Grok's free-tier credits. Note: the free tier is rate-limited, not
  unlimited — fine for smoke tests and early evals, revisit before eval suites get large.
- Blueprint §5's Claude routing table remains the production intent; when a Claude key arrives,
  setting it flips the provider back with zero code changes.
- Eval baselines are provider-specific: once the gym exists (M2), baselines recorded on Grok
  must be re-baselined if the provider flips. Record the provider in every eval report.
- Anything provider-specific beyond the Messages shape (prompt caching, token counting) must
  stay inside the router.

## Addendum (2026-07-02): Gemini free tier via OpenAI-compatible shape

Grok turned out not to be free for new accounts — Akhil's xAI team has $0 credits and no
free-credits program was offered (verified in console.x.ai). The router therefore gained a
second API shape: `kind: 'openai'` (plain-fetch `chat/completions` client, no extra SDK),
with Google Gemini's free tier as the first provider
(defaults: `gemini-2.5-flash-lite` / `gemini-2.5-flash` / `gemini-2.5-pro`).
Key priority: `ANTHROPIC_API_KEY` > `XAI_API_KEY` > `GEMINI_API_KEY`. Any OpenAI-compatible
endpoint (Groq, OpenRouter) can now slot in as one more `resolveProvider` branch.
