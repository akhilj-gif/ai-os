// Trust Gate (blueprint §8) — exists from commit #1 (principle 3).
// M0 scope: the classification contract + fail-closed defaults. Policy storage,
// approval flows, and the untrusted-content rule land in M1/M5.
import type { TrustClass } from '@ai-os/shared';

/** Policies are data, not code (§8.1). This is the built-in floor; user policies
 *  may tighten it but the gate itself can never be bypassed. */
export interface TrustPolicy {
  tool: string;
  trustClass: TrustClass;
  autoApprove: boolean;
}

/** Fail closed: a tool nobody classified is treated as irreversible. */
export const UNKNOWN_TOOL_CLASS: TrustClass = 'irreversible';

const DEFAULT_AUTO: Record<TrustClass, boolean> = {
  read: true,
  write: true, // auto + logged, undoable where possible
  irreversible: false, // approval required
  spend: false, // approval required — never auto (blueprint §2.1)
};

export function requiresApproval(trustClass: TrustClass): boolean {
  return !DEFAULT_AUTO[trustClass];
}

export function classifyTool(tool: string, policies: TrustPolicy[]): TrustClass {
  return policies.find((p) => p.tool === tool)?.trustClass ?? UNKNOWN_TOOL_CLASS;
}
