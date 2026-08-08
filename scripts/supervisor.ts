// pnpm os:watch — the self-healing supervisor. ONE idempotent pass: if the OS is
// healthy (API answering + all pm2 services online), no-op; otherwise run the
// full recovery (`pnpm os:up`, which now self-starts Docker) and, if it still
// can't get healthy, post a best-effort WhatsApp down-alert and log it.
//
// `pnpm os:install-autostart` registers this to run at logon AND every few
// minutes, so the OS auto-recovers after a reboot or the laptop sleeping (which
// drops the pm2 daemon — the recurring outage this ends). Pass --loop to run it
// continuously in the foreground instead of one pass.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, mkdirSync, existsSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { API, BRIDGE, C, dockerDaemonUp, httpJson, httpUp, pm2List, run, sleep } from './ops.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['ai-os-api', 'ai-os-bridge', 'ai-os-web', 'ai-os-browser', 'ai-os-voice'];
const LOCK = join(root, 'logs', 'supervisor.lock');

function log(line: string): void {
  const stamp = new Date().toISOString();
  try {
    mkdirSync(join(root, 'logs'), { recursive: true });
    appendFileSync(join(root, 'logs', 'supervisor.log'), `${stamp} ${line.replace(/\x1b\[[0-9;]*m/g, '')}\n`);
  } catch {
    /* logging is best-effort */
  }
  console.log(line);
}

/** A recovery is already running (another task fired) if the lock is < 5 min old. */
function recoveryLocked(): boolean {
  try {
    return existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 5 * 60_000;
  } catch {
    return false;
  }
}

async function healthy(): Promise<boolean> {
  if (!(await httpUp(`${API}/health`))) return false;
  const states = await pm2List();
  return APPS.every((a) => states[a] === 'online');
}

/** Best-effort WhatsApp self-chat alert. The bridge is pm2-supervised
 *  independently of the api, so it may be alive even when the api is down. */
async function alert(text: string): Promise<void> {
  try {
    const h = (await httpJson(`${BRIDGE}/health`)).body as { selfChats?: string[] } | null;
    const to = h?.selfChats?.[0];
    if (!to) return;
    await fetch(`${BRIDGE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.WHATSAPP_BRIDGE_TOKEN ? { 'x-bridge-token': process.env.WHATSAPP_BRIDGE_TOKEN } : {}) },
      body: JSON.stringify({ to, text }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    /* bridge unreachable too — the log is the fallback */
  }
}

async function tick(): Promise<boolean> {
  if (await healthy()) {
    log(C.green('✓ healthy'));
    return true;
  }
  if (recoveryLocked()) {
    log(C.yellow('• unhealthy, but a recovery is already in progress — skipping'));
    return true;
  }
  log(C.yellow('• unhealthy — running recovery (pnpm os:up)'));
  try {
    writeFileSync(LOCK, new Date().toISOString());
    if (!(await dockerDaemonUp())) log('  docker daemon down — os:up will launch Docker Desktop');
    await run('pnpm', ['os:up'], { cwd: root, timeoutMs: 300_000 });
    await sleep(3_000);
  } finally {
    try {
      rmSync(LOCK, { force: true });
    } catch {
      /* ignore */
    }
  }
  if (await healthy()) {
    log(C.green('✓ recovered'));
    return true;
  }
  log(C.red('✗ still unhealthy after recovery — alerting'));
  await alert('⚠ AI OS supervisor could not bring the stack healthy (Docker + pm2 + /health). A manual look is needed.');
  return false;
}

if (process.argv.includes('--loop')) {
  const everyMs = Number(process.env.AIOS_SUPERVISOR_POLL_MS) || 180_000;
  log(C.bold(`▶ supervisor loop (every ${Math.round(everyMs / 1000)}s)`));
  for (;;) {
    await tick();
    await sleep(everyMs);
  }
} else {
  const ok = await tick();
  process.exit(ok ? 0 : 1);
}
