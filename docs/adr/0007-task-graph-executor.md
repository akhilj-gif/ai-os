# ADR-0007 — Postgres-backed task-graph executor (M4), Temporal deferred

**Date:** 2026-07-05 · **Status:** Accepted

## Context

M4 needs durable multi-step execution: goal → plan → a DAG of steps run
sequentially/in-parallel, surviving crashes, with pause / redirect / resume and
approval gates. Blueprint §5 says *buy* durable workflows (Temporal / Inngest /
Trigger.dev). But those are heavy to operate on a solo laptop (Temporal = server +
workers + its own datastore; Inngest = a dev server / cloud), and their value —
retries, timers, resume-after-crash, signals — we only need a small slice of today.

## Decision

**Build a thin task-graph executor on Postgres now.** The durable state IS the
`steps` table (the M0 contract already has `kind`, `depends_on`, `status`,
`input`, `output`). A driver loop:

1. picks *runnable* steps (`pending` with all `depends_on` in `done`),
2. runs them (bounded parallelism), persisting each step's status/output,
3. repeats until the graph is `done`, `failed`, `paused`, or `awaiting_approval`.

Durability & control come from the DB, not a framework:
- **Resume-after-crash + exactly-once:** on restart the driver re-reads the graph
  and skips `done` steps — a completed side-effecting step never re-runs. **This
  closes FC-019** (M1's at-least-once gap).
- **Pause/resume:** `tasks.status = 'paused'` stops new-step scheduling.
- **Redirect:** `tasks.pending_directive` is consumed at a step boundary and folded
  into a replan of the remaining steps.
- **Approval:** an `approval` step sets `awaiting_approval` and halts until a
  decision arrives, then the graph continues.

## Consequences

- No new infra; the executor is ours and small. The Task/Step **contract** is the
  seam — if orchestration outgrows this (durable timers, high fan-out, cron at
  scale, cross-service signals), a Temporal/Inngest *driver* can replace the loop
  without changing the graph model or the planner. Thin adapter, contracts ours
  (risk register: framework churn).
- Retries/timeouts are hand-rolled and minimal for now (per-step `retries` column
  exists). Acceptable at current scale; revisit with the engine swap.
- M1's `runTask` (single reason-act loop) stays for quick chat turns; the planner
  emits a graph for multi-step goals. Unifying the two is deferred (not needed for
  M4's exit).
