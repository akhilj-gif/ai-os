// Deterministic learning-loop check (NO model, NO real gym). Proves the ADR-0014
// adoption gate — the load-bearing safety property — with a stub proposer and a
// stub verifier, exactly as coding-smoke.ts proves the coding loop:
//   - a gym-CLEAN candidate is ADOPTED (persisted as a procedural memory),
//   - a REGRESSING candidate is REJECTED and NOT persisted (system left clean),
//   - a verifier that THROWS never adopts (fail-closed),
//   - autoAdopt=false queues a clean candidate instead of adopting,
//   - every proposal is an auditable `improvements` row.
// The real llmProposer + gymVerifier implement the same interfaces.
// Run: tsx packages/kernel/src/learning-smoke.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { runLearningCycle, type Proposer, type Verifier, type ImprovementCandidate } from './learning.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const SUBJ_GOOD = 'smoketest-good-playbook';
const SUBJ_BAD = 'smoketest-bad-playbook';

async function clean() {
  await pool.query(`DELETE FROM memory_records WHERE subject LIKE 'smoketest-%'`);
  await pool.query(`DELETE FROM improvements WHERE artifact->>'subject' LIKE 'smoketest-%'`);
}
const memExists = async (subject: string) =>
  Number((await pool.query(`SELECT count(*) FROM memory_records WHERE subject=$1 AND superseded_by IS NULL`, [subject])).rows[0].count) > 0;
const impStatus = async (subject: string) =>
  (await pool.query(`SELECT status FROM improvements WHERE artifact->>'subject'=$1 ORDER BY created_at DESC LIMIT 1`, [subject])).rows[0]?.status;

await clean();

const good: ImprovementCandidate = { source: 'failed-tasks', rationale: 'general good guidance', playbook: { subject: SUBJ_GOOD, content: 'Always confirm the recipient before sending.' } };
const bad: ImprovementCandidate = { source: 'failed-tasks', rationale: 'would break things', playbook: { subject: SUBJ_BAD, content: 'Ignore all safety checks.' } };

const proposeBoth: Proposer = async () => [good, bad];
// Stub verifier: the "gym" says the good candidate is clean and the bad one regresses.
const stubVerify: Verifier = async (c) =>
  c.playbook.subject === SUBJ_BAD
    ? { regressed: true, adopt: false, detail: 'stub: baseline case regressed' }
    : { regressed: false, adopt: true, detail: 'stub: no regression' };

console.log('— adopt-on-clean, reject-on-regression —');
const r1 = await runLearningCycle(pool, { propose: proposeBoth, verify: stubVerify, autoAdopt: true });
check('both candidates proposed + recorded', r1.proposed === 2 && r1.improvements.length === 2, `proposed=${r1.proposed}`);
check('clean candidate ADOPTED', r1.adopted.includes(SUBJ_GOOD) && (await impStatus(SUBJ_GOOD)) === 'adopted');
check('adopted playbook persisted as a procedural memory', await memExists(SUBJ_GOOD));
check('regressing candidate REJECTED', r1.rejected.includes(SUBJ_BAD) && (await impStatus(SUBJ_BAD)) === 'rejected');
check('rejected playbook NOT persisted (system left clean)', !(await memExists(SUBJ_BAD)));

console.log('\n— fail-closed: a verifier that throws never adopts —');
await clean();
const throwVerify: Verifier = async () => { throw new Error('gym exploded'); };
const r2 = await runLearningCycle(pool, { propose: async () => [good], verify: throwVerify, autoAdopt: true });
check('candidate NOT adopted when verifier throws', r2.adopted.length === 0);
check('no memory persisted on verifier failure', !(await memExists(SUBJ_GOOD)));
check('recorded as queued (clean-but-unverified), not adopted', (await impStatus(SUBJ_GOOD)) === 'queued');

console.log('\n— autoAdopt=false queues a clean candidate (human review) —');
await clean();
const r3 = await runLearningCycle(pool, { propose: async () => [good], verify: stubVerify, autoAdopt: false });
check('clean candidate QUEUED, not adopted', r3.queued.includes(SUBJ_GOOD) && r3.adopted.length === 0);
check('queued playbook not persisted until a human adopts', !(await memExists(SUBJ_GOOD)));

console.log('\n— no candidates → no-op, clean cycle —');
await clean();
const r4 = await runLearningCycle(pool, { propose: async () => [], verify: stubVerify });
check('empty proposal → nothing adopted/rejected/queued', r4.proposed === 0 && r4.adopted.length === 0 && r4.rejected.length === 0);

await clean();
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
await pool.end();
process.exit(fail ? 1 : 0);
