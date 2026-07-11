// M11 agents — deterministic smoke (no DB, no model): plan parsing/validation,
// topological waves, and the orchestrate() engine with stubbed runners.
// Run: npx tsx packages/kernel/src/agents-smoke.ts
import { parsePlan, topoWaves, orchestrate, isRateLimitPressure, type Subtask, type ChildResult } from './agents.js';

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

console.log('\n— orchestrate: checkpoint-resume (prior seam) —');
{
  // Simulate a restart after s1 finished: prior() serves s1's recorded result;
  // the rest run normally and still see s1's output + taint.
  const ran: string[] = [];
  const seenCtx: Record<string, { depBlock: string; untrusted: boolean }> = {};
  const res = await orchestrate('goal', diamond, {
    concurrency: 2,
    prior: (s) => (s.id === 's1' ? { id: 's1', agent: 'researcher', status: 'done' as const, text: 'RECORDED: pgvector 0.8 [cite]', untrusted: true } : null),
    runChild: async (s, ctx) => {
      ran.push(s.id);
      seenCtx[s.id] = ctx;
      return { status: 'done', text: `${s.id} ok`, untrusted: ctx.untrusted };
    },
    synth: async (_g, results: ChildResult[]) => `SYNTH:${results.map((r) => `${r.id}=${r.status}`).join(',')}`,
  });
  check('terminal child NOT re-run on resume', !ran.includes('s1'), `ran: ${ran.join(',')}`);
  check('remaining children still run', ran.length === 3);
  check('recorded result feeds dependents', seenCtx['s2']!.depBlock.includes('RECORDED: pgvector 0.8'));
  check('recorded taint still propagates', seenCtx['s2']!.untrusted === true && seenCtx['s4']!.untrusted === true);
  check('synthesis sees all four ordered', res.text === 'SYNTH:s1=done,s2=done,s3=done,s4=done', res.text);
}

{
  // Restart after EVERYTHING finished (death during synthesis): no child runs,
  // synthesis still produces the final answer.
  let childCalls = 0;
  const res = await orchestrate('goal', diamond, {
    prior: (s) => ({ id: s.id, agent: s.agent, status: 'done' as const, text: `${s.id} recorded`, untrusted: false }),
    runChild: async () => {
      childCalls++;
      return { status: 'done', text: 'should never run', untrusted: false };
    },
    synth: async (_g, results: ChildResult[]) => `SYNTH:${results.length}`,
  });
  check('all-terminal resume runs zero children', childCalls === 0);
  check('all-terminal resume still synthesizes', res.text === 'SYNTH:4');
}

{
  // A child that ended awaiting_approval before the restart keeps that status —
  // resume must not re-run it (its approval card is already queued).
  const ran: string[] = [];
  const solo: Subtask[] = [
    { id: 'a', agent: 'communicator', goal: 'send x', dependsOn: [] },
    { id: 'b', agent: 'coder', goal: 'compute y', dependsOn: [] },
  ];
  const res = await orchestrate('g', solo, {
    prior: (s) => (s.id === 'a' ? { id: 'a', agent: 'communicator', status: 'awaiting_approval' as const, text: 'queued send', untrusted: false } : null),
    runChild: async (s) => {
      ran.push(s.id);
      return { status: 'done', text: 'ok', untrusted: false };
    },
    synth: async (_g, results: ChildResult[]) => results.map((r) => `${r.id}=${r.status}`).join(','),
  });
  check('awaiting_approval child not re-run', !ran.includes('a') && ran.includes('b'));
  check('awaiting_approval status survives resume', res.text === 'a=awaiting_approval,b=done', res.text);
}

console.log('\n— isRateLimitPressure —');
check('humanized rate-limit text matches', isRateLimitPressure('⚠ I couldn’t finish that — the AI model provider is rate-limited right now.'));
check('humanized network text matches', isRateLimitPressure('⚠ I couldn’t finish that — I had trouble reaching the AI model provider (network issue).'));
check('raw INFRA_RATELIMIT marker matches', isRateLimitPressure('INFRA_RATELIMIT 429 (groq): ...'));
check('an ordinary success/failure text does not match', !isRateLimitPressure('Task exceeded its iteration budget (12).'));

console.log('\n— orchestrate: default concurrency (no explicit override) —');
{
  // No `concurrency` in deps and no AIOS_AGENT_CONCURRENCY env — independent
  // subtasks must run TOGETHER (this is the actual behavior Akhil reported as
  // "one by one, wastes time"), not serialize just because nothing was passed.
  delete process.env.AIOS_AGENT_CONCURRENCY;
  const independent: Subtask[] = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, agent: 'generalist', goal: 'x', dependsOn: [] }));
  let maxInFlight = 0;
  let inFlight = 0;
  await orchestrate('g', independent, {
    runChild: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { status: 'done', text: 'ok', untrusted: false };
    },
    synth: async () => 'done',
  });
  check('default concurrency runs independent subtasks in parallel (not 1 at a time)', maxInFlight > 1, `max in flight: ${maxInFlight}`);
}

console.log('\n— orchestrate: adaptive concurrency backoff under real pressure —');
{
  // 8 independent subtasks, explicit ceiling 4 (deterministic regardless of
  // env/default). The FIRST chunk (s0-s3) hits genuine rate-limit pressure —
  // the engine must shrink for the REST of the run (s4-s7), not keep hammering
  // an exhausted provider at the same concurrency forever.
  const eight: Subtask[] = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, agent: 'generalist', goal: 'x', dependsOn: [] }));
  const startedAt: Record<string, number> = {};
  const runCount: Record<string, number> = {};
  let inFlight = 0;
  const reductions: Array<{ from: number; to: number }> = [];
  const res = await orchestrate('g', eight, {
    concurrency: 4,
    runChild: async (s) => {
      runCount[s.id] = (runCount[s.id] ?? 0) + 1;
      inFlight++;
      startedAt[s.id] = inFlight;
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      if (s.id === 's0' || s.id === 's1') {
        return { status: 'failed', text: '⚠ I couldn’t finish that — the AI model provider is rate-limited right now. It usually clears within a minute.', untrusted: false };
      }
      return { status: 'done', text: `${s.id} ok`, untrusted: false };
    },
    synth: async () => 'done',
    onEvent: async (e) => {
      if (e.kind === 'concurrency_reduced') reductions.push({ from: e.from, to: e.to });
    },
  });
  const firstChunkMax = Math.max(startedAt.s0!, startedAt.s1!, startedAt.s2!, startedAt.s3!);
  const secondChunkMax = Math.max(startedAt.s4!, startedAt.s5!, startedAt.s6!, startedAt.s7!);
  check('first chunk ran at the full starting ceiling', firstChunkMax === 4, `max: ${firstChunkMax}`);
  check('pressure in chunk 1 shrinks concurrency for chunk 2 (self-heals, not stuck)', secondChunkMax <= 2, `max: ${secondChunkMax}`);
  check('the shrink is reported via onEvent (observable, not silent)', reductions.length === 1 && reductions[0]!.from === 4 && reductions[0]!.to === 2, JSON.stringify(reductions));
  // Regression guard for a real bug this feature shipped with: `i +=
  // concurrency` in the wave-chunking loop re-read `concurrency` AFTER the
  // backoff above had already shrunk it, so the next slice's start index was
  // wrong and re-included s2/s3 — they ran twice, silently overwriting their
  // own results. Caught only by manually logging dispatch order, NOT by the
  // max-in-flight assertions above — so it gets its own explicit check.
  check('every subtask ran EXACTLY once (no re-slice duplication after a shrink)', eight.every((s) => runCount[s.id] === 1), JSON.stringify(runCount));
  check('all 8 results present in the final ordered output, none dropped', res.results.length === 8 && new Set(res.results.map((r) => r.id)).size === 8);
}

{
  // A single-child chunk (concurrency already 1) has nothing to shrink from —
  // must not throw or misbehave when isRateLimitPressure fires anyway.
  const solo: Subtask[] = [{ id: 'a', agent: 'generalist', goal: 'x', dependsOn: [] }];
  const res = await orchestrate('g', solo, {
    concurrency: 1,
    runChild: async () => ({ status: 'failed', text: 'INFRA_RATELIMIT 429', untrusted: false }),
    synth: async (_g, results: ChildResult[]) => results.map((r) => r.status).join(','),
  });
  check('concurrency already 1: pressure detection is a no-op, not a crash', res.text === 'failed');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
