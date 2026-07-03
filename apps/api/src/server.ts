// Fastify gateway (blueprint §10). M1: Google OAuth, chat → executor loop,
// resume-on-boot for orphaned tasks, and the tracing invariant — EVERY request
// gets a trace_id and a trace_events row.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
// Load the workspace-root .env regardless of which package cwd we run under.
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { Redis } from 'ioredis';
import { TraceStore, newTraceId } from '@ai-os/shared';
import {
  runHelloWorldTask,
  runTask,
  findOrphanedTasks,
  ensureDefaultSession,
  addMessage,
  listMessages,
} from '@ai-os/kernel';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});
const trace = new TraceStore(pool);

const app = Fastify({ logger: true });

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
  }
}

app.addHook('onRequest', async (req, reply) => {
  req.traceId = (req.headers['x-trace-id'] as string | undefined) ?? newTraceId();
  reply.header('x-trace-id', req.traceId);
  trace.recordSafe({
    traceId: req.traceId,
    component: 'api',
    event: 'http.request',
    payload: { method: req.method, url: req.url },
  });
});

app.get('/health', async () => {
  const services: Record<string, string> = {};
  try {
    await pool.query('SELECT 1');
    services.postgres = 'ok';
  } catch (err) {
    services.postgres = `error: ${err instanceof Error ? err.message : err}`;
  }
  try {
    await redis.ping();
    services.redis = 'ok';
  } catch (err) {
    services.redis = `error: ${err instanceof Error ? err.message : err}`;
  }
  try {
    const res = await fetch(
      `${process.env.LANGFUSE_HOST ?? 'http://localhost:3030'}/api/public/health`,
      { signal: AbortSignal.timeout(2000) },
    );
    services.langfuse = res.ok ? 'ok' : `http ${res.status}`;
  } catch {
    services.langfuse = 'unreachable';
  }
  const ok = services.postgres === 'ok' && services.redis === 'ok';
  return { ok, milestone: 'M1', services };
});

// M0 smoke test, kept alive
app.post('/hello', async () => runHelloWorldTask(pool));

// ---------------------------------------------------------------------------
// Google OAuth (Gmail readonly + compose(drafts) + Calendar readonly)
// ---------------------------------------------------------------------------
const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
];
const pendingOAuthStates = new Set<string>();

app.get('/oauth/google', async (_req, reply) => {
  const state = randomUUID();
  pendingOAuthStates.add(state);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID ?? '');
  url.searchParams.set('redirect_uri', process.env.GOOGLE_REDIRECT_URI ?? '');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent'); // guarantees a refresh_token
  url.searchParams.set('state', state);
  return reply.redirect(url.toString());
});

app.get('/oauth/google/callback', async (req, reply) => {
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  if (error) return reply.redirect(`http://localhost:3000/?google=denied`);
  if (!code || !state || !pendingOAuthStates.delete(state)) {
    return reply.code(400).send({ error: 'invalid oauth state or missing code' });
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      grant_type: 'authorization_code',
      redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? '',
      code,
    }),
  });
  if (!res.ok) {
    req.log.error({ status: res.status, body: await res.text() }, 'oauth token exchange failed');
    return reply.code(502).send({ error: 'token exchange failed' });
  }
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    id_token?: string;
  };
  if (!tok.refresh_token) {
    return reply.code(502).send({ error: 'Google returned no refresh_token — retry /oauth/google' });
  }
  // email from the id_token payload (came over TLS directly from Google)
  let email: string | null = null;
  try {
    const payload = JSON.parse(
      Buffer.from(tok.id_token!.split('.')[1]!, 'base64url').toString('utf8'),
    ) as { email?: string };
    email = payload.email ?? null;
  } catch {
    /* email stays null */
  }
  await pool.query(
    `INSERT INTO oauth_tokens (provider, account_email, refresh_token, access_token, access_token_expires_at, scopes)
     VALUES ('google', $1, $2, $3, now() + ($4 || ' seconds')::interval, $5)
     ON CONFLICT (provider) DO UPDATE SET
       account_email = EXCLUDED.account_email,
       refresh_token = EXCLUDED.refresh_token,
       access_token = EXCLUDED.access_token,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       scopes = EXCLUDED.scopes,
       updated_at = now()`,
    [email, tok.refresh_token, tok.access_token, String(tok.expires_in), tok.scope.split(' ')],
  );
  trace.recordSafe({
    traceId: req.traceId,
    component: 'api',
    event: 'oauth.google.connected',
    payload: { email },
  });
  return reply.redirect('http://localhost:3000/?google=connected');
});

app.get('/oauth/google/status', async () => {
  const { rows } = await pool.query<{ account_email: string | null; scopes: string[] }>(
    `SELECT account_email, scopes FROM oauth_tokens WHERE provider = 'google'`,
  );
  return rows[0]
    ? { connected: true, email: rows[0].account_email, scopes: rows[0].scopes }
    : { connected: false };
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
async function completeChatTask(taskId: string): Promise<void> {
  const result = await runTask(pool, taskId);
  const { rows } = await pool.query<{ session_id: string }>(
    `SELECT session_id FROM messages WHERE task_id = $1 AND role = 'user' LIMIT 1`,
    [taskId],
  );
  const sessionId = rows[0]?.session_id ?? (await ensureDefaultSession(pool));
  await addMessage(pool, { sessionId, role: 'assistant', content: result.text, taskId });
}

app.post('/chat', async (req) => {
  const { text, sessionId } = (req.body ?? {}) as { text?: string; sessionId?: string };
  if (!text?.trim()) return { error: 'text is required' };
  const session = sessionId ?? (await ensureDefaultSession(pool));

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1, 'draft', 'user', $2) RETURNING id`,
    [text.trim(), req.traceId],
  );
  const taskId = rows[0]!.id;
  await addMessage(pool, { sessionId: session, role: 'user', content: text.trim(), taskId });

  await completeChatTask(taskId);
  const msgs = await listMessages(pool, session);
  const reply = msgs.filter((m) => m.task_id === taskId && m.role === 'assistant').at(-1);
  return { sessionId: session, taskId, reply: reply?.content ?? '' };
});

app.get('/messages', async (req) => {
  const q = req.query as { sessionId?: string };
  const sessionId = q.sessionId ?? (await ensureDefaultSession(pool));
  return { sessionId, messages: await listMessages(pool, sessionId) };
});

// ---------------------------------------------------------------------------
// Boot: resume tasks orphaned by a mid-run kill (M1 exit criterion)
// ---------------------------------------------------------------------------
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: '127.0.0.1' });

void (async () => {
  const orphans = await findOrphanedTasks(pool);
  for (const taskId of orphans) {
    app.log.info({ taskId }, 'resuming orphaned task');
    trace.recordSafe({ traceId: newTraceId(), taskId, component: 'api', event: 'task.resume_on_boot' });
    completeChatTask(taskId).catch((err) => app.log.error({ err, taskId }, 'orphan resume failed'));
  }
})();
