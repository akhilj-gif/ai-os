# ADR-0017: M14 — ride booking by voice (Uber / Ola / Rapido)

**Status:** accepted (2026-07-11) · **Milestone:** M14 (post-roadmap; Akhil: "book a ride by voice — compare prices and vehicle types across Rapido/Uber/Ola, book by voice, keep the booking behind an approval prompt")

## Context — what the research found (2026)

Akhil asked whether the OS can book rides by voice with cross-provider price
comparison. The gating question was API availability. Findings:

- **Uber** — the Ride Requests API + fare estimate are usable for **self-booking
  without enterprise approval**: the privileged `request` scope needs Uber's
  allowlisting only "before it can be used by a wider audience," but "your
  account (and any developer accounts you list on the dashboard) will be able
  to authorize these scopes without whitelisting." Booking Akhil's OWN rides on
  his OWN account is exactly that un-gated case. Auth: OAuth 2.0 user-context
  (`request` scope) for booking; server token for products/estimates.
- **Ola** — developer platform is **invite-only since Nov 2017**: email
  `affiliates@olacabs.com`, get sandbox creds, and Ola must *certify* the
  integration before production. Not practical for an individual without their
  sign-off — treated as "no usable official API" until Akhil pursues it.
- **Rapido** — **no public consumer API**; only unofficial reverse-engineered
  clients. Browser automation is the only route.

## Update 2026-07-11 — live browser scouting (M15b bridge)

With the Playwright bridge built, scouted both sites' actual web presence
before writing any Ola/Rapido automation:

- **Rapido — dead end for browser automation, confirmed empirically.**
  `rapido.bike` is a marketing page only: no location fields, no search UI —
  "Download App" is the sole call to action. This independently confirms the
  API finding above: there is genuinely no web surface to automate. Rapido
  stays mock-only unless a mobile-app-automation approach is pursued
  separately (a different, larger undertaking — not in scope here).
- **Ola — a real, working search UI exists.** `www.olacabs.com` has a
  geocoded location-search (pickup/drop autocomplete backed by real address
  data) and a "SEARCH OLA CABS" button — confirmed by actually typing a
  pickup/drop and selecting suggestions. But the guest (logged-out) search
  does not surface an in-page fare result; it most likely requires a session.
  **Next step is Akhil's, not code:** run the bridge headed
  (`BROWSER_HEADLESS=0`) and sign into Ola once — the persistent `.userdata`
  profile keeps the session, and the authenticated flow can then be automated.
- **A general bridge bug was found and fixed along the way**: `/find`'s
  element-detection selector missed custom widgets built from `<li>`/`<div>`
  with no ARIA role (Ola's autocomplete items were exactly this shape) — now
  covers `role=option/listitem/menuitem` and clickable-by-cursor elements.
  Separately, refs from an earlier `/find` call weren't cleared before a later
  call re-numbered from `e0`, so two DIFFERENT elements could end up sharing
  one ref (hit live: Playwright's strict-mode check correctly refused to
  guess which element `/act` meant). Both are general robustness fixes that
  help every site the browser pack touches, not just Ola. Locked down
  deterministically: `find-in-page-smoke.ts` (9/9, real headless Chromium
  against a local fixture reproducing the exact shape that broke).

## Decision

Per Akhil's rule ("official API where it exists; else a browser bridge that
compares live fares and books; final booking always behind an approval
prompt"):

1. **The OS talks to ONE thing: a mobility BRIDGE contract** (mirrors ADR-0013's
   WhatsApp design — bridge owns the sessions/keys, the OS owns the policy):
   - `GET /health` → which providers are live
   - `POST /estimate {pickup, drop}` → `RideOption[]` across providers × vehicle
     types (fare low/high, ETA, surge)
   - `POST /book {optionId}` → `{ bookingId, provider, status }`
   The bridge behind it fans out however each provider requires — **Uber via its
   official API, Ola/Rapido via browser automation** — and a deterministic MOCK
   twin serves fixture fares for tests/demos. Swapping mock ↔ live never touches
   the OS.
2. **Two tools:**
   - `mobility_estimate` — **read, auto.** Compares options across providers so
     the brain can recommend by price/vehicle/ETA. NOT flagged `untrustedOutput`:
     it returns structured fares the bridge shapes (not free web content), and
     flagging it would wrongly make §8.3 block the very booking that legitimately
     follows an estimate.
   - `mobility_book` — **`spend`-class, `auto_approve=false`, ALWAYS.** Booking
     commits money AND dispatches a driver. Every call queues for Akhil's
     one-click approval showing the exact provider + vehicle + fare. §8.3 also
     blocks it structurally under untrusted context (an injected "book a ride
     to X" from a web page can never actuate). This is the approval prompt Akhil
     asked for — the OS never spends without his confirmation.
3. **Voice is already solved.** The brain parses "book me the cheapest bike from
   home to the office" → `estimate` → recommend → `book` (queued) → approve.
   No new voice work; M12d hands-free + the kernel do it.

## Consequences

- Ships mock-first (like the X pack): the full voice → compare → approve → book
  flow is deterministically testable now (`mobility-smoke`, `mobility` eval
  suite) with zero accounts and zero model quota.
- **Go-live needs Akhil (documented in the pack `requires`):**
  - Uber: register an app at developer.uber.com, list his account, drop
    `UBER_CLIENT_ID/SECRET` + OAuth — then his own rides book without Uber's
    approval.
  - Ola/Rapido: a browser-automation bridge with his logged-in sessions.
    Honest caveats (same bargain as the WhatsApp Baileys bridge): against ToS,
    breaks when their UIs change, hits OTP on login, and I cannot auto-solve
    CAPTCHAs (a prohibited action) — those steps stay human. Ola alternatively
    becomes official if he gets affiliate approval.
- Booking is `spend`/approval-gated by construction, so even a fully-compromised
  model or a mis-heard voice command can at worst *propose* a ride, never book
  one.
- Deferred: multi-stop, scheduled rides, in-ride tracking, fare-drop watching
  (a natural `act`-job follow-on once live).
