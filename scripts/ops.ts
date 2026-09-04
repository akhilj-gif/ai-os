// Shared ops helpers for the lifecycle scripts (up / status / down).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The API now requires x-aios-token on non-exempt endpoints (e.g. /dashboard).
// Lifecycle scripts don't load dotenv, so read the token straight from .env.
const apiToken: string = (() => {
  if (process.env.AIOS_API_TOKEN) return process.env.AIOS_API_TOKEN.trim();
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('AIOS_API_TOKEN='));
    return line ? line.slice('AIOS_API_TOKEN='.length).trim() : '';
  } catch {
    return '';
  }
})();
const authHeaders = (): Record<string, string> => (apiToken ? { 'x-aios-token': apiToken } : {});

/** The WhatsApp bridge uses its OWN shared secret (x-bridge-token), not the API
 *  token — sending the wrong one made every supervisor bridge call 401 and
 *  silently disabled the down-alert path. Read it from .env like the API token. */
export const bridgeToken: string = (() => {
  if (process.env.WHATSAPP_BRIDGE_TOKEN) return process.env.WHATSAPP_BRIDGE_TOKEN.trim();
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('WHATSAPP_BRIDGE_TOKEN='));
    return line ? line.slice('WHATSAPP_BRIDGE_TOKEN='.length).trim() : '';
  } catch {
    return '';
  }
})();
export const bridgeHeaders = (): Record<string, string> => (bridgeToken ? { 'x-bridge-token': bridgeToken } : {});

export const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const isWin = process.platform === 'win32';

/** Run a command, capture output. Never throws — returns {code, out}. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: isWin, windowsHide: true });
    let out = '';
    const cap = (d: Buffer) => (out += d.toString());
    p.stdout.on('data', cap);
    p.stderr.on('data', cap);
    const t = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : null;
    p.on('close', (code) => { if (t) clearTimeout(t); resolve({ code: code ?? -1, out }); });
    p.on('error', (e) => { if (t) clearTimeout(t); resolve({ code: -1, out: String(e) }); });
  });
}

/** Run a command streaming its output to this terminal (for noisy steps). */
export function runLive(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, shell: isWin, stdio: 'inherit', windowsHide: true });
    p.on('close', (code) => resolve(code ?? -1));
    p.on('error', () => resolve(-1));
  });
}

export async function dockerDaemonUp(): Promise<boolean> {
  const r = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 12_000 });
  return r.code === 0 && /\d+\./.test(r.out);
}

export async function pgReady(): Promise<boolean> {
  const r = await run('docker', ['exec', 'ai-os-postgres-1', 'pg_isready', '-U', 'postgres', '-d', 'aios'], { timeoutMs: 10_000 });
  return /accepting connections/.test(r.out);
}

export async function httpJson(url: string, timeoutMs = 4_000): Promise<{ ok: boolean; body: unknown }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: authHeaders() });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, body };
  } catch {
    return { ok: false, body: null };
  }
}

/** READINESS: the endpoint answered AND reported itself ready (2xx).
 *
 *  httpUp() below deliberately accepts ANY response, so it answers "is something
 *  listening on that port" — which is the right question for the web dev server.
 *  It is the WRONG question for /health: a 503 from an API whose database is down
 *  is still `status > 0`, so a liveness probe reports a dead OS as healthy. That
 *  is exactly how the autonomous jobs sat broken for ~13 days while every monitor
 *  said fine. Use this for anything that has an opinion about its own readiness. */
export async function httpReady(url: string, timeoutMs = 4_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: authHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

/** LIVENESS: something answered on that port at all, whatever it said. */
export async function httpUp(url: string, timeoutMs = 4_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: authHeaders() });
    return res.status > 0;
  } catch {
    return false;
  }
}

/** pm2 apps with the fields a health check actually needs. pm2List() below
 *  returns a name→status MAP, and doctor.ts consumed it as an ARRAY — so
 *  `apps.length` was undefined, `!apps.length` was always true, and the doctor
 *  reported "pm2 apps: NOTHING running" on every run while six apps were online.
 *  The per-app status and crash-loop branch underneath it had never executed.
 *  Record<string,string> has an index signature, so `apps.length` type-checks as
 *  `string` and nothing complained — and scripts/ was outside tsconfig's include
 *  anyway. Returning a real array makes the shape match the use. */
export async function pm2Apps(): Promise<Array<{ name: string; status: string; restarts: number }>> {
  const r = await run('npx', ['pm2', 'jlist'], { timeoutMs: 20_000 });
  try {
    const arr = JSON.parse(r.out.slice(r.out.indexOf('['))) as Array<{
      name: string;
      pm2_env?: { status?: string; restart_time?: number };
    }>;
    return arr.map((a) => ({ name: a.name, status: a.pm2_env?.status ?? 'unknown', restarts: a.pm2_env?.restart_time ?? 0 }));
  } catch {
    return [];
  }
}

/** pm2 process list (name → status), via npx so no global install is required. */
export async function pm2List(): Promise<Record<string, string>> {
  const r = await run('npx', ['pm2', 'jlist'], { timeoutMs: 20_000 });
  try {
    const arr = JSON.parse(r.out.slice(r.out.indexOf('['))) as Array<{ name: string; pm2_env?: { status?: string } }>;
    return Object.fromEntries(arr.map((a) => [a.name, a.pm2_env?.status ?? 'unknown']));
  } catch {
    return {};
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` until true or timeout. Returns whether it succeeded. */
export async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs: number, everyMs = 3_000): Promise<boolean> {
  const start = Date.now();
  process.stdout.write(`  waiting for ${label}`);
  while (Date.now() - start < timeoutMs) {
    if (await check()) { process.stdout.write(` ${C.green('ok')}\n`); return true; }
    process.stdout.write('.');
    await sleep(everyMs);
  }
  process.stdout.write(` ${C.red('timeout')}\n`);
  return false;
}

export const BRIDGE = 'http://127.0.0.1:4100';
export const API = 'http://127.0.0.1:4000';
export const WEB = 'http://127.0.0.1:3000';

/** If the Docker daemon is down, launch Docker Desktop and wait for it to come
 *  up. Best-effort — returns true once the daemon responds, false on timeout.
 *  The boot-on-login / supervisor path (os:up used to just bail here). */
export async function dockerDesktopStart(timeoutMs = 150_000): Promise<boolean> {
  if (await dockerDaemonUp()) return true;
  // AIOS_NO_GUI: never pop a GUI window (set by the supervisor / any unattended
  // caller). Docker Desktop is a windowed app, so launching it interrupts the
  // user — only an explicit, human-invoked `pnpm os:up` may do that.
  if (process.env.AIOS_NO_GUI === '1') return false;
  const exe = process.env.AIOS_DOCKER_DESKTOP ?? 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
  try {
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* launch failed — still wait below in case it is already starting */
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(5_000);
    if (await dockerDaemonUp()) return true;
  }
  return false;
}
