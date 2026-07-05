// code_exec — run a snippet in the Docker sandbox (ADR-0009). Code NEVER runs on
// the host. Fully isolated: non-root, read-only rootfs, no host FS, no network,
// resource + time limits. This is the coding engine's execution primitive.
import type { ToolDef } from '../registry.js';
import { dockerSandbox } from '../docker-sandbox.js';

const RUNTIMES: Record<string, { image: string; file: string; cmd: (f: string) => string[] }> = {
  python: { image: 'python:3.12-alpine', file: 'main.py', cmd: (f) => ['python', f] },
  node: { image: 'node:24-alpine', file: 'main.js', cmd: (f) => ['node', f] },
  sh: { image: 'alpine:3', file: 'run.sh', cmd: (f) => ['sh', f] },
};

export const codeExec: ToolDef = {
  name: 'code_exec',
  // Mutating (runs code) but fully sandboxed — the sandbox IS the safety boundary.
  // Note: because it's mutating, the structural gate blocks it when untrusted
  // content is in context (an injected "run this" is refused).
  untrustedOutput: false,
  description:
    'Run a code snippet in an isolated container (python | node | sh). No network, no host filesystem — safe. Returns stdout, stderr, exitCode. Use for computation, checking code, running tests.',
  inputSchema: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'node', 'sh'], description: 'runtime' },
      code: { type: 'string', description: 'source to run' },
    },
    required: ['language', 'code'],
  },
  async execute(args) {
    const lang = String(args.language ?? '');
    const rt = RUNTIMES[lang];
    if (!rt) throw new Error(`unsupported language: ${lang} (use python|node|sh)`);
    const code = String(args.code ?? '');
    if (!code.trim()) throw new Error('code is required');
    const res = await dockerSandbox().run({
      image: rt.image,
      cmd: rt.cmd(rt.file),
      files: { [rt.file]: code },
      timeoutMs: 30_000,
    });
    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      timedOut: res.timedOut,
    };
  },
};
