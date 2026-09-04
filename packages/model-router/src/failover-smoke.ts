// Deterministic failover checks (NO network, NO model). Proves the ADR-0011/
// ADR-0019 chain-selection, capability-classification, and infra-classification
// rules by permuting env in-process: pinned MODEL_PROVIDER = single-element
// chain (evals stay deterministic); unpinned = capability-routed order among
// configured providers; only INFRA-class failures justify falling through.
// Run: tsx packages/model-router/src/failover-smoke.ts
import { failoverChain, isInfraFailure, classifyCapability, callModel } from './index.js';

let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

const saved = { ...process.env };
const setEnv = (env: Record<string, string | undefined>) => {
  for (const k of ['MODEL_PROVIDER', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEY_FALLBACK', 'NVIDIA_API_KEY', 'GROQ_API_KEY']) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
};
const names = (capability?: Parameters<typeof failoverChain>[0]) => failoverChain(capability).map((p) => p.name).join(',');

console.log('— chain selection (ADR-0011 premium prefix + ADR-0019 capability order) —');
setEnv({ GEMINI_API_KEY: 'g1', GROQ_API_KEY: 'q1' });
check("unpinned, no capability given: defaults to 'coding' (nvidia unconfigured) → groq,gemini", names() === 'groq,gemini', names());

setEnv({ GEMINI_API_KEY: 'g1', GROQ_API_KEY: 'q1', MODEL_PROVIDER: 'groq' });
check('pinned MODEL_PROVIDER=groq: single-element chain (no failover — evals deterministic)', names() === 'groq', names());

setEnv({ GEMINI_API_KEY: 'g1', GROQ_API_KEY: 'q1', MODEL_PROVIDER: 'gemini' });
check('pinned MODEL_PROVIDER=gemini: single-element chain', names() === 'gemini', names());

setEnv({ GROQ_API_KEY: 'q1' });
check('only groq configured: chain is just groq', names() === 'groq', names());

setEnv({ ANTHROPIC_API_KEY: 'a1', GEMINI_API_KEY: 'g1', GROQ_API_KEY: 'q1' });
check("anthropic outranks all when configured, regardless of capability", names() === 'anthropic,groq,gemini', names());

setEnv({ GEMINI_API_KEY: 'g1', NVIDIA_API_KEY: 'n1', GROQ_API_KEY: 'q1' });
// Chain order re-pinned 2026-09-04 after probing every provider live. NVIDIA is
// LAST everywhere now, not because of capability fit but because this account can
// barely call it: /models lists 81 entries, 14 of 15 probed returned 410 Gone or
// "Not found for account", and the survivors timed out at 45-90s.
check("capability 'workspace': groq then gemini (nvidia is out of every chain)", names('workspace') === 'groq,gemini', names('workspace'));
check("capability 'coding': groq then gemini", names('coding') === 'groq,gemini', names('coding'));
// 'fast' led with Groq until its open models all began emitting inline
// chain-of-thought: a one-word classifier prompt returned "<think>…" (qwen) or
// empty (gpt-oss), so classifyGoal always read 'simple' and the multi-agent Brain
// could never fire. gemini-flash-lite-latest answers cleanly in ~1.1s.
// NVIDIA left every chain 2026-09-04: minimax-m3 took 143s on a live "what is
// 2+2?", so landing on it is catastrophic rather than slow. It stays configured
// for an explicit MODEL_PROVIDER=nvidia, but never as automatic failover.
// Groq leads every chain on MEASUREMENT: same question, same prompt —
// groq 0.60s @35 tok in, 0.74s @4839 tok in; gemini-flash-lite 10.03s @20 tok
// in, and gemini-flash-latest 429s outright under real use. Note the middle
// figure: input size does not drive Groq's latency, so the tool catalog was
// never a SPEED problem — it was an admission problem (Groq ITPM 7000).
check("capability 'fast': groq then gemini, and NVIDIA is in no chain at all", names('fast') === 'groq,gemini', names('fast'));

setEnv({ GEMINI_API_KEY: 'g1', GROQ_API_KEY: 'q1' }); // nvidia NOT configured
check("capability 'coding' with nvidia unconfigured: skips straight to groq,gemini", names('coding') === 'groq,gemini', names('coding'));

console.log('\n— capability classification (no network, no env needed) —');
check(
  "role:'routing' → always 'fast' (the kernel's own cheap/latency-sensitive calls)",
  classifyCapability({ role: 'routing', prompt: 'classify this goal: some elaborate coding task' }) === 'fast',
);
check(
  "gmail/calendar tool offered → 'workspace'",
  classifyCapability({ role: 'execution', tools: [{ name: 'gmail_list', description: '', inputSchema: {} }] }) === 'workspace',
);
check(
  "code_exec tool offered → 'coding'",
  classifyCapability({ role: 'execution', tools: [{ name: 'code_exec', description: '', inputSchema: {} }] }) === 'coding',
);
check(
  "prompt mentions calendar/search → 'workspace' (no tools field, e.g. callModel())",
  classifyCapability({ role: 'execution', prompt: "what's on my calendar today, and search the web for IST holidays" }) === 'workspace',
);
check(
  "prompt mentions debugging a function → 'coding'",
  classifyCapability({ role: 'planning', prompt: 'debug why this function returns undefined' }) === 'coding',
);
check(
  "no signal at all → 'coding' (the catch-all bucket; now groq-first, see chain order above)",
  classifyCapability({ role: 'execution', prompt: 'hey, how are you?' }) === 'coding',
);

setEnv({});
let threw = false;
try {
  failoverChain();
} catch {
  threw = true;
}
check('no providers configured → throws (fail closed)', threw);

setEnv({ MODEL_PROVIDER: 'gemini' }); // pinned but keyless
threw = false;
try {
  failoverChain();
} catch {
  threw = true;
}
check('pinned provider without a key → throws (no silent substitute)', threw);

console.log('\n— infra classification (what may fail over) —');
check('INFRA_RATELIMIT marker → failover', isInfraFailure(new Error('INFRA_RATELIMIT 429 (gemini): quota exceeded')));
check('INFRA_NETWORK marker → failover', isInfraFailure(new Error('INFRA_NETWORK: fetch failed')));
check('SDK error with status 429 → failover', isInfraFailure(Object.assign(new Error('rate limited'), { status: 429 })));
check('SDK error with status 529 (overloaded) → failover', isInfraFailure(Object.assign(new Error('overloaded'), { status: 529 })));
check('413 TPM overflow → failover', isInfraFailure(Object.assign(new Error('request too large'), { status: 413 })));
check('plain 400 bad request → NO failover (would fail everywhere)', !isInfraFailure(Object.assign(new Error('bad request'), { status: 400 })));
check('schema/parse error → NO failover', !isInfraFailure(new Error('proposer returned no JSON')));
check('auth error → NO failover', !isInfraFailure(Object.assign(new Error('invalid api key'), { status: 401 })));
check("body mentioning 'quota' without marker → NO failover (FC-020 lesson: match markers, not vibes)", !isInfraFailure(new Error('user quota table missing column')));

console.log('\n— end-to-end loop with a stubbed network (primary 429 → secondary serves) —');
// Real callModel(), real retry/classification/fallback code paths — only the
// network edge is stubbed. No .env is loaded here, so Langfuse is off and no
// stray HTTP leaves the process. capability:'workspace' pins gemini as primary
// (the prompt "ping" carries no classification signal either way, and this
// block is proving the FAILOVER MECHANISM, not which bucket is default).
const realFetch = globalThis.fetch;
const hits: string[] = [];
const stub = (primaryStatus: number) =>
  (async (url: unknown) => {
    const u = String(url);
    // groq is the chain PRIMARY as of 2026-09-04, so it is the one made to fail.
    if (u.includes('api.groq.com')) {
      hits.push('groq');
      return new Response(JSON.stringify({ error: { code: primaryStatus, message: 'stub' } }), { status: primaryStatus });
    }
    // gemini is the SECONDARY and serves the failover.
    if (u.includes('generativelanguage.googleapis.com')) {
      hits.push('gemini');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'pong-from-gemini' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch in smoke: ${u}`);
  }) as typeof fetch;

setEnv({ GEMINI_API_KEY: 'g1', GROQ_API_KEY: 'q1' });
globalThis.fetch = stub(429);
try {
  const t0 = Date.now();
  const res = await callModel({ role: 'execution', prompt: 'ping', capability: 'workspace', traceId: '00000000-0000-0000-0000-000000000001', name: 'failover-smoke' });
  const elapsed = Date.now() - t0;
  check('primary 429 → call served by the secondary', res.text === 'pong-from-gemini', res.text);
  check("fallback used the secondary's OWN default model", res.model === 'gemini-flash-latest', res.model);
  check('the chain was walked in order, primary first', hits.join(',') === 'groq,gemini', hits.join(','));
  check('failed over IMMEDIATELY (no backoff sleeps)', elapsed < 3000, `${elapsed}ms`);
} catch (err) {
  check('primary 429 → call served by the secondary', false, String(err).slice(0, 80));
}

hits.length = 0;
globalThis.fetch = stub(400); // non-infra: must NOT fail over
try {
  await callModel({ role: 'execution', prompt: 'ping', capability: 'workspace', traceId: '00000000-0000-0000-0000-000000000002', name: 'failover-smoke' });
  check('primary 400 → surfaces (no failover)', false, 'call unexpectedly succeeded');
} catch (err) {
  const msg = String(err);
  check('primary 400 → surfaces (no failover)', /groq 400/.test(msg), msg.slice(0, 60));
  check('the secondary was never tried on a non-infra failure', !hits.includes('gemini'), hits.join(','));
}
globalThis.fetch = realFetch;

process.env = saved as NodeJS.ProcessEnv;
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
