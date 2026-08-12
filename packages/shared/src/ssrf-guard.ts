// SSRF guard (2026-08-12, variant-analysis hunt). Every tool that fetches a
// model-supplied absolute URL checked only the URL SCHEME, never the resolved
// IP — so `http://127.0.0.1:4200/...` or a cloud metadata address
// (169.254.169.254) passed every existing check. Four call sites shared this
// root cause: http_get, http_send, fetch_url, and the browser bridge's
// /navigate. This is the one guard all of them call.
//
// Checks the RESOLVED address, not the hostname, so DNS rebinding and IP-
// literal bypasses are covered — a hostname allow/block list (the one
// pre-existing defense, in browser.ts) cannot do this. Callers must also
// validate every REDIRECT hop, since redirect:'follow' would otherwise let an
// approved public URL 302 into a private one after the check already passed.
import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

/** IPv4 ranges that must never be reachable from a model-issued fetch:
 *  loopback, private (RFC1918), link-local (incl. cloud metadata), CGNAT,
 *  "this network", and multicast/reserved. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local — includes AWS/GCP/Azure metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmark
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function v4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isBlockedV4(ip: string): boolean {
  const addr = v4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (addr & mask) === (v4ToInt(base) & mask);
  });
}

/** IPv6: loopback (::1), unspecified (::), unique-local (fc00::/7 — the v6
 *  analog of RFC1918), and link-local (fe80::/10 — the v6 analog of
 *  169.254.0.0/16, same metadata-endpoint risk). Also catches an
 *  IPv4-mapped (::ffff:a.b.c.d) address hiding a blocked v4 target. */
function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]!);
  const first = lower.split(':')[0]!;
  if (/^fe[89ab][0-9a-f]$/.test(first)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}$/.test(first)) return true; // fc00::/7 unique-local
  return false;
}

export class SsrfBlockedError extends Error {
  constructor(url: string, reason: string) {
    super(`refusing to fetch ${url}: ${reason}`);
  }
}

/** Validate that `url` is absolute http(s) AND resolves only to public
 *  addresses. Throws SsrfBlockedError otherwise. Call this again for every
 *  redirect hop — a validated entry URL says nothing about where it redirects. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError(raw, 'not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(raw, 'must be http or https');
  }
  const host = url.hostname;
  // An IP literal in the URL — validate directly, no DNS involved.
  if (isIPv4(host)) {
    if (isBlockedV4(host)) throw new SsrfBlockedError(raw, `${host} is a private/internal address`);
    return url;
  }
  if (isIPv6(host)) {
    if (isBlockedV6(host)) throw new SsrfBlockedError(raw, `${host} is a private/internal address`);
    return url;
  }
  // A hostname — resolve it and check EVERY answer (a name can round-robin
  // across public and private addresses; one safe answer proves nothing).
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(raw, `could not resolve ${host}`);
  }
  if (addrs.length === 0) throw new SsrfBlockedError(raw, `${host} resolved to no address`);
  for (const a of addrs) {
    const blocked = a.family === 4 ? isBlockedV4(a.address) : isBlockedV6(a.address);
    if (blocked) throw new SsrfBlockedError(raw, `${host} resolves to ${a.address}, a private/internal address`);
  }
  return url;
}

/** fetch() that validates the initial URL AND every redirect hop, instead of
 *  redirect:'follow' (which would let a public URL 302 into a private one
 *  after the entry check already passed). Caps hops at 5 like browsers do. */
export async function ssrfSafeFetch(rawUrl: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHttpUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get('location');
    if (!isRedirect || !location) return res;
    current = new URL(location, current).toString();
  }
  throw new SsrfBlockedError(rawUrl, `too many redirects (>${maxRedirects})`);
}
