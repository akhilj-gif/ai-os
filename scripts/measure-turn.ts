// What does ONE chat turn actually cost? Run: tsx scripts/measure-turn.ts ["your message"]
//
// Not a smoke test — a measuring instrument. Groq's free tier admits 7,000 input
// tokens per minute, and the live API was rejecting the literal message "hi"
// with `413 Request too large ... Requested 7267`. Something in the assembled
// turn is enormous and it is not the user's message; this prints the breakdown
// so the cut is aimed at the real bulk instead of the suspected one.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

import pg from 'pg';
import { composeRegistry, packPrompts, packGuides, loadEnabledPacks } from '../packages/packs/src/index.js';
import { systemPrompt } from '../packages/kernel/src/prompts.js';
import { assembleMemoryContext } from '../packages/kernel/src/context.js';
import { selectTools, omittedToolsNote, selectPackGuides } from '../packages/kernel/src/tool-select.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const goal = process.argv[2] ?? 'hi';

// ~4 chars/token is the usual English approximation and is close enough to
// reason about a 7,000-token ceiling; the provider's own count is the arbiter,
// and its 413 told us the real figure was ~7,267.
const chr10 = String.fromCharCode(10);
const tok = (s: string): number => Math.ceil(s.length / 4);
const rows: Array<[string, number, string]> = [];
const add = (label: string, text: string, note = ''): void => void rows.push([label, tok(text), note]);

// The live API composes its registry and system prompt from the ENABLED packs
// (server.ts packRegistry/packPrompt). Measuring buildRegistry() instead
// understates both, which is how a 2,351-token estimate coexisted with Groq
// reporting 7,267 for the same turn.
const enabled = await loadEnabledPacks(pool);
const sys = systemPrompt();
add('system prompt', sys);

let memBlock = '';
try {
  memBlock = (await assembleMemoryContext(pool, { goal })).block;
} catch (e) {
  console.log('(memory context failed:', e instanceof Error ? e.message : String(e), ')');
}
add('memory context', memBlock, `${memBlock.split('\n').length} lines`);

// Recent session history, exactly as the chat route supplies it.
const { rows: hist } = await pool.query<{ role: string; content: string }>(
  `SELECT role, content FROM messages WHERE session_id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)
   ORDER BY created_at DESC LIMIT 12`,
);
add('history (last 12 msgs)', hist.map((h) => `${h.role}: ${h.content}`).join('\n'), `${hist.length} messages`);

const registry = composeRegistry(enabled);
const full = registry.list();
const sel = selectTools(full, goal);
const selJson = JSON.stringify(sel.selected.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })));
add('tool schemas (selected)', selJson, `${sel.selected.length} of ${full.length} tools`);
const note = omittedToolsNote(sel.omitted);
add('omitted-tool names', note, `${sel.omitted.length} names`);
// The live path now ships only the guides whose tools were selected.
const guides = packGuides(enabled);
const shipped = selectPackGuides(guides, sel.selected.map((t) => t.name));
add('pack guides (selected)', shipped, `${shipped ? shipped.split(chr10).length : 0} of ${guides.length} packs`);
add('[was] ALL pack prompts', packPrompts(enabled), 'before this change — for comparison only');

const total = rows.reduce((a, [, t]) => a + t, 0);
const w = Math.max(...rows.map(([l]) => l.length));
console.log(`\nONE TURN, message = ${JSON.stringify(goal)} (${tok(goal)} tok)\n`);
for (const [label, t, note2] of rows.sort((a, b) => b[1] - a[1])) {
  const pct = total ? Math.round((t / total) * 100) : 0;
  const bar = '█'.repeat(Math.round(pct / 2));
  console.log(`  ${label.padEnd(w)}  ${String(t).padStart(6)} tok  ${String(pct).padStart(3)}%  ${bar} ${note2}`);
}
console.log(`  ${'TOTAL'.padEnd(w)}  ${String(total).padStart(6)} tok`);
console.log(`\n  Groq free-tier ITPM ceiling: 7,000 — ${total > 7000 ? `OVER by ${total - 7000}: every turn is rejected 413 before it is even read` : `under by ${7000 - total}`}`);

// The single biggest tool, since one bloated schema can dominate the catalog.
const bySize = sel.selected
  .map((t) => ({ name: t.name, tokens: tok(JSON.stringify({ description: t.description, parameters: t.inputSchema })) }))
  .sort((a, b) => b.tokens - a.tokens);
console.log(`\n  largest selected tools: ${bySize.slice(0, 6).map((t) => `${t.name} ${t.tokens}`).join(', ')}`);

await pool.end();
