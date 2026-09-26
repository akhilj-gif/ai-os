// Markets pack — live prices, a paper-trading account, and standing rules that
// run on their own.
//
// PAPER ONLY, BY DESIGN. No broker is connected and no code path here can move
// real money: an order is a row in paper_trades, filled at a quoted price. The
// owner chose "paper first, live later" (2026-09-27) and has no broker account
// yet. placePaperOrder() is the one function a real broker adapter would
// replace — deliberately not abstracted behind an interface until one exists,
// because the shape of a real adapter (auth, order ids, partial fills,
// rejections) is not knowable from here and a guessed interface would be wrong.
//
// THE LOOP IS CODE, NOT A MODEL. Standing rules ("sell if it falls below X")
// are evaluated by evaluateRules(), deterministically, on a scheduler tick. No
// model call happens between a price moving and a rule acting on it. That is
// not a style choice: measured on the live DB, 85% of this OS's failed steps
// were transient model-provider errors (429s, timeouts). A bot that needs the
// rate-limited provider in order to decide whether to execute a stop-loss is a
// bot that cannot execute a stop-loss. The model's job is the language part —
// turning "buy 5 Reliance if it drops to 1200" into a structured rule.
//
// PRICES ARE DELAYED, AND THIS MODULE SAYS SO. Yahoo's free NSE feed runs about
// 15 minutes behind: measured 2026-09-27, Friday's session closed at 15:30 but
// the last populated one-minute candle was 15:14 and regularMarketTime read
// 15:14:59. Every quote therefore carries its own quoteTime and ageSeconds, and
// every user-facing result states the price's age. That makes this fit for
// alerts and daily/swing rules and NOT for intraday scalping, where paper P&L
// on 15-minute-old prices would be fiction. Real-time needs a broker websocket.
//
// NOT INVESTMENT ADVICE. The pack prompt forbids recommending trades or
// predicting prices; the tools execute the user's own instructions.
import type pg from 'pg';
import type { ToolDef, ToolContext } from '../registry.js';

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
/** Starting paper capital, in INR. */
export const PAPER_CAPITAL = 100_000;
const MAX_QTY = 1_000_000;
/** How often the scheduler re-checks standing rules. */
export const RULE_CHECK_MINUTES = 5;

export interface Quote {
  symbol: string;
  price: number;
  previousClose: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  currency: string;
  exchange: string;
  /** When this price was actually traded — NOT when we fetched it. */
  quoteTime: string;
  ageSeconds: number;
  marketOpen: boolean;
}
export type QuoteFn = (symbol: string) => Promise<Quote>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round2 = (n: number): number => Math.round(n * 100) / 100;
/** ₹1,00,000.00 — Indian digit grouping, because that is how the owner reads
 *  money. The sign goes BEFORE the symbol: toLocaleString puts it on the number,
 *  so prefixing ₹ naively rendered a loss as "₹-1,500.00" (caught by
 *  market-db-smoke), which is the one place a number must read unambiguously. */
export const inr = (n: number): string =>
  `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const ist = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Candidate Yahoo symbols for what the user typed. A bare ticker tries NSE
 *  first (this OS's owner is in India) and then the plain symbol, so "AAPL"
 *  still resolves. An explicit suffix (.NS, .BO) or index (^NSEI) is used as-is. */
export function symbolCandidates(raw: unknown): string[] {
  const s = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) throw new Error('a ticker symbol is required, e.g. RELIANCE, TCS or INFY');
  if (!/^\^?[A-Z0-9&.-]{1,20}$/.test(s)) throw new Error(`"${String(raw)}" is not a valid ticker symbol`);
  if (s.includes('.') || s.startsWith('^')) return [s];
  return [`${s}.NS`, s];
}

export const isIndianSymbol = (s: string): boolean => /\.(NS|BO)$/.test(s) || s === '^NSEI' || s === '^BSESN';

/** A cheap pre-filter so the rule loop does not call Yahoo all weekend. It is
 *  only a filter — the quote's own trading period is the arbiter, which is what
 *  handles exchange holidays this function knows nothing about. The window is
 *  a few minutes wider than 09:15–15:30 on purpose. */
export function withinIndianSession(now: Date): boolean {
  const t = new Date(now.getTime() + 330 * 60_000); // IST = UTC+05:30, no DST
  const day = t.getUTCDay();
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 10 && mins <= 15 * 60 + 35;
}

/** Build a Quote from Yahoo's chart meta. Returns null when there is no usable
 *  price. ONLY numbers and whitelisted short codes are copied out — no free
 *  text (Yahoo's longName and friends are dropped). That is what makes it
 *  sound to mark market_quote untrustedOutput:false: there is no third-party
 *  prose in the result for an injection to live in, and marking it untrusted
 *  would make §8.3 refuse the obvious "check the price, then paper-buy" flow. */
export function quoteFromMeta(meta: Record<string, unknown>, fallbackSymbol: string, now: Date): Quote | null {
  const price = num(meta.regularMarketPrice);
  if (price === null || price <= 0) return null;
  const traded = num(meta.regularMarketTime);
  const reg = (meta.currentTradingPeriod as { regular?: { start?: unknown; end?: unknown } } | undefined)?.regular;
  const start = num(reg?.start);
  const end = num(reg?.end);
  const nowS = now.getTime() / 1000;
  const prev = num(meta.previousClose) ?? num(meta.chartPreviousClose);
  const sym = typeof meta.symbol === 'string' && /^\^?[A-Z0-9&.-]{1,20}$/.test(meta.symbol) ? meta.symbol : fallbackSymbol;
  const currency = typeof meta.currency === 'string' && /^[A-Z]{3}$/.test(meta.currency) ? meta.currency : 'UNKNOWN';
  const exchange =
    typeof meta.fullExchangeName === 'string' && /^[A-Za-z0-9 ]{1,24}$/.test(meta.fullExchangeName) ? meta.fullExchangeName : 'unknown';
  const tradedS = traded ?? nowS;
  return {
    symbol: sym,
    price: round2(price),
    previousClose: prev === null ? null : round2(prev),
    changePct: prev ? round2(((price - prev) / prev) * 100) : null,
    dayHigh: num(meta.regularMarketDayHigh),
    dayLow: num(meta.regularMarketDayLow),
    currency,
    exchange,
    quoteTime: new Date(tradedS * 1000).toISOString(),
    ageSeconds: Math.max(0, Math.round(nowS - tradedS)),
    marketOpen: start !== null && end !== null && nowS >= start && nowS < end,
  };
}

export async function fetchQuote(raw: unknown, opts: { now?: Date; fetchImpl?: typeof fetch } = {}): Promise<Quote> {
  const now = opts.now ?? new Date();
  const f = opts.fetchImpl ?? fetch;
  const candidates = symbolCandidates(raw);
  for (const sym of candidates) {
    const res = await f(`${YAHOO_CHART}${encodeURIComponent(sym)}?interval=1d&range=1d`, {
      headers: { 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) continue; // unknown on this exchange — try the next candidate
    if (!res.ok) throw new Error(`market data unavailable (Yahoo answered ${res.status} for ${sym}) — try again shortly`);
    const body = (await res.json()) as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> | null } };
    const meta = body.chart?.result?.[0]?.meta;
    const q = meta ? quoteFromMeta(meta, sym, now) : null;
    if (q) return q;
  }
  throw new Error(
    `no market data for "${String(raw)}". Indian stocks use their NSE symbol (RELIANCE, TCS, HDFCBANK, INFY); add .BO for BSE; indices are ^NSEI (Nifty 50) and ^BSESN (Sensex).`,
  );
}

/** One human sentence about how old a price is. Shown with every result. */
export function freshness(q: Quote): string {
  if (!q.marketOpen) return `Market closed — last traded price as of ${ist(q.quoteTime)}.`;
  const m = Math.round(q.ageSeconds / 60);
  return m >= 2 ? `Price is about ${m} min old (free NSE data runs ~15 min behind).` : 'Price is current.';
}

// ---------------------------------------------------------------------------
// Paper book — derived from the trade log, never stored separately, so it
// cannot drift from the trades that produced it.

export interface Trade {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
}
export interface Position {
  qty: number;
  avgCost: number;
}
export interface Book {
  cash: number;
  realized: number;
  positions: Map<string, Position>;
}

/** Replay the trade log with average-cost accounting. */
export function computeBook(trades: Trade[], capital = PAPER_CAPITAL): Book {
  let cash = capital;
  let realized = 0;
  const positions = new Map<string, Position>();
  for (const t of trades) {
    const p = positions.get(t.symbol) ?? { qty: 0, avgCost: 0 };
    if (t.side === 'buy') {
      cash -= t.qty * t.price;
      p.avgCost = (p.qty * p.avgCost + t.qty * t.price) / (p.qty + t.qty);
      p.qty += t.qty;
      positions.set(t.symbol, p);
    } else {
      cash += t.qty * t.price;
      realized += (t.price - p.avgCost) * t.qty;
      p.qty -= t.qty;
      if (p.qty <= 0) positions.delete(t.symbol);
      else positions.set(t.symbol, p);
    }
  }
  return { cash: round2(cash), realized: round2(realized), positions };
}

/** Why an order cannot be filled, or null if it can. A paper account that let
 *  you overspend or short-sell would rehearse habits the real one will refuse. */
export function checkOrder(book: Book, o: Trade): string | null {
  if (!Number.isInteger(o.qty) || o.qty < 1 || o.qty > MAX_QTY) return `quantity must be a whole number of shares from 1 to ${MAX_QTY.toLocaleString('en-IN')}`;
  if (o.side === 'buy') {
    const cost = o.qty * o.price;
    if (cost > book.cash + 0.005) return `not enough paper cash: ${o.qty} × ${inr(o.price)} = ${inr(cost)}, and the account has ${inr(book.cash)}`;
    return null;
  }
  const held = book.positions.get(o.symbol)?.qty ?? 0;
  if (o.qty > held) {
    return held
      ? `you hold only ${held} ${o.symbol}, so you cannot sell ${o.qty} (the paper account does not short-sell)`
      : `you hold no ${o.symbol} to sell (the paper account does not short-sell)`;
  }
  return null;
}

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;
async function loadTrades(db: Queryable): Promise<Trade[]> {
  const { rows } = await db.query<{ symbol: string; side: 'buy' | 'sell'; qty: number; price: string }>(
    `SELECT symbol, side, qty, price FROM paper_trades ORDER BY created_at, id`,
  );
  return rows.map((r) => ({ symbol: r.symbol, side: r.side, qty: Number(r.qty), price: Number(r.price) }));
}

export interface Fill {
  paper: true;
  filled: { symbol: string; side: 'buy' | 'sell'; qty: number; price: number; value: number };
  quoteTime: string;
  freshness: string;
  /** Profit/loss locked in by this trade (sells only). */
  realized: number | null;
  cash: number;
  position: Position | null;
}

/** Fill a paper order at the quoted price. THE ONE PLACE a real broker
 *  adapter would go. Serialised with an advisory lock so two rules firing in
 *  the same tick cannot both spend the same cash. */
export async function placePaperOrder(
  pool: pg.Pool,
  o: { symbol: unknown; side: unknown; qty: unknown; ruleId?: string | null },
  quoteFn: QuoteFn = (s) => fetchQuote(s),
): Promise<Fill> {
  const side = o.side === 'buy' || o.side === 'sell' ? o.side : null;
  if (!side) throw new Error('side must be "buy" or "sell"');
  const qty = Number(o.qty);
  const q = await quoteFn(String(o.symbol ?? ''));
  if (q.currency !== 'INR') {
    throw new Error(`the paper account is in INR and ${q.symbol} trades in ${q.currency} — you can quote it and set alerts on it, but not paper-trade it`);
  }
  // Refused rather than filled at a stale price: a Sunday fill at Friday's
  // close is a price nobody could have got, and it would make the P&L fiction.
  if (!q.marketOpen) {
    throw new Error(
      `the market is closed, so a fill now would use a price from ${ist(q.quoteTime)} that you could not actually get. Use market_rule_add instead — rules execute during market hours.`,
    );
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('ai-os:paper-book'))`);
    const trades = await loadTrades(client);
    const before = computeBook(trades);
    const order: Trade = { symbol: q.symbol, side, qty, price: q.price };
    const err = checkOrder(before, order);
    if (err) throw new Error(err);
    await client.query(`INSERT INTO paper_trades (symbol, side, qty, price, quote_time, rule_id) VALUES ($1,$2,$3,$4,$5,$6)`, [
      q.symbol,
      side,
      qty,
      q.price,
      q.quoteTime,
      o.ruleId ?? null,
    ]);
    await client.query('COMMIT');
    const after = computeBook([...trades, order]);
    const held = before.positions.get(q.symbol);
    return {
      paper: true,
      filled: { symbol: q.symbol, side, qty, price: q.price, value: round2(qty * q.price) },
      quoteTime: q.quoteTime,
      freshness: freshness(q),
      realized: side === 'sell' && held ? round2((q.price - held.avgCost) * qty) : null,
      cash: after.cash,
      position: after.positions.get(q.symbol) ?? null,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Standing rules

export type Condition = 'below' | 'above';
export const ruleTriggered = (r: { condition: Condition; threshold: number }, price: number): boolean =>
  r.condition === 'below' ? price <= r.threshold : price >= r.threshold;

export interface FiredRule {
  id: string;
  symbol: string;
  action: string;
  result: string;
}

/** The autonomous loop. Called by the scheduler's `market` job; no model is
 *  involved anywhere in it. Each rule fires ONCE and then switches itself off —
 *  a rule that re-fired every tick would keep buying on every check while the
 *  price stayed below its threshold, which is the classic runaway-bot bug. */
export async function evaluateRules(
  pool: pg.Pool,
  opts: { now?: Date; quoteFn?: QuoteFn } = {},
): Promise<{ checked: number; fired: FiredRule[]; summary: string }> {
  const now = opts.now ?? new Date();
  const { rows } = await pool.query<{ id: string; symbol: string; condition: Condition; threshold: string; action: 'buy' | 'sell' | 'alert'; qty: number | null }>(
    `SELECT id, symbol, condition, threshold, action, qty FROM market_rules WHERE enabled AND fired_at IS NULL ORDER BY created_at, id`,
  );
  if (!rows.length) return { checked: 0, fired: [], summary: 'no active rules' };

  const symbols = [...new Set(rows.map((r) => r.symbol))];
  if (symbols.every(isIndianSymbol) && !withinIndianSession(now)) {
    return { checked: 0, fired: [], summary: `outside NSE hours — ${rows.length} rule(s) waiting` };
  }
  const quoteFn = opts.quoteFn ?? ((s: string) => fetchQuote(s, { now }));
  const quotes = new Map<string, Quote | null>();
  for (const s of symbols) quotes.set(s, await quoteFn(s).catch(() => null));

  const fired: FiredRule[] = [];
  let checked = 0;
  for (const r of rows) {
    const q = quotes.get(r.symbol);
    if (!q || !q.marketOpen) continue; // never act on a closed-market price
    checked++;
    const threshold = Number(r.threshold);
    if (!ruleTriggered({ condition: r.condition, threshold }, q.price)) continue;
    // Claim BEFORE acting. The conditional UPDATE is what keeps "fires once"
    // true even if two ticks overlap: only one of them can flip the row.
    const claim = await pool.query(`UPDATE market_rules SET enabled = false, fired_at = $2 WHERE id = $1 AND enabled AND fired_at IS NULL`, [
      r.id,
      now,
    ]);
    if (!claim.rowCount) continue;
    let result: string;
    if (r.action === 'alert') {
      result = `${q.symbol} is ${inr(q.price)} — ${r.condition} your ${inr(threshold)} alert (traded ${ist(q.quoteTime)}).`;
    } else {
      try {
        // Fill at the SAME quote the rule was judged on — no second fetch, so
        // the price cannot move between "triggered" and "filled".
        const f = await placePaperOrder(pool, { symbol: r.symbol, side: r.action, qty: r.qty, ruleId: r.id }, async () => q);
        result =
          `PAPER ${r.action.toUpperCase()} ${r.qty} ${q.symbol} @ ${inr(q.price)} = ${inr(f.filled.value)}` +
          (f.realized !== null ? `, P&L ${f.realized >= 0 ? '+' : ''}${inr(f.realized)}` : '') +
          `. Paper cash now ${inr(f.cash)}.`;
      } catch (e) {
        // The rule is still consumed: retrying every 5 minutes would turn one
        // failure into a notification storm. The user sees why and can re-add it.
        result = `Rule triggered (${q.symbol} ${inr(q.price)}) but the paper ${r.action} failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    await pool.query(`UPDATE market_rules SET result = $2 WHERE id = $1`, [r.id, result]);
    fired.push({ id: r.id, symbol: q.symbol, action: r.action, result });
  }
  return { checked, fired, summary: fired.length ? `${fired.length} rule(s) fired` : `checked ${checked} rule(s), none triggered` };
}

// ---------------------------------------------------------------------------
// Tools

const PAPER_NOTE = 'PAPER TRADING — simulated account, no real money, no broker connected.';

export const marketQuote: ToolDef = {
  name: 'market_quote',
  // Numbers and whitelisted codes only — see quoteFromMeta for why this is safe.
  untrustedOutput: false,
  description:
    'Get the latest price of a stock or index. Plain tickers default to NSE (RELIANCE, TCS, INFY, HDFCBANK); add .BO for BSE; ^NSEI is Nifty 50, ^BSESN is Sensex; US tickers like AAPL also work. Free NSE data is ~15 min delayed — always tell the user the time the price is from.',
  inputSchema: {
    type: 'object',
    properties: { symbol: { type: 'string', description: 'Ticker, e.g. "RELIANCE" or "^NSEI"' } },
    required: ['symbol'],
  },
  async execute(args) {
    const q = await fetchQuote(args.symbol);
    return { ...q, freshness: freshness(q) };
  },
};

export const paperOrder: ToolDef = {
  name: 'paper_order',
  description: `${PAPER_NOTE} Buy or sell shares in the paper account at the current quoted price (market order). Starts with ${inr(PAPER_CAPITAL)}. Refused while the market is closed and when there is not enough cash or shares. INR stocks only.`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string' },
      side: { type: 'string', enum: ['buy', 'sell'] },
      qty: { type: 'integer', description: 'Number of shares (whole number)' },
    },
    required: ['symbol', 'side', 'qty'],
  },
  async execute(args, ctx: ToolContext) {
    return placePaperOrder(ctx.pool, { symbol: args.symbol, side: args.side, qty: args.qty });
  },
};

export const paperPortfolio: ToolDef = {
  name: 'paper_portfolio',
  untrustedOutput: false,
  description: `${PAPER_NOTE} Show the paper account: cash, each holding with its average cost, current value and profit/loss, and the overall return.`,
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, ctx: ToolContext) {
    const book = computeBook(await loadTrades(ctx.pool));
    const holdings = [];
    let value = 0;
    let unpriced = 0;
    for (const [symbol, p] of book.positions) {
      const q = await fetchQuote(symbol).catch(() => null);
      // Fall back to cost when a price cannot be fetched — and SAY so, rather
      // than silently reporting a zero P&L as if it were real.
      const price = q?.price ?? p.avgCost;
      if (!q) unpriced++;
      const mv = p.qty * price;
      value += mv;
      holdings.push({
        symbol,
        qty: p.qty,
        avgCost: round2(p.avgCost),
        price,
        value: round2(mv),
        pnl: round2(mv - p.qty * p.avgCost),
        pnlPct: round2(((price - p.avgCost) / p.avgCost) * 100),
        priceTime: q ? ist(q.quoteTime) : 'UNAVAILABLE — valued at cost',
      });
    }
    const equity = round2(book.cash + value);
    return {
      paper: true,
      startingCapital: PAPER_CAPITAL,
      cash: book.cash,
      holdings,
      realizedPnl: book.realized,
      equity,
      returnPct: round2(((equity - PAPER_CAPITAL) / PAPER_CAPITAL) * 100),
      ...(unpriced ? { warning: `${unpriced} holding(s) could not be priced and are shown at cost` } : {}),
    };
  },
};

export const marketRuleAdd: ToolDef = {
  name: 'market_rule_add',
  description: `${PAPER_NOTE} Create a standing rule the OS runs ON ITS OWN, checked every ${RULE_CHECK_MINUTES} min during market hours: "buy 5 RELIANCE if it drops to 1200" (below, buy), a stop-loss (below, sell), a target (above, sell), or a price alert (action alert). Each rule fires ONCE, then switches off. Use this instead of paper_order whenever the user says "if", "when" or "once" about a price.`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string' },
      condition: { type: 'string', enum: ['below', 'above'], description: 'Fire when the price is at or below / at or above `price`' },
      price: { type: 'number', description: 'Trigger price in the stock currency' },
      action: { type: 'string', enum: ['buy', 'sell', 'alert'] },
      qty: { type: 'integer', description: 'Shares to trade; required for buy/sell' },
    },
    required: ['symbol', 'condition', 'price', 'action'],
  },
  async execute(args, ctx: ToolContext) {
    const condition = args.condition === 'below' || args.condition === 'above' ? (args.condition as Condition) : null;
    if (!condition) throw new Error('condition must be "below" or "above"');
    const action = args.action === 'buy' || args.action === 'sell' || args.action === 'alert' ? args.action : null;
    if (!action) throw new Error('action must be "buy", "sell" or "alert"');
    const threshold = Number(args.price);
    if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('price must be a positive number');
    const qty = action === 'alert' ? null : Number(args.qty);
    if (qty !== null && (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY)) throw new Error('qty must be a whole number of shares for a buy or sell rule');

    // Resolving the ticker now does three jobs: it rejects a typo before it
    // sits silently for days, it stores the canonical symbol the loop will use,
    // and it lets us warn about a rule that would fire immediately.
    const q = await fetchQuote(args.symbol);
    if (action !== 'alert' && q.currency !== 'INR') {
      throw new Error(`the paper account is in INR and ${q.symbol} trades in ${q.currency} — an alert rule works, a buy/sell rule cannot`);
    }
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO market_rules (symbol, condition, threshold, action, qty) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [q.symbol, condition, threshold, action, qty],
    );
    // The loop runs as a scheduler job, created on first use so nothing polls
    // Yahoo for someone with no rules. ON CONFLICT against the partial unique
    // index (migration 0028) rather than WHERE NOT EXISTS, which two concurrent
    // adds could both pass. A job the user has DISABLED also conflicts, so it
    // stays disabled rather than being silently revived.
    await ctx.pool.query(
      `INSERT INTO jobs (name, kind, schedule, payload, enabled, next_run_at)
       VALUES ('market-rules', 'market', $1::jsonb, '{}'::jsonb, true, now())
       ON CONFLICT (kind) WHERE kind = 'market' DO NOTHING`,
      [JSON.stringify({ kind: 'interval', minutes: RULE_CHECK_MINUTES })],
    );

    const notes: string[] = [];
    if (ruleTriggered({ condition, threshold }, q.price)) {
      notes.push(
        `Heads-up: ${q.symbol} is ALREADY ${condition} ${inr(threshold)} (last ${inr(q.price)}), so this fires at the ${q.marketOpen ? `next check, within ${RULE_CHECK_MINUTES} min` : 'first check after the market opens'}.`,
      );
    }
    if (action === 'buy' && qty !== null) {
      const cash = computeBook(await loadTrades(ctx.pool)).cash;
      if (qty * threshold > cash) notes.push(`At ${inr(threshold)} this costs ${inr(qty * threshold)} but paper cash is ${inr(cash)} — it will fail unless cash frees up first.`);
    }
    return {
      paper: true,
      added: { id: rows[0]!.id, symbol: q.symbol, condition, price: threshold, action, qty },
      currentPrice: q.price,
      priceTime: ist(q.quoteTime),
      howItRuns: `Checked every ${RULE_CHECK_MINUTES} min during market hours without needing you; fires once, then switches off. You get a notification when it fires.`,
      ...(notes.length ? { notes } : {}),
    };
  },
};

export const marketRuleList: ToolDef = {
  name: 'market_rule_list',
  untrustedOutput: false,
  description: `${PAPER_NOTE} List standing market rules with their status (active, fired and what happened, or cancelled).`,
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, ctx: ToolContext) {
    const { rows } = await ctx.pool.query<{
      id: string;
      symbol: string;
      condition: string;
      threshold: string;
      action: string;
      qty: number | null;
      enabled: boolean;
      fired_at: Date | null;
      result: string | null;
    }>(`SELECT id, symbol, condition, threshold, action, qty, enabled, fired_at, result FROM market_rules ORDER BY created_at DESC LIMIT 50`);
    return {
      paper: true,
      rules: rows.map((r) => ({
        id: r.id,
        rule: `${r.action}${r.qty ? ` ${r.qty}` : ''} ${r.symbol} when ${r.condition} ${inr(Number(r.threshold))}`,
        status: r.fired_at ? 'fired' : r.enabled ? 'active' : 'cancelled',
        ...(r.fired_at ? { firedAt: ist(r.fired_at.toISOString()), result: r.result } : {}),
      })),
    };
  },
};

export const marketRuleRemove: ToolDef = {
  name: 'market_rule_remove',
  description: 'Cancel an active market rule by its id (from market_rule_list).',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async execute(args, ctx: ToolContext) {
    const id = String(args.id ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('id must be a rule id from market_rule_list');
    const r = await ctx.pool.query(`UPDATE market_rules SET enabled = false WHERE id = $1 AND enabled AND fired_at IS NULL`, [id]);
    if (!r.rowCount) throw new Error('no ACTIVE rule has that id — it may have already fired or been cancelled');
    return { cancelled: id };
  },
};
