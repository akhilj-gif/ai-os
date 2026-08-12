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

function extract(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '');
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
  return { title, text };
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
