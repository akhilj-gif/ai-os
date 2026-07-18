// M20 — the Pack Forge (ADR-0022): "I need a Spotify tool" → the OS WRITES the
// capability pack itself, subject to the same discipline as the M6 coding
// loop: generate → deterministic verifier (safety scan + import + manifest
// validation via stagePack) → feed failures back → repair round → stop. The
// ground truth is the verifier, never the model's claim. Staged packs are
// INERT until the user approves the install (pack_install / POST
// /packs/staged/:name/install) — building is free, activating needs a human.
import { callModel } from '@ai-os/model-router';
import { stagePack, type StageResult } from './dynamic.js';

const MAX_ROUNDS = 3;

/** The contract the generator must hit — also served to the model verbatim.
 *  Exported so the smoke and docs stay in sync with the real prompt. */
export const FORGE_GUIDE = `You write a single self-contained TypeScript module: a capability pack for a personal AI OS.

HARD RULES (a static scanner rejects violations — there is no human to argue with):
- The ENTIRE module is exactly one \`export default { ... }\` object literal. No imports, no require, no other statements before/after.
- Allowed globals ONLY: fetch, JSON, Date, Math, URL, URLSearchParams, encodeURIComponent, String/Number/Array/Object. NOTHING else — no process, no eval, no Function, no globalThis, no node: modules, no filesystem.
- Prefer FREE, KEYLESS public APIs (this version cannot hold secrets). If the capability truly needs an API key, do not fake it — return an error explaining what key is needed and list it in "requires".
- Every fetch must have a timeout: AbortSignal.timeout(10000). Handle non-OK responses with a clear returned { error: "..." } — never throw raw.
- Cap any returned text at ~4000 chars.

SHAPE:
export default {
  name: 'kebab-case-name',            // short, unique
  version: '0.1.0',
  description: 'one sentence',
  prompt: 'one short paragraph telling the assistant when/how to use these tools',
  requires: [],                        // human-readable external requirements, if any
  tools: [
    {
      name: '<packname>_<verb>',       // MUST be prefixed with the pack name + underscore
      description: 'when to call this and what it returns',
      trustClass: 'read',              // honest claim: read | write | irreversible | spend
      inputSchema: { type: 'object', properties: { q: { type: 'string', description: '…' } }, required: ['q'] },
      async execute(args: Record<string, unknown>): Promise<unknown> {
        // fetch + JSON only; return plain JSON-serializable data
      },
    },
  ],
};

Reply with ONLY the module code inside one \`\`\`ts fenced block. No prose.`;

export interface ForgeResult extends StageResult {
  rounds: number;
  source: string;
}

/** Extract the fenced code block (or fall back to the raw text). */
function extractCode(text: string): string {
  const m = text.match(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/);
  return (m ? m[1]! : text).trim();
}

/** Generate + verify + repair until the pack stages clean or rounds run out.
 *  Throws with the full failure list if the last round still fails. */
export async function forgePack(
  request: string,
  opts: { traceId: string; taskId?: string; staticPackNames: string[] },
): Promise<ForgeResult> {
  let feedback = '';
  let lastErr = '';
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const res = await callModel({
      role: 'planning', // top tier — pack authorship is the hardest codegen we do
      traceId: opts.traceId,
      taskId: opts.taskId,
      name: 'packs.forge',
      maxTokens: 3500,
      system: FORGE_GUIDE,
      prompt:
        `Capability requested by the user: ${request}\n` +
        (feedback ? `\nYour previous attempt was REJECTED by the verifier. Fix ALL of these and output the corrected full module:\n${feedback}` : ''),
    });
    const source = extractCode(res.text);
    try {
      const staged = await stagePack(source, opts.staticPackNames);
      return { ...staged, rounds: round, source };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      feedback = lastErr;
    }
  }
  throw new Error(`forge failed after ${MAX_ROUNDS} rounds — last verifier output:\n${lastErr}`);
}
