// Session Manager (blueprint §4.2), M1 scope: one durable default session,
// persisted messages. Multi-session UI arrives with the OS interface (M8).
import type pg from 'pg';

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  task_id: string | null;
  created_at: Date;
}

export async function ensureDefaultSession(pool: pg.Pool): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM sessions ORDER BY created_at ASC LIMIT 1`,
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await pool.query<{ id: string }>(
    `INSERT INTO sessions (title) VALUES ('main') RETURNING id`,
  );
  return created.rows[0]!.id;
}

export async function addMessage(
  pool: pg.Pool,
  m: { sessionId: string; role: 'user' | 'assistant'; content: string; taskId?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO messages (session_id, role, content, task_id) VALUES ($1, $2, $3, $4)`,
    [m.sessionId, m.role, m.content, m.taskId ?? null],
  );
  await pool.query(`UPDATE sessions SET updated_at = now() WHERE id = $1`, [m.sessionId]);
}

export async function listMessages(pool: pg.Pool, sessionId: string): Promise<SessionMessage[]> {
  const { rows } = await pool.query<SessionMessage>(
    `SELECT id, role, content, task_id, created_at
     FROM messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 500`,
    [sessionId],
  );
  return rows;
}
