# ADR-0012: Capability Packs — the kernel goes domain-free

**Status:** accepted (2026-07-06) · **Milestone:** M9

## Context

The blueprint's promise is a personal OS that "does anything I ask" — support-ops,
WhatsApp, X, finance, travel — without the kernel becoming a junk drawer of
domain code. M1–M8 built domain capability (Gmail, calendar, web, code exec)
directly into the tool layer + prompt. To scale to N domains without the kernel
rotting, capability must become **data you install**, not code you merge.

## Decision

A **capability pack** is a manifest (`@ai-os/packs`):
`{ tools, prompt fragment, procedural memories, trust policies, eval suites, requires }`.
Manifests live in code (typed, reviewable); **install STATE** lives in one table
(`capability_packs`: name, version, enabled, install_task_id).

- **The kernel is domain-free.** `composeRegistry(enabled)` = kernel-core tools
  (the per-task workspace, nothing else) + the union of enabled packs' tools.
  With zero packs enabled, the OS can read/write its workspace and nothing more.
  Proven, not asserted: `packs-smoke.ts` shows the empty-set surface is exactly
  `workspace_{list,read,write}`.
- **Runtime composition, hot-swappable.** The API loads enabled packs at boot and
  recomposes on install/enable/disable. Every executor entry (chat, graph,
  research, resume, scheduler) receives the composed registry + the packs' prompt
  fragments via `runTask`'s new `extraSystem` seam. The scheduler takes a registry
  *factory*, so a toggle applies to the next tick with no restart.
- **Install is an auditable task.** `installPack` creates a `done` task as the
  provenance for the memories it seeds; policies apply idempotently
  (`ON CONFLICT DO NOTHING` — never clobbers a user's trust edits); memory seeding
  is best-effort (a dead embedding quota warns, never fails the install).
- **Packs ship their own evals.** `support-triage` is bundled with the support-ops
  pack; the gym runs pack suites and reports an uncollected suite honestly rather
  than gating on it.

The four seed packs (`google`, `research`, `coding` enabled at migration;
`support-ops` installed **live via the API** to prove "installs without kernel
changes") exactly reproduce the pre-M9 tool surface — behavior is unchanged at
migration time.

## Consequences

- The kernel stops growing per domain. WhatsApp/X/finance/travel arrive as packs
  (M9.5) touching zero kernel code — the frozen-kernel/growing-library split the
  blueprint calls for.
- Disabling a pack removes its tools from live execution: verified end-to-end —
  with `research` disabled the watch automation fails honestly
  ("fetch_url unavailable — enable the research pack"), and succeeds again once
  re-enabled.
- A subtle coupling surfaced: every code path that runs a task MUST thread the
  composed registry, or it silently falls back to all-tools. `run-now` had this
  bug; fixed. The lesson is that the composed registry is now a cross-cutting
  invariant, not an optional argument.
- Support-ops tools (Trinity/Redash) stay deferred (ADR-0003); the pack exists as
  prompt + procedural memories + a (still-empty) eval suite until Akhil asks.
- Verified by `packs-smoke.ts` (17/17, no model): domain-free core, additive
  composition, idempotent+auditable install, enable/disable surface changes.
