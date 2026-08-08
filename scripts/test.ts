// Deterministic smoke suite runner (pnpm test). Runs only the suites that need
// NO Docker / Postgres / model quota, so it is safe in CI and as a fast local
// gate. DB/model-backed suites (memory, scheduler, graph, learning, whatsapp,
// forge) run separately against a live stack; the eval gym is `pnpm eval`.
import { spawnSync } from 'node:child_process';

const SMOKES = [
  'packages/trust/src/smoke.ts', // trust gate + §8.3 injection defense (security-critical)
  'packages/packs/src/terminal-smoke.ts', // terminal allowlist (security-critical)
  'packages/packs/src/files-smoke.ts',
  'packages/packs/src/browser-smoke.ts',
  'packages/model-router/src/failover-smoke.ts',
  'packages/kernel/src/agents-smoke.ts',
  'packages/kernel/src/context-smoke.ts',
  'packages/kernel/src/remote-smoke.ts',
  'packages/packs/src/x-smoke.ts',
  'packages/packs/src/mobility-smoke.ts',
  'packages/packs/src/mobility-decide-smoke.ts',
  'packages/packs/src/uber-smoke.ts',
  'apps/browser-bridge/src/find-in-page-smoke.ts',
  'apps/voice/src/lib/vad-smoke.ts',
];

let failed = 0;
for (const f of SMOKES) {
  const r = spawnSync('node', ['--import', 'tsx', f], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`✓ ${f}`);
  } else {
    failed++;
    console.error(`✗ ${f}\n${(r.stdout ?? '') + (r.stderr ?? '')}`);
  }
}
console.log(failed ? `\n${failed}/${SMOKES.length} smoke suite(s) FAILED` : `\nAll ${SMOKES.length} smoke suites passed`);
process.exit(failed ? 1 : 0);
