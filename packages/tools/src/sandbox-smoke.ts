// Deterministic sandbox-isolation checks (no model). Proves the ADR-0009
// guarantees against real Docker: runs code, non-root, read-only rootfs, no host
// FS, no network, and killed on timeout. Run: tsx packages/tools/src/sandbox-smoke.ts
import { DockerSandbox } from './docker-sandbox.js';

const sbx = new DockerSandbox();
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const sh = (script: string, timeoutMs = 30_000) =>
  sbx.run({ image: 'alpine:3', cmd: ['sh', '/work/run.sh'], files: { 'run.sh': script }, timeoutMs });

// 1. runs code, captures stdout, exit 0
const r1 = await sh('echo hello-from-sandbox');
check('runs code & captures stdout', r1.exitCode === 0 && r1.stdout.includes('hello-from-sandbox'), `exit=${r1.exitCode}`);

// 2. non-root
const r2 = await sh('id -u');
check('runs as non-root (uid 1000)', r2.stdout.trim() === '1000', `uid=${r2.stdout.trim()}`);

// 3. read-only root filesystem — write to / fails, write to /work succeeds
const r3 = await sh('touch /nope 2>&1 || echo ROOT_RO; touch /work/ok && echo WORK_RW');
check('root filesystem is read-only', r3.stdout.includes('ROOT_RO'));
check('workspace is writable', r3.stdout.includes('WORK_RW'));

// 4. no network (deny by default)
const r4 = await sh('wget -T 3 -q -O- http://example.com >/dev/null 2>&1 && echo NET_OK || echo NET_BLOCKED');
check('network denied by default', r4.stdout.includes('NET_BLOCKED'), r4.stdout.trim());

// 5. no host filesystem — the host cwd/files are not visible; /work has only what we put
const r5 = await sh('ls /work');
check('workspace holds only mounted files (run.sh)', r5.stdout.trim() === 'run.sh', `ls=${r5.stdout.trim()}`);

// 6. killed on timeout
const start = Date.now();
const r6 = await sh('sleep 30; echo SHOULD_NOT_PRINT', 4000);
const elapsed = Date.now() - start;
check('killed on timeout', r6.timedOut && !r6.stdout.includes('SHOULD_NOT_PRINT') && elapsed < 15000, `timedOut=${r6.timedOut} elapsed=${elapsed}ms`);

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
