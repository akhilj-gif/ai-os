// Deterministic commit-on-approval check (NO model). Proves the loop's last mile:
// a green, approved CodingResult is written into a real git repo and committed on a
// branch — and a NON-green result is refused (fail-closed). Uses a throwaway git repo
// in the OS temp dir; no network, no model. Run: tsx packages/kernel/src/coding-commit-smoke.ts
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitApproved, type CodingResult } from './coding.js';

const g = (cwd: string, args: string[]) =>
  new Promise<string>((res, rej) => {
    const p = spawn('git', args, { cwd });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? res(out) : rej(new Error(err))));
  });

let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

// Set up a throwaway repo with the buggy file already committed.
const repo = await mkdtemp(join(tmpdir(), 'ai-os-commit-'));
await g(repo, ['init', '-q']);
await g(repo, ['config', 'user.email', 'ci@ai-os.local']);
await g(repo, ['config', 'user.name', 'ai-os']);
await writeFile(join(repo, 'calc.py'), 'def add(a, b):\n    return a - b\n');
await g(repo, ['add', '-A']);
await g(repo, ['commit', '-qm', 'initial (buggy)']);
const baseSha = (await g(repo, ['rev-parse', 'HEAD'])).trim();

// A green result carrying the fix (as the loop would produce it).
const green: CodingResult = {
  status: 'passed',
  rounds: 2,
  rationale: 'use addition',
  changedFiles: ['calc.py'],
  files: { 'calc.py': 'def add(a, b):\n    return a + b\n' },
  testOutput: 'exit 0\nOK',
  taskId: 'test',
};

const commit = await commitApproved(green, { repoPath: repo, message: 'fix: add() should add', branch: 'ai-os/fix-add' });
check('committed the approved change', commit.committed, commit.message);
check('created a new commit (sha changed)', !!commit.sha && commit.sha !== baseSha, commit.sha?.slice(0, 8));
check('committed on the requested branch', commit.branch === 'ai-os/fix-add', commit.branch);
const onDisk = await readFile(join(repo, 'calc.py'), 'utf8');
check('working tree has the fix', onDisk.includes('a + b'));
const committedBlob = await g(repo, ['show', 'HEAD:calc.py']);
check('the fix is in the commit (not just the tree)', committedBlob.includes('a + b'));
const status = await g(repo, ['status', '--porcelain']);
check('tree is clean after commit (nothing dangling)', status.trim() === '', JSON.stringify(status.trim()));

// Fail-closed: a non-green result must be refused, never committed.
const red: CodingResult = { ...green, status: 'failed' };
let refused = false;
try {
  await commitApproved(red, { repoPath: repo, message: 'should not happen' });
} catch {
  refused = true;
}
check('refuses to commit a non-green result (fail-closed)', refused);

// Safety: a path escaping the repo is rejected.
const escape: CodingResult = { ...green, changedFiles: ['../evil.py'], files: { '../evil.py': 'x' } };
let blocked = false;
try {
  await commitApproved(escape, { repoPath: repo, message: 'escape' });
} catch {
  blocked = true;
}
check('rejects a path escaping the repo', blocked);

await rm(repo, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
