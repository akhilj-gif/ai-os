// `pnpm up` — cold → fully running, health-gated. The one command to start the OS.
// Ensures Docker + Postgres are healthy, migrates, then hands the long-running
// services to pm2 (auto-restart on crash). Idempotent: safe to run repeatedly.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C, run, runLive, bridgeHeaders, dockerDaemonUp, dockerDesktopStart, pgReady, httpReady, httpUp, pm2List, waitFor, API, BRIDGE, WEB } from './ops.js';

const DOT = '●';

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
// EXCLUDE the supervisor from the delete/start cycle. It is itself a pm2 app,
// and its recovery action is to run THIS script -- so a plain
// `pm2 delete <ecosystem>` deleted the supervisor while the supervisor was the
// process running the recovery. Killing it killed the os:up child it had just
// spawned, so `pm2 start` never ran and the OS was left with ZERO apps.
// Measured 2026-09-04: 370ms from "supervisor loop started" to the whole stack
// deleted, with no supervisor left alive to notice or report it. That is the
// real reason the OS never stayed up and the autonomous jobs went silent.
const ECO = join(root, 'ecosystem.config.cjs');
const MANAGED = 'ai-os-api,ai-os-bridge,ai-os-web,ai-os-browser,ai-os-voice';
await run('npx', ['pm2', 'delete', ECO, '--only', MANAGED], { cwd: root, timeoutMs: 30_000 }); // ignore "not found"
const start = await runLive('npx', ['pm2', 'start', ECO, '--only', MANAGED], { cwd: root });
if (start !== 0) { console.log(C.red('✗ pm2 failed to start the services')); process.exit(1); }

// Start the supervisor only if it is not already online. Restarting it here
// would kill whoever called us in the case where the caller IS the supervisor.
if ((await pm2List())['ai-os-supervisor'] !== 'online') {
  await runLive('npx', ['pm2', 'start', ECO, '--only', 'ai-os-supervisor'], { cwd: root });
}

// 5.5. Log rotation (2026-08-13 DoS sweep): every pm2 app logs to a plain
//      logs/*.log with no cap — bridge.log alone reached 42MB with zero
//      rotation, an unbounded-disk-growth path to eventually taking down the
//      whole machine (Postgres included). pm2-logrotate is a pm2 module, not
//      a repo file, so it doesn't survive a fresh `pm2 kill`/reinstall unless
//      re-asserted here. `pm2 install` and `pm2 set` are both idempotent — a
//      no-op if already configured this way.
console.log('\n▶ log rotation');
await run('npx', ['pm2', 'install', 'pm2-logrotate'], { cwd: root, timeoutMs: 60_000 });
for (const [k, v] of [['max_size', '10M'], ['retain', '10'], ['compress', 'true']]) {
  await run('npx', ['pm2', 'set', `pm2-logrotate:${k}`, v!], { cwd: root, timeoutMs: 15_000 });
}
console.log(C.green('✓ pm2-logrotate: 10M/file, 10 rotations, compressed'));

// 6. Health-gate: wait for API + bridge to answer (web dev server is slower — soft check).
console.log('\n▶ health');
const apiOk = await waitFor('api', () => httpReady(`${API}/health`), 45_000);
// The WhatsApp bridge authenticates with its OWN shared secret, not the API
// token that httpReady() sends -- so this probe got a flat 401 and reported the
// bridge DOWN on every single up, while the process was perfectly healthy. The
// supervisor's alert path had this same bug fixed months ago; this copy did not.
// Read pairing too: a bridge that is running but unpaired cannot send or receive
// anything, and scoring that green is the false-green this repo keeps paying for.
let bridgePaired = false;
const bridgeOk = await waitFor(
  'whatsapp bridge',
  async () => {
    try {
      const res = await fetch(`${BRIDGE}/health`, { headers: bridgeHeaders(), signal: AbortSignal.timeout(4_000) });
      if (!res.ok) return false;
      bridgePaired = ((await res.json()) as { paired?: boolean }).paired === true;
      return true;
    } catch {
      return false;
    }
  },
  30_000,
);
const webOk = await waitFor('web (first compile is slow)', () => httpUp(WEB), 60_000, 5_000);

const bridgeDot = !bridgeOk ? C.red(DOT) : bridgePaired ? C.green(DOT) : C.yellow(DOT + ' unpaired');
console.log(C.bold('\n▶ up complete') + `  api:${apiOk ? C.green('●') : C.red('●')}  bridge:${bridgeDot}  web:${webOk ? C.green('●') : C.yellow('●')}`);
if (bridgeOk && !bridgePaired) console.log(C.yellow('  the bridge is running but NOT paired -- scan the QR at http://127.0.0.1:4100/qr to enable WhatsApp'));
console.log(C.dim('  logs: pnpm os:logs   ·   status: pnpm os:status   ·   diagnose: pnpm os:doctor   ·   stop: pnpm os:down\n'));
process.exit(0);
