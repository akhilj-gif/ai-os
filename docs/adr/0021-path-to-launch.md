# ADR-0021: Path to launch — desktop agent + what "others can use it" requires

**Status:** accepted (2026-07-17) · **Scope:** product/security posture, computer pack

## Context

Akhil is showcasing the AI OS and wants (a) it to operate the desktop like
Claude Code, and (b) a path to letting other people use it. This ADR records
what shipped now (M19 + hardening), the honest security posture, and the two
launch strategies with their real costs.

## What shipped now

### M19 — desktop file tools (the "Claude Code on your desktop" surface)

`fs_list` / `fs_read` / `fs_search` (read-class, auto) and `fs_write`
(write-class, **always** one-click approval) in the `computer` pack, replacing
fragile cmd.exe one-liners for file work (quoting mangles content — proven in
the 2026-07-12 audit). All four confine every path to `AIOS_TERMINAL_ROOT`
(default: home) — the same single knob that confines the terminal cwd.
Verified: `files-smoke` 17/17 (escape rejection, round-trip, binary refusal,
caps, node_modules-skipping search) + live E2E through real chat — "list my
Downloads" answered from the real disk; "create a file" queued, file
**absent** until approval, exact content landed after one click.

`untrustedOutput=false` on the read tools is a deliberate, documented call:
§8.3's latch only gates auto-mutating tools, and every desktop-harming action
(fs_write, terminal_exec, sends, spends) is approval-gated regardless; marking
local files untrusted would break the core demo (read file → analyze in the
code sandbox) while adding no protection those gates don't already give.

### Hardening (this pass)

- **WhatsApp bridge token auth is now real.** The bridge supported
  `WHATSAPP_BRIDGE_TOKEN` but never loaded `.env`, so the check silently
  no-opped — any local process could drive Akhil's WhatsApp via
  `127.0.0.1:4100`. Fixed (bridge now loads the root `.env` like the API) and
  a token is set; verified 401 without it, QR pairing page stays exempt.
- **`AIOS_TERMINAL_ROOT` is explicit** in `.env` (home — the whole desktop is
  the *intent* for Claude-Code-like use) and documented in `.env.example`.
- Confirmed every service binds `127.0.0.1` only (api, both bridges, web,
  voice, langfuse, postgres, redis via compose port maps).

## Security posture — honest gaps, ranked

1. **The API itself has no auth.** Anything that can reach
   `http://127.0.0.1:4000` is Akhil — including `POST /pending/:id/decide`,
   which means a malicious *local* process could approve its own queued
   actions and defeat the approval gate. Localhost binding keeps the network
   out, but not other software on the machine. **Top next step:** an
   `AIOS_API_TOKEN` (same pattern as the bridge token) held by the UIs;
   approval endpoints first.
2. **Secrets live in a plaintext `.env`** (fine for a dev box, not for
   distribution). The SecretsBroker (§8.2, ADR-0008) is the seam for a real
   keychain later.
3. **WhatsApp is an unofficial client** (Baileys) — ToS violation, nonzero
   ban risk, accepted knowingly for personal use (ADR-0013). This is a
   *disclosure requirement* for any other user, and a hard blocker for any
   hosted offering.
4. Model keys are personal free-tier keys; costs and rate limits are Akhil's.

## Launch strategies

### A. Local-first installable app — recommended, realistic

Each user runs their own instance with their own keys, like Claude Code
itself. No multi-tenancy, no hosted liability; the existing single-user
architecture IS the product. What it needs, in order:

1. **API token auth** (gap #1 above) — small, do first.
2. **One-command install**: `docker compose up` already carries the substrate;
   add a guided `pnpm setup` that writes `.env` (keys, timezone), runs
   migrations, and walks OAuth (`/oauth/google`) + optional WhatsApp pairing.
3. **BYO keys onboarding**: Gemini/Groq/NVIDIA free tiers work today; document
   the 3-minute key setup. Anthropic key optional (auto-primary if set).
4. **Docs + demo script + LICENSE** in the README; WhatsApp ban-risk
   disclosure at pairing time (already opt-in by design).
5. Windows-first packaging is fine (current dogfood platform); mac/linux are
   compose + pnpm anyway.

### B. Hosted multi-user SaaS — not now

Requires real auth + sessions, per-user tenancy across every table
(oauth_tokens, memory_records, tasks, messages are all single-user today), a
secrets vault, per-user model-key handling or metered billing, TLS/domain
infra, data-privacy obligations (user emails/messages in the operator's DB),
and dropping or officially licensing the WhatsApp surface. That is a company,
not a milestone. Revisit only if A gets real traction.

## Demo script (showcase order)

1. Voice orb (3001): "What's on my calendar today?" — Google, real data.
2. "List the files in my Downloads folder" — M19, real desktop.
3. "Create a summary file of X in Downloads" — write queues → approve popup →
   file appears (the trust story in one beat).
4. "Search the web for … and message the gist to <contact> on WhatsApp" —
   research + approval-gated send (M11 multi-agent if phrased as one goal).
5. Dashboard (3000/dashboard): audit log, tokens, approvals inbox — the
   "trust is architecture" close.
