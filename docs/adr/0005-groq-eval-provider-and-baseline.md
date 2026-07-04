# ADR-0005 — Groq as the eval-execution provider; baseline semantics

**Date:** 2026-07-04 · **Status:** Accepted

## Context

The eval gym (M2) could not record a baseline: Gemini's free tier exhausts after
~8–12 calls (FC-017), nowhere near a full 9-case run, confirmed across 6 runs / 2 days.
A baseline needs a model that (a) sustains a full run and (b) reliably calls tools.

## Decisions

1. **Groq added as a provider** (`GROQ_API_KEY`, `gsk_` keys — this is Groq the
   fast-inference host, NOT xAI Grok). OpenAI-compatible endpoint, so it reuses the
   existing `chat()` tool-calling path. Generous free tier; sustains full gym runs.
2. **`MODEL_PROVIDER` env override** added to `resolveProvider`. It forces one
   provider regardless of auto-priority, so the gym runs on Groq
   (`MODEL_PROVIDER=groq`) **without** switching the chat app off Gemini (the daily
   driver stays Gemini via auto-priority when `MODEL_PROVIDER` is unset).
3. **Eval execution model = `openai/gpt-oss-120b`** (on Groq). `llama-3.3-70b`
   under-called tools (many cases failed the `requiresTool` precondition); gpt-oss-120b
   calls tools eagerly and defends injections well.
4. **Baseline is a per-case regression tripwire, recorded on the first COMPLETE run**
   (no skips) at whatever scores result — known-failing cases are baked in. A hard
   failure thereafter = a case that PASSED in the baseline now fails (per-case, so a
   swapped failure is caught even at a flat score), a gate100 breach (M5+), or a crash.
   This matches blueprint §6 ("baselines.json: last accepted scores; CI fails on
   regression") and unblocks recording without demanding 100%.

## Consequences

- **The baseline is model-specific** (recorded on gpt-oss-120b). If the execution
  model changes, delete `baselines.json` and re-record — scores are not comparable
  across models. The committed baseline documents its `model` field.
- First recorded baseline (2026-07-04): tool-reliability 4/4, injection-defense 4/5.
  The one known-failing case (inj-005) is a text-assertion limitation (FC-021), not a
  security breach — every case passes the decisive `noDraftCreated` trace assertion.
- Text-quality assertions (refused? admitted absence?) are regex today and brittle
  across models/phrasings (FC-021); the LLM-judge tier (EVAL-SPEC §3) is the real fix.
- Blueprint's production intent remains Claude (ADR-0002); Groq/gpt-oss is a dev/eval
  execution provider, added to the router's priority list after Gemini.
