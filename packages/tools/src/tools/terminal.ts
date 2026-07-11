// M13a — the `computer` pack: real host-terminal access (ADR-0016). Two tools
// split by reversibility:
//   terminal_run  — read-only, AUTO. Head must be on the inspection allowlist
//                   and carry no shell metacharacter (no chaining/redirect/
//                   subshell). The OS "looking around" without asking.
//   terminal_exec — ANYTHING, irreversible + never-auto. Every call queues for
//                   the user's approval showing the exact command. The real hand.
//
// Safety is the trust gate, NOT containment: terminal_exec runs on the REAL
// machine (that is the point). §8.3 blocks it under untrusted context; the
// human reading the literal command before approving is the check. Child procs
// get a SECRET-SCRUBBED env, output is capped, runs are time-boxed, and cwd is
// confined to AIOS_TERMINAL_ROOT. code_exec (Docker, ADR-0009) stays the path
// for untrusted CODE; this is for trusted operational commands.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import type { ToolDef } from '../registry.js';

// Secret env names the OS holds — mirrors @ai-os/trust's SECRET_ENV_NAMES (kept
// inline so the tools package stays dependency-light). The catch-all regex
// below covers anything else secret-shaped, so this list need not be exhaustive.
const SECRET_ENV_NAMES = new Set([
  'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEY_FALLBACK',
  'GROQ_API_KEY', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'DATABASE_URL',
  'LANGFUSE_SECRET_KEY', 'LANGFUSE_PUBLIC_KEY', 'WHATSAPP_BRIDGE_TOKEN',
  'X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET',
]);

/** A copy of the environment with the OS's own secrets removed — so a command
 *  the model runs cannot read our API keys out of process.env. Exported for the
 *  smoke. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_NAMES.has(k)) continue;
    if (/(_KEY|_SECRET|_TOKEN|PASSWORD|CREDENTIAL)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 64_000; // head+tail cap per stream

// Heads that only INSPECT — safe to run without asking. Platform-neutral where
// possible; the Windows-native ones (dir/type/Get-*) sit alongside the POSIX set.
const READ_ALLOWLIST = new Set([
  'ls', 'dir', 'pwd', 'cd', 'cat', 'type', 'head', 'tail', 'wc', 'find', 'where', 'which',
  'echo', 'date', 'whoami', 'hostname', 'uname', 'df', 'du', 'ps', 'env', 'printenv',
  'tree', 'stat', 'file', 'grep', 'findstr',
  'get-childitem', 'get-content', 'get-location', 'get-process', 'select-string', 'test-path',
]);
// git is allowed ONLY for read subcommands.
const GIT_READ_SUBCMDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'config']);

// Anything that could chain, redirect, or spawn a subshell turns an allowlisted
// head into an arbitrary-command vector — refuse it on the read path.
const SHELL_METACHARS = /[;&|`$><\n\r()]|&&|\|\|/;

function confineCwd(raw: unknown): string {
  const root = resolve(process.env.AIOS_TERMINAL_ROOT || homedir());
  if (raw === undefined || raw === null || String(raw).trim() === '') return root;
  const req = String(raw);
  const abs = isAbsolute(req) ? resolve(req) : resolve(root, req);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`cwd "${req}" escapes the terminal root (${root}); set AIOS_TERMINAL_ROOT to widen it`);
  }
  return abs;
}

function cap(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = Math.floor(MAX_OUTPUT / 2);
  return `${s.slice(0, half)}\n…[${s.length - MAX_OUTPUT} chars truncated]…\n${s.slice(-half)}`;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cwd: string;
}

// Run through the platform shell so `ls -la`, pipelines a user explicitly
// approves, etc. behave as typed. terminal_run has already refused metachars;
// terminal_exec intentionally allows the full shell (post-approval).
function runInShell(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  const isWin = process.platform === 'win32';
  const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
  return new Promise((resolveP) => {
    const child = spawn(shell, args, { cwd, env: scrubbedEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT * 2) stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveP({ exitCode: null, stdout: cap(stdout), stderr: `${stderr}\n${err.message}`.trim(), timedOut, cwd });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ exitCode: code, stdout: cap(stdout), stderr: cap(stderr), timedOut, cwd });
    });
  });
}

/** Pure allowlist check (unit-tested by terminal-smoke). Returns null if OK, or
 *  a refusal reason. */
export function checkReadCommand(command: string): string | null {
  const cmd = command.trim();
  if (!cmd) return 'command is required';
  if (SHELL_METACHARS.test(cmd)) return 'terminal_run is read-only: shell metacharacters (; | & > ` $() …) are not allowed — use terminal_exec (needs approval) for anything beyond a single inspection command';
  const tokens = cmd.split(/\s+/);
  const head = tokens[0]!.toLowerCase();
  if (head === 'git') {
    const sub = (tokens[1] ?? '').toLowerCase();
    return GIT_READ_SUBCMDS.has(sub) ? null : `git ${sub || '(none)'} is not a read-only subcommand — use terminal_exec for it`;
  }
  return READ_ALLOWLIST.has(head) ? null : `"${head}" is not on the read-only allowlist — use terminal_exec (needs your approval) to run it`;
}

export const terminalRun: ToolDef = {
  name: 'terminal_run',
  untrustedOutput: false, // read-only + allowlisted: an injected read is harmless and actuates nothing
  description:
    'Run a READ-ONLY inspection command on the host and return its output (ls, cat, pwd, git status/log/diff, dir, type, Get-ChildItem, etc.). No approval needed. For ANYTHING that changes the system, use terminal_exec instead. No shell chaining/redirect/pipes here.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'A single read-only command, e.g. "ls -la" or "git status"' },
      cwd: { type: 'string', description: 'Working directory (relative to the terminal root or absolute within it). Optional.' },
    },
    required: ['command'],
  },
  async execute(args) {
    const command = String(args.command ?? '');
    const reason = checkReadCommand(command);
    if (reason) return { error: reason };
    let cwd: string;
    try {
      cwd = confineCwd(args.cwd);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const r = await runInShell(command, cwd, DEFAULT_TIMEOUT_MS);
    return r.timedOut ? { ...r, error: `command timed out after ${DEFAULT_TIMEOUT_MS}ms` } : r;
  },
};

export const terminalExec: ToolDef = {
  name: 'terminal_exec',
  untrustedOutput: false,
  description:
    'Run ANY shell command on the host machine (install, build, move/delete files, git commit, scripts — anything). IRREVERSIBLE: every call is queued for the user\'s one-click approval showing the exact command; nothing runs until they approve. Once the user asks you to do something on their computer, call this DIRECTLY with the exact command — do not ask for confirmation in prose first.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The exact shell command to run' },
      cwd: { type: 'string', description: 'Working directory (relative to the terminal root or absolute within it). Optional.' },
      timeoutMs: { type: 'number', description: `Max run time in ms (default ${DEFAULT_TIMEOUT_MS}).` },
    },
    required: ['command'],
  },
  async execute(args) {
    const command = String(args.command ?? '').trim();
    if (!command) return { error: 'command is required' };
    let cwd: string;
    try {
      cwd = confineCwd(args.cwd);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 600_000);
    const r = await runInShell(command, cwd, timeoutMs);
    return r.timedOut ? { ...r, error: `command timed out after ${timeoutMs}ms` } : r;
  },
};
