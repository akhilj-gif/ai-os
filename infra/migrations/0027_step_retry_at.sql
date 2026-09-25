-- Step-level retry scheduling.
--
-- `steps.retries` has existed since the first migration and nothing ever
-- incremented it: all 1,395 rows on the live DB read 0. The column encoded an
-- intention the driver never implemented — a failed step was simply terminal.
-- Measured 2026-09-19: 115 of 135 failed steps were transient (Groq/Gemini
-- 429s, provider timeouts, `fetch failed`), and 130 of them were `reason`
-- steps, i.e. pure model calls with no side effects that were safe to rerun.
--
-- `retry_at` is what makes "not now" different from "never": a step parked for
-- a quota window stays failed (so nothing downstream runs and no partial
-- result is mistaken for an answer) but carries the time it becomes runnable
-- again. NULL means terminal, which is why the column is nullable and has no
-- default — every existing row is correctly terminal.
ALTER TABLE steps ADD COLUMN IF NOT EXISTS retry_at timestamptz;

-- The driver asks exactly one question of this column ("is anything in this
-- task due?"), and the coordinator asks it across tasks. Partial, because the
-- overwhelming majority of rows are NULL and never need to be visited.
CREATE INDEX IF NOT EXISTS steps_retry_due_idx ON steps (retry_at) WHERE retry_at IS NOT NULL;

-- Replan budget. A non-transient failure (bad args, a tool the planner
-- invented, a step that cannot work as written) is not a scheduling problem —
-- the PLAN is wrong, and the fix is to plan again knowing what went wrong.
-- Capped at one because a replan is a full planner call: on a tier limited to
-- ~8,000 tokens/min, an unbounded replan loop would consume exactly the quota
-- the retries are waiting for.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS replans int NOT NULL DEFAULT 0;
