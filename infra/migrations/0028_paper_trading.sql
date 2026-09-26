-- Markets pack: a paper-trading account and standing price rules.
--
-- PAPER ONLY. Nothing here represents real money; an order is a row, filled at
-- a quoted price. See packages/tools/src/tools/market.ts for why the trading
-- loop is deterministic code rather than a model, and why prices are labelled
-- with their age (free NSE data is ~15 minutes delayed).

-- The trade log IS the account. Cash, positions and P&L are derived from it by
-- replaying trades (computeBook), never stored separately — so the book cannot
-- drift from the trades that produced it, and every number is auditable back
-- to the fill that caused it.
CREATE TABLE IF NOT EXISTS paper_trades (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      text NOT NULL,
  side        text NOT NULL CHECK (side IN ('buy', 'sell')),
  qty         integer NOT NULL CHECK (qty > 0),
  price       numeric(14, 2) NOT NULL CHECK (price > 0),
  -- When the price was TRADED on the exchange, not when we fetched it. With a
  -- ~15-minute delayed feed these differ, and the difference is the honesty.
  quote_time  timestamptz NOT NULL,
  rule_id     uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_trades_order_idx ON paper_trades (created_at, id);

CREATE TABLE IF NOT EXISTS market_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      text NOT NULL,
  condition   text NOT NULL CHECK (condition IN ('below', 'above')),
  threshold   numeric(14, 2) NOT NULL CHECK (threshold > 0),
  action      text NOT NULL CHECK (action IN ('buy', 'sell', 'alert')),
  qty         integer CHECK (qty IS NULL OR qty > 0),
  enabled     boolean NOT NULL DEFAULT true,
  -- Set once, when the rule fires. A rule never fires twice: see
  -- evaluateRules for the runaway-buy failure this prevents.
  fired_at    timestamptz,
  result      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- A trade rule without a quantity is not a rule, it is a typo.
  CONSTRAINT market_rules_qty_for_trades CHECK (action = 'alert' OR qty IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS market_rules_active_idx ON market_rules (created_at) WHERE enabled AND fired_at IS NULL;

ALTER TABLE paper_trades
  DROP CONSTRAINT IF EXISTS paper_trades_rule_fk,
  ADD CONSTRAINT paper_trades_rule_fk FOREIGN KEY (rule_id) REFERENCES market_rules (id) ON DELETE SET NULL;

-- Exactly one rule-checking job. market_rule_add creates it on first use with
-- ON CONFLICT DO NOTHING; without this index two concurrent adds could both
-- see "no job yet" and create two, doubling every call to the data provider.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_single_market_idx ON jobs (kind) WHERE kind = 'market';
