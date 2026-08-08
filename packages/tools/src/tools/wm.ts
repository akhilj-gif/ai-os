// Working Memory tools (Memory OS Phase 4): session-scoped scratch for the
// current task — variables, choices, active context that must persist across
// turns but isn't long-term knowledge (theme=blue, framework=Next.js, the file
// we're editing). Scoped to the session (resolved from the running task), swept
// when stale by the Forgetting Engine. Read-class/internal — no external effect.
import type pg from 'pg';
import type { ToolDef } from '../registry.js';

async function sessionFor(pool: pg.Pool, taskId: string | null | undefined): Promise<string | null> {
  if (!taskId) return null;
  const { rows } = await pool.query<{ session_id: string }>(`SELECT session_id FROM messages WHERE task_id = $1 LIMIT 1`, [taskId]);
  return rows[0]?.session_id ?? null;
}

export const wmSet: ToolDef = {
  name: 'wm_set',
  untrustedOutput: false,
  description:
    'Set a working-memory variable for THIS session (short-term scratch): a choice, parameter, or active-context value you need to remember across turns while working (e.g. key="framework" value="Next.js"). Not for long-term facts — use memory/project tools for those.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short variable name, e.g. "theme", "deadline", "editing_file".' },
      value: { type: 'string', description: 'The value to remember for this session.' },
    },
    required: ['key', 'value'],
  },
  async execute(args, ctx) {
    const key = String(args.key ?? '').trim().slice(0, 80);
    const value = String(args.value ?? '').trim().slice(0, 2000);
    if (!key || !value) return { error: 'key and value are required' };
    const session = await sessionFor(ctx.pool, ctx.taskId);
    if (!session) return { error: 'no active session to attach working memory to' };
    await ctx.pool.query(
      `INSERT INTO working_memory (session_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (session_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [session, key, value],
    );
    return { ok: true, key, value };
  },
};

export const wmGet: ToolDef = {
  name: 'wm_get',
  untrustedOutput: false,
  description: 'Read working memory for THIS session — one variable by key, or all of them (omit key). Use to recall choices/parameters set earlier in the session.',
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Variable to read. Omit to get everything set this session.' } },
  },
  async execute(args, ctx) {
    const session = await sessionFor(ctx.pool, ctx.taskId);
    if (!session) return { variables: {} };
    const key = args.key ? String(args.key).trim() : null;
    if (key) {
      const { rows } = await ctx.pool.query<{ value: string }>(`SELECT value FROM working_memory WHERE session_id = $1 AND key = $2`, [session, key]);
      return rows[0] ? { key, value: rows[0].value } : { key, value: null, note: 'not set' };
    }
    const { rows } = await ctx.pool.query<{ key: string; value: string }>(`SELECT key, value FROM working_memory WHERE session_id = $1 ORDER BY updated_at DESC`, [session]);
    return { variables: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  },
};

export const wmClear: ToolDef = {
  name: 'wm_clear',
  untrustedOutput: false,
  description: 'Clear working memory for THIS session — one variable by key, or all (omit key). Use when a task is done or a choice no longer applies.',
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Variable to clear. Omit to clear all working memory for the session.' } },
  },
  async execute(args, ctx) {
    const session = await sessionFor(ctx.pool, ctx.taskId);
    if (!session) return { ok: true, cleared: 0 };
    const key = args.key ? String(args.key).trim() : null;
    const res = key
      ? await ctx.pool.query(`DELETE FROM working_memory WHERE session_id = $1 AND key = $2`, [session, key])
      : await ctx.pool.query(`DELETE FROM working_memory WHERE session_id = $1`, [session]);
    return { ok: true, cleared: res.rowCount ?? 0 };
  },
};
