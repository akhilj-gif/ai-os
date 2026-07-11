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
  for (const el of Array.from(document.querySelectorAll('[data-aios-ref]'))) el.removeAttribute('data-aios-ref');
  const out: ElementRef[] = [];
  const seen = new Set<Element>();
  let i = 0;
  for (const el of Array.from(document.querySelectorAll(sel))) {
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
    const ref = 'e' + i++;
    el.setAttribute('data-aios-ref', ref);
    out.push({ ref, role, name });
    if (out.length >= 50) break;
  }
  return out;
}
