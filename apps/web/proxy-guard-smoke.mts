// Ambient-authority guard on the Next /api proxy. Binds port 4000, so run this
// with the OS stack DOWN (it needs the port free to stand up a fake kernel API).
// Run: cd apps/web && npx tsx proxy-guard-smoke.mts
//
// WHY. This proxy is the one place the admin token is minted: it attaches
// AIOS_API_TOKEN to whatever request arrives, so anything reaching it executes
// fully authenticated. That is CSRF with an injected credential rather than a
// cookie — the attacking page cannot read the response, but the side effect
// (approve a pending action, promote a trust policy, send a message) already
// happened.
//
// The first version of the guard rejected only the literal 'cross-site'. A real
// browser rig (2026-08-13) proved that wrong twice over:
//   - Sec-Fetch-Site has FOUR values and three were being trusted. A page on ANY
//     OTHER localhost PORT is a different origin but the SAME SITE, so it sends
//     'same-site' and got 4/4 vectors through carrying the token. On loopback,
//     "same-site" spans every port and is worth nothing as a trust signal.
//   - A MISSING header was allowed, on the reasoning that non-browser clients
//     "stay token-gated as before" — backwards, because this proxy GIVES them the
//     token. It re-opened the exact "any local process can act as the user" hole
//     the API token exists to close.
// So the check is now an ALLOWLIST: only 'same-origin' passes. What each case
// asserts is not merely the status code but whether the TOKEN REACHED THE API,
// because that is the actual security property.
import { createServer } from 'node:http';

process.env.AIOS_API_TOKEN = 'ZZ-ADMIN-TOKEN';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

let tokenSeen: string | null = null;
const api = createServer((q, r) => {
  tokenSeen = (q.headers['x-aios-token'] as string) ?? null;
  r.writeHead(200, { 'content-type': 'application/json' });
  r.end('{"ok":true}');
});
await new Promise<void>((ok) => api.listen(4000, '127.0.0.1', () => ok()));

const { POST } = await import('./app/api/[...path]/route.js');
const ctx = { params: Promise.resolve({ path: ['trust', 'promote'] }) };
const req = (site: string | null): never => {
  const h = new Headers({ 'content-type': 'text/plain' });
  if (site !== null) h.set('sec-fetch-site', site);
  return { headers: h, method: 'POST', nextUrl: { search: '' }, arrayBuffer: async () => new ArrayBuffer(0) } as never;
};

// [value, mayReachTheApi]
const CASES: Array<[string | null, boolean]> = [
  ['same-origin', true], // the real UI: a relative fetch/EventSource from the page
  ['same-site', false], // PROVEN exploitable before: any other localhost port
  ['cross-site', false], // a hostile public page
  ['none', false], // pasted link, or the read-class auto-approved browser_navigate
  [null, false], // PROVEN exploitable before: any local process
  ['Same-Origin', false], // capitalised value must not sneak past
  ['cross-site, same-origin', false], // duplicated header, joined by Headers.get
];

try {
  for (const [site, mayPass] of CASES) {
    tokenSeen = null;
    const res = await POST(req(site), ctx);
    const reached = tokenSeen === 'ZZ-ADMIN-TOKEN';
    const label = site === null ? '(header absent)' : `"${site}"`;
    if (mayPass) {
      check(`${label} -> allowed AND token forwarded`, res.status === 200 && reached, `status=${res.status} token=${reached}`);
    } else {
      check(`${label} -> 403 AND token never forwarded`, res.status === 403 && !reached, `status=${res.status} token=${reached}`);
    }
  }
} finally {
  api.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
