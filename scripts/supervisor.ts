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
import { appendFileSync, mkdirSync, existsSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { API, BRIDGE, C, bridgeHeaders, dockerDaemonUp, httpReady, httpUp, pm2List, run, sleep } from './ops.js';

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
  // httpReady, not httpUp: /health returns 503 when Postgres or Redis is down,
  // and a liveness probe would score that as healthy and never recover it.
  if (!(await httpReady(`${API}/health`))) return false;
  const states = await pm2List();
  return APPS.every((a) => states[a] === 'online');
}

interface BridgeHealth {
  ok?: boolean;
  paired?: boolean;
  needsRepair?: boolean;
  selfChats?: string[];
}

/** Read the bridge's own health with ITS token (not the API token). */
async function bridgeHealth(): Promise<BridgeHealth | null> {
  try {
    const res = await fetch(`${BRIDGE}/health`, { headers: bridgeHeaders(), signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    return (await res.json()) as BridgeHealth;
  } catch {
    return null;
  }
}

/** Best-effort WhatsApp self-chat alert. The bridge is pm2-supervised
 *  independently of the api, so it may be alive even when the api is down.
 *  (Previously this authenticated with the WRONG token and read an env var the
 *  supervisor never loads, so it silently never sent anything.) */
async function alert(text: string): Promise<void> {
  try {
    const to = (await bridgeHealth())?.selfChats?.[0];
    if (!to) return; // unpaired — nothing we can deliver to; the log is the record
    await fetch(`${BRIDGE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify({ to, text }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    /* bridge unreachable too — the log is the fallback */
  }
}

/** Things a restart CANNOT fix — they need the human. Report them loudly every
 *  pass instead of silently looping os:up (an expired WhatsApp session needs a
 *  QR re-scan; restarting just churns). This is the gap that let the bridge sit
 *  unpaired for days while every monitor said "healthy". */
async function reportNeedsHuman(): Promise<void> {
  const h = await bridgeHealth();
  if (h && h.paired === false) {
    log(C.yellow('⚠ WhatsApp bridge is UNPAIRED — re-scan the QR at http://127.0.0.1:4100/qr (restarting cannot fix this)'));
  } else if (h?.needsRepair) {
    log(C.yellow('⚠ WhatsApp bridge needs repair — open http://127.0.0.1:4100/qr'));
  }
}

/** Recovery budget: at most MAX_RECOVERIES in WINDOW_MS. Without this, a stack
 *  that cannot self-heal (an unpaired bridge, a crash-looping build) gets os:up
 *  re-run on EVERY tick forever — which on Windows means repeatedly restarting
 *  dev servers and flashing windows at the user. Thrashing is worse than being
 *  down: after the budget, back off and let the human decide. */
const STATE = join(root, 'logs', 'supervisor-state.json');
const MAX_RECOVERIES = 3;
const WINDOW_MS = 60 * 60_000;

interface SupervisorState {
  attempts?: number[];
  lastBackup?: number;
}
function readState(): SupervisorState {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8')) as SupervisorState;
  } catch {
    return {};
  }
}
function writeState(s: SupervisorState): void {
  try {
    mkdirSync(join(root, 'logs'), { recursive: true });
    writeFileSync(STATE, JSON.stringify(s));
  } catch {
    /* best effort */
  }
}
function recentRecoveries(): number[] {
  return (readState().attempts ?? []).filter((t) => Date.now() - t < WINDOW_MS);
}
function noteRecovery(attempts: number[]): void {
  writeState({ ...readState(), attempts: [...attempts, Date.now()] });
}

/** Daily Postgres backup. The DB holds every memory, the knowledge graph and the
 *  OAuth tokens — none of it reproducible from the repo. Runs at most once per
 *  BACKUP_EVERY_MS, silently, and never blocks the health loop. */
const BACKUP_EVERY_MS = 20 * 3600_000;
async function backupIfDue(): Promise<void> {
  const s = readState();
  if (s.lastBackup && Date.now() - s.lastBackup < BACKUP_EVERY_MS) return;
  const r = await run('pnpm', ['os:backup'], { cwd: root, timeoutMs: 300_000 });
  if (r.code === 0) {
    writeState({ ...readState(), lastBackup: Date.now() });
    log(C.green('✓ daily backup written'));
  } else {
    log(C.red(`✗ backup FAILED: ${r.out.trim().split('\n').slice(-2).join(' ').slice(0, 200)}`));
  }
}

/** A watchdog that can silently vanish is worse than none. If the scheduled task
 *  is gone but the generated launcher is still present (i.e. autostart WAS
 *  installed on purpose), put the task back. `os:install-autostart --uninstall`
 *  removes the launcher too, so a deliberate uninstall stays uninstalled. */
async function assertInstalled(): Promise<void> {
  if (process.platform !== 'win32' || process.env.AIOS_SUPERVISOR_SELFHEAL === 'off') return;
  const shim = join(root, 'scripts', 'aios-autostart.vbs');
  if (!existsSync(shim)) return; // never installed (or intentionally removed) — respect that
  const q = await run('schtasks', ['/query', '/tn', 'AI-OS-Supervisor'], { timeoutMs: 15_000 });
  if (q.code === 0) return;
  log(C.yellow('⚠ the AI-OS-Supervisor scheduled task is missing — reinstalling it'));
  await run('pnpm', ['os:install-autostart'], { cwd: root, timeoutMs: 60_000 });
}

async function tick(): Promise<boolean> {
  await assertInstalled();
  await reportNeedsHuman();
  if (await healthy()) {
    log(C.green('✓ healthy'));
    await backupIfDue(); // only back up a healthy stack — never a half-broken one
    return true;
  }
  if (recoveryLocked()) {
    log(C.yellow('• unhealthy, but a recovery is already in progress — skipping'));
    return true;
  }
  // NEVER launch Docker Desktop from here: it is a GUI app, so starting it pops
  // a window in the user's face. Docker coming up is a human/OS-login concern.
  if (!(await dockerDaemonUp())) {
    log(C.yellow('⚠ Docker daemon is down — start Docker Desktop, then the OS can recover. (Not auto-launching it: that would pop a window.)'));
    return false;
  }
  const attempts = recentRecoveries();
  if (attempts.length >= MAX_RECOVERIES) {
    log(C.red(`✗ recovery budget spent (${attempts.length} in the last hour) — backing off. Run \`pnpm os:up\` yourself and check logs/api.err.log.`));
    return false;
  }
  log(C.yellow(`• unhealthy — running recovery (pnpm os:up) [${attempts.length + 1}/${MAX_RECOVERIES} this hour]`));
  try {
    writeFileSync(LOCK, new Date().toISOString());
    noteRecovery(attempts);
    // AIOS_NO_GUI tells os:up not to launch any GUI app either (belt + braces).
    await run('pnpm', ['os:up'], { cwd: root, timeoutMs: 300_000, env: { ...process.env, AIOS_NO_GUI: '1' } });
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
  // Startup grace. os:up starts this supervisor as one of the pm2 apps, so at
  // t=0 the api it is about to probe is by definition still booting. The first
  // tick used to fire immediately, score the stack unhealthy 370ms in, and
  // trigger a full recovery of a stack that was merely young. Wait for the api
  // to answer, and only give up (and let tick() do its job) after GRACE_MS.
  const GRACE_MS = 90_000;
  const until = Date.now() + GRACE_MS;
  while (Date.now() < until && !(await httpReady(`${API}/health`))) await sleep(3_000);
  for (;;) {
    await tick();
    await sleep(everyMs);
  }
} else {
  const ok = await tick();
  process.exit(ok ? 0 : 1);
}
