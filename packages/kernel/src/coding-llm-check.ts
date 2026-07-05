// Autonomy check: the FULL loop with the real LLM proposer (no stub). Given buggy
// code + a failing test, the model must propose a fix that makes the sandbox test
// pass. Needs model quota; if exhausted this is INCONCLUSIVE (the mechanics are
// proven deterministically by coding-smoke.ts). Run: tsx packages/kernel/src/coding-llm-check.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { runCodingTask } from './coding.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const buggy = {
  'calc.py': 'def add(a, b):\n    # BUG: this subtracts\n    return a - b\n',
  'test_calc.py': 'from calc import add\nassert add(2, 3) == 5, f"add(2,3)={add(2,3)}"\nassert add(10, 5) == 15\nprint("OK")\n',
};

try {
  const res = await runCodingTask(pool, {
    instruction: 'The add() function is wrong — it must return the SUM of a and b. Fix it.',
    files: buggy,
    testCmd: 'python test_calc.py',
    language: 'python',
    maxRounds: 3,
  });
  console.log(`status=${res.status} rounds=${res.rounds} rationale="${res.rationale}"`);
  console.log('final calc.py:\n' + res.files['calc.py']);
  console.log('test output:', res.testOutput.replace(/\n/g, ' ').slice(0, 120));
  if (res.status === 'passed') console.log('\nRESULT: AUTONOMOUS FIX CONFIRMED — model proposed a change the sandbox verified green.');
  else console.log('\nRESULT: loop ran but did not reach green within budget.');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/rate|quota|429|INFRA_/i.test(msg)) console.log(`INCONCLUSIVE: model quota/rate limit (${msg.slice(0, 100)}). Mechanics proven by coding-smoke.ts.`);
  else console.log('ERROR:', msg);
} finally {
  await pool.end();
}
