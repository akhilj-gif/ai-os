// Turn-cost and turn-honesty smoke. Pure: no DB, no network, no model quota.
//   tsx packages/kernel/src/turn-budget-smoke.ts
//
// WHY. Measured 2026-09-26 with scripts/measure-turn.ts, the literal message
// "hi" assembled ~6,700 input tokens against Groq's 7,000-per-minute ceiling,
// so every chat turn was rejected 413, fell through to an exhausted Gemini, and
// returned an error after ~60 seconds. The largest single slice was not tools:
// it was 2,632 tokens of pack instructions — all 15 packs explaining cabs,
// Gmail and X — shipped before the user had said anything.
//
// Two things are pinned here. That the prompt stays SMALL (selectPackGuides),
// and that when a turn does fail the user is told something TRUE
// (humanizeFailure). The second matters as much as the first: the old 413
// message said the problem "usually clears within a minute, so please try
// again", which is precisely wrong for a request that is simply too big.
import { selectPackGuides, selectTools, HISTORY_SLOTS, type PackGuide } from './tool-select.js';
import { humanizeFailure } from './executor.js';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

const GUIDES: PackGuide[] = [
  { name: 'google', tools: ['gmail_list', 'gmail_read', 'calendar_create_event'], prompt: 'Gmail and Calendar are connected. Drafts are never sent automatically.' },
  { name: 'mobility', tools: ['mobility_book', 'mobility_quote'], prompt: 'Cabs can be booked. Always confirm the fare first.' },
  { name: 'x', tools: ['x_publish_post'], prompt: 'Posting to X is irreversible and always needs approval.' },
];

console.log('— guidance follows its tools, in both directions —');
check('no tools selected -> no pack guidance at all', selectPackGuides(GUIDES, []) === '');
// The whole saving: a conversational turn selects no pack tool, so it pays nothing.
check('a plain chat turn pays 0 tokens of pack guidance', selectPackGuides(GUIDES, ['memory_search', 'web_search', 'time_now']) === '');

const oneTool = selectPackGuides(GUIDES, ['gmail_list']);
check('one tool selected -> that pack guidance appears', /Gmail and Calendar/.test(oneTool), oneTool.slice(0, 40));
check('...and ONLY that pack', !/Cabs|Posting to X/.test(oneTool));
check('...tagged with the pack name so the model can attribute it', oneTool.startsWith('[google]'), oneTool.slice(0, 12));

const two = selectPackGuides(GUIDES, ['gmail_read', 'x_publish_post']);
check('two packs -> both, and nothing else', /Gmail/.test(two) && /Posting to X/.test(two) && !/Cabs/.test(two));
check('...stable order (not selection order)', two.indexOf('[google]') < two.indexOf('[x]'));

// THE INVARIANT. A tool offered without its instructions loses the rules that
// make it correct — e.g. that calendar_create_event is approval-queued, which
// the model must tell the user. A guide shipped without its tool is pure waste.
for (const g of GUIDES) {
  for (const t of g.tools) {
    check(`"${t}" always brings [${g.name}] with it`, selectPackGuides(GUIDES, [t]).includes(g.prompt));
  }
}
check('an unknown tool name matches nothing (no accidental catch-all)', selectPackGuides(GUIDES, ['not_a_real_tool']) === '');
check('a pack with an empty prompt is skipped', selectPackGuides([{ name: 'p', tools: ['t'], prompt: '' }], ['t']) === '');

console.log('\n— a failed turn must tell the truth about WHY —');
const TOO_BIG =
  'INFRA_RATELIMIT 413 (groq): {"error":{"message":"Request too large for model `qwen/qwen3.8-27b` on input tokens per minute (ITPM): Limit 7000, Requested 7267, please reduce your message size"}}';
const big = humanizeFailure(TOO_BIG);
// The regression: this string ALSO matches /INFRA_RATELIMIT|rate.?limit/, so if
// the 413 branch is ever moved below the generic one, the user is told to wait
// and retry a request that cannot ever succeed.
check('a 413 is NOT reported as a transient rate limit', !/clears within a minute/.test(big), big.slice(0, 60));
check('...it says retrying will not help', /not help/i.test(big));
check('...it quotes the provider\'s real numbers', /7267/.test(big) && /7000/.test(big), big.slice(-90));
check('...and suggests something that actually works', /new chat|history/i.test(big));

const rateLimited = humanizeFailure('INFRA_RATELIMIT 429 (groq): Rate limit reached. Please try again in 28s');
check('a genuine 429 still says "try again"', /try again/i.test(rateLimited), rateLimited.slice(0, 50));
check('...and is NOT mistaken for a too-large request', !/too large/i.test(rateLimited));

check('a network error stays a network error', /network/i.test(humanizeFailure('INFRA_NETWORK: fetch failed')));
// Never a 500-char JSON blob in the chat window.
const unknown = humanizeFailure('{"error":{"message":"' + 'x'.repeat(900) + '"}}');
check('an unrecognised failure is trimmed, not dumped raw', unknown.length < 240, `${unknown.length} chars`);

console.log('');
console.log('- the CURRENT message decides what a turn pays for -');
// 20 tools so the cap actually engages (selectTools returns everything below it).
const TOOLS = [
  ...['tools_expand', 'memory_search', 'memory_write', 'web_search', 'fetch_url', 'time_now'].map((name) => ({ name, description: 'core' })),
  { name: 'mobility_book', description: 'Book a cab ride' },
  { name: 'mobility_quote', description: 'Quote a cab fare' },
  { name: 'whatsapp_send_message', description: 'Send a whatsapp message' },
  { name: 'gmail_list', description: 'List gmail messages' },
  { name: 'x_publish_post', description: 'Publish a post to X' },
  { name: 'calendar_list', description: 'List calendar events' },
  ...Array.from({ length: 10 }, (_, i) => ({ name: 'filler_' + i, description: 'unrelated capability ' + i })),
];
const CHATTY = 'please book a cab to the airport and send a whatsapp about the gmail thread';

// THE REGRESSION. History used to be concatenated with the message and scored
// identically, so 'hi' inherited every tool the last four messages mentioned:
// measured live, 15 tools / 2,048 tokens for a two-letter greeting.
const greet = selectTools(TOOLS, 'hi', 14, CHATTY);
check('a greeting after a busy conversation does not drag the whole toolkit along', greet.selected.length <= 6 + HISTORY_SLOTS, greet.selected.length + ' tools');
check('...core tools are always there', greet.selected.some((t) => t.name === 'memory_search'));
check('...and whatever is dropped stays reachable via tools_expand', greet.omitted.length > 0 && greet.selected.some((t) => t.name === 'tools_expand'));

const ask = selectTools(TOOLS, 'send a whatsapp message to mom', 14, '');
check('a real request still selects its tool', ask.selected.some((t) => t.name === 'whatsapp_send_message'));
check('...without unrelated ones', !ask.selected.some((t) => t.name === 'x_publish_post'), ask.selected.map((t) => t.name).join(','));

// Continuation must survive: 'do it' only makes sense via the previous turn.
const followUp = selectTools(TOOLS, 'yes do it', 14, 'can you book a cab with mobility_book');
check('a follow-up still reaches the tool the last turn named', followUp.selected.some((t) => t.name === 'mobility_book'), followUp.selected.map((t) => t.name).join(','));
check('...but carries at most ' + HISTORY_SLOTS + ' tools from history', followUp.selected.length <= 6 + HISTORY_SLOTS, followUp.selected.length + ' tools');

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
