// Playwright browser bridge (ADR-0018 / M15b). Owns ONE persistent Chromium and
// serves the browser contract. Headed by default so Akhil can watch it work and
// sign in to sites that need a login (OTP/CAPTCHA are his manual steps — the
// bridge never auto-solves them). Binds 127.0.0.1 only.
//
// Element refs: /find tags matching elements with a data-aios-ref attribute and
// returns {ref, role, name}; /act resolves `[data-aios-ref="…"]`. Refs are valid
// until the next navigation (attributes reset on a new document), so callers
// /find again after navigating.
//
// Run: pnpm --filter @ai-os/browser-bridge start
//   BROWSER_HEADLESS=1  → run headless (no visible window)
//   BROWSER_BRIDGE_PORT / BROWSER_BRIDGE_TOKEN / AIOS_BROWSER_START_URL
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { DEFAULT_BROWSER_BRIDGE_PORT, type ElementRef } from './contract.js';

const PORT = Number(process.env.BROWSER_BRIDGE_PORT) || DEFAULT_BROWSER_BRIDGE_PORT;
const HEADLESS = process.env.BROWSER_HEADLESS === '1' || process.env.BROWSER_HEADLESS === 'true';
const MAX_TEXT = 20_000;
// Persistent profile so logins/cookies survive restarts (like the WhatsApp
// bridge's .auth) — essential for gated sites (Ola/Rapido, banking). Gitignored.
const USER_DATA_DIR = process.env.BROWSER_USER_DATA_DIR ?? fileURLToPath(new URL('../.userdata', import.meta.url));

let context: BrowserContext | null = null;
let page: Page | null = null;

async function ensurePage(): Promise<Page> {
  if (context && page && !page.isClosed()) return page;
  context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: HEADLESS, viewport: { width: 1280, height: 800 } });
  page = context.pages()[0] ?? (await context.newPage());
  const start = process.env.AIOS_BROWSER_START_URL;
  if (start) await page.goto(start, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  return page;
}

// Tag interactive elements and return refs. Runs IN the page (real function,
// not a string — a string form would ignore the query arg); assigns a stable
// data-aios-ref to each candidate so /act can resolve it deterministically.
function findInPage(query: string): ElementRef[] {
  const q = (query || '').toLowerCase();
  const sel = 'a,button,input,textarea,select,[role=button],[role=link],[onclick]';
  const out: ElementRef[] = [];
  let i = 0;
  for (const el of Array.from(document.querySelectorAll(sel))) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0) || cs.visibility === 'hidden' || cs.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' || tag === 'textarea' || tag === 'select' ? 'field' : 'button');
    const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value') || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (q && !(name.toLowerCase().includes(q) || role.includes(q))) continue;
    const ref = 'e' + i++;
    el.setAttribute('data-aios-ref', ref);
    out.push({ ref, role, name });
    if (out.length >= 50) break;
  }
  return out;
}

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  const token = process.env.BROWSER_BRIDGE_TOKEN;

  app.addHook('onRequest', async (req, reply) => {
    if (token && req.headers['x-bridge-token'] !== token) return reply.code(401).send({ error: 'bad bridge token' });
  });

  app.get('/health', async () => ({ ok: true, impl: 'playwright', url: page && !page.isClosed() ? page.url() : 'about:blank', headless: HEADLESS }));

  app.post('/navigate', async (req, reply) => {
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url || !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'absolute http/https url required' });
    const p = await ensurePage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return { url: p.url(), title: await p.title() };
  });

  app.post('/read', async () => {
    const p = await ensurePage();
    const text = (await p.evaluate(() => document.body?.innerText ?? '')).slice(0, MAX_TEXT);
    return { url: p.url(), title: await p.title(), text };
  });

  app.post('/find', async (req) => {
    const { query } = (req.body ?? {}) as { query?: string };
    const p = await ensurePage();
    const matches = await p.evaluate(findInPage, query ?? '');
    return { matches };
  });

  app.post('/extract', async (req) => {
    const { instruction } = (req.body ?? {}) as { instruction?: string };
    const p = await ensurePage();
    const text = (await p.evaluate(() => document.body?.innerText ?? '')).slice(0, MAX_TEXT);
    return { url: p.url(), instruction: instruction ?? '', text };
  });

  app.post('/act', async (req, reply) => {
    const { action, ref, text } = (req.body ?? {}) as { action?: string; ref?: string; text?: string };
    if (!action) return reply.code(400).send({ error: 'action is required' });
    const p = await ensurePage();
    const loc = ref ? p.locator(`[data-aios-ref="${ref}"]`) : null;
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
      return reply.code(500).send({ error: err instanceof Error ? err.message.slice(0, 300) : 'action failed' });
    }
    await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    return { ok: true, action, url: p.url(), title: await p.title() };
  });

  process.on('unhandledRejection', (e) => app.log.error({ err: e instanceof Error ? e.message : e }, 'unhandledRejection'));
  process.on('uncaughtException', (e) => app.log.error({ err: e.message }, 'uncaughtException'));

  await app.listen({ port: PORT, host: '127.0.0.1' });
  app.log.info(`[browser-bridge] listening on http://127.0.0.1:${PORT} (headless=${HEADLESS})`);
}

void main();
