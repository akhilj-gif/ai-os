// Standalone memory smoke test: store → recall → supersede, against real
// Postgres + Gemini embeddings. Run: tsx packages/memory/src/smoke.ts
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import pg from 'pg';
import { MemoryService } from './service.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const mem = new MemoryService(pool);
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

// clean prior smoke rows
await pool.query(`DELETE FROM memory_records WHERE subject LIKE 'smoke-%'`);

// 1. store a preference
const p1 = await mem.remember({
  type: 'preference',
  content: 'Prefers concise replies with no preamble and bullet points.',
  subject: 'smoke-reply-style',
  source: { user_stated: true },
});
check('remember preference', !!p1.id);

// 2. store an unrelated semantic fact
await mem.remember({
  type: 'semantic',
  content: 'The user manages billing and subscription support tickets at Emergent.',
  subject: 'smoke-role',
  source: { user_stated: true },
});

// 3. recall by a semantically-related query (not keyword-identical)
const r1 = await mem.recall({ query: 'how should I format my answer to them?', limit: 5 });
check('recall finds reply-style by meaning', r1.some((r) => r.subject === 'smoke-reply-style'), r1.map((r) => `${r.subject}:${r.score.toFixed(3)}`).join(', '));

// 4. preferences always-loaded
const prefs = await mem.getPreferences();
check('getPreferences returns the preference', prefs.some((p) => p.subject === 'smoke-reply-style'));

// 5. conflict resolution: new same-subject preference supersedes the old
const p2 = await mem.remember({
  type: 'preference',
  content: 'Now prefers detailed replies with full explanations.',
  subject: 'smoke-reply-style',
  source: { user_stated: true },
});
const activePrefs = await mem.getPreferences();
const activeReplyStyle = activePrefs.filter((p) => p.subject === 'smoke-reply-style');
check('supersede: exactly one active reply-style', activeReplyStyle.length === 1, `${activeReplyStyle.length} active`);
check('supersede: newest wins', activeReplyStyle[0]?.id === p2.id);
const old = (await pool.query(`SELECT superseded_by FROM memory_records WHERE id=$1`, [p1.id])).rows[0];
check('supersede: old points to new (auditable)', old?.superseded_by === p2.id);

// cleanup
await pool.query(`DELETE FROM memory_records WHERE subject LIKE 'smoke-%'`);
await pool.end();
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
