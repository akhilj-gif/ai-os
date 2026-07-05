# ADR-0008 — Secrets broker & audit redaction (M5)

**Date:** 2026-07-05 · **Status:** Accepted · **Blueprint:** §8.2

## Context

"Secrets live in a broker; agents get short-lived scoped tokens, never raw
credentials in context." Our secrets: model/provider keys (env), Google OAuth
tokens (DB). Two risks: a secret entering the model's context, and a secret
landing in the append-only audit log (tool_calls.result, trace_events.payload)
if a tool ever returns or echoes one.

## Decisions

1. **`SecretsBroker` (`packages/trust/src/secrets.ts`) is the sanctioned place to
   read a secret** — `broker.get(NAME)` for the known env secrets. Provider keys
   are otherwise only touched by the model router; OAuth tokens only inside tools
   (fetched from the DB, used for the HTTP call, never returned to the model). So
   secrets already never enter model context by construction; the broker makes
   that explicit and gives future code one door.
2. **`redactForAudit(x)` scrubs secrets before persistence.** Applied to
   `tool_calls.args` and `tool_calls.result` in both the ReAct executor and the
   graph executor. It removes (a) known env secret VALUES and (b) secret-shaped
   tokens by pattern (GOCSPX-, AQ., xai-, gsk_, sk-, ya29., Bearer …, postgres
   URLs) — so even a secret pasted into an email the OS reads, or a tool that
   echoes a token, cannot be written to the audit log in the clear.

## Consequences

- The audit log stays fully inspectable (principle 6) without being a secret sink.
- Full **rotation to short-lived scoped tokens per task** (the strongest form of
  §8.2) is deferred until there are multiple credential-bearing tools to scope;
  today the redaction guard + single-door reads are the proportionate protection.
- Redaction is best-effort string scrubbing; it is a backstop, not a licence to
  put secrets near model context. The primary defense remains architectural
  (secrets never enter context).
