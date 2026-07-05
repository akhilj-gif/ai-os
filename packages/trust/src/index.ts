// Trust Gate (blueprint §8) — exists from commit #1 (principle 3).
// Policy lookup from the trust_policies table (policies are data, §8.1),
// fail-closed classification, and the approval default per class. At M1 a
// non-auto tool was refused; at M4 the planner/graph route it through an
// approval step (pause → approve → resume).
import type pg from 'pg';
import type { TrustClass } from '@ai-os/shared';

export interface TrustDecision {
  tool: string;
  trustClass: TrustClass;
  autoApprove: boolean;
  /** true when no policy row existed and the fail-closed default was applied */
  unknownTool: boolean;
}

/** A trust policy row (data, not code — §8.1). */
export interface TrustPolicy {
  tool: string;
  trustClass: TrustClass;
  autoApprove: boolean;
}

/** Fail closed: a tool nobody classified is treated as irreversible. */
export const UNKNOWN_TOOL_CLASS: TrustClass = 'irreversible';

/** Default per-class approval policy (§8.1): read/write auto, irreversible/spend not. */
export function requiresApproval(trustClass: TrustClass): boolean {
  return trustClass === 'irreversible' || trustClass === 'spend';
}

/** A mutating action — anything that changes state or the outside world. */
export function isMutating(trustClass: TrustClass): boolean {
  return trustClass === 'write' || trustClass === 'irreversible' || trustClass === 'spend';
}

/**
 * The STRUCTURAL injection defense (blueprint §8.3 rule 2), the heart of M5.
 * When untrusted content (a web page, email/ticket body, or any external tool
 * result) is in the current context, the model CANNOT be used to trigger a
 * mutating action — regardless of what it decides. Untrusted content informs;
 * it never gains authority to cause side effects. Read-only actions stay
 * allowed. This makes injection defense architectural, not prompt-dependent:
 * even a fully-compromised model is contained.
 *
 * We broaden the blueprint's literal "irreversible/spend" to ALL mutations
 * (incl. write): a draft/file write induced by a hostile email is exactly the
 * exfiltration/tampering vector the rule exists to stop. User-requested writes
 * happen before any untrusted content enters context, so they are unaffected.
 */
export function blockedByUntrustedContext(trustClass: TrustClass, untrustedInContext: boolean): boolean {
  return untrustedInContext && isMutating(trustClass);
}

/** Classify a tool against a policy set, fail-closed for unknown tools. */
export function classifyTool(tool: string, policies: TrustPolicy[]): TrustClass {
  return policies.find((p) => p.tool === tool)?.trustClass ?? UNKNOWN_TOOL_CLASS;
}

export { SecretsBroker, secretsBroker, redactForAudit } from './secrets.js';

export class TrustGate {
  constructor(private readonly pool: pg.Pool) {}

  async classify(tool: string): Promise<TrustDecision> {
    const { rows } = await this.pool.query<{ trust_class: TrustClass; auto_approve: boolean }>(
      'SELECT trust_class, auto_approve FROM trust_policies WHERE tool = $1',
      [tool],
    );
    const row = rows[0];
    if (!row) {
      return { tool, trustClass: UNKNOWN_TOOL_CLASS, autoApprove: false, unknownTool: true };
    }
    return {
      tool,
      trustClass: row.trust_class,
      autoApprove: row.auto_approve,
      unknownTool: false,
    };
  }
}
