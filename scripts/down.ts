// `pnpm down` — stop the OS. Stops the pm2 services and the infra containers.
// Never removes volumes (your data + WhatsApp session survive). `pnpm up` restarts.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C, run, runLive } from './ops.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log(C.bold('\n▶ ai-os down\n'));

console.log('▶ stopping pm2 services');
await run('npx', ['pm2', 'delete', join(root, 'ecosystem.config.cjs')], { cwd: root, timeoutMs: 30_000 });
console.log(C.green('  services stopped'));

console.log('\n▶ stopping containers (data + session preserved)');
await runLive('docker', ['compose', 'stop'], { cwd: join(root, 'infra') });

console.log(C.dim('\n  (containers stopped, not removed — `pnpm up` brings everything back)\n'));
