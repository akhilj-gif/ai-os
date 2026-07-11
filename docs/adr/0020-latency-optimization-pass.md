# ADR-0020: Latency optimization pass

**Status:** accepted (2026-07-11) · **Scope:** kernel executor, api, model-router

## Context

Akhil: *"Whenever I try to make any tasks, giving tasks to the model, it is
taking more time... I want the conversation to be real time, to be fast."*
Followed by a 13-point wishlist (profile the pipeline, load-once at startup,
parallelize independent ops, stream immediately, cache prompts/embeddings/
tool metadata, persistent connections, minimize model hops, lightweight
models escalating only when needed, avoid redundant context injection,
pre-warm providers, measure every stage, <500ms first-token for simple chat,
before/after report per change).

Rather than mechanically build all 13 as new machinery, this pass traced the
real `/chat` request pipeline first (`completeChatTask` → `runTask`'s ReAct
loop) and fixed what was actually there — several items turned out to already
be true; two were real, measurable bottlenecks; one discovery (NVIDIA latency
variance) wasn't on the list at all.

## Decision

**Already true, verified, no code needed** (reported honestly rather than
"fixed" for their own sake):
- Tools/packs load once at boot (`enabledPacks` loaded before `listen`,
  `composeRegistry()` is a cheap in-memory recompose, microseconds).
- DB connections are already a persistent `pg.Pool` singleton; Node's `fetch`
  (undici) keeps HTTP connections alive to providers by default.
- Memory-context injection is NOT redundant — every chat message is its own
  `tasks` row by design (M1), so per-message recall is the feature working as
  intended, not a bug to cache away.
- Router/classifier overhead (ADR-0019's capability classification) is
  synchronous regex over already-in-memory data — microseconds, not worth
  instrumenting further.

**Real fixes:**
1. **Memory extraction no longer blocks the response.** `extractAndStore()`
   (a background "what's worth remembering" LLM call after every completed
   turn) was `await`-ed before `runTask` returned — the user waited on a
   learning step with zero bearing on their answer. Now fire-and-forget
   (`void extractAndStore(...).then(...).catch(...)`), matching the
   fire-and-forget pattern `resumeTaskById` already uses at boot. Failure
   handling unchanged (was always best-effort/non-fatal).
2. **`classifyGoal` and memory-context assembly now run in parallel.** Both
   only need `task.goal`; neither depends on the other's result; they ran
   sequentially before. `completeChatTask` now `Promise.all`s them and passes
   the result into `runTask` via a new optional `precomputedMemory` field
   (`undefined` = compute internally, unchanged for every other caller —
   `runAgentTask`/eval-gym/jobs all pass nothing and are unaffected). Only
   started when the result will actually be used (skipped on `agentMode:
   'off'` boot-resume and `'force'`, where it'd go to waste).
3. **Provider pre-warming at boot.** One fire-and-forget `callModel` per
   capability bucket (workspace/coding/fast) right after packs load — pays
   the DNS/TLS handshake cost before the first real request instead of during
   it. Never blocks `listen`; a warm failure is just a missed warm.
4. **NVIDIA's execution-tier default model changed** (`meta/llama-3.1-70b-
   instruct` → `meta/llama-3.1-8b-instruct`). Not on Akhil's list — found
   *during* this pass: the free/community tier's latency is HIGH VARIANCE,
   not just slower — the 70b model measured 2.9s one call and 27–48s minutes
   later for the identical prompt, no code change in between (shared queue
   depth on NVIDIA's end, outside our control). 70b stays on the `planning`
   tier only (used less often, already latency-tolerant multi-step work);
   `execution` — everyday chat — now uses the model that was consistently
   1–3s in direct testing. Direct application of Akhil's own "lightweight
   models for simple tasks, escalate only when needed."
5. **Stage-level latency logging** — `console.log('[latency] ...')` at the
   classify+memory step and each `chat()` iteration, matching the existing
   `[model-router]`/`[kernel]` console-log convention. Not a new metrics
   stack; reuses what's already there (Langfuse still owns generation-level
   detail).

**Explicitly NOT done this pass (flagged, not silently dropped):**
- **True token streaming.** The current `/chat` returns one buffered JSON
  response after the full ReAct loop (including all tool round-trips)
  completes — the single biggest lever on *perceived* latency, and the only
  way to structurally hit "<500ms first-token." Not attempted here: it's a
  new capability (SSE/chunked wire contract + provider-level `stream: true` +
  a tool-calling loop that currently needs the FULL tool_calls structure
  before it can act on one), touching the API contract and both frontends
  (`apps/web`, `apps/voice`), not a tuning change. Deserves its own scoped
  milestone (ADR + design) rather than a rushed subset inside a perf pass.
- **Embedding caching.** Considered; skipped — memory-recall embeds the
  CURRENT message text, which is different almost every turn in real
  conversation, so a cache would rarely hit. Revisit only if profiling shows
  repeated identical queries in practice.

## Consequences

- **Controlled comparison** (provider pinned to NVIDIA to hold the model
  constant, isolating just the code-path change): old code averaged 2.85s
  (2.51s/4.57s/1.47s over 3 runs), new code averaged 1.82s (2.80s/1.23s/
  1.42s) — roughly a 36% reduction, consistent with removing one blocking
  model round-trip and overlapping two others.
- **Unpinned (real, live) comparison was noisier and briefly looked WORSE**
  (3.18s/3.72s before vs 4.74s/6.02s after) — root-caused via the new stage
  logs to live Gemini per-key 429-rotation and Groq TPD exhaustion landing
  harder during the "after" window, not a regression: the stage breakdown
  showed classify+memory correctly overlapped (815ms/3904ms as ONE block,
  not two stacked costs) even when the total was dominated by a rate-limited
  hop underneath it. Recorded honestly rather than cherry-picking the
  favorable run.
- **The <500ms first-token target is not met**, and can't be without
  streaming — every fix here reduces total round-trip time, not perceived
  first-token time, since the response is still fully buffered. With
  streaming built later, these fixes compound (less time-to-first-token
  because there's less blocking work before the model call even starts).
- **Full regression sweep unaffected**: 13/13 smokes green (act, agents,
  approval-notify, context, coordinator, graph, learning, remote, scheduler,
  trust, packs, memory, failover). `npx tsc -b` clean.
- Free-tier quota exhaustion (Groq TPD, Gemini per-key RPM) remains the
  single biggest real-world latency variable on this stack today, and no
  application-level fix changes that — only time (daily reset), a paid tier,
  or accepting the variance does.
