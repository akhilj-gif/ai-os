# PRD — Support Operations Copilot (the first wedge)

**Version:** 1.0 · **Date:** 2026-07-02 · **Owner:** Akhil · **Status:** Draft for M0 review

---

## 1. Problem

Akhil is a customer-support agent at Emergent (billing/subscriptions focus). Every ticket costs manual digging: identify the issue from a messy thread, pull customer history from Trinity, check billing state in Redash, find the right KB article, draft a reply in his voice, log a note. Current assistants fail at this in documented ways ([FAILURE-CORPUS.md](FAILURE-CORPUS.md)) — they forget his setup, can't reach the data, can't run unattended, and can't be trusted to act.

**Goal:** cut per-ticket handling time and eliminate the morning queue scan, without giving up control of anything that reaches a customer.

## 2. User & usage context

- **User:** Akhil (n=1, the expert user — instant quality judge). No multi-user support. Deferred per blueprint.
- **Systems:** Trinity (ticketing, read-only MCP), Redash (analytics/billing data), the Emergent KB (`Downloads\kb\articles\<category>\*.md`), Support MCP (ticket messages + internal notes).
- **Prior art to absorb:** the `/issue` slash command (v1, shipped 2026-06-21) — its three-section output format (The issue / Solution from KB / Reply to send + one-line safety check) is the validated reply-drafting UX and carries over as-is.

## 3. Jobs to be done (in build order)

### J1 — Ticket triage & context pull *(M1)*
Given any ticket identifier (UUID, Mongo ID, or plain number), resolve it, classify the issue type, and assemble context: conversation, customer history, and (when billing-related) the customer's subscription/billing state from Redash.

### J2 — KB-backed reply drafting *(M1–M2)*
Draft a reply in Akhil's established format, citing the KB article(s) used. **Solutions come only from the KB.** On a KB miss: say so honestly, offer nearest articles with caveats, produce a clearly-labeled uncited draft, and log the KB gap (FC-008).

### J3 — Morning briefing *(M7)*
Scheduled daily summary: overnight volume, SLA risks, anomalies, recurring-pattern flags (FC-009). Runs unattended.

### J4 — Pattern detection *(M7)*
"This is the 6th coupon-not-applying ticket this week" → proactive alert with the linked tickets.

### J5 — Watch flows *(M7)*
"Watch this ticket, tell me when the customer replies" — durable event-triggered tasks (FC-010).

## 4. User stories & acceptance criteria

| # | Story | Acceptance criteria |
|---|---|---|
| U1 | As Akhil, I paste any ticket reference and get the issue explained in plain language. | All 3 ID formats resolve correctly on the fixture set (FC-004); zero manual ID translation. |
| U2 | As Akhil, I get a reply draft with KB citations I can trust. | Every claim in the draft traces to a cited KB article; KB-miss behavior per J2; draft shown **verbatim** for approval, never auto-sent. |
| U3 | As Akhil, I ask billing questions ("did the promo apply?") and get real data. | Answer cites the Redash query/table used; tool failure surfaces honestly with retry status (FC-002, FC-003). |
| U4 | As Akhil, I state a preference once and it sticks. | Preference honored ≥5 days later, cross-session, without re-statement (FC-001; M3 exit). |
| U5 | As Akhil, I can see everything the copilot did. | Every tool call in the task-keyed audit timeline; nothing invisible (FC-012). |
| U6 | As Akhil, I wake up to a queue briefing. | 14 consecutive unattended days; <10% false alerts (M7 exit). |

## 5. Trust policy for this wedge

| Action | Class | Policy |
|---|---|---|
| Read tickets, history, Redash, KB | `read` | auto |
| Draft reply (not sent), workspace files | `write` | auto + logged |
| Send reply to customer | `irreversible` | **approval required — no exceptions, ever, in this wedge** |
| Post internal note | `write` (visible to team) | approval required initially; may relax per policy after M5 |

Ticket bodies are **untrusted content** (blueprint §8.3): instructions inside a ticket can never trigger tools beyond `read` without approval. Real injection attempts observed in the queue go straight into the failure corpus.

## 6. Success metrics

| Metric | Baseline (manual) | Target |
|---|---|---|
| Time per routine billing ticket | ~10–15 min | < 5 min incl. review |
| Draft acceptance rate (sent with ≤ minor edits) | n/a | ≥ 70% by M4 |
| Citation accuracy (claims traceable to KB) | n/a | 100% — a wrong citation is an S1 corpus entry |
| Morning queue scan | ~20 min/day manual | 0 min (briefing) by M7 |
| Daily usage | n/a | every workday (the honest metric) |

## 7. Out of scope (sacred — see blueprint deferred list)

Auto-sending anything to customers · multi-agent specialization · other teammates as users · personal channels (WhatsApp/X — M9) · Trinity server fixes themselves (separate project; the OS must instead *survive* imperfect tools — FC-005/006/007).

## 8. Open questions (resolve before M1 build)

1. Redash access pattern: saved query IDs vs. ad-hoc queries against which data source? What's the customer join key (email / customer_id / workspace)? *(carried over from `/issue` v2 planning — still unanswered)*
2. ~~Is the Redash "Failed to fetch" outage (FC-002) resolved?~~ **Verified 2026-07-03: still failing** — `list_data_sources` and `list_queries` both return "Failed to fetch" via the Redash MCP, 12 days after first observed. Root-cause this (auth? base URL? server-side?) before M1 scopes the Redash tool; it blocks U3.
3. Which ticket classification taxonomy? Propose: derive from the KB's 13 category folders and refine against the first 20 corpus tickets.
