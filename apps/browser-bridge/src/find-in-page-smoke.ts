// find-in-page smoke — deterministic against a REAL headless Chromium (no
// bridge server, no network): loads a local HTML fixture reproducing the
// olacabs.com shape (custom <li> autocomplete items with no role, standard
// nav links) and proves (1) custom clickable widgets are found, (2) noise
// (plain non-clickable <li>) is excluded, and (3) the ref-collision bug found
// live 2026-07-11 stays fixed — a narrower second find() must not leave two
// elements sharing the same ref.
// Run: npx tsx apps/browser-bridge/src/find-in-page-smoke.ts
import { chromium } from 'playwright';
import { findInPage } from './find-in-page.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const FIXTURE = `<!doctype html><html><body>
  <nav><a href="/about">About</a><a href="/contact">Contact</a></nav>
  <input id="pickup" placeholder="Current Location" />
  <ul id="suggestions">
    <li style="cursor:pointer">Rajiv Gandhi International Airport</li>
    <li style="cursor:pointer">Hyderabad Metro Rail</li>
  </ul>
  <ul id="plain-nav-noise"><li>Not clickable, just a list item</li></ul>
  <button>Submit</button>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(FIXTURE);

console.log('— custom widget detection —');
{
  const matches = await page.evaluate(findInPage, '');
  const names = matches.map((m) => m.name);
  check('finds the standard input field', names.includes('Current Location'));
  check('finds the standard button', names.includes('Submit'));
  check('finds custom cursor:pointer <li> widgets (the Ola-shaped case)', names.includes('Rajiv Gandhi International Airport') && names.includes('Hyderabad Metro Rail'));
  check('excludes a non-clickable plain <li> (no noise)', !names.includes('Not clickable, just a list item'));
  const airport = matches.find((m) => m.name === 'Rajiv Gandhi International Airport');
  check('custom widget gets a listitem role', airport?.role === 'listitem');
}

console.log('\n— ref-collision fix (live bug, 2026-07-11) —');
{
  // First call: broad query matches many elements, "About" link becomes e1.
  const broad = await page.evaluate(findInPage, '');
  const aboutRef = broad.find((m) => m.name === 'About')!.ref;
  check('broad find tags "About"', !!aboutRef);

  // Second call: a NARROW query that also numbers from e0 — before the fix,
  // this left "About" (still wearing its old ref from the broad call) sharing
  // a ref with whatever the narrow call's own e0/e1 numbering assigned.
  const narrow = await page.evaluate(findInPage, 'current location');
  check('narrow find returns only the matching field', narrow.length === 1 && narrow[0]!.name === 'Current Location');

  const refCounts = await page.evaluate(() => {
    const counts: Record<string, number> = {};
    for (const el of Array.from(document.querySelectorAll('[data-aios-ref]'))) {
      const ref = el.getAttribute('data-aios-ref')!;
      counts[ref] = (counts[ref] ?? 0) + 1;
    }
    return counts;
  });
  const collisions = Object.entries(refCounts).filter(([, n]) => n > 1);
  check('no ref is shared by two elements after a second, narrower find()', collisions.length === 0, JSON.stringify(refCounts));

  // The concrete failure mode: resolving the narrow call's own ref must hit
  // EXACTLY one element (this is what threw "strict mode violation" live).
  const soleRef = narrow[0]!.ref;
  const hitCount = await page.locator(`[data-aios-ref="${soleRef}"]`).count();
  check('resolving the fresh ref hits exactly one element (no strict-mode violation)', hitCount === 1, `count=${hitCount}`);
}

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
