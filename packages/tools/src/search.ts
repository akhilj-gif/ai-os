// Web search backend — a provider chain with caching, per-provider cooldown, and
// a relevance gate.
//
// WHY THIS REPLACED A SINGLE SCRAPER. web_search used to be one DuckDuckGo Lite
// HTML scrape. Measured 2026-08-19 from this machine:
//
//   ddg-lite / ddg-html   works for ~2 consecutive queries, then HTTP 202 with an
//                         anomaly page. The THIRD query in a row failed.
//   bing (format=rss)     never blocks, but only honours the FIRST WORD: "best
//                         typescript testing framework" returned ten dictionary
//                         entries for "best". Unusable, and dangerous precisely
//                         because it looks like it worked.
//   mojeek                Captcha page from this IP.
//   brave (html scrape)   HTTP 429.
//   searxng (5 public)    429, 403, empty, or connection failure.
//   wikipedia API         works, clean JSON, but encyclopedic only.
//
// So "add more scrapers" is not a fix — there are none that work. The honest
// architecture is: use a real search API when a key exists (both options below
// have free tiers that comfortably cover personal use), fall back to the keyless
// scraper, and be explicit when the fallback is exhausted rather than pretending.
//
// Three things exist here that a naive chain would not have:
//
//   CACHE.     Repeat queries are what trigger the blocking in the first place —
//              a research run that searches, reads, then re-searches something
//              similar burns the budget on duplicates. A short TTL removes that
//              entirely and costs nothing.
//   COOLDOWN.  A provider that just returned a block page will return one again
//              in ten seconds. Marking it down for a few minutes means the chain
//              spends its attempts on providers that might actually answer,
//              instead of walking into the same wall every call.
//   QUALITY GATE. Bing RSS is the reason. A provider that returns ten confident,
//              well-formed, WRONG results is worse than one that errors, because
//              the research pipeline will happily synthesise from it and cite it.
//              Results whose titles have no lexical overlap with the query are
//              treated as a provider failure and the chain moves on.
import { ssrfSafeFetch } from '@ai-os/shared';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Which provider produced this — surfaced so a synthesis step can weigh a
   *  Wikipedia fallback differently from a real web index. */
  source: string;
}

export interface SearchOutcome {
  query: string;
  results: SearchResult[];
  provider: string;
  cached?: boolean;
  /** Providers that were tried and why they were skipped or failed. Returned to
   *  the model so a failure is diagnosable instead of a bare "no results". */
  attempts: Array<{ provider: string; outcome: string }>;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CACHE_TTL_MS = 10 * 60_000;
const COOLDOWN_MS = 5 * 60_000;
const CACHE_MAX = 200;

const cache = new Map<string, { at: number; outcome: SearchOutcome }>();
const cooldown = new Map<string, number>();

/** Thrown when a provider is alive but refusing us — distinct from "no results",
 *  because the caller should switch provider rather than rephrase the query. */
class ProviderBlocked extends Error {}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]+>/g, '')).trim();

/** Content words of the query, for the relevance gate. Short words are dropped:
 *  "the", "in", "of" match everything and would let a degenerate provider pass. */
function contentWords(q: string): string[] {
  const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'is', 'are', 'how', 'what', 'best', 'top', 'my', 'me', 'i', 'with', 'from', 'by', 'at', 'do', 'does', 'can']);
  return q
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Does this result set actually answer THIS query, or is the provider matching
 *  on one token and returning confident nonsense? Bing RSS returned ten
 *  dictionary entries for "best" given "best typescript testing framework"; the
 *  titles shared exactly one stop-word with the query. Requiring that a
 *  reasonable share of results touch a CONTENT word of the query catches that
 *  class without rejecting legitimately-phrased results.
 *
 *  Deliberately lenient: a single-content-word query, or a query whose answer
 *  legitimately uses synonyms, must still pass — this gate exists to catch
 *  garbage, not to second-guess a real index. */
export function looksRelevant(query: string, results: SearchResult[]): boolean {
  const words = contentWords(query);
  if (words.length === 0 || results.length === 0) return true; // nothing to judge against
  const hits = results.filter((r) => {
    // TOKENS, not substrings. A raw `hay.includes(w)` matches inside unrelated
    // words and silently defeats the gate: the query "best python web framework"
    // scored "BEST Definition — merriam-webster.com" as relevant, because "web"
    // is a substring of "webster". Found by this file's own smoke test.
    const hay = new Set(`${r.title} ${r.snippet} ${r.url}`.toLowerCase().split(/[^a-z0-9+#.]+/));
    return words.some((w) => hay.has(w));
  }).length;
  return hits / results.length >= 0.3;
}

// ---------------------------------------------------------------------------
// Providers. Each throws ProviderBlocked when refused, or returns [] for a
// genuine no-results.
// ---------------------------------------------------------------------------

/** Brave Search API — free tier is 2,000 queries/month, which is far beyond
 *  personal use. This is the recommended primary. */
async function braveApi(query: string, max: number): Promise<SearchResult[]> {
  const key = (process.env.BRAVE_SEARCH_API_KEY ?? '').trim();
  if (!key) throw new Error('no key');
  const res = await ssrfSafeFetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 429) throw new ProviderBlocked('rate limited (free tier is 2k/month, ~1/sec)');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (body.web?.results ?? []).slice(0, max).map((r) => ({
    title: stripTags(r.title ?? ''),
    url: r.url ?? '',
    snippet: stripTags(r.description ?? ''),
    source: 'brave',
  }));
}

/** Tavily — built for AI research: it returns cleaned content, not just links,
 *  which saves a fetch per result. Free tier is 1,000 credits/month. */
async function tavily(query: string, max: number): Promise<SearchResult[]> {
  const key = (process.env.TAVILY_API_KEY ?? '').trim();
  if (!key) throw new Error('no key');
  const res = await ssrfSafeFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: max, search_depth: 'basic' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) throw new ProviderBlocked('rate limited');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (body.results ?? []).slice(0, max).map((r) => ({
    title: stripTags(r.title ?? ''),
    url: r.url ?? '',
    // Tavily's `content` is extracted page text, so snippets are substantially
    // richer than a search-engine description.
    snippet: stripTags(r.content ?? '').slice(0, 500),
    source: 'tavily',
  }));
}

/** DuckDuckGo Lite — keyless, and the only scraper measured to work at all. It
 *  answers with HTTP 202 + an anomaly page rather than a 429 when it decides to
 *  block, so the status code alone is not enough to detect refusal. */
async function ddgLite(query: string, max: number): Promise<SearchResult[]> {
  const res = await ssrfSafeFetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(12_000),
  });
  const html = await res.text();
  if (res.status === 202 || /anomaly-modal|Select all squares containing|complete the following challenge/i.test(html)) {
    throw new ProviderBlocked('anti-bot challenge (DDG answers 202, not 429)');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const snippets = [...html.matchAll(/<td class="result-snippet">([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]!));
  const out: SearchResult[] = [];
  for (const m of html.matchAll(/<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const raw = m[1]!;
    // DDG wraps results as //duckduckgo.com/l/?uddg=<encoded>
    const wrapped = raw.match(/[?&]uddg=([^&]+)/);
    const url = wrapped ? decodeURIComponent(wrapped[1]!) : raw.startsWith('//') ? `https:${raw}` : raw;
    const title = stripTags(m[2]!);
    if (!title || url.includes('duckduckgo.com/y.js')) continue;
    out.push({ title, url, snippet: snippets[out.length] ?? '', source: 'duckduckgo' });
    if (out.length >= max) break;
  }
  return out;
}

/** Wikipedia — always available and never blocked, but encyclopedic only. Last
 *  in the chain so a factual question still gets an answer when every web index
 *  has refused; the relevance gate discards it when the query is not the kind of
 *  thing Wikipedia knows. */
async function wikipedia(query: string, max: number): Promise<SearchResult[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${max}`;
  const res = await ssrfSafeFetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { query?: { search?: Array<{ title: string; snippet: string }> } };
  return (body.query?.search ?? []).map((r) => ({
    title: r.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: stripTags(r.snippet),
    source: 'wikipedia',
  }));
}

const PROVIDERS: Array<{ name: string; fn: (q: string, max: number) => Promise<SearchResult[]>; needsKey?: string }> = [
  { name: 'brave', fn: braveApi, needsKey: 'BRAVE_SEARCH_API_KEY' },
  { name: 'tavily', fn: tavily, needsKey: 'TAVILY_API_KEY' },
  { name: 'duckduckgo', fn: ddgLite },
  { name: 'wikipedia', fn: wikipedia },
];

/** True when at least one keyed provider is configured — used to tell the user
 *  that the keyless path is a known-fragile fallback, not the intended setup. */
export function hasKeyedProvider(): boolean {
  return PROVIDERS.some((p) => p.needsKey && (process.env[p.needsKey] ?? '').trim());
}

export async function searchWeb(query: string, max = 5): Promise<SearchOutcome> {
  const key = `${query.toLowerCase().trim()}::${max}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.outcome, cached: true };

  const attempts: SearchOutcome['attempts'] = [];
  for (const p of PROVIDERS) {
    if (p.needsKey && !(process.env[p.needsKey] ?? '').trim()) {
      attempts.push({ provider: p.name, outcome: `skipped: ${p.needsKey} not set` });
      continue;
    }
    const until = cooldown.get(p.name) ?? 0;
    if (Date.now() < until) {
      attempts.push({ provider: p.name, outcome: `skipped: cooling down for ${Math.ceil((until - Date.now()) / 1000)}s` });
      continue;
    }
    try {
      const results = await p.fn(query, max);
      if (!results.length) {
        attempts.push({ provider: p.name, outcome: 'no results' });
        continue;
      }
      if (!looksRelevant(query, results)) {
        // Treated as a provider fault, not a query fault: a provider that
        // answers the wrong question will keep doing it, so cool it down too.
        cooldown.set(p.name, Date.now() + COOLDOWN_MS);
        attempts.push({ provider: p.name, outcome: `rejected: results do not match the query (returned "${results[0]!.title.slice(0, 40)}")` });
        continue;
      }
      const outcome: SearchOutcome = { query, results, provider: p.name, attempts };
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: Date.now(), outcome });
      return outcome;
    } catch (err) {
      const blocked = err instanceof ProviderBlocked;
      if (blocked) cooldown.set(p.name, Date.now() + COOLDOWN_MS);
      attempts.push({ provider: p.name, outcome: `${blocked ? 'blocked' : 'error'}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Everything failed. The message names the actual fix rather than leaving the
  // model to guess — without a key the keyless scraper blocks after ~2 queries,
  // and that is a configuration problem, not something a retry solves.
  const advice = hasKeyedProvider()
    ? 'All configured search providers refused. Wait a few minutes and retry.'
    : 'No search API key is configured, so the OS is relying on keyless scraping, which blocks after roughly two consecutive queries. Set BRAVE_SEARCH_API_KEY (free tier: 2,000 queries/month) or TAVILY_API_KEY in .env for reliable search.';
  throw new Error(`${advice}\nTried: ${attempts.map((a) => `${a.provider} (${a.outcome})`).join('; ')}`);
}

/** Test seam — the smoke needs a clean slate between cases. */
export function _resetSearchState(): void {
  cache.clear();
  cooldown.clear();
}
