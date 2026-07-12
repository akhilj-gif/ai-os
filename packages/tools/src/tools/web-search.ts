// Web search via DuckDuckGo Lite HTML (keyless). Fragile by nature — a proper
// search API (Brave/Tavily) is a drop-in swap recorded in ADR-0004.
import type { ToolDef } from '../registry.js';

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).trim();
}

/** DDG wraps result links as //duckduckgo.com/l/?uddg=<encoded-url>&... */
function unwrapUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) return decodeURIComponent(m[1]!);
  return href.startsWith('//') ? `https:${href}` : href;
}

// DuckDuckGo Lite's anti-bot layer answers with an HTTP 200 anomaly/CAPTCHA
// page instead of a 429/503 — res.ok is true, but there are zero real results
// to parse. Detecting this distinctly matters: the old behavior threw the
// same generic "no parseable results" for a genuinely-empty query AND for
// "we got blocked", so a retrying model just hammered the same wall instead
// of getting a signal to back off. Live-confirmed 2026-07-12: as few as 1-2
// requests can trigger this (ADR-0004 already anticipated needing a paid
// fallback like Brave/Tavily if this got worse — that's a bigger, separate
// change, not attempted here).
function isBlockPage(html: string): boolean {
  return /anomaly-modal|Select all squares containing|complete the following challenge/i.test(html);
}

export const webSearch: ToolDef = {
  name: 'web_search',
  untrustedOutput: true, // web content is untrusted (§8.3)
  description: 'Search the web. Returns titles, URLs and snippets for the top results.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      maxResults: { type: 'number', description: 'Max results (1-10). Default 5.' },
    },
    required: ['query'],
  },
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) throw new Error('query is required');
    // args.maxResults ?? — not `|| 5` — because `|| ` can't tell "omitted"
    // from "explicitly 0"; both are falsy, so maxResults:0 silently became 5.
    const requested = args.maxResults == null ? 5 : Number(args.maxResults);
    const max = Math.min(Math.max(requested, 1), 10);

    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`web search failed: HTTP ${res.status}`);
    const html = await res.text();
    if (isBlockPage(html)) {
      throw new Error(
        'web search is currently rate-limited/challenged by DuckDuckGo (not a "no results" case) — wait before retrying the same query; retrying immediately will hit the same block',
      );
    }

    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const linkRe = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<td class="result-snippet">([\s\S]*?)<\/td>/g;
    const snippets = [...html.matchAll(snippetRe)].map((m) => stripTags(m[1]!));
    let i = 0;
    for (const m of html.matchAll(linkRe)) {
      const url = unwrapUrl(m[1]!);
      const title = stripTags(m[2]!);
      if (!title || url.includes('duckduckgo.com/y.js')) continue;
      results.push({ title, url, snippet: snippets[i] ?? '' });
      i++;
      if (results.length >= max) break;
    }
    if (!results.length) throw new Error('web search returned no parseable results');
    return { query, results };
  },
};
