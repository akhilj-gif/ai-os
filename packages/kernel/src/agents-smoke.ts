// M11 agents — deterministic smoke (no DB, no model): plan parsing/validation,
// topological waves, and the orchestrate() engine with stubbed runners.
// Run: npx tsx packages/kernel/src/agents-smoke.ts
import { parsePlan, topoWaves, orchestrate, type Subtask, type ChildResult } from './agents.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}
function throws(fn: () => unknown, re: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(String(e));
  }
}

console.log('— parsePlan —');
const good = parsePlan('Here is the plan: {"subtasks":[{"id":"s1","agent":"researcher","goal":"find x","dependsOn":[]},{"id":"s2","agent":"scheduler","goal":"book y","dependsOn":["s1"]}]} done');
check('extracts JSON from prose wrapper', good.length === 2 && good[1]!.dependsOn[0] === 's1');
check('unknown agent rejected', throws(() => parsePlan('{"subtasks":[{"id":"a","agent":"hacker","goal":"x"}]}'), /unknown agent/));
check('duplicate id rejected', throws(() => parsePlan('{"subtasks":[{"id":"a","agent":"coder","goal":"x"},{"id":"a","agent":"coder","goal":"y"}]}'), /duplicate/));
check('unknown dependency rejected', throws(() => parsePlan('{"subtasks":[{"id":"a","agent":"coder","goal":"x","dependsOn":["zz"]}]}'), /unknown "zz"/));
check('self-dependency rejected', throws(() => parsePlan('{"subtasks":[{"id":"a","agent":"coder","goal":"x","dependsOn":["a"]}]}'), /itself/));
check('empty plan rejected', throws(() => parsePlan('{"subtasks":[]}'), /missing\/empty/));
check('over-cap rejected', throws(() => parsePlan(JSON.stringify({ subtasks: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, agent: 'coder', goal: 'x' })) })), /too many/));
check('missing goal rejected', throws(() => parsePlan('{"subtasks":[{"id":"a","agent":"coder","goal":""}]}'), /no goal/));

console.log('\n— topoWaves —');
const diamond: Subtask[] = [
  { id: 's1', agent: 'researcher', goal: 'a', dependsOn: [] },
  { id: 's2', agent: 'coder', goal: 'b', dependsOn: ['s1'] },
  { id: 's3', agent: 'scheduler', goal: 'c', dependsOn: ['s1'] },
  { id: 's4', agent: 'communicator', goal: 'd', dependsOn: ['s2', 's3'] },
];
const waves = topoWaves(diamond);
check('diamond → 3 waves', waves.length === 3, waves.map((w) => w.map((s) => s.id).join('+')).join(' | '));
check('middle wave is parallel pair', waves[1]!.length === 2);
check(
  'cycle throws',
  throws(
    () => topoWaves([
      { id: 'a', agent: 'coder', goal: 'x', dependsOn: ['b'] },
      { id: 'b', agent: 'coder', goal: 'y', dependsOn: ['a'] },
    ]),
    /cycle/,
  ),
);

console.log('\n— orchestrate —');
{
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const seenCtx: Record<string, { depBlock: string; untrusted: boolean }> = {};
  const res = await orchestrate('goal', diamond, {
    concurrency: 2,
    runChild: async (s, ctx) => {
      order.push(s.id);
      seenCtx[s.id] = ctx;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      inFlight--;
      // researcher output is untrusted-derived; scheduler fails; others fine
      if (s.id === 's1') return { status: 'done', text: 'found: pgvector 0.8 [cite]', untrusted: true };
      if (s.id === 's3') throw new Error('boom');
      return { status: 'done', text: `${s.id} ok`, untrusted: ctx.untrusted };
    },
    synth: async (_goal, results: ChildResult[]) =>
      `SYNTH:${results.map((r) => `${r.id}=${r.status}${r.untrusted ? '(u)' : ''}`).join(',')}`,
  });

  check('all four children ran', order.length === 4);
  check('wave order respected (s1 first, s4 last)', order[0] === 's1' && order[3] === 's4');
  check('concurrency cap 2 respected', maxInFlight <= 2, `max in flight: ${maxInFlight}`);
  check('dependency result injected into dependent context', seenCtx['s2']!.depBlock.includes('pgvector 0.8'));
  check('untrusted taint propagates to dependents', seenCtx['s2']!.untrusted === true && seenCtx['s4']!.untrusted === true);
  check('untrusted dep block is banner-framed', seenCtx['s2']!.depBlock.startsWith('[UNTRUSTED-DERIVED CONTENT'));
  check('child throw becomes failed result, run continues', res.results.find((r) => r.id === 's3')!.status === 'failed');
  check('synthesizer sees ordered results incl. failure', res.text === 'SYNTH:s1=done(u),s2=done(u),s3=failed(u),s4=done(u)', res.text);
}

{
  // No deps and concurrency 1 → strictly sequential
  const solo: Subtask[] = [
    { id: 'a', agent: 'coder', goal: 'x', dependsOn: [] },
    { id: 'b', agent: 'coder', goal: 'y', dependsOn: [] },
  ];
  let inFlight = 0;
  let overlap = false;
  await orchestrate('g', solo, {
    concurrency: 1,
    runChild: async () => {
      if (inFlight > 0) overlap = true;
      inFlight++;
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { status: 'done', text: 'ok', untrusted: false };
    },
    synth: async () => 'done',
  });
  check('concurrency 1 → no overlap', !overlap);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
