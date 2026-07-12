// M14c — real Uber API client (ADR-0017). Uber's Ride Requests API supports
// SELF-booking without enterprise approval: the privileged `request` scope
// authorizes on your own account (OAuth 2.0 user context). This module is the
// live Uber source behind the mobility pack; when UBER_* env is absent the
// pack uses its mock.
//
// HONESTY: the NETWORK calls here (estimate/book/token) are written to Uber's
// documented v1.2 shapes but are UNVERIFIED until Akhil registers an app and
// adds keys — exactly like the Baileys WhatsApp bridge was until first paired.
// Endpoint paths + response field names are centralized below so they're easy
// to correct against the live API. The PURE logic (auth URL, option encoding,
// response→RideOption mapping) is deterministically smoke-tested.
import type pg from 'pg';
import type { RideOption } from './mobility.js';

const AUTH_BASE = 'https://auth.uber.com/oauth/v2';
const API_BASE = process.env.UBER_API_BASE ?? 'https://api.uber.com/v1.2';
const SCOPES = 'request'; // privileged scope for booking on your own account

export function uberConfigured(): boolean {
  return !!(process.env.UBER_CLIENT_ID && process.env.UBER_CLIENT_SECRET && process.env.UBER_REDIRECT_URI);
}

// --- OAuth (authorization-code, user context) ---------------------------------

export function uberAuthorizeUrl(state: string): string {
  const u = new URL(`${AUTH_BASE}/authorize`);
  u.searchParams.set('client_id', process.env.UBER_CLIENT_ID ?? '');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('redirect_uri', process.env.UBER_REDIRECT_URI ?? '');
  u.searchParams.set('state', state);
  return u.toString();
}

interface UberToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

/** Exchange the callback code and persist tokens (oauth_tokens provider='uber'). UNVERIFIED. */
export async function exchangeUberCode(pool: pg.Pool, code: string): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.UBER_CLIENT_ID ?? '',
      client_secret: process.env.UBER_CLIENT_SECRET ?? '',
      grant_type: 'authorization_code',
      redirect_uri: process.env.UBER_REDIRECT_URI ?? '',
      code,
    }),
  });
  if (!res.ok) throw new Error(`Uber token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const tok = (await res.json()) as UberToken;
  if (!tok.refresh_token) throw new Error('Uber returned no refresh_token — retry /oauth/uber');
  await pool.query(
    `INSERT INTO oauth_tokens (provider, refresh_token, access_token, access_token_expires_at, scopes)
     VALUES ('uber', $1, $2, now() + ($3 || ' seconds')::interval, $4)
     ON CONFLICT (provider) DO UPDATE SET
       refresh_token = EXCLUDED.refresh_token, access_token = EXCLUDED.access_token,
       access_token_expires_at = EXCLUDED.access_token_expires_at, scopes = EXCLUDED.scopes, updated_at = now()`,
    [tok.refresh_token, tok.access_token, String(tok.expires_in), (tok.scope ?? SCOPES).split(' ')],
  );
}

export class UberNotConnectedError extends Error {
  constructor() {
    super('Uber not connected — visit http://localhost:4000/oauth/uber to authorize ride booking on your account.');
  }
}

/** Read + refresh the Uber user token (mirrors getGoogleAccessToken). UNVERIFIED. */
export async function getUberToken(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ refresh_token: string; access_token: string | null; access_token_expires_at: Date | null }>(
    `SELECT refresh_token, access_token, access_token_expires_at FROM oauth_tokens WHERE provider = 'uber'`,
  );
  const row = rows[0];
  if (!row) throw new UberNotConnectedError();
  if (row.access_token && row.access_token_expires_at && row.access_token_expires_at.getTime() - Date.now() > 60_000) {
    return row.access_token;
  }
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.UBER_CLIENT_ID ?? '',
      client_secret: process.env.UBER_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Uber token refresh failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const tok = (await res.json()) as UberToken;
  await pool.query(
    `UPDATE oauth_tokens SET access_token=$1, access_token_expires_at = now() + ($2 || ' seconds')::interval, updated_at=now() WHERE provider='uber'`,
    [tok.access_token, String(tok.expires_in)],
  );
  return tok.access_token;
}

// --- Geocoding (keyless open-meteo) -------------------------------------------

export interface Coords {
  lat: number;
  lng: number;
}

/** open-meteo's place search returns zero results for comma-joined "locality,
 *  city" strings even though each half resolves alone, and with no country
 *  bias a bare English name like "Bangalore" matches an unrelated same-named
 *  town in Pakistan ahead of "Bengaluru", India. countryCode=IN biases to the
 *  app's home market; on a comma-joined miss, retry with just the part
 *  before the first comma. */
async function geocodeSearch(query: string): Promise<{ latitude: number; longitude: number } | null> {
  const r = (await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&countryCode=IN`, { signal: AbortSignal.timeout(6000) })).json()) as {
    results?: Array<{ latitude: number; longitude: number }>;
  };
  return r.results?.[0] ?? null;
}

export async function geocode(place: string): Promise<Coords | null> {
  try {
    const commaIdx = place.indexOf(',');
    const loc = (await geocodeSearch(place)) ?? (commaIdx === -1 ? null : await geocodeSearch(place.slice(0, commaIdx).trim()));
    return loc ? { lat: loc.latitude, lng: loc.longitude } : null;
  } catch {
    return null;
  }
}

// --- Pure mapping / option encoding (deterministically tested) ----------------

/** Map an Uber product display name to our vehicle taxonomy. */
export function uberVehicleClass(displayName: string): string {
  const n = displayName.toLowerCase();
  if (/moto|bike/.test(n)) return 'bike';
  if (/auto|rick/.test(n)) return 'auto';
  return 'car'; // UberGo, Premier, XL, Go Sedan, Black …
}

const DELIM = '~';
/** optionId carries everything mobility_book needs (booking gets only the id). */
export function encodeUberOption(productId: string, s: Coords, e: Coords, fareId = ''): string {
  return ['uber', productId, s.lat, s.lng, e.lat, e.lng, fareId].join(DELIM);
}
export function decodeUberOption(optionId: string): { productId: string; s: Coords; e: Coords; fareId: string } | null {
  const p = optionId.split(DELIM);
  if (p[0] !== 'uber' || p.length < 6) return null;
  return { productId: p[1]!, s: { lat: Number(p[2]), lng: Number(p[3]) }, e: { lat: Number(p[4]), lng: Number(p[5]) }, fareId: p[6] ?? '' };
}
export function isUberOption(optionId: string): boolean {
  return optionId.startsWith(`uber${DELIM}`);
}

// Uber v1.2 GET /estimates/price item shape (the fields we use).
export interface UberPriceItem {
  product_id: string;
  display_name: string;
  localized_display_name?: string;
  low_estimate: number | null;
  high_estimate: number | null;
  currency_code: string | null;
  duration?: number; // trip seconds
  surge_multiplier?: number;
}
// GET /estimates/time item → pickup ETA (seconds) per product.
export interface UberTimeItem {
  product_id: string;
  estimate: number; // seconds to pickup
}

/** price estimates (+ optional pickup times) → RideOption[]. Pure. */
export function mapUberEstimates(prices: UberPriceItem[], times: UberTimeItem[], s: Coords, e: Coords): RideOption[] {
  const etaByProduct = new Map(times.map((t) => [t.product_id, Math.round(t.estimate / 60)]));
  return prices
    .filter((p) => p.low_estimate != null && p.high_estimate != null)
    .map((p) => ({
      optionId: encodeUberOption(p.product_id, s, e),
      provider: 'uber' as const,
      vehicle: uberVehicleClass(p.localized_display_name ?? p.display_name),
      fareLow: p.low_estimate!,
      fareHigh: p.high_estimate!,
      currency: p.currency_code ?? 'INR',
      etaMin: etaByProduct.get(p.product_id) ?? 0,
      ...(p.surge_multiplier && p.surge_multiplier > 1 ? { surge: p.surge_multiplier } : {}),
    }));
}

// --- Live network calls (UNVERIFIED until keys) -------------------------------

async function uberApi<T>(pool: pg.Pool, path: string, init?: RequestInit): Promise<T> {
  const token = await getUberToken(pool);
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Accept-Language': 'en_IN', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) throw new Error(`INFRA_RATELIMIT 429 (uber): ${(await res.text()).slice(0, 200)}`);
  if (!res.ok) throw new Error(`uber api ${res.status} on ${path.split('?')[0]}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Live Uber fare comparison across products. UNVERIFIED. */
export async function uberEstimate(pool: pg.Pool, pickup: string, drop: string): Promise<RideOption[]> {
  const s = await geocode(pickup);
  const e = await geocode(drop);
  if (!s || !e) throw new Error(`could not geocode ${!s ? 'pickup' : 'drop'} location`);
  const priceQ = `?start_latitude=${s.lat}&start_longitude=${s.lng}&end_latitude=${e.lat}&end_longitude=${e.lng}`;
  const prices = await uberApi<{ prices: UberPriceItem[] }>(pool, `/estimates/price${priceQ}`);
  let times: UberTimeItem[] = [];
  try {
    const t = await uberApi<{ times: UberTimeItem[] }>(pool, `/estimates/time?start_latitude=${s.lat}&start_longitude=${s.lng}`);
    times = t.times ?? [];
  } catch {
    /* pickup ETAs are a nice-to-have; ranking still works on price */
  }
  return mapUberEstimates(prices.prices ?? [], times, s, e);
}

/** Live Uber booking — runs ONLY after the user approves the queued spend
 *  action (mobility_book is spend/approval-gated). UNVERIFIED. */
export async function uberBook(pool: pg.Pool, optionId: string): Promise<{ ok: boolean; bookingId: string; provider: 'uber'; status: string }> {
  const d = decodeUberOption(optionId);
  if (!d) throw new Error(`not an Uber option: ${optionId}`);
  const body: Record<string, unknown> = {
    product_id: d.productId,
    start_latitude: d.s.lat,
    start_longitude: d.s.lng,
    end_latitude: d.e.lat,
    end_longitude: d.e.lng,
  };
  if (d.fareId) body.fare_id = d.fareId;
  const r = await uberApi<{ request_id: string; status: string }>(pool, '/requests', { method: 'POST', body: JSON.stringify(body) });
  return { ok: true, bookingId: r.request_id, provider: 'uber', status: r.status };
}
