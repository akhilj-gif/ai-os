// Approval freshness regression. Needs Postgres + the API running:
//   tsx packages/kernel/src/pending-ttl-smoke.ts
//
// THE HOLE THIS PINS. decidePendingAction checked only that the row was still
// status='pending', never how OLD it was, so an approval card stayed armed
// forever. Measured 2026-09-19 on the live DB: 14 cards pending, the oldest 71
// days, including purge_all_data (wipes every memory record), mobility_book
// (books a real cab) and an x_publish_post whose text read "Shipped M12 today"
// — approving that in September would have publicly posted a false claim about
// August.
//
// An approval card is the confirmation step for an intent expressed in
// conversation. Once that conversation is weeks cold the card no longer means
// what the user thought they were agreeing to, and the one-click gate the whole
// trust system rests on becomes a trap instead of a safeguard.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import pg from 'pg';

const API = `http://127.0.0.1:${process.env.API_PORT || 4000}`;
const TOKEN = (process.env.AIOS_API_TOKEN ?? '').trim();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

/** Queue a card with a chosen age, so the test does not have to wait a day. */
async function queue(tool: string, ageDays: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO pending_actions (task_id, tool, args, trust_class, status, created_at)
     SELECT id, $1, '{}'::jsonb, 'read', 'pending', now() - ($2::bigint * interval '1 day')
     FROM tasks ORDER BY created_at DESC LIMIT 1
     RETURNING id`,
    [tool, ageDays],
  );
  return rows[0]!.id;
}
const decide = async (id: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(`${API}/pending/${id}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-aios-token': TOKEN } : {}) },
    body: JSON.stringify({ decision: 'approved' }),
  });
  return { status: res.status, body: await res.text() };
};
const statusOf = async (id: string): Promise<string> =>
  (await pool.query<{ status: string }>(`SELECT status FROM pending_actions WHERE id=$1`, [id])).rows[0]?.status ?? '(gone)';

const created: string[] = [];
try {
  console.log('— a STALE card must never execute —');
  const old = await queue('app_list', 40);
  created.push(old);
  const r1 = await decide(old);
  check('approving a 40-day-old card is refused', r1.status === 409, `http ${r1.status}`);
  check('...and the reason says it expired, not something generic', /expired/i.test(r1.body), r1.body.slice(0, 80));
  check('...and it is marked expired, NOT executed', (await statusOf(old)) === 'expired', await statusOf(old));

  console.log('\n— a FRESH card must still work (or the gate is just broken) —');
  const fresh = await queue('app_list', 0);
  created.push(fresh);
  const r2 = await decide(fresh);
  check('approving a fresh card succeeds', r2.status === 200, `http ${r2.status}`);
  check('...and it actually executed', (await statusOf(fresh)) === 'executed', await statusOf(fresh));

  console.log('\n— the UI must not OFFER a card the API would refuse —');
  const stale2 = await queue('app_list', 40);
  created.push(stale2);
  const dash = (await (await fetch(`${API}/dashboard`, { headers: TOKEN ? { 'x-aios-token': TOKEN } : {} })).json()) as {
    pendingActions?: Array<{ id: string }>;
  };
  const offered = (dash.pendingActions ?? []).some((p) => p.id === stale2);
  check('the dashboard hides the stale card', !offered, `${dash.pendingActions?.length ?? 0} offered`);
  // Hidden, but deliberately NOT deleted: the row is the audit trail of what the
  // OS wanted to do and when, which is worth more than a tidy table.
  check('...but the row still exists for the audit trail', (await statusOf(stale2)) === 'pending', await statusOf(stale2));
} finally {
  if (created.length) await pool.query(`DELETE FROM pending_actions WHERE id = ANY($1::uuid[])`, [created]);
  await pool.end();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
