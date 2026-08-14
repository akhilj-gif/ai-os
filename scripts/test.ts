// Deterministic smoke suite runner (pnpm test). Runs only the suites that need
// NO Docker / Postgres / model quota, so it is safe in CI and as a fast local
// gate. DB/model-backed suites (memory, scheduler, graph, learning, whatsapp,
// forge, kernel/memory-taint) run separately against a live stack; the eval gym
// is `pnpm eval`.
//
// Two further suites are excluded because they BIND PORTS (4000, and 3001 for
// the Vite one) to stand up a fake kernel API, so they need the stack DOWN
// rather than up, and cannot share a runner with either group:
//   cd apps/web   && npx tsx proxy-guard-smoke.mts
//   cd apps/voice && npx tsx proxy-guard-smoke.mts
// Both pin the ambient-authority guard on the /api proxies — the place the admin
// token is minted — including the same-site-spans-every-localhost-port and
// missing-header cases that were proven exploitable on 2026-08-13.
import { spawnSync } from 'node:child_process';

const SMOKES = [
  'packages/shared/src/json-smoke.ts', // model-output JSON extractor (used by 7 capture/plan paths)
  'packages/shared/src/ssrf-smoke.ts', // SSRF block-list, incl. pinned regressions for 2 real bypasses (security-critical)
  'packages/trust/src/smoke.ts', // trust gate + §8.3 injection defense + classify() invariants (security-critical)
  'packages/packs/src/terminal-smoke.ts', // terminal allowlist (security-critical)
  'packages/packs/src/forge-scan-smoke.ts', // Pack Forge AST gate — 16 pinned code-exec vectors (security-critical)
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
