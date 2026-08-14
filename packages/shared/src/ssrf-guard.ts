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
import { Agent, fetch as undiciFetch } from 'undici';

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

/** Expand a bracket-stripped IPv6 address into its 8 uint16 groups, handling
 *  `::` compression and an optional trailing IPv4 dotted-quad (RFC 4291
 *  §2.5.5). Returns null if the address doesn't parse. Numeric, not string
 *  matching — see the comment on isBlockedV6 for why that distinction is the
 *  whole fix here. */
function parseV6Groups(ip: string): number[] | null {
  let head = ip;
  const lastColon = ip.lastIndexOf(':');
  const maybeV4 = ip.slice(lastColon + 1);
  if (isIPv4(maybeV4)) {
    // A trailing dotted-quad (the classic ::ffff:a.b.c.d mapped form, or the
    // rarer explicit ::a.b.c.d) — fold it into two hex groups before parsing.
    const [a, b, c, d] = maybeV4.split('.').map(Number);
    head = `${ip.slice(0, lastColon + 1)}${(((a! << 8) | b!) >>> 0).toString(16)}:${(((c! << 8) | d!) >>> 0).toString(16)}`;
  }
  const parts = head.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : [];
  if (parts.length === 1) {
    if (left.length !== 8) return null;
    return left.map((g) => parseInt(g, 16));
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill('0'), ...right].map((g) => parseInt(g || '0', 16));
}

/** IPv6: loopback (::1), unspecified (::), unique-local (fc00::/7 — the v6
 *  analog of RFC1918), link-local (fe80::/10 — the v6 analog of
 *  169.254.0.0/16, same metadata-endpoint risk), and any form (mapped
 *  ::ffff:a.b.c.d OR the deprecated IPv4-compatible ::a.b.c.d) carrying a
 *  blocked v4 address in its low 32 bits.
 *
 *  This checks the address NUMERICALLY, not by string pattern — a live
 *  differential-review pass (2026-08-12) proved the previous regex-based
 *  version missed the deprecated compatible form: Node's URL parser
 *  normalizes `[::169.254.169.254]` to hostname `[::a9fe:a9fe]` (hex groups)
 *  BEFORE this function ever sees it, so a string match for a trailing
 *  dotted-quad can never fire on that input — the address has to be parsed
 *  into groups and checked by value instead. */
function isBlockedV6(ip: string): boolean {
  const parsed = parseV6Groups(ip.toLowerCase());
  if (!parsed || parsed.length !== 8) return true; // unparseable → fail closed, never fail open
  const [g0, g1, g2, g3, g4, g5, g6, g7] = parsed as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: or ::1
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated, still routed by some stacks)
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast — the v6 analog of 224.0.0.0/4, already blocked for v4
  if ((g0 & 0xff80) === 0xfe00) return true; // fe00::/9 unassigned — reserved space has no business being fetched

  // TRANSITION FAMILIES (2026-08-13). Every one of these EMBEDS an IPv4 address
  // somewhere other than the low 32 bits, so the mapped/compatible check below
  // could not see it — verified live: [64:ff9b::7f00:1], [2002:7f00:1::],
  // [2001:0:0:0:0:0:7f00:1] and [::ffff:0:7f00:1] all reached 127.0.0.1, and the
  // NAT64/6to4 forms of 169.254.169.254 reached cloud metadata. Refusing the
  // whole prefix rather than decoding each one and testing the inner v4: these
  // are deprecated or gateway-only (6to4 and Teredo are formally deprecated,
  // NAT64 addresses belong to a translator, not to a host the OS should fetch),
  // so there is no legitimate reason for one to appear in a model-supplied URL,
  // and "block the range" cannot be defeated by a novel way of encoding the
  // inner address. Prefixes are matched EXACTLY, not loosely — Teredo is
  // 2001:0000::/32, and 2001::/16 as a whole is a huge legitimate global range
  // that must keep working.
  if (g0 === 0x2002) return true; // 6to4, 2002::/16 — v4 sits in g1:g2
  if (g0 === 0x2001 && g1 === 0x0000) return true; // Teredo, 2001:0::/32 — server v4 in g2:g3, client v4 XOR-obfuscated in g6:g7
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // NAT64 well-known 64:ff9b::/96 and local-use 64:ff9b:1::/48

  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), and
  // IPv4-translated (::ffff:0:a.b.c.d) all carry the v4 in the low 32 bits.
  const lowV4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) return isBlockedV4(lowV4);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return isBlockedV4(lowV4); // ::ffff:0:a.b.c.d
  return false;
}

/** Hard ceiling on a single response body, applied to DECOMPRESSED bytes.
 *
 *  Both tool callers cap only AFTER `await res.text()` — http.ts slices to
 *  MAX_BODY, fetch-url.ts to MAX_BYTES — so the whole body was already resident
 *  before any cap applied. That is a memory DoS, and Content-Length cannot bound
 *  it: a gzip decompression bomb was measured turning a 510 KiB transfer into
 *  ~2.8 GB of RSS and killing the process (2026-08-13). undici decompresses
 *  before handing us the stream, so metering it HERE is the only place the real
 *  size is known. Set well above fetch-url's own 2 MB cap so no existing caller
 *  changes behaviour. */
const MAX_RESPONSE_BYTES = 8_000_000;

/** Fallback request timeout for a caller that passes no AbortSignal. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Read at most `maxBytes` of the body, then cancel the stream. TRUNCATES rather
 *  than throwing, because both callers already truncate — a hostile server must
 *  not be able to turn "page too big" into a failed task, only a shorter page. */
export async function drainCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = maxBytes - total;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        total += room;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A mid-body network error still yields whatever arrived; the caller sees a
    // short body rather than an exception from deep inside the guard.
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export class SsrfBlockedError extends Error {
  constructor(url: string, reason: string) {
    super(`refusing to fetch ${url}: ${reason}`);
  }
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** "[::1]" → "::1". URL.hostname brackets IPv6 literals; net.isIPv6 and the
 *  group parser both need them gone. */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Validate + resolve in one pass. Internal — assertPublicHttpUrl (below)
 *  wraps this for callers that only need the validation; ssrfSafeFetch
 *  additionally needs the resolved address itself, to pin the connection to
 *  it (see the DNS-rebinding comment on ssrfSafeFetch). */
async function resolveAndValidate(raw: string): Promise<{ url: URL; resolved: ResolvedAddress }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError(raw, 'not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(raw, 'must be http or https');
  }
  // URL.hostname keeps the BRACKETS on an IPv6 literal ("[::1]"), and
  // net.isIPv6("[::1]") is false — so before 2026-08-13 the isIPv6 branch below
  // was unreachable dead code and every IPv6 literal fell through to the DNS
  // path instead. It still got BLOCKED there (node's resolver happens to parse
  // a bracketed literal, and a resolver failure fails closed), so this was not
  // a bypass — but it made a purely local, offline decision depend on resolver
  // behaviour, which is exactly the kind of load-bearing accident that turns
  // into a bypass after an unrelated change. Found by writing ssrf-smoke.ts.
  const host = stripBrackets(url.hostname);
  // An IP literal in the URL — validate directly, no DNS involved.
  if (isIPv4(host)) {
    if (isBlockedV4(host)) throw new SsrfBlockedError(raw, `${host} is a private/internal address`);
    return { url, resolved: { address: host, family: 4 } };
  }
  if (isIPv6(host)) {
    if (isBlockedV6(host)) throw new SsrfBlockedError(raw, `${host} is a private/internal address`);
    return { url, resolved: { address: host, family: 6 } };
  }
  // A hostname — resolve it and check EVERY answer (a name can round-robin
  // across public and private addresses; one safe answer proves nothing).
  // ONE message for every name-resolution outcome (2026-08-13). These used to
  // read differently — "could not resolve X" versus "X resolves to a
  // private/internal address" — and http_get/fetch_url hand a caught error
  // straight back as ordinary tool output, so the pair was a 1-bit oracle: a
  // prompt-injected agent could enumerate INTERNAL HOSTNAMES (does
  // `vault.internal` exist on this network?) purely from which refusal it got,
  // without ever completing a connection. Removing the specific resolved IP from
  // the message, done earlier, was not enough while the two failure MODES stayed
  // distinguishable. The operator still gets the detail via console.warn below.
  const REFUSED = `${host} could not be resolved to a public address`;
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(raw, REFUSED);
  }
  if (addrs.length === 0) throw new SsrfBlockedError(raw, REFUSED);
  for (const a of addrs) {
    const blocked = a.family === 4 ? isBlockedV4(a.address) : isBlockedV6(a.address);
    if (blocked) {
      // The resolved address stays OUT of the thrown message (2026-08-12,
      // differential-review self-check): http_get/fetch_url return a caught
      // error straight back as normal tool output, so a hostname the caller
      // supplied but didn't already know the IP of (e.g. an internal-sounding
      // name reachable only via a specific VPC) would otherwise let a prompt-
      // injected agent learn real internal IPs purely from BLOCKED responses,
      // never completing a connection. console.warn keeps it for an operator
      // reading server logs; the tool-visible message does not.
      console.warn(`[ssrf-guard] blocked ${raw}: ${host} resolves to ${a.address}, a private/internal address`);
      throw new SsrfBlockedError(raw, REFUSED); // identical to the "no such name" case — see REFUSED above
    }
  }
  const first = addrs[0]!;
  return { url, resolved: { address: first.address, family: first.family === 6 ? 6 : 4 } };
}

/** Validate that `url` is absolute http(s) AND resolves only to public
 *  addresses. Throws SsrfBlockedError otherwise. Call this again for every
 *  redirect hop — a validated entry URL says nothing about where it redirects. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  return (await resolveAndValidate(raw)).url;
}

/** A dns.lookup-compatible function that ignores real DNS and always answers
 *  with the single address already validated for `expectedHost` — used to
 *  pin ssrfSafeFetch's actual TCP connection (see there for why). */
function pinnedLookup(expectedHost: string, resolved: ResolvedAddress) {
  // Compared bracket-insensitively: the caller passes url.hostname (which
  // brackets IPv6), while undici's connector may hand us either form. A
  // mismatch here fails the request closed, so a purely cosmetic difference
  // must not be allowed to look like a redirect to an unexpected host.
  const want = stripBrackets(expectedHost);
  return (hostname: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (err: Error | null, ...rest: unknown[]) => void;
    if (stripBrackets(hostname) !== want) {
      cb(new Error(`ssrf-guard: refusing to resolve unexpected host "${hostname}" (pinned to "${expectedHost}")`));
      return;
    }
    const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    if (wantsAll) cb(null, [{ address: resolved.address, family: resolved.family }]);
    else cb(null, resolved.address, resolved.family);
  };
}

/** fetch() that validates the initial URL AND every redirect hop, instead of
 *  redirect:'follow' (which would let a public URL 302 into a private one
 *  after the entry check already passed). Caps hops at 5 like browsers do.
 *
 *  Also pins the actual TCP connection to the exact address just validated
 *  (2026-08-13, closing a gap flagged and deliberately deferred on
 *  2026-08-12). Without this, assertPublicHttpUrl's lookup() and fetch()'s
 *  OWN internal DNS resolution are two independent queries — a DNS-rebinding
 *  attacker (a name server they control, TTL=0) can answer with a safe public
 *  address for the check and a private one moments later for the real
 *  connect, and the check would never see the address actually used. Using
 *  an undici Agent with a fixed connect.lookup means the low-level address
 *  lookup is the one we already validated; the Host header, TLS SNI, and
 *  certificate verification still use the original hostname, so this only
 *  overrides WHERE the socket connects, not what the server sees or how the
 *  cert is checked.
 *
 *  Uses undici's OWN fetch, not Node's global fetch: Node's global fetch is
 *  powered by a specific version of undici bundled INSIDE that Node release,
 *  and handing it an Agent built from the separately-installed `undici`
 *  package is a version mismatch — confirmed live (2026-08-13): it threw
 *  `InvalidArgumentError: invalid onRequestStart method` the moment a real
 *  request went out. Using the package's own fetch alongside its own Agent
 *  keeps both from the same version, avoiding the interface drift entirely.
 *  The returned Response is spec-compliant (json/text/status/headers/ok) and
 *  behaves identically for every caller here — none does an `instanceof`
 *  check against the global Response class. */
export async function ssrfSafeFetch(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 5,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<Response> {
  let current = rawUrl;
  // A caller that forgets a signal must not be able to hang forever on a server
  // that stalls mid-body (2026-08-13). http_get always passes one; fetch_url
  // does too, but the default belongs here so the NEXT caller cannot omit it.
  const init2: RequestInit = init.signal ? init : { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) };
  let hopInit: RequestInit = { ...init2 };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, resolved } = await resolveAndValidate(current);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(url.hostname, resolved) } });
    try {
      const res = (await undiciFetch(url, { ...hopInit, redirect: 'manual', dispatcher } as never)) as unknown as Response;
      const isRedirect = res.status >= 300 && res.status < 400;
      const location = res.headers.get('location');
      if (!isRedirect || !location) {
        // DRAIN THE BODY BEFORE THE finally CLOSES THE POOL. undiciFetch resolves
        // as soon as the HEADERS arrive, so the first version of this function
        // closed the Agent while the body was still streaming — and that is a
        // DEADLOCK, not just an early close: close() waits for the in-flight
        // request to finish, the request cannot finish until its body is
        // consumed, and the body cannot be consumed because control is stuck in
        // the finally. Reproduced 2026-08-13: any response larger than undici's
        // initial buffered chunk (~16 KiB) hung forever, which is most real web
        // pages — so http_get, fetch_url and web_search were all affected. Small
        // responses survived only because they arrived complete with the
        // headers, which is exactly why it passed the first round of testing.
        //
        // Buffering here also detaches the Response from the pooled socket, so
        // returning it after close() is safe. Every caller reads the whole body
        // (res.text()/res.json()) and caps it afterwards, so nothing loses
        // streaming it was actually using. content-encoding/length are dropped
        // because undici already decompressed the bytes we are re-wrapping.
        const noBody = res.status === 204 || res.status === 205 || res.status === 304;
        const buffered = noBody ? null : await drainCapped(res, maxBytes);
        const headers = new Headers();
        for (const [k, v] of res.headers as unknown as Iterable<[string, string]>) {
          if (k !== 'content-encoding' && k !== 'content-length') headers.append(k, v);
        }
        const out = new Response(buffered, { status: res.status, statusText: res.statusText, headers });
        // Response.url is an empty string on a constructed Response and is
        // read-only, so re-wrapping silently lost the POST-REDIRECT url —
        // fetch-url.ts does `res.url || url` and was therefore reporting
        // redirected content under the originally requested address (2026-08-13).
        // An own property shadows the prototype getter.
        Object.defineProperty(out, 'url', { value: current, enumerable: true });
        return out;
      }
      // A redirect: discard the body so the socket is releasable, then re-derive
      // the next hop's init before looping (the guard re-validates the new URL).
      await res.arrayBuffer().catch(() => {});
      const next = new URL(location, current);
      hopInit = initForRedirect(hopInit, url, next, res.status);
      current = next.toString();
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }
  throw new SsrfBlockedError(rawUrl, `too many redirects (>${maxRedirects})`);
}

/** Carry `init` across a redirect the way undici's own redirect handler does.
 *
 *  Following redirects manually (which the SSRF check requires, so every hop can
 *  be re-validated) means losing what undici would otherwise do for free — and
 *  what it does is SECURITY-relevant: it strips credential headers when the hop
 *  changes origin. Without this, a public URL that 302s to an attacker host
 *  replayed Authorization/Cookie verbatim to that host, turning the SSRF guard
 *  into a credential-exfiltration path (2026-08-13 adversarial review of this
 *  file's own first version). It also downgrades the method per spec, so a POST
 *  body is not silently re-sent somewhere new. */
export function initForRedirect(prev: RequestInit, from: URL, to: URL, status: number): RequestInit {
  const out: RequestInit = { ...prev };
  if (from.origin !== to.origin) {
    // ALLOWLIST the headers that survive a cross-origin hop, rather than
    // denylisting three known credential names. The denylist version replayed
    // every OTHER header verbatim to the new host (2026-08-13) — and the tools
    // here routinely set exactly that kind of header: http_get forwards whatever
    // `headers` the model supplies (commonly an api-key, x-api-key or a bearer
    // under a vendor-specific name), and the bridges use x-aios-token /
    // x-bridge-token. Any of those leaking to a redirect target is the same
    // credential-exfiltration bug the original strip was added to prevent, just
    // spelled differently. Keeping only content negotiation and the UA means a
    // NEW credential header cannot be forgotten here later.
    const KEEP = new Set(['accept', 'accept-language', 'accept-encoding', 'content-type', 'user-agent']);
    const src = new Headers((prev.headers ?? {}) as never);
    const headers = new Headers();
    for (const [k, v] of src as unknown as Iterable<[string, string]>) {
      if (KEEP.has(k.toLowerCase())) headers.append(k, v);
    }
    out.headers = headers;
  }
  const method = (prev.method ?? 'GET').toUpperCase();
  // 303 always becomes GET; 301/302 downgrade a POST. 307/308 deliberately
  // preserve both method and body.
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    out.method = 'GET';
    out.body = undefined;
  }
  return out;
}
