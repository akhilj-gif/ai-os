// Playwright browser bridge (ADR-0018 / M15b). Owns ONE persistent Chromium and
// serves the browser contract. Headed by default so Akhil can watch it work and
// sign in to sites that need a login (OTP/CAPTCHA are his manual steps — the
// bridge never auto-solves them). Binds 127.0.0.1 only.
//
// Element refs: /find tags matching elements with a data-aios-ref attribute and
// returns {ref, role, name}; /act resolves `[data-aios-ref="…"]`. Each /find call
// re-tags from scratch (clearing any refs a PRIOR call left behind), so refs are
// a snapshot of THAT call only — /act with a ref from an earlier /find (before
// the page changed, or before a narrower-query /find re-numbered from e0) may
// resolve to nothing or the wrong element. Always /find immediately before /act.
//
// Run: pnpm --filter @ai-os/browser-bridge start
//   BROWSER_HEADLESS=1  → run headless (no visible window)
//   BROWSER_BRIDGE_PORT / BROWSER_BRIDGE_TOKEN / AIOS_BROWSER_START_URL
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { timingSafeEqualStr } from '@ai-os/shared';
import { DEFAULT_BROWSER_BRIDGE_PORT, type ElementRef } from './contract.js';
import { findInPage } from './find-in-page.js';
import { installSsrfGuard } from './ssrf-route.js';

// Playwright's own error messages (e.g. locator timeouts) embed ANSI dim/reset
// codes from its terminal call-log pretty-printer — strip them before they hit
// a JSON error body, which has no terminal to render them.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const PORT = Number(process.env.BROWSER_BRIDGE_PORT) || DEFAULT_BROWSER_BRIDGE_PORT;
const HEADLESS = process.env.BROWSER_HEADLESS === '1' || process.env.BROWSER_HEADLESS === 'true';
const MAX_TEXT = 20_000;
// Persistent profile so logins/cookies survive restarts (like the WhatsApp
// bridge's .auth) — essential for gated sites (Ola/Rapido, banking). Gitignored.
const USER_DATA_DIR = process.env.BROWSER_USER_DATA_DIR ?? fileURLToPath(new URL('../.userdata', import.meta.url));

let context: BrowserContext | null = null;
let page: Page | null = null;

// The SSRF route guard lives in ./ssrf-route.ts so its smoke can import the
// real installer without booting this server. See that file for the full
// rationale, including the documented DNS-rebinding residual.

async function ensurePage(): Promise<Page> {
  if (context && page && !page.isClosed()) return page;
  context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: HEADLESS, viewport: { width: 1280, height: 800 } });
  installSsrfGuard(context);
  // FOLLOW NEW TABS (2026-08-19). Measured: clicking a target="_blank" link on
  // example.com opened a second page and the bridge kept driving the FIRST one,
  // so every subsequent read/find/act targeted the tab the user had just left
  // and the new one was orphaned. On a real site that is most checkout flows,
  // most OAuth popups, and most "open in new tab" results — the task silently
  // continues against the wrong document.
  //
  // Adopting the newest page is the right default for an agent: a click that
  // opens a tab is the site moving you there. It is also reversible, since
  // /tabs lists every page and /tabs/:i switches back.
  context.on('page', (fresh) => {
    void fresh
      .waitForLoadState('domcontentloaded')
      .catch(() => undefined)
      .then(() => {
        if (!fresh.isClosed()) page = fresh;
      });
  });
  // If the tracked tab is closed (by the site or by us), fall back to whatever
  // is left rather than throwing on the next call.
  context.on('close', () => {
    page = null;
  });
  page = context.pages()[0] ?? (await context.newPage());
  const start = process.env.AIOS_BROWSER_START_URL;
  if (start) await page.goto(start, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  return page;
}

/** Refs from a child frame carry an `f<index>:` prefix; resolve back to the
 *  frame that minted them. Main-frame refs stay bare, which keeps the common
 *  case short and every existing ref valid. */
function locatorFor(p: Page, ref: string) {
  const m = /^f(\d+):(.+)$/.exec(ref);
  if (!m) return p.locator(`[data-aios-ref="${ref}"]`);
  const frame = p.frames()[Number(m[1])];
  // A vanished frame is a stale ref, and the caller's 404 path handles that —
  // a locator over the main frame would silently find nothing, which reads the
  // same to the caller but is a lie about where we looked.
  return (frame ?? p.mainFrame()).locator(`[data-aios-ref="${m[2]}"]`);
}

const SNAPSHOT_MAX = 30;
/** A fresh, compact list of the page's interactive elements (with refs). Returned
 *  after navigate/act so the model always knows the CURRENT page's controls
 *  without a separate /find — refs are re-tagged each call, so these are valid
 *  right now (the stale-ref trap). */
async function snapshot(p: Page): Promise<ElementRef[]> {
  return (await findEverywhere(p, '')).slice(0, SNAPSHOT_MAX);
}

/** Run findInPage in EVERY frame, not just the main one.
 *
 *  page.evaluate only ever reaches the main frame, and a cross-origin iframe
 *  cannot be read from it at all — so cookie banners, embedded payment fields,
 *  and third-party login widgets were entirely invisible. Measured 2026-08-19:
 *  a page with one iframe reported one control from the main document while
 *  "Accept all cookies" and a card-number field sat unreachable in the child.
 *  Those are exactly the controls a real task has to click first.
 *
 *  Child-frame refs are namespaced `f<index>:<ref>` so /act can resolve them
 *  back to the right frame. Frame index is a per-call snapshot, same contract
 *  the refs themselves already have — and if the indexes shift, the identity
 *  digest in the ref means the lookup misses and returns the stale-ref 404
 *  rather than acting on the wrong element. */
async function findEverywhere(p: Page, query: string): Promise<ElementRef[]> {
  const frames = p.frames();
  const out: ElementRef[] = [];
  for (const [i, frame] of frames.entries()) {
    // A detached or still-loading frame throws; it simply contributes nothing.
    const found = (await frame.evaluate(findInPage, query).catch(() => [])) as ElementRef[];
    const isMain = frame === p.mainFrame();
    for (const r of found) {
      out.push(isMain ? r : { ...r, ref: `f${i}:${r.ref}`, name: r.name });
    }
  }
  return out;
}

/** Let a page settle after a navigation/interaction: DOM ready always, then a
 *  BEST-EFFORT networkidle so SPA/async content that arrives after the initial
 *  response is present before we snapshot or the next step runs. */
async function settle(p: Page): Promise<void> {
  await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
  await p.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => undefined);
}

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  // .trim() so a whitespace-only value doesn't slip past this warning (2026-08-12,
  // sharp-edges hunt — same class as the whatsapp-bridge blank-token fix).
  const token = (process.env.BROWSER_BRIDGE_TOKEN ?? '').trim() || undefined;
  if (!token) {
    app.log.warn('SECURITY: BROWSER_BRIDGE_TOKEN is not set — the browser bridge is UNAUTHENTICATED (anyone on loopback can drive your logged-in Chromium). Set it in .env and restart.');
  }

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0] === '/health') return; // health is unauthenticated (liveness only)
    if (token && !timingSafeEqualStr(String(req.headers['x-bridge-token'] ?? ''), token)) return reply.code(401).send({ error: 'bad bridge token' });
  });

  app.get('/health', async () => ({ ok: true, impl: 'playwright', url: page && !page.isClosed() ? page.url() : 'about:blank', headless: HEADLESS }));

  app.post('/navigate', async (req, reply) => {
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url || !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'absolute http/https url required' });
    const p = await ensurePage();
    // One retry: transient DNS/timeout on the first hit is common; a second
    // attempt after a beat succeeds far more often than it fails again.
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      await p.waitForTimeout(800);
      try {
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch {
        return reply.code(502).send({ error: `could not load ${url}: ${(err instanceof Error ? err.message : 'navigation failed').replace(ANSI_RE, '').slice(0, 200)}` });
      }
    }
    await settle(p);
    // Return the page's controls immediately — the model can act without a
    // separate /read + /find round-trip.
    return { url: p.url(), title: await p.title(), elements: await snapshot(p) };
  });

  app.post('/read', async () => {
    const p = await ensurePage();
    const text = (await p.evaluate(() => document.body?.innerText ?? '')).slice(0, MAX_TEXT);
    // Structured read: text AND the current interactive elements in one call.
    return { url: p.url(), title: await p.title(), text, elements: await snapshot(p) };
  });

  // Wait for the page to reach a condition before the next step — the fix for
  // "acted before the element existed" on dynamic/SPA pages.
  app.post('/wait', async (req, reply) => {
    const { selector, text, state, timeoutMs } = (req.body ?? {}) as { selector?: string; text?: string; state?: string; timeoutMs?: number };
    const p = await ensurePage();
    const timeout = Math.min(Math.max(Number(timeoutMs) || 10_000, 500), 30_000);
    try {
      if (selector) await p.locator(selector).first().waitFor({ state: 'visible', timeout });
      else if (text) await p.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
      else await p.waitForLoadState((state as 'load' | 'networkidle') || 'networkidle', { timeout });
      return { ok: true, url: p.url(), title: await p.title(), elements: await snapshot(p) };
    } catch (err) {
      return reply.code(504).send({ error: `wait timed out (${timeout}ms): ${(err instanceof Error ? err.message : '').replace(ANSI_RE, '').slice(0, 160) || 'condition not met'}` });
    }
  });

  // Screenshot the current viewport (JPEG, base64) — for visual verification via
  // the OS's vision model ("is the confirmation shown?").
  app.post('/screenshot', async () => {
    const p = await ensurePage();
    const buf = await p.screenshot({ type: 'jpeg', quality: 55 });
    return { url: p.url(), title: await p.title(), dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` };
  });

  app.post('/find', async (req) => {
    const { query } = (req.body ?? {}) as { query?: string };
    const p = await ensurePage();
    const matches = await findEverywhere(p, query ?? '');
    return { matches };
  });

  app.post('/extract', async (req) => {
    const { instruction } = (req.body ?? {}) as { instruction?: string };
    const p = await ensurePage();
    const text = (await p.evaluate(() => document.body?.innerText ?? '')).slice(0, MAX_TEXT);
    return { url: p.url(), instruction: instruction ?? '', text };
  });

  // DETERMINISTIC extraction. /extract above ignores its instruction and returns
  // the whole document.body.innerText (up to 20,000 chars) for the model to read
  // — which makes "check my notifications" cost a full page of tokens every
  // time, on a free tier already capped at 7,000 input tokens/minute. This runs
  // CSS selectors in the page instead and returns only the matched values, so a
  // saved recipe costs a few hundred bytes and needs no model round-trip at all.
  //
  // A field selector may end in @attr to read an attribute rather than text
  // (e.g. "a@href", "img@src") — links and image URLs are the two things page
  // TEXT can never give you, and they are most of what a connector wants.
  app.post('/scrape', async (req, reply) => {
    const { container, fields, limit } = (req.body ?? {}) as {
      container?: string;
      fields?: Record<string, string>;
      limit?: number;
    };
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      return reply.code(400).send({ error: 'fields is required: { name: "cssSelector" | "cssSelector@attr" }' });
    }
    const p = await ensurePage();
    const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
    try {
      // Written FLAT — no inner helper functions. This body is shipped into the
      // page, and esbuild wraps nested function expressions in a `__name` helper
      // that does not exist there; a previous in-page walker did that and threw
      // ReferenceError on every call. Same hazard, same discipline.
      const rows = await p.evaluate(
        (arg: { container?: string; fields: Record<string, string>; cap: number }) => {
          const scopes: Element[] = arg.container
            ? Array.from(document.querySelectorAll(arg.container)).slice(0, arg.cap)
            : [document.documentElement];
          const out: Array<Record<string, string | null>> = [];
          for (const scope of scopes) {
            const row: Record<string, string | null> = {};
            for (const key of Object.keys(arg.fields)) {
              const spec = arg.fields[key] as string;
              const at = spec.lastIndexOf('@');
              const sel = at > 0 ? spec.slice(0, at) : spec;
              const attr = at > 0 ? spec.slice(at + 1) : '';
              let el: Element | null = null;
              try {
                el = sel === ':scope' ? scope : scope.querySelector(sel);
              } catch {
                row[key] = null;
                continue;
              }
              if (!el) {
                row[key] = null;
                continue;
              }
              const v = attr ? el.getAttribute(attr) : (el as HTMLElement).innerText;
              row[key] = v === null || v === undefined ? null : String(v).trim().slice(0, 500);
            }
            out.push(row);
          }
          return out;
        },
        { container, fields, cap },
      );
      const matched = rows.filter((r) => Object.values(r).some((v) => v !== null && v !== ''));
      return {
        url: p.url(),
        rows: matched,
        count: matched.length,
        // An empty result is almost always a stale selector, not an empty page.
        // Say so, or the caller reports "you have no notifications" when in fact
        // the site re-skinned and the recipe needs re-learning.
        ...(matched.length === 0 ? { hint: 'no element matched — the selectors are probably stale for this page; re-derive them with browser_read' } : {}),
      };
    } catch (e) {
      return reply.code(400).send({ error: `scrape failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

  app.post('/act', async (req, reply) => {
    const { action, ref, text } = (req.body ?? {}) as { action?: string; ref?: string; text?: string };
    if (!action) return reply.code(400).send({ error: 'action is required' });
    const p = await ensurePage();
    let loc = ref ? locatorFor(p, ref) : null;
    // A stale/typo'd ref has to fail this check to even reach click/fill/
    // selectOption below — otherwise a ref that plainly never existed pays
    // the full 15s action-timeout instead of failing in ~milliseconds.
    if (loc && (await loc.count()) === 0) {
      // RECOVERY (2026-08-19): a ref is now `e<position>~<digest of role+name>`,
      // and the digest follows the element when the page re-renders — "Sign in"
      // stays ~1kxw even after it shifts from e0 to e1. So an exact-ref miss with
      // exactly ONE element carrying the same digest is unambiguously the same
      // control, just moved, and clicking it is what the caller meant. Requiring
      // exactly one match is what keeps this safe: if the name is duplicated on
      // the page there is a real choice to make, and guessing is how you click
      // the wrong "Delete". Zero or many -> the stale-ref 404 below, unchanged.
      const digest = ref?.includes('~') ? ref.slice(ref.indexOf('~')) : null;
      const fm = /^f(\d+):/.exec(ref ?? '');
      const scope = fm ? (p.frames()[Number(fm[1])] ?? p.mainFrame()) : p;
      const moved = digest ? scope.locator(`[data-aios-ref$="${digest}"]`) : null;
      if (moved && (await moved.count()) === 1) {
        loc = moved;
      } else {
        return reply.code(404).send({ error: `no element matches ref "${ref}" — it may be stale (page navigated/re-rendered); call read/find again for current refs` });
      }
    }
    try {
      switch (action) {
        case 'click':
          if (!loc) return reply.code(400).send({ error: 'click needs a ref' });
          await loc.click({ timeout: 15_000 });
          break;
        case 'type':
          if (!loc) return reply.code(400).send({ error: 'type needs a ref' });
          await loc.fill(text ?? '', { timeout: 15_000 });
          break;
        case 'select':
          if (!loc) return reply.code(400).send({ error: 'select needs a ref' });
          await loc.selectOption(text ?? '', { timeout: 15_000 });
          break;
        case 'key':
          await p.keyboard.press(text || 'Enter');
          break;
        case 'scroll':
          await p.mouse.wheel(0, Number(text) || 600);
          break;
        default:
          return reply.code(400).send({ error: `unknown action "${action}"` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'action failed';
      return reply.code(500).send({ error: message.replace(ANSI_RE, '').slice(0, 300) });
    }
    await settle(p);
    // Return the post-action page state + fresh controls, so the model sees the
    // result of what it did and can take the next step without a stale ref.
    return { ok: true, action, url: p.url(), title: await p.title(), elements: await snapshot(p) };
  });

  process.on('unhandledRejection', (e) => app.log.error({ err: e instanceof Error ? e.message : e }, 'unhandledRejection'));
  process.on('uncaughtException', (e) => app.log.error({ err: e.message }, 'uncaughtException'));

  await app.listen({ port: PORT, host: '127.0.0.1' });
  app.log.info(`[browser-bridge] listening on http://127.0.0.1:${PORT} (headless=${HEADLESS})`);
}

void main();
