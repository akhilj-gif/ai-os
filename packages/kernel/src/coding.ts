// Coding engine (blueprint §M6): a TEST-DRIVEN fix loop. Propose a change →
// apply to a working copy → run the tests in the Docker sandbox → if red, feed the
// failure back and iterate → stop when green. The change is never applied to the
// real tree here; the loop returns the passing fileset + a diff for approval (the
// M4 approval gate / git commit is the last mile). Runs entirely in the sandbox —
// no host code execution.
import type pg from 'pg';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { newTraceId, parseModelJson, TraceStore } from '@ai-os/shared';
import { callModel } from '@ai-os/model-router';
import { dockerSandbox } from '@ai-os/tools';

export interface RepoFile {
  path: string;
  content: string;
}
export interface ProposedFix {
  files: RepoFile[]; // full-file replacements/additions (robust than diffs for an LLM)
  rationale: string;
}
export interface Proposer {
  (ctx: { instruction: string; files: Record<string, string>; lastFailure?: string }): Promise<ProposedFix>;
}

export interface CodingResult {
  status: 'passed' | 'failed';
  rounds: number;
  rationale: string;
  changedFiles: string[];
  files: Record<string, string>; // final working set
  testOutput: string;
  taskId: string;
}

const IMAGES: Record<string, string> = {
  python: 'python:3.12-alpine',
  node: 'node:24-alpine',
  sh: 'alpine:3',
};

/** The default LLM proposer. Structured full-file output; strict "return JSON". */
export function llmProposer(pool: pg.Pool, ids: { taskId: string; traceId: string }): Proposer {
  return async ({ instruction, files, lastFailure }) => {
    const fileBlocks = Object.entries(files)
      .map(([p, c]) => `--- ${p} ---\n${c}`)
      .join('\n\n');
    const resp = await callModel({
      role: 'planning',
      system: `You are a coding engine. Given the repository files and a task, return a fix as STRICT JSON:
{"rationale":"one line","files":[{"path":"...","content":"FULL new file content"}]}
Only include files you change or add. Return COMPLETE file contents, not diffs. No prose outside the JSON. Do not call tools.`,
      prompt: [
        `TASK: ${instruction}`,
        lastFailure ? `The previous attempt FAILED its tests:\n${lastFailure.slice(0, 2000)}\nFix it.` : '',
        `FILES:\n${fileBlocks}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      maxTokens: 2000,
      traceId: ids.traceId,
      taskId: ids.taskId,
      name: 'coding-propose',
    });
    const parsed = parseModelJson<ProposedFix>(resp.text);
    if (!parsed) throw new Error('proposer returned no parseable JSON');
    return { rationale: parsed.rationale ?? '', files: parsed.files ?? [] };
  };
}

export async function runCodingTask(
  pool: pg.Pool,
  opts: {
    instruction: string;
    files: Record<string, string>; // the starting repo
    testCmd: string; // e.g. "python -m pytest -q" or "node test.js"
    language?: 'python' | 'node' | 'sh';
    maxRounds?: number;
    egress?: boolean; // allow network in the test sandbox (for dep installs)
    propose?: Proposer; // override for tests; defaults to the LLM proposer
  },
): Promise<CodingResult> {
  const traceId = newTraceId();
  const trace = new TraceStore(pool);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1, 'running', 'user', $2) RETURNING id`,
    [`code: ${opts.instruction}`, traceId],
  );
  const taskId = rows[0]!.id;
  const image = IMAGES[opts.language ?? 'python'] ?? IMAGES.python!;
  const maxRounds = opts.maxRounds ?? 3;
  const propose = opts.propose ?? llmProposer(pool, { taskId, traceId });

  const working = { ...opts.files };
  const changed = new Set<string>();
  let rationale = '';
  let lastFailure: string | undefined;
  let testOutput = '';

  await trace.record({ traceId, taskId, component: 'coding', event: 'coding.started', payload: { instruction: opts.instruction } });

  for (let round = 1; round <= maxRounds; round++) {
    let fix: ProposedFix;
    try {
      fix = await propose({ instruction: opts.instruction, files: working, lastFailure });
    } catch (err) {
      testOutput = `proposer error: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    for (const f of fix.files) {
      working[f.path] = f.content;
      changed.add(f.path);
    }
    rationale = fix.rationale || rationale;

    const res = await dockerSandbox().run({
      image,
      cmd: ['sh', '-c', opts.testCmd],
      files: working,
      timeoutMs: 120_000,
      egressAllowlist: opts.egress ? ['*'] : undefined,
    });
    testOutput = `exit ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}\n${res.stdout}\n${res.stderr}`.trim();
    await trace.record({ traceId, taskId, component: 'coding', event: 'coding.tested', payload: { round, exit: res.exitCode } });

    if (res.exitCode === 0 && !res.timedOut) {
      await pool.query(`UPDATE tasks SET status='done', updated_at=now() WHERE id=$1`, [taskId]);
      await trace.record({ traceId, taskId, component: 'coding', event: 'coding.passed', payload: { round, changed: [...changed] } });
      return { status: 'passed', rounds: round, rationale, changedFiles: [...changed], files: working, testOutput, taskId };
    }
    lastFailure = testOutput;
  }

  await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
  await trace.record({ traceId, taskId, component: 'coding', event: 'coding.failed', payload: { rounds: maxRounds } });
  return { status: 'failed', rounds: maxRounds, rationale, changedFiles: [...changed], files: working, testOutput, taskId };
}

/** Run a git command in `cwd`. Deterministic host op — never runs untrusted code. */
function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn('git', args, { cwd });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => res({ code: code ?? -1, stdout: out, stderr: err }));
    p.on('error', (e) => res({ code: -1, stdout: '', stderr: String(e) }));
  });
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
  branch?: string;
  diff: string;
  message: string;
}

/**
 * The last mile of the loop: commit an APPROVED, green CodingResult to a real git
 * repo. After the sandbox proved the change passes and a human approved it (M4
 * approval gate), write the changed files into the working tree and commit them on a
 * branch. Deterministic host git — consistent with the workspace write tool; the only
 * code that ever *ran* did so in the sandbox. Refuses to commit a change whose tests
 * are not green (fail-closed). Stops at a local commit; pushing / opening a PR needs a
 * remote + gh auth and is the caller's explicit, separately-approved step.
 */
export async function commitApproved(
  result: CodingResult,
  opts: { repoPath: string; message: string; branch?: string },
): Promise<CommitResult> {
  if (result.status !== 'passed') throw new Error('refusing to commit: tests are not green');
  const repo = resolve(opts.repoPath);
  const inside = await git(repo, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw new Error(`${repo} is not a git work tree`);

  if (opts.branch) await git(repo, ['checkout', '-B', opts.branch]);

  for (const rel of result.changedFiles) {
    const abs = resolve(repo, rel);
    if (abs !== repo && !abs.startsWith(repo + sep)) throw new Error(`path escapes repo: ${rel}`); // safety
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, result.files[rel] ?? '', 'utf8');
  }
  await git(repo, ['add', ...result.changedFiles]);
  const commit = await git(repo, ['commit', '-m', opts.message]);
  if (commit.code !== 0) return { committed: false, diff: '', message: `${opts.message} — ${commit.stderr.trim()}` };
  const sha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const diff = (await git(repo, ['show', '--stat', 'HEAD'])).stdout;
  return { committed: true, sha, branch, diff, message: opts.message };
}
