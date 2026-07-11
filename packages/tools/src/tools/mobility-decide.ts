// M14b — the travel DECISION ENGINE (ADR-0017). This is what turns a booking
// interface into a decision engine: given the compared ride options plus
// context (time of day, rain, trip distance) and the user's learned
// preferences, it produces a RANKED recommendation with plain-language reasons
// and a mustConfirm flag — while booking itself stays spend/approval-gated.
//
// Pure and deterministic (mobility-decide-smoke covers it): no clock, no
// network, no DB — the caller injects context and prefs. Preferences are DATA
// (a mobility_prefs row, editable and learnable), so the engine's behavior
// changes as the user's habits are recorded, without code changes.
import type { RideOption } from './mobility.js';

export interface MobilityPrefs {
  /** How to rank: cheapest, soonest-arriving, or a normalized blend. */
  rankBy: 'price' | 'eta' | 'balanced';
  /** Skip bikes when it's raining. */
  avoidBikeIfRaining: boolean;
  /** If the cheapest isn't a car but a car is within this many ₹ of it, prefer the car. 0 = off. */
  preferCarWithinRupees: number;
  /** For trips longer than this (km), pick an auto over a bike. 0 = off. */
  autoOverBikeBeyondKm: number;
  /** Local hour (0-23) at/after which a booking should be explicitly confirmed. null = never. */
  askAfterHour: number | null;
  /** Flag/deprioritize options whose surge exceeds this multiplier. null = off. */
  maxSurge: number | null;
}

export const DEFAULT_PREFS: MobilityPrefs = {
  rankBy: 'balanced',
  avoidBikeIfRaining: true,
  preferCarWithinRupees: 40,
  autoOverBikeBeyondKm: 10,
  askAfterHour: 22,
  maxSurge: null,
};

export interface RideContext {
  /** Local hour 0-23 (caller passes it; engine stays clock-free). */
  hour?: number;
  isRaining?: boolean;
  distanceKm?: number;
}

export interface RideDecision {
  ranked: RideOption[];
  recommended: RideOption | null;
  reasons: string[];
  /** True when a preference says "don't just book — confirm intent first" (e.g. late night). Booking already requires approval; this is a stronger, explicit nudge. */
  mustConfirm: boolean;
  /** Options removed by a rule, with why (surfaced so the choice is explainable). */
  excluded: Array<{ option: RideOption; reason: string }>;
}

const isBike = (v: string) => /bike|moto/i.test(v);
const isAuto = (v: string) => /auto|rick/i.test(v);
const isCar = (v: string) => /car|cab|sedan|suv|premium|prime|mini/i.test(v);
const mid = (o: RideOption) => (o.fareLow + o.fareHigh) / 2;

/** Normalize to 0..1 across the set (0 = best). Guards a single-option set. */
function norm(vals: number[]): (v: number) => number {
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo;
  return (v) => (span === 0 ? 0 : (v - lo) / span);
}

export function decideRide(options: RideOption[], context: RideContext = {}, prefs: MobilityPrefs = DEFAULT_PREFS): RideDecision {
  const reasons: string[] = [];
  const excluded: RideDecision['excluded'] = [];
  let pool = [...options];

  // Rule: avoid bikes when it's raining.
  if (prefs.avoidBikeIfRaining && context.isRaining) {
    const bikes = pool.filter((o) => isBike(o.vehicle));
    if (bikes.length && pool.length > bikes.length) {
      pool = pool.filter((o) => !isBike(o.vehicle));
      for (const b of bikes) excluded.push({ option: b, reason: "it's raining — skipping bikes" });
      reasons.push("It's raining, so I dropped bike options.");
    } else if (bikes.length) {
      reasons.push("It's raining and only bikes are available — flagging that.");
    }
  }

  // Rule: for long trips, prefer an auto over a bike.
  if (prefs.autoOverBikeBeyondKm > 0 && (context.distanceKm ?? 0) > prefs.autoOverBikeBeyondKm) {
    const bikes = pool.filter((o) => isBike(o.vehicle));
    const hasAuto = pool.some((o) => isAuto(o.vehicle));
    if (bikes.length && hasAuto) {
      pool = pool.filter((o) => !isBike(o.vehicle));
      for (const b of bikes) excluded.push({ option: b, reason: `trip is over ${prefs.autoOverBikeBeyondKm} km — auto over bike` });
      reasons.push(`It's a ${context.distanceKm} km trip, so I preferred an auto over a bike.`);
    }
  }

  if (pool.length === 0) {
    // Every option got filtered — fall back to the originals rather than nothing.
    pool = [...options];
    reasons.push('All options were filtered by your rules; showing everything so you can still choose.');
  }

  // Optional surge flag.
  if (prefs.maxSurge != null) {
    const surged = pool.filter((o) => (o.surge ?? 1) > prefs.maxSurge!);
    for (const s of surged) reasons.push(`${s.provider} ${s.vehicle} is surging (${s.surge}×).`);
  }

  // Rank.
  const priceN = norm(pool.map(mid));
  const etaN = norm(pool.map((o) => o.etaMin));
  const score = (o: RideOption): number => {
    if (prefs.rankBy === 'price') return priceN(mid(o));
    if (prefs.rankBy === 'eta') return etaN(o.etaMin);
    return 0.6 * priceN(mid(o)) + 0.4 * etaN(o.etaMin); // balanced
  };
  const ranked = [...pool].sort((a, b) => score(a) - score(b));
  if (prefs.rankBy === 'eta') reasons.push('Ranked by arrival time (soonest first).');
  else if (prefs.rankBy === 'balanced') reasons.push('Ranked by a blend of price and arrival time.');

  // Rule: prefer a car if it's within ₹X of the top pick.
  if (prefs.preferCarWithinRupees > 0 && ranked.length > 1) {
    const top = ranked[0]!;
    if (!isCar(top.vehicle)) {
      const car = ranked.find((o) => isCar(o.vehicle));
      if (car && mid(car) - mid(top) <= prefs.preferCarWithinRupees) {
        ranked.splice(ranked.indexOf(car), 1);
        ranked.unshift(car);
        reasons.push(`A car was within ₹${prefs.preferCarWithinRupees} of the cheapest, so I recommended it for comfort.`);
      }
    }
  }

  // Rule: confirm bookings late at night.
  let mustConfirm = false;
  if (prefs.askAfterHour != null && context.hour != null && context.hour >= prefs.askAfterHour) {
    mustConfirm = true;
    reasons.push(`It's after ${prefs.askAfterHour}:00 — I'll confirm before booking.`);
  }

  return { ranked, recommended: ranked[0] ?? null, reasons, mustConfirm, excluded };
}
