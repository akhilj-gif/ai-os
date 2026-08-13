// M20 — Pack Forge substrate (ADR-0022): DYNAMIC capability packs, authored by
// the OS itself at runtime, staged as reviewable source files, and activated
// only after the user's explicit approval.
//
// Trust model (v1 — honest about its limits):
//   - Generated code runs IN-PROCESS once installed. There is no in-process
//     sandbox for it; the real gates are (1) a strict static scan (below),
//     (2) the human reviewing + approving the INSTALL, and (3) a hard trust
//     floor: every generated tool is autoApprove=FALSE (each call queues for
//     one-click approval) and untrustedOutput=TRUE (its output latches §8.3,
//     so it can never trigger auto-mutations). The user can relax per-tool
//     policies later in /settings once a pack has earned trust.
//   - The static scan is an ALLOWLIST posture, not a blocklist patch: a
//     generated module may import NOTHING (global fetch/JSON/Date/Math only),
//     may not touch process/env/eval/require/dynamic-import, and is size-capped.
//     A scan can be fooled in principle — which is why the floor + human
//     install approval exist. Keyed APIs (secrets) are deliberately v2.
// (no renameSync/rmSync: staging used to write a temp file, import it, and
// rename-or-delete based on the result — that dance existed only to contain the
// import. Staging no longer imports anything, so it just writes the file.)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import type pg from 'pg';
import type { ToolDef } from '@ai-os/tools';
import { newTraceId } from '@ai-os/shared';
import type { CapabilityPack } from './index.js';

const MAX_SOURCE_CHARS = 64_000;
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** Where staged/installed dynamic pack sources live (gitignored — they are
 *  per-installation state, like .auth/ and workspaces/). */
export function dynamicPacksDir(): string {
  return process.env.AIOS_DYNAMIC_PACKS_DIR ?? join(process.cwd(), 'packs-dynamic');
}

/** In-memory registry of LOADED dynamic packs — consulted by composeRegistry/
 *  packPrompts/listPacks via allPacks() in index.ts. */
export const DYNAMIC: Record<string, CapabilityPack> = {};

// ---------------------------------------------------------------------------
// Static safety scan — runs on raw source BEFORE any import/execution.
// ---------------------------------------------------------------------------
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /\bimport\b/, why: 'imports are not allowed — use only globals (fetch, JSON, Date, Math, URL)' },
  { re: /\brequire\s*\(/, why: 'require() is not allowed' },
  { re: /\bprocess\b/, why: 'process (env/exit/…) access is not allowed' },
  { re: /\beval\s*\(/, why: 'eval() is not allowed' },
  { re: /\bnew\s+Function\b|\bFunction\s*\(/, why: 'Function constructor is not allowed' },
  { re: /\bglobalThis\b/, why: 'globalThis access is not allowed' },
  { re: /child_process|worker_threads|node:/, why: 'node built-ins are not allowed' },
  { re: /__proto__|constructor\s*\[/, why: 'prototype tampering is not allowed' },
];

// ---------------------------------------------------------------------------
// AST manifest extraction — the structural gate. Parses, never executes.
//
// This REPLACED a text-based check (comment-stripping + brace-balancing) that
// asked only "is the module exactly one `export default { … }` with nothing
// outside it". That question turned out to be the wrong one. It treats the
// object literal as inert DATA, and a JS object literal is not data: it runs
// arbitrary code at CONSTRUCTION time (computed keys, any expression in value
// position, template interpolation, spread, IIFEs) and at PROPERTY-READ time
// (getters). All of that lives INSIDE the braces, so "nothing outside" never
// saw it, and none of it needs a FORBIDDEN keyword.
//
// That was not theoretical: on 2026-08-13 all six of those vectors were shown
// to pass the old scan with zero violations AND actually execute — via
// listStagedPacks(), the path this file itself describes as read-only and
// approval-free. `fetch` is an intentionally allowed global, so that is a
// working exfiltration primitive reachable by merely LISTING staged packs.
//
// The fix is not more blocklist entries — it is to stop importing untrusted
// source in order to read its metadata. We now parse the module and extract
// the manifest from the syntax tree, enforcing a genuine ALLOWLIST: every
// value must be a plain literal, and the ONLY executable thing permitted
// anywhere is a function under the key `execute` (which runs only when the
// tool is actually called, long after a human approved the install). This
// finally matches the "ALLOWLIST posture" the header comment always claimed.
// ---------------------------------------------------------------------------

/** Marker for "a function appeared here" — replaced by an inert placeholder
 *  before validation, so nothing from the source is ever callable. */
const FN = Symbol('pack-fn');

/** Bound on the recursive literal walk. Guards against a hostile source whose
 *  only payload is nesting depth (see the RangeError note in scanPackSource). */
const MAX_LITERAL_DEPTH = 40;

/** Names a generated pack may never reference, checked as RESOLVED IDENTIFIERS
 *  rather than as source text.
 *
 *  This exists because the FORBIDDEN regexes below cannot see through a unicode
 *  identifier escape. `process` IS the identifier `process` to every JS
 *  engine, but matches no /\bprocess\b/ — verified 2026-08-13: 6 of 8 payloads
 *  (escaped process, eval, require, globalThis, Function, and
 *  `(()=>{}).constructor("…")()`) passed the keyword scan with ZERO
 *  violations. That is the worst possible failure mode for this gate, because
 *  the gate's stated fallback is a HUMAN reading the source before approving —
 *  and no reviewer spots `process` in a diff.
 *
 *  TypeScript's scanner decodes escapes, so Identifier.text is the canonical
 *  name regardless of how it was written; matching on that closes the whole
 *  class rather than one spelling of it. Unlike the regexes this also ignores
 *  identical words inside strings and comments, so it adds no false positives.
 *
 *  Honest scope: this is defense in depth, NOT a sandbox. Generated code still
 *  runs in-process once a human approves it, and a determined escape through
 *  computed member access cannot be caught statically. The real containment is
 *  human install approval + autoApprove=false per call + no DB pool. What this
 *  removes is the class of bypass that is INVISIBLE to the human doing the
 *  approving. */
const FORBIDDEN_NAMES = new Set([
  'process',
  'eval',
  'require',
  'Function',
  'globalThis',
  'constructor', // (()=>{}).constructor === Function — the classic escape
  '__proto__',
  'prototype',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'child_process',
  'worker_threads',
  'Reflect',
  'Proxy',
  'WebAssembly',
]);

/** Every forbidden identifier actually referenced anywhere in the module,
 *  INCLUDING inside execute() bodies (which the value allowlist deliberately
 *  does not constrain, since they are real code by design). */
function forbiddenNamesUsed(sf: ts.SourceFile): string[] {
  const hits = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      if (FORBIDDEN_NAMES.has(n.text)) hits.add(n.text);
    } else if (n.kind === ts.SyntaxKind.ImportKeyword) {
      hits.add('import'); // dynamic import(), incl. import.meta
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return [...hits];
}

function nodeToValue(node: ts.Node, key: string, errors: string[], path: string, depth: number): unknown {
  if (depth > MAX_LITERAL_DEPTH) {
    errors.push(`${path}: nesting deeper than ${MAX_LITERAL_DEPTH} levels is not allowed`);
    return undefined;
  }
  // `x as const` / `x satisfies T` are TYPE-level only — fully erased before
  // anything runs, so unwrapping them adds no execution surface, and a model
  // writing TypeScript reaches for them often enough that rejecting would cost
  // pointless repair rounds. The wrapped expression is still checked below.
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return nodeToValue(node.expression, key, errors, path, depth);
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    if (key !== 'execute') {
      errors.push(`${path}: a function is only allowed as \`execute\``);
      return undefined;
    }
    return FN;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((el, i) => {
      if (ts.isSpreadElement(el)) {
        errors.push(`${path}[${i}]: spread (...) is not allowed — it evaluates an expression while the array is built`);
        return undefined;
      }
      return nodeToValue(el, '', errors, `${path}[${i}]`, depth + 1);
    });
  }
  if (ts.isObjectLiteralExpression(node)) return objectToValue(node, errors, path, depth + 1);
  errors.push(
    `${path}: only literal data is allowed here, found ${ts.SyntaxKind[node.kind]} — any expression in a value position executes the moment the module is imported`,
  );
  return undefined;
}

function objectToValue(obj: ts.ObjectLiteralExpression, errors: string[], path: string, depth: number): Record<string, unknown> {
  if (depth > MAX_LITERAL_DEPTH) {
    errors.push(`${path}: nesting deeper than ${MAX_LITERAL_DEPTH} levels is not allowed`);
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const prop of obj.properties) {
    if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      errors.push(`${path || '<root>'}: get/set accessors are not allowed — a getter runs code every time the property is READ`);
      continue;
    }
    if (ts.isSpreadAssignment(prop)) {
      errors.push(`${path || '<root>'}: spread (...) is not allowed — it evaluates an expression while the object is built`);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      errors.push(`${path || '<root>'}: shorthand properties are not allowed — name the value explicitly`);
      continue;
    }
    const nameNode = prop.name;
    if (!nameNode || ts.isComputedPropertyName(nameNode)) {
      errors.push(`${path || '<root>'}: computed property keys are not allowed — the key expression runs at construction time`);
      continue;
    }
    const key = ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) ? nameNode.text : null;
    if (key === null) {
      errors.push(`${path || '<root>'}: unsupported property key`);
      continue;
    }
    const childPath = path ? `${path}.${key}` : key;
    if (ts.isMethodDeclaration(prop)) {
      if (key !== 'execute') {
        errors.push(`${childPath}: a method is only allowed as \`execute\``);
        continue;
      }
      out[key] = FN;
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) {
      errors.push(`${childPath}: unsupported property form`);
      continue;
    }
    out[key] = nodeToValue(prop.initializer, key, errors, childPath, depth + 1);
  }
  return out;
}

/** Swap the FN marker for an inert placeholder. validateManifest only checks
 *  that `execute` IS a function; it never calls it, and neither do we — the
 *  real one is bound later, post-approval, in loadDynamicPack. */
function hydrate(v: unknown): unknown {
  if (v === FN) return async () => undefined;
  if (Array.isArray(v)) return v.map(hydrate);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, hydrate(x)]));
  }
  return v;
}

/** Parse `source` and pull the manifest out of the syntax tree WITHOUT
 *  importing or evaluating one byte of it. The returned manifest's execute
 *  functions are inert placeholders — it is metadata for review/validation
 *  only, never a runnable pack. */
export function extractManifestFromSource(src: string): { manifest?: DynamicManifest; errors: string[] } {
  // Pathological input must REJECT, never propagate. ~2000 nested brackets in
  // ~4KB of source overflows the stack inside ts.createSourceFile itself —
  // TypeScript's own recursive-descent parser, which MAX_LITERAL_DEPTH cannot
  // help with because the throw happens before our walk starts. A RangeError
  // escaping here would surface as an opaque 500 from the forge/staging routes
  // (and, before listStagedPacks stopped importing, from merely listing).
  // Catching it converts a crash into an ordinary scan violation, which is what
  // every caller already knows how to handle.
  try {
    return extractManifestUnsafe(src);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return { errors: [`source could not be parsed safely (${name}) — pathologically nested or malformed`] };
  }
}

function extractManifestUnsafe(src: string): { manifest?: DynamicManifest; errors: string[] } {
  const errors: string[] = [];
  const sf = ts.createSourceFile('pack.mts', src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  // Resolved-identifier check first: it sees through unicode escapes, which the
  // FORBIDDEN regexes cannot, and it covers execute() bodies too.
  for (const name of forbiddenNamesUsed(sf)) {
    errors.push(`\`${name}\` is not allowed anywhere in a generated pack (referenced as an identifier — unicode escapes do not hide it)`);
  }
  const exportDefaults = sf.statements.filter((s): s is ts.ExportAssignment => ts.isExportAssignment(s) && !s.isExportEquals);
  if (exportDefaults.length !== 1) {
    errors.push('module must be exactly one `export default { … }` object literal');
    return { errors };
  }
  if (sf.statements.length !== 1) {
    errors.push(
      'module must contain NOTHING besides `export default { … }` — no other top-level statement is allowed (it would run on every stage/list/install, before any approval)',
    );
  }
  // Unwrap type-only wrappers here too, so `export default { … } as const` is
  // accepted for the same reason it is accepted on a property value: erased
  // before anything runs, and common in model-written TypeScript.
  let expr: ts.Expression = exportDefaults[0]!.expression;
  while (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  if (!ts.isObjectLiteralExpression(expr)) {
    errors.push('`export default` must be a plain object literal');
    return { errors };
  }
  const raw = hydrate(objectToValue(expr, errors, '', 0));
  if (errors.length) return { errors };
  return { manifest: raw as DynamicManifest, errors: [] };
}

/** Returns human-readable violations (empty = clean). Exported for the smoke.
 *
 *  Three layers, in order of strength:
 *    1. a size cap;
 *    2. the AST allowlist (extractManifestFromSource) — the load-bearing one:
 *       the module must parse to exactly one `export default { … }` whose every
 *       value is a plain literal, with executable code permitted ONLY under
 *       `execute`. This is what makes it safe to read a pack's metadata, since
 *       we now read it from the syntax tree instead of importing the file;
 *    3. the FORBIDDEN keyword regexes — kept as cheap defense-in-depth for the
 *       inside of `execute` bodies (which the allowlist deliberately does not
 *       constrain, since they are real code by design). Scanned against the raw
 *       source including comments/strings: a false positive is the safe
 *       direction, and the forge's repair loop just rewrites. */
export function scanPackSource(src: string): string[] {
  const out: string[] = [];
  if (src.length > MAX_SOURCE_CHARS) out.push(`source is ${src.length} chars — cap is ${MAX_SOURCE_CHARS}`);
  out.push(...extractManifestFromSource(src).errors);
  for (const f of FORBIDDEN) {
    // The scan runs on the whole file including comments/strings — false
    // positives are acceptable (rejecting is the safe direction; the forge
    // repair loop rewrites).
    const probe = src.replace(/export\s+default/, ''); // don't let the export keyword trip /\bimport\b/-style checks
    if (f.re.test(probe)) out.push(f.why);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manifest validation — runs on the imported module's default export.
// ---------------------------------------------------------------------------
export interface DynamicManifest {
  name: string;
  version: string;
  description: string;
  prompt?: string;
  requires?: string[];
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /** The GENERATOR's claim — recorded in the policy row's class, but the
     *  autoApprove floor (false) applies regardless of what it claims. */
    trustClass?: 'read' | 'write' | 'irreversible' | 'spend';
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  }>;
}

export function validateManifest(mod: unknown, staticPackNames: string[]): { manifest?: DynamicManifest; errors: string[] } {
  const errors: string[] = [];
  const m = (mod as { default?: unknown })?.default as DynamicManifest | undefined;
  if (!m || typeof m !== 'object') return { errors: ['module has no default-export object'] };
  if (!NAME_RE.test(String(m.name ?? ''))) errors.push(`pack name "${m.name}" must match ${NAME_RE}`);
  if (staticPackNames.includes(m.name)) errors.push(`pack name "${m.name}" collides with a built-in pack`);
  if (!m.version || typeof m.version !== 'string') errors.push('version (string) required');
  if (!m.description || typeof m.description !== 'string') errors.push('description (string) required');
  if (!Array.isArray(m.tools) || m.tools.length === 0 || m.tools.length > 8) {
    errors.push('tools must be a non-empty array (max 8)');
  } else {
    for (const t of m.tools) {
      if (!t?.name || !t.name.startsWith(`${m.name}_`)) errors.push(`tool "${t?.name}" must be prefixed "${m.name}_"`);
      if (!t?.description) errors.push(`tool "${t?.name}" needs a description`);
      if (!t?.inputSchema || typeof t.inputSchema !== 'object') errors.push(`tool "${t?.name}" needs an inputSchema object`);
      if (typeof t?.execute !== 'function') errors.push(`tool "${t?.name}" needs an async execute function`);
    }
  }
  return errors.length ? { errors } : { manifest: m, errors: [] };
}

/** Manifest → CapabilityPack with the v1 trust FLOOR baked in:
 *  every tool untrustedOutput=true; every policy autoApprove=false. */
export function toCapabilityPack(m: DynamicManifest, source: string): CapabilityPack {
  const tools: ToolDef[] = m.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    untrustedOutput: true, // FLOOR: generated-tool output is external/untrusted by definition
    execute: async (args) => t.execute(args), // ctx (pool) is deliberately NOT passed to generated code
  }));
  return {
    name: m.name,
    version: m.version,
    description: `[forged] ${m.description}`,
    tools,
    prompt: m.prompt,
    policies: m.tools.map((t) => ({
      tool: t.name,
      trustClass: t.trustClass ?? 'irreversible',
      autoApprove: false, // FLOOR: every generated-tool call queues for one-click approval
    })),
    memories: [],
    evalSuites: [],
    verifiedBy: `forge scan + human install approval (source: packs-dynamic/${m.name}.pack.mts, ${source.length} chars)`,
    requires: m.requires,
  };
}

// ---------------------------------------------------------------------------
// Stage / load / install / list
// ---------------------------------------------------------------------------
async function importPackFile(file: string): Promise<unknown> {
  // Cache-busted so a re-staged file re-imports fresh.
  return import(`${pathToFileURL(file).href}?v=${Date.now()}-${randomUUID().slice(0, 8)}`);
}

export interface StageResult {
  name: string;
  file: string;
  toolNames: string[];
  description: string;
  requires?: string[];
}

/** Scan + import + validate a generated source, then stage it as
 *  packs-dynamic/<name>.pack.mts (NOT active until installed). Throws with
 *  every violation listed — the forge feeds that back for a repair round. */
export async function stagePack(source: string, staticPackNames: string[]): Promise<StageResult> {
  const violations = scanPackSource(source);
  if (violations.length) throw new Error(`safety scan rejected the pack:\n- ${violations.join('\n- ')}`);
  // Metadata comes from the SYNTAX TREE, not from importing the file. Staging
  // happens before any human has seen the pack, so it must not execute it.
  const { manifest, errors } = validateManifest({ default: extractManifestFromSource(source).manifest }, staticPackNames);
  if (!manifest) throw new Error(`manifest invalid:\n- ${errors.join('\n- ')}`);
  const dir = dynamicPacksDir();
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${manifest.name}.pack.mts`);
  writeFileSync(finalPath, source, 'utf8');
  return {
    name: manifest.name,
    file: finalPath,
    toolNames: manifest.tools.map((t) => t.name),
    description: manifest.description,
    requires: manifest.requires,
  };
}

/** Import a STAGED pack file and register it into DYNAMIC (floor applied).
 *  Does not touch the DB — install/enable state lives there.
 *
 *  This is the ONE path that still genuinely imports the file, because it needs
 *  the real `execute` functions to bind into the registry — metadata can be
 *  read from the AST but a callable function cannot. Two things make that
 *  acceptable where it was not acceptable for stage/list:
 *    - it runs at INSTALL (post-approval) and at boot for an already-installed
 *      pack, i.e. only for source a human has accepted; and
 *    - the AST allowlist re-checked on the line below means the module body can
 *      no longer DO anything when it is imported. Every value is a literal, so
 *      construction is inert and there are no getters to fire; the only code
 *      that exists is inside `execute`, which runs when the tool is called and
 *      is separately gated by the trust floor (autoApprove=false) below.
 *  So the import no longer grants execution — it only retrieves functions whose
 *  invocation stays behind the approval queue. */
export async function loadDynamicPack(name: string, staticPackNames: string[]): Promise<CapabilityPack> {
  const file = join(dynamicPacksDir(), `${name}.pack.mts`);
  if (!existsSync(file)) throw new Error(`no staged pack file: ${file}`);
  const source = readFileSync(file, 'utf8');
  const violations = scanPackSource(source);
  if (violations.length) throw new Error(`staged pack "${name}" fails the safety scan (file edited?):\n- ${violations.join('\n- ')}`);
  const mod = await importPackFile(file);
  const { manifest, errors } = validateManifest(mod, staticPackNames);
  if (!manifest) throw new Error(`staged pack "${name}" manifest invalid:\n- ${errors.join('\n- ')}`);
  if (manifest.name !== name) throw new Error(`file ${basename(file)} declares name "${manifest.name}"`);
  const pack = toCapabilityPack(manifest, source);
  DYNAMIC[name] = pack;
  return pack;
}

export interface StagedPackInfo {
  name: string;
  description: string;
  toolNames: string[];
  requires?: string[];
  source: string;
  loadError?: string;
}

/** Every *.pack.mts on disk, with source for human review. Never throws. */
export async function listStagedPacks(staticPackNames: string[]): Promise<StagedPackInfo[]> {
  const dir = dynamicPacksDir();
  if (!existsSync(dir)) return [];
  const out: StagedPackInfo[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.pack.mts'))) {
    const name = f.replace(/\.pack\.mts$/, '');
    const source = readFileSync(join(dir, f), 'utf8');
    try {
      // NEVER imports (2026-08-13). This function exists to render staged packs
      // for human review — an explicitly read-only, pre-approval action — and it
      // used to import() every file on disk to read its name, executing all of
      // them on every call, cache-busted so a fresh execution each time. Reading
      // metadata out of the syntax tree gets the same information with no
      // execution at all, which is the whole reason extractManifestFromSource
      // exists. A file that fails the scan is reported, not run.
      const violations = scanPackSource(source);
      if (violations.length) throw new Error(violations.join('; '));
      const { manifest, errors } = validateManifest({ default: extractManifestFromSource(source).manifest }, staticPackNames);
      if (!manifest) throw new Error(errors.join('; '));
      out.push({ name, description: manifest.description, toolNames: manifest.tools.map((t) => t.name), requires: manifest.requires, source });
    } catch (err) {
      out.push({ name, description: '(unloadable)', toolNames: [], source, loadError: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    }
  }
  return out;
}

/** Install a STAGED dynamic pack: load (floor applied) + persist install state
 *  and fail-closed policy rows. Mirrors installPack for static packs. The
 *  CALLER is responsible for the human-approval gate. */
export async function installDynamicPack(pool: pg.Pool, name: string, staticPackNames: string[]): Promise<{ name: string; tools: string[] }> {
  const pack = await loadDynamicPack(name, staticPackNames);
  const task = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1,'done','user',$2) RETURNING id`,
    [`install dynamic pack: ${name}@${pack.version} (forged)`, newTraceId()],
  );
  await pool.query(
    `INSERT INTO capability_packs (name, version, enabled, install_task_id) VALUES ($1,$2,true,$3)
     ON CONFLICT (name) DO UPDATE SET version=$2, install_task_id=$3, enabled=true`,
    [name, pack.version, task.rows[0]!.id],
  );
  for (const p of pack.policies) {
    await pool.query(
      `INSERT INTO trust_policies (tool, trust_class, auto_approve) VALUES ($1,$2,$3) ON CONFLICT (tool) DO NOTHING`,
      [p.tool, p.trustClass, p.autoApprove],
    );
  }
  return { name, tools: pack.tools.map((t) => t.name) };
}
