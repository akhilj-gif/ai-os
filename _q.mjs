import pg from 'pg';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()];}));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const all = await pool.query(`SELECT id, checkpoints FROM tasks WHERE jsonb_array_length(coalesce(checkpoints,'[]'::jsonb)) > 0`);
let stats = {};
let worst = [];
for (const row of all.rows) for (const cp of row.checkpoints ?? []) {
  let extra = 0, total = 0;
  for (const m of cp?.state?.messages ?? []) {
    for (const [k,v] of Object.entries(m)) {
      const len = typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length;
      total += len;
      if (!['role','content','tool_calls','tool_call_id'].includes(k)) { extra += len; stats[k]=(stats[k]||0)+len; }
    }
  }
  if (extra > 500) worst.push({task: row.id, extraChars: extra, totalChars: total, pct: Math.round(100*extra/total)});
}
console.log('extra-field chars by key:', JSON.stringify(stats));
worst.sort((a,b)=>b.extraChars-a.extraChars);
console.log('worst checkpoints by wasted chars:', JSON.stringify(worst.slice(0,8), null, 1));
await pool.end();
