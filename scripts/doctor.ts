// pnpm os:doctor — one command that answers "what is wrong right now?"
//
// WHY. Troubleshooting used to mean running six things by hand (docker ps, pm2
// list, psql, curl /health, ls logs, reading .env) and knowing which mattered.
// Worse, some of those lie: /health returned 200 with a dead database until
// 2026-08-15, and pm2 saying "online" tells you nothing about whether a process
// is doing work. This walks every dependency and prints one line per check with
// the FIX attached to the failure, because knowing something is broken is only
// half of it.
//
// Ordered OUTSIDE-IN deliberately: docker before postgres before migrations
// before the API, so the first ✗ is the root cause and the ones after it are
// usually symptoms. Fix the top one first.
//
// Exit code is 0 only when nothing FAILED, so a watchdog or cron can consume it
// directly (`pnpm os:doctor || notify`). Warnings do not fail the run.
import pg from 'pg';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { C, dockerDaemonUp, pgReady, httpReady, httpUp, pm2Apps, API, BRIDGE, WEB, bridgeHeaders } from './ops.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(root, '.env') });

type Status = 'ok' | 'warn' | 'fail' | 'skip';
let fails = 0;
let warns = 0;
const rows: Array<{ status: Status; name: string; detail: string; fix?: string }> = [];

function record(status: Status, name: string, detail = '', fix?: string): void {
  if (status === 'fail') fails++;
  if (status === 'warn') warns++;
  rows.push({ status, name, detail, fix });
}

const DOT: Record<Status, string> = { ok: C.green('OK  '), warn: C.yellow('WARN'), fail: C.red('FAIL'), skip: C.dim('--  ') };
const mb = (n: number): string => `${(n / 1e6).toFixed(1)}MB`;

// --- 1. host prerequisites --------------------------------------------------
const dockerUp = await dockerDaemonUp();
record(dockerUp ? 'ok' : 'fail', 'docker engine', dockerUp ? 'running' : 'not reachable', 'Start Docker Desktop — Postgres runs in it. This is the usual root cause after a reboot.');

// --- 2. datastores ----------------------------------------------------------
const pgUp = dockerUp ? await pgReady() : false;
record(!dockerUp ? 'skip' : pgUp ? 'ok' : 'fail', 'postgres', !dockerUp ? 'skipped (no docker)' : pgUp ? 'accepting connections' : 'not ready', 'pnpm os:up');

const pool = pgUp ? new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 4000 }) : null;

// --- 3. schema currency -----------------------------------------------------
if (pool) {
  try {
    const onDisk = readdirSync(join(root, 'infra/migrations')).filter((f) => f.endsWith('.sql')).length;
    const { rows: r } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM schema_migrations');
    const applied = Number(r[0]?.n ?? 0);
    record(applied >= onDisk ? 'ok' : 'fail', 'migrations', `${applied}/${onDisk} applied`, 'pnpm db:migrate');
  } catch (err) {
    record('fail', 'migrations', `cannot read schema_migrations: ${err instanceof Error ? err.message : err}`, 'pnpm db:migrate');
  }
}

// --- 4. processes -----------------------------------------------------------
const apps = await pm2Apps();
const EXPECTED = ['ai-os-api', 'ai-os-bridge', 'ai-os-web', 'ai-os-browser', 'ai-os-supervisor', 'ai-os-voice'];
if (!apps.length) {
  record('fail', 'pm2 apps', 'NOTHING running', 'pnpm os:up   — nothing is running, which is why the OS appears dead');
} else {
  for (const name of EXPECTED) {
    const app = apps.find((a) => a.name === name);
    if (!app) {
      record('fail', name, 'not in pm2', 'pnpm os:up');
      continue;
    }
    const restarts = app.restarts ?? 0;
    // "online" with a high restart count is a crash-loop, which a glance at
    // `pm2 list` reads as healthy.
    const looping = restarts > 5;
    record(
      app.status !== 'online' ? 'fail' : looping ? 'warn' : 'ok',
      name,
      `${app.status}${restarts ? `, ${restarts} restart(s)` : ''}`,
      app.status !== 'online' || looping ? `npx pm2 logs ${name} --lines 50` : undefined,
    );
  }
}

// --- 5. readiness, not just liveness ---------------------------------------
const apiReady = await httpReady(`${API}/health`);
const apiAlive = apiReady || (await httpUp(`${API}/health`));
record(
  apiReady ? 'ok' : 'fail',
  'api readiness',
  apiReady ? `${API} ready` : apiAlive ? 'answering but NOT ready (503)' : 'no response',
  apiReady ? undefined : `curl ${API}/health   — the body names the failing dependency`,
);
// A degraded-but-listening API is exactly what a liveness probe misses, so name
// the failing component instead of a bare "down".
if (apiAlive && !apiReady) {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(4000) });
    const body = (await res.json()) as { services?: Record<string, string> };
    for (const [svc, state] of Object.entries(body.services ?? {})) {
      if (state !== 'ok') record('fail', `  api dep: ${svc}`, state);
    }
  } catch {
    /* the readiness line already carries the failure */
  }
}
record((await httpUp(WEB)) ? 'ok' : 'warn', 'web ui', WEB, 'first compile is slow; npx pm2 logs ai-os-web');

// --- 6. WhatsApp pairing: a restart CANNOT fix this ------------------------
try {
  const res = await fetch(`${BRIDGE}/health`, { headers: bridgeHeaders(), signal: AbortSignal.timeout(5000) });
  const body = (await res.json()) as { paired?: boolean; needsRepair?: boolean };
  const good = !!body.paired && !body.needsRepair;
  record(good ? 'ok' : 'warn', 'whatsapp pairing', body.paired ? (body.needsRepair ? 'needs re-pair' : 'paired') : 'UNPAIRED', good ? undefined : 'Re-scan the QR at http://127.0.0.1:4100/qr — restarting cannot fix pairing.');
} catch {
  record('skip', 'whatsapp pairing', 'bridge not answering');
}

// --- 7. configuration ------------------------------------------------------
const REQUIRED_ENV = ['DATABASE_URL', 'AIOS_API_TOKEN', 'BROWSER_BRIDGE_TOKEN', 'WHATSAPP_BRIDGE_TOKEN'];
const missing = REQUIRED_ENV.filter((k) => !(process.env[k] ?? '').trim());
record(
  missing.length ? 'fail' : 'ok',
  'required env',
  missing.length ? `missing/blank: ${missing.join(', ')}` : `${REQUIRED_ENV.length} present`,
  missing.length ? 'Set them in .env — a blank bridge token leaves that bridge UNAUTHENTICATED.' : undefined,
);
const MODEL_KEYS = ['ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'NVIDIA_API_KEY'];
const haveModel = MODEL_KEYS.filter((k) => (process.env[k] ?? '').trim());
record(haveModel.length ? 'ok' : 'fail', 'model providers', haveModel.length ? haveModel.join(', ') : 'NO model key set', 'Set at least one provider key in .env or every task fails.');

// --- 8. backups ------------------------------------------------------------
const backupDir = process.env.AIOS_BACKUP_DIR ?? join(homedir(), 'AIOS-Backups');
if (!existsSync(backupDir)) {
  record('fail', 'backups', `no ${backupDir}`, 'pnpm os:backup --verify   — there is currently NO recoverable copy of your memory');
} else {
  const dumps = readdirSync(backupDir).filter((f) => f.endsWith('.dump'));
  if (!dumps.length) {
    record('fail', 'backups', 'directory exists but is EMPTY', 'pnpm os:backup --verify');
  } else {
    const newest = dumps.map((f) => statSync(join(backupDir, f)).mtimeMs).sort((a, b) => b - a)[0]!;
    const hours = Math.round((Date.now() - newest) / 3_600_000);
    record(hours <= 48 ? 'ok' : 'warn', 'backups', `${dumps.length} dump(s), newest ${hours}h old`, hours > 48 ? 'pnpm os:backup --verify' : undefined);
  }
}

// --- 9. recent failures, from the data the OS already writes ---------------
if (pool) {
  const safe = async (name: string, sql: string, render: (rows: Array<Record<string, string>>) => { status: Status; detail: string; fix?: string }): Promise<void> => {
    try {
      const { rows: r } = await pool.query<Record<string, string>>(sql);
      const out = render(r);
      record(out.status, name, out.detail, out.fix);
    } catch {
      record('skip', name, 'table unreadable');
    }
  };
  // Job OUTCOMES live in job_runs, not jobs (jobs has no status column at all —
  // an earlier version of this check queried jobs.status and silently reported
  // "table unreadable", which is exactly the kind of check that is worse than no
  // check). trace_id comes back so the fix line can name a real incident to open.
  await safe(
    'failed jobs (24h)',
    `SELECT j.kind, count(*)::text AS n, max(r.trace_id::text) AS trace
       FROM job_runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.status = 'failed' AND r.started_at > now() - interval '24 hours'
      GROUP BY j.kind ORDER BY 2 DESC`,
    (r) =>
      r.length
        ? { status: 'warn', detail: r.map((j) => `${j.kind}x${j.n}`).join(', '), fix: r[0]?.trace ? `pnpm os:trace ${r[0].trace}` : 'pnpm os:trace --recent' }
        : { status: 'ok', detail: 'none' },
  );
  // MISSED runs are the signature of the OS being down rather than broken: the
  // scheduler never got the chance to run them. This is what "autonomous jobs
  // silently dead for 13 days" looked like in the data, unnoticed.
  await safe(
    'missed job runs (7d)',
    `SELECT count(*)::text AS n FROM job_runs WHERE status = 'missed' AND started_at > now() - interval '7 days'`,
    (r) => {
      const n = Number(r[0]?.n ?? 0);
      return n ? { status: 'warn', detail: `${n} missed — the scheduler was not running`, fix: 'This means downtime, not a bug. See the autostart check below.' } : { status: 'ok', detail: 'none' };
    },
  );
  await safe(
    'failed tasks (24h)',
    "SELECT count(*)::text AS n FROM tasks WHERE status='failed' AND updated_at > now() - interval '24 hours'",
    (r) => {
      const n = Number(r[0]?.n ?? 0);
      return n ? { status: 'warn', detail: `${n} failed`, fix: 'pnpm os:trace --recent   — list recent failures with their trace ids' } : { status: 'ok', detail: 'none' };
    },
  );
  // THE SILENTLY-DEAD DETECTOR, and the most important check in this file.
  // "zero failed runs" and "zero missed runs" both read as healthy when the real
  // state is that the scheduler has not run AT ALL — which is precisely how the
  // autonomous jobs sat dead for ~13 days while every monitor said fine.
  // Absence of failure is not health; absence of ACTIVITY is the signal.
  await safe(
    'scheduler activity',
    `SELECT to_char(max(started_at),'YYYY-MM-DD HH24:MI') AS t,
            round(extract(epoch FROM now() - max(started_at)) / 3600)::text AS hours
       FROM job_runs`,
    (r) => {
      const t = r[0]?.t;
      if (!t) return { status: 'warn', detail: 'no job has EVER run', fix: 'Check that jobs are registered and enabled: SELECT name,kind,enabled,next_run_at FROM jobs;' };
      const hours = Number(r[0]?.hours ?? 0);
      if (hours > 48) return { status: 'fail', detail: `last job run ${t} (${hours}h ago) — the scheduler is DEAD, not merely idle`, fix: 'The api process owns the scheduler. pnpm os:up, then re-run this. If it recurs, see the autostart check.' };
      if (hours > 6) return { status: 'warn', detail: `last job run ${t} (${hours}h ago)`, fix: 'Expected if no job is due; suspicious if a job should have fired.' };
      return { status: 'ok', detail: `last job run ${t} (${hours}h ago)` };
    },
  );
  await safe('approvals waiting', "SELECT count(*)::text AS n FROM pending_actions WHERE status='pending'", (r) => {
    const n = Number(r[0]?.n ?? 0);
    // A growing queue means the OS is blocked on the human, not broken.
    return { status: n > 10 ? 'warn' : 'ok', detail: `${n} pending`, fix: n > 10 ? 'The OS is waiting on you — approve/reject in the dashboard' : undefined };
  });
  await safe('last task activity', 'SELECT to_char(max(updated_at), \'YYYY-MM-DD HH24:MI\') AS t FROM tasks', (r) => {
    const t = r[0]?.t;
    return t ? { status: 'ok', detail: `last task ${t}` } : { status: 'warn', detail: 'no tasks ever recorded' };
  });
}

// --- 10. log hygiene -------------------------------------------------------
const logDir = join(root, 'logs');
if (!existsSync(logDir)) {
  record('skip', 'logs on disk', 'no logs/ yet');
} else {
  const files = readdirSync(logDir).filter((f) => f.endsWith('.log'));
  const total = files.reduce((n, f) => n + statSync(join(logDir, f)).size, 0);
  const biggest = files.map((f) => ({ f, s: statSync(join(logDir, f)).size })).sort((a, b) => b.s - a.s)[0];
  record(
    total > 500e6 ? 'warn' : 'ok',
    'logs on disk',
    `${files.length} file(s), ${mb(total)}${biggest ? `, largest ${biggest.f} ${mb(biggest.s)}` : ''}`,
    total > 500e6 ? 'npx pm2 install pm2-logrotate   (os:up asserts it, but only when os:up runs)' : undefined,
  );
}

// --- 11. autostart: the reason this script exists at all -------------------
// Measured 2026-08-15: the OS was not running and nothing started it. Task
// Scheduler was tried and silently did nothing; a Startup-folder VBS popped
// console windows. Until a real service exists, say so on every single run.
const startupDir = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const hasStartupEntry = existsSync(startupDir) && readdirSync(startupDir).some((f) => /ai-?os/i.test(f));
record(
  hasStartupEntry ? 'ok' : 'warn',
  'autostart',
  hasStartupEntry ? 'startup entry present' : 'NONE — the OS will not come back after a reboot',
  hasStartupEntry ? undefined : 'Roadmap Phase 0: a real Windows service (nssm/winsw) wrapping pm2.',
);

// --- render ----------------------------------------------------------------
console.log(C.bold('\nai-os doctor\n'));
for (const r of rows) {
  console.log(`  ${DOT[r.status]}  ${r.name.padEnd(20)} ${C.dim(r.detail)}`);
  if (r.fix && r.status !== 'ok') console.log(`        ${C.yellow('->')} ${r.fix}`);
}
const verdict = fails ? C.red(`${fails} FAILED`) + (warns ? `, ${warns} warning(s)` : '') : warns ? C.yellow(`${warns} warning(s)`) : C.green('all clear');
console.log(`\n  ${verdict}\n`);
if (fails) console.log(C.dim('  Fix the FIRST failure — checks run outside-in, so later ones are usually symptoms.\n'));
// Exit code is this script's entire machine-readable contract: a watchdog or CI
// step reads it to decide whether the OS is healthy. Calling process.exit()
// straight after pool.end() raced libuv's socket teardown and aborted the
// process with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and
// status 3221226505 (0xC0000409) -- so a perfectly healthy run reported a
// catastrophic failure, and a genuine 1 was indistinguishable from the crash.
// Let the closing handles finish before exiting.
await pool?.end();
await new Promise((r) => setTimeout(r, 250));
process.exit(fails ? 1 : 0);
