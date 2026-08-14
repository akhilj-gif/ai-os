// Same-origin proxy to the kernel API. Replaces the old next.config rewrite so we
// can inject the API auth token (x-aios-token) SERVER-SIDE — the browser never
// sees it, and the API rejects any request without it. PM2 supplies
// AIOS_API_TOKEN to this process via ecosystem.config.cjs. OAuth browser
// redirects go straight to :4000 (not through /api), so they are unaffected.
import { type NextRequest } from 'next/server';

const API = process.env.AIOS_API_BASE ?? 'http://localhost:4000';
const TOKEN = process.env.AIOS_API_TOKEN ?? '';

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
  if (req.headers.get('sec-fetch-site') !== 'same-origin') {
    return new Response(JSON.stringify({ error: 'only same-origin requests may use the API proxy' }), {
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
