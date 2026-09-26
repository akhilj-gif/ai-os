// Cross-provider tool-call history smoke. Pure: no network, no keys.
//   tsx packages/model-router/src/signature-smoke.ts
//
// THE BUG. Gemini's thinking models strictly validate a thought signature on
// every function call in the CURRENT turn (Google: "Only current turn is
// required"), and this router fails over MID-turn. Iteration 1 served by Groq
// produced an unsigned call; Groq then rate-limited; iteration 2 went to
// Gemini, which answered
//   400 "Function call is missing a thought_signature in functionCall parts"
// and the whole tool-using turn died. Observed live 2026-09-27 on the first
// markets-pack request ("what is the price of reliance right now?"). On a free
// Groq tier that rate-limits within a minute, that is the common path.
import { adaptToolCalls, sanitizeMessages, GEMINI_SKIP_SIGNATURE, type ChatMessage } from './index.js';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const call = (id: string, sig?: string): NonNullable<ChatMessage['tool_calls']>[number] => ({
  id,
  type: 'function',
  function: { name: 'market_quote', arguments: '{"symbol":"RELIANCE"}' },
  ...(sig ? { extra_content: { google: { thought_signature: sig } } } : {}),
});
const sigOf = (c: NonNullable<ChatMessage['tool_calls']>[number] | undefined): string | undefined => c?.extra_content?.google?.thought_signature;

console.log('— a call made by Groq, replayed to Gemini —');
const fromGroq = adaptToolCalls([call('a')], 'gemini');
check('an unsigned call gets Google\'s documented placeholder', sigOf(fromGroq[0]) === GEMINI_SKIP_SIGNATURE, sigOf(fromGroq[0]));
check('...the placeholder is the exact documented string', GEMINI_SKIP_SIGNATURE === 'skip_thought_signature_validator');
const parallel = adaptToolCalls([call('a'), call('b')], 'gemini');
// Gemini signs only the FIRST of parallel calls; mirror that exactly.
check('parallel calls: only the first is signed', !!sigOf(parallel[0]) && !sigOf(parallel[1]));

console.log('\n— a call Gemini signed itself —');
const own = adaptToolCalls([call('a', 'REAL-SIG-FROM-GEMINI'), call('b')], 'gemini');
// Overwriting a real signature with the placeholder would throw away the
// model's reasoning state for the turn — it must pass through untouched.
check('a real signature is passed back UNCHANGED', sigOf(own[0]) === 'REAL-SIG-FROM-GEMINI', sigOf(own[0]));
check('...and nothing is added to its siblings', !sigOf(own[1]));

console.log('\n— a Gemini call replayed to Groq —');
const toGroq = adaptToolCalls([call('a', 'REAL-SIG-FROM-GEMINI')], 'groq');
// Groq has already 400'd on one foreign field ("property 'reasoning_content'
// is unsupported", in steps.error). Gemini's field must not leak either way.
check('Gemini\'s extra_content is stripped for other providers', !('extra_content' in toGroq[0]!), JSON.stringify(toGroq[0]));
check('...and the call itself is intact', toGroq[0]!.function.name === 'market_quote' && toGroq[0]!.id === 'a');

console.log('\n— through sanitizeMessages, as the request is actually built —');
const history: ChatMessage[] = [
  { role: 'user', content: 'what is the price of reliance?' },
  { role: 'assistant', content: null, tool_calls: [call('a')] },
  { role: 'tool', content: '{"price":1226}', tool_call_id: 'a' },
];
const toGemini = sanitizeMessages(history, 'gemini');
check('the unsigned history is made valid for Gemini', sigOf(toGemini[1]!.tool_calls?.[0]) === GEMINI_SKIP_SIGNATURE);
check('...a null assistant content is still allowed alongside tool_calls', toGemini[1]!.content === null);
check('...the tool result is untouched', toGemini[2]!.tool_call_id === 'a' && toGemini[2]!.content === '{"price":1226}');
check('...and the caller\'s history is NOT mutated', history[1]!.tool_calls?.[0]?.extra_content === undefined);
const plain = sanitizeMessages([{ role: 'user', content: 'hi' }], 'groq');
check('messages without tool calls are unaffected', JSON.stringify(plain) === '[{"role":"user","content":"hi"}]', JSON.stringify(plain));

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
