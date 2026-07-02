# ADR-0001 — M0 skeleton choices

**Date:** 2026-07-02 · **Status:** Accepted

## Context

M0 requires a bootable monorepo, the 5 data contracts as tables + types, docker-compose
substrate, and tracing. Several small decisions were made that the blueprint left open.

## Decisions

1. **Langfuse v2 (self-host, single container)** for tracing, not v3. v3 requires ClickHouse +
   MinIO + a worker — too heavy for a dev laptop at M0. v2 shares the compose Postgres
   (separate `langfuse` database) and supports headless init (`LANGFUSE_INIT_*`), so SDK keys
   work with zero UI setup. Revisit at M2 if eval volume outgrows v2.
2. **Plain SQL migrations + `pg`, no ORM.** The 5 contracts are the architecture; hiding them
   behind an ORM obscures the thing we most need to see. Runner: `infra/migrate.ts`
   (transactional, tracked in `schema_migrations`).
3. **`tsx` as the dev runtime, no build step.** Workspace packages export `src/index.ts`
   directly. A build/publish pipeline is premature before there's anything to deploy.
4. **`memory_records.embedding` is dimensionless** (`vector`, no typmod) until an embedding
   model is chosen (M3 ADR). The ANN index lands with that decision — pgvector requires a
   fixed dimension to index.
5. **Dev credentials are hardcoded in docker-compose** (postgres `aios`, Langfuse init keys).
   Acceptable for a localhost-only dev substrate; the secrets broker arrives at M5 and any
   deployment beyond localhost re-opens this.
6. **Workflow engine (Temporal vs Inngest vs Trigger.dev) deliberately NOT chosen.** First
   needed at M4; deciding now would be speculation. Blocking ADR before M4 starts.

## Consequences

- `pnpm dev` boots API + web with zero compiled artifacts.
- Contracts change = one SQL migration + one zod edit (`packages/shared/src/contracts.ts`) — kept in sync by hand for now; a drift check belongs in the M2 CI gate.
