// Per-turn tool selection.
//
// WHY THIS EXISTS. The chat path shipped ALL 50 tool definitions on every turn —
// 5,830 tokens of catalog, ~10,965 tokens of total prompt. That is not a latency
// problem (measured: Groq answers a 4,839-token prompt in 0.74s, the same as a
// 35-token one). It is an ADMISSION problem:
//
//   INFRA_RATELIMIT 413 (groq): Request too large for qwen/qwen3.8-27b on input
//   tokens per minute (ITPM): Limit 7000, Requested 10965
//
// So the fast provider refused EVERY chat call, the request fell through to a
// quota-exhausted Gemini, and the retry ladder turned "what is 2+2?" into 167
// seconds. Cutting the catalog is what buys admission to the fast path.
//
// Compression alone could not get there: dropping nested schema descriptions
// saves 1,009 tok and additionally truncating every description to 160 chars
// reaches 3,661 — still over budget, and it degrades tool-use quality for all 50
// tools at once. Selecting fewer tools and keeping their schemas INTACT is both
// smaller and better: the tools that are offered are described in full.
//
// THE SILENT-CAPABILITY-LOSS TRAP. Naive keyword filtering hides a tool the user
// actually needed and the OS just... can't do it, with no error. That is the bug
// class this codebase keeps paying for, so it is designed out rather than hoped
// away: every omitted tool's NAME is still listed for the model (names cost 165
// tok for all 50), and `tools_expand` pulls any of them back with full schema
// mid-run. Filtering therefore delays a tool by one iteration at worst; it never
// removes a capability.
// Structural, not ToolDef: registry.list() hands back ToolSchema (name +
// description + inputSchema, no execute), and selection only ever reads those.
// Typing to the fields actually used keeps this usable from both shapes.
interface Selectable {
  name: string;
  description?: string;
}

/** Always offered in chat: the tools an ordinary turn reaches for regardless of
 *  wording, plus the escape hatch. Kept deliberately short — every entry here is
 *  paid for on every single turn. */
export const CORE_TOOLS = ['tools_expand', 'memory_search', 'memory_write', 'web_search', 'fetch_url', 'time_now'];

const STOP = new Set([
  'the','a','an','and','or','but','if','then','of','to','in','on','for','with','my','me','i','you','is','are','was','were',
  'do','does','did','can','could','would','should','what','which','who','when','where','how','why','this','that','these',
  'those','it','its','be','been','being','have','has','had','from','by','at','as','not','no','yes','please','just','get',
]);

const words = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));

/** Score a tool against the turn's text by token overlap. Name matches count
 *  double — "send a whatsapp" should surface whatsapp_send_message ahead of a
 *  tool that merely mentions whatsapp in prose. */
function score(tool: Selectable, turn: Set<string>): number {
  let n = 0;
  for (const w of words(tool.name)) if (turn.has(w)) n += 2;
  for (const w of new Set(words(tool.description ?? ''))) if (turn.has(w)) n += 1;
  return n;
}

export interface ToolSelection<T extends Selectable = Selectable> {
  selected: T[];
  /** Names the model can pull in with tools_expand. */
  omitted: string[];
}

/**
 * Pick the tools worth paying for this turn.
 * @param text  the user's message plus any recent history worth matching against
 * @param cap   max tools to offer; the whole point is to stay under the provider's
 *              input budget, so this is a ceiling, not a target
 */
export function selectTools<T extends Selectable>(defs: T[], text: string, cap = 14): ToolSelection<T> {
  // Nothing to gain below the cap — offer everything and skip the guesswork.
  if (defs.length <= cap) return { selected: defs, omitted: [] };

  const turn = new Set(words(text));
  const core = new Set(CORE_TOOLS);
  const chosen = new Map<string, T>();

  for (const d of defs) if (core.has(d.name)) chosen.set(d.name, d);

  const ranked = defs
    .filter((d) => !chosen.has(d.name))
    .map((d) => ({ d, s: score(d, turn) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  for (const { d } of ranked) {
    if (chosen.size >= cap) break;
    chosen.set(d.name, d);
  }

  const selected = defs.filter((d) => chosen.has(d.name));
  return { selected, omitted: defs.filter((d) => !chosen.has(d.name)).map((d) => d.name) };
}

/** The line appended to the system prompt so omitted tools stay DISCOVERABLE.
 *  Without this, filtering silently removes capability. */
export function omittedToolsNote(omitted: string[]): string {
  if (omitted.length === 0) return '';
  return (
    `OTHER TOOLS AVAILABLE ON REQUEST (${omitted.length}): ${omitted.join(', ')}.\n` +
    `Their full schemas are not loaded right now to keep this request small. If one of them is the right tool for what the user asked, ` +
    `call tools_expand with a short query (e.g. tools_expand({"query":"whatsapp"})) and it will be loaded so you can call it on the next step. ` +
    `Never invent arguments for a tool whose schema you have not loaded.`
  );
}
