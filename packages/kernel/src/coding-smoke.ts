// Deterministic coding-loop check (NO model). Proves the test-driven fix loop end
// to end: starting from buggy code with a FAILING test, the loop applies a proposed
// change, runs the tests in the Docker sandbox, and — while red — feeds the failure
// back and iterates until green. The proposer is stubbed with a fixed 2-round script
// (round 1 a WRONG fix, round 2 the correct one) so the MECHANICS — apply →
// sandbox-test → iterate → passing diff — are proven without model quota, exactly
// like trust/smoke.ts (15/15) and sandbox-smoke.ts (7/7). The real LLM proposer
// (llmProposer) implements the same Proposer interface.
// Run: tsx packages/kernel/src/coding-smoke.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { runCodingTask, type Proposer } from './coding.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

// Fixture: add() subtracts (bug). The test asserts add(2,3)===5 and exits non-zero on failure.
const buggy = {
  'calc.py': 'def add(a, b):\n    return a - b\n',
  'test_calc.py': 'from calc import add\nassert add(2, 3) == 5, f"add(2,3)={add(2,3)}"\nprint("OK")\n',
};

// Scripted proposer. Round 1 returns a WRONG fix (multiply → 6≠5, stays red); round 2,
// having received lastFailure, returns the correct fix (add). Round 2 firing at all
// proves the feedback loop — not just single-shot luck.
let calls = 0;
const stub: Proposer = async ({ lastFailure }) => {
  calls++;
  if (calls === 1) return { rationale: 'try multiply', files: [{ path: 'calc.py', content: 'def add(a, b):\n    return a * b\n' }] };
  if (!lastFailure) throw new Error('round 2 did not receive the previous failure');
  return { rationale: 'use addition', files: [{ path: 'calc.py', content: 'def add(a, b):\n    return a + b\n' }] };
};

console.log('— test-driven fix loop (red → red → green) —');
const res = await runCodingTask(pool, {
  instruction: 'fix add() so add(2,3)==5',
  files: buggy,
  testCmd: 'python test_calc.py',
  language: 'python',
  propose: stub,
});
check('loop reaches green', res.status === 'passed', res.status);
check('iterated over 2 rounds (proves feedback loop)', res.rounds === 2, `rounds=${res.rounds}`);
check('final code is the correct fix (a + b)', res.files['calc.py']?.includes('a + b') ?? false);
check('did NOT keep the wrong intermediate (a * b)', !(res.files['calc.py']?.includes('a * b') ?? true));
check('changed file tracked', res.changedFiles.includes('calc.py'), res.changedFiles.join(','));
check('sandbox test actually ran (OK printed)', res.testOutput.includes('OK'), res.testOutput.replace(/\n/g, ' ').slice(0, 70));
check('rationale carried from final round', res.rationale === 'use addition', res.rationale);

// Safety: a proposer that never fixes it must be reported as FAILED — never a false green.
console.log('\n— no false pass when the fix never works —');
const neverFix: Proposer = async () => ({ rationale: 'still broken', files: [{ path: 'calc.py', content: 'def add(a, b):\n    return a - b\n' }] });
const res2 = await runCodingTask(pool, {
  instruction: 'fix add()',
  files: buggy,
  testCmd: 'python test_calc.py',
  language: 'python',
  maxRounds: 2,
  propose: neverFix,
});
check('reports failure (no false green)', res2.status === 'failed', res2.status);
check('exhausted the round budget', res2.rounds === 2, `rounds=${res2.rounds}`);
check('failure carries the test output', res2.testOutput.includes('add(2,3)=-1'), res2.testOutput.replace(/\n/g, ' ').slice(0, 70));

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
await pool.end();
process.exit(fail ? 1 : 0);
