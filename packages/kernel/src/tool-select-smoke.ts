// Per-turn tool selection. Run: tsx packages/kernel/src/tool-select-smoke.ts
//
// WHY. Shipping all 50 tool schemas (5,830 tok) pushed the chat prompt to ~10,965
// and over Groq's 7,000 input-tokens-per-minute ceiling, so the FAST provider
// 413'd on every call and every turn fell through to a quota-exhausted Gemini.
// Measured end to end before the fix: "what is 2+2?" took 166,945ms.
//
// The risk being guarded here is not size, it is SILENT CAPABILITY LOSS — a
// keyword filter that hides the tool the user needed, with no error. So these
// assertions are mostly about what must NEVER be dropped.
import { selectTools, omittedToolsNote, CORE_TOOLS } from './tool-select.js';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

const t = (name: string, description: string) => ({ name, description });
const CATALOG = [
  ...CORE_TOOLS.map((n) => t(n, `core tool ${n}`)),
  t('whatsapp_send_message', 'Send a WhatsApp message to a chat.'),
  t('whatsapp_search_contacts', 'Find a WhatsApp contact by name.'),
  t('calendar_create_event', 'Create a calendar event at a time.'),
  t('calendar_list', 'List upcoming calendar events.'),
  t('gmail_read', 'Read email messages from Gmail.'),
  t('gmail_send', 'Send an email through Gmail.'),
  t('video_analyze', 'Analyze and summarize a long video from a file or URL.'),
  t('mobility_estimate', 'Estimate a cab fare for a ride between two places.'),
  t('terminal_exec', 'Run a shell command on the machine.'),
  t('code_exec', 'Execute code in a sandbox.'),
  t('browser_act', 'Click or type on the current web page.'),
  t('browser_find', 'Find an element on the current web page.'),
  t('files_write', 'Write a file to disk.'),
  t('files_read', 'Read a file from disk.'),
  t('x_post', 'Post a tweet to X.'),
];

const names = (s: { selected: Array<{ name: string }> }) => s.selected.map((x) => x.name);

// --- the point of the exercise: it actually gets smaller ---------------------
const trivial = selectTools(CATALOG, 'what is 2+2?');
check('a trivial turn is capped well under the full catalog', trivial.selected.length <= 14, `${trivial.selected.length}/${CATALOG.length} offered`);
check('...and the rest are reported as omitted, not vanished', trivial.omitted.length === CATALOG.length - trivial.selected.length, `${trivial.omitted.length} omitted`);

// --- core tools are never dropped -------------------------------------------
for (const c of CORE_TOOLS) check(`core tool "${c}" survives an unrelated turn`, names(trivial).includes(c));

// --- the relevant tool must be present when the user clearly asks for it ----
for (const [turn, want] of [
  ['send a whatsapp to mom saying hi', 'whatsapp_send_message'],
  ['what meetings do I have on my calendar tomorrow', 'calendar_list'],
  ['read my latest email from gmail', 'gmail_read'],
  ['summarize this video for me', 'video_analyze'],
  ['how much would a cab ride to the airport cost', 'mobility_estimate'],
  ['post this to x', 'x_post'],
] as const) {
  check(`"${turn.slice(0, 34)}…" offers ${want}`, names(selectTools(CATALOG, turn)).includes(want), names(selectTools(CATALOG, turn)).join(',').slice(0, 70));
}

// --- a small catalog must not be filtered at all ----------------------------
const small = CATALOG.slice(0, 8);
check('a catalog already under the cap is passed through untouched', selectTools(small, 'anything').selected.length === small.length && selectTools(small, 'x').omitted.length === 0);

// --- the discoverability note is what prevents silent loss ------------------
const note = omittedToolsNote(trivial.omitted);
check('the omitted note names every omitted tool', trivial.omitted.every((n) => note.includes(n)));
check('...and tells the model how to load one', /tools_expand/.test(note));
check('an empty omitted list produces NO note (nothing to say)', omittedToolsNote([]) === '');

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
