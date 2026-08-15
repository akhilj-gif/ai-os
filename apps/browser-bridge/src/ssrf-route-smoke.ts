// SSRF route-guard smoke — deterministic against a REAL headless Chromium, with
// a fake "internal service" on an ephemeral loopback port that nothing may reach.
// Run: npx tsx apps/browser-bridge/src/ssrf-route-smoke.ts
//
// WHY. /navigate takes a model-supplied URL, so the bridge needs an SSRF guard;
// it lives in a context.route() handler because a real browser follows redirects
// and opens popups that a one-time pre-goto check never sees.
//
// Until 2026-08-13 that handler validated only requests whose resourceType was
// 'document', on the reasoning that "subresources of an already-approved page are
// a different, broader threat model". That reasoning ignores WHO CHOOSES THE
// PAGE. The model picks the navigation target and can pick a page whose contents
// it authors (a gist, a paste, any attacker-controlled HTML), at which point the
// page's subresources are model-controlled too. So "document vs subresource" was
// never the trust boundary — "model-controlled vs not" is, and everything in this
// context sits on the model's side of it. An <img> or fetch() at
// http://127.0.0.1:4200 needs no document navigation at all, and this bridge runs
// a PERSISTENT profile holding real logins.
//
// This suite imports the SAME guard installer the bridge uses (never a copy), so
// it cannot drift from what actually ships.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { installSsrfGuard } from './ssrf-route.js';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

// The thing that must stay unreachable. Ephemeral port so this never collides
// with a running stack.
let hits = 0;
const internal = createServer((_q, r) => {
  hits++;
  r.writeHead(200, { 'content-type': 'text/plain' });
  r.end('INTERNAL-SECRET');
});
// Count ws upgrades too — otherwise the WebSocket probe below would read zero
// arrivals and look "covered" when nothing was ever listening for it.
internal.on('upgrade', (_q, sock) => {
  hits++;
  sock.destroy();
});
await new Promise<void>((ok) => internal.listen(0, '127.0.0.1', () => ok()));
const port = (internal.address() as { port: number }).port;

const ctx = await chromium.launchPersistentContext('', { headless: true });
installSsrfGuard(ctx);
const page = ctx.pages()[0] ?? (await ctx.newPage());

const blocked: string[] = [];
ctx.on('requestfailed', (r) => {
  if ((r.failure()?.errorText ?? '').includes('BLOCKED_BY_CLIENT')) blocked.push(r.resourceType());
});

try {
  // setContent rather than a served page: the outer document is then not itself
  // subject to the guard, so each assertion below is unambiguously about the
  // SUBRESOURCE. (An earlier attempt served the outer page from 127.0.0.1 and the
  // guard correctly blocked that too, which made the result impossible to read.)
  await page
    .setContent(
      `<img src="http://127.0.0.1:${port}/img">
       <script src="http://127.0.0.1:${port}/js"></script>
       <link rel="stylesheet" href="http://127.0.0.1:${port}/css">
       <iframe src="http://127.0.0.1:${port}/frame"></iframe>`,
      { waitUntil: 'load' },
    )
    .catch(() => undefined);

  // The exfiltration-capable case: page JS reading an internal service and
  // rendering it where /read would pick it up.
  const xhr = await page.evaluate(async (p: number) => {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/xhr`);
      return 'GOT:' + (await r.text()).slice(0, 24);
    } catch (e) {
      return 'FAILED:' + (e as Error).message.slice(0, 40);
    }
  }, port);
  await page.waitForTimeout(1200);

  // The assertion that matters: not "was it blocked" but "did anything arrive".
  check('internal service received ZERO requests', hits === 0, `hits=${hits}`);
  check('page fetch() to loopback failed', xhr.startsWith('FAILED'), xhr);
  check('subresources were actively refused by the guard', blocked.length > 0, 'blocked: ' + JSON.stringify(blocked));
  for (const kind of ['image', 'script', 'stylesheet', 'fetch']) {
    check(`${kind} subresource blocked`, blocked.includes(kind), 'saw: ' + JSON.stringify(blocked));
  }

  // Request kinds beyond plain subresources. These were measured individually on
  // 2026-08-13; the two NOT covered are asserted as KNOWN so this suite records
  // reality. If one of them ever starts being blocked, that is good news and this
  // check should flip — a suite that quietly tolerates either outcome tells you
  // nothing.
  const arrivals = async (label: string, fn: () => Promise<unknown>): Promise<number> => {
    const before = hits;
    await fn().catch(() => undefined);
    await page.waitForTimeout(900);
    const n = hits - before;
    console.log(`      ${label}: ${n} arrival(s)`);
    return n;
  };

  check(
    'web worker fetch is blocked',
    (await arrivals('web worker', () =>
      page.evaluate(async (p: number) => {
        const src = `self.onmessage=async()=>{try{await fetch('http://127.0.0.1:${p}/w');}catch(e){}; self.postMessage('d');};`;
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        await new Promise((r) => {
          w.onmessage = r;
          w.postMessage('go');
        });
      }, port),
    )) === 0,
  );

  check(
    'sendBeacon is blocked',
    (await arrivals('sendBeacon', () => page.evaluate((p: number) => void navigator.sendBeacon(`http://127.0.0.1:${p}/b`, 'x'), port))) === 0,
  );

  check(
    'popup window.open is blocked (why context.route, not page.route)',
    (await arrivals('popup', () => page.evaluate((p: number) => void window.open(`http://127.0.0.1:${p}/p`, '_blank'), port))) === 0,
  );

  // KNOWN HOLE 1: ctx.route never sees a ws:// upgrade. routeWebSocket is the
  // right API but does not fire under launchPersistentContext in playwright
  // 1.61.1 (measured), which is the context type the bridge uses.
  const wsArrivals = await arrivals('websocket', () =>
    page.evaluate(
      (p: number) =>
        new Promise<string>((r) => {
          const s = new WebSocket(`ws://127.0.0.1:${p}/ws`);
          s.onopen = () => r('open');
          s.onerror = () => r('err');
          setTimeout(() => r('t'), 1500);
        }),
      port,
    ),
  );
  check('KNOWN HOLE: ws:// still reaches loopback (documented residual)', wsArrivals > 0, wsArrivals === 0 ? 'now blocked — update ssrf-route.ts and flip this check' : 'as documented');

  // KNOWN HOLE 2: Chrome's speculative loader bypasses route interception. Blind
  // GET only (the page cannot read the response).
  const preArrivals = await arrivals('link rel=prefetch', () =>
    page.evaluate((p: number) => {
      const l = document.createElement('link');
      l.rel = 'prefetch';
      l.href = `http://127.0.0.1:${p}/pf`;
      document.head.appendChild(l);
    }, port),
  );
  check('KNOWN HOLE: prefetch still reaches loopback (documented residual)', preArrivals > 0, preArrivals === 0 ? 'now blocked — update ssrf-route.ts and flip this check' : 'as documented');

  // A guard that blocks everything is not a guard — a public navigation must
  // still work. (Network-dependent; treated as informational if offline.)
  const status = await page
    .goto('https://example.com/', { waitUntil: 'domcontentloaded' })
    .then((r) => r?.status() ?? 0)
    .catch(() => -1);
  if (status === -1) console.log('SKIP  public navigation still works (no network)');
  else check('public navigation still works', status === 200, 'status ' + status);
} finally {
  await ctx.close();
  internal.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
