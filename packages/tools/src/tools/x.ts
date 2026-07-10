// M12c — X/Twitter pack tools (ADR-0015). Mirror of the WhatsApp shape
// (ADR-0013) minus the bridge: X has an official API, so the tools talk a tiny
// in-module CLIENT seam — the real client (X API v2, OAuth 1.0a user context)
// activates when all four X_API_* env keys are set; otherwise a deterministic
// MOCK serves fixtures and collects "published" posts in an inspectable outbox
// (nothing ever leaves the machine). Free tier is write-mostly (~500 posts/mo,
// reads nearly nil) → v1 is get-me / draft / publish; timeline monitoring
// rides the internet engine (fetch/watch), not paid API reads.
//
// Trust: PUBLISHING as the user is the pack's whole risk — irreversible-class,
// auto_approve=false, always (policy in the pack manifest). Drafting is
// stateless validation (write-class shape, no side effects).
import { createHmac, randomBytes } from 'node:crypto';
import type { ToolDef } from '../registry.js';

const X_API = 'https://api.x.com/2';
// X counts URLs as 23 chars; we enforce the plain 280 ceiling and surface the
// count so the model can self-correct — exactness beyond that is the API's job.
export const X_MAX_CHARS = 280;

interface XCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

function creds(): XCreds | null {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) return null;
  return { apiKey: X_API_KEY, apiSecret: X_API_SECRET, accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_SECRET };
}

/** Mock outbox — "published" posts when no real keys are configured. Exposed
 *  for smokes (the X analog of the mock bridge's /outbox). */
export const xMockOutbox: Array<{ id: string; text: string; at: string }> = [];
const MOCK_ME = { id: 'mock-1', username: 'akhil_mock', name: 'Akhil (mock)' };

// --- OAuth 1.0a (HMAC-SHA1) request signing — the only auth the free-tier
// user-context write path accepts. UNVERIFIED against the live API until
// Akhil's dev-account keys exist (the Baileys precedent: honest about it).
const pct = (s: string) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function oauthHeader(method: string, url: string, c: XCreds): string {
  const p: Record<string, string> = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: c.accessToken,
    oauth_version: '1.0',
  };
  const base = [method.toUpperCase(), pct(url), pct(Object.keys(p).sort().map((k) => `${pct(k)}=${pct(p[k]!)}`).join('&'))].join('&');
  const key = `${pct(c.apiSecret)}&${pct(c.accessSecret)}`;
  p.oauth_signature = createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(p).sort().map((k) => `${pct(k)}="${pct(p[k]!)}"`).join(', ');
}

async function xApi<T>(method: 'GET' | 'POST', path: string, c: XCreds, body?: unknown): Promise<T> {
  const url = `${X_API}${path}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: oauthHeader(method, url, c), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) throw new Error(`INFRA_RATELIMIT 429 (x-api): ${(await res.text()).slice(0, 200)}`);
  if (!res.ok) throw new Error(`x api ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export const xGetMe: ToolDef = {
  name: 'x_get_me',
  description: "The user's own X/Twitter account (id, @username, display name). Mocked until X API keys are configured.",
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const c = creds();
    if (!c) return { ...MOCK_ME, mock: true, note: 'X API keys not configured — running against the deterministic mock.' };
    const r = await xApi<{ data: { id: string; username: string; name: string } }>('GET', '/users/me', c);
    return r.data;
  },
};

export const xDraftPost: ToolDef = {
  name: 'x_draft_post',
  description:
    'Draft/validate an X post BEFORE publishing: checks the 280-char limit and echoes the exact text back for review. No side effects — publishing is a separate, approval-gated step (x_publish_post).',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The exact post text to validate' } },
    required: ['text'],
  },
  async execute(args) {
    const text = String(args.text ?? '').trim();
    if (!text) throw new Error('text is required');
    const chars = [...text].length;
    if (chars > X_MAX_CHARS) {
      return { ok: false, chars, limit: X_MAX_CHARS, over: chars - X_MAX_CHARS, error: `draft is ${chars - X_MAX_CHARS} chars over the ${X_MAX_CHARS} limit — shorten it` };
    }
    return { ok: true, draft: text, chars, limit: X_MAX_CHARS };
  },
};

export const xPublishPost: ToolDef = {
  name: 'x_publish_post',
  description:
    "PUBLISH a post to X/Twitter as the user — irreversible, so every call is queued for the user's one-click approval (nothing publishes until they approve). Once the user has asked to post and the text is final, call this DIRECTLY — do not ask for confirmation in prose first.",
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Exact final post text (≤280 chars)' } },
    required: ['text'],
  },
  async execute(args) {
    const text = String(args.text ?? '').trim();
    if (!text) throw new Error('text is required');
    const chars = [...text].length;
    if (chars > X_MAX_CHARS) throw new Error(`post is ${chars} chars (limit ${X_MAX_CHARS}) — run x_draft_post and shorten it`);
    const c = creds();
    if (!c) {
      const id = `mock-post-${xMockOutbox.length + 1}`;
      xMockOutbox.push({ id, text, at: new Date().toISOString() });
      return { ok: true, id, url: `https://x.com/${MOCK_ME.username}/status/${id}`, mock: true, note: 'X API keys not configured — recorded in the mock outbox, nothing left the machine.' };
    }
    const r = await xApi<{ data: { id: string; text: string } }>('POST', '/tweets', c, { text });
    return { ok: true, id: r.data.id, url: `https://x.com/i/status/${r.data.id}` };
  },
};
