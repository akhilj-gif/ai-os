// Deterministic smoke suite runner (pnpm test). Runs only the suites that need
// NO Docker / Postgres / model quota, so it is safe in CI and as a fast local
// gate. DB/model-backed suites (memory, scheduler, graph, learning, whatsapp,
// forge, kernel/memory-taint) run separately against a live stack; the eval gym
// is `pnpm eval`. One of those is security-critical and worth naming:
//   tsx packages/kernel/src/graph-untrusted-smoke.ts
// It pins §8.3 on the GRAPH driver, which — unlike executor.ts — enforced none
// of it until 2026-09-04: a write-class tool ran there under untrusted context.
// Needs Postgres, because the taint latch is persisted on the task row.
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
  'packages/tools/src/search-smoke.ts', // search relevance gate — pins the Bing first-word-only garbage case
  'packages/tools/src/tools/video-ssrf-smoke.ts', // yt-dlp SUBPROCESS sink — ssrf-guard only covers fetch(); pins the metadata-service hole (security-critical)
  'packages/model-router/src/failover-smoke.ts',
  'packages/kernel/src/agents-smoke.ts',
  'packages/kernel/src/context-smoke.ts',
  'packages/kernel/src/remote-smoke.ts',
  'packages/packs/src/x-smoke.ts',
  'packages/packs/src/mobility-smoke.ts',
  'packages/packs/src/mobility-decide-smoke.ts',
  'packages/packs/src/uber-smoke.ts',
  'apps/browser-bridge/src/find-in-page-smoke.ts',
  'apps/browser-bridge/src/ssrf-route-smoke.ts', // bridge SSRF guard covers EVERY http(s) request (security-critical)
  'apps/browser-bridge/src/ref-identity-smoke.ts', // element refs carry identity — pins the wrong-element-click regression // bridge SSRF guard covers EVERY http(s) request, not just documents (security-critical)
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
