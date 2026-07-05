// Gmail tools: list (read), read one (read), create draft (write).
// A SEND tool deliberately does not exist in M1 (ADR-0003) — the trust policy for
// drafts is write/auto+logged; sending is irreversible and arrives with approvals (M4+).
import type { ToolDef } from '../registry.js';
import { googleApi } from '../google.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface MessageMeta {
  id: string;
  snippet?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
  internalDate?: string;
}

function header(msg: MessageMeta, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{3,}/g, '\n')
    .trim();
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}

function extractBody(part: Part | undefined, want: string): string | null {
  if (!part) return null;
  if (part.mimeType === want && part.body?.data) return decodeB64Url(part.body.data);
  for (const p of part.parts ?? []) {
    const found = extractBody(p, want);
    if (found) return found;
  }
  return null;
}

export const gmailList: ToolDef = {
  name: 'gmail_list',
  untrustedOutput: true, // email metadata is untrusted external content (§8.3)
  description:
    "List the user's Gmail messages. Supports Gmail search queries (e.g. 'in:inbox newer_than:1d', 'from:foo is:unread'). Returns id, from, subject, date, snippet per message.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Gmail search query. Default: 'in:inbox newer_than:1d'" },
      maxResults: { type: 'number', description: 'Max messages (1-25). Default 10.' },
    },
  },
  async execute(args, ctx) {
    const query = typeof args.query === 'string' && args.query ? args.query : 'in:inbox newer_than:1d';
    const max = Math.min(Math.max(Number(args.maxResults) || 10, 1), 25);
    const listing = await googleApi<{ messages?: Array<{ id: string }> }>(
      ctx.pool,
      `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
    );
    const ids = (listing.messages ?? []).map((m) => m.id);
    const metas = await Promise.all(
      ids.map((id) =>
        googleApi<MessageMeta>(
          ctx.pool,
          `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        ),
      ),
    );
    return {
      query,
      messages: metas.map((m) => ({
        id: m.id,
        from: header(m, 'From'),
        subject: header(m, 'Subject'),
        date: header(m, 'Date'),
        snippet: m.snippet ?? '',
      })),
    };
  },
};

export const gmailRead: ToolDef = {
  name: 'gmail_read',
  untrustedOutput: true, // email BODIES are the #1 injection vector (§8.3)
  description: 'Read one Gmail message in full (plain-text body) by message id from gmail_list.',
  inputSchema: {
    type: 'object',
    properties: { messageId: { type: 'string', description: 'Gmail message id' } },
    required: ['messageId'],
  },
  async execute(args, ctx) {
    const id = String(args.messageId ?? '');
    if (!id) throw new Error('messageId is required');
    const msg = await googleApi<MessageMeta & { payload?: Part & MessageMeta['payload'] }>(
      ctx.pool,
      `${GMAIL}/messages/${id}?format=full`,
    );
    const plain = extractBody(msg.payload as Part, 'text/plain');
    const html = plain ? null : extractBody(msg.payload as Part, 'text/html');
    const body = (plain ?? (html ? stripHtml(html) : msg.snippet ?? '')).slice(0, 6000);
    return {
      id: msg.id,
      from: header(msg as MessageMeta, 'From'),
      to: header(msg as MessageMeta, 'To'),
      subject: header(msg as MessageMeta, 'Subject'),
      date: header(msg as MessageMeta, 'Date'),
      body,
    };
  },
};

export const gmailCreateDraft: ToolDef = {
  name: 'gmail_create_draft',
  description:
    'Create a DRAFT email in Gmail (never sends). The user reviews and sends it themselves in Gmail.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string' },
      body: { type: 'string', description: 'Plain-text body' },
    },
    required: ['to', 'subject', 'body'],
  },
  async execute(args, ctx) {
    const raw = Buffer.from(
      `To: ${String(args.to)}\r\nSubject: ${String(args.subject)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${String(args.body)}`,
      'utf8',
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const draft = await googleApi<{ id: string }>(ctx.pool, `${GMAIL}/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { raw } }),
    });
    return { draftId: draft.id, note: 'Draft created in Gmail — NOT sent. The user sends it manually.' };
  },
};
