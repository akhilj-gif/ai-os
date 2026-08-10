// Fastify gateway (blueprint §10). M1: Google OAuth, chat → executor loop,
// resume-on-boot for orphaned tasks, and the tracing invariant — EVERY request
// gets a trace_id and a trace_events row.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
// Load the workspace-root .env regardless of which package cwd we run under.
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import { randomUUID, createHash } from 'node:crypto';
import { captureScreen } from '@ai-os/tools';
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
  assembleMemoryContext,
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
  startCoordinator,
  type CoordinatorReport,
  defaultExecutors,
  runLearningCycle,
  gatherFailureSignals,
  tickRemote,
  type RemoteCursor,
  type Schedule,
} from '@ai-os/kernel';
import { MemoryService, recordExperience, updateKnowledgeGraph, memoryAnalytics, cognitiveBriefing, consolidateInsights } from '@ai-os/memory';
import { failoverChain, transcribe, synthesize, callModel, describeImages } from '@ai-os/model-router';
import { composeRegistry, packPrompts, loadEnabledPacks, installPack, setPackEnabled, listPacks, PACKS, uberConfigured, uberAuthorizeUrl, exchangeUberCode, forgePack, installDynamicPack, listStagedPacks } from '@ai-os/packs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const memory = new MemoryService(pool);
// M9: the runtime tool surface is composed from ENABLED capability packs (loaded
// at boot, refreshed on install/toggle). Kernel-core = workspace only.
let enabledPacks = new Set<string>();
let lastCoordinatorReport: CoordinatorReport | null = null; // M16: latest tick, for GET /coordinator/status
const packRegistry = () => {
  const r = composeRegistry(enabledPacks);
  // M20 meta-tools: the OS can forge new packs from chat. pack_forge only
  // STAGES source (inert, reviewable); pack_install activates and is
  // irreversible-class + never-auto, so the approval card IS the human gate.
  r.register({
    name: 'pack_forge',
    untrustedOutput: false,
    description:
      'Build a NEW capability pack (new tools) for a capability the OS lacks — e.g. "a dictionary API tool". Writes and verifies the pack code, then STAGES it (inactive). Nothing runs until the user installs it via pack_install. Report the staged pack name, its tools, and that it awaits their install approval.',
    inputSchema: {
      type: 'object',
      properties: { request: { type: 'string', description: "What capability to build, in the user's words (include the API to use if they named one)." } },
      required: ['request'],
    },
    async execute(args, ctx) {
      try {
        const res = await forgePack(String(args.request ?? ''), { traceId: newTraceId(), taskId: ctx.taskId, staticPackNames: Object.keys(PACKS) });
        return { staged: res.name, tools: res.toolNames, description: res.description, requires: res.requires, rounds: res.rounds, next: 'Ask the user to review and install with pack_install (their approval card is the activation gate).' };
      } catch (err) {
        return { error: err instanceof Error ? err.message.slice(0, 600) : String(err) };
      }
    },
  });
  r.register({
    name: 'pack_install',
    untrustedOutput: false,
    description:
      'ACTIVATE a previously staged (forged) pack by name — its tools become live. Requires the user\'s one-click approval; call it directly once they ask, the approval card is the confirmation.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Staged pack name (from pack_forge).' } },
      required: ['name'],
    },
    async execute(args) {
      try {
        const res = await installDynamicPack(pool, String(args.name ?? ''), Object.keys(PACKS));
        enabledPacks = await loadEnabledPacks(pool); // recompose so the new tools are live next call
        return { installed: res.name, tools: res.tools, note: 'Every tool in this pack requires one-click approval per call until the user relaxes its policy in /settings.' };
      } catch (err) {
        return { error: err instanceof Error ? err.message.slice(0, 600) : String(err) };
      }
    },
  });
  return r;
};
const packPrompt = () =>
  packPrompts(enabledPacks) +
  '\n[forge] If the user asks for a capability no current tool provides and it could be served by a public web API, offer to BUILD it: call pack_forge with their request. After it stages, tell them the pack name/tools and that installing needs their approval (pack_install).';
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});
const trace = new TraceStore(pool);

// 20MB: chat attachments (images) travel as base64 JSON, well above Fastify's 1MB default.
const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
  }
}

// API authentication (2026-07-26 security hardening). Every endpoint requires a
// shared secret (x-aios-token === AIOS_API_TOKEN) EXCEPT /health and the OAuth
// browser-redirect routes (which the browser opens directly and cannot carry a
// header — they have their own CSRF state guard). This closes the loopback
// self-approval hole: without it any local process could POST /pending/:id/decide
// or /chat and act as the user. The UI reaches the API only through the Vite/Next
// proxies, which inject the header server-side (the browser never sees the token).
const API_TOKEN = (process.env.AIOS_API_TOKEN ?? '').trim();
let warnedNoAuth = false;
const authExempt = (path: string): boolean => path === '/health' || path.startsWith('/oauth/');

// Coarse per-IP rate-limit backstop (2026-07-26 audit). The API is loopback-only
// so this is effectively one bucket; the ceiling is far above any real UI burst
// and only ever trips on a runaway/abusive caller flooding the kernel.
const RL_WINDOW_MS = 10_000;
const RL_MAX = 1500;
const rlBuckets = new Map<string, { count: number; resetAt: number }>();

// Single error envelope (2026-07-26 hardening): any uncaught throw becomes a
// consistent {error, traceId} response tied to the request's trace, instead of
// Fastify's default 500 leaking raw pg/error text. Thrown errors that carry a
// 4xx/5xx statusCode keep it; everything else is a clean, non-leaking 500.
app.setErrorHandler((error, req, reply) => {
  const err = error as { statusCode?: number; message?: string };
  const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  req.log.error({ err: error, traceId: req.traceId }, 'unhandled request error');
  return reply.code(status).send({ error: status === 500 ? 'internal error' : (err.message ?? 'error'), traceId: req.traceId });
});

app.addHook('onRequest', async (req, reply) => {
  req.traceId = (req.headers['x-trace-id'] as string | undefined) ?? newTraceId();
  reply.header('x-trace-id', req.traceId);
  trace.recordSafe({
    traceId: req.traceId,
    component: 'api',
    event: 'http.request',
    payload: { method: req.method, url: req.url },
  });

  // Rate-limit backstop (runs before auth so unauthenticated floods are capped too).
  const now = Date.now();
  const bucket = rlBuckets.get(req.ip);
  if (!bucket || now > bucket.resetAt) {
    rlBuckets.set(req.ip, { count: 1, resetAt: now + RL_WINDOW_MS });
  } else if (++bucket.count > RL_MAX) {
    return reply.code(429).send({ error: 'rate limit exceeded' });
  }

  const path = req.url.split('?')[0]!;
  if (authExempt(path)) return;
  if (!API_TOKEN) {
    // Fail-open ONLY when no token is configured, so a fresh install isn't bricked
    // — but make it loud so it is never silently insecure (the ADR-0021 bridge bug).
    if (!warnedNoAuth) {
      warnedNoAuth = true;
      req.log.warn('SECURITY: AIOS_API_TOKEN is not set — API authentication is DISABLED. Set it in .env and restart to secure every endpoint.');
    }
    return;
  }
  const provided = req.headers['x-aios-token'];
  if (provided !== API_TOKEN) {
    trace.recordSafe({ traceId: req.traceId, component: 'api', event: 'http.unauthorized', payload: { method: req.method, path } });
    return reply.code(401).send({ error: 'unauthorized: missing or invalid x-aios-token' });
  }
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
    signal: AbortSignal.timeout(10_000),
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
  // Perf (2026-07-11): classifyGoal (routing-tier model call) and the memory-
  // context embed+recall are INDEPENDENT — neither needs the other's result —
  // but ran sequentially before. Kick memory off in parallel and hand runTask
  // the finished value, skipping its own internal recall. Only worth starting
  // when 'auto' will actually reach runTask afterward: 'off' (boot-resume) has
  // its own checkpoint memory already, and 'force' goes straight to
  // runAgentTask, which doesn't consume a memory block — starting the fetch in
  // either case would just be wasted work with nothing to hand it to.
  let precomputedMemory: string | undefined;
  if (process.env.AIOS_AGENTS !== 'off' && agentMode !== 'off') {
    if (agentMode === 'force') useAgents = true;
    else {
      const t = await pool.query<{ goal: string; trace_id: string }>(`SELECT goal, trace_id FROM tasks WHERE id=$1`, [taskId]);
      const goal = t.rows[0];
      if (goal) {
        const memT0 = Date.now();
        const [classification, memory] = await Promise.all([
          classifyGoal(goal.goal, goal.trace_id),
          assembleMemoryContext(pool, { goal: goal.goal }).catch((err) => {
            console.warn('[api] memory context failed (non-fatal):', err instanceof Error ? err.message : err);
            return '';
          }),
        ]);
        console.log(`[latency] classifyGoal+memoryContext taskId=${taskId} ms=${Date.now() - memT0}`);
        useAgents = classification === 'complex';
        precomputedMemory = memory;
      }
    }
  }

  const result = useAgents
    ? await runAgentTask(pool, taskId, {
        registry: packRegistry(),
        extraSystem: packPrompt(),
        say: async (content) => { await addMessage(pool, { sessionId, role: 'assistant', content, taskId }); },
      })
    : await runTask(pool, taskId, { registry: packRegistry(), extraSystem: packPrompt(), enableMemory: true, history: prior, precomputedMemory });
  await addMessage(pool, { sessionId, role: 'assistant', content: result.text, taskId });

  // Learn from doing (Memory OS Phase 1): distill this task's execution into an
  // episodic memory (+ a failure memory with cause/prevention if it failed), so
  // similar future tasks recall the experience. Fire-and-forget — it must never
  // hold up the reply, and it's internally best-effort (mirrors extractAndStore).
  void recordExperience(pool, { taskId, replyText: result.text }).catch((err) =>
    console.warn('[api] experience capture failed (non-fatal):', err instanceof Error ? err.message : err),
  );

  // Knowledge Graph (Memory OS Phase 3): extract entities + relations from the
  // exchange into kg_nodes/kg_edges so the OS can reason over connections.
  // Fire-and-forget; the task goal is the user's actual intent for this task.
  void pool
    .query<{ goal: string; trace_id: string }>(`SELECT goal, trace_id FROM tasks WHERE id = $1`, [taskId])
    .then(({ rows }) => {
      const t = rows[0];
      if (t) return updateKnowledgeGraph(pool, { taskId, traceId: t.trace_id, userText: t.goal, assistantText: result.text });
    })
    .catch((err) => console.warn('[api] knowledge-graph update failed (non-fatal):', err instanceof Error ? err.message : err));
}

interface ChatAttachment {
  name: string;
  mime: string;
  dataUrl: string; // data:<mime>;base64,<...> — read client-side via FileReader
}

// Thorough vision instruction: OCR + structured extraction (tables → markdown,
// charts described with their data), object/UI notes, and multi-image compare.
// Gemini 2.5 Flash handles all of these; the digest becomes the executor's
// goal text, so richer here = better answers downstream.
function visionInstruction(userText: string, imageCount: number): string {
  return [
    userText ? `The user asks: "${userText}"` : '',
    'Analyze the image(s) thoroughly:',
    '- Transcribe ALL visible text verbatim (OCR), preserving layout/order.',
    '- Render any tables as markdown tables; describe charts/graphs with their data points.',
    '- Note key objects, people, UI elements, or data shown.',
    imageCount > 1 ? '- Address each image in order, and compare them if the request implies a comparison.' : '',
    userText ? 'Then answer the user’s question directly from what you see.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Turns uploaded images/files into text the existing (text-only) executor can
// reason over: images go through real Gemini vision, small text-like files are
// decoded inline. No executor/kernel changes needed — this only shapes the
// goal text that runTask() already reads verbatim (executor.ts:196).
async function describeAttachments(attachments: ChatAttachment[], userText: string, reused = false): Promise<string> {
  const images = attachments.filter((a) => a.mime.startsWith('image/'));
  const files = attachments.filter((a) => !a.mime.startsWith('image/'));
  const parts: string[] = [];
  const tag = reused ? 'Image attachment(s), previously shown' : 'Image attachment(s)';
  if (images.length) {
    try {
      const desc = await describeImages(images, visionInstruction(userText, images.length));
      parts.push(`[${tag}: ${images.map((i) => i.name).join(', ')}]\n${desc}`);
    } catch (err) {
      parts.push(`[${tag}: ${images.map((i) => i.name).join(', ')} — could not be analyzed: ${err instanceof Error ? err.message : String(err)}]`);
    }
  }
  for (const f of files) {
    try {
      const base64 = f.dataUrl.slice(f.dataUrl.indexOf(',') + 1);
      const content = Buffer.from(base64, 'base64').toString('utf8').slice(0, 8000);
      parts.push(`[File attachment: ${f.name}]\n${content}`);
    } catch {
      parts.push(`[File attachment: ${f.name} — could not be read as text]`);
    }
  }
  return [userText, ...parts].filter(Boolean).join('\n\n');
}

// Multi-turn image memory: keep the most recent turn's images per session so
// a follow-up ("zoom the top-left", "what's in the 2nd row") can re-run vision
// on the SAME image instead of losing it after one reply. In-memory + bounded
// (20 min TTL) — a convenience cache, not durable state.
const RECENT_IMAGES = new Map<string, { images: ChatAttachment[]; at: number }>();
const RECENT_IMAGE_TTL_MS = 20 * 60 * 1000;
// Precise on purpose: an explicit visual noun or a spatial/zoom verb — NOT bare
// "it/this" (which would re-analyze the old image on unrelated follow-ups).
const VISUAL_REF_RE = /\b(image|picture|photo|pic|screenshot|diagram|chart|graph|logo|shown|zoom|crop|(top|bottom)[- ]?(left|right)|the (top|bottom|left|right|first|second|third|last))\b/i;

function rememberImages(sessionId: string, attachments: ChatAttachment[]): void {
  const images = attachments.filter((a) => a.mime.startsWith('image/'));
  if (images.length) RECENT_IMAGES.set(sessionId, { images, at: Date.now() });
}
function recallImages(sessionId: string): ChatAttachment[] | null {
  const e = RECENT_IMAGES.get(sessionId);
  if (!e) return null;
  if (Date.now() - e.at > RECENT_IMAGE_TTL_MS) {
    RECENT_IMAGES.delete(sessionId);
    return null;
  }
  return e.images;
}

app.post('/chat', async (req) => {
  const { text, sessionId, agentMode, attachments } = (req.body ?? {}) as {
    text?: string;
    sessionId?: string;
    agentMode?: 'auto' | 'force' | 'off';
    attachments?: ChatAttachment[];
  };
  const trimmed = text?.trim() ?? '';
  if (!trimmed && !attachments?.length) return { error: 'text or an attachment is required' };
  // Robustness: a passed sessionId must be a real session, else fall back to the
  // default — a bad/unknown id used to FK-violate on addMessage and silently 500.
  let session = await ensureDefaultSession(pool);
  if (sessionId) {
    const ok = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]).catch(() => ({ rowCount: 0 }));
    if (ok.rowCount) session = sessionId;
  }

  // Attachments → vision digest; remember the images for follow-ups. With no
  // new attachment but a visual reference, re-run vision on the last images.
  let goal = trimmed;
  if (attachments?.length) {
    rememberImages(session, attachments);
    goal = await describeAttachments(attachments, trimmed);
  } else if (trimmed && VISUAL_REF_RE.test(trimmed)) {
    const prior = recallImages(session);
    if (prior) goal = await describeAttachments(prior, trimmed, true);
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1, 'draft', 'user', $2) RETURNING id`,
    [goal, req.traceId],
  );
  const taskId = rows[0]!.id;
  await addMessage(pool, { sessionId: session, role: 'user', content: goal, taskId });

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

// Memory OS Phase 5: analytics snapshot for the dashboard.
app.get('/memory/analytics', async () => memoryAnalytics(pool));

// Memory OS Phase 6 — the Cognitive Layer. The OS thinks about what it knows:
// a forward-looking briefing (predictions / proactive suggestions / questions),
// and on-demand consolidation of experience into generalized insights.
// The briefing is an LLM call, so it's cached (10 min) — it must not fire on
// every page load; "Think now" (consolidate) invalidates it for a fresh one.
let briefingCache: { at: number; data: Awaited<ReturnType<typeof cognitiveBriefing>> } | null = null;
app.get('/cognition/briefing', async (req) => {
  const refresh = (req.query as { refresh?: string }).refresh === '1';
  if (!refresh && briefingCache && Date.now() - briefingCache.at < 10 * 60 * 1000) return briefingCache.data;
  const data = await cognitiveBriefing(pool, { traceId: req.traceId });
  briefingCache = { at: Date.now(), data };
  return data;
});
app.post('/cognition/consolidate', async (req) => {
  const r = await consolidateInsights(pool, { traceId: req.traceId });
  briefingCache = null; // new insights → next briefing regenerates fresh
  trace.recordSafe({ traceId: req.traceId, component: 'memory', event: 'cognition.consolidated', payload: { synthesized: r.synthesized } });
  return r;
});

// ---------------------------------------------------------------------------
// Tier 2 — runtime settings + autopilot (graduated-trust autonomy).
// ---------------------------------------------------------------------------
async function getSetting(key: string, fallback = 'off'): Promise<string> {
  const { rows } = await pool.query<{ value: string }>(`SELECT value FROM os_settings WHERE key = $1`, [key]);
  return rows[0]?.value ?? fallback;
}
async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO os_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

app.get('/settings', async () => {
  const { rows } = await pool.query<{ key: string; value: string }>(`SELECT key, value FROM os_settings ORDER BY key`);
  return { settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
});
app.put('/settings/:key', async (req) => {
  const { key } = req.params as { key: string };
  const { value } = (req.body ?? {}) as { value?: string };
  if (typeof value !== 'string') return { error: 'value (string) is required' };
  await setSetting(key, String(value));
  return { ok: true, key, value };
});

// Autopilot: when enabled ('read'), the OS runs its OWN top read-safe foresight
// suggestions in READ-ONLY mode (executor refuses any mutate/send/spend), so it
// makes itself useful unattended without ever taking an irreversible action.
// Returns what it did; each run becomes an episode that feeds cognition back.
// Autonomy governor (Tier 4-2): a hard daily ceiling on UNATTENDED activity
// (autopilot cycles + standing-goal advances = tasks created_by='trigger'), so a
// loop or a bad day can never burn the machine's quota or spam actions. Checked
// before every autonomous run; the user's own requests are never counted/capped.
const AUTONOMY_DEFAULT_MAX = 20;
async function autonomyBudget(): Promise<{ used: number; max: number; ok: boolean }> {
  const parsed = Number(await getSetting('autonomy_daily_max', String(AUTONOMY_DEFAULT_MAX)));
  const max = Number.isFinite(parsed) && parsed >= 0 ? parsed : AUTONOMY_DEFAULT_MAX; // 0 is valid = pause all autonomy
  const used = Number(
    (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE created_by = 'trigger' AND created_at::date = now()::date`)).rows[0]?.n ?? 0,
  );
  return { used, max, ok: used < max };
}
app.get('/governor', async () => autonomyBudget());

async function runAutopilotCycle(traceId: string): Promise<{ mode: string; ran: Array<{ action: string; status: string; text: string }>; note?: string }> {
  const mode = await getSetting('autopilot');
  // 'read' = read-only (writes refused); 'propose' = graduated write autonomy
  // (writes QUEUE as pending approvals for the user to review, never auto-run).
  if (mode !== 'read' && mode !== 'propose') return { mode, ran: [] };
  const budget = await autonomyBudget();
  if (!budget.ok) return { mode, ran: [], note: `daily autonomy budget reached (${budget.used}/${budget.max}) — try again tomorrow or raise it in Settings` };
  const readOnly = mode === 'read';
  const briefing = await cognitiveBriefing(pool, { traceId });
  const actions = briefing.suggestions.filter((s) => s.action).slice(0, 2);
  const ran: Array<{ action: string; status: string; text: string }> = [];
  for (const s of actions) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1, 'draft', 'trigger', $2) RETURNING id`,
      [s.action, traceId],
    );
    const taskId = rows[0]!.id;
    const r = await runTask(pool, taskId, { registry: packRegistry(), extraSystem: packPrompt(), enableMemory: true, readOnly });
    ran.push({ action: s.action!, status: r.status, text: r.text.slice(0, 400) });
    void recordExperience(pool, { taskId, replyText: r.text }).catch(() => undefined);
  }
  if (ran.length) {
    await pool.query(`INSERT INTO notifications (kind, title, body) VALUES ('autopilot', $1, $2)`, [
      `🤖 Autopilot ran ${ran.length} read-only action${ran.length === 1 ? '' : 's'}`,
      ran.map((r) => `• ${r.action}\n  → ${r.text}`).join('\n\n'),
    ]);
  }
  return { mode, ran };
}
app.post('/cognition/autopilot', async (req) => runAutopilotCycle(req.traceId));

// ---------------------------------------------------------------------------
// Tier 2-C — Standing agents: long-horizon goals the OS advances one safe
// (read-only) step at a time, between sessions. Advancing runs the executor in
// readOnly mode, so a step can research/inspect/draft but never mutate/send.
// ---------------------------------------------------------------------------
interface StandingGoalRow { id: string; goal: string; status: string; cadence_minutes: number; progress: string; steps: number; last_advanced_at: string | null; }

async function advanceStandingGoal(g: StandingGoalRow, traceId: string): Promise<{ step: string; status: string }> {
  const prompt =
    `You are advancing a LONG-HORIZON standing goal one small step at a time — this run does the SINGLE next useful READ-ONLY step (research, inspect, gather, draft), then reports.\n\n` +
    `GOAL: ${g.goal}\n\nPROGRESS SO FAR:\n${g.progress || '(nothing yet — this is the first step)'}\n\n` +
    `Do the next read-only step now. Then reply with 1-2 sentences: what you did this step and what the next step should be. If the goal needs a mutating/sending/spending action, DESCRIBE it for the user to approve — do not attempt it.`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (goal, status, created_by, trace_id) VALUES ($1, 'draft', 'trigger', $2) RETURNING id`,
    [prompt, traceId],
  );
  const taskId = rows[0]!.id;
  const r = await runTask(pool, taskId, { registry: packRegistry(), extraSystem: packPrompt(), enableMemory: true, readOnly: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const entry = `[${stamp}] ${r.text.slice(0, 400).replace(/\s+/g, ' ')}`;
  await pool.query(
    `UPDATE standing_goals SET progress = (CASE WHEN progress = '' THEN $2 ELSE progress || E'\\n' || $2 END), steps = steps + 1, last_advanced_at = now() WHERE id = $1`,
    [g.id, entry],
  );
  return { step: entry, status: r.status };
}

/** Advance every active standing goal whose cadence is due. Gated on autopilot. */
async function advanceDueStandingGoals(traceId: string): Promise<number> {
  const mode = await getSetting('autopilot');
  if (mode !== 'read' && mode !== 'propose') return 0;
  if (!(await autonomyBudget()).ok) return 0; // respect the daily autonomy ceiling
  const { rows } = await pool.query<StandingGoalRow>(
    `SELECT * FROM standing_goals
     WHERE status = 'active'
       AND (last_advanced_at IS NULL OR last_advanced_at < now() - (cadence_minutes || ' minutes')::interval)
     ORDER BY last_advanced_at ASC NULLS FIRST LIMIT 2`,
  );
  for (const g of rows) await advanceStandingGoal(g, traceId).catch((e) => console.warn('[standing] advance failed:', e instanceof Error ? e.message : e));
  return rows.length;
}

app.get('/standing', async () => {
  const { rows } = await pool.query(`SELECT id, goal, status, cadence_minutes, steps, progress, last_advanced_at, created_at FROM standing_goals ORDER BY created_at DESC`);
  return { goals: rows };
});
app.post('/standing', async (req) => {
  const { goal, cadenceMinutes } = (req.body ?? {}) as { goal?: string; cadenceMinutes?: number };
  if (!goal?.trim()) return { error: 'goal is required' };
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO standing_goals (goal, cadence_minutes) VALUES ($1, $2) RETURNING id`,
    [goal.trim(), Number.isFinite(cadenceMinutes) ? Math.max(30, Number(cadenceMinutes)) : 360],
  );
  return { ok: true, id: rows[0]!.id };
});
app.patch('/standing/:id', async (req) => {
  const { id } = req.params as { id: string };
  const { status } = (req.body ?? {}) as { status?: string };
  if (!['active', 'paused', 'done'].includes(String(status))) return { error: 'status must be active|paused|done' };
  await pool.query(`UPDATE standing_goals SET status = $2 WHERE id = $1`, [id, status]);
  return { ok: true };
});
// Advance ONE goal now (manual — user-initiated, so it runs regardless of cadence/autopilot).
app.post('/standing/:id/advance', async (req) => {
  const { id } = req.params as { id: string };
  const { rows } = await pool.query<StandingGoalRow>(`SELECT * FROM standing_goals WHERE id = $1`, [id]);
  if (!rows[0]) return { error: 'no such standing goal' };
  return advanceStandingGoal(rows[0], req.traceId);
});

// ---------------------------------------------------------------------------
// Tier 2-B — proactive delivery: push undelivered notifications (morning
// briefing, watch alerts, autopilot summaries) to the user's WhatsApp
// self-chat, so the OS reaches out FIRST. Gated by proactive_delivery=on and
// only when the bridge is paired. Best-effort — bridge down = try again later.
// ---------------------------------------------------------------------------
async function deliverProactiveNotifications(): Promise<{ sent: number; skipped?: string }> {
  if ((await getSetting('proactive_delivery')) !== 'on') return { sent: 0, skipped: 'disabled' };
  const base = process.env.WHATSAPP_BRIDGE_URL ?? 'http://127.0.0.1:4100';
  const token = process.env.WHATSAPP_BRIDGE_TOKEN;
  const headers = { 'content-type': 'application/json', ...(token ? { 'x-bridge-token': token } : {}) };
  const health = (await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { paired?: boolean; me?: string } | null;
  if (!health?.paired || !health.me) return { sent: 0, skipped: 'bridge not paired' };
  const self = health.me.includes('@') ? health.me : `${health.me}@s.whatsapp.net`;
  const { rows } = await pool.query<{ id: string; title: string; body: string }>(
    `SELECT id, title, body FROM notifications WHERE delivered_wa = false ORDER BY created_at LIMIT 5`,
  );
  let sent = 0;
  for (const n of rows) {
    const text = `🔔 ${n.title}\n\n${n.body}`.slice(0, 1500);
    const ok = await fetch(`${base}/send`, { method: 'POST', headers, body: JSON.stringify({ chatId: self, text }), signal: AbortSignal.timeout(10_000) })
      .then((r) => r.ok)
      .catch(() => false);
    await pool.query(`UPDATE notifications SET delivered_wa = $2 WHERE id = $1`, [n.id, ok]);
    if (ok) sent++;
  }
  return { sent };
}
app.post('/notifications/deliver', async () => deliverProactiveNotifications());

// ---------------------------------------------------------------------------
// Tier 4-3 — Continuous perception: watch the screen on a light cadence, but
// only spend a vision call when it MEANINGFULLY changes (hash-diff gate, same
// idea as the watch job). Opt-in (screen_watch=on), privacy-sensitive → off by
// default. A noticed change becomes a notification (and can reach WhatsApp via
// proactive delivery). Manual trigger forces one analysis regardless.
// ---------------------------------------------------------------------------
let lastScreenHash: string | null = null;
async function screenWatchTick(opts: { force?: boolean } = {}): Promise<{ analyzed: boolean; changed: boolean; note?: string; analysis?: string }> {
  if (!opts.force && (await getSetting('screen_watch')) !== 'on') return { analyzed: false, changed: false, note: 'disabled' };
  const buf = await captureScreen();
  if (!buf) return { analyzed: false, changed: false, note: 'no capture (no active desktop session?)' };
  const hash = createHash('sha256').update(buf).digest('hex');
  const first = lastScreenHash === null;
  const changed = hash !== lastScreenHash;
  lastScreenHash = hash;
  // Baseline (first tick) and unchanged frames cost nothing — only a real change
  // (or a manual/forced run) spends a vision call.
  if (!opts.force && (first || !changed)) return { analyzed: false, changed, note: first ? 'baseline captured' : 'no change' };
  const analysis = await describeImages(
    [{ mime: 'image/png', dataUrl: `data:image/png;base64,${buf.toString('base64')}` }],
    'Concisely: what is on the screen right now, and is there anything that may need attention (an error, a message, a task waiting)?',
  );
  await pool.query(`INSERT INTO notifications (kind, title, body) VALUES ('screen', $1, $2)`, ['👁 Screen update noticed', analysis.slice(0, 1500)]);
  return { analyzed: true, changed: true, analysis: analysis.slice(0, 400) };
}
app.post('/perception/screen-watch', async () => screenWatchTick({ force: true }));

// ---------------------------------------------------------------------------
// Tier 3 — Graduated trust: the OS learns which actions you consistently
// approve (from pending_actions history) and lets you PROMOTE a tool to
// auto-approve, so autonomy widens based on your demonstrated trust. Money
// ('spend') can never be promoted; every promotion is one-click revocable.
// ---------------------------------------------------------------------------
const PROMOTE_THRESHOLD = 3; // approvals with zero rejections before a tool is "promotable"

app.get('/trust/ladder', async () => {
  const { rows } = await pool.query<{ tool: string; trust_class: string; auto_approve: boolean; approvals: number; rejections: number }>(
    `SELECT p.tool,
            COALESCE(tp.trust_class::text, max(p.trust_class)) AS trust_class,
            COALESCE(bool_or(tp.auto_approve), false) AS auto_approve,
            count(*) FILTER (WHERE p.status = 'executed')::int AS approvals,
            count(*) FILTER (WHERE p.status = 'rejected')::int AS rejections
     FROM pending_actions p
     LEFT JOIN trust_policies tp ON tp.tool = p.tool
     GROUP BY p.tool, tp.trust_class, tp.auto_approve
     ORDER BY approvals DESC, p.tool`,
  );
  const ladder = rows.map((r) => ({
    ...r,
    promotable: !r.auto_approve && r.trust_class !== 'spend' && r.approvals >= PROMOTE_THRESHOLD && r.rejections === 0,
  }));
  return { ladder, threshold: PROMOTE_THRESHOLD };
});

app.post('/trust/promote', async (req) => {
  const { tool } = (req.body ?? {}) as { tool?: string };
  if (!tool) return { error: 'tool is required' };
  // Resolve the tool's class from its policy or its decision history.
  const cls =
    (await pool.query<{ c: string }>(`SELECT trust_class::text AS c FROM trust_policies WHERE tool = $1`, [tool])).rows[0]?.c ??
    (await pool.query<{ c: string }>(`SELECT max(trust_class) AS c FROM pending_actions WHERE tool = $1`, [tool])).rows[0]?.c;
  if (!cls) return { error: `unknown tool "${tool}"` };
  if (cls === 'spend') return { error: 'spend-class actions (money) can never be auto-approved — they always require confirmation.' };
  await pool.query(
    `INSERT INTO trust_policies (tool, trust_class, auto_approve) VALUES ($1, $2::trust_class, true)
     ON CONFLICT (tool) DO UPDATE SET auto_approve = true, updated_at = now()`,
    [tool, cls],
  );
  trace.recordSafe({ traceId: req.traceId, component: 'trust', event: 'trust.promoted', payload: { tool, trustClass: cls } });
  return { ok: true, tool, trustClass: cls, autoApprove: true };
});

app.post('/trust/demote', async (req) => {
  const { tool } = (req.body ?? {}) as { tool?: string };
  if (!tool) return { error: 'tool is required' };
  await pool.query(`UPDATE trust_policies SET auto_approve = false, updated_at = now() WHERE tool = $1`, [tool]);
  trace.recordSafe({ traceId: req.traceId, component: 'trust', event: 'trust.demoted', payload: { tool } });
  return { ok: true, tool, autoApprove: false };
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
  // Clamp maxRounds (2026-07-26 audit): unbounded rounds = unbounded Docker-sandbox
  // spawns + planning-tier LLM calls from a single request.
  const safeMaxRounds = Math.min(Math.max(Math.floor(Number(maxRounds) || 3), 1), 6);
  return runCodingTask(pool, { instruction: instruction.trim(), files, testCmd: testCmd.trim(), language, egress, maxRounds: safeMaxRounds });
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
  // Surface the INNERMOST error message, not nested JSON (dogfooded 2026-07-20:
  // the chat showed `⚠ whatsapp_send_message failed: {"error":"whatsapp bridge
  // 500: {\"statusCode\":500,...}"}` — unreadable to a human deciding what to
  // do next). Bridge errors embed JSON-in-JSON; unwrap layers when possible.
  let failText = '';
  if (!success) {
    let msg = String((result as { error?: unknown })?.error ?? 'unknown error');
    const nested = msg.match(/"message"\s*:\s*"([^"]{3,200})"/); // inner HTTP body, if any
    if (nested) msg = nested[1]!;
    failText = msg.slice(0, 220);
  }
  const line = success ? `✅ Done — ${pa.tool} executed.` : `⚠ ${pa.tool} failed: ${failText}`;
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

// M16: the Coordinator's most recent tick — visibility into what it's
// watching/found/did, without waiting for a notification to show up.
app.get('/coordinator/status', async () => ({
  enabled: (process.env.AIOS_COORDINATOR ?? 'on') !== 'off',
  autoResume: (process.env.AIOS_COORDINATOR_AUTORESUME ?? 'on') !== 'off',
  lastTick: lastCoordinatorReport,
}));

// ---------------------------------------------------------------------------
// M9 Capability Packs (ADR-0012): manifests live in code; install state in DB.
// Install applies bundled policies + seeds procedural memories (provenance = the
// install task); enable/disable changes the composed tool surface immediately.
// ---------------------------------------------------------------------------
app.get('/packs', async () => ({ packs: await listPacks(pool) }));

// ---------------------------------------------------------------------------
// M20 Pack Forge (ADR-0022): forge → review staged SOURCE → install (human
// gate). The HTTP install endpoint is itself the approval when driven from the
// UI; from chat, pack_install queues the normal approval card instead.
// ---------------------------------------------------------------------------
app.post('/packs/forge', async (req, reply) => {
  const { request } = (req.body ?? {}) as { request?: string };
  if (!request?.trim()) return reply.code(400).send({ error: 'request is required' });
  try {
    const res = await forgePack(request.trim(), { traceId: req.traceId, staticPackNames: Object.keys(PACKS) });
    return { staged: res.name, tools: res.toolNames, description: res.description, requires: res.requires, rounds: res.rounds, review: `GET /packs/staged then POST /packs/staged/${res.name}/install` };
  } catch (err) {
    return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/packs/staged', async () => ({ staged: await listStagedPacks(Object.keys(PACKS)) }));

app.post('/packs/staged/:name/install', async (req, reply) => {
  const { name } = req.params as { name: string };
  try {
    const res = await installDynamicPack(pool, name, Object.keys(PACKS));
    enabledPacks = await loadEnabledPacks(pool);
    return { installed: res.name, tools: res.tools };
  } catch (err) {
    return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

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
// "Nexus" (the Mind) — the OS made visible. Two feeds:
//   GET /mind/graph → ONE constellation of everything the OS knows, assembled
//     from the knowledge graph (entities + relations) AND durable memories,
//     cross-linked where a memory actually mentions an entity. The raw kg is
//     sparse on its own; fused with memories it becomes the real picture.
//   GET /mind/live  → the reasoning timeline of a task (default: the active or
//     most recent one) — steps, tool calls, trust decisions, agent children.
// Both are read-only projections; no new tables.
// ---------------------------------------------------------------------------
interface MindNode { id: string; label: string; kind: string; group: 'entity' | 'memory'; weight: number; detail?: string }
interface MindLink { source: string; target: string; rel: string; weight: number }

app.get('/mind/graph', async () => {
  const [ents, rels, mems, stats] = await Promise.all([
    pool.query<{ id: string; kind: string; name: string; mentions: number }>(
      `SELECT id, kind, name, mentions FROM kg_nodes ORDER BY mentions DESC, last_seen_at DESC LIMIT 90`,
    ),
    pool.query<{ src: string; rel: string; dst: string; weight: number }>(`SELECT src, rel, dst, weight FROM kg_edges`),
    pool.query<{ id: string; type: string; subject: string | null; content: string; confidence: number; tags: string[] }>(
      `SELECT id, type, subject, left(content, 110) AS content, confidence, tags
       FROM memory_records WHERE superseded_by IS NULL ORDER BY last_confirmed_at DESC LIMIT 70`,
    ),
    pool.query(
      `SELECT (SELECT count(*) FROM tasks) AS tasks,
              (SELECT count(*) FROM tool_calls) AS tool_calls,
              (SELECT count(*) FROM memory_records WHERE superseded_by IS NULL) AS memories,
              (SELECT count(*) FROM kg_nodes) AS entities,
              (SELECT count(*) FROM kg_edges) AS relations,
              (SELECT count(*) FROM messages) AS messages`,
    ),
  ]);

  const nodes: MindNode[] = [];
  const links: MindLink[] = [];
  const present = new Set<string>();

  for (const e of ents.rows) {
    nodes.push({ id: e.id, label: e.name, kind: e.kind, group: 'entity', weight: Math.max(1, e.mentions) });
    present.add(e.id);
  }
  for (const r of rels.rows) {
    if (present.has(r.src) && present.has(r.dst)) links.push({ source: r.src, target: r.dst, rel: r.rel, weight: r.weight ?? 1 });
  }

  // Memories become nodes, and link to any entity they actually name — this is
  // what turns two disconnected clouds into one mind.
  const named = ents.rows
    .map((e) => ({ id: e.id, needle: e.name.toLowerCase() }))
    .filter((e) => e.needle.length >= 3);
  const byTag = new Map<string, string[]>();
  for (const m of mems.rows) {
    const label = m.subject?.trim() || m.content.replace(/\s+/g, ' ').slice(0, 42);
    nodes.push({
      id: m.id,
      label,
      kind: m.type,
      group: 'memory',
      weight: Math.max(1, Math.round((m.confidence ?? 1) * 3)),
      detail: m.content.replace(/\s+/g, ' '),
    });
    present.add(m.id);
    const hay = `${m.subject ?? ''} ${m.content}`.toLowerCase();
    for (const e of named) if (hay.includes(e.needle)) links.push({ source: m.id, target: e.id, rel: 'mentions', weight: 1 });
    for (const t of m.tags ?? []) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t)!.push(m.id);
    }
  }
  // Cluster memories that share a tag (star from the first) so themes are visible.
  let clustered = 0;
  for (const [tag, ids] of byTag) {
    if (ids.length < 2 || clustered >= 8) continue;
    clustered++;
    for (let i = 1; i < ids.length; i++) links.push({ source: ids[0]!, target: ids[i]!, rel: tag, weight: 1 });
  }

  const s = stats.rows[0] as Record<string, string>;
  return {
    nodes,
    links,
    stats: {
      tasks: Number(s.tasks),
      toolCalls: Number(s.tool_calls),
      memories: Number(s.memories),
      entities: Number(s.entities),
      relations: Number(s.relations),
      messages: Number(s.messages),
    },
  };
});

app.get('/mind/live', async (req) => {
  const { taskId } = req.query as { taskId?: string };
  const chosen = taskId
    ? (await pool.query(`SELECT * FROM tasks WHERE id = $1`, [taskId])).rows[0]
    : (
        await pool.query(
          `SELECT * FROM tasks WHERE status <> 'draft'
           ORDER BY (status IN ('running','planning','awaiting_approval')) DESC, updated_at DESC LIMIT 1`,
        )
      ).rows[0];

  const recent = (
    await pool.query(
      `SELECT id, goal, status, updated_at FROM tasks WHERE status <> 'draft' AND parent_task_id IS NULL
       ORDER BY updated_at DESC LIMIT 8`,
    )
  ).rows;
  if (!chosen) return { task: null, steps: [], toolCalls: [], children: [], recent };

  const [steps, calls, children] = await Promise.all([
    pool.query(
      `SELECT id, local_id, title, kind, status, model_used, tokens, error, tool, created_at
       FROM steps WHERE task_id = $1 ORDER BY created_at`,
      [chosen.id],
    ),
    pool.query(
      `SELECT tc.id, tc.tool, tc.trust_class, tc.approved_by, tc.duration_ms, tc.created_at, s.id AS step_id,
              left(tc.args::text, 220) AS args, left(tc.result::text, 220) AS result
       FROM tool_calls tc JOIN steps s ON s.id = tc.step_id
       WHERE s.task_id = $1 ORDER BY tc.created_at`,
      [chosen.id],
    ),
    pool.query(`SELECT id, goal, status FROM tasks WHERE parent_task_id = $1 ORDER BY created_at`, [chosen.id]),
  ]);

  return {
    task: { id: chosen.id, goal: chosen.goal, status: chosen.status, spent: chosen.spent, created_at: chosen.created_at, updated_at: chosen.updated_at },
    steps: steps.rows,
    toolCalls: calls.rows,
    children: children.rows,
    recent,
  };
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
  // Spend can NEVER be auto-approved — money always needs a human. Mirrors the
  // /trust/promote guard, which PUT /policies previously bypassed (2026-07-26 audit).
  if (autoApprove === true) {
    const cur = await pool.query<{ trust_class: string }>(`SELECT trust_class FROM trust_policies WHERE tool = $1`, [tool]);
    const effectiveClass = trustClass ?? cur.rows[0]?.trust_class;
    if (effectiveClass === 'spend') {
      return reply.code(400).send({ error: 'spend-class tools can never be auto-approved — money always requires explicit approval' });
    }
  }
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
// Resume ONE task by its current shape — the single source of truth for
// "how to continue a task that stopped mid-run". Used at boot (every
// running/planning task is orphaned by definition — M1 exit criterion) AND
// live by the Coordinator (M16, below) when a task shows no progress for a
// while. NEVER re-plans (M11's persisted-plan resume); NEVER bypasses
// approval (resuming continues the SAME durable checkpoint/plan — any
// approval-gated step still queues exactly as it would have the first time).
// Never rejects (errors are logged internally) so callers can fire-and-forget
// (`void resumeTaskById(id)`, boot-resume's original concurrent-dispatch
// behavior) or `await` it, without an unhandled-rejection risk either way.
function resumeTaskById(taskId: string, why: 'boot' | 'coordinator'): Promise<void> {
  return (async () => {
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
        app.log.info({ taskId, why }, 'orphaned agent child left to its parent orchestration resume');
        return;
      }
      await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
      app.log.warn({ taskId, why }, 'orphaned agent child with no live parent marked failed');
      return;
    }
    if (shape && shape.has_children) {
      const sess = (await pool.query<{ session_id: string }>(`SELECT session_id FROM messages WHERE task_id=$1 AND role='user' LIMIT 1`, [taskId])).rows[0]?.session_id;
      const say = sess ? async (content: string) => { await addMessage(pool, { sessionId: sess, role: 'assistant', content, taskId }); } : undefined;
      if (shape.has_plan) {
        app.log.info({ taskId, why }, 'resuming orphaned orchestration from persisted plan');
        trace.recordSafe({ traceId: newTraceId(), taskId, component: 'api', event: 'task.resume_on_boot', payload: { orchestration: true, why } });
        await resumeAgentTask(pool, taskId, { registry: packRegistry(), extraSystem: packPrompt(), say })
          .then(async (result) => {
            if (result) {
              if (say && result.text) await say(result.text);
              return;
            }
            // Plan turned out unusable (malformed/agent renamed) — fail honestly.
            await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
            if (say) await say('⚠ This multi-agent run stalled and its plan could not be recovered — please ask again.');
            app.log.warn({ taskId, why }, 'orchestration resume found no usable plan; marked failed');
          });
        return;
      }
      await pool.query(`UPDATE tasks SET status='failed', updated_at=now() WHERE id=$1`, [taskId]);
      if (say) await say('⚠ This multi-agent run stalled — please ask again.');
      app.log.warn({ taskId, why }, 'orphaned orchestration without a persisted plan marked failed');
      return;
    }
    // Route by shape: a task with planner-authored steps (local_id set) is a
    // graph task → resume via runGraph (skips done steps, exactly-once); a plain
    // chat task → runTask. Both are durable-resumable. agentMode 'off': a resumed
    // chat task continues from its checkpoint — re-classifying it into a fresh
    // orchestration would discard that state.
    const isGraph = (await pool.query(`SELECT 1 FROM steps WHERE task_id=$1 AND local_id IS NOT NULL LIMIT 1`, [taskId])).rowCount ?? 0;
    app.log.info({ taskId, why, isGraph: !!isGraph }, 'resuming task');
    trace.recordSafe({ traceId: newTraceId(), taskId, component: 'api', event: 'task.resume_on_boot', payload: { graph: !!isGraph, why } });
    await Promise.resolve(isGraph ? runGraph(pool, taskId, { registry: packRegistry() }) : completeChatTask(taskId, 'off'));
  })().catch((err) => app.log.error({ err, taskId, why }, 'resume failed'));
}

// ---------------------------------------------------------------------------
// Boot: resume tasks orphaned by a mid-run kill (M1 exit criterion)
// ---------------------------------------------------------------------------
const port = Number(process.env.API_PORT ?? 4000);
enabledPacks = await loadEnabledPacks(pool); // before listen: routes + resume + scheduler all compose from it
app.log.info({ packs: [...enabledPacks] }, 'capability packs enabled');
// M20 meta-tool policies (idempotent, never overwrites user edits): forging
// only STAGES inert source (write/auto — and §8.3 blocks it under untrusted
// context); installing ACTIVATES generated code → irreversible, never auto.
await pool.query(
  `INSERT INTO trust_policies (tool, trust_class, auto_approve) VALUES
     ('pack_forge','write',true), ('pack_install','irreversible',false)
   ON CONFLICT (tool) DO NOTHING`,
);

// Perf (2026-07-11): pre-warm each capability bucket's primary provider (DNS +
// TLS handshake) so the FIRST real request doesn't pay cold-connection cost.
// Fire-and-forget, never blocks boot; a warm failure is just a missed warm —
// the real request still gets its own full retry/failover machinery.
void (async () => {
  const t0 = Date.now();
  const results = await Promise.allSettled(
    (['workspace', 'coding', 'fast'] as const).map((capability) =>
      callModel({ role: 'routing', prompt: 'ping', capability, maxTokens: 1, traceId: randomUUID(), name: 'provider-warmup' }),
    ),
  );
  app.log.info(
    { ms: Date.now() - t0, ok: results.filter((r) => r.status === 'fulfilled').length, of: results.length },
    'provider pre-warm',
  );
})();
await app.listen({ port, host: '127.0.0.1' });

// Stay-up guards (mirror the bridges): log, never exit — one rejected background
// promise or a stray throw must not crash the whole gateway (2026-07-26 audit).
process.on('unhandledRejection', (reason) => app.log.error({ reason }, 'unhandledRejection'));
process.on('uncaughtException', (err) => app.log.error({ err }, 'uncaughtException'));

void (async () => {
  const orphans = await findOrphanedTasks(pool);
  for (const taskId of orphans) void resumeTaskById(taskId, 'boot'); // fire-and-forget, concurrent — matches the pre-refactor dispatch
})().catch((err) => app.log.error({ err }, 'boot-resume failed'));

// M7: the scheduler heartbeat. Ticks every SCHEDULER_POLL_MS (default 30s); due
// jobs run their fixed pipelines; zombies from a previous crash are reaped on the
// first tick (the jobs analog of the orphan-resume above).
startScheduler(pool, {
  executors: defaultExecutors(),
  registry: packRegistry, // factory — pack toggles apply to future ticks without restart
  onTick: (r) => app.log.info({ claimed: r.claimed, reaped: r.reaped, missed: r.missed, ran: r.ran }, 'scheduler tick'),
});

// M16 — the Coordinator (Akhil, 2026-07-11: "a smart coordinator... watches
// quotas, service health, stuck tasks... proactively tells me when something
// needs attention"). Generalizes boot-resume from "once at boot" to "continuously,
// live": a task with no progress for AIOS_COORDINATOR_STUCK_MINUTES gets resumed
// through the exact same resumeTaskById path, plus provider-health/approval-
// backlog/job-failure-streak surfacing — all via notifications, never bypassing
// approval. Kill switches: AIOS_COORDINATOR=off (whole feature),
// AIOS_COORDINATOR_AUTORESUME=off (keep watching + notifying, never auto-resume).
if ((process.env.AIOS_COORDINATOR ?? 'on') !== 'off') {
  const autoResume = (process.env.AIOS_COORDINATOR_AUTORESUME ?? 'on') !== 'off';
  startCoordinator(pool, {
    resumeStuckTask: autoResume ? (taskId) => resumeTaskById(taskId, 'coordinator') : undefined,
    onTick: (r) => {
      lastCoordinatorReport = r;
      if (r.stuckTasks.length || r.providerDegraded || r.approvalBacklog.length || r.jobStreaks.length) {
        app.log.info({ stuck: r.stuckTasks.length, resumed: r.resumedTaskIds.length, providerDegraded: !!r.providerDegraded, backlog: r.approvalBacklog.length, jobStreaks: r.jobStreaks.length }, 'coordinator tick');
      }
    },
  });
  app.log.info({ autoResume }, 'coordinator enabled');
}

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
    // Only ANNOUNCE (push to WhatsApp) approvals that actually originated from
    // a WhatsApp command — session_id already carries true origin (the
    // lineage walk in queuePendingAction). Without this filter, EVERY pending
    // approval system-wide (voice UI, web chat, autonomous orchestrations)
    // got pushed to the phone the next time this ticked — not what "only
    // when I use it with WhatsApp" means. Approving/rejecting an id typed
    // here still works regardless of origin (decidePending, unchanged) —
    // this only restricts the unsolicited PUSH.
    listPending: async () =>
      (
        await pool.query<{ id: string; tool: string; args: unknown; untrusted: boolean }>(
          `SELECT id, tool, args, untrusted_context AS untrusted FROM pending_actions
           WHERE status='pending'
             AND session_id = (SELECT session_id FROM remote_channels WHERE channel='whatsapp')
           ORDER BY created_at`,
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

// Tier 2-C: advance due standing goals in the background — read-only, and only
// when autopilot is on (advanceDueStandingGoals gates both). Checked every 30
// min; the per-goal cadence (default 6h) does the real pacing, so free-tier
// quota impact is minimal. AIOS_STANDING=off disables it.
if (process.env.AIOS_STANDING !== 'off') {
  let standingInFlight = false;
  setInterval(() => {
    if (standingInFlight) return;
    standingInFlight = true;
    advanceDueStandingGoals(newTraceId())
      .then((n) => { if (n) app.log.info({ advanced: n }, 'standing goals advanced'); })
      .catch((err) => app.log.debug({ err: err instanceof Error ? err.message : err }, 'standing advance skipped'))
      .finally(() => { standingInFlight = false; });
  }, Number(process.env.AIOS_STANDING_POLL_MS) || 30 * 60_000);
  app.log.info('standing-goal autonomy enabled (read-only, autopilot-gated)');
}

// Tier 2-B: push proactive notifications to WhatsApp on a light cadence (gated
// by proactive_delivery=on + a paired bridge). AIOS_PROACTIVE=off disables it.
if (process.env.AIOS_PROACTIVE !== 'off') {
  let deliverInFlight = false;
  setInterval(() => {
    if (deliverInFlight) return;
    deliverInFlight = true;
    deliverProactiveNotifications()
      .then((r) => { if (r.sent) app.log.info(r, 'proactive notifications delivered to WhatsApp'); })
      .catch((err) => app.log.debug({ err: err instanceof Error ? err.message : err }, 'proactive delivery skipped'))
      .finally(() => { deliverInFlight = false; });
  }, Number(process.env.AIOS_PROACTIVE_POLL_MS) || 5 * 60_000);
}

// Tier 4-3: continuous screen perception — capture on a light cadence, analyze
// only on a real change (screenWatchTick gates on the screen_watch setting).
// AIOS_SCREEN_WATCH=off disables the loop entirely.
if (process.env.AIOS_SCREEN_WATCH !== 'off') {
  let screenInFlight = false;
  setInterval(() => {
    if (screenInFlight) return;
    screenInFlight = true;
    screenWatchTick()
      .then((r) => { if (r.analyzed) app.log.info({ analysis: r.analysis }, 'screen-watch noticed a change'); })
      .catch((err) => app.log.debug({ err: err instanceof Error ? err.message : err }, 'screen-watch skipped'))
      .finally(() => { screenInFlight = false; });
  }, Number(process.env.AIOS_SCREEN_WATCH_MS) || 90_000);
}
