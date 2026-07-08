// Confirm the MODEL half of the learning loop on REAL data: gather actual failed
// tasks, ask the proposer (LLM) for root-cause playbooks, print them. One model
// call — cheap. The gym-verify half is proven separately (learning-smoke + the
// FC-020 regression gate). Quota-dead → INCONCLUSIVE (honest), not a failure.
// Run: MODEL_PROVIDER=groq npx tsx packages/kernel/src/learning-llm-check.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { gatherFailureSignals, llmProposer } from './learning.js';
import { newTraceId } from '@ai-os/shared';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const signals = await gatherFailureSignals(pool, 12);
console.log(`failed tasks available to learn from: ${signals.totalFailed} (showing ${signals.failedTasks.length})`);
for (const t of signals.failedTasks.slice(0, 5)) console.log(`  - ${t.goal.slice(0, 60)} :: ${t.error.slice(0, 70)}`);

if (signals.failedTasks.length === 0) {
  console.log('\nno failed tasks to analyze — nothing to propose (clean history).');
  await pool.end();
  process.exit(0);
}

try {
  const propose = llmProposer(pool, { taskId: newTraceId(), traceId: newTraceId() });
  const candidates = await propose(signals);
  console.log(`\nPROPOSER RETURNED ${candidates.length} playbook(s):`);
  for (const c of candidates) {
    console.log(`\n  • [${c.playbook.subject}]`);
    console.log(`    rationale: ${c.rationale}`);
    console.log(`    playbook:  ${c.playbook.content}`);
  }
  console.log(candidates.length ? '\nRESULT: proposer works on real failures — these would each be GYM-VERIFIED before adoption.' : '\nRESULT: proposer ran but proposed nothing (no generalizable pattern).');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/rate|quota|429|INFRA_/i.test(msg)) console.log(`\nINCONCLUSIVE: model quota/rate limit (${msg.slice(0, 80)}). Mechanics proven by learning-smoke.ts.`);
  else console.log('\nERROR:', msg);
} finally {
  await pool.end();
}
