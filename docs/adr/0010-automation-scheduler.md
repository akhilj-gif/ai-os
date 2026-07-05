# ADR-0010: M7 Automation — durable scheduler, fixed pipelines, quota-survival semantics

**Status:** accepted (2026-07-06) · **Milestone:** M7

## Context

M7 makes the OS proactive: things happen without Akhil asking (morning briefing,
watch-flows, scheduled reflection). Unattended execution changes the risk and the
economics: nobody is watching a run to catch weirdness, and the free-tier model
quota (Gemini + Groq daily caps) that throttles interactive use is guaranteed to
also hit scheduled runs.

## Decision

1. **Thin Postgres-backed scheduler** (same call as ADR-0007, and for the same
   reasons): `jobs` / `job_runs` / `notifications` tables, no Temporal/BullMQ.
   Volume is a handful of personal jobs a day; durability + inspectability beat
   throughput. The core is a pure-ish **`tick(pool, {now, executors})`** —
   production wraps it in a poll timer; tests inject `now`, so every scheduling
   guarantee is provable deterministically with zero model quota.

2. **Unattended jobs are FIXED, READ-ONLY pipelines** (`briefing`, `watch`,
   `reflect`) — never open agent loops. Rationale: §8.3's structural stance.
   An unattended run has no human to catch an injection-steered action, so
   mutating tools are not merely gated — they are *unreachable by construction*.
   Untrusted content (email subjects, page text) reaches at most one tool-less
   synthesis call; an injection can distort prose, never actuate. The only output
   channel is a `notifications` row.

3. **Quota-survival semantics** (the free-tier reality, designed-in):
   - `INFRA_*` failure (rate limit / network) → run recorded **`deferred`**,
     retry in 15m, failStreak untouched. Quota exhaustion *delays* a briefing;
     it never kills the job. (Proven live: Gemini-429 → deferred; Groq → delivered.)
   - Real failure → **`failed`** + failStreak backoff (5m×streak, budget 3),
     then fall back to the natural cadence — no tight loops, no give-up.
   - Due past a **2h grace** (API was down) → recorded **`missed`**, not executed:
     a 5-hour-late "morning" briefing is noise; honesty beats pretending.
   - Runs stuck `running` >30m (process died) → **reaped** to failed on the next
     tick — the scheduler's analog of resume-on-boot.
   - Claims advance `next_run_at` inside the claim transaction
     (`FOR UPDATE SKIP LOCKED`) → exactly-once per due-ness, safe under
     concurrent ticks; a live previous run skips the claim (no overlap).

4. **Schedules are data, not cron strings**: `{kind:'daily', time}` (tz-aware,
   AIOS_TZ), `{kind:'interval', minutes}`, `{kind:'once', at}` — covers the
   personal-OS cases without a cron dependency; `computeNextRun` is a pure
   function with boundary tests.

## Consequences

- `scheduler-smoke.ts` (31/31, no model) is the guarantee; model-dependent paths
  are confirmed by `briefing-live-check.ts` when quota allows.
- A future job kind that needs to *act* (e.g. auto-draft replies) must go through
  the M4 task-graph + approval flow instead of this executor family — the
  fixed-pipeline rule is the boundary, not a limitation to erode.
- Single-process assumption (one API instance) is fine today; the SKIP LOCKED
  claims already make multi-instance safe if that ever changes.
