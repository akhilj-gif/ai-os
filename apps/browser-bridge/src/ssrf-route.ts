// SSRF guard for the browser bridge, in its own module so ssrf-route-smoke.ts can
// exercise the REAL installer without importing index.ts (which starts a server
// on import). A copy in the test would be free to drift from what ships.
import type { BrowserContext } from 'playwright';
import { assertPublicHttpUrl } from '@ai-os/shared';

// SSRF guard (2026-08-12, variant-analysis hunt): /navigate previously checked
// only the URL scheme, so a model-issued goto could reach 127.0.0.1, another
// loopback bridge, or (once this ever runs on a cloud VM) the metadata
// endpoint. A route handler is the right layer for a REAL browser rather than
// a one-time check before p.goto: Playwright fires a new request through this
// handler for the entry URL AND for every redirect hop the server sends, so a
// public URL that later 302s into a private one is caught too — a check made
// only before the initial goto would miss that.
//
// Validates EVERY http(s) request, not just document navigations (2026-08-13).
// It was previously scoped to documents, on the reasoning that "subresources of
// an already-approved page are a different, broader threat model". That
// reasoning does not survive contact with WHO CHOOSES THE PAGE: the model picks
// the navigation target, and it can pick a page whose contents it authors (a
// gist, a paste, any attacker-controlled or model-generated HTML). At that point
// the page's subresources are model-controlled too, so "document vs subresource"
// simply is not the trust boundary — "model-controlled vs not" is, and every
// request in this context is on the model's side of it. An <img> or fetch() to
// http://127.0.0.1:4200 needs no document navigation at all, and this profile is
// PERSISTENT with real logins, which raises the stakes of anything a hostile
// page can reach. Cost is a DNS check per request; negligible in practice because
// node's resolver hits the OS cache for repeats within a page load.
//
// Registered on the CONTEXT, not the one tracked Page (2026-08-12,
// differential-review self-check — a live Playwright repro proved
// page.route() gives a popup opened via window.open()/target="_blank" ZERO
// coverage: the popup's own top-level navigation never reaches the handler at
// all, no encoding tricks needed). context.route() applies to every page the
// context ever creates, existing or future.
//
// Never calls req.frame(). An earlier version did, to identify top-level
// navigations, but a live repro of the SAME popup scenario proved req.frame()
// THROWS for a popup's very first navigation request (the frame object isn't
// wired up yet when the request is issued — a genuine Playwright race, not a
// coding mistake). An uncaught throw inside a route handler is worse than the
// bypass being fixed.
//
// MEASURED COVERAGE (2026-08-13, live headless Chromium against a request-counting
// loopback server). COVERED: document navigations, image, script, stylesheet,
// iframe, fetch/XHR, web-worker fetch, sendBeacon, fetch keepalive:true,
// EventSource, and popups opened via window.open. NOT COVERED, both confirmed by
// a request actually arriving:
//   - ws:// upgrades — ctx.route never sees them; see the note on routeWebSocket.
//   - <link rel=prefetch> — Chrome's speculative loader bypasses route
//     interception entirely. It is a blind GET (the page cannot read the
//     response), so its value to an attacker is a side effect or an existence
//     oracle rather than exfiltration, but it IS an unvalidated reach.
//
// KNOWN RESIDUAL — DNS rebinding. This validates the resolved address, but
// CHROME opens the socket and resolves the name AGAIN itself, so an attacker
// running the authoritative name server with TTL=0 can answer public here and
// private on the browser's own lookup. ssrfSafeFetch closes this for tool fetches
// by pinning the connection to the validated IP via an undici Agent; that trick
// is unavailable here because we do not own the socket. Closing it properly means
// routing the browser through a local proxy that performs pinned connects, or
// fulfilling every route from our own pinned fetch — both are real changes to
// browser semantics (credentials, streaming, redirects) and are deliberately NOT
// attempted for a single-user local OS. Documented rather than silently ignored.
//
// NOTE THAT ONE FIX CLOSES ALL THREE. Launching Chromium behind a local proxy
// (--proxy-server) that performs the address check and a pinned connect would
// cover ws://, prefetch, AND rebinding at once, because every byte the browser
// sends would go through a socket we own rather than one Chrome opens. That is
// the principled fix if these residuals ever stop being acceptable; it is a real
// piece of work (proxy auth, CONNECT tunnelling for https, and it changes how the
// profile reaches the network), which is why it is written down here instead of
// half-built.
export function installSsrfGuard(ctx: BrowserContext): void {
  // ⚠ CURRENTLY INEFFECTIVE UNDER launchPersistentContext — READ BEFORE TRUSTING.
  //
  // ctx.route() does not see a ws:// upgrade at all, so WebSockets need their own
  // interceptor. Measured 2026-08-13: a page opened ws://127.0.0.1:<port> and the
  // connection ARRIVED at a loopback server while every http probe in the same run
  // was refused. A WebSocket is bidirectional once connected and open-vs-error is
  // observable to the page, so that is both a reach into local services and a port
  // scanner.
  //
  // routeWebSocket is the right API and the handler below is correct — but in
  // playwright 1.61.1 it only fires for a context made by browser.newContext().
  // Measured across three configurations: newContext + context.routeWebSocket
  // FIRES (0 upgrades reached the server, page saw close 1008); page.routeWebSocket
  // does NOT fire; launchPersistentContext + context.routeWebSocket does NOT fire.
  // The bridge uses launchPersistentContext deliberately, to keep real logins, so
  // this handler DOES NOT RUN here today. It is kept because it costs nothing and
  // starts working the moment either playwright fixes that or the bridge moves to
  // a non-persistent context — but do NOT count ws:// as guarded. See the
  // RESIDUALS note at the end of this comment block for the fix that would.
  //
  // connectToServer() is what actually contacts the server, so simply NOT calling
  // it refuses the connection; calling it with no onMessage handlers makes the
  // route a transparent pass-through, which keeps legitimate WebSocket sites
  // working (verified: a non-loopback ws echoed normally through it).
  ctx.routeWebSocket('**', async (ws) => {
    const raw = ws.url();
    // Reuse the http checker by mapping the scheme — the address rules are
    // identical, and duplicating them here is how the two drift apart.
    const asHttp = raw.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    try {
      await assertPublicHttpUrl(asHttp);
      await ws.connectToServer();
    } catch {
      ws.close({ code: 1008, reason: 'blocked by client' });
    }
  });

  ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    // Only http(s) can reach the network. data:/blob:/about: cannot be an SSRF
    // vector and are extremely common as subresources (inline images, fonts),
    // and assertPublicHttpUrl would reject them for their scheme alone.
    if (!url.startsWith('http://') && !url.startsWith('https://')) return route.continue();
    try {
      await assertPublicHttpUrl(url);
      return route.continue();
    } catch {
      // Playwright throws if the route already resolved by the time abort()
      // runs (a race with continue() elsewhere) — the request is gone either way.
      return route.abort('blockedbyclient').catch(() => {});
    }
  });
}
