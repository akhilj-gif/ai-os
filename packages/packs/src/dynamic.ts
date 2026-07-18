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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
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

/** Returns human-readable violations (empty = clean). Exported for the smoke. */
export function scanPackSource(src: string): string[] {
  const out: string[] = [];
  if (src.length > MAX_SOURCE_CHARS) out.push(`source is ${src.length} chars — cap is ${MAX_SOURCE_CHARS}`);
  // `export default` must be the ONLY export/statement surface we accept.
  if (!/export\s+default\s*\{/.test(src)) out.push('module must be exactly one `export default { … }` object literal');
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
  const dir = dynamicPacksDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.staging-${randomUUID().slice(0, 8)}.mts`);
  writeFileSync(tmp, source, 'utf8');
  try {
    const mod = await importPackFile(tmp);
    const { manifest, errors } = validateManifest(mod, staticPackNames);
    if (!manifest) throw new Error(`manifest invalid:\n- ${errors.join('\n- ')}`);
    const finalPath = join(dir, `${manifest.name}.pack.mts`);
    renameSync(tmp, finalPath);
    return {
      name: manifest.name,
      file: finalPath,
      toolNames: manifest.tools.map((t) => t.name),
      description: manifest.description,
      requires: manifest.requires,
    };
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Import a STAGED pack file and register it into DYNAMIC (floor applied).
 *  Does not touch the DB — install/enable state lives there. */
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
      const mod = await importPackFile(join(dir, f));
      const { manifest, errors } = validateManifest(mod, staticPackNames);
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
