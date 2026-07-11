// M14c Uber-client smoke — deterministic, no network (ADR-0017). Verifies the
// PURE logic the live Uber path depends on: OAuth authorize-URL shape, option
// encode/decode round-trip, vehicle classification, and mapping a sample Uber
// price/time response into RideOption[]. The network calls (estimate/book/
// token) are UNVERIFIED until keys — this locks down everything around them.
// Run: npx tsx packages/packs/src/uber-smoke.ts
import { uberAuthorizeUrl, uberVehicleClass, encodeUberOption, decodeUberOption, isUberOption, mapUberEstimates, uberConfigured, type UberPriceItem, type UberTimeItem, type Coords } from '@ai-os/tools';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

console.log('— OAuth authorize URL —');
{
  const prev = process.env.UBER_CLIENT_ID;
  process.env.UBER_CLIENT_ID = 'test-client';
  process.env.UBER_REDIRECT_URI = 'http://localhost:4000/oauth/uber/callback';
  const u = new URL(uberAuthorizeUrl('state123'));
  check('points at auth.uber.com/authorize', u.origin + u.pathname === 'https://auth.uber.com/oauth/v2/authorize');
  check('carries client_id, response_type=code, request scope, state', u.searchParams.get('client_id') === 'test-client' && u.searchParams.get('response_type') === 'code' && u.searchParams.get('scope') === 'request' && u.searchParams.get('state') === 'state123');
  check('redirect_uri is our callback', u.searchParams.get('redirect_uri') === 'http://localhost:4000/oauth/uber/callback');
  if (prev === undefined) delete process.env.UBER_CLIENT_ID;
  else process.env.UBER_CLIENT_ID = prev;
}

console.log('\n— vehicle classification —');
check('Uber Moto → bike', uberVehicleClass('Uber Moto') === 'bike');
check('Uber Auto → auto', uberVehicleClass('Uber Auto') === 'auto');
check('UberGo → car', uberVehicleClass('UberGo') === 'car');
check('Premier → car', uberVehicleClass('Premier') === 'car');

console.log('\n— option encode/decode round-trip —');
{
  const s: Coords = { lat: 17.44, lng: 78.39 };
  const e: Coords = { lat: 17.24, lng: 78.43 };
  const id = encodeUberOption('prod-xyz', s, e, 'fare-abc');
  check('encoded id is recognized as an Uber option', isUberOption(id));
  const d = decodeUberOption(id);
  check('decodes productId + coords + fareId', !!d && d.productId === 'prod-xyz' && d.s.lat === 17.44 && d.e.lng === 78.43 && d.fareId === 'fare-abc');
  check('a non-uber optionId is not misread', decodeUberOption('mock-rapido-bike') === null && !isUberOption('mock-rapido-bike'));
}

console.log('\n— price/time response → RideOption[] —');
{
  const s: Coords = { lat: 17.44, lng: 78.39 };
  const e: Coords = { lat: 17.24, lng: 78.43 };
  const prices: UberPriceItem[] = [
    { product_id: 'p-moto', display_name: 'Uber Moto', low_estimate: 60, high_estimate: 75, currency_code: 'INR', surge_multiplier: 1 },
    { product_id: 'p-go', display_name: 'UberGo', low_estimate: 240, high_estimate: 290, currency_code: 'INR', surge_multiplier: 1.3 },
    { product_id: 'p-null', display_name: 'Unavailable', low_estimate: null, high_estimate: null, currency_code: 'INR' },
  ];
  const times: UberTimeItem[] = [
    { product_id: 'p-moto', estimate: 120 }, // 2 min
    { product_id: 'p-go', estimate: 300 }, // 5 min
  ];
  const opts = mapUberEstimates(prices, times, s, e);
  check('null-fare products dropped', opts.length === 2);
  const moto = opts.find((o) => o.vehicle === 'bike');
  const go = opts.find((o) => o.vehicle === 'car');
  check('moto mapped: bike, ₹60-75, eta 2', moto?.fareLow === 60 && moto.fareHigh === 75 && moto.etaMin === 2 && moto.provider === 'uber');
  check('surge carried through when >1', go?.surge === 1.3);
  check('no surge field when 1×', !!moto && moto.surge === undefined);
  check('optionIds are bookable Uber ids', opts.every((o) => isUberOption(o.optionId)));
}

console.log('\n— uberConfigured gate —');
{
  const prev = { id: process.env.UBER_CLIENT_ID, sec: process.env.UBER_CLIENT_SECRET, red: process.env.UBER_REDIRECT_URI };
  delete process.env.UBER_CLIENT_ID; delete process.env.UBER_CLIENT_SECRET; delete process.env.UBER_REDIRECT_URI;
  check('not configured with no env', uberConfigured() === false);
  process.env.UBER_CLIENT_ID = 'a'; process.env.UBER_CLIENT_SECRET = 'b'; process.env.UBER_REDIRECT_URI = 'c';
  check('configured when all three present', uberConfigured() === true);
  if (prev.id === undefined) delete process.env.UBER_CLIENT_ID; else process.env.UBER_CLIENT_ID = prev.id;
  if (prev.sec === undefined) delete process.env.UBER_CLIENT_SECRET; else process.env.UBER_CLIENT_SECRET = prev.sec;
  if (prev.red === undefined) delete process.env.UBER_REDIRECT_URI; else process.env.UBER_REDIRECT_URI = prev.red;
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
