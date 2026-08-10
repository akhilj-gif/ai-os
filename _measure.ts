import { systemPrompt } from './packages/kernel/src/prompts.js';
import { composeRegistry, packPrompts, CORE_TOOLS, PACKS } from './packages/packs/src/index.js';

const tok = (s: string) => Math.ceil(s.length / 4);

const enabled = new Set(['browser','coding','computer','google','memory','mobility','projects','research','support-ops','video','whatsapp','x']);
const reg = composeRegistry(enabled);
const tools = reg.list();

// This is how the model-router serialises tools (OpenAI shape) — check index.ts
const wire = tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));
const wireJson = JSON.stringify(wire);

const sp = systemPrompt();
const pp = packPrompts(enabled);

console.log('TOOL COUNT:', tools.length);
console.log('systemPrompt chars/tokens:', sp.length, tok(sp));
console.log('packPrompts chars/tokens:', pp.length, tok(pp));
console.log('tool schema JSON chars/tokens:', wireJson.length, tok(wireJson));
console.log('TOTAL FIXED OVERHEAD tokens:', tok(sp) + tok(pp) + tok(wireJson));
console.log('CONTEXT_TOKEN_BUDGET default:', 6400);
console.log('');
console.log('--- per-pack prompt tokens ---');
for (const name of [...enabled].sort()) {
  const p = PACKS[name];
  if (p?.prompt) console.log(String(tok(`[${p.name}] ${p.prompt}`)).padStart(5), name);
}
console.log('');
console.log('--- per-tool wire tokens (desc + schema), desc len ---');
const rows = tools.map((t) => {
  const one = JSON.stringify({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } });
  return { name: t.name, tokens: tok(one), descLen: (t.description ?? '').length };
}).sort((a, b) => b.tokens - a.tokens);
for (const r of rows) console.log(String(r.tokens).padStart(5), String(r.descLen).padStart(5), r.name);
console.log('');
console.log('tool names:', tools.map(t=>t.name).join(' '));
