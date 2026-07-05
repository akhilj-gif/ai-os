// fetch_url — retrieve a web page and extract readable text. Self-contained
// (own HTTP + HTML→text), like web_search, so the OS never depends on a host's
// MCP server. Output is UNTRUSTED external content (§8.3) — the trust gate blocks
// mutations once it's in context.
import type { ToolDef } from '../registry.js';

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
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`fetch_url ${res.status} for ${url}`);
    const ctype = res.headers.get('content-type') ?? '';
    const body = (await res.text()).slice(0, MAX_BYTES);
    if (/application\/(json|xml)|text\/plain/.test(ctype) && !/text\/html/.test(ctype)) {
      return { url, title: url, text: body.slice(0, MAX_TEXT) };
    }
    const { title, text } = extract(body);
    return { url, title: title || url, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
  },
};
