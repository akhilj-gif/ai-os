// M14 — mobility pack tools (ADR-0017): book rides by voice across Uber / Ola /
// Rapido with cross-provider fare comparison. The OS talks to ONE bridge
// contract; behind it a real bridge fans out (Uber official API, Ola/Rapido
// browser automation) — or, with no bridge configured, a deterministic MOCK
// serves fixture fares and records bookings in an inspectable outbox (nothing
// is really booked). Same mock-first shape as the X pack.
//
// Trust: mobility_estimate is read/auto (compare fares). mobility_book is
// SPEND-class + auto_approve=false ALWAYS — it commits money and dispatches a
// driver, so every call queues for the user's approval showing provider +
// vehicle + fare. §8.3 also blocks it under untrusted context.
import type { ToolContext, ToolDef } from '../registry.js';
import { decideRide, DEFAULT_PREFS, type MobilityPrefs, type RideContext } from './mobility-decide.js';

export type Provider = 'uber' | 'ola' | 'rapido';

export interface RideOption {
  optionId: string; // opaque handle the user approves and mobility_book consumes
  provider: Provider;
  vehicle: string; // 'bike' | 'auto' | 'car' | 'cab-premium' | …
  fareLow: number;
  fareHigh: number;
  currency: string;
  etaMin: number; // pickup ETA, minutes
  surge?: number; // multiplier, when >1
}

const bridgeUrl = (): string | null => process.env.MOBILITY_BRIDGE_URL ?? null;

async function bridge<T>(path: string, body?: unknown): Promise<T> {
  const base = bridgeUrl();
  if (!base) throw new Error('no mobility bridge configured');
  const token = process.env.MOBILITY_BRIDGE_TOKEN;
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-bridge-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) throw new Error(`INFRA_RATELIMIT 429 (mobility-bridge): ${(await res.text()).slice(0, 200)}`);
  if (!res.ok) throw new Error(`mobility bridge ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

// --- Deterministic mock (no bridge): representative Indian-market fares so the
// compare/book flow is fully exercised. Rapido bike is cheapest; Uber has no
// bike; Ola spans auto→car. Booking lands in the mock outbox. ---
export const mobilityMockOutbox: Array<{ optionId: string; provider: Provider; vehicle: string; fare: number; at: string }> = [];

function mockOptions(): RideOption[] {
  return [
    { optionId: 'mock-rapido-bike', provider: 'rapido', vehicle: 'bike', fareLow: 55, fareHigh: 70, currency: 'INR', etaMin: 2 },
    { optionId: 'mock-rapido-auto', provider: 'rapido', vehicle: 'auto', fareLow: 95, fareHigh: 115, currency: 'INR', etaMin: 4 },
    { optionId: 'mock-ola-auto', provider: 'ola', vehicle: 'auto', fareLow: 90, fareHigh: 110, currency: 'INR', etaMin: 3 },
    { optionId: 'mock-ola-car', provider: 'ola', vehicle: 'car', fareLow: 230, fareHigh: 270, currency: 'INR', etaMin: 6 },
    { optionId: 'mock-uber-car', provider: 'uber', vehicle: 'car', fareLow: 250, fareHigh: 300, currency: 'INR', etaMin: 4, surge: 1.2 },
    { optionId: 'mock-uber-premium', provider: 'uber', vehicle: 'cab-premium', fareLow: 380, fareHigh: 440, currency: 'INR', etaMin: 5 },
  ];
}

/** Load the decision-engine preferences (M14b) — the editable/learnable
 *  mobility_prefs row, merged over the built-in defaults. Any DB hiccup falls
 *  back to defaults so a comparison never fails on preferences. */
async function loadPrefs(ctx: ToolContext | undefined): Promise<MobilityPrefs> {
  if (!ctx?.pool) return DEFAULT_PREFS;
  try {
    const row = (await ctx.pool.query<{ prefs: Partial<MobilityPrefs> }>(`SELECT prefs FROM mobility_prefs WHERE id = true`)).rows[0];
    return row?.prefs ? { ...DEFAULT_PREFS, ...row.prefs } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Best-effort "is it raining at the pickup?" via keyless open-meteo (geocode →
 *  current precipitation). Any failure → undefined, and the rain rule simply
 *  doesn't fire (fail-open is safe: booking is still approval-gated). */
async function isRainingAt(pickup: string): Promise<boolean | undefined> {
  if (process.env.AIOS_MOBILITY_WEATHER === 'off') return undefined;
  try {
    const geo = (await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(pickup)}&count=1`, { signal: AbortSignal.timeout(6000) })).json()) as {
      results?: Array<{ latitude: number; longitude: number }>;
    };
    const loc = geo.results?.[0];
    if (!loc) return undefined;
    const wx = (await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=precipitation,rain`, { signal: AbortSignal.timeout(6000) })).json()) as {
      current?: { precipitation?: number; rain?: number };
    };
    const p = wx.current;
    if (!p) return undefined;
    return (p.precipitation ?? 0) > 0 || (p.rain ?? 0) > 0;
  } catch {
    return undefined;
  }
}

export const mobilityEstimate: ToolDef = {
  name: 'mobility_estimate',
  untrustedOutput: false, // structured fares the bridge shapes — not free web content; flagging would wrongly block the follow-on booking
  description:
    'Compare ride options across Uber, Ola and Rapido AND get a smart recommendation. Returns each provider\'s vehicle types (bike/auto/car/…) with fare range/ETA/surge, plus a `recommendation` that applies the user\'s travel preferences (rank by price/ETA/balanced, avoid bikes in rain, prefer a car within ₹X of cheapest, auto over bike on long trips, confirm late-night) with plain-language `reasons`. Read-only — no ride is booked; book the recommended optionId with mobility_book (which asks for approval).',
  inputSchema: {
    type: 'object',
    properties: {
      pickup: { type: 'string', description: 'Pickup location (address or place name)' },
      drop: { type: 'string', description: 'Destination (address or place name)' },
      vehicle: { type: 'string', description: 'Optional filter: bike | auto | car. Omit to see all.' },
      distanceKm: { type: 'number', description: 'Trip distance in km, if known (enables the long-trip rule).' },
    },
    required: ['pickup', 'drop'],
  },
  async execute(args, ctx) {
    const pickup = String(args.pickup ?? '').trim();
    const drop = String(args.drop ?? '').trim();
    if (!pickup || !drop) throw new Error('pickup and drop are required');
    let options: RideOption[];
    let live: boolean;
    if (bridgeUrl()) {
      const r = await bridge<{ options: RideOption[]; distanceKm?: number }>('/estimate', { pickup, drop });
      options = r.options ?? [];
      live = true;
      if (r.distanceKm != null && args.distanceKm == null) args = { ...args, distanceKm: r.distanceKm };
    } else {
      options = mockOptions();
      live = false;
    }
    const vf = String(args.vehicle ?? '').trim().toLowerCase();
    if (vf) options = options.filter((o) => o.vehicle.toLowerCase().includes(vf));

    // M14b decision engine: apply the user's learned preferences to produce a
    // ranked recommendation with reasons. Context: local hour + rain + distance.
    const prefs = await loadPrefs(ctx);
    const context: RideContext = {
      hour: new Date().getHours(),
      distanceKm: args.distanceKm != null ? Number(args.distanceKm) : undefined,
      isRaining: prefs.avoidBikeIfRaining ? await isRainingAt(pickup) : undefined,
    };
    const decision = decideRide(options, context, prefs);

    return {
      pickup,
      drop,
      options: decision.ranked,
      recommendation: decision.recommended
        ? {
            optionId: decision.recommended.optionId,
            provider: decision.recommended.provider,
            vehicle: decision.recommended.vehicle,
            fareLow: decision.recommended.fareLow,
            fareHigh: decision.recommended.fareHigh,
            etaMin: decision.recommended.etaMin,
            reasons: decision.reasons,
            mustConfirm: decision.mustConfirm,
          }
        : null,
      excluded: decision.excluded.map((e) => ({ provider: e.option.provider, vehicle: e.option.vehicle, reason: e.reason })),
      ...(live ? {} : { mock: true, note: 'No mobility bridge configured — sample fares. Configure MOBILITY_BRIDGE_URL (Uber API + Ola/Rapido) for live comparison.' }),
    };
  },
};

export const mobilityBook: ToolDef = {
  name: 'mobility_book',
  untrustedOutput: false,
  description:
    'BOOK a ride by its optionId (from mobility_estimate) — SPENDS money and dispatches a driver, so every call is queued for the user\'s one-click approval showing the provider, vehicle and fare; nothing books until they approve. Once the user has chosen an option and asked to book, call this DIRECTLY with the optionId — do not ask for confirmation in prose first.',
  inputSchema: {
    type: 'object',
    properties: {
      optionId: { type: 'string', description: 'The optionId of the chosen ride from mobility_estimate' },
    },
    required: ['optionId'],
  },
  async execute(args) {
    const optionId = String(args.optionId ?? '').trim();
    if (!optionId) throw new Error('optionId is required');
    if (bridgeUrl()) {
      return bridge<{ ok: boolean; bookingId: string; provider: Provider; status: string }>('/book', { optionId });
    }
    // Mock: resolve the option and record it — nothing is really booked.
    const opt = mockOptions().find((o) => o.optionId === optionId);
    if (!opt) return { error: `unknown optionId "${optionId}" — run mobility_estimate first` };
    const bookingId = `mock-booking-${mobilityMockOutbox.length + 1}`;
    mobilityMockOutbox.push({ optionId, provider: opt.provider, vehicle: opt.vehicle, fare: opt.fareLow, at: new Date().toISOString() });
    return { ok: true, bookingId, provider: opt.provider, vehicle: opt.vehicle, status: 'confirmed', mock: true, note: 'No mobility bridge configured — recorded in the mock outbox, no real ride booked.' };
  },
};
