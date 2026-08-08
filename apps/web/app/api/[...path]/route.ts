// Same-origin proxy to the kernel API. Replaces the old next.config rewrite so we
// can inject the API auth token (x-aios-token) SERVER-SIDE — the browser never
// sees it, and the API rejects any request without it. PM2 supplies
// AIOS_API_TOKEN to this process via ecosystem.config.cjs. OAuth browser
// redirects go straight to :4000 (not through /api), so they are unaffected.
import { type NextRequest } from 'next/server';

const API = process.env.AIOS_API_BASE ?? 'http://localhost:4000';
const TOKEN = process.env.AIOS_API_TOKEN ?? '';

async function proxy(req: NextRequest, paramsP: Promise<{ path?: string[] }>): Promise<Response> {
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
