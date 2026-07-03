# FAILURE CORPUS — 50 real tasks where current assistants fail

**Version:** 0.1 (template + 12 seeded entries) · **Owner:** Akhil · **Target: 50 entries before M0 exit.**

> The most valuable document in the project (blueprint §2.3). Every entry is a *real* task from daily work where ChatGPT / Claude / Wingman / the `/issue` command failed, needed babysitting, or couldn't be attempted at all. These entries become the eval suites (§6) and justify every roadmap item. **No hypothetical entries — if it didn't actually happen to you, it doesn't go in.**

---

## How to capture an entry (do this the moment it happens)

1. Copy the entry template at the bottom of this file.
2. Write the task **verbatim** — what you actually asked or wanted, not a cleaned-up version.
3. Record what the assistant actually did, not what you assume it did.
4. Tag one primary failure mode (secondary tags allowed).
5. Write the "pass condition" — the observable outcome that would count as success. This becomes the eval assertion, so make it checkable.

**Cadence:** add entries during daily support work; review weekly (blueprint §13). Aim for ~5/week → 50 within the M0 window.

---

## Failure-mode taxonomy

| Code | Failure mode | Definition |
|---|---|---|
| `MEM` | Memory loss | Had to re-state something the assistant was already told (any prior session) |
| `AUTON` | No background autonomy | Task needs to run unattended / survive session end / trigger later — impossible |
| `TOOL-GAP` | Tool coverage gap | The needed system/data simply isn't reachable |
| `TOOL-REL` | Tool unreliability | Tool exists but failed: errors, overflow, malformed output, crashes |
| `TOOL-SHAPE` | Tool ergonomics | Tool works but its interface forces babysitting (ID juggling, missing filters/fields) |
| `PLAN` | Planning failure | Wrong decomposition, missed steps, no replanning after a failed step |
| `CLAR` | Clarification failure | Acted on an ambiguous ask instead of asking; or asked when it shouldn't |
| `TRUST` | Trust/permission gap | Couldn't safely act (no approval flow, no audit trail, no granular policy) |
| `KNOW` | Knowledge gap | KB/context didn't cover it and there was no honest fallback path |
| `INJ` | Injection surface | Untrusted content (ticket body, web page) could steer or did steer behavior |
| `COST` | Cost/latency | Task technically possible but too slow or too expensive to be worth it |

## Severity & frequency scales

- **Severity:** S1 = caused a real mistake reaching a customer/person · S2 = blocked the task entirely · S3 = wasted significant time (>10 min) · S4 = friction/annoyance
- **Frequency:** F1 = daily · F2 = weekly · F3 = monthly · F4 = rare but painful

## Target distribution (guide, not law)

| Category | Target | Seeded | Maps to eval suite |
|---|---|---|---|
| Ticket triage & reply drafting | 12 | 3 (FC-003, FC-008, FC-014) | `support-triage` |
| Billing / Redash lookups | 8 | 1 (FC-002) | `support-triage`, `tool-reliability` |
| Memory & continuity | 8 | 1 (FC-001) | `memory-recall` |
| Tool reliability & ergonomics | 8 | 6 (FC-004..007, FC-013, FC-015) | `tool-reliability` |
| Background work & proactivity | 6 | 2 (FC-009, FC-010) | `planning` |
| Trust, approvals & injection | 8 | 2 (FC-011, FC-012 — trust UX; **0 real injection payloads yet, collect from the queue, don't invent**) | `injection-defense` |
| **Total** | **50** | **15** | |

---

## Entries

### FC-001 · Re-explaining my setup every session
- **Date:** recurring, daily (documented 2026-06-21)
- **Assistant:** Claude Code
- **Task (verbatim):** Any `/issue`-style ticket lookup in a fresh session.
- **What happened:** Every new session I had to re-explain the KB location (`Downloads\kb\articles\...`), ticket ID formats (UUID vs 24-char Mongo ID vs plain number), and my output preferences (no timeline, three sections) until they were hardcoded into a slash command. Preferences learned in conversation evaporate.
- **Failure mode:** `MEM` · **Severity:** S3 · **Frequency:** F1
- **Pass condition:** State a preference once in any session; a task 5+ days later honors it without re-statement.
- **Eval suite:** `memory-recall`

### FC-002 · Redash connection silently broken, no recovery
- **Date:** 2026-06-21
- **Assistant:** Claude Code + Redash MCP
- **Task (verbatim):** Add Redash billing/subscription lookup to the `/issue` flow (v2).
- **What happened:** `list_queries` / `list_data_sources` returned "Failed to fetch". The assistant had no retry/backoff strategy, no way to diagnose whether it was auth, network, or server-side, and no memory that the connection was known-broken — later sessions would re-attempt blind.
- **Failure mode:** `TOOL-REL` (secondary: `MEM`) · **Severity:** S2 · **Frequency:** F3
- **Pass condition:** On tool failure: classified error, bounded retries, then an honest "Redash unreachable since <time>" surfaced to me — and the outage is remembered across sessions.
- **Eval suite:** `tool-reliability`

### FC-003 · No billing/promo tool — ticket #30479 unanswerable
- **Date:** 2026-06 (ticket #30479)
- **Assistant:** Claude Code + Trinity MCP
- **Task (verbatim):** Resolve a customer ticket about a promo/coupon not applying.
- **What happened:** Trinity MCP has no promo/coupon/billing-config tool. The assistant could read the ticket but could not verify the coupon state, so the "solution" was a guess. I had to do the lookup manually.
- **Failure mode:** `TOOL-GAP` (secondary: `KNOW`) · **Severity:** S2 · **Frequency:** F2
- **Pass condition:** Agent recognizes the data gap, says exactly what it cannot verify and why, and (post-M1) uses a Redash/billing tool to get the real answer with a citation.
- **Eval suite:** `support-triage`

### FC-004 · ID-format juggling across Trinity tools
- **Date:** recurring (documented 2026-06-21)
- **Assistant:** Claude Code + Trinity MCP
- **Task (verbatim):** "Look up ticket 29967 and the customer's history."
- **What happened:** Only `get_ticket` accepts a human ticket number; every other tool requires the internal Mongo ID. The agent (and I) must chain calls just to translate IDs, and it regularly got this wrong before the mapping was documented in the slash command.
- **Failure mode:** `TOOL-SHAPE` · **Severity:** S4 · **Frequency:** F1
- **Pass condition:** Any ticket identifier form → correct resolution chain with zero user intervention, 100% of the time on the eval fixture set.
- **Eval suite:** `tool-reliability`

### FC-005 · "Show me tickets assigned to X this week" — impossible query
- **Date:** 2026-06 (led to the Redash overwatch workaround, prashika.md)
- **Assistant:** Claude Code + Trinity MCP
- **Task (verbatim):** Pull the replies a specific agent handled (for attribution/QA).
- **What happened:** `list_tickets` filters by status only — no assignee, search, tag, or date filters. Trinity MCP fundamentally can't answer per-agent questions. Workaround required manually finding the `oracle_message_feedback` table in Redash and hand-building a query.
- **Failure mode:** `TOOL-SHAPE` (secondary: `PLAN` — the assistant didn't propose the Redash fallback itself) · **Severity:** S3 · **Frequency:** F2
- **Pass condition:** Agent routes around a tool's filter gap by choosing an alternative data source on its own and states which source it used.
- **Eval suite:** `planning`, `tool-reliability`

### FC-006 · Tool output overflow blows the context
- **Date:** 2026-06 (fixed in Trinity gap #1, but the class remains)
- **Assistant:** Claude Code + Trinity MCP
- **Task (verbatim):** "Who's online on the support team right now?"
- **What happened:** `get_agents` returned the entire unfiltered agent roster; the oversized payload flooded the context window and degraded everything after it. Fixed by patching the server — but the *agent* had no defense: it will still paste any oversized tool result straight into context.
- **Failure mode:** `TOOL-REL` (secondary: `COST`) · **Severity:** S3 · **Frequency:** F3
- **Pass condition:** Context engine truncates/summarizes oversized tool output under an explicit budget; downstream answer quality unaffected (measured).
- **Eval suite:** `tool-reliability`

### FC-007 · Inconsistent schemas between sibling tools broke summarization
- **Date:** 2026-06 (Trinity gap #2, fixed at server; class remains)
- **Assistant:** Claude Code + Trinity MCP
- **Task (verbatim):** Summarize a customer's ticket history for context before drafting a reply.
- **What happened:** `get_customer_history` and `get_customer_tickets` returned differently-shaped ticket objects; the model silently mixed fields between the two shapes and produced a history summary with wrong dates/statuses.
- **Failure mode:** `TOOL-REL` · **Severity:** S2 · **Frequency:** F3
- **Pass condition:** Malformed/mismatched tool responses are detected against a declared schema, not silently absorbed; summary assertions pass against fixtures.
- **Eval suite:** `tool-reliability`

### FC-008 · KB doesn't cover it → dead end
- **Date:** recurring
- **Assistant:** `/issue` command
- **Task (verbatim):** `/issue <ticket>` where the topic has no KB article.
- **What happened:** The command correctly refuses to invent a solution (by design), but then I'm on my own — no escalation path, no "closest related article", no draft-from-first-principles marked as un-cited, no note that this KB gap keeps recurring.
- **Failure mode:** `KNOW` (secondary: `PLAN`) · **Severity:** S3 · **Frequency:** F2
- **Pass condition:** On KB miss: agent says so, offers nearest-neighbor articles with similarity caveats, drafts a clearly-labeled uncited reply for review, and logs the KB gap for the weekly review.
- **Eval suite:** `support-triage`

### FC-009 · Nothing watches the queue while I sleep
- **Date:** recurring, daily
- **Assistant:** all (ChatGPT, Claude, Wingman)
- **Task (verbatim):** "Every morning, summarize overnight tickets, flag SLA risks, and tell me which ones look like the promo bug."
- **What happened:** Not possible. No assistant can run a standing scheduled task against my real tools and deliver a briefing. I do the morning queue scan by hand, every day.
- **Failure mode:** `AUTON` · **Severity:** S3 · **Frequency:** F1
- **Pass condition:** A scheduled automation produces the briefing daily for 14 consecutive days, unattended, with <10% false-alert rate (M7 exit criteria).
- **Eval suite:** `planning` (later: automation suite)

### FC-010 · "Watch this ticket and tell me when the customer replies"
- **Date:** recurring
- **Assistant:** all
- **Task (verbatim):** As written.
- **What happened:** Impossible — tasks die with the session. There is no durable task that sleeps, wakes on an event, and notifies me. I set manual reminders instead.
- **Failure mode:** `AUTON` · **Severity:** S4 · **Frequency:** F2
- **Pass condition:** Event-triggered task survives server restart, fires on the reply event, notifies within 5 minutes.
- **Eval suite:** `planning`

### FC-011 · Wingman acts on ambiguous asks instead of clarifying
- **Date:** documented 2026-06 (Wingman gap #1)
- **Assistant:** Wingman
- **Task (verbatim):** Vague commands (e.g., a reschedule request with two plausible interpretations).
- **What happened:** Wingman picks an interpretation and runs with it rather than asking one clarifying question. Wrong guess = undo work + eroded trust in giving it anything ambiguous.
- **Failure mode:** `CLAR` · **Severity:** S2 · **Frequency:** F2
- **Pass condition:** On the ambiguity fixture set, agent asks exactly when genuinely ambiguous (and does NOT ask when the ask is clear) — both directions scored.
- **Eval suite:** `planning`

### FC-012 · No audit trail — can't see what the agent did while away
- **Date:** documented 2026-06 (Wingman gap #4)
- **Assistant:** Wingman
- **Task (verbatim):** "What did you do while I was in the meeting?"
- **What happened:** No persistent, inspectable log of actions taken, attempted, or decided against. Trust in autonomy is impossible without it — I re-check everything manually, which defeats the point of autonomy.
- **Failure mode:** `TRUST` · **Severity:** S3 · **Frequency:** F1
- **Pass condition:** Every tool call, approval, and memory write appears in an append-only, task-keyed audit timeline (blueprint §8.4); nothing the OS does is invisible.
- **Eval suite:** (architecture requirement — verified by inspection + `injection-defense` interplay)

---

### FC-013 · Model rate limit killed a task instead of waiting
- **Date:** 2026-07-03 (M1 kill/resume exit test)
- **Assistant:** AI OS itself (M1 kernel, Gemini free tier)
- **Task (verbatim):** Multi-step research task resumed after a mid-run server kill.
- **What happened:** Gemini free tier returned 429 with an explicit "retry in 28.8s" hint. The model router had no retry/backoff, so the whole task failed instantly — despite the server literally saying how long to wait.
- **Failure mode:** `TOOL-REL` (secondary: `COST`) · **Severity:** S2 · **Frequency:** F1 (free tier: 5 req/min)
- **Pass condition:** 429/503 → honor Retry-After/body hint with capped backoff (≤4 attempts); task completes. **Fixed same day** (`fetchWithRateLimitRetry`, model-router) — keep as a regression eval case.
- **Eval suite:** `tool-reliability`

### FC-014 · Gmail search too literal — missed an email it had already seen
- **Date:** 2026-07-03
- **Assistant:** AI OS (M1 kernel)
- **Task (verbatim):** "Read the GitHub token expiry email from my inbox and tell me exactly what it says I should do."
- **What happened:** The agent had listed "[GitHub] Your personal access token (classic) is about to expire" minutes earlier in the SAME session, but searched Gmail for the literal phrase "GitHub token expiry", found nothing, and gave up — offering an unrelated Supabase email as "closest".
- **Failure mode:** `PLAN` (secondary: `MEM`) · **Severity:** S3 · **Frequency:** F2
- **Pass condition:** Query reformulation on zero-hit searches (broader terms, from:github), and reuse of message ids already surfaced in-context.
- **Eval suite:** `support-triage` (retrieval rubric), `planning`

### FC-015 · Keyless web search intermittently returns nothing parseable
- **Date:** 2026-07-03
- **Assistant:** AI OS (M1 `web_search` = DuckDuckGo Lite scrape)
- **Task (verbatim):** "web_search for the latest pgvector release…"
- **What happened:** Same query class succeeded earlier in the day, then returned "no parseable results" on the resumed run — HTML scrape flakiness (layout/ratelimit). Known-fragile choice (ADR-0004 #4); now it has a measured failure.
- **Failure mode:** `TOOL-REL` · **Severity:** S3 · **Frequency:** F2
- **Pass condition:** Search succeeds ≥95% on the eval fixture set — likely requires swapping to a real search API (Brave/Tavily) or adding a fallback engine.
- **Eval suite:** `tool-reliability`

### FC-016 … FC-050 · *(to collect — copy the template below)*

<!-- Add new entries above this line. Keep IDs sequential. -->

---

## Entry template

```markdown
### FC-0XX · <one-line title>
- **Date:** <when it happened — absolute date>
- **Assistant:** <ChatGPT / Claude / Claude Code / Wingman / /issue / ...>
- **Task (verbatim):** <what you actually asked or needed>
- **What happened:** <observed behavior, not interpretation>
- **Failure mode:** `CODE` (secondary: `CODE`) · **Severity:** S1–S4 · **Frequency:** F1–F4
- **Pass condition:** <observable, checkable outcome that would count as success — this becomes the eval assertion>
- **Eval suite:** <support-triage / memory-recall / tool-reliability / injection-defense / planning>
```

## Collection status

| | Count |
|---|---|
| Entries collected | **15 / 50** |
| S1 (real mistake shipped) | 0 |
| S2 (task blocked) | 5 |
| Trust entries / real injection payloads | 2 / 0 |
| From the OS's own runs (dogfood) | 3 (FC-013..015) |

**Biggest gaps to collect:** real ticket-triage failures with actual ticket numbers (the `support-triage` suite needs ~20 real tickets per blueprint §6), and real injection/trust incidents — watch for suspicious ticket bodies during daily work rather than inventing payloads.
