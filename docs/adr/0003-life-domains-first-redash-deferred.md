# ADR-0003 — Life domains lead the roadmap; Redash deferred; M1 tool swap

**Date:** 2026-07-03 · **Status:** Accepted

## Context

The blueprint's original M1 tool set (web search, filesystem, **Redash**) and exit test
("summarize yesterday's ticket volume from Redash") framed the walking skeleton around support
ops. Akhil corrected this on 2026-07-03: the OS is his **life OS** — support automation is one
eval surface, not the product. Separately, the Redash MCP connection has been broken for 12+
days (verified 2026-07-03; PRD open question #2), making it a poor foundation for M1 anyway.

## Decision

1. **[DOMAINS.md](../DOMAINS.md) is the travel map** — the definitive list of life areas, in
   arrival order, each landing as a capability pack on a domain-free kernel.
2. **M1's third tool becomes Email/Calendar (Gmail APIs)** — the first real life domain, with
   official APIs and low friction. New M1 exit test: "what's on my plate today?" → correct,
   cited inbox+calendar summary; mid-task kill → resume. This supersedes the blueprint §9 M1
   text; the blueprint has been amended in place.
3. **Redash is deferred indefinitely** — revisit when Akhil asks. The Trinity MCP remains
   available as an eval surface (its failure data is free), but no roadmap item depends on it.
4. Trust posture unchanged and reaffirmed: email **send** is `irreversible` (approval); at M1
   the send capability simply doesn't exist — read + draft only.

## Consequences

- M1 needs Google OAuth for Gmail/Calendar scopes (read + draft). This is the first real
  secrets-handling exercise — tokens live in `.env` for now, secrets broker still lands at M5.
- The support-triage eval suite (M2) still draws on real tickets — as one suite among several,
  with email/research suites joining as those domains produce failure-corpus entries.
- The failure corpus explicitly accepts entries from any life domain, not just work.
