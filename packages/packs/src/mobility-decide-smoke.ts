// M14b decision-engine smoke — pure, deterministic (ADR-0017). Proves each of
// Akhil's travel rules fires correctly on injected context, and that booking
// is never triggered here (this engine only ranks/recommends).
// Run: npx tsx packages/packs/src/mobility-decide-smoke.ts
import { decideRide, DEFAULT_PREFS, type MobilityPrefs } from '@ai-os/tools';
import type { RideOption } from '@ai-os/tools';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const opt = (id: string, provider: 'uber' | 'ola' | 'rapido', vehicle: string, fare: number, eta: number, surge?: number): RideOption => ({
  optionId: id, provider, vehicle, fareLow: fare, fareHigh: fare + 15, currency: 'INR', etaMin: eta, ...(surge ? { surge } : {}),
});

// A representative option set: rapido bike (cheapest, fastest), ola auto, ola car, uber car.
const base = () => [
  opt('bike', 'rapido', 'bike', 55, 2),
  opt('auto', 'ola', 'auto', 90, 3),
  opt('olacar', 'ola', 'car', 120, 6),
  opt('ubercar', 'uber', 'car', 260, 4),
];

console.log('— rain rule —');
{
  const dry = decideRide(base(), { isRaining: false, hour: 14 });
  check('dry: bike stays available', dry.ranked.some((o) => o.vehicle === 'bike'));
  const wet = decideRide(base(), { isRaining: true, hour: 14 });
  check('rain: bikes dropped', !wet.ranked.some((o) => o.vehicle === 'bike'));
  check('rain: reason explained', wet.reasons.some((r) => /rain/i.test(r)));
  check('rain: bike listed in excluded', wet.excluded.some((e) => e.option.vehicle === 'bike'));
}

console.log('\n— prefer-car-within-₹X rule —');
{
  // olacar (120) is within ₹40 of auto (90)? 120-90=30 ≤ 40 → but top by balanced may be bike.
  // Make bike unavailable (rain) so top is auto(90); car(120) within 40 → promote car.
  const d = decideRide(base(), { isRaining: true, hour: 14 }, { ...DEFAULT_PREFS });
  check('car promoted when within ₹40 of the top non-car', d.recommended?.vehicle === 'car' && d.recommended.provider === 'ola', `${d.recommended?.provider} ${d.recommended?.vehicle}`);
  check('promotion reason explained', d.reasons.some((r) => /car was within/i.test(r)));
  // With the gap set to 0 (off), the auto should win instead.
  const off = decideRide(base(), { isRaining: true, hour: 14 }, { ...DEFAULT_PREFS, preferCarWithinRupees: 0 });
  check('rule off → cheapest (auto) recommended', off.recommended?.vehicle === 'auto');
}

console.log('\n— long-trip auto-over-bike rule —');
{
  const short = decideRide(base(), { distanceKm: 5, hour: 14 }, { ...DEFAULT_PREFS, preferCarWithinRupees: 0, avoidBikeIfRaining: false });
  check('short trip: bike allowed', short.ranked.some((o) => o.vehicle === 'bike'));
  const long = decideRide(base(), { distanceKm: 14, hour: 14 }, { ...DEFAULT_PREFS, preferCarWithinRupees: 0, avoidBikeIfRaining: false });
  check('long trip: bike dropped for auto', !long.ranked.some((o) => o.vehicle === 'bike'));
  check('long trip: reason explained', long.reasons.some((r) => /km/i.test(r)));
}

console.log('\n— late-night confirm rule —');
{
  const day = decideRide(base(), { hour: 14 });
  check('daytime: no mustConfirm', day.mustConfirm === false);
  const night = decideRide(base(), { hour: 23 });
  check('after 22:00: mustConfirm set', night.mustConfirm === true);
  check('night: reason explained', night.reasons.some((r) => /22:00|after/i.test(r)));
}

console.log('\n— rankBy —');
{
  // eta ranking: rapido bike (eta 2) fastest; disable other rules to isolate.
  const flat: MobilityPrefs = { rankBy: 'eta', avoidBikeIfRaining: false, preferCarWithinRupees: 0, autoOverBikeBeyondKm: 0, askAfterHour: null, maxSurge: null };
  const byEta = decideRide(base(), { hour: 14 }, flat);
  check('rank by eta → fastest (bike, 2min) first', byEta.recommended?.optionId === 'bike');
  const byPrice = decideRide(base(), { hour: 14 }, { ...flat, rankBy: 'price' });
  check('rank by price → cheapest (bike, ₹55) first', byPrice.recommended?.optionId === 'bike');
}

console.log('\n— fallback safety —');
{
  // Only bikes, and it's raining → engine must not return empty; falls back.
  const onlyBikes = [opt('b1', 'rapido', 'bike', 55, 2), opt('b2', 'uber', 'moto', 60, 3)];
  const d = decideRide(onlyBikes, { isRaining: true, hour: 14 });
  check('never returns empty when a rule filters everything', d.ranked.length === 2 && d.recommended !== null);
  check('fallback is explained', d.reasons.some((r) => /only bikes|filtered/i.test(r)));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
