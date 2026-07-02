# DOMAINS — the travel map

**Version:** 1.0 · **Date:** 2026-07-03 · **Owner:** Akhil
**What this is:** the definitive list of life areas the OS must cover, in travel order — what "arrived" means in each, how we get access, and what trust ceiling applies. The kernel (M1–M8) is the vehicle; every domain below is a destination reached as a **capability pack** on that kernel, not as kernel features.

> Correction that produced this doc (2026-07-03): this OS is **not a ticket tool**. Support ops is one eval surface among many, and Redash is deferred until it's wanted. The destination is Akhil's whole life.

---

## The journey at a glance

| # | Domain | Arrives | Access path | Trust ceiling at arrival |
|---|--------|---------|-------------|--------------------------|
| 1 | **Email & Calendar** | **M1** (first real tool) | Gmail / Google Calendar APIs — official, easy | read + draft (`write`); send = approval |
| 2 | **Knowledge & Research** | M1 (web search) → M6 (engine) | search APIs, fetch, monitored sources | read-only by nature |
| 3 | **Files & personal documents** | M1 (workspace) → M9.5 (filing pack) | filesystem tool, scoped workspaces | `write` in workspace only |
| 4 | **Coding** | M6 | sandbox + git; PR after approval | `write` in sandbox; push/PR = approval |
| 5 | **Work / support ops** | background wedge, M2 evals; Redash **deferred** | Trinity MCP (exists), Redash later | read + draft; nothing sent, ever auto |
| 6 | **WhatsApp (messaging)** | M9 — after trust hardening (M5) | Matrix bridge (mautrix-whatsapp) behind an MCP server; never Baileys-style libs (ban risk) | read/summarize/draft auto; **send = `irreversible`, approval per message** |
| 7 | **X / Twitter (social)** | M9 | monitoring for reads; official API/browser for writes | digests auto; **post = approval** |
| 8 | **Finance** | M9.5 | aggregator/read-only APIs, statement ingestion | read-only; **`spend` never auto — permanent rule** |
| 9 | **Travel & logistics** | M9.5 | email parsing (bookings), calendar, search, browser fallback | plan/track auto; book = `spend` → approval |
| 10 | **Home & life admin** | M9.5 | reminders, shopping lists, renewals, document filing | `write` auto; purchases = approval |

Travel rule: a domain arrives **only** as a pack (manifest: prompts + procedural memories + MCP servers + policies + eval suite) that installs with zero kernel changes. If a domain needs a kernel change, the kernel isn't done — fix that first.

---

## Per-domain definition of "arrived"

### 1. Email & Calendar — *the first taste of a life OS (M1)*
- **Arrived when:** "what's on my plate today?" returns a cited summary of inbox + calendar; "draft a reply to X" produces a draft I approve before anything sends; a mid-task server kill resumes cleanly.
- **First win:** morning "plate" summary replacing the manual inbox scan.
- **Eval seeds:** summarization accuracy vs. real inbox fixtures; draft tone; send-approval gate never bypassed.

### 2. Knowledge & Research
- **Arrived when (M6):** monitored sources (HN, ArXiv, GitHub, RSS, topics I care about) produce a daily digest that's accurate against its sources 5 days straight; "research X deeply" returns a cited multi-source answer.
- **First win (M1):** web search tool with citations in the walking skeleton.
- **Eval seeds:** digest-vs-source accuracy; citation validity; hallucinated-source rate = 0.

### 3. Files & personal documents
- **Arrived when:** "file this PDF where it belongs" and "find that insurance document from March" both work against an organized personal store.
- **First win (M1):** scoped filesystem workspace tool.
- **Eval seeds:** retrieval precision on a seeded document set.

### 4. Coding
- **Arrived when (M6):** it fixes a real bug in one of my repos with a passing test and an opened PR after my approval.
- **Eval seeds:** repo-understanding QA; test-pass rate on known-bug fixtures.

### 5. Work / support ops — *the background wedge, not the identity*
- **Status:** Trinity MCP already exists; the 12-entry failure corpus draws heavily from here because it's where daily failure data is free. That's its job: **eval fuel**.
- **Deferred:** Redash integration (connection broken anyway — see PRD open questions). Revisit when Akhil asks, not before.
- **Arrived when:** honestly — it already pays rent via `/issue`; the pack version (M9 pack #1) just proves the kernel is domain-free.

### 6. WhatsApp — *the highest-trust destination*
- **Why it waits for M9:** a wrong message to the wrong person damages a relationship. Sends stay `irreversible` (per-message approval) until per-contact allowlists are earned through a clean track record. Drafts are shown **verbatim**, never paraphrased.
- **Arrived when:** I triage my WhatsApp backlog through the OS — summaries auto, replies drafted, every send approved by me; reminders extracted from chats land in the calendar.
- **Route:** own Matrix homeserver + mautrix-whatsapp bridge, wrapped in an MCP server. Business Cloud API as fallback (separate number). Never unofficial client libs.
- **Eval seeds:** injection defense on message content (messages are untrusted input!); draft-approval gate; summary accuracy.

### 7. X / Twitter
- **Arrived when:** topic/account monitoring produces engagement digests; drafted posts/replies queue for approval; one approved tweet posts through the OS.
- **Eval seeds:** digest accuracy; zero unapproved publishes.

### 8. Finance
- **Arrived when:** spend tracking, bill reminders, and a subscription audit run read-only from statements/aggregators; monthly "where did money go" report.
- **Hard rule forever:** `spend` class never auto-approves. Read-only until the trust gate has months of clean history.

### 9. Travel & logistics
- **Arrived when:** "plan the Goa trip" produces an itinerary with real options; bookings I make are auto-tracked from email into the calendar with reminders.

### 10. Home & life admin
- **Arrived when:** renewals, appointments, and shopping lists maintain themselves from conversations and documents, with proactive nudges that are right >90% of the time.

---

## What this changes right now (M1 scope)

M1's walking skeleton keeps its shape — chat → one agent loop → 3 MCP tools → traced, resumable — but the third tool is now **Email/Calendar (Gmail)**, not Redash (ADR-0003):

1. **web search** (Knowledge)
2. **filesystem workspace** (Files)
3. **email/calendar read + draft** (Email & Calendar — the first life domain)

**New M1 exit test:** "what's on my plate today?" → correct, cited inbox+calendar summary; kill the server mid-task → it resumes. Trust gate live from the first tool: reads auto, drafts logged, **send button doesn't exist yet**.

The failure corpus stays open to *all* domains — a bad research answer or a missed calendar conflict is as corpus-worthy as any ticket.
