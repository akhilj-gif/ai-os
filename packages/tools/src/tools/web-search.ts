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

export const webSearch: ToolDef = {
  name: 'web_search',
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
    const max = Math.min(Math.max(Number(args.maxResults) || 5, 1), 10);

    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`web search failed: HTTP ${res.status}`);
    const html = await res.text();

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
