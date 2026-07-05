// Sandbox contract (blueprint §8.2, ADR-0009). The seam M6's code-execution and
// browsing tools implement. Defined now; no live runner yet because no tool needs
// one (there is deliberately NO host-code path today). Any future code/browse tool
// MUST run through a SandboxRunner meeting the guarantees below.
export interface SandboxSpec {
  /** Container image (dev: Docker; later gVisor/Firecracker). */
  image: string;
  /** Command + args to run inside the container. */
  cmd: string[];
  /** Files to materialise in the per-task workspace (relative paths only). */
  files?: Record<string, string>;
  /** Hard wall-clock limit; the runner MUST kill past this. */
  timeoutMs: number;
  /** Egress allowlist (hostnames). Empty = no network. Deny by default. */
  egressAllowlist?: string[];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Guarantees every implementation MUST meet:
 *  - no host filesystem mount (only the per-task workspace, rw; nothing else)
 *  - network denied by default; only `egressAllowlist` hosts reachable
 *  - CPU / memory / wall-time limits; non-root user; killed on timeout
 *  - nothing runs on the host (blueprint §8.2)
 */
export interface SandboxRunner {
  run(spec: SandboxSpec): Promise<SandboxResult>;
}

/** Placeholder until M6 wires a Docker-backed runner. Fails loudly so no code
 *  path can silently execute unsandboxed. */
export const notImplementedSandbox: SandboxRunner = {
  run() {
    throw new Error('SandboxRunner not implemented until M6 (Engines). Code must not run on the host — see ADR-0009.');
  },
};
