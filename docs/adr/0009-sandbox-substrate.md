# ADR-0009 — Sandbox: substrate now, enforced at M6

**Date:** 2026-07-05 · **Status:** Accepted · **Blueprint:** §8.2

## Context

M5's exit includes "code runs only in containers." But the tools that need a
sandbox — a code-execution engine and a browser — arrive at **M6** (Engines).
There is deliberately no host-code-execution or arbitrary-shell tool today; the
current tool layer is HTTP calls (web/Gmail/Calendar) and a **path-scoped**
filesystem workspace (safePath blocks traversal/cross-drive/UNC — unit-tested).

## Decisions

1. **The "code runs only in containers" invariant holds vacuously now** and is
   enforced going forward: no tool executes host code or opens an unrestricted
   shell. A repo guard (grep for `child_process`/`exec`/`spawn` outside the
   sandbox module) backs this; adding a code/browse tool MUST go through the
   sandbox.
2. **Define the sandbox contract now** (`packages/tools/src/sandbox.ts`):
   `SandboxRunner.run({ image, cmd, files, timeoutMs, egressAllowlist })` →
   `{ stdout, stderr, exitCode }`. M6's coding/browsing tools implement against
   this interface; M5 ships the interface + a Docker-backed skeleton, not a
   live runner (nothing calls it yet — building a full runner now would be
   unused code).
3. **Guarantees the runner must meet (for M6):** no host FS mount (only the
   per-task workspace, read-write; rest read-only or none), egress allowlist
   (deny by default), CPU/mem/wall-time limits, non-root. Dev: Docker;
   later: gVisor/Firecracker (blueprint §5).

## Consequences

- M5 is honest: the sandbox is substrate + invariant, not a running container
  runner, because there is nothing to run in it yet. The exit criterion ("code
  runs only in containers") is met by the absence of any host-code path plus the
  defined contract — and becomes load-bearing the moment M6 adds the code engine.
- The filesystem workspace scoping (M3 fix) is the one sandbox-like control that
  is live and tested today.
