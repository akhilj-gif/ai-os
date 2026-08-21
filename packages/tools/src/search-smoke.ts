// Search relevance-gate smoke — deterministic, no network, no DB.
// Run: tsx packages/tools/src/search-smoke.ts
//
// WHY THIS GATE EXISTS, in one measured example. On 2026-08-19 Bing's RSS
// endpoint was evaluated as a fallback provider. It never blocked and returned a
// full ten results for every query — which is exactly what a good provider looks
// like from the outside. But it only honours the FIRST WORD: given "best
// typescript testing framework" it returned ten dictionary entries for the word
// "best" (Merriam-Webster, Cambridge, Best Buy).
//
// A provider that fails is harmless — the chain moves on. A provider that
// returns confident, well-formed, WRONG results is not: the research pipeline
// synthesises from it and cites it, so the OS produces a sourced answer built
// entirely on definitions of the word "best". That is the failure this gate
// exists to prevent, and these cases pin it.
import { looksRelevant, type SearchResult } from './search.js';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

const r = (title: string, url = 'https://example.com/x', snippet = ''): SearchResult => ({ title, url, snippet, source: 'test' });

// --- the real failure, verbatim from the Bing RSS response ------------------
const BING_GARBAGE = [
  r('BEST Definition & Meaning - Merriam-Webster', 'https://www.merriam-webster.com/dictionary/best', 'superlative of good'),
  r('BEST | English meaning - Cambridge Dictionary', 'https://dictionary.cambridge.org/dictionary/english/', 'of the highest quality'),
  r('Best Buy | Official Online Store', 'https://www.bestbuy.com/', 'shop now and save'),
  r('Best - definition of best by The Free Dictionary', 'https://www.thefreedictionary.com/best', ''),
];
check('REJECTS the measured Bing first-word-only garbage', !looksRelevant('best typescript testing framework', BING_GARBAGE));

// --- and must not reject legitimate answers ---------------------------------
check(
  'accepts genuine results for the same query',
  looksRelevant('best typescript testing framework', [
    r('Jest vs Vitest: choosing a TypeScript testing framework', 'https://dev.to/x', 'comparing test runners'),
    r('Vitest | Next Generation Testing Framework', 'https://vitest.dev', 'vite-native'),
  ]),
);

// Relevance may live in the URL or snippet, not only the title — a gate that
// only read titles would reject plenty of real results.
check(
  'matches on url when the title is unhelpful',
  looksRelevant('pgvector hnsw tuning', [r('GitHub - pgvector/pgvector', 'https://github.com/pgvector/pgvector', 'open-source vector similarity')]),
);
check(
  'matches on snippet when the title is unhelpful',
  looksRelevant('econnrefused postgres', [r('Stack Overflow', 'https://stackoverflow.com/q/1', 'getting ECONNREFUSED connecting to postgres')]),
);

// --- must not be trigger-happy ---------------------------------------------
// A gate that is too strict is worse than none: it would discard a working
// provider and push the chain onto a weaker one.
check('a partially-relevant set still passes (30% threshold)', looksRelevant('playwright wait for selector', [
  r('Page | Playwright', 'https://playwright.dev/docs/api/class-page', 'waitForSelector'),
  r('Unrelated blog post about cooking', 'https://food.example/x', 'recipes'),
  r('Another unrelated page', 'https://misc.example/y', 'nothing to do with it'),
]));
check('query of only stop-words cannot be judged, so it passes', looksRelevant('how do i', [r('Anything at all')]));
check('empty result set passes (nothing to judge)', looksRelevant('typescript', []));

// Stop-words must not count as a match, or the gate never fires: the Bing case
// above shares "best" with the query and nothing else.
check('a shared stop-word alone does not count as relevance', !looksRelevant('best python web framework', [
  r('BEST Definition & Meaning', 'https://merriam-webster.com/dictionary/best', 'superlative'),
  r('Best Buy', 'https://bestbuy.com', 'store'),
]));

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
