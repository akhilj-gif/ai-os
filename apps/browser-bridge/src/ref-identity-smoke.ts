// Element-ref identity smoke — real headless Chromium, no network, no DB.
// Run: tsx apps/browser-bridge/src/ref-identity-smoke.ts
//
// THE BUG THIS PINS. Refs used to be a bare positional counter — 'e0','e1','e2'
// in document order — and /act only checked that SOMETHING still carried the
// ref. So when a page re-rendered and a later find() re-numbered everything, the
// model's saved "e0" resolved to a DIFFERENT control. Measured: a page with
// [Sign in, Delete account] gained a prepended "Accept cookies" banner, and the
// saved ref for "Sign in" then pointed at "Accept cookies". The existence check
// passed, the click landed on the wrong button, and the bridge answered ok:true.
// Wrong action, success reported — the worst failure mode a browser agent has.
//
// Refs now carry a digest of role+name, so a re-bound ref simply does not exist
// and the stale-ref 404 fires. Where the same control merely MOVED, /act can
// recover by digest, but only when exactly one element carries it.
import { chromium } from 'playwright';
import { findInPage } from './find-in-page.js';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

/** Mirrors the resolution /act performs, including the digest recovery. */
async function resolve(ref: string): Promise<{ how: string; text: string | null }> {
  const exact = page.locator(`[data-aios-ref="${ref}"]`);
  if ((await exact.count()) > 0) return { how: 'exact', text: (await exact.first().textContent())?.trim() ?? null };
  const digest = ref.includes('~') ? ref.slice(ref.indexOf('~')) : null;
  const moved = digest ? page.locator(`[data-aios-ref$="${digest}"]`) : null;
  if (moved && (await moved.count()) === 1) return { how: 'recovered', text: (await moved.textContent())?.trim() ?? null };
  return { how: 'stale404', text: null };
}
const snap = (): Promise<Array<{ ref: string; name: string }>> => page.evaluate(findInPage, '') as Promise<Array<{ ref: string; name: string }>>;

try {
  // --- refs carry identity, not just position ------------------------------
  await page.setContent('<div id="l"><button>Sign in</button><button>Delete account</button></div>');
  const before = await snap();
  check('a ref encodes an identity digest, not a bare counter', /^e\d+~[a-z0-9]+$/.test(before[0]!.ref), before[0]!.ref);
  const signIn = before.find((r) => r.name === 'Sign in')!.ref;

  // --- THE REGRESSION: a prepended banner must not steal the saved ref -----
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.textContent = 'Accept cookies';
    document.getElementById('l')!.prepend(b);
  });
  const after = await snap();
  const nowAtE0 = after.find((r) => r.ref.startsWith('e0'))!;
  check('a re-render DOES shift positions (the hazard is real)', nowAtE0.name === 'Accept cookies', `e0 is now "${nowAtE0.name}"`);

  const r1 = await resolve(signIn);
  check('the saved ref never resolves to the wrong control', r1.text === 'Sign in' || r1.how === 'stale404', `${r1.how} -> ${r1.text}`);
  check('and it recovers the moved control rather than failing', r1.how === 'recovered' && r1.text === 'Sign in', `${r1.how} -> ${r1.text}`);

  // --- an element that is genuinely gone must 404 --------------------------
  await page.setContent('<div id="g"><button>Only</button></div>');
  const gone = (await snap())[0]!.ref;
  await page.evaluate(() => {
    document.getElementById('g')!.innerHTML = '<button>Different</button>';
  });
  await snap();
  const r2 = await resolve(gone);
  check('a removed control returns stale, never a substitute', r2.how === 'stale404', r2.how);

  // --- documented limit, asserted so it cannot silently change -------------
  // Two controls with the same role+name share a digest, so they stay
  // distinguishable only by position. This scheme fixes the differently-named
  // case; it does not claim to resolve genuine duplicates.
  await page.setContent('<div id="d"><button>Delete</button><button>Keep</button></div>');
  const dRef = (await snap()).find((r) => r.name === 'Delete')!.ref;
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.textContent = 'Delete';
    document.getElementById('d')!.prepend(b);
  });
  await snap();
  const r3 = await resolve(dRef);
  check('KNOWN LIMIT: duplicate names share a digest, so one is picked', r3.text === 'Delete', `${r3.how} -> ${r3.text}`);
} finally {
  await browser.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
