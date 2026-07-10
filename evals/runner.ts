// The gym (blueprint §6, docs/EVAL-SPEC.md). Runs suites through the REAL
// executor loop with mocked tools where cases specify them, scores with
// tier-1/2 assertions, compares against baselines.json, and exits non-zero on
// regression. `pnpm eval [suite]` — this exit code IS the release gate.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { newTraceId } from '@ai-os/shared';
import { runTask, makePlan, runResearch } from '@ai-os/kernel';
import { MemoryService } from '@ai-os/memory';
import { buildRegistry, ToolRegistry } from '@ai-os/tools';
import type { EvalCase, Suite, CaseContext } from './lib/types.js';
import { injectionDefense } from './suites/injection-defense.js';
import { toolReliability, resetSuiteState } from './suites/tool-reliability.js';
import { memoryRecall } from './suites/memory-recall.js';
import { planning } from './suites/planning.js';
import { research } from './suites/research.js';
import { supportTriage } from './suites/support-triage.js';
import { whatsapp } from './suites/whatsapp.js';
import { x } from './suites/x.js';

const SUITES: Suite[] = [toolReliability, injectionDefense, memoryRecall, planning, research, whatsapp, x, supportTriage];
const evalsDir = dirname(fileURLToPath(import.meta.url));
const baselinesPath = join(evalsDir, 'baselines.json');

interface SuiteScore {
  passed: number;
  /** cases that actually executed (total minus infra-skipped) — the scoring denominator */
  scored: number;
  total: number;
  skipped: number;
  score: number;
  /** per-case verdicts — the basis for per-case regression detection */
  caseResults: Record<string, 'pass' | 'fail' | 'skip'>;
  failures: Array<{ caseId: string; assertion: string; detail: string }>;
  /** soft-assertion failures — reported, never gating (FC-021) */
  softNotes: Array<{ caseId: string; assertion: string; detail: string }>;
}

function registryFor(evalCase: EvalCase): ToolRegistry {
  // CLOSED WORLD (FC-023): every real tool keeps its schema (so the model sees the
  // same tool surface as production), but only mocked tools return data and only
  // realTools execute for real. Everything else throws a hermetic marker. Without
  // this, registering a new tool (M6 added fetch_url) silently changes the world
  // every old case runs in — rel-001's "search failed" world grew a working
  // fallback, real network entered the eval, and the case regressed for reasons
  // that had nothing to do with the behavior under test.
  const base = buildRegistry();
  const registry = new ToolRegistry();
  for (const schema of base.list()) {
    const real = base.get(schema.name)!;
    const mock = evalCase.mocks?.[schema.name];
    const allowReal = evalCase.realTools?.includes(schema.name) ?? false;
    const execute = mock
      ? (args: Record<string, unknown>) => mock(args)
      : allowReal
        ? real.execute.bind(real)
        : async () => {
            throw new Error(`EVAL_UNMOCKED_TOOL: ${schema.name} is not mocked and not in realTools — the eval world is closed`);
          };
    registry.register({ ...schema, execute });
  }
  for (const extra of evalCase.extraTools ?? []) {
    registry.register({ ...extra, execute: (args) => extra.execute(args) });
  }
  return registry;
}

const INFRA_RE = /^INFRA_(RATELIMIT|NETWORK)\b/;
const NET_RE = /^(fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up)/i;

async function runCase(pool: pg.Pool, evalCase: EvalCase): Promise<CaseContext> {
  // setup/teardown run for EVERY case kind (was planOnly-only — a whatsapp case
  // seeding trust policies in setup() silently never ran them, so the gate
  // fail-closed EVERY tool as unknown/irreversible and the case tested nothing).
  if (evalCase.setup) await evalCase.setup(pool);
  try {
    return await runCaseInner(pool, evalCase);
  } finally {
    if (evalCase.teardown) await evalCase.teardown(pool);
  }
}

async function runCaseInner(pool: pg.Pool, evalCase: EvalCase): Promise<CaseContext> {
  // planOnly: exercise the PLANNER and assert on plan shape, no execution.
  if (evalCase.planOnly) {
    try {
      const plan = await makePlan(pool, {
        taskId: randomUUID(),
        traceId: randomUUID(),
        goal: evalCase.goal,
        registry: registryFor(evalCase),
      });
      return { text: JSON.stringify(plan), plan, task: { status: 'done', spent: { tokens: 0 } }, toolCalls: [], pool, infraFailed: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const infraFailed = INFRA_RE.test(msg) || NET_RE.test(msg);
      return { text: msg, task: { status: 'failed', spent: { tokens: 0 } }, toolCalls: [], pool, infraFailed };
    }
    // teardown handled by runCase's finally
  }

  // research: run the research engine and assert on its cited output.
  if (evalCase.research) {
    try {
      const r = await runResearch(pool, { question: evalCase.goal, registry: registryFor(evalCase) });
      return {
        text: r.report,
        research: { report: r.report, sources: r.sources, status: r.status },
        task: { status: r.status === 'done' ? 'done' : 'failed', spent: { tokens: 0 } },
        toolCalls: [],
        pool,
        infraFailed: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: msg, task: { status: 'failed', spent: { tokens: 0 } }, toolCalls: [], pool, infraFailed: INFRA_RE.test(msg) || NET_RE.test(msg) };
    }
  }

  // Memory-recall cases: seed memories (tagged for cleanup), then let the task
  // recall them. Purge any prior eval-seed first so runs are idempotent.
  if (evalCase.seedMemory?.length) {
    const mem = new MemoryService(pool);
    await pool.query(`DELETE FROM memory_records WHERE 'eval-seed' = ANY(tags)`);
    for (const s of evalCase.seedMemory) {
      await mem.remember({ ...s, tags: ['eval-seed'], source: s.source });
    }
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1, 'draft', 'trigger', $2) RETURNING id`,
    [`[eval:${evalCase.id}] ${evalCase.goal}`, newTraceId()],
  );
  const taskId = rows[0]!.id;
  // M10: the learning loop verifies a candidate playbook by running the gym with
  // it injected into every case's context. A regression here (a baseline PASS now
  // failing) is exactly what must block adoption.
  const candidate = process.env.EVAL_CANDIDATE_MEMORY
    ? (() => { try { const p = JSON.parse(process.env.EVAL_CANDIDATE_MEMORY!) as { subject: string; content: string }; return `Learned playbook — ${p.subject}: ${p.content}`; } catch { return undefined; } })()
    : undefined;
  const result = await runTask(pool, taskId, { registry: registryFor(evalCase), enableMemory: evalCase.enableMemory, extraSystem: candidate });

  const task = (
    await pool.query<{ status: string; spent: { tokens: number } }>(
      `SELECT status, spent FROM tasks WHERE id = $1`,
      [taskId],
    )
  ).rows[0]!;
  const toolCalls = (
    await pool.query(
      `SELECT tc.tool, tc.trust_class, tc.approved_by, tc.args, tc.result
       FROM tool_calls tc JOIN steps s ON s.id = tc.step_id
       WHERE s.task_id = $1 ORDER BY tc.created_at`,
      [taskId],
    )
  ).rows as CaseContext['toolCalls'];

  // A task that failed on provider quota/rate-limit or a network outage is an
  // infra skip, not a real assertion result (FC-017). Match ONLY the explicit
  // markers the model router emits (INFRA_RATELIMIT / INFRA_NETWORK) or a raw
  // network-error message — NOT arbitrary substrings in a 4xx/5xx body, which
  // would hide a genuine provider-integration bug whose text mentions "quota"
  // (review finding). The marker is anchored to the start of the error.
  let infraFailed = false;
  if (task.status === 'failed') {
    const errs = await pool.query<{ error: string | null }>(
      `SELECT error FROM steps WHERE task_id = $1 AND error IS NOT NULL`,
      [taskId],
    );
    infraFailed = errs.rows.some((r) => INFRA_RE.test(r.error ?? '') || NET_RE.test(r.error ?? ''));
  }

  // Purge seeded memories so they don't leak into later cases or the UI.
  if (evalCase.seedMemory?.length) {
    await pool.query(`DELETE FROM memory_records WHERE 'eval-seed' = ANY(tags)`);
  }

  return { text: result.text, task, toolCalls, pool, infraFailed };
}

async function scoreSuite(pool: pg.Pool, suite: Suite): Promise<SuiteScore> {
  resetSuiteState();
  const failures: SuiteScore['failures'] = [];
  const softNotes: SuiteScore['failures'] = [];
  const caseResults: SuiteScore['caseResults'] = {};
  let passed = 0;
  let skipped = 0;

  for (const c of suite.cases) {
    process.stdout.write(`  ${c.id} … `);
    let casePassed = true;
    let realFailure = false; // an assertion actually failed (vs the case being infra-skipped)
    try {
      const ctx = await runCase(pool, c);

      // Precondition: the payload-bearing tool must actually have run, else the
      // case tested nothing (vacuous pass). A missing precondition is a real FAIL,
      // never a skip — even a "model just abstained" run must not go green.
      const required = c.requiresTool ? (Array.isArray(c.requiresTool) ? c.requiresTool : [c.requiresTool]) : [];
      const preconditionMet = required.every((t) => ctx.toolCalls.some((tc) => tc.tool === t));

      if (ctx.infraFailed) {
        // Infra failure: OUTPUT assertions can't be judged, but TRACE assertions
        // still are — a forbidden tool_call that already happened is a real result.
        // A trace failure here is a genuine FAIL; otherwise the case is SKIPPED.
        const traceAssertions = c.assertions.filter((a) => a.traceBased);
        for (const a of traceAssertions) {
          const verdict = await a.check(ctx);
          if (verdict !== true) {
            realFailure = true;
            casePassed = false;
            failures.push({ caseId: c.id, assertion: `${a.name} [trace, on infra-fail]`, detail: String(verdict) });
          }
        }
        if (realFailure) {
          caseResults[c.id] = 'fail';
          console.log('FAIL (forbidden action on an infra-failed case)');
        } else {
          skipped++;
          caseResults[c.id] = 'skip';
          console.log('SKIP (rate-limit/quota — no forbidden action recorded)');
          await new Promise((r) => setTimeout(r, 8_000));
          continue;
        }
      } else {
        if (!preconditionMet) {
          realFailure = true;
          casePassed = false;
          failures.push({
            caseId: c.id,
            assertion: '(precondition)',
            detail: `required tool(s) never invoked: ${required.filter((t) => !ctx.toolCalls.some((tc) => tc.tool === t)).join(', ')} — case tested nothing`,
          });
        }
        for (const a of c.assertions) {
          const verdict = await a.check(ctx);
          if (verdict !== true) {
            if (a.soft) {
              // Reported but never gates (FC-021): flaky text-quality checks must
              // not flip a case's verdict or trigger a false regression.
              softNotes.push({ caseId: c.id, assertion: a.name, detail: String(verdict) });
            } else {
              realFailure = true;
              casePassed = false;
              failures.push({ caseId: c.id, assertion: a.name, detail: String(verdict) });
            }
          }
        }
      }
    } catch (err) {
      realFailure = true;
      casePassed = false;
      failures.push({ caseId: c.id, assertion: '(case crashed)', detail: err instanceof Error ? err.message : String(err) });
    }
    if (caseResults[c.id] !== 'skip') caseResults[c.id] = casePassed ? 'pass' : 'fail';
    if (casePassed) passed++;
    const softForCase = softNotes.filter((s) => s.caseId === c.id).length;
    console.log(casePassed ? `PASS${softForCase ? ` (${softForCase} soft note${softForCase > 1 ? 's' : ''})` : ''}` : 'FAIL');
    // pace cases so a suite doesn't burst through the per-minute free-tier quota
    await new Promise((r) => setTimeout(r, 8_000));
  }
  const scored = suite.cases.length - skipped;
  return {
    passed,
    scored,
    caseResults,
    total: suite.cases.length,
    skipped,
    score: scored > 0 ? passed / scored : 0,
    failures,
    softNotes,
  };
}

async function main() {
  const only = process.argv[2];
  const suites = only ? SUITES.filter((s) => s.name === only) : SUITES;
  if (!suites.length) {
    console.error(`unknown suite "${only}" — available: ${SUITES.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const model = process.env.MODEL_EXECUTION ?? '(provider default)';
  console.log(`gym: ${suites.length} suite(s) · execution model: ${model}\n`);

  const results: Record<string, SuiteScore> = {};
  for (const suite of suites) {
    console.log(`suite: ${suite.name}`);
    if (suite.cases.length === 0) {
      // A pack may bundle a suite whose cases aren't collected yet (support-triage
      // needs ~20 real tickets). Report honestly; never gate on an empty suite.
      console.log(`  → (no cases yet — pending collection)\n`);
      continue;
    }
    results[suite.name] = await scoreSuite(pool, suite);
    const r = results[suite.name]!;
    const skipNote = r.skipped ? ` · ${r.skipped} skipped (rate-limit)` : '';
    console.log(`  → ${r.passed}/${r.scored} scored (${Math.round(r.score * 100)}%)${skipNote}\n`);
  }

  for (const [name, r] of Object.entries(results)) {
    for (const f of r.failures) console.log(`FAIL ${name}/${f.caseId} · ${f.assertion}: ${f.detail}`);
    for (const s of r.softNotes) console.log(`soft ${name}/${s.caseId} · ${s.assertion}: ${s.detail} (non-gating, FC-021)`);
  }

  // A baseline is a REGRESSION TRIPWIRE, not a demand for 100% (blueprint §6:
  // "baselines.json: last accepted scores; CI fails on regression"). It records
  // per-case verdicts on the first COMPLETE run; thereafter a hard failure is:
  //   - REGRESSION: a case that PASSED in the baseline now fails (per-case, so a
  //     swapped failure is caught even at a flat score), OR
  //   - GATE breach: a gate100 suite (M5+) scoring < 100%, OR
  //   - CRASH: the harness/tool threw (not a measured model behavior).
  // Known-failing cases baked into the baseline (e.g. FC-018) are NOT failures.
  interface BaseSuite { score: number; passed: number; total: number; caseResults: Record<string, 'pass' | 'fail' | 'skip'> }
  const baselines: Record<string, BaseSuite> = existsSync(baselinesPath)
    ? (JSON.parse(readFileSync(baselinesPath, 'utf8')) as { suites: Record<string, BaseSuite> }).suites ?? {}
    : {};
  const haveBaseline = existsSync(baselinesPath);

  let hardFailure = false;
  for (const suite of suites) {
    const r = results[suite.name];
    if (!r) continue; // empty suite (cases not collected yet) — nothing to gate on
    // Crash = harness/tool threw, always a hard failure.
    const crashed = r.failures.filter((f) => f.assertion === '(case crashed)');
    if (crashed.length) {
      console.log(`\nCRASH: ${suite.name} — ${crashed.map((c) => c.caseId).join(', ')}`);
      hardFailure = true;
    }
    if (suite.gate100 && r.scored > 0 && r.score < 1) {
      console.log(`\nGATE: ${suite.name} must be 100% (got ${Math.round(r.score * 100)}% over scored cases)`);
      hardFailure = true;
    }
    const base = baselines[suite.name];
    if (base) {
      for (const [caseId, prior] of Object.entries(base.caseResults)) {
        if (prior === 'pass' && r.caseResults[caseId] === 'fail') {
          console.log(`\nREGRESSION: ${suite.name}/${caseId} passed in baseline, now FAILS`);
          hardFailure = true;
        }
      }
    }
  }

  const anySkipped = Object.values(results).some((r) => r.skipped > 0);
  const reportsDir = join(evalsDir, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  if (hardFailure) {
    console.log('\nFAILED: regression / gate / crash above (a skip elsewhere does not excuse it).');
    writeFileSync(join(reportsDir, `${stamp()}-failed.json`), JSON.stringify({ model, results }, null, 2));
    await pool.end();
    process.exit(1);
  }

  // Establish the baseline on the first COMPLETE run, OR deliberately REFRESH it
  // with EVAL_REFRESH_BASELINE=1 (e.g. after adding suites — the committed
  // baseline predates planning/research/whatsapp, so those have no tripwire yet).
  // Refresh is gated on cleanliness: we reach here only past the hardFailure exit
  // (no crash/gate/regression), and a run with skips can't establish a baseline.
  const refresh = process.env.EVAL_REFRESH_BASELINE === '1';
  if (!haveBaseline || refresh) {
    if (anySkipped) {
      const why = haveBaseline ? 'refresh requested' : 'no baseline exists';
      console.log(`\nINCONCLUSIVE: ${why} but this run had skips — cannot ${haveBaseline ? 'refresh' : 'establish'} a baseline from an incomplete run.`);
      writeFileSync(join(reportsDir, `${stamp()}-inconclusive.json`), JSON.stringify({ model, results }, null, 2));
      await pool.end();
      process.exit(0);
    }
    writeFileSync(
      baselinesPath,
      JSON.stringify(
        {
          recorded_at: new Date().toISOString(),
          model,
          suites: Object.fromEntries(
            Object.entries(results).map(([k, v]) => [k, { score: v.score, passed: v.passed, total: v.total, caseResults: v.caseResults }]),
          ),
        },
        null,
        2,
      ),
    );
    const knownFails = Object.values(results).flatMap((r) => Object.entries(r.caseResults).filter(([, v]) => v === 'fail').map(([k]) => k));
    const verb = haveBaseline ? 'BASELINE REFRESHED' : 'BASELINE ESTABLISHED';
    console.log(`\n${verb} → evals/baselines.json (${Object.keys(results).length} suites)${knownFails.length ? ` (known-failing, baked in: ${knownFails.join(', ')})` : ' — all green'}`);
  } else if (anySkipped) {
    console.log('\nINCONCLUSIVE: no regression vs baseline, but some cases skipped for quota — baseline unchanged.');
  } else {
    console.log('\nPASS: no regression vs baseline; all cases scored.');
  }

  const reportPath = join(reportsDir, `${stamp()}.json`);
  writeFileSync(reportPath, JSON.stringify({ model, results }, null, 2));
  console.log(`report → ${reportPath}`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
