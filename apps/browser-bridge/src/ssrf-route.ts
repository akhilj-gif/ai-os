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
export function installSsrfGuard(ctx: BrowserContext): void {
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
