# EVAL SPEC — how failure-corpus entries become scored, repeatable tests

**Version:** 1.0 · **Date:** 2026-07-02 · **Owner:** Akhil · **Implements:** blueprint §6 ("the gym", built in M2)

---

## 1. The pipeline: corpus entry → eval case

Every [FAILURE-CORPUS.md](FAILURE-CORPUS.md) entry carries a **pass condition** — an observable, checkable outcome. Converting one to an eval case:

1. **Fixture** — freeze the real inputs (ticket JSON, tool responses, KB snapshot refs). Real data, anonymized where needed; never synthetic when real exists.
2. **Mocked tool layer** — the agent under test runs against recorded/mocked MCP responses so runs are deterministic and free. (Live-tool smoke runs are a separate, manual suite.)
3. **Assertions** — the pass condition, expressed as checks (§4).
4. **Baseline** — first accepted score recorded in `baselines.json`; CI fails on regression.

One corpus entry may yield several cases (e.g. FC-004 → one case per ID format).

## 2. Suite layout

```
evals/
  suites/
    support-triage/        ← FC-003, FC-008 + ~20 real tickets: classification + reply rubrics
    memory-recall/         ← FC-001: "told the system X on day 1, ask on day 30"
    tool-reliability/      ← FC-002, FC-004..007: flaky tools, overflow, schema drift, ID juggling
    injection-defense/     ← 15+ attack payloads in ticket bodies & web pages (real ones from the queue first)
    planning/              ← FC-005, FC-009..011: decomposition, fallback routing, clarify-vs-act
  runner.ts                ← runs suite → scores → report (console + JSON)
  baselines.json           ← last accepted scores per suite
  fixtures/                ← shared frozen inputs (tickets, tool recordings, KB snapshot manifest)
```

### Case file format (one YAML per case)

```yaml
id: support-triage/fc-003-promo-not-applying
source: FC-003                  # corpus traceability — every case cites its entry
task: "Resolve ticket #30479 (coupon not applying)"
fixtures:
  ticket: fixtures/tickets/30479.json
  tools: fixtures/recordings/trinity-30479/   # recorded MCP responses
assertions:                     # §4 — all must pass unless marked soft
  - kind: behavior
    check: "agent states it cannot verify coupon state OR queries billing tool"
  - kind: citation
    check: "every solution claim cites a KB article or a tool result"
  - kind: judge
    rubric: rubrics/reply-quality.md
    min_score: 4                # of 5
budgets: { max_tokens: 30000, max_cost_usd: 0.15, max_latency_s: 60 }
```

## 3. Scoring: three tiers, cheapest first

| Tier | What | Examples | Cost |
|---|---|---|---|
| **1. Hard assertions** | Deterministic checks on outputs/trace | correct classification label; all 3 ID formats resolved; no tool call beyond `read` class; cited article exists in KB | free |
| **2. Trace assertions** | Checks on the *behavior*, from the trace | retried ≤ N times then surfaced error honestly (FC-002); asked a clarifying question on ambiguous fixture, did NOT ask on clear fixture (FC-011); oversized output was truncated (FC-006) | free |
| **3. LLM judge** | Rubric-scored quality, only where 1–2 can't reach | reply tone/completeness vs. rubric; briefing accuracy vs. source tickets | ~cents/case |

**Judge rules:** judge model ≠ executor model tier where feasible; rubric is a versioned file; judge sees fixture + output, never the agent's chain-of-thought; every judge rubric is spot-checked against 5 hand-scored cases before trusted (agreement ≥ 4/5 or the rubric is rewritten).

**Case verdict:** all hard/trace assertions pass AND judge ≥ threshold AND within budget. Any budget breach = fail (principle 10: cost is a feature).

## 4. Suite-level scoring & gates

Per suite, per run, record: **success rate · cost per task · latency p50/p95 · tokens per task**.

| Gate | Rule |
|---|---|
| `injection-defense` | **100% required. Gates every release. No exceptions, no "known failures".** |
| All other suites | ≥ baseline in `baselines.json`; regression = CI failure |
| Baseline updates | Only deliberate: a human (Akhil) accepts the new number in the same PR that changes behavior |
| Flake policy | A case that flips verdict on identical inputs twice in 10 runs is quarantined *and* becomes a new corpus entry (nondeterminism is itself a failure) |

**Trigger matrix (blueprint §6 rules):** prompt change, model change, memory-logic change, context-engine change → full run before merge. New feature → its eval cases exist **first**, red, then the feature turns them green. Tool-adapter change → `tool-reliability` at minimum.

## 5. Runner contract

`pnpm eval [suite] [--case id] [--live]` →

- Runs each case through the real agent loop (mocked tools by default, `--live` for smoke).
- Emits per-case verdicts + suite scores to console and `evals/reports/<timestamp>.json`.
- Every case run is traced (same tracing as production — trace_id links report ↔ Langfuse).
- Exit code 0 only if all gates pass — this *is* the CI gate.
- Deterministic where possible: fixed seeds/temperature 0 for assertion-tier cases.

## 6. What M2 must ship (scope contract)

Three suites live with real cases: `support-triage` (≥ 10 cases), `tool-reliability` (≥ 8), `injection-defense` v1 (≥ 8 payloads). Runner + baselines + CI gate wired.
**M2 exit test:** one prompt change measurably improves a suite; one deliberately bad change is caught. If the corpus has < 50 entries by then, build from what exists — but `support-triage` needs its ~20 real tickets before M4's planner work.

## 7. Metrics dashboard (weekly cadence, blueprint §13)

Per-suite trend lines: success rate, cost/task, latency p95 — reviewed weekly. Two consecutive months of rising scores + falling cost without manual prompt edits is the M10 exit; this spec's numbers are that measurement from day one.
