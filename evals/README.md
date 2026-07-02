# evals — "the gym"

Built in **M2** per [docs/EVAL-SPEC.md](../docs/EVAL-SPEC.md). Directory reserved now so the
structure is part of the skeleton:

```
suites/           ← support-triage, memory-recall, tool-reliability, injection-defense, planning
fixtures/         ← frozen real inputs (tickets, recorded tool responses, KB snapshot manifest)
runner.ts         ← suite runner → scores → report (CI gate)
baselines.json    ← last accepted scores; regression = failure
```

Cases come from [docs/FAILURE-CORPUS.md](../docs/FAILURE-CORPUS.md) — every case cites its FC-### entry.
