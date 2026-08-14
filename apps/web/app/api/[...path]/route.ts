// Same-origin proxy to the kernel API. Replaces the old next.config rewrite so we
// can inject the API auth token (x-aios-token) SERVER-SIDE — the browser never
// sees it, and the API rejects any request without it. PM2 supplies
// AIOS_API_TOKEN to this process via ecosystem.config.cjs. OAuth browser
// redirects go straight to :4000 (not through /api), so they are unaffected.
import { type NextRequest } from 'next/server';

const API = process.env.AIOS_API_BASE ?? 'http://localhost:4000';
const TOKEN = process.env.AIOS_API_TOKEN ?? '';

/** Is the Host header a loopback name? Port-agnostic on purpose — the point is to
 *  reject a rebound attacker-owned NAME, and hard-coding a port would break the
 *  UI the first time someone runs it somewhere else. */
export function hostIsLoopback(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  // Strip the port, taking care with a bracketed IPv6 literal ("[::1]:3000").
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : (h.split(':')[0] ?? '');
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

async function proxy(req: NextRequest, paramsP: Promise<{ path?: string[] }>): Promise<Response> {
  // This proxy is the one place ambient authority is minted: it attaches the
  // admin token to whatever arrives, so any request that reaches it executes
  // fully authenticated. That is CSRF with an injected credential instead of a
  // cookie — a malicious page cannot read the response, but the side effect
  // (approve a pending action, promote a trust policy, send a message) has
  // already happened.
  //
  // ALLOWLIST, not a denylist. The first version of this check rejected only the
  // literal 'cross-site', which was wrong in two proven ways (2026-08-13, real
  // browser rig):
  //   - Sec-Fetch-Site has FOUR values and three of them were being trusted. A
  //     page served from ANY OTHER PORT on localhost is a different ORIGIN but
  //     the SAME SITE, so it sends 'same-site' — and drove this API with the
  //     admin token on 4 of 4 vectors (no-cors fetch POST, img GET, sendBeacon,
  //     cross-origin form POST). On loopback, "same-site" spans every port, so
  //     it is worth nothing as a trust signal.
  //   - A request with NO Sec-Fetch-Site header was allowed on the reasoning
  //     that non-browser clients "stay token-gated as before". That reasoning was
  //     backwards: this proxy GIVES them the token. It re-opened precisely the
  //     "any local process can act as the user" hole that the API token exists to
  //     close (see the comment above the auth hook in apps/api/src/server.ts).
  // Legitimate non-browser callers (tools, CLI, supervisor, scripts/ops.ts) talk
  // to the API directly on :4000 with their own AIOS_API_TOKEN and never come
  // through here, so requiring same-origin costs nothing. Every real UI call is a
  // relative fetch/EventSource from the page itself, i.e. same-origin.
  //
  // An allowlist also disposes of header-shape tricks for free: a capitalised
  // value, or a duplicated header that Headers.get joins into
  // "cross-site, same-origin", simply is not 'same-origin' and is refused.
  //
  // WHAT THIS DOES AND DOES NOT CLOSE — stated precisely, because an earlier
  // version of this comment overclaimed. Sec-Fetch-Site is unforgeable from
  // BROWSER JS, so the allowlist stops a hostile page driving this API. It does
  // NOT stop a non-browser local process, which can simply set the header itself;
  // that boundary is inherently soft anyway, since any process able to read .env
  // or the pm2 environment already has AIOS_API_TOKEN. The threat handled here is
  // browser-driven CSRF, not local privilege separation.
  const site = req.headers.get('sec-fetch-site');
  // Host must be loopback (2026-08-13). Without this, DNS rebinding defeats the
  // allowlist entirely: an attacker points evil.example at 127.0.0.1, the victim
  // loads http://evil.example:3000/, and that page's fetch to /api/* IS
  // same-origin from the browser's point of view — so 'same-origin' arrives, the
  // token is attached, and the origin check was worth nothing. Checking the
  // hostname (port-agnostic, so a port change does not silently break the UI)
  // pins the request to a name the attacker cannot own.
  if (site !== 'same-origin' || !hostIsLoopback(req.headers.get('host'))) {
    return new Response(JSON.stringify({ error: 'only same-origin loopback requests may use the API proxy' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  const { path = [] } = await paramsP;
  const url = `${API}/${path.join('/')}${req.nextUrl.search}`;
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('content-length');
  if (TOKEN) headers.set('x-aios-token', TOKEN);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const res = await fetch(url, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    redirect: 'manual',
  });
  const respHeaders = new Headers(res.headers);
  respHeaders.delete('content-encoding');
  respHeaders.delete('content-length');
  return new Response(res.body, { status: res.status, headers: respHeaders });
}

type Ctx = { params: Promise<{ path?: string[] }> };
export const GET = (req: NextRequest, ctx: Ctx) => proxy(req, ctx.params);
export const POST = (req: NextRequest, ctx: Ctx) => proxy(req, ctx.params);
export const PUT = (req: NextRequest, ctx: Ctx) => proxy(req, ctx.params);
export const PATCH = (req: NextRequest, ctx: Ctx) => proxy(req, ctx.params);
export const DELETE = (req: NextRequest, ctx: Ctx) => proxy(req, ctx.params);
