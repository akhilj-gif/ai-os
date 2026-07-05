// Docker-backed SandboxRunner (blueprint §8.2, ADR-0009). THE only sanctioned
// place the OS shells out (docker CLI). Every guarantee from the contract is
// enforced here: non-root, read-only rootfs, no host FS (only a per-run workspace
// mount), network denied by default, memory/cpu/pids/time limits, killed on timeout.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SandboxRunner, SandboxSpec, SandboxResult } from './sandbox.js';

const MEM = process.env.SANDBOX_MEMORY ?? '512m';
const CPUS = process.env.SANDBOX_CPUS ?? '1';

/** Docker Desktop / Linux both accept an absolute host path for -v; on win32 we
 *  pass it through (Docker Desktop translates C:\... itself). */
function mountPath(p: string): string {
  return p;
}

export class DockerSandbox implements SandboxRunner {
  async run(spec: SandboxSpec): Promise<SandboxResult> {
    const work = mkdtempSync(join(tmpdir(), 'aios-sbx-'));
    try {
      for (const [rel, content] of Object.entries(spec.files ?? {})) {
        const full = join(work, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
      }
      const name = `aios-${randomUUID().slice(0, 12)}`;
      const net = spec.egressAllowlist && spec.egressAllowlist.length > 0 ? 'bridge' : 'none';
      const args = [
        'run', '--rm', '--name', name,
        '--network', net,           // deny by default
        '-u', '1000:1000',          // non-root
        '--read-only',              // read-only root filesystem
        '--tmpfs', '/tmp:rw,size=64m',
        '--memory', MEM, '--cpus', CPUS, '--pids-limit', '256',
        '--cap-drop', 'ALL',        // no Linux capabilities
        '-v', `${mountPath(work)}:/work:rw`, // ONLY the per-run workspace, nothing of the host
        '-w', '/work',
        spec.image,
        ...spec.cmd,
      ];

      return await new Promise<SandboxResult>((resolve) => {
        const child = spawn('docker', args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const cap = (buf: Buffer, add: (s: string) => void) => add(buf.toString('utf8').slice(0, 200_000));
        child.stdout.on('data', (b) => cap(b, (s) => (stdout += s)));
        child.stderr.on('data', (b) => cap(b, (s) => (stderr += s)));

        const killer = setTimeout(() => {
          timedOut = true;
          spawn('docker', ['kill', name], { windowsHide: true });
        }, spec.timeoutMs);

        child.on('close', (code) => {
          clearTimeout(killer);
          resolve({ stdout: stdout.slice(0, 100_000), stderr: stderr.slice(0, 20_000), exitCode: code ?? -1, timedOut });
        });
        child.on('error', (err) => {
          clearTimeout(killer);
          resolve({ stdout, stderr: `docker spawn failed: ${err.message}`, exitCode: -1, timedOut });
        });
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

let shared: DockerSandbox | null = null;
export function dockerSandbox(): DockerSandbox {
  shared ??= new DockerSandbox();
  return shared;
}
