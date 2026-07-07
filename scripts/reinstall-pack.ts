// One-off ops helper: (re)install a capability pack from the CLI when the API
// is down. Usage: npx tsx scripts/reinstall-pack.ts <pack-name>
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
import { installPack } from '../packages/packs/src/index.js';

const name = process.argv[2];
if (!name) {
  console.error('usage: npx tsx scripts/reinstall-pack.ts <pack-name>');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const r = await installPack(pool, name);
console.log(`${r.name}@${r.version} installed — policies: ${r.policiesApplied}, memories: ${r.memoriesSeeded}${r.memoryWarning ? ` (${r.memoryWarning})` : ''}`);
await pool.end();
