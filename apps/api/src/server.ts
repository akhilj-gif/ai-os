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
  runAgentTask,
  resumeAgentTask,
  classifyGoal,
  findOrphanedTasks,
  ensureDefaultSession,
  addMessage,
  listMessages,
  planAndStart,
  runGraph,
  pauseTask,
  resumeTask,
  redirectTask,
  decideApproval,
  runResearch,
  runCodingTask,
  createJob,
  tick,
  startScheduler,
  defaultExecutors,
  runLearningCycle,
  gatherFailureSignals,
  tickRemote,
  type RemoteCursor,
  type Schedule,
} from '@ai-os/kernel';
import { MemoryService } from '@ai-os/memory';
import { failoverChain, transcribe, synthesize } from '@ai-os/model-router';
import { composeRegistry, packPrompts, loadEnabledPacks, installPack, setPackEnabled, listPacks, PACKS, uberConfigured, uberAuthorizeUrl, exchangeUberCode } from '@ai-os/packs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const memory = new MemoryService(pool);
// M9: the runtime tool surface is composed from ENABLED capability packs (loaded
// at boot, refreshed on install/toggle). Kernel-core = workspace only.
let enabledPacks = new Set<string>();
const packRegistry = () => composeRegistry(enabledPacks);
const packPrompt = () => packPrompts(enabledPacks);
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
  return { ok, milestone: 'M10', services };
});

// M8 settings: which providers/models the router will use, in failover order
// (ADR-0011). Names and model ids only — never key material.
app.get('/system/models', async () => {
  try {
    const chain = failoverChain();
    return {
      pinned: process.env.MODEL_PROVIDER ?? null,
      chain: chain.map((p, i) => ({
        name: p.name,
        position: i === 0 ? 'primary' : `fallback ${i}`,
        models: {
          routing: i === 0 ? process.env.MODEL_ROUTING ?? p.defaults.routing : p.defaults.routing,
          execution: i === 0 ? process.env.MODEL_EXECUTION ?? p.defaults.execution : p.defaults.execution,
          planning: i === 0 ? process.env.MODEL_PLANNING ?? p.defaults.planning : p.defaults.planning,
        },
      })),
    };
  } catch (err) {
    return { pinned: null, chain: [], error: err instanceof Error ? err.message : String(err) };
  }
});

// M0 smoke test, kept alive
app.post('/hello', async () => runHelloWorldTask(pool));

// ---------------------------------------------------------------------------
// Google OAuth (Gmail readonly + compose(drafts) + Calendar readonly + events write)
// ---------------------------------------------------------------------------
const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
  // calendar.events (not the broader 'calendar' scope) — least privilege for
  // calendar_create_event: can create/edit/delete events, cannot touch calendar
  // settings/sharing. A refresh token issued under the OLD scope list does NOT
  // gain this automatically — the user must re-run /oauth/google to re-consent.
  'https://www.googleapis.com/auth/calendar.events',
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

// M14c — Uber OAuth (ride booking on Akhil's own account). Mirrors Google:
// /oauth/uber → consent; callback stores tokens in oauth_tokens provider='uber'.
// Only usable once UBER_CLIENT_ID/SECRET/REDIRECT_URI are in .env.
app.get('/oauth/uber', async (_req, reply) => {
  if (!uberConfigured()) return reply.code(400).send({ error: 'Uber not configured — set UBER_CLIENT_ID, UBER_CLIENT_SECRET, UBER_REDIRECT_URI in .env first' });
  const state = randomUUID();
  pendingOAuthStates.add(state);
  return reply.redirect(uberAuthorizeUrl(state));
});

app.get('/oauth/uber/callback', async (req, reply) => {
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  if (error) return reply.redirect('http://localhost:3000/?uber=denied');
  if (!code || !state || !pendingOAuthStates.delete(state)) {
    return reply.code(400).send({ error: 'invalid oauth state or missing code' });
  }
  try {
    await exchangeUberCode(pool, code);
  } catch (err) {
    req.log.error({ err: err instanceof Error ? err.message : err }, 'uber oauth exchange failed');
    return reply.code(502).send({ error: 'Uber token exchange failed — check the app credentials and redirect URI' });
  }
  trace.recordSafe({ traceId: req.traceId, component: 'api', event: 'oauth.uber.connected', payload: {} });
  return reply.redirect('http://localhost:3000/?uber=connected');
});

app.get('/oauth/uber/status', async () => {
  if (!uberConfigured()) return { connected: false, configured: false };
  const { rows } = await pool.query(`SELECT scopes FROM oauth_tokens WHERE provider = 'uber'`);
  return { connected: rows.length > 0, configured: true };
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
const CHAT_HISTORY_TURNS = 12; // recent turns fed back so chat has memory across messages
// Each replayed turn is capped: one giant message (a pasted wall, an old raw error
// dump) otherwise balloons the prompt past Groq's free-tier tokens-per-minute cap,
// and the chat "hangs" for minutes inside the rate-limit retry loop before failing
// (dogfooded on the 102-message main session). Memory quality loses little — the
// tail of a wall of text is rarely what the next turn depends on.
const CHAT_HISTORY_MSG_CHARS = 500;

async function completeChatTask(taskId: string, agentMode: 'auto' | 'force' | 'off' = 'auto'): Promise<void> {
  const { rows } = await pool.query<{ session_id: string }>(
    `SELECT session_id FROM messages WHERE task_id = $1 AND role = 'user' LIMIT 1`,
    [taskId],
  );
  const sessionId = rows[0]?.session_id ?? (await ensureDefaultSession(pool));

  // Conversation MEMORY: replay the session's recent user/assistant turns (excluding
  // this task's own just-added message) so the model sees the ongoing chat, not a
  // cold start. Without this every message was a brand-new amnesiac task.
  const prior = (await listMessages(pool, sessionId))
    .filter((m) => m.task_id !== taskId && (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
    .slice(-CHAT_HISTORY_TURNS)
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content.length > CHAT_HISTORY_MSG_CHARS ? `${m.content.slice(0, CHAT_HISTORY_MSG_CHARS)} …[truncated]` : m.content,
    }));

  // M11 — the Brain: multi-domain goals get planned across specialist agents.
  // 'auto' asks a routing-tier classifier (fail-safe → simple); AIOS_AGENTS=off
  // is the kill switch. Orchestrated runs post progress lines into the chat.
  let useAgents = false;
  if (process.env.AIOS_AGENTS !== 'off' && agentMode !== 'off') {
    if (agentMode === 'force') useAgents = true;
    else {
      const t = await pool.query<{ goal: string; trace_id: string }>(`SELECT goal, trace_id FROM tasks WHERE id=$1`, [taskId]);
      useAgents = t.rows[0] ? (await classifyGoal(t.rows[0].goal, t.rows[0].trace_id)) === 'complex' : false;
    }
  }

  const result = useAgents
    ? await runAgentTask(pool, taskId, {
        registry: packRegistry(),
        extraSystem: packPrompt(),
        say: async (content) => { await addMessage(pool, { sessionId, role: 'assistant', content, taskId }); },
      })
    : await runTask(pool, taskId, { registry: packRegistry(), extraSystem: packPrompt(), enableMemory: true, history: prior });
  await addMessage(pool, { sessionId, role: 'assistant', content: result.text, taskId });
}

app.post('/chat', async (req) => {
  const { text, sessionId, agentMode } = (req.body ?? {}) as { text?: string; sessionId?: string; agentMode?: 'auto' | 'force' | 'off' };
  if (!text?.trim()) return { error: 'text is required' };
  // Robustness: a passed sessionId must be a real session, else fall back to the
  // default — a bad/unknown id used to FK-violate on addMessage and silently 500.
  let session = await ensureDefaultSession(pool);
  if (sessionId) {
    const ok = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]).catch(() => ({ rowCount: 0 }));
    if (ok.rowCount) session = sessionId;
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1, 'draft', 'user', $2) RETURNING id`,
    [text.trim(), req.traceId],
  );
  const taskId = rows[0]!.id;
  await addMessage(pool, { sessionId: session, role: 'user', content: text.trim(), taskId });

  await completeChatTask(taskId, agentMode ?? 'auto');
  const msgs = await listMessages(pool, session);
  const reply = msgs.filter((m) => m.task_id === taskId && m.role === 'assistant').at(-1);
  return { sessionId: session, taskId, reply: reply?.content ?? '' };
});

// ---------------------------------------------------------------------------
// Voice commands (M11 seed): raw recorder audio in → Whisper text out.
// Transcription is an INTERFACE concern — the kernel never sees audio, only the
// resulting text, which the client then sends through the normal /chat trust
// path (so approval-required tools still queue for in-chat approval; a
// mis-heard command can at worst run read-class tools).
// ---------------------------------------------------------------------------
// Groq's Whisper endpoint caps files at 25MB; match it so the recorder can't
// overflow us first. Parser body is the raw bytes — no multipart dependency.
app.addContentTypeParser(/^audio\/.+/, { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) =>
  done(null, body),
);

app.post('/voice/transcribe', async (req, reply) => {
  const audio = req.body as Buffer;
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    return reply.code(400).send({ error: 'send raw audio bytes with an audio/* content-type' });
  }
  const mime = req.headers['content-type'] ?? 'audio/webm';
  try {
    const text = await transcribe(audio, mime);
    trace.recordSafe({ traceId: req.traceId, component: 'api', event: 'voice.transcribed', payload: { bytes: audio.length, chars: text.length } });
    return { text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, 'voice transcription failed');
    return reply.code(502).send({ error: /INFRA_RATELIMIT/.test(msg) ? 'transcription rate-limited — try again in a moment' : 'transcription failed' });
  }
});

// M12d follow-up (2026-07-11): natural spoken replies. Groq Orpheus TTS renders
// the reply as a realistic female voice ("tara"); any failure (quota, no key)
// → 502 and the UI falls back to the browser's speechSynthesis. Interface
// concern — the kernel never hears audio.
app.post('/voice/speak', async (req, reply) => {
  const { text } = (req.body ?? {}) as { text?: string };
  if (!text?.trim()) return reply.code(400).send({ error: 'text is required' });
  try {
    const { audio, mime } = await synthesize(text);
    trace.recordSafe({ traceId: req.traceId, component: 'api', event: 'voice.synthesized', payload: { chars: text.length, bytes: audio.length } });
    return reply.type(mime).send(audio);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.warn({ err: msg.slice(0, 200) }, 'voice synthesis failed (UI falls back to browser TTS)');
    return reply.code(502).send({ error: /terms/i.test(msg) ? 'the TTS model needs a one-time terms acceptance in the Groq console' : 'synthesis unavailable' });
  }
});

app.get('/messages', async (req) => {
  const q = req.query as { sessionId?: string };
  const sessionId = q.sessionId ?? (await ensureDefaultSession(pool));
  // Pending approvals for THIS session are returned alongside the thread so the
  // chat can render them inline (approve/reject in-chat, no trip to the dashboard).
  const pending = (
    await pool.query(
      `SELECT id, task_id, tool, args, untrusted_context, created_at
       FROM pending_actions WHERE session_id=$1 AND status='pending' ORDER BY created_at`,
      [sessionId],
    )
  ).rows;
  return { sessionId, messages: await listMessages(pool, sessionId), pendingActions: pending };
});

// ---------------------------------------------------------------------------
// Chat sessions: "New chat" support (M1's sessions.ts only ever had ONE default
// session — every message piled into it forever). Title is never asked for up
// front; the UI shows each session's first user message as its label instead.
// ---------------------------------------------------------------------------
app.post('/sessions', async (req) => {
  const { title } = (req.body ?? {}) as { title?: string };
  const { rows } = await pool.query(
    `INSERT INTO sessions (title) VALUES ($1) RETURNING id, title, created_at, updated_at`,
    [title?.trim() || 'New chat'],
  );
  trace.recordSafe({ traceId: req.traceId, component: 'sessions', event: 'session.created', payload: { id: rows[0]!.id } });
  return rows[0];
});

app.get('/sessions', async () => {
  const { rows } = await pool.query(
    `SELECT s.id, s.title, s.created_at, s.updated_at,
            (SELECT count(*) FROM messages m WHERE m.session_id = s.id)::int AS message_count,
            (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.created_at ASC LIMIT 1) AS first_message
     FROM sessions s
     ORDER BY s.updated_at DESC
     LIMIT 100`,
  );
  return { sessions: rows };
});

app.delete('/sessions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { rowCount } = await pool.query(`DELETE FROM sessions WHERE id=$1`, [id]); // messages cascade
  return rowCount ? { ok: true } : reply.code(404).send({ error: 'no such session' });
});

// ---------------------------------------------------------------------------
// Memory (blueprint §7.2: user-visible, with source + delete = trust via inspectability)
// ---------------------------------------------------------------------------
app.get('/memory', async (req) => {
  const q = req.query as { includeSuperseded?: string };
  const records = await memory.list({ includeSuperseded: q.includeSuperseded === 'true' });
  return { count: records.length, records };
});

app.delete('/memory/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const ok = await memory.remove(id);
  trace.recordSafe({ traceId: req.traceId, component: 'memory', event: 'memory.deleted', payload: { id, ok } });
  return reply.code(ok ? 200 : 404).send({ deleted: ok });
});

// M8 memory browser: semantic search over memories. Degrades to a plain keyword
// match when embeddings are unavailable (quota) — search must never be down.
app.get('/memory/search', async (req) => {
  const { q, type } = req.query as { q?: string; type?: string };
  if (!q?.trim()) return { records: [], mode: 'none' };
  const types = type ? [type as never] : undefined;
  try {
    const records = await memory.recall({ query: q.trim(), types, limit: 25, minRelevance: 0.05 });
    return { records, mode: 'semantic' };
  } catch {
    const { rows } = await pool.query(
      `SELECT * FROM memory_records
       WHERE superseded_by IS NULL AND content ILIKE $1 ${type ? 'AND type = $2' : ''}
       ORDER BY confidence DESC, created_at DESC LIMIT 25`,
      type ? [`%${q.trim()}%`, type] : [`%${q.trim()}%`],
    );
    return { records: rows, mode: 'keyword (embeddings unavailable)' };
  }
});

// ---------------------------------------------------------------------------
// Research engine (M6): ask a question → cited report over fetched web sources.
// ---------------------------------------------------------------------------
app.post('/research', async (req) => {
  const { question } = (req.body ?? {}) as { question?: string };
  if (!question?.trim()) return { error: 'question is required' };
  return runResearch(pool, { question: question.trim(), registry: packRegistry() });
});

app.get('/research', async () => {
  const { rows } = await pool.query(
    `SELECT id, question, status, sources, created_at FROM research_reports ORDER BY created_at DESC LIMIT 50`,
  );
  return { reports: rows };
});

app.get('/research/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const r = (await pool.query(`SELECT id, question, report, sources, status, created_at FROM research_reports WHERE id=$1`, [id])).rows[0];
  return r ? r : reply.code(404).send({ error: 'no such report' });
});

// ---------------------------------------------------------------------------
// Coding engine (M6 §): the test-driven fix loop. Propose → sandbox-test → iterate
// until green. Returns the passing change for approval. Read-only w.r.t. the host —
// all code runs in the Docker sandbox; the mutating commit-on-approval step
// (commitApproved) is a deliberate library call, not exposed over HTTP.
// ---------------------------------------------------------------------------
app.post('/code', async (req, reply) => {
  const { instruction, files, testCmd, language, egress, maxRounds } = (req.body ?? {}) as {
    instruction?: string;
    files?: Record<string, string>;
    testCmd?: string;
    language?: 'python' | 'node' | 'sh';
    egress?: boolean;
    maxRounds?: number;
  };
  if (!instruction?.trim() || !files || !testCmd?.trim()) {
    return reply.code(400).send({ error: 'instruction, files and testCmd are required' });
  }
  return runCodingTask(pool, { instruction: instruction.trim(), files, testCmd: testCmd.trim(), language, egress, maxRounds });
});

// ---------------------------------------------------------------------------
// Automation (M7, ADR-0010): durable scheduled jobs + the notifications surface.
// Jobs are fixed read-only pipelines (briefing/watch/reflect) — the only thing an
// unattended run can do is write a notification.
// ---------------------------------------------------------------------------
// briefing/watch/reflect = fixed read-only pipelines. act (M12b) runs an agent
// loop on a trigger (mutations still approval-gated). learn (M13b) runs the
// gym-gated learning cycle. Both are unattended but contained by the trust gate.
const JOB_KINDS = new Set(['briefing', 'watch', 'reflect', 'act', 'learn']);

app.get('/jobs', async () => {
  const { rows: jobs } = await pool.query(
    `SELECT j.*,
            (SELECT to_jsonb(r) FROM (
               SELECT status, started_at, finished_at, error, output FROM job_runs
               WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1) r) AS last_run
     FROM jobs j ORDER BY j.created_at`,
  );
  return { jobs };
});

app.post('/jobs', async (req, reply) => {
  const { name, kind, schedule, payload } = (req.body ?? {}) as {
    name?: string; kind?: string; schedule?: Schedule; payload?: Record<string, unknown>;
  };
  if (!name?.trim() || !kind || !JOB_KINDS.has(kind) || !schedule) {
    return reply.code(400).send({ error: `name, kind (${[...JOB_KINDS].join('|')}) and schedule are required` });
  }
  if (kind === 'watch' && !/^https?:\/\//i.test(String(payload?.url ?? ''))) {
    return reply.code(400).send({ error: 'watch jobs need payload.url (http/https)' });
  }
  if (kind === 'act' && !String(payload?.goal ?? '').trim()) {
    return reply.code(400).send({ error: 'act jobs need payload.goal (what to do when triggered)' });
  }
  try {
    return await createJob(pool, { name: name.trim(), kind, schedule, payload });
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put('/jobs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { enabled } = (req.body ?? {}) as { enabled?: boolean };
  if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (boolean) is required' });
  const { rows } = await pool.query(`UPDATE jobs SET enabled=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, enabled]);
  return rows[0] ?? reply.code(404).send({ error: 'no such job' });
});

app.delete('/jobs/:id', async (req, reply) => {
  const { rowCount } = await pool.query(`DELETE FROM jobs WHERE id=$1`, [(req.params as { id: string }).id]);
  return rowCount ? { ok: true } : reply.code(404).send({ error: 'no such job' });
});

app.post('/jobs/:id/run-now', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { rowCount } = await pool.query(`UPDATE jobs SET next_run_at=now(), updated_at=now() WHERE id=$1 AND enabled`, [id]);
  if (!rowCount) return reply.code(404).send({ error: 'no such enabled job' });
  const report = await tick(pool, { executors: defaultExecutors(), registry: packRegistry() });
  const { rows } = await pool.query(`SELECT status, error, output FROM job_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 1`, [id]);
  return { report, lastRun: rows[0] ?? null };
});

app.get('/notifications', async (req) => {
  const unreadOnly = (req.query as { unread?: string }).unread === '1';
  const { rows } = await pool.query(
    `SELECT * FROM notifications ${unreadOnly ? 'WHERE NOT read' : ''} ORDER BY created_at DESC LIMIT 50`,
  );
  return { notifications: rows };
});

app.post('/notifications/:id/read', async (req, reply) => {
  const { rowCount } = await pool.query(`UPDATE notifications SET read=true WHERE id=$1`, [(req.params as { id: string }).id]);
  return rowCount ? { ok: true } : reply.code(404).send({ error: 'no such notification' });
});

// Chat approval: decide a queued irreversible action. On approve, execute the
// EXACT call the user saw (via the pack registry); on reject, cancel. Either way
// post a confirmation into the chat and resolve the task. Fail-closed: only a
// still-'pending' action can be acted on (no double-send).
// Shared by the HTTP route and the M12a WhatsApp remote channel ("@os approve
// <id>") — one fail-closed implementation, two surfaces.
async function decidePendingAction(
  id: string,
  decision: 'approved' | 'rejected',
  traceId: string,
): Promise<{ ok: boolean; executed: boolean; rejected?: boolean; error?: string; httpCode?: number; line: string; result?: unknown }> {
  const pa = (await pool.query(`SELECT task_id, session_id, tool, args, status FROM pending_actions WHERE id=$1`, [id])).rows[0] as
    | { task_id: string; session_id: string | null; tool: string; args: Record<string, unknown>; status: string }
    | undefined;
  if (!pa) return { ok: false, executed: false, error: 'no such pending action', httpCode: 404, line: '⚠ No such pending approval.' };
  if (pa.status !== 'pending') return { ok: false, executed: false, error: `already ${pa.status}`, httpCode: 409, line: `⚠ Already ${pa.status} — nothing to do.` }; // no double-send
  await pool.query(`UPDATE notifications SET read=true WHERE meta->>'pendingActionId' = $1`, [id]);

  const say = async (content: string) => {
    if (pa.session_id) await addMessage(pool, { sessionId: pa.session_id, role: 'assistant', content, taskId: pa.task_id });
  };

  if (decision === 'rejected') {
    await pool.query(`UPDATE pending_actions SET status='rejected', decided_at=now() WHERE id=$1`, [id]);
    await pool.query(`UPDATE tasks SET status='done', updated_at=now() WHERE id=$1`, [pa.task_id]);
    const line = `❌ Cancelled — I did not run ${pa.tool}.`;
    await say(line);
    trace.recordSafe({ traceId, taskId: pa.task_id, component: 'trust', event: 'pending.rejected', payload: { tool: pa.tool } });
    return { ok: true, executed: false, rejected: true, line };
  }

  const tool = packRegistry().get(pa.tool);
  let result: unknown = { error: `tool ${pa.tool} unavailable (pack disabled?)` };
  if (tool) {
    try { result = await tool.execute(pa.args, { pool, taskId: pa.task_id }); }
    catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
  }
  const success = !(result && typeof result === 'object' && 'error' in (result as object));
  await pool.query(`UPDATE pending_actions SET status=$2, result=$3, decided_at=now() WHERE id=$1`, [id, success ? 'executed' : 'failed', JSON.stringify(result)]);
  await pool.query(`UPDATE tasks SET status='done', updated_at=now() WHERE id=$1`, [pa.task_id]);
  const line = success ? `✅ Done — ${pa.tool} executed.` : `⚠ ${pa.tool} failed: ${JSON.stringify(result).slice(0, 200)}`;
  await say(line);
  trace.recordSafe({ traceId, taskId: pa.task_id, component: 'trust', event: success ? 'pending.executed' : 'pending.failed', payload: { tool: pa.tool } });
  return { ok: success, executed: success, line, result };
}

app.post('/pending/:id/decide', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { decision } = (req.body ?? {}) as { decision?: 'approved' | 'rejected' };
  if (decision !== 'approved' && decision !== 'rejected') return reply.code(400).send({ error: 'decision must be approved|rejected' });
  const out = await decidePendingAction(id, decision, req.traceId);
  if (out.httpCode) return reply.code(out.httpCode).send({ error: out.error });
  return out.rejected ? { ok: true, executed: false, rejected: true } : { ok: out.ok, executed: out.executed, result: out.result };
});

// ---------------------------------------------------------------------------
// M8 OS Interface: one aggregate powering the dashboard (live tasks, global
// approvals inbox, spend, notifications, jobs) + the task-inspector depth
// (trace timeline + tool-call audit). Read-only composition over existing data.
// ---------------------------------------------------------------------------
app.get('/dashboard', async () => {
  const [approvals, active, recent, notifs, jobs, spend, counts, pending] = await Promise.all([
    pool.query(
      `SELECT s.id AS step_id, s.title, s.tool, s.tool_args, s.created_at, t.id AS task_id, t.goal
       FROM steps s JOIN tasks t ON t.id = s.task_id
       WHERE s.kind = 'approval'
         AND s.status NOT IN ('done','failed','skipped')
         AND COALESCE(s.approval->>'status','pending') NOT IN ('approved','rejected')
         AND t.status IN ('planning','running','paused','awaiting_approval')
       ORDER BY s.created_at`,
    ),
    pool.query(
      `SELECT id, goal, status, spent, updated_at FROM tasks
       WHERE status IN ('planning','running','paused','awaiting_approval')
       ORDER BY updated_at DESC LIMIT 20`,
    ),
    pool.query(`SELECT id, goal, status, spent, created_at, updated_at FROM tasks ORDER BY updated_at DESC LIMIT 12`),
    pool.query(
      `SELECT (SELECT count(*) FROM notifications WHERE NOT read) AS unread,
              COALESCE((SELECT jsonb_agg(n) FROM (SELECT id, kind, title, read, created_at FROM notifications ORDER BY created_at DESC LIMIT 5) n), '[]'::jsonb) AS latest`,
    ),
    pool.query(
      `SELECT j.id, j.name, j.kind, j.enabled, j.next_run_at,
              (SELECT to_jsonb(r) FROM (SELECT status, started_at FROM job_runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1) r) AS last_run
       FROM jobs j ORDER BY j.next_run_at NULLS LAST`,
    ),
    pool.query(
      `SELECT COALESCE(SUM((spent->>'tokens')::bigint) FILTER (WHERE updated_at >= date_trunc('day', now())), 0) AS today,
              COALESCE(SUM((spent->>'tokens')::bigint), 0) AS total
       FROM tasks`,
    ),
    pool.query(`SELECT status, count(*)::int AS n FROM tasks GROUP BY status`),
    pool.query(`SELECT id, task_id, tool, args, untrusted_context, created_at FROM pending_actions WHERE status='pending' ORDER BY created_at`),
  ]);
  return {
    approvals: approvals.rows,
    pendingActions: pending.rows, // chat-queued irreversible actions awaiting one-click approval
    activeTasks: active.rows,
    recentTasks: recent.rows,
    notifications: { unread: Number(notifs.rows[0]!.unread), latest: notifs.rows[0]!.latest },
    jobs: jobs.rows,
    spend: { todayTokens: Number(spend.rows[0]!.today), totalTokens: Number(spend.rows[0]!.total) },
    taskCounts: Object.fromEntries(counts.rows.map((r: { status: string; n: number }) => [r.status, r.n])),
  };
});

// ---------------------------------------------------------------------------
// M9 Capability Packs (ADR-0012): manifests live in code; install state in DB.
// Install applies bundled policies + seeds procedural memories (provenance = the
// install task); enable/disable changes the composed tool surface immediately.
// ---------------------------------------------------------------------------
app.get('/packs', async () => ({ packs: await listPacks(pool) }));

// ---------------------------------------------------------------------------
// M10 Learning Loop (ADR-0014): the audit trail of self-improvements, and a
// manual trigger. A cycle proposes playbooks from recent failures and adopts one
// ONLY if the gym proves no regression. POST /learning/run runs the real gym
// (heavy + model-gated) — deliberately manual for now; a scheduled job comes next.
// ---------------------------------------------------------------------------
app.get('/improvements', async () => {
  const { rows } = await pool.query(
    `SELECT id, source, rationale, artifact, status, verdict, memory_id, created_at, decided_at
     FROM improvements ORDER BY created_at DESC LIMIT 100`,
  );
  const signals = await gatherFailureSignals(pool, 5);
  return { improvements: rows, failureSignals: { totalFailed: signals.totalFailed, recent: signals.failedTasks } };
});

app.post('/learning/run', async (req) => {
  const { autoAdopt } = (req.body ?? {}) as { autoAdopt?: boolean };
  // Runs the real LLM proposer + gym verifier. autoAdopt defaults to false here —
  // over HTTP we propose+verify and QUEUE, leaving adoption an explicit choice.
  return runLearningCycle(pool, { autoAdopt: autoAdopt ?? false });
});

app.post('/improvements/:id/adopt', async (req, reply) => {
  const { id } = req.params as { id: string };
  const imp = (await pool.query(`SELECT artifact, status, task_id FROM improvements WHERE id=$1`, [id])).rows[0] as
    | { artifact: { subject: string; content: string }; status: string; task_id: string }
    | undefined;
  if (!imp) return reply.code(404).send({ error: 'no such improvement' });
  if (imp.status === 'adopted') return { ok: true, alreadyAdopted: true };
  if (imp.status === 'rejected') return reply.code(409).send({ error: 'refusing to adopt a gym-rejected improvement' });
  const mem = await memory.remember({
    type: 'procedural', subject: imp.artifact.subject, content: imp.artifact.content,
    tags: ['learned'], source: { task_id: imp.task_id },
  });
  await pool.query(`UPDATE improvements SET status='adopted', memory_id=$2, decided_at=now() WHERE id=$1`, [id, mem.id]);
  trace.recordSafe({ traceId: req.traceId, component: 'learning', event: 'improvement.adopted', payload: { id, memoryId: mem.id } });
  return { ok: true, memoryId: mem.id };
});

app.post('/packs/:name/install', async (req, reply) => {
  const { name } = req.params as { name: string };
  if (!PACKS[name]) return reply.code(404).send({ error: `unknown pack "${name}"` });
  const result = await installPack(pool, name);
  enabledPacks = await loadEnabledPacks(pool);
  trace.recordSafe({ traceId: req.traceId, taskId: result.installTaskId, component: 'packs', event: 'pack.installed', payload: { name, version: result.version } });
  return result;
});

app.put('/packs/:name', async (req, reply) => {
  const { name } = req.params as { name: string };
  const { enabled } = (req.body ?? {}) as { enabled?: boolean };
  if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (boolean) is required' });
  const ok = await setPackEnabled(pool, name, enabled);
  if (!ok) return reply.code(404).send({ error: 'pack not installed' });
  enabledPacks = await loadEnabledPacks(pool);
  trace.recordSafe({ traceId: req.traceId, component: 'packs', event: enabled ? 'pack.enabled' : 'pack.disabled', payload: { name } });
  return { name, enabled };
});

app.get('/tasks/:id/trace', async (req, reply) => {
  const { id } = req.params as { id: string };
  const task = (await pool.query(`SELECT id, goal, status, spent, trace_id, created_at, updated_at FROM tasks WHERE id=$1`, [id])).rows[0];
  if (!task) return reply.code(404).send({ error: 'no such task' });
  const [toolCalls, events] = await Promise.all([
    pool.query(
      `SELECT tc.id, tc.tool, tc.args, tc.result, tc.trust_class, tc.approved_by, tc.duration_ms, tc.created_at,
              s.title AS step_title, s.local_id
       FROM tool_calls tc JOIN steps s ON s.id = tc.step_id
       WHERE s.task_id = $1 ORDER BY tc.created_at`,
      [id],
    ),
    pool.query(`SELECT ts, component, event, payload FROM trace_events WHERE task_id=$1 ORDER BY ts LIMIT 500`, [id]),
  ]);
  return { task, toolCalls: toolCalls.rows, events: events.rows };
});

// ---------------------------------------------------------------------------
// Trust policies (M5 §8.1): policies are data — the user can tighten/loosen per tool.
// ---------------------------------------------------------------------------
app.get('/policies', async () => {
  const { rows } = await pool.query(
    `SELECT tool, trust_class, auto_approve, updated_at FROM trust_policies ORDER BY tool`,
  );
  return { policies: rows };
});

app.put('/policies/:tool', async (req, reply) => {
  const { tool } = req.params as { tool: string };
  const { trustClass, autoApprove } = (req.body ?? {}) as { trustClass?: string; autoApprove?: boolean };
  const valid = ['read', 'write', 'irreversible', 'spend'];
  if (trustClass !== undefined && !valid.includes(trustClass)) return reply.code(400).send({ error: 'invalid trustClass' });
  const res = await pool.query(
    `UPDATE trust_policies
     SET trust_class = COALESCE($2, trust_class), auto_approve = COALESCE($3, auto_approve), updated_at = now()
     WHERE tool = $1 RETURNING tool, trust_class, auto_approve`,
    [tool, trustClass ?? null, autoApprove ?? null],
  );
  if (!res.rowCount) return reply.code(404).send({ error: 'no such policy' });
  trace.recordSafe({ traceId: req.traceId, component: 'trust', event: 'policy.changed', payload: { tool, trustClass, autoApprove } });
  return { policy: res.rows[0] };
});

// ---------------------------------------------------------------------------
// Planner + Task Graph (M4): plan a goal, inspect the graph, control the run.
// ---------------------------------------------------------------------------
app.post('/plan', async (req) => {
  const { text } = (req.body ?? {}) as { text?: string };
  if (!text?.trim()) return { error: 'text is required' };
  return planAndStart(pool, { goal: text.trim(), registry: packRegistry() });
});

app.get('/tasks', async () => {
  // parent_task_id lets the UI nest an orchestration's specialist children
  // under their parent (M11 tree view) instead of listing them flat.
  const { rows } = await pool.query(
    `SELECT id, goal, status, created_by, parent_task_id, created_at, updated_at FROM tasks ORDER BY created_at DESC LIMIT 50`,
  );
  return { tasks: rows };
});

app.get('/tasks/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const task = (await pool.query(`SELECT id, goal, status, spent, parent_task_id, untrusted, created_at, updated_at FROM tasks WHERE id=$1`, [id])).rows[0];
  if (!task) return reply.code(404).send({ error: 'no such task' });
  const steps = (
    await pool.query(
      `SELECT id, kind, title, local_id, depends_on, status, output, tool, tool_args, approval, error, created_at
       FROM steps WHERE task_id=$1 ORDER BY created_at`,
      [id],
    )
  ).rows;
  // M11: an orchestrated task's specialist subtasks, in creation order.
  const children = (
    await pool.query(`SELECT id, goal, status, untrusted, created_at FROM tasks WHERE parent_task_id=$1 ORDER BY created_at`, [id])
  ).rows;
  return { task, steps, children };
});

app.post('/tasks/:id/pause', async (req) => {
  const { id } = req.params as { id: string };
  await pauseTask(pool, id);
  return { ok: true, status: 'paused' };
});

app.post('/tasks/:id/resume', async (req) => {
  const { id } = req.params as { id: string };
  return resumeTask(pool, id, { registry: packRegistry() });
});

app.post('/tasks/:id/redirect', async (req) => {
  const { id } = req.params as { id: string };
  const { directive } = (req.body ?? {}) as { directive?: string };
  if (!directive?.trim()) return { error: 'directive is required' };
  await redirectTask(pool, id, directive.trim());
  return { ok: true };
});

app.post('/tasks/:id/approve', async (req) => {
  const { id } = req.params as { id: string };
  const { stepId, decision, note } = (req.body ?? {}) as { stepId?: string; decision?: 'approved' | 'rejected'; note?: string };
  if (!stepId || (decision !== 'approved' && decision !== 'rejected')) {
    return { error: 'stepId and decision (approved|rejected) are required' };
  }
  return decideApproval(pool, id, stepId, decision, note, { registry: packRegistry() });
});

// ---------------------------------------------------------------------------
// Boot: resume tasks orphaned by a mid-run kill (M1 exit criterion)
// ---------------------------------------------------------------------------
const port = Number(process.env.API_PORT ?? 4000);
enabledPacks = await loadEnabledPacks(pool); // before listen: routes + resume + scheduler all compose from it
app.log.info({ packs: [...enabledPacks] }, 'capability packs enabled');
await app.listen({ port, host: '127.0.0.1' });

void (async () => {
  const orphans = await findOrphanedTasks(pool);
  for (const taskId of orphans) {
    // M11 checkpoint-resume: an orchestration parent resumes from its persisted
    // plan (tasks.agent_plan, migration 0015) — existing children are re-driven,
    // NEVER re-planned (re-planning duplicated children live 2026-07-10). An
    // agent CHILD is skipped when its parent is being resumed (the parent's
    // orchestrator re-runs it from its own checkpoint); only a child with no
    // live parent is dead work. No usable plan → the old fail-honest path.
    const shape = (
      await pool.query<{ created_by: string; has_children: boolean; has_plan: boolean; parent_active: boolean }>(
        `SELECT created_by::text,
                EXISTS(SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id) AS has_children,
                t.agent_plan IS NOT NULL AS has_plan,
                EXISTS(SELECT 1 FROM tasks p WHERE p.id = t.parent_task_id AND p.status IN ('running','planning')) AS parent_active
         FROM tasks t WHERE t.id = $1`,
        [taskId],
      )
    ).rows[0];
    if (shape && shape.created_by === 'agent') {
      if (shape.parent_active) {
        app.log.info({ taskId }, 'orphaned agent child left to its parent orchestration resume');
        continue;
      }
      await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
      app.log.warn({ taskId }, 'orphaned agent child with no live parent marked failed');
      continue;
    }
    if (shape && shape.has_children) {
      const sess = (await pool.query<{ session_id: string }>(`SELECT session_id FROM messages WHERE task_id=$1 AND role='user' LIMIT 1`, [taskId])).rows[0]?.session_id;
      const say = sess ? async (content: string) => { await addMessage(pool, { sessionId: sess, role: 'assistant', content, taskId }); } : undefined;
      if (shape.has_plan) {
        app.log.info({ taskId }, 'resuming orphaned orchestration from persisted plan');
        trace.recordSafe({ traceId: newTraceId(), taskId, component: 'api', event: 'task.resume_on_boot', payload: { orchestration: true } });
        resumeAgentTask(pool, taskId, { registry: packRegistry(), extraSystem: packPrompt(), say })
          .then(async (result) => {
            if (result) {
              if (say && result.text) await say(result.text);
              return;
            }
            // Plan turned out unusable (malformed/agent renamed) — fail honestly.
            await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
            if (say) await say('⚠ A restart interrupted this multi-agent run and its plan could not be recovered — please ask again.');
            app.log.warn({ taskId }, 'orchestration resume found no usable plan; marked failed');
          })
          .catch((err) => app.log.error({ err, taskId }, 'orchestration resume failed'));
        continue;
      }
      await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
      if (say) await say('⚠ A restart interrupted this multi-agent run — please ask again.');
      app.log.warn({ taskId }, 'orphaned orchestration without a persisted plan marked failed');
      continue;
    }
    // Route by shape: a task with planner-authored steps (local_id set) is a
    // graph task → resume via runGraph (skips done steps, exactly-once); a plain
    // chat task → runTask. Both are durable-resumable. agentMode 'off': a resumed
    // chat task continues from its checkpoint — re-classifying it into a fresh
    // orchestration would discard that state.
    const isGraph = (await pool.query(`SELECT 1 FROM steps WHERE task_id=$1 AND local_id IS NOT NULL LIMIT 1`, [taskId])).rowCount ?? 0;
    app.log.info({ taskId, isGraph: !!isGraph }, 'resuming orphaned task');
    trace.recordSafe({ traceId: newTraceId(), taskId, component: 'api', event: 'task.resume_on_boot', payload: { graph: !!isGraph } });
    const p = isGraph ? runGraph(pool, taskId, { registry: packRegistry() }) : completeChatTask(taskId, 'off');
    Promise.resolve(p).catch((err) => app.log.error({ err, taskId }, 'orphan resume failed'));
  }
})();

// M7: the scheduler heartbeat. Ticks every SCHEDULER_POLL_MS (default 30s); due
// jobs run their fixed pipelines; zombies from a previous crash are reaped on the
// first tick (the jobs analog of the orphan-resume above).
startScheduler(pool, {
  executors: defaultExecutors(),
  registry: packRegistry, // factory — pack toggles apply to future ticks without restart
  onTick: (r) => app.log.info({ claimed: r.claimed, reaped: r.reaped, missed: r.missed, ran: r.ran }, 'scheduler tick'),
});

// ---------------------------------------------------------------------------
// M12a — WhatsApp remote control (ADR-0015): poll the self-chat through the
// bridge for "@os" commands from Akhil's own number; run them through the
// ordinary chat trust path; replies + approval prompts go back over the
// bridge. Replies are interface plumbing (deterministic code), NOT a model
// capability — whatsapp_send_message still queues for approval. Kill switch:
// AIOS_WA_REMOTE=off. Bridge down/unpaired → silent no-op each tick.
// ---------------------------------------------------------------------------
if ((process.env.AIOS_WA_REMOTE ?? 'on') !== 'off') {
  const WA_TRIGGER = process.env.AIOS_WA_TRIGGER ?? '@os';
  const waBridge = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const base = process.env.WHATSAPP_BRIDGE_URL ?? 'http://127.0.0.1:4100';
    const token = process.env.WHATSAPP_BRIDGE_TOKEN;
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(token ? { 'x-bridge-token': token } : {}), ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`bridge ${res.status}`);
    return (await res.json()) as T;
  };

  // The remote channel gets its own session — phone commands show up in the
  // UIs as a "WhatsApp remote" conversation, fully auditable.
  const ensureRemoteSession = async (): Promise<string> => {
    const existing = (await pool.query<{ session_id: string | null }>(`SELECT session_id FROM remote_channels WHERE channel='whatsapp'`)).rows[0];
    if (existing?.session_id) return existing.session_id;
    const s = (await pool.query<{ id: string }>(`INSERT INTO sessions (title) VALUES ('WhatsApp remote') RETURNING id`)).rows[0]!.id;
    await pool.query(
      `INSERT INTO remote_channels (channel, session_id) VALUES ('whatsapp', $1)
       ON CONFLICT (channel) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = now()`,
      [s],
    );
    return s;
  };

  let inFlight = false; // a slow tick (model call) must not stack on the next interval
  const deps = {
    trigger: WA_TRIGGER,
    health: () => waBridge<{ ok: boolean; paired: boolean; me?: string }>('/health'),
    messages: (chatId: string, limit: number) =>
      waBridge<{ messages: Array<{ id: string; fromMe: boolean; text: string; timestamp: string }> }>(
        `/messages?chatId=${encodeURIComponent(chatId)}&limit=${limit}`,
      ).then((r) => r.messages),
    send: (chatId: string, text: string) => waBridge<{ messageId?: string }>('/send', { method: 'POST', body: JSON.stringify({ chatId, text }) }),
    runCommand: async (text: string): Promise<string> => {
      const sessionId = await ensureRemoteSession();
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1, 'draft', 'user', $2) RETURNING id`,
        [text, newTraceId()],
      );
      const taskId = rows[0]!.id;
      await addMessage(pool, { sessionId, role: 'user', content: text, taskId });
      await completeChatTask(taskId, 'auto');
      const msgs = await listMessages(pool, sessionId);
      const reply = msgs.filter((m) => m.task_id === taskId && m.role === 'assistant').at(-1);
      return reply?.content ?? '(the task ran but produced no reply — check the Tasks page)';
    },
    decidePending: async (idPrefix: string, decision: 'approved' | 'rejected'): Promise<string> => {
      const matches = (
        await pool.query<{ id: string }>(
          `SELECT id FROM pending_actions WHERE status='pending' AND replace(id::text, '-', '') LIKE $1 || '%'`,
          [idPrefix.replace(/-/g, '')],
        )
      ).rows;
      if (matches.length === 0) return '⚠ No pending approval matches that id.';
      if (matches.length > 1) return '⚠ That id matches more than one pending approval — use more characters.';
      return (await decidePendingAction(matches[0]!.id, decision, newTraceId())).line;
    },
    listPending: async () =>
      (
        await pool.query<{ id: string; tool: string; args: unknown; untrusted: boolean }>(
          `SELECT id, tool, args, untrusted_context AS untrusted FROM pending_actions WHERE status='pending' ORDER BY created_at`,
        )
      ).rows,
    loadCursor: async (): Promise<RemoteCursor> => {
      const row = (await pool.query<{ cursor: Partial<RemoteCursor> | null }>(`SELECT cursor FROM remote_channels WHERE channel='whatsapp'`)).rows[0];
      const c = row?.cursor ?? {};
      return { lastTs: c.lastTs ?? null, seenIds: c.seenIds ?? [], announced: c.announced ?? [] };
    },
    saveCursor: async (c: RemoteCursor): Promise<void> => {
      await pool.query(
        `INSERT INTO remote_channels (channel, cursor) VALUES ('whatsapp', $1::jsonb)
         ON CONFLICT (channel) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
        [JSON.stringify(c)],
      );
    },
  };
  setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    tickRemote(deps)
      .then((r) => {
        if (r.processed || r.announced) app.log.info(r, 'wa-remote tick');
      })
      .catch((err) => app.log.debug({ err: err instanceof Error ? err.message : err }, 'wa-remote tick skipped (bridge down?)'))
      .finally(() => {
        inFlight = false;
      });
  }, Number(process.env.AIOS_WA_POLL_MS) || 12_000);
  app.log.info({ trigger: WA_TRIGGER }, 'whatsapp remote control enabled (self-chat commands)');
}
