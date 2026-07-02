# AI OS — Personal AI Operating System

Akhil's long-term project: a personal AI Operating System — a persistent, trustworthy layer over his **entire digital life** (work/support ops, WhatsApp, X/Twitter, finance, travel, everything). Chat is one interface among many. End state: "anything I ask, it can plan and do" — delivered as installable capability packs on a domain-free kernel.

## Source of truth

**Read [docs/BLUEPRINT.md](docs/BLUEPRINT.md) before any architectural or roadmap decision.** It contains the north star, principles, architecture, data contracts, build-vs-buy decisions, the M0–M10 milestone roadmap with exit criteria, and the risk register. Update it when decisions change — it is a living document.

## Non-negotiable principles (short form — full list in blueprint §3)

- **Vertical slice first** — every milestone ships a working end-to-end system, never a layer in isolation.
- **Evals before features** — the gym (`evals/`) gates every change; injection-defense suite must stay at 100%.
- **Trust is architecture** — action classes (`read`/`write`/`irreversible`/`spend`), audit log, and injection defense from commit #1. Sends on personal channels (WhatsApp/X) are `irreversible` → approval required.
- **Buy the plumbing, build the brain** — MCP for tools, Temporal/Inngest for durable workflows, pgvector, Langfuse. Build: planner, memory, context engine, trust gate, evals.
- **One agent until evals prove two.**
- Do not start milestone N+1 until milestone N's exit criteria pass.

## Current status

- **Milestone: M0 (Definition & Skeleton)** — in progress as of 2026-07-02.
- M0 docs drafted 2026-07-02 (pending Akhil's review): `docs/VISION.md`, `docs/PRINCIPLES.md`, `docs/PRD-support-ops.md`, `docs/EVAL-SPEC.md`, and `docs/FAILURE-CORPUS.md` (12/50 entries seeded from real documented failures — Akhil to collect the remaining 38 during daily work).
- Skeleton built 2026-07-02: pnpm monorepo (blueprint §10 layout), docker-compose (`infra/` — Postgres+pgvector, Redis, Langfuse v2 self-host headless-initialized on :3030), 5 data contracts as tables (`infra/migrations/0001_contracts.sql`) + zod v4 types (`packages/shared`), tracing (every API request + kernel task writes `trace_events`; model calls span to Langfuse). `pnpm dev` boots API (:4000) + web shell (:3000); `pnpm db:migrate`, `pnpm hello` work. Dev choices recorded in `docs/adr/0001-m0-skeleton-choices.md`.
- Model provider is env-resolved (ADR-0002): `ANTHROPIC_API_KEY` → Claude (production intent) > `XAI_API_KEY` → Grok (Anthropic-compatible; key present but team has $0 credits) > `GEMINI_API_KEY` → Gemini free tier via OpenAI-compatible endpoint (**active dev provider**; Akhil's personal Pro key, fallback key commented in `.env`).
- **M0 technical exit criteria met 2026-07-02:** `pnpm dev` boots kernel+UI; `pnpm hello` → Gemini model call → trace verified in Langfuse (login: akhil.j@emergent.sh / aios-dev-password at localhost:3030) with task row `done` + spent tokens recorded.
- Docs reviewed by Akhil 2026-07-03 ✓ (plus a verification pass: corpus tables corrected, Redash outage re-confirmed then deprioritized).
- M0 remaining before closing: **(1)** failure corpus 12/50 → 50 (collected during daily work — entries from ANY life domain count); **(2)** first git commit (repo has zero commits).
- M1 next: chat → agent loop → 3 tools (web search, filesystem workspace, Gmail/Calendar read+draft) per amended blueprint §M1.
- **Google OAuth ready (2026-07-03):** GCP project `ai-os-501220` on Akhil's PERSONAL account (jinukuntlaakhilakumargoud@gmail.com — deliberately not the emergent.sh work account). Gmail API + Calendar API enabled; consent screen "AI OS" (External, **Testing** status — refresh tokens expire after 7 days until published; decide at M1); Akhil is the sole test user; client `ai-os-kernel` (Web app) with redirect `http://localhost:4000/oauth/google/callback`. `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` are in `.env` (older duplicate secret disabled in console). M1 must request scopes: gmail.readonly, gmail.compose, calendar.readonly.
- Ops note: Docker Desktop on this machine can crash on boot with "file cannot be accessed" on stale unix-socket files after unclean shutdowns — fix: quit Docker, rename `%LOCALAPPDATA%\Docker\run` (and `%LOCALAPPDATA%\docker-secrets-engine` if named in the error), relaunch. Containers have no restart policy: run `docker compose up -d` in `infra/` after Docker restarts.
- **This is a life OS, not a ticket tool** (Akhil, 2026-07-03 — ADR-0003). The travel map is `docs/DOMAINS.md`: Email/Calendar arrives at M1, research/files alongside, WhatsApp/X at M9 after trust hardening, finance/travel/home at M9.5. Support ops stays as an eval surface only; **Redash is deferred until Akhil asks**.

## Stack (decided — blueprint §5)

TypeScript end-to-end · Node/Fastify kernel · Next.js UI · Postgres+pgvector · Redis · MCP tool layer · Claude API via a model router (Haiku=routing, Sonnet=execution, Fable/Opus=planning) · Docker sandbox · Langfuse tracing.

## Conventions

- Monorepo layout per blueprint §10 (`packages/kernel`, `packages/memory`, `packages/trust`, `packages/model-router`, `packages/tools`, `packages/scheduler`, `packages/shared`, `apps/api`, `apps/web`, `evals/`, `infra/`).
- Record significant decisions as ADRs in `docs/adr/`.
- Update the "Current status" section above whenever a milestone advances.
