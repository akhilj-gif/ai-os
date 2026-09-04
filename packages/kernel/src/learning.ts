// Learning Loop (blueprint §M10, ADR-0014): the OS improves itself. Its exact
// symmetry with the coding loop (M6) is the whole idea —
//   coding loop:   propose diff  → run TESTS in the sandbox → adopt iff exit 0
//   learning loop: propose playbook → run the GYM            → adopt iff no regression
// Both trust an OBJECTIVE verifier, never the model's claim. A proposed
// self-improvement (a procedural "playbook" memory) is adopted ONLY if the gym
// proves it doesn't regress the baseline; otherwise it's rejected or queued for
// review. Every proposal is an auditable `improvements` row, and the system is
// never left worse than it started (fail-closed).
import type pg from 'pg';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newTraceId, parseModelJson, TraceStore } from '@ai-os/shared';
import { callModel } from '@ai-os/model-router';
import { MemoryService } from '@ai-os/memory';

export interface FailureSignal {
  failedTasks: Array<{ goal: string; error: string }>;
  totalFailed: number;
  /** Memory OS signals (Tier 4): the OS's own distilled failure lessons and
   *  generalized insights — richer learning fuel than raw trace errors alone. */
  failureMemories: string[];
  insights: string[];
}

export interface Playbook {
  subject: string; // stable key — supersedes a prior playbook on the same subject
  content: string; // the procedural guidance to inject into future task context
}
export interface ImprovementCandidate {
  source: string;
  rationale: string;
  playbook: Playbook;
}
export interface Proposer {
  (signals: FailureSignal): Promise<ImprovementCandidate[]>;
}

export interface Verdict {
  regressed: boolean; // any baseline PASS → FAIL under the candidate
  adopt: boolean; // safe to adopt (no regression; slice-1 bar). improved is a bonus.
  detail: string;
}
export interface Verifier {
  (candidate: ImprovementCandidate): Promise<Verdict>;
}

export interface LearningResult {
  taskId: string;
  proposed: number;
  adopted: string[]; // subjects adopted
  rejected: string[];
  queued: string[];
  improvements: string[]; // improvement row ids
}

// Learning must target BEHAVIORAL failures, not environment noise. A rate-limit /
// quota / network error is the world's fault, not a mistake the agent can learn to
// avoid — feeding those in just produces "manage your rate limits" playbooks.
const INFRA_ERR = /INFRA_(RATELIMIT|NETWORK)|rate.?limit|quota|\b429\b|\b503\b/i;

/** Gather what to learn FROM: recent failed tasks + their error, EXCLUDING infra
 *  failures (quota/rate-limit/network) — those aren't learnable behavior. Pure DB. */
export async function gatherFailureSignals(pool: pg.Pool, limit = 15): Promise<FailureSignal> {
  const { rows } = await pool.query<{ goal: string; error: string | null }>(
    `SELECT t.goal, (te.payload->>'error') AS error
     FROM tasks t
     LEFT JOIN LATERAL (
       SELECT payload FROM trace_events
       WHERE task_id = t.id AND event = 'task.failed'
       ORDER BY ts DESC LIMIT 1
     ) te ON true
     WHERE t.status = 'failed'
     ORDER BY t.updated_at DESC
     LIMIT $1`,
    [limit * 4], // over-fetch, then drop infra noise below
  );
  const behavioral = rows.filter((r) => !INFRA_ERR.test(r.error ?? '')).slice(0, limit);
  // Memory OS fuel: the OS's own distilled failure lessons + generalized insights.
  const fm = await pool.query<{ content: string }>(
    `SELECT content FROM memory_records WHERE type='failure' AND superseded_by IS NULL ORDER BY last_confirmed_at DESC LIMIT 12`,
  );
  const ins = await pool.query<{ content: string }>(
    `SELECT content FROM memory_records WHERE 'insight' = ANY(tags) AND superseded_by IS NULL ORDER BY last_confirmed_at DESC LIMIT 8`,
  );
  return {
    failedTasks: behavioral.map((r) => ({ goal: r.goal, error: r.error ?? '(no recorded error)' })),
    // "totalFailed" reflects the learnable population, not quota casualties.
    totalFailed: rows.filter((r) => !INFRA_ERR.test(r.error ?? '')).length,
    failureMemories: fm.rows.map((r) => r.content).filter((c) => !INFRA_ERR.test(c)),
    insights: ins.rows.map((r) => r.content),
  };
}

const PROPOSE_SYSTEM = `You are the reflection engine of a personal AI OS. From recent FAILED tasks, the OS's own distilled FAILURE LESSONS, and its generalized INSIGHTS, propose small, GENERAL procedural "playbooks" that make the agent behave better next time — durable guidance, not a fix for one task.
Return STRICT JSON: {"candidates":[{"source":"failed-tasks|failure-memory|insight","rationale":"one line: root cause → why this helps","playbook":{"subject":"kebab-case-topic","content":"one or two imperative sentences the agent should follow"}}]}
Rules: at most 3 candidates; each playbook must be GENERAL (no task-specific ids/names) and ACTIONABLE; prefer turning a recurring failure or a strong insight into a concrete behavior; no prose outside the JSON; do not call tools.`;

/** The default LLM proposer — root-cause analysis over failures + Memory OS signals. */
export function llmProposer(pool: pg.Pool, ids: { taskId: string; traceId: string }): Proposer {
  return async (signals) => {
    // Propose if there's ANY learnable signal — failed tasks, distilled failure
    // lessons, or insights (the OS can improve from what it learned, not only crashes).
    if (signals.failedTasks.length === 0 && signals.failureMemories.length === 0 && signals.insights.length === 0) return [];
    const evidence = [
      signals.failedTasks.length ? `FAILED TASKS:\n${signals.failedTasks.map((t, i) => `${i + 1}. GOAL: ${t.goal}\n   ERROR: ${t.error.slice(0, 300)}`).join('\n')}` : '',
      signals.failureMemories.length ? `DISTILLED FAILURE LESSONS:\n${signals.failureMemories.map((c) => `- ${c}`).join('\n')}` : '',
      signals.insights.length ? `INSIGHTS:\n${signals.insights.map((c) => `- ${c}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const resp = await callModel({
      role: 'planning',
      system: PROPOSE_SYSTEM,
      prompt: `Learnable signals (${signals.totalFailed} behavioral failures total):\n${evidence}`,
      maxTokens: 900, // under Groq's 1,000 OTPM ceiling — see executor.ts
      traceId: ids.traceId,
      taskId: ids.taskId,
      name: 'learning-propose',
    });
    const parsed = parseModelJson<{ candidates?: ImprovementCandidate[] }>(resp.text);
    if (!parsed) return [];
    return (parsed.candidates ?? []).filter((c) => c.playbook?.subject && c.playbook?.content);
  };
}

const evalsRunner = fileURLToPath(new URL('../../../evals/runner.ts', import.meta.url));

/** The gym verifier: run the FULL gym with the candidate playbook injected into
 *  every case's context (EVAL_CANDIDATE_MEMORY). The runner already fails (exit 1)
 *  on ANY regression vs the recorded baseline — so exit 0 = safe to adopt, exit 1 =
 *  the candidate broke something. This reuses the entire FC-020 regression gate. */
export function gymVerifier(opts: { model?: string } = {}): Verifier {
  return (candidate) =>
    new Promise<Verdict>((resolve) => {
      const env = {
        ...process.env,
        EVAL_CANDIDATE_MEMORY: JSON.stringify(candidate.playbook),
        ...(opts.model ? { MODEL_EXECUTION: opts.model } : {}),
      };
      // Run the gym the same way the project does (`npx tsx runner.ts`); shell on
      // Windows so the npx shim resolves.
      const p = spawn('npx', ['tsx', evalsRunner], { env, shell: process.platform === 'win32' });
      let out = '';
      const cap = (d: Buffer) => (out += d.toString());
      p.stdout.on('data', cap);
      p.stderr.on('data', cap);
      p.on('close', (code) => {
        const inconclusive = /INCONCLUSIVE/.test(out);
        if (inconclusive) resolve({ regressed: false, adopt: false, detail: 'gym INCONCLUSIVE (quota) — cannot verify; queued' });
        else if (code === 0) resolve({ regressed: false, adopt: true, detail: 'gym clean: no regression vs baseline' });
        else resolve({ regressed: true, adopt: false, detail: `gym regression/gate (exit ${code}) — ${(out.match(/REGRESSION:[^\n]*/) ?? ['regression'])[0]}` });
      });
      p.on('error', (e) => resolve({ regressed: false, adopt: false, detail: `gym could not run: ${e.message}` }));
    });
}

/**
 * Run one learning cycle: gather → propose → verify each candidate → adopt (only
 * if the gym is clean) / reject / queue. ADOPTED playbooks become procedural
 * memories (provenance = this cycle's task). The system is never left worse:
 * candidates are verified in isolation and only clean ones persist.
 */
export async function runLearningCycle(
  pool: pg.Pool,
  opts: { propose?: Proposer; verify?: Verifier; autoAdopt?: boolean; signals?: FailureSignal } = {},
): Promise<LearningResult> {
  const traceId = newTraceId();
  const trace = new TraceStore(pool);
  const memory = new MemoryService(pool);
  const autoAdopt = opts.autoAdopt ?? true;

  const task = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ('learning: self-improvement cycle','running','schedule',$1) RETURNING id`,
    [traceId],
  );
  const taskId = task.rows[0]!.id;
  const propose = opts.propose ?? llmProposer(pool, { taskId, traceId });
  const verify = opts.verify ?? gymVerifier();

  const signals = opts.signals ?? (await gatherFailureSignals(pool));
  await trace.record({ traceId, taskId, component: 'learning', event: 'cycle.started', payload: { failedTasks: signals.failedTasks.length } });

  const result: LearningResult = { taskId, proposed: 0, adopted: [], rejected: [], queued: [], improvements: [] };

  let candidates: ImprovementCandidate[] = [];
  try {
    candidates = await propose(signals);
  } catch (err) {
    await trace.record({ traceId, taskId, component: 'learning', event: 'propose.failed', payload: { error: err instanceof Error ? err.message : String(err) } });
  }
  result.proposed = candidates.length;

  for (const c of candidates) {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO improvements (source, rationale, artifact, status, task_id) VALUES ($1,$2,$3,'verifying',$4) RETURNING id`,
      [c.source, c.rationale, JSON.stringify({ kind: 'playbook', ...c.playbook }), taskId],
    );
    const impId = row.rows[0]!.id;
    result.improvements.push(impId);

    let verdict: Verdict;
    try {
      verdict = await verify(c);
    } catch (err) {
      // Fail-closed: a verifier that throws must NEVER adopt.
      verdict = { regressed: false, adopt: false, detail: `verify threw: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (verdict.adopt && autoAdopt) {
      const mem = await memory.remember({
        type: 'procedural',
        subject: c.playbook.subject, // supersedes any prior playbook on the same subject
        content: c.playbook.content,
        tags: ['learned'],
        source: { task_id: taskId },
      });
      await pool.query(`UPDATE improvements SET status='adopted', verdict=$2, memory_id=$3, decided_at=now() WHERE id=$1`, [impId, JSON.stringify(verdict), mem.id]);
      result.adopted.push(c.playbook.subject);
      await trace.record({ traceId, taskId, component: 'learning', event: 'improvement.adopted', payload: { subject: c.playbook.subject, memoryId: mem.id } });
    } else if (verdict.regressed) {
      await pool.query(`UPDATE improvements SET status='rejected', verdict=$2, decided_at=now() WHERE id=$1`, [impId, JSON.stringify(verdict)]);
      result.rejected.push(c.playbook.subject);
      await trace.record({ traceId, taskId, component: 'learning', event: 'improvement.rejected', payload: { subject: c.playbook.subject, detail: verdict.detail } });
    } else {
      // Clean but not auto-adopted (or inconclusive) → queue for human review.
      await pool.query(`UPDATE improvements SET status='queued', verdict=$2, decided_at=now() WHERE id=$1`, [impId, JSON.stringify(verdict)]);
      result.queued.push(c.playbook.subject);
      await trace.record({ traceId, taskId, component: 'learning', event: 'improvement.queued', payload: { subject: c.playbook.subject, detail: verdict.detail } });
    }
  }

  await pool.query(`UPDATE tasks SET status='done', updated_at=now() WHERE id=$1`, [taskId]);
  await trace.record({ traceId, taskId, component: 'learning', event: 'cycle.done', payload: { adopted: result.adopted.length, rejected: result.rejected.length, queued: result.queued.length } });
  return result;
}
