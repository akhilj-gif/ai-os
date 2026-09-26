// Markets pack — database smoke. Needs Postgres; no model quota.
//   tsx packages/kernel/src/market-db-smoke.ts
//
// ISOLATION. The paper account is DERIVED from every row in paper_trades, so a
// test that wrote into the real table would silently change the owner's paper
// cash and P&L. Everything here runs in a throwaway schema (market_smoke) that
// shadows paper_trades, market_rules and jobs via search_path, and is dropped
// at the end. The production code is exercised unmodified.
//
// What is pinned is what goes wrong in trading bots specifically: a rule that
// fires twice (the runaway buy), two orders that both spend the same cash, a
// fill at a price nobody could have got, and a disabled pack that keeps trading.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import pg from 'pg';
import { ToolRegistry, marketQuote, marketRuleAdd, evaluateRules, type Quote } from '@ai-os/tools';
import { placePaperOrder } from '../../tools/src/tools/market.js';
import { marketExecutor } from './jobs.js';

const SCHEMA = 'market_smoke';
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await admin.query(`CREATE SCHEMA ${SCHEMA}`);
for (const t of ['paper_trades', 'market_rules', 'jobs']) {
  await admin.query(`CREATE TABLE ${SCHEMA}.${t} (LIKE public.${t} INCLUDING ALL)`);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${SCHEMA},public` });

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const q = (price: number, o: { open?: boolean; currency?: string; symbol?: string } = {}): Quote => ({
  symbol: o.symbol ?? 'RELIANCE.NS',
  price,
  previousClose: price,
  changePct: 0,
  dayHigh: price,
  dayLow: price,
  currency: o.currency ?? 'INR',
  exchange: 'NSE',
  quoteTime: new Date().toISOString(),
  ageSeconds: 900,
  marketOpen: o.open ?? true,
});
const count = async (sql: string): Promise<number> => Number((await pool.query<{ n: string }>(sql)).rows[0]!.n);
const err = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return '(no error — IT WENT THROUGH)';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
const reset = async (): Promise<void> => {
  await pool.query('TRUNCATE paper_trades, market_rules, jobs');
};
const rule = async (condition: string, threshold: number, action: string, qty: number | null): Promise<string> =>
  (await pool.query<{ id: string }>(`INSERT INTO market_rules (symbol, condition, threshold, action, qty) VALUES ('RELIANCE.NS',$1,$2,$3,$4) RETURNING id`, [condition, threshold, action, qty])).rows[0]!.id;
// A weekday inside NSE hours, so the session pre-filter lets the loop run.
const MARKET_TIME = new Date(Date.UTC(2026, 8, 25, 5, 0)); // Fri 10:30 IST

try {
  console.log('— paper orders —');
  await reset();
  const f = await placePaperOrder(pool, { symbol: 'RELIANCE', side: 'buy', qty: 10 }, async () => q(1226));
  check('a buy fills at the quoted price', f.filled.price === 1226 && f.filled.value === 12260, JSON.stringify(f.filled));
  check('...cash drops by exactly the cost', f.cash === 100000 - 12260, String(f.cash));
  check('...and it is labelled paper', f.paper === true);
  check('one trade row was written', (await count('SELECT count(*) n FROM paper_trades')) === 1);

  const over = await err(() => placePaperOrder(pool, { symbol: 'RELIANCE', side: 'buy', qty: 1000 }, async () => q(1226)));
  check('an order larger than the cash is refused', /not enough paper cash/.test(over), over.slice(0, 70));
  check('...and writes NOTHING', (await count('SELECT count(*) n FROM paper_trades')) === 1);

  const closed = await err(() => placePaperOrder(pool, { symbol: 'RELIANCE', side: 'buy', qty: 1 }, async () => q(1226, { open: false })));
  // A Sunday fill at Friday's close is a price nobody could have got.
  check('a closed-market fill is refused rather than faked', /market is closed/.test(closed), closed.slice(0, 60));
  const usd = await err(() => placePaperOrder(pool, { symbol: 'AAPL', side: 'buy', qty: 1 }, async () => q(200, { currency: 'USD', symbol: 'AAPL' })));
  check('a USD stock cannot be bought with INR paper cash', /INR/.test(usd), usd.slice(0, 60));

  console.log('\n— two orders racing for the same cash —');
  await reset();
  // Each alone is affordable (60,000 of 1,00,000); together they are not.
  const race = await Promise.allSettled([
    placePaperOrder(pool, { symbol: 'RELIANCE', side: 'buy', qty: 50 }, async () => q(1200)),
    placePaperOrder(pool, { symbol: 'RELIANCE', side: 'buy', qty: 50 }, async () => q(1200)),
  ]);
  const filled = race.filter((r) => r.status === 'fulfilled').length;
  check('exactly ONE of two racing orders fills', filled === 1, `${filled} filled`);
  check('...so the cash can never go negative', (await count(`SELECT count(*) n FROM paper_trades`)) === 1);

  console.log('\n— standing rules —');
  await reset();
  const stop = await rule('below', 1200, 'alert', null);
  const r1 = await evaluateRules(pool, { now: MARKET_TIME, quoteFn: async () => q(1190) });
  check('a triggered rule fires', r1.fired.length === 1 && r1.fired[0]!.id === stop, r1.summary);
  const r2 = await evaluateRules(pool, { now: MARKET_TIME, quoteFn: async () => q(1180) });
  // THE RUNAWAY-BUY BUG: without one-shot, a "buy below X" rule buys again on
  // every 5-minute tick for as long as the price stays below X.
  check('...and does NOT fire again on the next tick', r2.fired.length === 0, r2.summary);

  await reset();
  await pool.query(`INSERT INTO paper_trades (symbol, side, qty, price, quote_time) VALUES ('RELIANCE.NS','buy',10,1300, now())`);
  await rule('below', 1200, 'sell', 10);
  // Two overlapping ticks (a slow tick and the next one) must not both sell.
  const both = await Promise.all([
    evaluateRules(pool, { now: MARKET_TIME, quoteFn: async () => q(1150) }),
    evaluateRules(pool, { now: MARKET_TIME, quoteFn: async () => q(1150) }),
  ]);
  check('two overlapping ticks fire a rule exactly once', both.reduce((a, r) => a + r.fired.length, 0) === 1);
  check('...producing exactly one sell', (await count(`SELECT count(*) n FROM paper_trades WHERE side='sell'`)) === 1);
  const sold = both.flatMap((r) => r.fired)[0]?.result ?? '';
  check('...and the notification states the loss honestly', /P&L -/.test(sold) && /PAPER SELL/.test(sold), sold.slice(0, 90));

  await reset();
  const tooBig = await rule('below', 1300, 'buy', 500);
  const r3 = await evaluateRules(pool, { now: MARKET_TIME, quoteFn: async () => q(1250) });
  check('an unaffordable rule is consumed, not retried every 5 minutes', r3.fired.length === 1, r3.summary);
  const res3 = (await pool.query<{ result: string; enabled: boolean }>(`SELECT result, enabled FROM market_rules WHERE id=$1`, [tooBig])).rows[0]!;
  check('...and records WHY it did nothing', /failed: not enough paper cash/.test(res3.result), res3.result.slice(0, 80));
  check('...with no trade written', (await count('SELECT count(*) n FROM paper_trades')) === 0);

  await reset();
  await rule('below', 1300, 'alert', null);
  const shut = await evaluateRules(pool, { now: MARKET_TIME, quoteFn: async () => q(1250, { open: false }) });
  check('a rule does not fire on a closed-market price (holiday)', shut.fired.length === 0, shut.summary);
  let called = 0;
  const sunday = await evaluateRules(pool, { now: new Date(Date.UTC(2026, 8, 27, 6, 0)), quoteFn: async () => (called++, q(1250)) });
  check('outside NSE hours the loop does not even call the data provider', called === 0 && /outside NSE hours/.test(sunday.summary), sunday.summary);

  console.log('\n— the scheduler job —');
  const job = { id: 'j', name: 'market-rules', kind: 'market', schedule: { kind: 'interval', minutes: 5 }, payload: {}, state: {} } as never;
  const off = await marketExecutor(pool, job, { runId: 'r', traceId: 't', now: MARKET_TIME, registry: new ToolRegistry() });
  // Disabling the pack must actually stop trading, not just hide the tools
  // while leftover rules keep executing in the background.
  check('with the markets pack DISABLED, the job evaluates nothing', /disabled/.test(off.summary), off.summary);
  check('...and the pending rule is untouched', (await count(`SELECT count(*) n FROM market_rules WHERE enabled AND fired_at IS NULL`)) === 1);

  console.log('\n— adding a rule through the real tool (live Yahoo) —');
  await reset();
  const ctx = { pool, taskId: '00000000-0000-0000-0000-000000000000', untrusted: false };
  const added = (await Promise.all([
    marketRuleAdd.execute({ symbol: 'RELIANCE', condition: 'below', price: 1, action: 'alert' }, ctx),
    marketRuleAdd.execute({ symbol: 'TCS', condition: 'above', price: 1, action: 'alert' }, ctx),
  ])) as Array<{ added: { symbol: string }; notes?: string[] }>;
  check('the ticker is resolved to its canonical NSE symbol', added[0]!.added.symbol === 'RELIANCE.NS', added[0]!.added.symbol);
  check('two concurrent adds create exactly ONE checking job', (await count(`SELECT count(*) n FROM jobs WHERE kind='market'`)) === 1);
  check('a rule that would fire immediately says so', (added[1]!.notes ?? []).some((n) => /ALREADY above/.test(n)), JSON.stringify(added[1]!.notes));
  const typo = await err(() => marketRuleAdd.execute({ symbol: 'RELIANCEE', condition: 'below', price: 1000, action: 'alert' }, ctx));
  check('a mistyped ticker is rejected now, not after days of silence', /no market data/.test(typo), typo.slice(0, 60));
  const noQty = await err(() => marketRuleAdd.execute({ symbol: 'RELIANCE', condition: 'below', price: 1000, action: 'buy' }, ctx));
  check('a buy rule without a quantity is refused', /qty/.test(noQty), noQty.slice(0, 60));
  const live = (await marketQuote.execute({ symbol: 'RELIANCE' }, ctx)) as Quote & { freshness: string };
  check('the live quote states its own age', typeof live.freshness === 'string' && live.freshness.length > 10, live.freshness);
} finally {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
