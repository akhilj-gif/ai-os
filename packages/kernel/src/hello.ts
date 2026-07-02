// M0 exit check: `pnpm hello` → model call → trace in Postgres + Langfuse.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
// Load the workspace-root .env regardless of which package cwd we run under.
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import pg from 'pg';
import { runHelloWorldTask } from './index.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const result = await runHelloWorldTask(pool);
console.log(JSON.stringify(result, null, 2));
if (result.status === 'done') {
  console.log(
    `\nTrace: ${process.env.LANGFUSE_HOST ?? 'http://localhost:3030'} → project ai-os → traces → ${result.traceId}`,
  );
}
await pool.end();
process.exit(result.status === 'done' ? 0 : 1);
