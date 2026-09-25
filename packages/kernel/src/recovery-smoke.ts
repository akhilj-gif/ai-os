// Recovery policy smoke — pure, no DB, no network, no model.
//   tsx packages/kernel/src/recovery-smoke.ts
//
// Two different jobs here. Most checks pin that transient failures DO recover,
// because that is the behaviour being added. The ones marked SAFETY pin that
// certain failures never recover — a trust refusal and a half-applied mutating
// call. Those matter more: a retry loop is the classic way a security control
// gets worn down, and this file is what stops "make it more resilient" from
// quietly turning into "retry until the gate gives up".
import {
  planRecovery,
  parseRetryAfterMs,
  isTrustRefusal,
  MAX_INLINE_RETRIES,
  MAX_TOTAL_RETRIES,
  INLINE_WAIT_CEILING_MS,
} from './recovery.js';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const NOW = new Date('2026-09-19T12:00:00Z');
const at = (o: Partial<Parameters<typeof planRecovery>[0]>) =>
  planRecovery({ error: '', kind: 'reason', mutating: false, retries: 0, replanned: false, now: NOW, ...o });

// Verbatim bodies from the live steps table — not invented samples.
const GROQ_TPD =
  'INFRA_RATELIMIT 429 (groq): {"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01kw` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199005, Requested 3118. Please try again in 15m17.136s. Need more tokens?","type":"tokens","code":"rate_limit_exceeded"}}';
const GROQ_TPM = 'INFRA_RATELIMIT 429 (groq): {"error":{"message":"Rate limit reached ... Please try again in 8.5s","code":"rate_limit_exceeded"}}';
const GEMINI_429 = 'INFRA_RATELIMIT 429 (gemini): [{"error":{"code":429,"message":"You exceeded your current quota","details":[{"retryDelay":"42s"}]}}]';
const TIMEOUT = 'INFRA_NETWORK: gemini/gemini-flash-latest exceeded its 60000ms budget — abandoning this provider so the chain can fail over';
const REFUSAL =
  'Refused by the trust gate: untrusted content is in this task\'s context, so a "write" (mutating) action cannot be triggered by it (§8.3).';

console.log('— reading the provider\'s own advice —');
check('Groq "15m17.136s" is parsed', parseRetryAfterMs(GROQ_TPD) === 917136, String(parseRetryAfterMs(GROQ_TPD)));
check('Groq "8.5s" is parsed', parseRetryAfterMs(GROQ_TPM) === 8500, String(parseRetryAfterMs(GROQ_TPM)));
check('Gemini retryDelay "42s" is parsed', parseRetryAfterMs(GEMINI_429) === 42000, String(parseRetryAfterMs(GEMINI_429)));
// "500ms" must not read as 500 SECONDS — the units alternation order decides this.
check('"500ms" is half a second, not eight minutes', parseRetryAfterMs('retry-after: 500ms') === 500, String(parseRetryAfterMs('retry-after: 500ms')));
check('an error with no advice yields 0, not NaN', parseRetryAfterMs('fetch failed') === 0, String(parseRetryAfterMs('fetch failed')));

console.log('\n— SAFETY: what must never be retried —');
check('a trust refusal is recognised', isTrustRefusal(REFUSAL));
const ref = at({ error: REFUSAL, kind: 'tool', mutating: true });
check('a trust refusal is FATAL, never retried or parked', ref.action === 'fatal', ref.action);
// The dangerous phrasing of the same bug: a refusal that also smells transient.
const refPlusRate = at({ error: REFUSAL + ' INFRA_RATELIMIT 429', kind: 'tool', mutating: true });
check('...even when the text also contains a rate-limit marker', refPlusRate.action === 'fatal', refPlusRate.action);
const mut = at({ error: 'gmail 400: bad recipient', kind: 'tool', mutating: true });
check('a mutating tool failing non-transiently is NOT re-fired', mut.action === 'fatal', mut.action);
check('...and says why (the side effect may already have landed)', /side effect/.test(mut.why));
// THE ORDERING TEST. A send that throws `fetch failed` may have delivered the
// message and lost the response. If the transient branch is ever moved above
// the mutating branch, this is the check that fails — and the bug it catches
// is a double-sent WhatsApp message, not a slow task.
const mutFlaky = at({ error: 'fetch failed', kind: 'tool', mutating: true });
check('a mutating tool is not retried even when the error LOOKS transient', mutFlaky.action === 'fatal', mutFlaky.action);
const mutRate = at({ error: 'INFRA_RATELIMIT 429 (groq): slow down. Please try again in 2s', kind: 'tool', mutating: true });
check('...not even on an explicit rate limit with a short wait', mutRate.action === 'fatal', mutRate.action);
// The same error on a READ tool is safe to retry — that is the distinction.
const readFlaky = at({ error: 'fetch failed', kind: 'tool', mutating: false });
check('a READ tool with the same error DOES retry', readFlaky.action === 'retry', readFlaky.action);

console.log('\n— transient failures recover —');
const short = at({ error: GROQ_TPM });
check('a short wait retries inline', short.action === 'retry', short.action);
check('...using the provider\'s number, not a guess', short.action === 'retry' && short.waitMs === 8500, JSON.stringify(short));
const long = at({ error: GROQ_TPD });
check('a 15-minute day-quota PARKS instead of blocking a worker', long.action === 'park', long.action);
check('...scheduled for when the provider said', long.action === 'park' && long.retryAt.getTime() === NOW.getTime() + 917136, long.action === 'park' ? long.retryAt.toISOString() : '');
const to = at({ error: TIMEOUT });
check('a provider timeout retries', to.action === 'retry', to.action);
check('...with a backoff, since no advice was given', to.action === 'retry' && to.waitMs > 0 && to.waitMs <= INLINE_WAIT_CEILING_MS, JSON.stringify(to));
check('a bare "fetch failed" still recovers', at({ error: 'fetch failed' }).action === 'retry');
// REGRESSION. graph.ts prefixes a failed tool call with its tool name, and
// isInfraFailure's regex is anchored (`/^INFRA_/`), so the prefix silently
// stopped it matching — a 15-minute quota park became a hard failure. It fails
// invisibly: the text still SAYS rate limit, the code just stops seeing it.
const wrapped = at({ error: `probe_read: ${GROQ_TPD}` });
check('a WRAPPED rate limit is still recognised (anchoring regression)', wrapped.action === 'park', wrapped.action);
check('...and still reads the wrapped wait time', wrapped.action === 'park' && wrapped.retryAt.getTime() === NOW.getTime() + 917136);
// Untagged provider errors: 31 rows on the live DB read `gemini 429: ...` with
// no INFRA_ marker, because they never went through the router's failover path.
check('an untagged "gemini 429" is transient', at({ error: 'gemini 429: [{"error":{"code":429}}]' }).action !== 'fatal');
check('a 503 is transient', at({ error: 'gemini 503: high demand' }).action !== 'fatal');
// ...but a plain wrong-answer error must NOT be mistaken for transient, or
// every genuine bug would be retried six times before anyone heard about it.
check('a genuine logic error is NOT treated as transient', at({ error: 'unknown tool: sendcarrierpigeon' }).action === 'replan');

console.log('\n— escalation: inline, then parked, then honest —');
check(`attempt ${MAX_INLINE_RETRIES} stops retrying inline and parks`, at({ error: TIMEOUT, retries: MAX_INLINE_RETRIES }).action === 'park');
check(`attempt ${MAX_TOTAL_RETRIES} gives up`, at({ error: TIMEOUT, retries: MAX_TOTAL_RETRIES }).action === 'fatal');
check('...and admits it rather than pretending success', /gave up after/.test(at({ error: TIMEOUT, retries: MAX_TOTAL_RETRIES }).why));
// Backoff must actually grow, or "retry" is just hammering the thing that is already overloaded.
const b0 = at({ error: TIMEOUT, retries: 0 });
const b1 = at({ error: TIMEOUT, retries: 1 });
check('backoff grows between attempts', b0.action === 'retry' && b1.action === 'retry' && b1.waitMs > b0.waitMs, `${b0.action === 'retry' ? b0.waitMs : '?'} -> ${b1.action === 'retry' ? b1.waitMs : '?'}`);

console.log('\n— a wrong PLAN is adapted to, not retried —');
const bad = at({ error: 'unknown tool: sendcarrierpigeon' });
check('a non-transient reason failure replans', bad.action === 'replan', bad.action);
check('...but only once, then it is fatal', at({ error: 'unknown tool: x', replanned: true }).action === 'fatal');
// Replanning is a full planner call; on an 8k-tokens/min tier an unbounded
// replan loop would eat the very budget the retry is waiting for.
check('...and the cap is explained, not arbitrary', /replanned once/.test(at({ error: 'x', replanned: true }).why));

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
