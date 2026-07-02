# AI Operating System — Master Blueprint

**Version:** 1.0 · **Date:** 2026-07-02 · **Owner:** Akhil
**Status:** Living document — update the milestone tracker after every milestone review.

---

## 1. North Star

> Build a personal AI Operating System: a persistent, trustworthy layer between a person and their **entire digital life** — work, messaging (WhatsApp), social (X/Twitter), finance, travel, everything. Chat is one interface among many. It plans, remembers, acts through tools, runs work in the background, and provably gets better every month.

**End state:** a true personal assistant — anything Akhil asks, it can plan and do (within the trust model). The architecture achieves "anything" not by hardcoding features but by making every new domain an installable capability pack (§ M9) on the same kernel.

**What it is NOT:** a chatbot with plugins, a ChatGPT clone, or a framework for other developers (that comes later).

**The one-sentence test for every feature:** *"Does this help the OS complete a real task end-to-end with less human effort than last month?"* If no — cut it.

---

## 2. Product Definition (Phase 0)

### 2.1 Full scope vs. first wedge

**The full scope is your whole life.** Target domains, in eventual coverage order:

| Domain | Examples of "anything I ask" |
|---|---|
| Work / support ops | triage tickets, Redash lookups, drafted replies, queue briefings |
| Messaging | WhatsApp: read summaries, drafted replies, reminders from chats, send-on-approval |
| Social | X/Twitter: monitor topics & accounts, draft posts/replies, engagement digests |
| Knowledge & research | deep research, monitoring, learning plans |
| Coding | full coding engine (§ M6) |
| Finance | spend tracking, bill reminders, subscription audits |
| Travel & logistics | plan trips, track bookings, calendar orchestration |
| Home / life admin | shopping lists, renewals, appointments, document filing |

**But do not BUILD in that order.** A general assistant loses to ChatGPT/Claude on day one. Prove the kernel on **one job where you are the expert user**, then every other domain is a capability pack on the same kernel — new MCP servers + playbooks + policies, zero kernel changes.

> **Amendment (2026-07-03, ADR-0003):** the per-domain travel order, arrival criteria, and access paths now live in [DOMAINS.md](DOMAINS.md). Support ops remains an eval surface (its failure data is free), but the first *life* domain — Email/Calendar — arrives at M1, and Redash is deferred until wanted.

**First wedge: Support Operations Copilot** — because you (the builder) are the expert user:

- Triage an incoming ticket → classify → pull context (Trinity, Redash, billing data)
- Draft a KB-backed reply with citations
- Detect patterns across tickets → proactive alerts
- Morning briefing: overnight queue summary, SLA risks, anomalies

This gives you: real tasks, real failure data, a real eval set, and a user (you) who can judge quality instantly. Every layer of the OS (planner, memory, tools, automation, trust) is exercised by this single wedge.

### Personal-channel reality check (know this before promising "anything")

| Channel | Access reality | Plan |
|---|---|---|
| **WhatsApp** | No official personal-account API. Options: WhatsApp Business Cloud API (separate number, official), a Matrix bridge (mautrix-whatsapp) on your own server, or unofficial libraries (Baileys/whatsmeow — **account-ban risk**) | Start with a Matrix bridge behind an MCP server; treat every send as `irreversible` (approval required) until trust is earned |
| **X/Twitter** | Official API is paid and rate-limited at useful tiers | Read via monitoring/scraping tools for digests; write via official API free tier (limited posts) or browser automation with approval gates |
| **Email / Calendar** | Official APIs (Gmail/Google Calendar) — easy | Early capability pack, low friction |
| **Banking / finance** | Aggregator APIs vary by country; often read-only | Read-only first; **`spend` class is never auto-approved** |
| **Anything with no API** | Browser Agent in the sandbox | Slowest and most fragile path — use it as the fallback, not the default |

Rule of thumb: **acting as you on personal channels is the highest-trust action class in the whole OS.** A wrong Redash query wastes a minute; a wrong WhatsApp message to the wrong person damages a relationship. Personal channels therefore arrive *after* the trust gate is hardened (M5), not before.

### 2.2 Differentiation (why not just use X?)

| vs | Their gap | Our answer |
|---|---|---|
| ChatGPT | Session-centric; memory is shallow; no durable background work | Persistent task graph + structured memory + automations that run without you |
| Claude | Superb reasoning, but tool ecosystem is per-session | OS-level standing context: your tools, your memory, your routines are always mounted |
| Wingman | Domain-locked to its product surface | Open tool layer (MCP) — any system becomes a capability |
| Devin | Coding-only | Coding is one engine among many, sharing the same memory and trust model |

### 2.3 Phase 0 deliverables (write these before code)

```
docs/
  VISION.md            ← the north star, 1 page max
  PRINCIPLES.md        ← the 10 rules below
  PRD-support-ops.md   ← the wedge use case, user stories, success metrics
  FAILURE-CORPUS.md    ← 50 real tasks where current assistants fail you
  EVAL-SPEC.md         ← how those 50 become scored, repeatable tests
```

The **failure corpus** is the most valuable document. Collect 50 real tasks from your daily work where ChatGPT/Claude/Wingman fail or need too much babysitting. These become your eval suite (§6) and your roadmap justification.

---

## 3. Core Principles (the constitution)

1. **Vertical slice first.** Every milestone ships a thinner version of the whole system, never a layer in isolation.
2. **Evals before features.** No component ships without a scored test. If you can't measure it, you can't improve it.
3. **Trust is architecture, not a phase.** Permissions, audit log, and injection defense exist from commit #1.
4. **Buy the plumbing, build the brain.** Differentiation lives in planning, memory, and learning loops — never in rebuilding queues, workflow engines, or tool protocols.
5. **One agent until evals prove two.** Specialist agents are added only when a measured task shows the split wins.
6. **Everything is inspectable.** Every plan, tool call, memory read/write, and token spent is traceable to a task ID.
7. **Interruptible by design.** Any task can be paused, redirected, or resumed. State lives in the database, not in a process.
8. **Untrusted content never gets authority.** Web pages, emails, and tool outputs can inform, never instruct (§8.3).
9. **Memory has provenance and expiry.** Every remembered fact knows where it came from and when to be doubted.
10. **Cost is a feature.** Per-task token budgets, model routing, monthly caps. An OS you can't afford to run is a demo.

---

## 4. System Architecture

### 4.1 Layer diagram

```
┌─────────────────────────────────────────────────────────────┐
│  INTERFACES        chat · dashboard · API · notifications   │
├─────────────────────────────────────────────────────────────┤
│  KERNEL                                                     │
│   ┌───────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐  │
│   │  Session  │→ │ Planner  │→ │ Task      │→ │ Executor │  │
│   │  Manager  │  │ (brain)  │  │ Graph     │  │ Loop     │  │
│   └───────────┘  └──────────┘  └───────────┘  └──────────┘  │
│         │              │              │             │        │
│   ┌─────┴──────────────┴──────────────┴─────────────┴────┐  │
│   │        CONTEXT ENGINE (what enters the model)        │  │
│   │   budgeting · retrieval · compaction · assembly      │  │
│   └───────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│  SERVICES                                                   │
│   Memory Service │ Model Router │ Trust Gate │ Scheduler    │
├─────────────────────────────────────────────────────────────┤
│  TOOL LAYER (MCP)                                           │
│   browser · files · email · calendar · code-sandbox ·       │
│   search · Redash · Trinity · terminal · custom servers     │
├─────────────────────────────────────────────────────────────┤
│  SUBSTRATE                                                  │
│   Postgres (+pgvector) · Redis · object store ·             │
│   sandbox runtime (Docker) · OpenTelemetry + LLM tracing    │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Component responsibilities

| Component | Owns | Never does |
|---|---|---|
| **Session Manager** | conversations, user identity, interface fan-out | reasoning |
| **Planner** | goal interpretation, clarification, task-graph generation, replanning | executing tools directly |
| **Task Graph** | durable DAG of steps: status, dependencies, checkpoints, approvals | holding state in memory only |
| **Executor Loop** | runs one step: assemble context → call model → dispatch tools → record | deciding *what* to do next (planner's job) |
| **Context Engine** | token budgeting, memory retrieval ranking, history compaction | storing anything |
| **Memory Service** | typed memory CRUD, provenance, decay, conflict resolution | deciding what's relevant *now* (context engine's job) |
| **Model Router** | model selection per step class, fallbacks, cost tracking | prompt content |
| **Trust Gate** | action classification, permission checks, approval requests, audit log | being bypassable |
| **Scheduler** | cron + event triggers, wakes tasks | executing anything itself |

### 4.3 Data contracts (define these in week 1 — they are the real architecture)

```typescript
Task {
  id, goal, status: draft|planning|running|paused|awaiting_approval|done|failed,
  plan: Step[], budget: {tokens, cost_usd}, spent: {...},
  created_by: user|schedule|trigger, trace_id, checkpoints: Checkpoint[]
}

Step {
  id, task_id, kind: reason|tool|approval|subtask,
  depends_on: StepId[], status, input, output,
  model_used, tokens, retries, error?
}

ToolCall {
  id, step_id, tool, args, result,
  trust_class: read|write|irreversible|spend,
  approved_by?: user|policy, sandbox_id?, duration_ms
}

MemoryRecord {
  id, type: episodic|semantic|preference|procedural|project|document,
  content, embedding, source: {task_id?, tool_call_id?, user_stated?},
  confidence: 0..1, created_at, last_confirmed_at, expires_at?,
  superseded_by?: MemoryId          // conflict resolution
}

TraceEvent {
  trace_id, span_id, task_id, component, event, payload, ts, cost?
}
```

If these five schemas are right, every layer above them can be rewritten cheaply. Spend real design time here.

---

## 5. Build vs Buy (decided up front)

| Concern | Decision | Rationale |
|---|---|---|
| Agent loop | **Build thin** (or Claude Agent SDK) | This IS the product; keep it small and yours |
| Tool protocol | **Buy: MCP** | Thousands of servers exist; your marketplace = MCP registry curation |
| Durable workflows | **Buy: Temporal / Inngest / Trigger.dev** | Retries, timeouts, resume-after-crash are solved problems |
| Vector search | **Buy: pgvector** | One database; no separate vector DB until proven necessary |
| LLM tracing | **Buy: Langfuse (self-host) or Braintrust** | Eval + tracing in one; do not hand-roll |
| Sandbox | **Buy: Docker (dev) → gVisor/Firecracker (later)** | Never exec on host |
| Auth (later) | **Buy: managed auth** | Zero differentiation |
| Planner, memory schema, context engine, trust gate, evals | **BUILD** | This is the moat |

**Stack:** TypeScript end-to-end · Node/Fastify (kernel) · Next.js (UI) · Postgres+pgvector · Redis · Claude API via Model Router (Haiku = routing/classification, Sonnet = execution, Fable/Opus = planning & hard reasoning).

---

## 6. The Eval Harness ("the gym") — build in Milestone 2, use forever

Every capability gets a task suite: fixture inputs → agent run → scored output.

```
evals/
  suites/
    support-triage/     ← 20 real tickets, expected classifications + reply rubrics
    memory-recall/      ← "told the system X on day 1, ask on day 30"
    tool-reliability/   ← flaky tool, rate limit, malformed response handling
    injection-defense/  ← 15 attack payloads embedded in web pages & ticket bodies
    planning/           ← multi-step goals with known-good decompositions
  runner.ts             ← runs suite → scores (LLM-judge + assertions) → report
  baselines.json        ← last accepted scores; CI fails on regression
```

**Rules:**
- New feature → new eval cases first (from the failure corpus).
- Prompt change, model change, memory change → full run before merge.
- Track per-suite: success rate, cost per task, latency p50/p95.
- The injection-defense suite must stay at 100%. It gates every release.

---

## 7. Memory Architecture

### 7.1 Six typed stores, one service

| Type | Contents | Written by | Retrieval |
|---|---|---|---|
| **Episodic** | what happened (task summaries) | executor, on task end | recency + similarity |
| **Semantic** | facts about the world/user's domain | reflection pass | similarity |
| **Preference** | how the user likes things | explicit statements + confirmed patterns | always-loaded (small) |
| **Procedural** | how to do recurring tasks (learned playbooks) | reflection after repeated success | matched by task type |
| **Project** | active goals, constraints, status | planner | loaded by project tag |
| **Document** | ingested files/pages, chunked | ingestion pipeline | hybrid search |

### 7.2 Hygiene (the part everyone skips)

- **Provenance:** every record cites its source (task, tool call, or "user stated").
- **Confidence + decay:** unconfirmed facts decay; retrieval down-ranks stale records.
- **Conflict resolution:** new contradicting fact → old record gets `superseded_by`, never silently overwritten. The chain is auditable.
- **Reflection job (nightly):** dedupe, merge, extract semantic facts from episodic logs, propose procedural memories, expire junk.
- **User-visible:** the Memory page in the UI shows every record with source + delete button. Trust requires inspectability.

### 7.3 Context Engine (what to LOAD — harder than what to store)

Per model call, assemble under an explicit token budget:

```
budget = model_context × 0.6          // headroom for output + tools
  1. system + tool schemas            (fixed)
  2. preference memory                (always, ~small)
  3. task state + current step        (always)
  4. retrieved memories               (ranked: relevance × confidence × recency, top-k until budget)
  5. conversation history             (recent verbatim; older → compacted summaries)
```

Compaction is a first-class operation with its own eval suite ("does the agent still know X after 3 compactions?").

---

## 8. Trust & Security Model (built into the kernel, not bolted on)

### 8.1 Action classes

Every tool call is classified before execution:

| Class | Examples | Default policy |
|---|---|---|
| `read` | search, fetch, query Redash | auto |
| `write` | create file, draft email, add calendar event | auto + logged, undoable where possible |
| `irreversible` | send email, delete, deploy, post publicly | **approval required** |
| `spend` | purchases, paid API calls beyond budget | **approval required** |

User can tighten/loosen per tool, per capability, per task. Policies are data, not code.

### 8.2 Sandbox

- All code execution and browsing in containers: no host FS, egress allowlist, CPU/mem/time limits.
- Filesystem tool is scoped to per-task workspaces.
- Secrets live in a broker; agents get short-lived scoped tokens, never raw credentials in context.

### 8.3 Prompt injection defense (the #1 threat for an agent OS)

1. **Provenance tagging:** every context block is labeled `trusted` (user, system, own memory) or `untrusted` (web, email, ticket bodies, tool results).
2. **Authority rule:** instructions in untrusted content are data, never commands. Enforced by prompt structure *and* by the Trust Gate: a step whose current context contains untrusted content **cannot trigger `irreversible`/`spend` actions without human approval**, regardless of what the model decides.
3. **Quarantine pattern:** untrusted content is summarized/extracted by a tool-less model call before entering the main loop where tools are live.
4. **Red-team eval suite** (§6) runs on every release.

### 8.4 Audit

Append-only log: every tool call, approval, memory write, and token spent, keyed by task. The dashboard renders it as a timeline. Nothing the OS does is invisible.

---

## 9. Roadmap — 10 milestones, each a working system

Estimates assume part-time solo building (~10–15 h/wk). Halve them if full-time. **Exit criteria are the contract — do not start Mn+1 until Mn's criteria pass.**

### M0 — Definition & Skeleton *(2 weeks)*
Vision, PRD, failure corpus (50 tasks), eval spec. Repo scaffold, Postgres/Redis via docker-compose, tracing wired (every request has a trace_id), the 5 data contracts implemented as tables + types.
**Exit:** docs reviewed; `pnpm dev` boots kernel + UI shell; a trace appears in Langfuse for a hello-world model call.

### M1 — Walking Skeleton *(3 weeks)* *(amended by ADR-0003)*
Chat interface → single agent loop → **3 MCP tools** (web search, filesystem workspace, **email/calendar read+draft via Gmail APIs**) → response. Sessions persist. Trust Gate exists from the first tool (reads auto, drafts logged; send capability does not exist yet). Every step traced.
**Exit:** ask "what's on my plate today?" → correct, cited inbox+calendar summary; kill the server mid-task → task resumes.

### M2 — The Gym *(2 weeks)*
Eval runner + 3 suites from the failure corpus (support-triage, tool-reliability, injection-defense v1). Baselines recorded. CI gate.
**Exit:** one prompt change measurably improves a suite score; one deliberately bad change is caught by CI.

### M3 — Memory v1 + Context Engine *(3 weeks)*
Typed memory tables, provenance, retrieval, always-loaded preferences, history compaction, nightly reflection job (basic). Memory page in UI with delete.
**Exit:** memory-recall eval ≥ 90%; tell it a preference Monday, it's honored Friday without re-stating; every memory shows its source.

### M4 — Planner + Durable Task Graph *(4 weeks)*
Goal → clarifying questions (when genuinely ambiguous) → task graph → parallel/sequential execution on the workflow engine (Temporal/Inngest). Pause, redirect ("actually use the other account"), resume. Approval steps.
**Exit:** a 6+ step real task (triage ticket → pull billing → draft reply → await approval → log note) runs end-to-end; can be paused mid-run, edited, resumed; planning eval suite passes baseline.

### M5 — Trust Hardening + Sandbox *(3 weeks)*
Full action-class enforcement, per-tool policies UI, container sandbox for code/browse, secrets broker, quarantine pattern for untrusted content, injection suite → 100%.
**Exit:** red-team payload embedded in a ticket body fails to trigger any `irreversible` action across the whole suite; code runs only in containers.

### M6 — Engines: Coding + Internet *(5 weeks)*
Coding engine: repo understanding → plan → edit in sandbox → run tests → diff for approval → commit/PR. Internet engine: monitored sources (HN, ArXiv, GitHub, RSS), search-summarize-compare, trend detection.
**Exit:** it fixes a real bug in one of your repos with a passing test, PR opened after your approval; daily AI-news digest is accurate against sources 5 days straight.

### M7 — Automation & Proactivity *(3 weeks)*
Scheduler (cron + event triggers) creating standard Tasks. Morning briefing, queue-anomaly alerts, "watch this and tell me when" flows. Notification routing (chat/email/push) with quiet hours.
**Exit:** 3 automations run for 2 weeks with zero babysitting; false-alert rate < 10%.

### M8 — OS Interface *(4 weeks)*
Beyond chat: Dashboard (live tasks, costs, approvals inbox), Task inspector (plan/trace/timeline), Memory browser, Automation manager, Settings (policies, budgets, models). Approvals answerable from notification.
**Exit:** a full day's work is manageable without opening raw logs; approval round-trip < 30 s from phone/desktop.

### M9 — Capability Packs: the OS goes personal *(5 weeks)*
A capability = manifest {prompts, procedural memories, MCP servers, policies, eval suite}. Install/enable/disable. Ship 5:
1. **Support-Ops** (extracted from core — proves the kernel is domain-free)
2. **Research** (internet engine packaged)
3. **Coding** (coding engine packaged)
4. **WhatsApp** (bridge MCP server; read/summarize/draft auto, send = approval)
5. **X/Twitter** (monitoring digests + drafted posts, publish = approval)
**Exit:** a new capability installs without kernel changes and passes its bundled evals; core kernel has no support-ops-specific code left; you triage your personal WhatsApp backlog and post one approved tweet through the OS.

### M9.5 — Personal life expansion *(rolling, one pack at a time)*
Email/Calendar → Finance (read-only) → Travel → Shopping/life-admin. One pack per 1–2 weeks, each with its own eval suite and policy defaults. The "do anything I ask" promise is delivered here — as an ever-growing pack library on a frozen kernel, not as kernel features.

### M10 — Learning Loop *(ongoing from here)*
Reflection engine upgraded: failed tasks → root-cause analysis → proposed playbook/prompt changes → **verified in the gym** → auto-adopted or queued for review. Weekly self-report: what improved, what regressed, cost trends.
**Exit:** two consecutive months where eval scores rise and cost-per-task falls without manual prompt editing.

### Deferred (correctly)
Multi-user/orgs/RBAC · public SDK & marketplace · third-party developer API. Revisit only after M10 sustains a month of daily personal use.

---

## 10. Repository Structure

```
ai-os/
  docs/                    ← Phase 0 docs + ADRs (architecture decision records)
  packages/
    kernel/                ← session, planner, task-graph, executor, context-engine
    memory/                ← memory service + reflection jobs
    trust/                 ← action classes, policies, gate, audit
    model-router/          ← providers, routing table, budgets, fallbacks
    tools/                 ← MCP client + first-party MCP servers
    scheduler/             ← cron/triggers → tasks
    shared/                ← the 5 data contracts, telemetry
  apps/
    api/                   ← Fastify gateway (chat, tasks, approvals)
    web/                   ← Next.js OS interface
  evals/                   ← suites, runner, baselines (CI-gated)
  infra/                   ← docker-compose, migrations, sandbox images
```

---

## 11. Metrics That Matter

| Metric | Target by M8 |
|---|---|
| Task success rate (eval suites) | ≥ 85% overall, 100% injection defense |
| End-to-end task completion without human rescue | ≥ 70% |
| Cost per completed task | trending down month-over-month |
| Approval round-trip time | < 30 s |
| Memory recall accuracy (30-day) | ≥ 90% |
| Automations running unattended | ≥ 3 for ≥ 14 days |
| Your own daily usage | every workday (the honest metric) |

---

## 12. Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Scope explosion → never ships | **High** | Milestone exit criteria are contracts; deferred list is sacred |
| Prompt injection incident | High | §8.3 architecture + gated 100% eval suite |
| Memory poisoning (bad facts accumulate) | Medium | provenance, confidence decay, nightly reflection, user-visible delete |
| Token costs spiral | Medium | model router tiers, per-task budgets, monthly cap alerts |
| Framework churn (MCP/SDK evolution) | Medium | thin adapters; contracts (§4.3) are yours, protocols are replaceable |
| Wrong message sent as you (WhatsApp/X) | Medium | sends are `irreversible` class → approval required by default; per-contact allowlists before any auto-send; drafts shown verbatim, never paraphrased |
| WhatsApp unofficial-API account ban | Medium | prefer Matrix bridge / Business API over Baileys-style libraries; never mass-send |
| Solo-builder burnout | High | vertical slices = usable product every milestone; M1 already saves you time at work |
| A frontier lab ships your wedge | Medium | your moat is *your* memory, *your* tools, *your* playbooks — personal depth, not general breadth |

---

## 13. Operating Cadence

- **Weekly:** review eval dashboard (scores, cost, regressions); triage failure corpus additions.
- **Per milestone:** demo to yourself using only the product (no logs); write a 1-page retro; update this blueprint.
- **Monthly:** re-run the full gym; prune memory; review deferred list — promote at most one item.

---

*The plan's core bet: an OS earns trust the same way a person does — by remembering accurately, acting predictably, asking before doing anything irreversible, and demonstrably improving. Everything above serves those four behaviors.*
