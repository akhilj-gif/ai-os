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

- **This is a life OS, not a ticket tool** (Akhil, 2026-07-03 — ADR-0003). The travel map is `docs/DOMAINS.md`: Email/Calendar arrived at M1, research/files alongside, WhatsApp/X at M9 after trust hardening, finance/travel/home at M9.5. Support ops is an eval surface only; **Redash is deferred until Akhil asks**.
- **M0 (Definition & Skeleton) — COMPLETE 2026-07-03** (commit e9d6eca): docs reviewed, substrate boots, hello-world trace verified in Langfuse (login akhil.j@emergent.sh / aios-dev-password at :3030).
- **M1 (Walking Skeleton) — built 2026-07-03, both exit criteria demonstrated:** (1) "what's on my plate today?" → correct inbox+calendar summary with [mail:]/[event:] citations against Akhil's real Google account; (2) server killed mid-task → resumed from checkpoint on boot and completed (trace: task.resume_on_boot → task.resumed → task.done). Built: chat UI (:3000) → resumable executor loop (per-iteration checkpoints in `tasks.checkpoints`, keep 3, resume-on-boot) → 8 tools behind the TrustGate (web_search DDG-lite, workspace_list/read/write task-scoped, gmail_list/read/create_draft — **no send tool exists**, calendar_list) → every call in the `tool_calls` audit log. Implementation choices: ADR-0004. Soak M1 with daily use before starting M2 (the gym).
- **Model provider** (ADR-0002): env-resolved, Anthropic > xAI (key present, $0 credits) > **Gemini free tier (active)**. Free tier = 5 req/min on gemini-2.5-flash; router does 429/503 retry-with-backoff (FC-013). Tool-calling `chat()` is OpenAI-shape only until the message IR lands (ADR-0004).
- **Google OAuth connected** (2026-07-03): GCP project `ai-os-501220` on Akhil's PERSONAL account (jinukuntlaakhilakumargoud@gmail.com, not the emergent.sh work account); scopes gmail.readonly + gmail.compose + calendar.readonly; refresh token in `oauth_tokens`. Consent app is **Testing** status → refresh token expires every 7 days; **pending decision: publish app** (Audience page) for a persistent token.
- Rolling: failure corpus **15/50** (FC-013/014/015 came from the OS's own runs — rate-limit handling ✅fixed, literal Gmail search, DDG scrape flake); `support-triage` needs ~20 real tickets before M2.
- Ops notes: Docker Desktop can crash on boot with "file cannot be accessed" on stale unix-socket files after unclean shutdowns — quit Docker, rename `%LOCALAPPDATA%\Docker\run` (and `docker-secrets-engine` if named), relaunch. Containers have no restart policy → `docker compose up -d` in `infra/` after Docker restarts. Dev servers: preview config `ai-os-web` runs `pnpm dev` (api :4000 + web :3000).

## Stack (decided — blueprint §5)

TypeScript end-to-end · Node/Fastify kernel · Next.js UI · Postgres+pgvector · Redis · MCP tool layer · Claude API via a model router (Haiku=routing, Sonnet=execution, Fable/Opus=planning) · Docker sandbox · Langfuse tracing.

## Conventions

- Monorepo layout per blueprint §10 (`packages/kernel`, `packages/memory`, `packages/trust`, `packages/model-router`, `packages/tools`, `packages/scheduler`, `packages/shared`, `apps/api`, `apps/web`, `evals/`, `infra/`).
- Record significant decisions as ADRs in `docs/adr/`.
- Update the "Current status" section above whenever a milestone advances.
