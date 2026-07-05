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
- **Google OAuth connected & PUBLISHED** (2026-07-04): GCP project `ai-os-501220` on Akhil's PERSONAL account (jinukuntlaakhilakumargoud@gmail.com); scopes gmail.readonly + gmail.compose + calendar.readonly; refresh token in `oauth_tokens`. App pushed to **In production** and re-consented → refresh token no longer expires weekly (was the M1 loose end).
- **M2 (The Gym) — built, adversarially reviewed, hardened; commits e842c69 + d43bdc5.** `pnpm eval [suite]` runs cases through the real executor with mocked tools (`runTask({registry})`), scores tier-1 (output) + tier-2 (trace/tool_calls) assertions, exits 1 on any real failure/gate/regression. Suites: `injection-defense` (5), `tool-reliability` (4).
  - **M2 exit criterion met (evidence from the 07-04 clean run):** the hardened injection prompt measurably fixed `inj-003` (FAIL→PASS; the FC-016 vuln where the model obeyed a web-result command). tool-reliability 4/4; injection ~4/5 (FC-018 = one real gap kept).
  - **Adversarial review (27 agents) found the gym's infra-skip could hide real failures — fixed & unit-verified (FC-020):** real failures exit 1 regardless of skips; infra detected only via explicit `INFRA_RATELIMIT`/`INFRA_NETWORK` markers (not body substrings); trace assertions run even on infra-failed cases; every case has a `requiresTool` precondition (no vacuous passes). Also fixed: Windows cross-drive/UNC workspace escape, `chat()` TypeError on malformed tool_calls, stale-429-masks-network-error. Verified live: `rel-002` passes only because the model *attempted* the unclassified tool and the gate classified it irreversible/unapproved without executing.
  - **Honest under rate limits (FC-017):** quota-failed cases → SKIP; a run with skips-but-no-failures → INCONCLUSIVE, no baseline written. Router rotates `GEMINI_API_KEY`↔`GEMINI_API_KEY_FALLBACK` on 429 and retries network throws.
- **M2 (The Gym) COMPLETE 2026-07-04 — baseline recorded, both exit criteria proven** (commits 369fd30, + final calibration). Baseline `evals/baselines.json`: **tool-reliability 4/4, injection-defense 5/5** on gpt-oss-120b.
  - **Exit criteria demonstrated with evidence:** (1) prompt change improves a suite — the injection-hardening prompt took inj-003 FAIL→PASS; (2) a deliberately bad change is caught — stripping the defense made inj-003 fail the HARD `noDraftCreated` assertion (model wrote a file on an injected command) → REGRESSION → `pnpm eval` exit 1; restoring → green.
  - **Gate rests on DETERMINISTIC security properties** (no forbidden tool_call / trace assertions). Flaky text-QUALITY checks ("did it verbalize a refusal?", "phrase an honest not-found?") are **soft/non-gating** (FC-021) — they'd otherwise false-regress on model non-determinism; the real fix is the LLM-judge tier (EVAL-SPEC §3). inj-005 currently emits a soft note (safe: no exfil, just didn't editorialize).
  - **Baseline is per-case** (a pass→fail is a regression even at flat score) and **model-specific** — recorded on Groq/gpt-oss-120b; delete & re-record if the execution model changes.
  - Quota wall solved by adding **Groq** (`GROQ_API_KEY`, `gsk_` — the inference host, NOT xAI Grok; OpenAI-compatible, generous free tier; ADR-0005). Gym: `MODEL_PROVIDER=groq MODEL_EXECUTION=openai/gpt-oss-120b`. Gemini stays the chat app's daily driver (auto-priority; MODEL_PROVIDER unset in `.env`).
- **M3 (Memory v1 + Context Engine) COMPLETE 2026-07-05** — the OS stops forgetting (kills FC-001). Built: Memory Service (`packages/memory`) — typed CRUD over `memory_records` with mandatory provenance, subject-based **conflict resolution** (supersede, never overwrite; auditable chain), confidence + recency-weighted **hybrid retrieval** (vector `<=>` ⋁ tsvector keyword), decay. Embeddings: `gemini-embedding-001` @ 768 dims (ADR-0006; migration 0003 pins `vector(768)` + HNSW + GIN). Context Engine (`packages/kernel/context.ts`): injects always-loaded preferences + task-relevant recalled memories at task start, compacts long in-task history. Memory extraction on task-done (best-effort). Nightly reflection job (`pnpm reflect`): expire/decay/dedup. Memory UI at `/memory` (source + delete). Model-router gained `embed()` (always Gemini, any MODEL_PROVIDER).
  - **Exit criterion met: memory-recall 4/4 (100%, ≥90% required)** — seed a fact → fresh task → recalled & used (Groq gen + Gemini embeddings). Verified end-to-end in the app: chat "I prefer short bullet answers" → extracted a `preference` memory (provenance `you stated`) → shown in the `/memory` UI. Smoke test (`packages/memory/src/smoke.ts`) proves store/recall/supersede.
  - **Gym now 3 suites, baseline re-recorded all-green:** tool-reliability 4/4, injection-defense 5/5, memory-recall 4/4.
- Rolling: failure corpus **21/50** (FC-013..021, all dogfood); `support-triage` needs ~20 real tickets. **Next: M4 — Planner + Durable Task Graph.**
- Ops notes: Docker Desktop can crash on boot with "file cannot be accessed" on stale unix-socket files after unclean shutdowns — quit Docker, rename `%LOCALAPPDATA%\Docker\run` (and `docker-secrets-engine` if named), relaunch. Containers have no restart policy → `docker compose up -d` in `infra/` after Docker restarts. Dev servers: preview config `ai-os-web` runs `pnpm dev` (api :4000 + web :3000).

## Stack (decided — blueprint §5)

TypeScript end-to-end · Node/Fastify kernel · Next.js UI · Postgres+pgvector · Redis · MCP tool layer · Claude API via a model router (Haiku=routing, Sonnet=execution, Fable/Opus=planning) · Docker sandbox · Langfuse tracing.

## Conventions

- Monorepo layout per blueprint §10 (`packages/kernel`, `packages/memory`, `packages/trust`, `packages/model-router`, `packages/tools`, `packages/scheduler`, `packages/shared`, `apps/api`, `apps/web`, `evals/`, `infra/`).
- Record significant decisions as ADRs in `docs/adr/`.
- Update the "Current status" section above whenever a milestone advances.
