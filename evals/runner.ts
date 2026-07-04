// The gym (blueprint §6, docs/EVAL-SPEC.md). Runs suites through the REAL
// executor loop with mocked tools where cases specify them, scores with
// tier-1/2 assertions, compares against baselines.json, and exits non-zero on
// regression. `pnpm eval [suite]` — this exit code IS the release gate.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import pg from 'pg';
import { newTraceId } from '@ai-os/shared';
import { runTask } from '@ai-os/kernel';
import { buildRegistry, ToolRegistry } from '@ai-os/tools';
import type { EvalCase, Suite, CaseContext } from './lib/types.js';
import { injectionDefense } from './suites/injection-defense.js';
import { toolReliability, resetSuiteState } from './suites/tool-reliability.js';

const SUITES: Suite[] = [toolReliability, injectionDefense];
const evalsDir = dirname(fileURLToPath(import.meta.url));
const baselinesPath = join(evalsDir, 'baselines.json');

interface SuiteScore {
  passed: number;
  /** cases that actually executed (total minus infra-skipped) — the scoring denominator */
  scored: number;
  total: number;
  skipped: number;
  score: number;
  failures: Array<{ caseId: string; assertion: string; detail: string }>;
}

function registryFor(evalCase: EvalCase): ToolRegistry {
  const base = buildRegistry();
  const registry = new ToolRegistry();
  for (const schema of base.list()) {
    const real = base.get(schema.name)!;
    const mock = evalCase.mocks?.[schema.name];
    registry.register({ ...schema, execute: mock ? (args) => mock(args) : real.execute.bind(real) });
  }
  for (const extra of evalCase.extraTools ?? []) {
    registry.register({ ...extra, execute: (args) => extra.execute(args) });
  }
  return registry;
}

async function runCase(pool: pg.Pool, evalCase: EvalCase): Promise<CaseContext> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1, 'draft', 'trigger', $2) RETURNING id`,
    [`[eval:${evalCase.id}] ${evalCase.goal}`, newTraceId()],
  );
  const taskId = rows[0]!.id;
  const result = await runTask(pool, taskId, { registry: registryFor(evalCase) });

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

  // A task that failed on a provider quota/rate-limit error is an infra skip,
  // not a real assertion result (FC-017) — keeps a quota-starved run from
  // masquerading as a security/reliability regression.
  let infraFailed = false;
  if (task.status === 'failed') {
    const errs = await pool.query<{ error: string | null }>(
      `SELECT error FROM steps WHERE task_id = $1 AND error IS NOT NULL`,
      [taskId],
    );
    infraFailed = errs.rows.some((r) => /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(r.error ?? ''));
  }

  return { text: result.text, task, toolCalls, pool, infraFailed };
}

async function scoreSuite(pool: pg.Pool, suite: Suite): Promise<SuiteScore> {
  resetSuiteState();
  const failures: SuiteScore['failures'] = [];
  let passed = 0;
  let skipped = 0;

  for (const c of suite.cases) {
    process.stdout.write(`  ${c.id} … `);
    let casePassed = true;
    try {
      const ctx = await runCase(pool, c);
      if (ctx.infraFailed) {
        skipped++;
        console.log('SKIP (rate-limit/quota)');
        await new Promise((r) => setTimeout(r, 8_000));
        continue;
      }
      for (const a of c.assertions) {
        const verdict = await a.check(ctx);
        if (verdict !== true) {
          casePassed = false;
          failures.push({ caseId: c.id, assertion: a.name, detail: String(verdict) });
        }
      }
    } catch (err) {
      casePassed = false;
      failures.push({ caseId: c.id, assertion: '(case crashed)', detail: err instanceof Error ? err.message : String(err) });
    }
    if (casePassed) passed++;
    console.log(casePassed ? 'PASS' : 'FAIL');
    // pace cases so a suite doesn't burst through the per-minute free-tier quota
    await new Promise((r) => setTimeout(r, 8_000));
  }
  const scored = suite.cases.length - skipped;
  return {
    passed,
    scored,
    total: suite.cases.length,
    skipped,
    score: scored > 0 ? passed / scored : 0,
    failures,
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
    results[suite.name] = await scoreSuite(pool, suite);
    const r = results[suite.name]!;
    const skipNote = r.skipped ? ` · ${r.skipped} skipped (rate-limit)` : '';
    console.log(`  → ${r.passed}/${r.scored} scored (${Math.round(r.score * 100)}%)${skipNote}\n`);
  }

  for (const [name, r] of Object.entries(results)) {
    for (const f of r.failures) console.log(`FAIL ${name}/${f.caseId} · ${f.assertion}: ${f.detail}`);
  }

  // A run with ANY infra-skips is inconclusive: it cannot set a baseline or trip
  // the gate (FC-017). Report and exit cleanly so CI doesn't record noise.
  const anySkipped = Object.values(results).some((r) => r.skipped > 0);
  if (anySkipped) {
    console.log('\nINCONCLUSIVE: some cases were skipped for rate-limit/quota — not scoring against baseline.');
    console.log('Re-run when quota is available (or point MODEL_EXECUTION at a paid/local model).');
    const reportsDir = join(evalsDir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-inconclusive.json`),
      JSON.stringify({ model, results }, null, 2),
    );
    await pool.end();
    process.exit(0);
  }

  // Baseline gate (EVAL-SPEC §4): regression = failure; baseline updates are a
  // deliberate human act — delete/edit baselines.json in the same commit that
  // changes behavior.
  const baselines: Record<string, { score: number }> = existsSync(baselinesPath)
    ? (JSON.parse(readFileSync(baselinesPath, 'utf8')) as { suites: Record<string, { score: number }> }).suites ?? {}
    : {};

  let failed = false;
  for (const suite of suites) {
    const r = results[suite.name]!;
    if (suite.gate100 && r.score < 1) {
      console.log(`\nGATE: ${suite.name} must be 100% (got ${Math.round(r.score * 100)}%)`);
      failed = true;
    }
    const base = baselines[suite.name];
    if (base && r.score < base.score) {
      console.log(`\nREGRESSION: ${suite.name} ${Math.round(r.score * 100)}% < baseline ${Math.round(base.score * 100)}%`);
      failed = true;
    }
  }

  // Record baselines on first full run
  if (!only && !existsSync(baselinesPath) && !failed) {
    writeFileSync(
      baselinesPath,
      JSON.stringify(
        {
          recorded_at: new Date().toISOString(),
          model,
          suites: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { score: v.score, passed: v.passed, total: v.total }])),
        },
        null,
        2,
      ),
    );
    console.log(`\nbaselines recorded → evals/baselines.json`);
  }

  const reportsDir = join(evalsDir, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, JSON.stringify({ model, results }, null, 2));
  console.log(`report → ${reportPath}`);

  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
