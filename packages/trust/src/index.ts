// Trust Gate (blueprint §8) — exists from commit #1 (principle 3).
// M1 scope: policy lookup from the trust_policies table (policies are data, §8.1),
// fail-closed classification, and the approval default per class. Approval FLOWS
// (pause task → ask user → resume) arrive in M4; at M1 a non-auto tool is refused.
import type pg from 'pg';
import type { TrustClass } from '@ai-os/shared';

export interface TrustDecision {
  tool: string;
  trustClass: TrustClass;
  autoApprove: boolean;
  /** true when no policy row existed and the fail-closed default was applied */
  unknownTool: boolean;
}

/** Fail closed: a tool nobody classified is treated as irreversible. */
export const UNKNOWN_TOOL_CLASS: TrustClass = 'irreversible';

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
