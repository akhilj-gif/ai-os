// Deterministic unit checks for the SSRF guard — no DNS, no network, no DB.
// Run: tsx packages/shared/src/ssrf-smoke.ts
//
// Every case here uses an IP LITERAL or a bad scheme, which assertPublicHttpUrl
// decides without ever calling the resolver — so this suite is safe in the
// CI-safe `pnpm test` gate. (The hostname path necessarily needs DNS and is
// exercised by the live stack, not here.)
//
// Writing that "no resolver" claim is what exposed a real bug: the IPv6 cases
// below were silently going THROUGH the resolver, because URL.hostname brackets
// IPv6 literals ("[::1]") and net.isIPv6 rejects the bracketed form, making the
// guard's IPv6 fast path dead code. Blocked either way, but only by accident —
// now fixed in ssrf-guard.ts via stripBrackets().
//
// This file exists because ssrf-guard.ts was written and twice PATCHED for real
// bypasses (2026-08-12/13) with zero automated coverage behind it — including
// one bypass, the IPv4-compatible IPv6 form, that a regex-based implementation
// silently failed for weeks. Each such bypass is pinned below as a named
// regression so it can never come back unnoticed.
import { assertPublicHttpUrl, SsrfBlockedError, initForRedirect } from './ssrf-guard.js';

let fail = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) fail++;
};

/** true when the guard REFUSED the url (the safe outcome). */
async function blocked(url: string): Promise<boolean> {
  try {
    await assertPublicHttpUrl(url);
    return false;
  } catch (err) {
    return err instanceof SsrfBlockedError;
  }
}

async function allowed(url: string): Promise<boolean> {
  try {
    await assertPublicHttpUrl(url);
    return true;
  } catch {
    return false;
  }
}

// --- scheme gate ------------------------------------------------------------
for (const u of ['file:///etc/passwd', 'ftp://8.8.8.8/x', 'gopher://8.8.8.8/', 'data:text/html,hi']) {
  check(`non-http scheme blocked: ${u}`, await blocked(u));
}
check('not-a-url blocked', await blocked('not a url at all'));

// --- IPv4 private / internal ranges ----------------------------------------
const BLOCKED_V4 = [
  ['http://127.0.0.1/', 'loopback'],
  ['http://127.0.0.1:4200/trust/promote', 'loopback with port+path (the OS API itself)'],
  ['http://10.1.2.3/', 'RFC1918 10/8'],
  ['http://172.16.5.5/', 'RFC1918 172.16/12'],
  ['http://172.31.255.255/', 'RFC1918 172.31 upper edge'],
  ['http://192.168.1.1/', 'RFC1918 192.168/16'],
  ['http://169.254.169.254/latest/meta-data/', 'CLOUD METADATA endpoint'],
  ['http://169.254.1.1/', 'link-local'],
  ['http://0.0.0.0/', 'unspecified'],
  ['http://100.64.0.1/', 'CGNAT'],
  ['http://224.0.0.1/', 'multicast'],
  ['http://240.0.0.1/', 'reserved'],
  ['https://127.0.0.1/', 'loopback over https too'],
];
for (const [u, why] of BLOCKED_V4) check(`v4 blocked (${why}): ${u}`, await blocked(u!));

// A public literal must still be ALLOWED — a guard that blocks everything is
// not a guard, and this is the case that catches an over-broad mask bug.
for (const u of ['http://8.8.8.8/', 'https://1.1.1.1/', 'http://172.32.0.1/', 'http://11.0.0.1/']) {
  check(`v4 public allowed: ${u}`, await allowed(u));
}

// --- IPv6 ------------------------------------------------------------------
const BLOCKED_V6 = [
  ['http://[::1]/', 'loopback'],
  ['http://[::]/', 'unspecified'],
  ['http://[fe80::1]/', 'link-local fe80::/10'],
  ['http://[fc00::1]/', 'unique-local fc00::/7'],
  ['http://[fd12:3456::1]/', 'unique-local fd00 form'],
  ['http://[::ffff:127.0.0.1]/', 'IPv4-MAPPED loopback'],
  ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped cloud metadata'],
  // REGRESSION (2026-08-12): the deprecated IPv4-COMPATIBLE form. Node's URL
  // parser rewrites this to hostname [::a9fe:a9fe] BEFORE the guard sees it, so
  // the original string/regex implementation could never match it and let the
  // cloud-metadata address straight through. Only a numeric group parse catches
  // it. If this case ever fails again, that whole bypass is back.
  ['http://[::169.254.169.254]/', 'IPv4-COMPATIBLE cloud metadata (historic bypass)'],
  ['http://[::a9fe:a9fe]/', 'same address written as hex groups'],
  ['http://[::127.0.0.1]/', 'IPv4-compatible loopback'],
];
for (const [u, why] of BLOCKED_V6) check(`v6 blocked (${why}): ${u}`, await blocked(u!));

check('v6 public allowed: [2606:4700::1111]', await allowed('http://[2606:4700::1111]/'));

// --- no DNS oracle ---------------------------------------------------------
// The thrown message must not hand back an internal address: http_get/fetch_url
// return a caught error verbatim as tool output, so a leaked IP would let a
// prompt-injected agent map an internal network purely from BLOCKED responses.
// (For an IP literal the caller obviously already knows the IP — what matters
// is that the message stays generic in shape.)
try {
  await assertPublicHttpUrl('http://169.254.169.254/');
  check('metadata address threw', false);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  check('block message mentions no resolved-address detail beyond the input', !/resolves to \d/.test(msg));
}

// --- redirect carry-over rules -------------------------------------------
// Following redirects manually is REQUIRED here (every hop must be re-validated),
// but it means losing what undici's own redirect handler does for free — and part
// of that is security-relevant. The first version of ssrfSafeFetch replayed
// Authorization and Cookie verbatim to a redirect target on a DIFFERENT host,
// which turns the SSRF guard into a credential-exfiltration path: a public URL
// 302s to an attacker host and hands over the bearer token. Pinned here.
const withCreds = (): RequestInit => ({
  method: 'POST',
  body: 'x=1',
  headers: { authorization: 'Bearer supersecret', cookie: 'session=abc', 'content-type': 'text/plain' },
});
const hdr = (i: RequestInit, n: string): string | null => new Headers((i.headers ?? {}) as never).get(n);
const A = new URL('https://good.example/a');
const B = new URL('https://evil.example/b');
const sameHost = new URL('https://good.example/other');

const cross = initForRedirect(withCreds(), A, B, 302);
check('cross-host redirect strips Authorization', hdr(cross, 'authorization') === null);
check('cross-host redirect strips Cookie', hdr(cross, 'cookie') === null);
check('cross-host redirect keeps benign headers', hdr(cross, 'content-type') === 'text/plain');

const same = initForRedirect(withCreds(), A, sameHost, 307);
check('SAME-host redirect keeps Authorization (not over-broad)', hdr(same, 'authorization') === 'Bearer supersecret');

// Method/body downgrade per spec, so a POST body is not silently re-sent.
check('303 downgrades to GET', initForRedirect(withCreds(), A, sameHost, 303).method === 'GET');
check('303 drops the body', initForRedirect(withCreds(), A, sameHost, 303).body === undefined);
check('302 downgrades a POST to GET', initForRedirect(withCreds(), A, sameHost, 302).method === 'GET');
check('307 PRESERVES method and body', (() => {
  const r = initForRedirect(withCreds(), A, sameHost, 307);
  return r.method === 'POST' && r.body === 'x=1';
})());
check('308 PRESERVES method and body', (() => {
  const r = initForRedirect(withCreds(), A, sameHost, 308);
  return r.method === 'POST' && r.body === 'x=1';
})());

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
