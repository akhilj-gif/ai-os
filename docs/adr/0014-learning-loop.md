# ADR-0014: M10 Learning Loop — the OS improves itself, gym-gated

**Status:** accepted (2026-07-08) · **Milestone:** M10

## Context

The blueprint's finale: the OS should get better without manual prompt editing —
"failed tasks → root-cause → proposed playbook/prompt changes → **verified in the
gym** → auto-adopted or queued." The danger is obvious: an OS that rewrites its
own behavior can rewrite it *worse*. Self-improvement without an objective gate is
how an agent quietly degrades.

## Decision

The learning loop is the coding loop (M6) with the verifier swapped:

| | proposes | verifier (objective ground truth) | adopts iff |
|---|---|---|---|
| Coding loop (M6) | a code diff | the **sandbox** runs the tests | exit 0 |
| Learning loop (M10) | a **playbook** (procedural memory) | the **gym** runs the eval suites | no regression |

Neither trusts the model's claim — both trust an external verifier.

- **Signal → proposal.** `gatherFailureSignals` pulls recent failed tasks + their
  recorded errors; `llmProposer` does root-cause analysis and proposes small,
  GENERAL procedural playbooks (a subject + one/two imperative sentences). A
  playbook is DATA (a procedural memory), not code — safe to add and to revert.
- **The gym is the gate.** `gymVerifier` runs the full gym with the candidate
  playbook injected into every case's context (`EVAL_CANDIDATE_MEMORY` →
  `runTask`'s `extraSystem` seam from M9). The runner already exits non-zero on
  ANY regression vs the recorded baseline (the FC-020 machinery), so **exit 0 =
  safe to adopt, exit 1 = the candidate broke something.** Quota exhaustion →
  INCONCLUSIVE → queued, never adopted on a guess.
- **Adopt / reject / queue, fail-closed.** Adopt (persist the procedural memory,
  provenance = the cycle's task) only when the gym is clean AND autoAdopt is on.
  A regression → rejected. Clean-but-not-auto or inconclusive → queued for human
  review. A verifier that throws → never adopts. Candidates are verified in
  isolation; only adopted ones persist, so the system is never left worse.
- **Auditable + reversible.** Every proposal is an `improvements` row (the change,
  the gym verdict, its fate, the memory it created). Reverting an adopted playbook
  = removing one procedural memory.
- **Adoption over HTTP is manual.** `POST /learning/run` proposes + verifies +
  QUEUES (autoAdopt defaults false); `POST /improvements/:id/adopt` is the
  explicit human yes. Auto-adoption is reserved for the scheduled cycle.

## Consequences

- The exit criterion ("two months of rising eval scores + falling cost-per-task
  without manual editing") is now *mechanically possible*: the loop can only ever
  raise or hold the baseline, never lower it.
- Slice-1 adopts on "no regression"; "improved a previously-failing case" is a
  stronger future bar (and enables auto-adopt with confidence). A scheduled
  weekly cycle + self-report (extends the M7 scheduler) is the next step.
- The playbook surface is procedural memories only; tuning the kernel system
  prompt or pack prompts is deliberately out of scope (higher blast radius).
- Verified by `learning-smoke.ts` (deterministic, no model): adopt-on-clean,
  reject-and-revert-on-regression, fail-closed on verifier error, autoAdopt=false
  queues, empty-proposal no-op. The LLM proposer + gym verifier are confirmed
  on a clean-quota window.
