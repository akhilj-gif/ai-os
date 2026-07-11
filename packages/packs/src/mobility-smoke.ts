// M14 mobility smoke — deterministic, no model, no network (ADR-0017). Proves
// the mock client + the pack's trust posture: estimate compares/sorts across
// providers, book records ONLY in the local outbox (no real ride), unknown
// optionId is refused, and the pack classifies mobility_book spend/never-auto.
// Run: npx tsx packages/packs/src/mobility-smoke.ts
import { mobilityEstimate, mobilityBook, mobilityMockOutbox } from '@ai-os/tools';
import { PACKS } from './index.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

// Guard: this smoke asserts MOCK behavior — a configured bridge would hit real
// providers. Refuse to run against one.
if (process.env.MOBILITY_BRIDGE_URL) {
  console.log('SKIP  MOBILITY_BRIDGE_URL is set — this smoke only runs against the mock.');
  process.exit(0);
}
// Determinism: disable the live weather lookup so the rain rule can't reorder
// options based on the real forecast for "home".
process.env.AIOS_MOBILITY_WEATHER = 'off';

const ctx = { pool: null as never, taskId: 'smoke' };

console.log('— estimate (compare + preference-aware recommendation) —');
{
  const r = (await mobilityEstimate.execute({ pickup: 'home', drop: 'airport' }, ctx)) as {
    options: Array<{ optionId: string; provider: string; vehicle: string; fareLow: number }>;
    recommendation: { provider: string; vehicle: string; reasons: string[]; mustConfirm: boolean } | null;
    mock?: boolean;
  };
  check('returns options across all three providers', new Set(r.options.map((o) => o.provider)).size === 3, [...new Set(r.options.map((o) => o.provider))].join(','));
  // Default prefs, no rain/distance → cheapest+fastest (rapido bike) wins; no car within ₹40 of it.
  check('recommends the Rapido bike (cheapest & fastest)', r.recommendation?.provider === 'rapido' && r.recommendation.vehicle === 'bike', JSON.stringify(r.recommendation?.provider + '/' + r.recommendation?.vehicle));
  check('recommendation carries plain-language reasons', (r.recommendation?.reasons.length ?? 0) > 0);
  check('flagged as mock (no bridge)', r.mock === true);
}
{
  const r = (await mobilityEstimate.execute({ pickup: 'home', drop: 'airport', vehicle: 'bike' }, ctx)) as { options: Array<{ vehicle: string }> };
  check('vehicle filter narrows to bikes only', r.options.length > 0 && r.options.every((o) => o.vehicle.includes('bike')));
}
{
  const r = (await mobilityEstimate.execute({ pickup: 'home', drop: 'airport', vehicle: 'bike' }, ctx)) as { options: Array<{ vehicle: string }> };
  check('vehicle filter narrows to bikes only', r.options.length > 0 && r.options.every((o) => o.vehicle.includes('bike')));
}

console.log('\n— book (mock outbox only, never a real ride) —');
{
  const before = mobilityMockOutbox.length;
  const r = (await mobilityBook.execute({ optionId: 'mock-rapido-bike' }, ctx)) as { ok?: boolean; provider?: string; mock?: boolean };
  check('book records in the mock outbox only', r.ok === true && r.mock === true && mobilityMockOutbox.length === before + 1);
  check('outbox records the chosen provider', mobilityMockOutbox.at(-1)!.provider === 'rapido');
  const bad = (await mobilityBook.execute({ optionId: 'does-not-exist' }, ctx)) as { error?: string };
  check('unknown optionId refused (no phantom booking)', !!bad.error && mobilityMockOutbox.length === before + 1);
}

console.log('\n— pack manifest trust posture —');
{
  const pack = PACKS.mobility;
  check('mobility pack registered with both tools', !!pack && pack.tools.length === 2);
  const est = pack!.policies.find((p) => p.tool === 'mobility_estimate');
  const book = pack!.policies.find((p) => p.tool === 'mobility_book');
  check('estimate is read + auto', est?.trustClass === 'read' && est.autoApprove === true);
  check('book is SPEND + NEVER auto', book?.trustClass === 'spend' && book.autoApprove === false);
  check('pack bundles the mobility eval suite', pack!.evalSuites.includes('mobility'));
  check('pack documents the go-live bridge requirement', (pack!.requires ?? []).some((r) => /MOBILITY_BRIDGE_URL|developer\.uber\.com/.test(r)));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
