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
check("capability 'workspace': gemini first (Workspace/Search/Vision)", names('workspace') === 'gemini,nvidia,groq', names('workspace'));
check("capability 'coding': nvidia first (coding/general chat/OSS reasoning)", names('coding') === 'nvidia,groq,gemini', names('coding'));
check("capability 'fast': groq first (ultra-low-latency/simple)", names('fast') === 'groq,gemini,nvidia', names('fast'));

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
  "no signal at all → 'coding' (the catch-all: general chat routes to NVIDIA per spec)",
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

console.log('\n— end-to-end loop with a stubbed network (Gemini 429 → Groq serves) —');
// Real callModel(), real retry/classification/fallback code paths — only the
// network edge is stubbed. No .env is loaded here, so Langfuse is off and no
// stray HTTP leaves the process. capability:'workspace' pins gemini as primary
// (the prompt "ping" carries no classification signal either way, and this
// block is proving the FAILOVER MECHANISM, not which bucket is default).
const realFetch = globalThis.fetch;
const hits: string[] = [];
const stub = (geminiStatus: number) =>
  (async (url: unknown) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      hits.push('gemini');
      return new Response(JSON.stringify({ error: { code: geminiStatus, message: 'stub' } }), { status: geminiStatus });
    }
    if (u.includes('api.groq.com')) {
      hits.push('groq');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'pong-from-groq' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
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
  check('gemini 429 → call served by groq', res.text === 'pong-from-groq', res.text);
  check("fallback used groq's OWN default model", res.model === 'llama-3.3-70b-versatile', res.model);
  check('gemini was tried first, groq second', hits.join(',') === 'gemini,groq', hits.join(','));
  check('failed over IMMEDIATELY (no backoff sleeps)', elapsed < 3000, `${elapsed}ms`);
} catch (err) {
  check('gemini 429 → call served by groq', false, String(err).slice(0, 80));
}

hits.length = 0;
globalThis.fetch = stub(400); // non-infra: must NOT fail over
try {
  await callModel({ role: 'execution', prompt: 'ping', capability: 'workspace', traceId: '00000000-0000-0000-0000-000000000002', name: 'failover-smoke' });
  check('gemini 400 → surfaces (no failover)', false, 'call unexpectedly succeeded');
} catch (err) {
  const msg = String(err);
  check('gemini 400 → surfaces (no failover)', /gemini 400/.test(msg), msg.slice(0, 60));
  check('groq was never tried on a non-infra failure', !hits.includes('groq'), hits.join(','));
}
globalThis.fetch = realFetch;

process.env = saved as NodeJS.ProcessEnv;
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
