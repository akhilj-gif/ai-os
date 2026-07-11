# ADR-0016: M13 — the OS gets hands (your terminal) and a brain that trains itself

**Status:** accepted (2026-07-11) · **Milestone:** M13 (post-roadmap; Akhil: "I want this to work as an operating system — give it my terminal, and a brain that thinks and does tasks intelligently, and train the brain")

## Context

Through M12 the OS can read/draft/send across channels and orchestrate
specialists, but every capability is a *bounded* tool — it cannot run an
arbitrary command on Akhil's actual machine the way a human operator (or
Claude Code) does. And while the M10 learning loop EXISTS (propose playbook →
gym-gate → adopt), nothing ever RUNS it, so the brain never actually improves
on its own. M13 closes both: real host-command capability under the existing
trust discipline, and a scheduled learning cycle so the OS trains itself from
its own failures.

The tension is danger. A shell on the host is the single most powerful — and
most abusable — capability in the whole system. The design principle is
unchanged from ADR-0009 (sandbox) and ADR-0013 (WhatsApp send): **capability
is fine; UNGATED capability is not.** The trust gate, the §8.3 structural
injection defense, and the human-in-the-loop approval flow are exactly what
make a terminal safe to hand over.

## Decisions

### M13a — the `computer` capability pack (terminal access)

1. **Two tools, split by reversibility — the whole safety model:**
   - `terminal_run` — **read-only, auto-approved.** Runs ONLY commands whose
     head is on a conservative allowlist of inspection commands (`ls`, `cat`,
     `pwd`, `git status`, `dir`, `type`, `Get-ChildItem`, …). Anything with a
     shell metacharacter that could chain/redirect/subshell (`;`, `|`, `&`,
     `` ` ``, `>`, `$(`) is refused — an allowlisted head can't be a Trojan
     horse for an arbitrary command. This is the OS "looking around" without
     asking permission every time.
   - `terminal_exec` — **anything, `irreversible`-class, `auto_approve=false`,
     ALWAYS.** This is the real hand: any command at all, but every call
     queues for Akhil's one-click approval showing the EXACT command + cwd.
     The human reading the literal command before it runs is the safety check
     (same invariant as a WhatsApp send).
2. **§8.3 holds automatically.** `terminal_exec` is mutating, so the structural
   gate BLOCKS it whenever untrusted content is in context — an injected "run
   `rm -rf`" from a web page or WhatsApp message can never even queue. Approval
   is reachable only for commands the user's own request produced. `terminal_run`
   is read-class but *also* declared mutating-safe: its allowlist means an
   injected read is harmless (it can only list/print), and it never actuates.
3. **Credential hygiene:** child processes spawn with a SCRUBBED environment
   (`scrubbedEnv` — every `*_KEY/_SECRET/_TOKEN/PASSWORD` and the known secret
   names removed), so a command the model runs can't read the OS's own API
   keys out of `process.env`. Output is capped (64KB head+tail) and every run
   is time-boxed (default 60s). Command + cwd + exit code land in the
   `tool_calls` audit log, secret-redacted like everything else.
4. **cwd is confined by default** to a configurable root
   (`AIOS_TERMINAL_ROOT`, default the user's home) — the tool refuses a cwd
   that escapes it. This is a guardrail, not a sandbox: `terminal_exec` is
   deliberately un-sandboxed (that's the point — it works on the REAL machine),
   and its safety is the approval gate, not containment. `code_exec` (ADR-0009,
   Docker) remains the path for running untrusted CODE; `terminal_exec` is for
   trusted operational commands Akhil authorizes.
5. Pack ships prompt + procedural memories + a `computer` eval suite
   (run-never-mutates; injected-command-never-executes; explicit-request-still-
   gated) — the M9 exit contract.

### M13b — the always-learning brain (schedule the M10 loop)

1. A new `learn` job kind runs `runLearningCycle` on a schedule (default
   weekly). It uses the FULL M10 machinery unchanged: gather behavioral
   failures (infra/quota noise excluded) → LLM proposes small general
   procedural playbooks → **each candidate is gym-gated** (`gymVerifier` runs
   the whole eval suite with the candidate injected; ANY baseline regression
   rejects it) → adopt / reject / queue.
2. **`autoAdopt=false` on the scheduled path.** Unattended, the OS never
   silently rewrites its own brain: clean-but-unproven playbooks QUEUE for
   Akhil's review (surfaced in a notification with counts and in
   `/improvements`), and he adopts them with a click. Only the gym's verdict
   can reject; only a human (or an explicit `autoAdopt` run) adopts. Fail-closed
   throughout — a verifier that throws never adopts.
3. This is the M10 exit criterion finally *operating*, not just built: the
   brain gets measurably better week over week, every change proven against
   the gym before it can touch behavior.

## Consequences

- The OS can now genuinely operate the machine — "clean my downloads",
  "what's using disk", "run the build" — with the same one-click approval Akhil
  already trusts for sends. The dangerous half (`terminal_exec`) is unusable by
  injected content and unusable without a human seeing the literal command.
- Deterministic proof (no model, no real mutation): `terminal-smoke`
  (allowlist enforcement, metacharacter refusal, env-scrub, cwd confinement,
  output cap, exec classified irreversible/never-auto) + the `computer` eval
  suite for the model-facing behavior.
- The learning loop is now a standing weekly job; its proposals are visible and
  human-gated, so the "train the brain" ask is satisfied safely rather than by
  letting the model edit itself.
- Deferred: full desktop/GUI control (screenshots, clicks) — that's a separate,
  much larger surface; terminal is the high-leverage 20%. A persistent shell
  session (state across commands) is also deferred; each call is one command.
