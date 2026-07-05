// Runnable reflection pass: `pnpm reflect`. The Scheduler (M7) will invoke this
// nightly; for now it's manual/cron-able.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import pg from 'pg';
import { runReflection } from './reflect.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const report = await runReflection(pool);
console.log('reflection:', JSON.stringify(report));
await pool.end();
