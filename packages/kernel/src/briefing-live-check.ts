// Live briefing check: pull the real Morning-briefing job due NOW and tick with
// the default executors — real gmail_list + calendar_list + ONE model synthesis →
// a notification row. Needs model quota (run with MODEL_PROVIDER=groq when Gemini
// is spent); if quota is out the run records `deferred` — which is itself the
// designed behavior, never a false success. Run:
//   MODEL_PROVIDER=groq npx tsx packages/kernel/src/briefing-live-check.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { tick } from './scheduler.js';
import { defaultExecutors } from './jobs.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const job = (await pool.query(`SELECT id, name FROM jobs WHERE kind='briefing' AND enabled ORDER BY created_at LIMIT 1`)).rows[0];
if (!job) {
  console.log('NO BRIEFING JOB — create one at /automations first.');
  process.exit(1);
}
await pool.query(`UPDATE jobs SET next_run_at=now() WHERE id=$1`, [job.id]);
const report = await tick(pool, { executors: defaultExecutors() });
console.log('tick:', JSON.stringify(report.ran));
const run = (await pool.query(`SELECT status, error, output FROM job_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 1`, [job.id])).rows[0];
console.log(`run status: ${run?.status}${run?.error ? ' — ' + String(run.error).slice(0, 120) : ''}`);
if (run?.status === 'done') {
  const n = (await pool.query(`SELECT title, body FROM notifications WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1`, [job.id])).rows[0];
  console.log(`\n=== ${n?.title} ===\n${n?.body}\n\nRESULT: LIVE BRIEFING DELIVERED (real inbox + calendar → synthesized → notification).`);
} else if (run?.status === 'deferred') {
  console.log('\nRESULT: DEFERRED (quota) — the designed degradation; it will retry automatically.');
} else {
  console.log('\nRESULT: run did not complete — see error above.');
}
await pool.end();
