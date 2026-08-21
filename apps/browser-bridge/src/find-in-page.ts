// Pure in-page element-finding logic (M15b), extracted from index.ts so it can
// be unit-tested against a real (headless) browser without booting the bridge
// server. Runs INSIDE the page via page.evaluate — no Node globals.
import type { ElementRef } from './contract.js';

// Covers standard controls PLUS custom widgets (autocomplete dropdown items,
// menu options) that many SPAs build from <li>/<div> with no semantic role —
// found live on olacabs.com's location-suggestion list (2026-07-11): those
// items matched none of a/button/[role] and were invisible to this tool until
// the cursor:pointer + option/listitem/menuitem heuristic was added below.
export function findInPage(query: string): ElementRef[] {
  const q = (query || '').toLowerCase();
  const sel = 'a,button,input,textarea,select,[role=button],[role=link],[onclick],li,[role=option],[role=listitem],[role=menuitem],[class*=suggest],[class*=option]';
  // Clear refs from any PRIOR find() call first — otherwise an element tagged
  // e1 by an earlier (broader) query keeps that attribute forever, and a later
  // narrower query's own fresh e0/e1 numbering collides with it: /act then
  // resolves the ref to TWO elements (hit live: "Enter Location" field and an
  // unrelated nav link both carried data-aios-ref="e1" → Playwright's strict
  // mode correctly refused to guess which one). Refs are a per-call snapshot.
  // querySelectorAll does NOT pierce shadow roots, so every control inside a web
  // component was invisible — measured 2026-08-19: a page whose only button was
  // in an open shadow root returned an empty list. Design-system buttons, media
  // players and many payment widgets live there, so "this page has no controls"
  // was a lie on a growing share of real sites. Closed roots stay unreachable by
  // construction; nothing can see into those.
  //
  // Written as an explicit STACK, not recursion with inner helper functions.
  // This whole function is shipped to the browser via page.evaluate, and esbuild
  // wraps nested function expressions in a `__name` helper that does not exist
  // in the page — a first attempt using two inner arrows made every call throw
  // `ReferenceError: __name is not defined`, i.e. it broke find entirely rather
  // than just failing to see shadow content. A flat loop has no such hazard.
  const roots: Array<Document | ShadowRoot> = [document];
  const candidates: Element[] = [];
  for (let ri = 0; ri < roots.length; ri++) {
    const root = roots[ri]!;
    for (const el of Array.from(root.querySelectorAll('[data-aios-ref]'))) el.removeAttribute('data-aios-ref');
    for (const el of Array.from(root.querySelectorAll(sel))) candidates.push(el);
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) roots.push(sr);
    }
  }

  const out: ElementRef[] = [];
  const seen = new Set<Element>();
  let i = 0;
  for (const el of candidates) {
    if (seen.has(el)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0) || cs.visibility === 'hidden' || cs.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    // A bare <li>/div is only worth surfacing if it's actually clickable —
    // otherwise every list item on the page (nav, footer) becomes noise.
    if ((tag === 'li' || tag === 'div') && !el.getAttribute('role') && cs.cursor !== 'pointer') continue;
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' || tag === 'textarea' || tag === 'select' ? 'field' : tag === 'li' ? 'listitem' : 'button');
    const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value') || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!name) continue;
    if (q && !(name.toLowerCase().includes(q) || role.includes(q))) continue;
    seen.add(el);
    // The ref carries IDENTITY, not just position (2026-08-19). It used to be a
    // bare counter, 'e0','e1','e2'… assigned in document order, and /act only
    // checked that SOMETHING carried the ref. So when a page re-rendered and a
    // later find() re-numbered the elements, the model's saved "e1" resolved to a
    // DIFFERENT control: the existence check passed, the click landed on the
    // wrong thing, and the bridge reported ok:true. Wrong action, success
    // reported — the worst failure mode available to a browser agent.
    //
    // Appending a digest of role+name makes a re-bound ref simply NOT EXIST, so
    // the stale-ref 404 that /act already returns starts firing for this case
    // too. No new parameter and no cooperation from the model required: it hands
    // back the same opaque string it was given.
    //
    // KNOWN LIMIT: two controls with the SAME role and name (two "Delete"
    // buttons in a list) produce the same digest, so they remain distinguishable
    // only by position — the thing that is unreliable. Verified, not assumed.
    // This scheme fixes the dangerous case, where the ref silently comes to mean
    // a DIFFERENTLY-named control ("Sign in" -> "Accept cookies"); it does not
    // claim to resolve genuine duplicates, which need row context the accessible
    // name does not carry.
    let h = 5381;
    const idSrc = role + '|' + name;
    for (let k = 0; k < idSrc.length; k++) h = ((h << 5) + h + idSrc.charCodeAt(k)) >>> 0;
    const ref = 'e' + i++ + '~' + h.toString(36).slice(0, 4);
    el.setAttribute('data-aios-ref', ref);
    out.push({ ref, role, name });
    if (out.length >= 50) break;
  }
  return out;
}
