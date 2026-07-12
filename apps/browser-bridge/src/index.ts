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
import { DEFAULT_BROWSER_BRIDGE_PORT } from './contract.js';
import { findInPage } from './find-in-page.js';

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

async function ensurePage(): Promise<Page> {
  if (context && page && !page.isClosed()) return page;
  context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: HEADLESS, viewport: { width: 1280, height: 800 } });
  page = context.pages()[0] ?? (await context.newPage());
  const start = process.env.AIOS_BROWSER_START_URL;
  if (start) await page.goto(start, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  return page;
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
    // A stale/typo'd ref has to fail this check to even reach click/fill/
    // selectOption below — otherwise a ref that plainly never existed pays
    // the full 15s action-timeout instead of failing in ~milliseconds.
    if (loc && (await loc.count()) === 0) {
      return reply.code(404).send({ error: `no element matches ref "${ref}" — it may be stale (page navigated/re-rendered); call read/find again for current refs` });
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
    await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    return { ok: true, action, url: p.url(), title: await p.title() };
  });

  process.on('unhandledRejection', (e) => app.log.error({ err: e instanceof Error ? e.message : e }, 'unhandledRejection'));
  process.on('uncaughtException', (e) => app.log.error({ err: e.message }, 'uncaughtException'));

  await app.listen({ port: PORT, host: '127.0.0.1' });
  app.log.info(`[browser-bridge] listening on http://127.0.0.1:${PORT} (headless=${HEADLESS})`);
}

void main();
