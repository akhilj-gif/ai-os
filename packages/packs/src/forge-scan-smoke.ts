// Deterministic security smoke for the Pack Forge static gate — NO DB, NO model,
// NO network. Run: tsx packages/packs/src/forge-scan-smoke.ts
//
// WHY THIS FILE EXISTS. Pack Forge lets the OS write its OWN capability packs at
// runtime: a model emits TypeScript, it lands in packs-dynamic/, a human reviews
// the source and approves the install. The model that writes that source can be
// prompt-injected, so generated source is ATTACKER-CONTROLLED and the gate in
// front of it is a genuine security boundary.
//
// On 2026-08-13 that gate was defeated. It required the module to be "exactly
// one `export default { … }` with nothing outside it" and blocklisted keywords —
// which silently assumes an object literal is inert DATA. It is not. A literal
// runs arbitrary code at CONSTRUCTION (computed keys, expressions in value
// position, template interpolation, spread, IIFEs) and at PROPERTY-READ time
// (getters). All six vectors passed the scan with zero violations AND executed,
// via listStagedPacks() — the pre-approval, "read-only" path that rendered the
// review UI. `fetch` is an allowed global, so that was a working exfiltration
// primitive triggered by merely LISTING staged packs.
//
// The fix was structural: read the manifest from the SYNTAX TREE instead of
// importing the file, behind a real allowlist (every value a plain literal;
// executable code only under `execute`). Each vector below is pinned so it can
// never silently come back — and the last section proves the legitimate path
// still works, because a gate that blocks everything is not a gate.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'aios-forge-scan-smoke-'));
process.env.AIOS_DYNAMIC_PACKS_DIR = dir;

const { scanPackSource, extractManifestFromSource, listStagedPacks, loadDynamicPack, stagePack, DYNAMIC } = await import('./dynamic.js');

let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

// A tripwire reachable as a BARE global name, so no payload below needs any
// FORBIDDEN keyword (no globalThis/process/eval) to prove it ran.
const PWNED: string[] = [];
(globalThis as unknown as { __pwn: (w: string) => boolean }).__pwn = (w) => {
  PWNED.push(w);
  return true;
};

const GOOD = `export default {
  name: 'scansmoke-echo',
  version: '0.1.0',
  description: 'deterministic echo pack',
  prompt: 'Use scansmoke-echo_shout.',
  requires: [],
  tools: [
    {
      name: 'scansmoke-echo_shout',
      description: 'Upper-case the given text.',
      trustClass: 'read',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute(args: Record<string, unknown>): Promise<unknown> {
        return { shouted: String(args.text ?? '').toUpperCase() };
      },
    },
  ],
};
`;

const T = `{ name: 'p_go', description: 'd', inputSchema: { type: 'object' }, async execute() { return {}; } }`;

// --- 1. code-execution vectors that must ALL be rejected -------------------
// Every one keeps its code strictly INSIDE the object literal and uses no
// blocklisted keyword — i.e. exactly what the old text-based gate could not see.
const EXEC_VECTORS: Array<[string, string]> = [
  ['getter (runs on every property READ)', `export default { get name() { __pwn('g'); return 'p'; }, version: '1.0.0', description: 'd', tools: [${T}] };`],
  ['computed property key', `export default { [__pwn('c') ? 'name' : 'x']: 'p', version: '1.0.0', description: 'd', tools: [${T}] };`],
  ['comma expression in value position', `export default { name: 'p', version: (__pwn('k'), '1.0.0'), description: 'd', tools: [${T}] };`],
  ['template-literal interpolation', `export default { name: 'p', version: \`1.\${__pwn('t')}.0\`, description: 'd', tools: [${T}] };`],
  ['spread of an expression', `export default { ...(__pwn('s') ? {} : {}), name: 'p', version: '1.0.0', description: 'd', tools: [${T}] };`],
  ['IIFE in value position', `export default { name: 'p', version: (() => { __pwn('i'); return '1.0.0'; })(), description: 'd', tools: [${T}] };`],
  ['setter', `export default { set name(v) { __pwn('S'); }, version: '1.0.0', description: 'd', tools: [${T}] };`],
  // Nested — the allowlist must recurse, not just guard the root.
  ['getter NESTED inside tools[0]', `export default { name: 'p', version: '1.0.0', description: 'd', tools: [{ get name() { __pwn('n'); return 'p_go'; }, description: 'd', inputSchema: {}, async execute() { return {}; } }] };`],
  ['computed key NESTED inside inputSchema', `export default { name: 'p', version: '1.0.0', description: 'd', tools: [{ name: 'p_go', description: 'd', inputSchema: { [__pwn('q') ? 'type' : 'x']: 'object' }, async execute() { return {}; } }] };`],
  ['expression NESTED in an array element', `export default { name: 'p', version: '1.0.0', description: 'd', requires: [__pwn('a') ? 'x' : 'y'], tools: [${T}] };`],
  ['bare call expression as a value', `export default { name: 'p', version: __pwn('b') ? '1.0.0' : '2', description: 'd', tools: [${T}] };`],
  ['new expression', `export default { name: 'p', version: '1.0.0', description: 'd', requires: new Array(0), tools: [${T}] };`],
  ['class expression', `export default { name: 'p', version: '1.0.0', description: 'd', requires: class { constructor() { __pwn('cl'); } }, tools: [${T}] };`],
  ['tagged template', `export default { name: 'p', version: String.raw\`1.0.0\`, description: 'd', tools: [${T}] };`],
  ['function in a NON-execute position', `export default { name: 'p', version: '1.0.0', description: () => __pwn('f'), tools: [${T}] };`],
  ['await in value position', `export default { name: 'p', version: await Promise.resolve('1.0.0'), description: 'd', tools: [${T}] };`],
];

console.log('— code-execution vectors (all must be REJECTED) —');
for (const [label, src] of EXEC_VECTORS) {
  const v = scanPackSource(src);
  check(`rejected: ${label}`, v.length > 0, v[0]?.slice(0, 72) ?? 'NOTHING FLAGGED');
}

// --- 2. and none of them may EXECUTE via the pre-approval listing path ------
console.log('— pre-approval listing must never execute a staged file —');
PWNED.length = 0;
for (const [i, [, src]] of EXEC_VECTORS.entries()) writeFileSync(join(dir, `vec${i}.pack.mts`), src, 'utf8');
const listed = await listStagedPacks([]);
check('every hostile file is listed for review (not hidden)', listed.length === EXEC_VECTORS.length, `${listed.length} listed`);
check('every hostile file is flagged unloadable', listed.every((p) => !!p.loadError));
check('source is still surfaced for the human reviewer', listed.every((p) => p.source.length > 0));
check('ZERO payloads executed during listing', PWNED.length === 0, PWNED.length ? `RAN: ${JSON.stringify(PWNED)}` : 'no marks');
for (const [i] of EXEC_VECTORS.entries()) rmSync(join(dir, `vec${i}.pack.mts`), { force: true });

// --- 3. structural rules ---------------------------------------------------
console.log('— structural rules —');
check('no export default rejected', scanPackSource('const x = 1;').some((v) => /export default/.test(v)));
check('extra top-level statement rejected', scanPackSource(`const q = 1;\n${GOOD}`).some((v) => /NOTHING besides|top-level/.test(v)));
check('trailing top-level statement rejected', scanPackSource(`${GOOD}\n__pwn('after');`).some((v) => /NOTHING besides|top-level/.test(v)));
check('non-object default export rejected', scanPackSource('export default 42;').some((v) => /object literal/.test(v)));
check('two export defaults rejected', scanPackSource(`${GOOD}\nexport default {};`).length > 0);
check('oversized source rejected', scanPackSource(`${GOOD}\n// ${'x'.repeat(70_000)}`).some((v) => /cap is/.test(v)));

// --- 4. keyword blocklist still active (defense in depth for execute bodies) -
console.log('— keyword blocklist (inside execute bodies) —');
check('import rejected', scanPackSource(`import fs from 'fs';\n${GOOD}`).some((v) => /imports are not allowed/.test(v)));
check('require rejected', scanPackSource(GOOD.replace('String(args.text', "require('fs') && String(args.text")).some((v) => /require/.test(v)));
check('process rejected', scanPackSource(GOOD.replace('args.text ?? ', 'process.env.X ?? ')).some((v) => /process/.test(v)));
check('eval rejected', scanPackSource(GOOD.replace("String(args.text ?? '')", "eval('1')")).some((v) => /eval/.test(v)));
check('Function ctor rejected', scanPackSource(GOOD.replace("String(args.text ?? '')", "Function('return 1')()")).some((v) => /Function/.test(v)));
check('globalThis rejected', scanPackSource(GOOD.replace('args.text', 'globalThis.x')).some((v) => /globalThis/.test(v)));
check('node: builtin rejected', scanPackSource(GOOD.replace('deterministic', 'node:fs')).some((v) => /node built-ins/.test(v)));

// --- 4b. UNICODE-ESCAPED identifiers must not slip past ---------------------
// `process` IS the identifier `process` to every JS engine, but matches no
// /\bprocess\b/. Verified 2026-08-13: 6 of 8 such payloads passed the keyword
// regexes with ZERO violations. That is the worst failure mode available to
// this gate, since its stated fallback is a HUMAN reading the source — and no
// reviewer spots `process` in a diff. The fix matches on the RESOLVED
// Identifier.text from the AST (TypeScript decodes escapes), so the whole class
// is closed rather than one spelling. Built with String.fromCharCode so this
// file's own compilation cannot collapse the escape before the gate sees it.
console.log('— unicode-escaped identifiers —');
const BS = String.fromCharCode(92);
const escFirst = (w: string) => BS + 'u' + w.charCodeAt(0).toString(16).padStart(4, '0') + w.slice(1);
const inExec = (body: string) => `export default {
  name: 'uni-pack', version: '0.1.0', description: 'd',
  tools: [{ name: 'uni-pack_go', description: 'd', inputSchema: { type: 'object' }, async execute() { ${body} } }],
};`;
for (const word of ['process', 'eval', 'require', 'globalThis', 'Function', 'constructor']) {
  const src = inExec(`return ${escFirst(word)};`);
  // Guard the test itself: if the escape got collapsed at compile time this
  // would silently become the plain-word case and prove nothing.
  const carriesEscape = src.includes(BS + 'u00');
  check(`test fixture really carries an escape for ${word}`, carriesEscape);
  check(`unicode-escaped ${word} rejected`, scanPackSource(src).length > 0);
}
check('plain .constructor( chain rejected', scanPackSource(inExec('return (()=>{}).constructor("return 1")();')).length > 0);
check('dynamic import() rejected', scanPackSource(inExec('return import("node:fs");')).length > 0);
// The AST name check must NOT fire on the same words inside plain prose, which
// is where the raw-text regexes produce their false positives.
check('the word "process" inside a description is still fine', scanPackSource(GOOD.replace('deterministic echo pack', 'helps you handle a workflow step')).length === 0);

// --- 4c. the gate must not blow up on a hostile shape ----------------------
console.log('— gate robustness —');
const deep = 'export default { name: "d-pack", version: "0.1.0", description: "d", requires: ' + '['.repeat(2000) + ']'.repeat(2000) + ', tools: [] };';
let threw = '';
try {
  const v = scanPackSource(deep);
  check('deeply nested literal is rejected, not crashed on', v.length > 0, v[0]?.slice(0, 60));
} catch (err) {
  threw = err instanceof Error ? err.name : String(err);
  check('deeply nested literal is rejected, not crashed on', false, `threw ${threw}`);
}

// --- 5. the legitimate path must still work --------------------------------
console.log('— legitimate pack still passes end to end —');
check('clean source passes the scan', scanPackSource(GOOD).length === 0, scanPackSource(GOOD).join('; '));

const ext = extractManifestFromSource(GOOD);
check('metadata extracted without importing', !!ext.manifest, ext.errors.join('; '));
check('name extracted', ext.manifest?.name === 'scansmoke-echo');
check('version extracted', ext.manifest?.version === '0.1.0');
check('prompt extracted', ext.manifest?.prompt === 'Use scansmoke-echo_shout.');
check('nested inputSchema extracted intact', JSON.stringify(ext.manifest?.tools[0]?.inputSchema) === JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }));
check('trustClass extracted', ext.manifest?.tools[0]?.trustClass === 'read');
check('execute is a placeholder function, not the real one', typeof ext.manifest?.tools[0]?.execute === 'function');
check('extracted placeholder returns undefined (never the real body)', (await ext.manifest!.tools[0]!.execute({})) === undefined);

// TS type-level wrappers are erased at runtime, so they must not be rejected.
check('`as const` accepted (type-only, no runtime effect)', scanPackSource(GOOD.replace("required: ['text'] }", "required: ['text'] } as const")).length === 0);

const staged = await stagePack(GOOD, []);
check('good pack stages', staged.name === 'scansmoke-echo' && staged.toolNames.join() === 'scansmoke-echo_shout');
PWNED.length = 0;
const list2 = await listStagedPacks([]);
const mine = list2.find((p) => p.name === 'scansmoke-echo');
check('good pack lists cleanly (no loadError)', !!mine && !mine.loadError, mine?.loadError ?? '');
check('listing a GOOD pack also executes nothing', PWNED.length === 0);

// loadDynamicPack is the one path that still imports — post-approval — and it
// must bind the REAL execute so the tool actually works.
const pack = await loadDynamicPack('scansmoke-echo', []);
const out = (await pack.tools[0]!.execute({ text: 'hi akhil' }, undefined as never)) as { shouted?: string };
check('post-approval load binds the REAL execute', out.shouted === 'HI AKHIL', JSON.stringify(out));
check('trust floor: untrustedOutput=true', pack.tools.every((t) => t.untrustedOutput === true));
check('trust floor: autoApprove=false', pack.policies.every((p) => p.autoApprove === false));
delete DYNAMIC['scansmoke-echo'];

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
