# ADR-0018: M15 — general browser automation

**Status:** accepted (2026-07-11) · **Milestone:** M15 (post-roadmap; Akhil: "make the OS able to perform all types of browser automation")

## Context

M13 gave the OS the terminal (its hands on the machine); M14 needed the web for
Ola/Rapido. The general capability underneath both asks is a controllable
BROWSER: navigate, read, find elements, extract data, and act (click, type,
submit) on real sites. This is the highest-leverage remaining capability — it
turns "book a ride / fill this form / pull my statement / apply to this" from
bespoke integrations into one general tool. It's also the exact substrate the
Ola/Rapido mobility bridge (ADR-0017) will run on.

The danger is the mirror of the terminal's: a browser acting on the live web
can spend money, submit irreversible forms, and log in as the user — AND the
pages it reads are the single richest injection surface in the system. The
design is the same discipline: capability is fine; UNGATED capability is not.
The trust gate + §8.3 structural injection defense are what make it safe.

## Decisions

### The `browser` capability pack — tools split by side effect

1. **Read family — auto, but `untrustedOutput: true`:**
   `browser_navigate` (open a URL), `browser_read` (page text/structure),
   `browser_find` (locate elements → refs), `browser_extract` (structured
   pull). These are how the OS "looks at" the web; they run without approval
   because they don't change anything. But their output is UNTRUSTED external
   content — the moment a page is read, §8.3 blocks any auto mutation, so a
   page that says "click Delete" can never actuate on its own.
2. **`browser_act` — `irreversible`-class, `auto_approve=false`, ALWAYS.**
   Every state-changing interaction (click, type, select, submit, key) queues
   for one-click approval showing the exact action + target element + current
   URL. The human seeing the literal action before it fires is the check —
   the same invariant as `terminal_exec` and a WhatsApp send. Because pages are
   untrusted, an injected instruction can only ever reach this human-gated
   path, never an auto action.
3. **Bridge-owns-session, OS-owns-policy** (ADR-0013 pattern): a browser is a
   stateful session, so the tools speak a localhost bridge contract
   (`/health /navigate /read /find /act /extract`). Behind it: a real
   **Playwright** browser for live use, or an in-module deterministic MOCK
   (a tiny fixture site, incl. an injection page) so the whole flow + trust
   posture are testable with no install and no network. Swap via
   `BROWSER_BRIDGE_URL`. The same bridge, pointed at Ola/Rapido, is M14's
   go-live path.
4. **Navigation confinement (optional):** `AIOS_BROWSER_ALLOW`/`_BLOCK` domain
   lists can fence where the browser may go; unset = open web. A guardrail,
   not the safety boundary (approval is).

## Consequences

- The OS can now automate the web generally — fill forms, pull data, drive
  multi-step flows — with money/irreversible actions always stopping for
  approval, and injection contained architecturally (read = untrusted →
  auto-mutation blocked; act = human-gated).
- Deterministic proof (no browser, no network): `browser-smoke` (navigate →
  read returns the page, find returns refs, act records to a log and is
  classified irreversible/never-auto, injected page text never auto-acts) +
  the `browser` eval suite (read-never-acts / injected-instruction-never-acts /
  act-requires-approval).
- Go-live (documented in the pack `requires`): stand up the Playwright bridge
  (`pnpm --filter @ai-os/browser-bridge start` — installs a browser once) and
  set `BROWSER_BRIDGE_URL`; for sites needing login, Akhil signs in in the
  bridge's browser (OTP/CAPTCHA are his manual steps — I cannot auto-solve
  CAPTCHAs). Per-action approval is deliberately chatty for long flows; a
  "trusted flow" batching mode and a domain allowlist for low-risk reads are
  deferred enhancements.
- Deferred: file downloads/uploads via the browser, and persistent multi-tab
  orchestration — added when a concrete need appears.
