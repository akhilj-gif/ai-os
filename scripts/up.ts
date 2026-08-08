// `pnpm up` — cold → fully running, health-gated. The one command to start the OS.
// Ensures Docker + Postgres are healthy, migrates, then hands the long-running
// services to pm2 (auto-restart on crash). Idempotent: safe to run repeatedly.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C, run, runLive, dockerDaemonUp, dockerDesktopStart, pgReady, httpUp, waitFor, API, BRIDGE, WEB } from './ops.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log(C.bold('\n▶ ai-os up\n'));

// 1. Docker daemon must be running. Auto-start Docker Desktop if it's down (so a
//    boot-on-login / post-sleep recovery is hands-free); only bail if it never
//    comes up.
if (!(await dockerDaemonUp())) {
  console.log(C.yellow('• Docker daemon down — launching Docker Desktop…'));
  if (!(await dockerDesktopStart())) {
    console.log(C.red('✗ Docker daemon did not come up.'));
    console.log('  Start Docker Desktop manually, then re-run `pnpm os:up`.');
    console.log(C.dim('  (If it is open but wedged: quit it, rename %LOCALAPPDATA%\\Docker\\run, relaunch.)'));
    process.exit(1);
  }
}
console.log(C.green('✓ Docker daemon up'));

// 2. Bring up the infra containers (idempotent).
console.log('\n▶ docker compose up -d');
await runLive('docker', ['compose', 'up', '-d'], { cwd: join(root, 'infra') });

// 3. Wait for Postgres to accept connections before migrating.
if (!(await waitFor('postgres', pgReady, 90_000))) {
  console.log(C.red('✗ Postgres never became ready — check `docker compose logs postgres`.'));
  process.exit(1);
}

// 4. Migrate (idempotent — applied migrations are skipped).
console.log('\n▶ migrations');
const mig = await run('node', ['--import', 'tsx', join(root, 'infra/migrate.ts')], { cwd: root, timeoutMs: 90_000 });
console.log(mig.out.trim().split('\n').slice(-6).map((l) => '  ' + l).join('\n'));
if (mig.code !== 0) { console.log(C.red('✗ migration failed')); process.exit(1); }

// 5. Hand the services to pm2 (clean slate each up, then start from the ecosystem).
console.log('\n▶ pm2 services');
await run('npx', ['pm2', 'delete', join(root, 'ecosystem.config.cjs')], { cwd: root, timeoutMs: 30_000 }); // ignore "not found"
const start = await runLive('npx', ['pm2', 'start', join(root, 'ecosystem.config.cjs')], { cwd: root });
if (start !== 0) { console.log(C.red('✗ pm2 failed to start the services')); process.exit(1); }

// 6. Health-gate: wait for API + bridge to answer (web dev server is slower — soft check).
console.log('\n▶ health');
const apiOk = await waitFor('api', () => httpUp(`${API}/health`), 45_000);
const bridgeOk = await waitFor('whatsapp bridge', () => httpUp(`${BRIDGE}/health`), 30_000);
const webOk = await waitFor('web (first compile is slow)', () => httpUp(WEB), 60_000, 5_000);

console.log(C.bold('\n▶ up complete') + `  api:${apiOk ? C.green('●') : C.red('●')}  bridge:${bridgeOk ? C.green('●') : C.red('●')}  web:${webOk ? C.green('●') : C.yellow('●')}`);
console.log(C.dim('  logs: npx pm2 logs   ·   status: pnpm status   ·   stop: pnpm down\n'));
process.exit(0);
