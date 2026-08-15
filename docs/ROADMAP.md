# AI OS — status and roadmap

**Written 2026-08-15.** Supersedes the forward-looking half of
[ADR-0021](adr/0021-path-to-launch.md), whose "top next step" (API auth) shipped
weeks ago. Everything in *Where we are* is measured, not remembered — commands to
re-derive each number are given so this document can be checked rather than
trusted.

---

## 1. Where we are

### Measured, 2026-08-15

| Dimension | Value | How to re-check |
|---|---|---|
| Code | ~23.7k LOC, 145 TS/TSX files | `find packages apps -name '*.ts*' \| grep -v node_modules \| xargs wc -l` |
| Structure | 7 packages, 5 apps, 21 tool modules, 26 migrations | `ls packages apps packages/tools/src/tools infra/migrations` |
| Decisions | 22 ADRs | `ls docs/adr` |
| Gates | typecheck clean · 0 lint errors · 18/18 smoke suites | `pnpm typecheck && pnpm lint && pnpm test` |
| Dev activity | 21 commits in 10 days | `git log --oneline --since='10 days ago' \| wc -l` |
| **Uptime** | **not running** | `npx pm2 list` → only `pm2-logrotate` |
| **Autostart** | **none configured** | Startup folder empty; no AIOS scheduled task |
| Database | down (Docker Desktop not started) | `docker ps` |

### The one sentence that matters

**Capability is far ahead of operability.** The system can plan, remember, drive a
browser, run code, book rides and answer on WhatsApp — *when it is up*. It is
almost never up. A personal OS that is not running delivers exactly zero value,
no matter how good the code is.

This is not a new observation and that is the point: on 2026-08-09 the autonomous
jobs were found silently dead for ~13 days, WhatsApp unpaired, and there were zero
database backups. Backups, a supervisor and job-failure alerting were added in
response. Six days later the stack is *again* not running, because nothing starts
it. The failure is structural, not incidental.

### What is genuinely strong

- **The kernel/pack split holds.** New capability lands as a manifest with zero
  kernel edits. That architectural bet has paid off across ~20 milestones.
- **The trust model is real, not aspirational.** Four trust classes, approval
  queueing, graduated trust with a permanent money exception, and a DB `CHECK`
  constraint backstopping the invariant. It is enforced in code and pinned by
  tests.
- **Security has been adversarially tested, not merely reviewed.** Six rounds,
  each attacking the previous round's fix. Roughly fifteen real vulnerabilities
  closed — several of which were *introduced by the previous fix*, including a
  deadlock that hung every fetch over 16 KiB and a decompression bomb that
  turned 407 KiB into 880 MB of RSS. Every finding was reproduced by execution
  before being fixed.
- **The codebase explains itself.** Comments record *why*, including rejected
  alternatives and measured residuals. This is the reason a six-round audit was
  possible at all.

### What is weak, stated plainly

1. **Availability.** No autostart, no watchdog, no external "is it alive" signal.
2. **Docker Desktop is a hard dependency** for Postgres, and it is a GUI app that
   the user deliberately does not auto-launch (it pops windows). So the database
   — and therefore the whole OS — depends on a manual step.
3. **Five documented security residuals** remain (§4 of `docs/SECURITY.md`), three
   of which one piece of work would close together.
4. **No behavioural regression testing.** 18 smoke suites cover units and
   security invariants. The eval gym (`evals/`) exists but is not a gate, so
   "did the assistant get worse?" is currently unanswerable.
5. **Secrets live in a plaintext `.env`**, which caps how far this can be shared.
6. **The daily self-improve job commits to `master`** without review.
7. **Design docs have drifted from the code.** A documentation pass on 2026-08-15
   found **39 places** where `BLUEPRINT.md` or an ADR states something the code
   contradicts — including three of the four §8.3 rules, ADR-0009's "code runs
   only in containers" (`terminal_exec` is an unrestricted host shell by design),
   and ADR-0022's Pack Forge flow. Stale security documentation is worse than
   none: it is what let the graph-path gap in Phase 1.0 stay invisible. The
   corrected picture now lives in `docs/SECURITY.md` §7 and
   `docs/architecture/`.
8. **A 50-item debt inventory** now exists (same pass), including several with
   security relevance: the sandbox egress allowlist is specified but never
   applied, path confinement is lexical so a symlink escapes it, and terminal
   secret-scrubbing clears `process.env` but not `cat .env`.

---

## 2. The plan

Four phases, strictly ordered. Each has an exit criterion that is a *measurement*,
not a feeling. Do not start a phase before the previous one's exit criterion is
met — the recurring failure mode here is adding capability on top of a system that
is not reliably running.

### Phase 0 — Make it run (days)

> Exit criterion: **7 consecutive days of >99% uptime with zero manual starts**,
> proven by a health-history table, across at least one reboot.

The whole phase is one idea: the OS must survive a reboot without the user doing
anything, and must tell someone when it does not.

1. **Durable, silent autostart.** Two approaches have already failed and must not
   be retried: Windows Task Scheduler (measured — reported `Last Result: 0` while
   doing no work) and a Startup-folder VBS (popped console windows). The
   remaining correct option is a **real Windows service** wrapping pm2
   (`nssm` / `winsw`), which starts before login, has no window, and restarts on
   failure. Verify by rebooting and checking uptime, not by reading config.
2. **Remove Docker Desktop from the critical path.** Either run Postgres as a
   native Windows service, or run the container via the Docker *engine* service
   started at boot without the desktop GUI. Today the database depends on a human
   opening an app.
3. **External watchdog.** Something outside the OS must notice it is down and say
   so out-of-band (WhatsApp or push), because an OS that is down cannot alert on
   its own behalf. Health-check writes a heartbeat row; the watchdog reads it.
4. **Prove the backups.** `scripts/backup.ts --verify` already restores into a
   scratch DB and compares row counts. Schedule it and assert the last verified
   restore is <48h old.

### Phase 1 — Make autonomy trustworthy (2–3 weeks)

> Exit criterion: the OS runs unattended for a week with **cumulative spend under
> a hard cap**, zero unapproved irreversible actions, and every job failure
> surfaced within one cycle.

Unattended operation is the product. These are the things that must be true before
leaving it alone is wise.

0. **Put §8.3 on the planner/graph path.** Found and verified 2026-08-15 while
   writing these docs, and it outranks everything else here: `graph.ts` has
   **zero** occurrences of the untrusted latch (`executor.ts` has eight), calls
   `tool.execute(args, {pool, taskId})` with no `ctx.untrusted`, and imports
   `assembleMemoryContext` without ever calling it. Every piece of injection
   hardening done on 2026-08-13 protects `runTask` **only** — a task routed
   through `POST /plan` → `runGraph` runs tools with the structural defense
   entirely absent. The hardening was thorough on the path I was looking at and
   blind to the one I was not. Thread the latch through `runGraph` exactly as the
   executor does, and add the first security suite that exercises the graph path
   at all. (Task #14.)
1. **Stop `video_analyze` bypassing the SSRF guard.** The model-supplied URL is
   handed straight to `yt-dlp` as an argv and the file never calls the guard;
   the tool is read-class and auto-approved, so no human sees the URL. The 2026-08-12
   sink sweep missed it because it grepped for in-process HTTP clients and this is
   a **subprocess** fetcher. Fix the call, then sweep that whole sink class —
   `yt-dlp`, `curl`, `wget`, `ffmpeg` with a URL input. (Task #15.)
2. **Close the three linked browser residuals with one change.** `ws://`,
   `<link rel=prefetch>` and browser DNS-rebinding are all unfixable at the
   Playwright route layer, and all three disappear if Chromium is launched behind
   **a local pinned-connect proxy** — every byte then travels a socket we own.
2. **A cumulative spend ceiling.** Today approval is per-action; approving one
   ride is not approving fifty. The governor must cap spend per rolling window and
   *block*, not merely report.
3. **A global recursion/fan-out limit.** `MAX_ITERATIONS = 12` bounds one task,
   but tasks spawn tasks (autopilot, standing goals, scheduler, delegation) with
   no global depth or breadth bound.
4. **Finish the memory-provenance work.** `kg_nodes`/`kg_edges` carry no
   provenance, and `recordExperience`/`consolidateInsights` should inherit taint
   from `tasks.untrusted`. Without this, poison can still enter the graph clean.
5. **Endpoint hygiene.** ~15 routes return HTTP 200 with an `{error}` body, so a
   caller (or the model) can believe a denied action succeeded. Mutating `GET`s
   (`/packs/forge/stream`, `/cognition/briefing?refresh=1`) should be `POST`.
   `pendingOAuthStates` is unbounded and never expires.
6. **An operations view that answers one question:** *is it working?* Job success
   rate, spend, approval latency, memory growth, last verified backup. Not a
   metrics zoo — five numbers.

### Phase 2 — Make it measurably good (4–8 weeks)

> Exit criterion: a behavioural eval suite runs in CI, and a regression in
> assistant quality **fails the build** the way a type error does.

Everything so far proves the system does not break. Nothing yet proves it is
*good*, or detects it getting worse.

1. **Promote the eval gym to a gate.** `evals/` has suites, baselines and reports.
   Wire it to a scored threshold. Behaviour is the product; it deserves the same
   protection as types.
2. **Build the router message-IR.** Recorded in the Wingman study as the blocker
   that breaks the agentic loop the moment a Claude key is used: provider-specific
   message shapes leak into the loop. An internal message IR with per-provider
   adapters fixes it and is a precondition for using the strongest model
   available at any moment.
3. **Measure memory quality.** Recall precision/recall, duplicate rate, decay
   behaviour, and whether recalled memories actually improve answers. Memory is
   the differentiator and is currently unmeasured.
4. **Make proactivity earn its place.** Standing goals and the morning briefing
   should be evaluated on whether the user acts on them. Proactive output nobody
   reads is worse than silence.

### Phase 3 — Make it shareable (months, optional)

> Exit criterion: a second person runs it on their machine without the author
> present.

1. Secrets out of `.env` into the OS keychain via the existing `SecretsBroker`
   seam (§8.2) — the seam was designed for this.
2. Per-user isolation, first-run setup, and a real installer.
3. Disclose the WhatsApp position honestly: Baileys is an unofficial client
   (ADR-0013) with real ban risk. Acceptable for personal use; a hard blocker for
   anything hosted, and a disclosure requirement for any other user.

---

## 3. Thinking ahead — second-order risks

Things that are not urgent today and will hurt later if nobody names them now.

| Risk | Why it bites later | Cheapest hedge now |
|---|---|---|
| **Unreviewed self-commits** | The daily job pushes to `master`. One bad automated commit is a silent regression with no reviewer. | Push to a branch and open a PR instead. Same automation, a human gate. |
| **Provider churn** | Free-tier keys, changing model names, shifting rate limits. Router already failovers, but roles are hard-coded. | The message-IR (Phase 2) is the structural answer. |
| **Baileys ban** | Loses the WhatsApp surface with no warning and no appeal. | Keep the pack boundary clean so a swap to the official Cloud API is a pack change, not a kernel change. |
| **Memory growth** | `memory_records`, `trace_events`, `steps` and notifications only ever grow; recall quality degrades as noise accumulates. | Retention + decay policy, measured by the Phase 2 memory metrics. |
| **pgvector/Postgres upgrades** | A major-version bump with a vector extension is a real migration risk against a live personal dataset. | Backups are verified (done). Add a documented restore drill. |
| **Single-machine dependency** | Everything, including all memory, lives on one Windows laptop. | Off-machine encrypted backup of `~/AIOS-Backups`. |
| **Security drift** | Six rounds found that each fix introduced new defects. Without the regression suites, that decays quietly. | Already hedged: every fix is pinned by a smoke test. Keep that discipline absolute. |

---

## 4. What I would do first

If only one thing happens next, make it **Phase 0.1 — the Windows service**.

Every other item on this list is worth less than it looks while the OS is off.
Security hardening protects a system nobody is running; new capabilities extend a
system nobody is running; better memory improves recall for a system nobody is
running. Uptime is the multiplier on all of it, and right now the multiplier is
close to zero.
