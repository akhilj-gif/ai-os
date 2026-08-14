// Ambient-authority guard on the Vite /api proxy, driven against the REAL dev
// server (it loads vite.config.ts, so the actual shipped plugin is what gets
// attacked). Binds 3001 + 4000, so run with the OS stack DOWN.
// Run: cd apps/voice && npx tsx proxy-guard-smoke.mts
//
// Same threat as apps/web/proxy-guard-smoke.mts — see the long note there for why
// a 'cross-site'-only denylist was proven inadequate (same-site spans every
// localhost port; an absent header handed the token to any local process). This
// file additionally pins the two things specific to the Vite side:
//
//   1. The guard runs as a MIDDLEWARE, not inside the proxy's configure hook.
//      Rejecting there required proxyReq.destroy(), which emits an error on the
//      outbound socket and logged a full stack trace for every blocked request —
//      a remote-triggerable log/disk-growth nuisance. A middleware registered in
//      configureServer's body runs BEFORE Vite's internal proxy middleware, so a
//      refused request never opens an upstream socket at all. The final case
//      hammers 25 blocked requests to prove the server stays healthy.
//   2. Assertions are on whether the TOKEN REACHED THE API, not just the status,
//      because that is the property that matters.
import { createServer as httpServer, request } from 'node:http';
import { createServer as createVite } from 'vite';

process.env.AIOS_API_TOKEN = 'ZZ-ADMIN-TOKEN';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

let tokenSeen: string | null = null;
const api = httpServer((q, r) => {
  tokenSeen = (q.headers['x-aios-token'] as string) ?? null;
  r.writeHead(200, { 'content-type': 'application/json' });
  r.end('{"ok":true}');
});
await new Promise<void>((ok) => api.listen(4000, '127.0.0.1', () => ok()));

// noDiscovery: this test never loads the app, only hits /api, so the dependency
// pre-bundling scan is pure overhead — and because it runs in the background from
// index.html, it was still resolving when vite.close() landed and dumped an
// "outdated request" esbuild stack trace over otherwise-passing output. Skipping
// discovery removes that teardown race; it does not affect the proxy path.
const vite = await createVite({
  configFile: './vite.config.ts',
  root: '.',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
});
await vite.listen();
const port = vite.config.server.port ?? 3001;

const hit = (site: string | null): Promise<number> =>
  new Promise((ok) => {
    const headers: Record<string, string> = { 'content-type': 'text/plain' };
    if (site !== null) headers['sec-fetch-site'] = site;
    const rq = request({ host: '127.0.0.1', port, path: '/api/trust/promote', method: 'POST', headers }, (rs) => {
      rs.resume();
      rs.on('end', () => ok(rs.statusCode ?? 0));
    });
    rq.on('error', () => ok(-1));
    rq.end('x=1');
  });

const CASES: Array<[string | null, boolean]> = [
  ['same-origin', true],
  ['same-site', false], // PROVEN exploitable before: any other localhost port
  ['cross-site', false],
  ['none', false],
  [null, false], // PROVEN exploitable before: any local process
  ['Same-Origin', false],
];

try {
  for (const [site, mayPass] of CASES) {
    tokenSeen = null;
    const status = await hit(site);
    const reached = tokenSeen === 'ZZ-ADMIN-TOKEN';
    const label = site === null ? '(header absent)' : `"${site}"`;
    if (mayPass) {
      check(`${label} -> proxied AND token forwarded`, status === 200 && reached, `status=${status} token=${reached}`);
    } else {
      check(`${label} -> 403 AND token never forwarded`, status === 403 && !reached, `status=${status} token=${reached}`);
    }
  }

  let bad = 0;
  for (let i = 0; i < 25; i++) if ((await hit('cross-site')) !== 403) bad++;
  check('25 blocked requests stay 403 and the server survives', bad === 0, bad ? `${bad} anomalies` : '');
} finally {
  await vite.close();
  api.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
