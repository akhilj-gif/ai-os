// Support-triage suite — BUNDLED WITH the support-ops capability pack (M9).
// Deliberately empty: per blueprint §6 it needs ~20 REAL triage tickets (actual
// ticket numbers, actual failure modes) collected during Akhil's daily support
// work — invented tickets would gym-train against fiction (FC-corpus discipline).
// The runner reports an empty suite as "no cases yet" without affecting the gate.
import type { Suite } from '../lib/types.js';

export const supportTriage: Suite = {
  name: 'support-triage',
  cases: [],
};
