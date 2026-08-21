// fetch_url — retrieve a web page and extract readable text. Self-contained
// (own HTTP + HTML→text), like web_search, so the OS never depends on a host's
// MCP server. Output is UNTRUSTED external content (§8.3) — the trust gate blocks
// mutations once it's in context.
import type { ToolDef } from '../registry.js';
import { ssrfSafeFetch } from '@ai-os/shared';

const MAX_BYTES = 2_000_000; // don't ingest huge pages
const MAX_TEXT = 12_000; // cap extracted text fed to the model

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

// A handful of known interstitial/login-gate phrases — a page that returns
// 200 OK but is actually a bot-wall or "please sign in" screen (LinkedIn,
// Google's blocked-request page, etc.) reads as a real successful fetch with
// no signal that the content is fake. Not exhaustive; a low-confidence flag
// beats silently feeding the model a gate page as if it were real content.
const GATE_PHRASES = [
  'agree & join linkedin',
  "if you're having trouble accessing",
  'sign in to continue',
  'please verify you are a human',
  'enable javascript to continue',
];

function looksBlocked(text: string): boolean {
  const lower = text.toLowerCase();
  return text.length < 400 || GATE_PHRASES.some((p) => lower.includes(p));
}

// Boilerplate-aware extraction (2026-08-19).
//
// The previous version stripped only script/style/noscript/svg/head, so the text
// began with the site's navigation. That was not cosmetic: research.ts feeds the
// model the FIRST 3,000 characters of this output, so for
// https://en.wikipedia.org/wiki/PostgreSQL the model received "Jump to content |
// Main menu | Navigation | Main page | Contents | Random article | About
// Wikipedia | Contact us …" and not one sentence about PostgreSQL — while the run
// still reported success. Measured on that exact URL.
//
// Three passes, cheapest first, no dependency:
//   1. Drop layout containers outright.
//   2. If the page marks its content with <main>/<article>, keep only that — the
//      highest-signal hint a page can give, and most real sites give it.
//   3. Score what remains and drop link-menu blocks, for the sites that mark up
//      nothing. Navigation is many short fragments with almost no sentence
//      punctuation; prose is the opposite.
const LAYOUT_TAGS = 'script|style|noscript|svg|head|nav|header|footer|aside|form|button|select|dialog|iframe|template';
const LAYOUT_RE = new RegExp(`<(${LAYOUT_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');

/** Keep the innermost <main>/<article> when present — on Wikipedia this alone
 *  removes the sidebar, the interwiki language list and the edit chrome. */
function mainContent(html: string): string {
  for (const tag of ['article', 'main']) {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html);
    // Guard against a tiny decorative <article> (a teaser card) beating the real
    // body: only take it when it holds a meaningful share of the page.
    if (m?.[1] && m[1].length > html.length * 0.15) return m[1];
  }
  return html;
}

/** Navigation rather than content? Link menus are many short lines with no
 *  sentence enders; prose has long lines that end in punctuation. */
function isBoilerplate(block: string): boolean {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return true;
  const shortRatio = lines.filter((l) => l.length < 40).length / lines.length;
  const sentences = (block.match(/[.!?]["')\]]?(\s|$)/g) ?? []).length;
  const words = block.split(/\s+/).length;
  return shortRatio > 0.75 && sentences < Math.max(2, words / 120);
}

function extract(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '');
  const body = mainContent(html.replace(LAYOUT_RE, ' '));
  const flat = decodeEntities(
    body
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
  // Never return nothing: a page that is genuinely all short lines (a link
  // directory, a table) is still worth more than an empty string, so fall back
  // to the unfiltered text rather than reporting a blank page.
  const kept = flat
    .split(/\n{2,}/)
    .filter((b) => !isBoilerplate(b))
    .join('\n\n')
    .trim();
  return { title, text: kept.length > 200 ? kept : flat };
}

export const fetchUrl: ToolDef = {
  name: 'fetch_url',
  untrustedOutput: true,
  description: 'Fetch a web page by URL and return its title and readable text (HTML stripped). Use after web_search to read a result in full.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Absolute http(s) URL to fetch' } },
    required: ['url'],
  },
  async execute(args) {
    const url = String(args.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('url must be an absolute http(s) URL');
    // Validates the resolved IP + every redirect hop, not just the scheme
    // (2026-08-12 variant-analysis hunt — same root cause as http_get/http_send).
    const res = await ssrfSafeFetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        // A strict-content-negotiation API (confirmed: GitHub's) 415s on an
        // accept header that doesn't include its own shape — broaden this to
        // a normal browser-like header instead of html-only.
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
      },
      // Bounds the worst case a hanging/slow-to-respond host can cost against
      // the executor's 12-iteration budget (was 20s; fetch() has no separate
      // connect-vs-read phase timeout to shrink just the connect side).
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`fetch_url ${res.status} for ${url}`);
    const ctype = res.headers.get('content-type') ?? '';
    // res.url is the URL AFTER following redirects — the input `url` is what
    // was requested, not necessarily what was actually fetched.
    const finalUrl = res.url || url;
    const body = (await res.text()).slice(0, MAX_BYTES);
    if (/application\/(json|xml)|text\/plain/.test(ctype) && !/text\/html/.test(ctype)) {
      return { url: finalUrl, title: finalUrl, text: body.slice(0, MAX_TEXT) };
    }
    const { title, text } = extract(body);
    const clipped = text.slice(0, MAX_TEXT);
    return {
      url: finalUrl,
      title: title || finalUrl,
      text: clipped,
      truncated: text.length > MAX_TEXT,
      likelyBlocked: looksBlocked(text) || undefined,
    };
  },
};
