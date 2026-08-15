# Security model — as built

**Written 2026-08-15**, after six rounds of adversarial hardening in which each
round attacked the previous round's fix. This describes what the code *does*,
including what it does not do. Where a defense is incomplete it is listed in
§6, not softened here.

Design intent lives in `BLUEPRINT.md` §8. That document is older than the code
and several of its claims no longer hold — see §7.

---

## 1. Threat model

One user, one machine, everything bound to `127.0.0.1`. The adversary is **not**
a remote network attacker; it is:

1. **Prompt injection.** The OS reads web pages, emails, tickets, videos and
   messages. Any of them can contain text aimed at the model. This is the
   primary threat and the reason §8.3 exists.
2. **A compromised or mistaken model.** The model chooses tool calls. The design
   assumes it can be wrong or actively steered, and contains it structurally
   rather than by prompting.
3. **A hostile web page** driven by the browser bridge, which runs a persistent
   profile holding real logins.
4. **Other local processes**, weakly. This boundary is inherently soft: anything
   that can read `.env` already holds every credential.

Explicitly out of scope: a remote attacker (nothing listens off-loopback), and a
malicious operating system.

---

## 2. The trust gate

`packages/trust/src/index.ts`. Every tool carries a class:

| Class | Default | Can be promoted to auto? |
|---|---|---|
| `read` | auto-approve | n/a |
| `write` | auto-approve | n/a |
| `irreversible` | **queues for approval** | **Yes** — after 3 clean approvals (graduated trust, Tier 3) |
| `spend` | **queues for approval** | **Never.** Permanent. |

The `irreversible` / `spend` asymmetry is deliberate and load-bearing. Treating
them alike looks safer and silently kills graduated trust — read/write already
auto-approve, so if irreversible can never be promoted, nothing is ever
promotable and the feature is dead code. That mistake was made and caught during
hardening; `packages/trust/src/smoke.ts` now pins both halves as a matched pair.

Enforcement is layered:

- `TrustGate.classify()` strips `auto_approve` for `spend` unconditionally — the
  one function every decision is built from.
- `POST /trust/promote` and `PUT /policies/:tool` share a `hasEarnedTrust()`
  check and evaluate the **effective resulting state**, closing a two-request
  bypass the shipped Settings UI produced by sending `trust_class` and
  `auto_approve` as separate PUTs.
- Migration `0025` adds `CHECK (NOT (auto_approve AND trust_class = 'spend'))`
  as the backstop for any future endpoint.

An unknown tool fails closed to `irreversible`.

---

## 3. §8.3 — structural injection defense

Once untrusted content is in a task's context, **mutating actions are blocked
regardless of what the model decides**. Untrusted content informs; it never
gains authority. This is architectural, not prompt-dependent: a fully
compromised model is still contained.

`blockedByUntrustedContext(class, untrusted)` blocks `write`, `irreversible` and
`spend` — deliberately broader than the blueprint's "irreversible/spend", because
a file write or draft induced by a hostile email is exactly the vector.

**What arms the latch**, in `executor.ts`:

1. A tool declaring `untrustedOutput: true` returns successfully.
2. A tool result carries `__untrusted: true` (per-result taint — `wm_get` uses
   this, because its output is untrusted only for values that were *stored*
   untrusted; marking the whole tool would arm §8.3 on every routine read).
3. **Recalled memory is untrusted-derived** (2026-08-13). See §4.

### Memory provenance

The latch used to be per-task, and no memory row recorded where its content came
from. So untrusted content escaped containment by taking a trip through the
database: a tool read a web page (contained), *persisted* it, and a later
unrelated task recalled it into the system message under "Treat these as trusted
context you learned earlier" with the latch off.

Closed by `source.untrusted` — provenance stamped at write time, riding the
existing JSONB `source` column so no migration was needed and every pre-existing
row correctly reads as first-party. `assembleMemoryContext` splits recall by
provenance, quarantines tainted rows into a trailing data-only section (never the
imperative "do NOT repeat these" block), and returns `{block, untrusted}` which
the executor ORs into the latch.

Writers stamp from the executor's live latch via `ToolContext.untrusted` — never
from model-supplied arguments, so a compromised model cannot mark its own writes
clean. `project_record` additionally stopped hardcoding `user_stated: true`, a
claim it could not make.

---

## 4. Network egress (SSRF)

`packages/shared/src/ssrf-guard.ts` is the one guard every in-process fetch uses.

- **Resolved-address checking**, not hostname matching: DNS is resolved and every
  answer checked against loopback, RFC1918, link-local (including cloud
  metadata), CGNAT, multicast, reserved, and the IPv6 equivalents — including
  the transition families that embed a v4 address outside the low 32 bits
  (6to4 `2002::/16`, Teredo `2001:0::/32`, NAT64 `64:ff9b::/x`, IPv4-translated).
- **Connection pinning**: `ssrfSafeFetch` resolves once and pins the socket to
  that exact address via an undici `Agent` with a custom `connect.lookup`,
  closing the rebinding TOCTOU. TLS SNI and certificate verification still use
  the original hostname (verified: pinning `example.com` to `8.8.8.8` fails
  `ERR_TLS_CERT_ALTNAME_INVALID`).
- **Manual redirect following** so every hop is re-validated, with a header
  **allowlist** across an origin change — only `accept`, `accept-language`,
  `accept-encoding`, `content-type`, `user-agent` survive, so a new credential
  header cannot be forgotten later.
- **An 8 MB body cap** metered on *decompressed* bytes, because `Content-Length`
  cannot bound a gzip bomb (measured: 407 KiB inflating to 400 MB, +880 MB RSS).
- **One refusal message** for every resolution outcome, so the error cannot be
  used as an internal-hostname existence oracle.

The browser bridge (`apps/browser-bridge/src/ssrf-route.ts`) validates every
http(s) request through a `BrowserContext` route handler — documents *and*
subresources, because the model chooses the page and can choose one it authors.

---

## 5. Authentication surfaces

| Surface | Control |
|---|---|
| API (`:4000`) | `x-aios-token` on every route except `/health` and 4 OAuth browser-redirect routes; constant-time comparison |
| Web proxy (`:3000`) | Injects the token server-side; requires `sec-fetch-site: same-origin` **and** a loopback `Host` |
| Voice proxy (`:3001`) | Same two checks, as a middleware that runs before the proxy |
| Browser bridge (`:4200`) | `BROWSER_BRIDGE_TOKEN`, constant-time |
| WhatsApp bridge (`:4100`) | `WHATSAPP_BRIDGE_TOKEN`, constant-time; QR pairing page exempt |

The `Host` check exists because `Sec-Fetch-Site` reports *whether* the initiator
matched the origin, never *which* origin — so a rebound attacker-owned name
resolving to `127.0.0.1` produces a genuinely same-origin request.

**What the origin allowlist does not do:** stop a non-browser local process,
which can simply set the header itself. It closes browser-driven CSRF. The
local-process boundary is soft by construction.

Secrets: `SecretsBroker` (`packages/trust/src/secrets.ts`) holds the known
credential names and `redactForAudit` scrubs them from `steps.tool_args` and
`steps.result` before they reach the append-only audit log.

---

## 6. Residuals — what is NOT covered

Honest list. Each was measured, not assumed.

| # | Residual | Status |
|---|---|---|
| 1 | **§8.3 is absent from the planner/graph path.** `graph.ts` has zero occurrences of the latch (executor.ts has 8), calls `tool.execute(args, {pool, taskId})` with no `ctx.untrusted`, and imports `assembleMemoryContext` without calling it. Every 2026-08-13 hardening applies to `runTask` only. | **Open — highest priority.** Task #14 |
| 2 | **`video_analyze` bypasses the SSRF guard**: the model-supplied URL goes straight to `yt-dlp` as an argv, and the file never calls the guard. Read-class and auto-approved, so no human sees the URL. | **Open.** Task #15 |
| 3 | **Browser-bridge DNS rebinding.** Chrome owns the socket and re-resolves; the undici pin cannot apply. | Documented, accepted |
| 4 | **`ws://` and `<link rel=prefetch>` reach loopback** from a page. Measured. `routeWebSocket` is the right API but does not fire under `launchPersistentContext` (playwright 1.61.1). | Documented, accepted |
| 5 | **Generated pack code runs in-process** after human approval. No in-process sandbox. | Documented v1 trust model |
| 6 | **Sandbox egress allowlist is specified but not implemented** — `docker-sandbox.ts:69` maps any non-empty allowlist to plain `--network` on. ADR-0009 claims deny-by-default. | **Open** |
| 7 | **Terminal secret scrubbing is incomplete**: secrets are removed from `process.env`, but `cat .env` still reads them off disk. | Open |
| 8 | **Path confinement is lexical** — `files.ts` never calls `realpath`, so a symlink inside the root can point outside it. | Open |

Residuals 3 and 4 share one fix: launch Chromium behind a **local pinned-connect
proxy**, so every byte travels a socket we own. That would close rebinding,
`ws://` and prefetch together.

---

## 7. Where BLUEPRINT.md is now wrong

The design doc predates the implementation. Do not treat it as ground truth.

- §8.3 rule 2 says untrusted context blocks `irreversible`/`spend`. The code
  blocks **all** mutating classes including `write`.
- §8.3 rule 3 describes a "quarantine pattern" where untrusted content is
  pre-summarised by a tool-less model call. **No such pre-pass exists.**
  Quarantine is implemented as a fenced, labelled section in the memory block.
- §8.3 rule 1 says every context block is labelled trusted or untrusted, with
  own memory always trusted. Recalled memory is **no longer categorically
  trusted** — it is split by provenance.
- ADR-0009's "code runs only in containers" invariant does not hold:
  `terminal_exec` is an unrestricted host shell by design.
- ADR-0022's Pack Forge flow says "safety scan → dynamic import → validate".
  Staging **no longer imports anything**; manifests are extracted from the
  TypeScript AST.

---

## 8. Regression suites

Security invariants are pinned by executable tests, because six rounds
demonstrated that each fix can introduce the next defect.

| Suite | Pins |
|---|---|
| `packages/trust/src/smoke.ts` | Trust classes, §8.3 decisions, and the spend-vs-irreversible asymmetry as a matched pair |
| `packages/shared/src/ssrf-smoke.ts` | Address block-list incl. both historic IPv6 bypasses, transition prefixes, the body cap, redirect header allowlist, and the no-oracle property |
| `packages/packs/src/forge-scan-smoke.ts` | 16 pack-forge code-execution vectors, unicode-escaped identifiers, the nesting bomb, and that the legitimate path still works |
| `packages/kernel/src/memory-taint-smoke.ts` | Provenance stamping on write, quarantine + latch on recall, and no false positives on first-party memory (DB-backed) |
| `apps/browser-bridge/src/ssrf-route-smoke.ts` | Per-request-kind coverage against a request-counting internal service, including the two known holes asserted as known |
| `apps/web` / `apps/voice` `proxy-guard-smoke.mts` | Every `sec-fetch-site` value and the rebinding `Host` cases, asserting the token never reaches the API |

A suite asserts **"did anything arrive at the internal service"**, not "did an
error appear" — the weaker question passes for the wrong reasons.
