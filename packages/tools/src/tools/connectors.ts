// App connectors — a free, keyless way to plug the OS into any site the user is
// already signed into, using the Playwright bridge's persistent profile.
//
// WHY THIS AND NOT AN API/SCRAPING SERVICE. The paid options each fail on one
// axis: official APIs mostly do not exist for consumer apps (and Instagram's
// only sees your OWN account), and Apify-style services cost per result — its
// free tier is $5/month, roughly 1,850 Instagram results, then runs are blocked.
// The user has no budget, so the only sustainable connector is the browser they
// already own, with the session they already have.
//
// WHY RECIPES ARE LEARNED, NOT HARD-CODED. The obvious design is a table of
// selectors for Instagram, LinkedIn, Gmail and so on. That work rots on contact:
// consumer SPAs ship obfuscated, frequently-changing class names, and nobody can
// verify a selector for an account they cannot log into. So this ships the
// MECHANISM — derive selectors once against the real logged-in page, save them,
// replay them forever — and stores recipes as data in os_settings.
//
// THE POINT IS TOKEN COST, not just convenience. browser_extract returns the
// whole page (up to 20,000 chars) for the model to read, so "check my
// notifications" costs a full page of tokens on a free tier already capped at
// 7,000 input tokens per minute. app_run navigates and extracts with saved
// selectors and returns a few hundred bytes, with no model round-trip inside the
// loop — which is what makes it cheap enough to put on a schedule.
//
// TRUST. Everything here is READ-class and untrustedOutput: a page you are
// logged into is still attacker-influenced content (someone else's post,
// someone else's DM). Saving a recipe is write-class but touches only our own
// settings row. Nothing here can act on a page — that stays browser_act, which
// is approval-gated.
import type pg from 'pg';
import type { ToolDef, ToolContext } from '../registry.js';

const KEY_PREFIX = 'connector:';
/** Keep a replayed connector small on purpose — the whole reason it exists. */
const MAX_ROWS = 50;

/** Normalise a connector name. Shared by save and run so a name ALWAYS round
 *  trips: saving "HN Top Stories!!" and later running "HN Top Stories" must find
 *  the same recipe. The trailing-hyphen case is not hypothetical — the first
 *  version stored "hn-top-stories-" (trailing punctuation became a hyphen) and
 *  the obvious lookup then failed with "no connector named...". */
export function slug(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface Recipe {
  name: string;
  url: string;
  /** CSS selector for the repeating element (a post, a row, a notification).
   *  Omit for a single-value page (a profile header, a counter). */
  container?: string;
  /** field name -> CSS selector, optionally suffixed with @attr to read an
   *  attribute instead of text (e.g. "a@href"). ":scope" reads the container. */
  fields: Record<string, string>;
  limit?: number;
  /** Free-text note from whoever saved it — e.g. "must be signed in". */
  note?: string;
}

function bridgeUrl(): string | null {
  const u = process.env.BROWSER_BRIDGE_URL?.trim();
  return u ? u.replace(/\/$/, '') : null;
}

async function bridge(path: string, body: unknown): Promise<unknown> {
  const base = bridgeUrl();
  if (!base) throw new Error('BROWSER_BRIDGE_URL is not set — the browser bridge is what makes connectors work');
  const token = process.env.BROWSER_BRIDGE_TOKEN;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-bridge-token': token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`browser bridge ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as unknown;
}

async function loadRecipe(pool: pg.Pool, name: string): Promise<Recipe | null> {
  const { rows } = await pool.query<{ value: string }>(`SELECT value FROM os_settings WHERE key = $1`, [KEY_PREFIX + name]);
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].value) as Recipe;
  } catch {
    return null;
  }
}

export const appScrape: ToolDef = {
  name: 'app_scrape',
  untrustedOutput: true,
  description:
    'Extract SPECIFIC values from the page currently open in the browser, using CSS selectors, and return them as small structured rows. Use this instead of browser_extract when you know what you want — browser_extract returns the whole page and is expensive. Derive the selectors from browser_read first, then save a working set with app_save so it can be replayed cheaply. A field selector may end in @attr to read an attribute (e.g. "a@href").',
  inputSchema: {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'CSS selector for the repeating element (a post/row). Omit for a single-value page.' },
      fields: { type: 'object', description: 'Map of field name to CSS selector, e.g. {"title":"h3","link":"a@href"}' },
      limit: { type: 'integer', description: 'Max rows (1-100, default 20)' },
    },
    required: ['fields'],
  },
  async execute(args) {
    const fields = args.fields as Record<string, string> | undefined;
    if (!fields || Object.keys(fields).length === 0) throw new Error('fields is required, e.g. {"title":"h3","link":"a@href"}');
    return bridge('/scrape', { container: args.container, fields, limit: args.limit });
  },
};

export const appSave: ToolDef = {
  name: 'app_save',
  description:
    'Save a working set of selectors as a NAMED, reusable connector so it can be replayed later with app_run (and put on a schedule) without re-deriving anything. Only save selectors you have just verified with app_scrape on the real page.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short id, e.g. "instagram-notifications"' },
      url: { type: 'string', description: 'URL to open before extracting' },
      container: { type: 'string', description: 'CSS selector for the repeating element (optional)' },
      fields: { type: 'object', description: 'Map of field name to CSS selector' },
      limit: { type: 'integer' },
      note: { type: 'string', description: 'Anything the next run should know, e.g. "must be signed in"' },
    },
    required: ['name', 'url', 'fields'],
  },
  async execute(args, ctx: ToolContext) {
    const name = slug(String(args.name ?? ''));
    const url = String(args.url ?? '').trim();
    const fields = args.fields as Record<string, string> | undefined;
    if (!name) throw new Error('name is required');
    if (!/^https?:\/\//i.test(url)) throw new Error('url must be an http(s) URL');
    if (!fields || Object.keys(fields).length === 0) throw new Error('fields is required');
    const recipe: Recipe = {
      name,
      url,
      container: args.container ? String(args.container) : undefined,
      fields,
      limit: args.limit ? Number(args.limit) : undefined,
      note: args.note ? String(args.note) : undefined,
    };
    await ctx.pool.query(
      `INSERT INTO os_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEY_PREFIX + name, JSON.stringify(recipe)],
    );
    return { saved: name, url, fields: Object.keys(fields), replayWith: `app_run({"name":"${name}"})` };
  },
};

export const appList: ToolDef = {
  name: 'app_list',
  description: 'List the saved app connectors (name, URL, fields). Call this first when the user asks about an app — a saved connector is far cheaper than re-deriving selectors.',
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, ctx: ToolContext) {
    const { rows } = await ctx.pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM os_settings WHERE key LIKE $1 ORDER BY key`,
      [KEY_PREFIX + '%'],
    );
    const connectors = rows.map((r) => {
      try {
        const c = JSON.parse(r.value) as Recipe;
        return { name: c.name, url: c.url, fields: Object.keys(c.fields), note: c.note };
      } catch {
        return { name: r.key.slice(KEY_PREFIX.length), broken: true };
      }
    });
    return connectors.length
      ? { connectors }
      : { connectors: [], note: 'No connectors saved yet. Open the page with browser_navigate, find selectors with browser_read, verify with app_scrape, then app_save it.' };
  },
};

export const appRun: ToolDef = {
  name: 'app_run',
  untrustedOutput: true,
  description:
    'Run a SAVED app connector: opens its URL in the browser and extracts its fields, returning small structured rows. This is the cheap path — use it whenever a connector exists for what the user asked about. Requires the browser to already be signed into that site.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Connector name from app_list' },
      limit: { type: 'integer', description: 'Override the saved row limit' },
    },
    required: ['name'],
  },
  async execute(args, ctx: ToolContext) {
    // Slugified the SAME way as on save, so a human-shaped name still resolves.
    const name = slug(String(args.name ?? ''));
    const recipe = await loadRecipe(ctx.pool, name);
    if (!recipe) {
      const { rows } = await ctx.pool.query<{ key: string }>(`SELECT key FROM os_settings WHERE key LIKE $1`, [KEY_PREFIX + '%']);
      throw new Error(
        `no connector named "${name}". Saved: ${rows.map((r) => r.key.slice(KEY_PREFIX.length)).join(', ') || '(none)'}`,
      );
    }
    await bridge('/navigate', { url: recipe.url });
    const out = (await bridge('/scrape', {
      container: recipe.container,
      fields: recipe.fields,
      limit: Math.min(Number(args.limit) || recipe.limit || 20, MAX_ROWS),
    })) as { rows?: unknown[]; count?: number; hint?: string };
    // A saved recipe returning nothing is the failure mode that matters: the site
    // re-skinned and the selectors are stale. Reporting "0 rows" as if it were an
    // empty inbox is the silent-wrong-answer class this repo keeps paying for.
    if (!out.count) {
      return {
        connector: name,
        url: recipe.url,
        rows: [],
        stale: true,
        error:
          `The "${name}" connector matched nothing. Either you are not signed into ${new URL(recipe.url).hostname} in the browser, or the site changed and the selectors need re-deriving (browser_read, then app_scrape, then app_save to overwrite). Do NOT report this as "nothing new".`,
      };
    }
    return { connector: name, url: recipe.url, ...out };
  },
};
