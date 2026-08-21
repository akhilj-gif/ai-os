// web_search — thin ToolDef over the provider chain in ../search.ts.
//
// The chain (Brave API -> Tavily -> DuckDuckGo -> Wikipedia) with caching,
// per-provider cooldown and a relevance gate lives there; this file is only the
// tool surface. See ../search.ts for the measurements that produced that design.
import type { ToolDef } from '../registry.js';
import { searchWeb } from '../search.js';

export const webSearch: ToolDef = {
  name: 'web_search',
  untrustedOutput: true, // web content is untrusted (§8.3)
  description:
    'Search the web. Returns titles, URLs and snippets for the top results. Tries several providers in order and reports which one answered — if results look thin, the `provider` field tells you whether you got a real web index or the Wikipedia fallback.',
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
    // args.maxResults ?? — not `|| 5` — because `||` cannot tell "omitted" from
    // "explicitly 0"; both are falsy, so maxResults:0 silently became 5.
    const n = Number(args.maxResults);
    const requested = args.maxResults == null || !Number.isFinite(n) ? 5 : n;
    const max = Math.min(Math.max(requested, 1), 10);

    const out = await searchWeb(query, max);
    return {
      query: out.query,
      provider: out.provider,
      ...(out.cached ? { cached: true } : {}),
      results: out.results,
      // Surfaced so a failed-over search is visible to the model rather than
      // silently looking like a normal result set from a different index.
      ...(out.attempts.some((a) => !a.outcome.startsWith('skipped')) ? { providerNotes: out.attempts } : {}),
    };
  },
};
