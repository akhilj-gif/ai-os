// Deterministic smoke suite runner (pnpm test). Runs only the suites that need
// NO Docker / Postgres / model quota, so it is safe in CI and as a fast local
// gate. DB/model-backed suites (memory, scheduler, graph, learning, whatsapp,
// forge, kernel/memory-taint) run separately against a live stack; the eval gym
// is `pnpm eval`. One of those is security-critical and worth naming:
//   tsx packages/kernel/src/graph-untrusted-smoke.ts
//   tsx packages/kernel/src/pending-ttl-smoke.ts
//   tsx packages/kernel/src/graph-recovery-smoke.ts
//   tsx packages/kernel/src/market-db-smoke.ts
// The markets suite pins what goes wrong in trading bots specifically: a rule
// firing twice (the runaway buy), two orders spending the same cash, a fill at
// a closed-market price, and a disabled pack that keeps trading. It runs in a
// throwaway schema because the paper account is derived from EVERY trade row.
// The recovery suite pins that a rate-limited step is retried/parked instead of
// killing the task (85% of this system's step failures were transient), and
// that a MUTATING tool is still never re-fired. Needs Postgres for the durable
// park (steps.retry_at); the pure policy half runs in `pnpm test` above.
// Pins that an approval card EXPIRES (24h): decidePendingAction used to check
// only status=pending, so a 71-day-old purge_all_data card was still armed.
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
  'packages/kernel/src/tool-select-smoke.ts', // per-turn tool selection — pins that filtering never silently drops a needed tool
  'packages/kernel/src/context-smoke.ts',
  'packages/kernel/src/remote-smoke.ts',
  'packages/packs/src/x-smoke.ts',
  'packages/tools/src/tools/instagram-smoke.ts', // instagram pack — pins the mock client + the caption/hashtag/public-image limits
  'packages/model-router/src/signature-smoke.ts', // mid-turn failover replays Groq's unsigned tool calls to Gemini — pins the documented placeholder and that real signatures pass through
  'packages/tools/src/tools/market-smoke.ts', // markets pack — average-cost P&L, overspend/short refusals, market hours, quotes carry their age and no provider prose
  'packages/tools/src/tools/connectors-smoke.ts', // app connectors — pins the slug round trip (save-then-run) and the arg contracts
  'packages/kernel/src/turn-budget-smoke.ts', // per-turn prompt cost + honest failure text — pins the 2,632-token pack-prompt cut and the 413-is-not-transient message
  'packages/kernel/src/recovery-smoke.ts', // failure recovery policy — pins that transient failures retry AND that a trust refusal never does
  'packages/packs/src/mobility-smoke.ts',
  'packages/packs/src/mobility-decide-smoke.ts',
  'packages/packs/src/uber-smoke.ts',
  'apps/browser-bridge/src/find-in-page-smoke.ts',
  'apps/browser-bridge/src/ssrf-route-smoke.ts', // bridge SSRF guard covers EVERY http(s) request (security-critical)
  'apps/browser-bridge/src/ref-identity-smoke.ts', // element refs carry identity — pins the wrong-element-click regression // bridge SSRF guard covers EVERY http(s) request, not just documents (security-critical)
  'apps/web/markdown-smoke.ts', // chat Markdown — replies render without literal **, and attacker text inside a reply can never become markup (security-critical)
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
