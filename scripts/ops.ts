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

export const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const isWin = process.platform === 'win32';

/** Run a command, capture output. Never throws — returns {code, out}. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, shell: isWin, windowsHide: true });
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

export async function httpUp(url: string, timeoutMs = 4_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: authHeaders() });
    return res.status > 0;
  } catch {
    return false;
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
