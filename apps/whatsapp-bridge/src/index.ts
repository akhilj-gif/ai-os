// Real WhatsApp bridge (ADR-0013) — Baileys (unofficial WhatsApp Web protocol).
// Run: pnpm --filter @ai-os/whatsapp-bridge start  → scan the QR with WhatsApp
// (Linked devices). Session creds persist in .auth/ (gitignored) so pairing is
// one-time. ⚠ OPT-IN: unofficial clients violate WhatsApp ToS and carry a
// NONZERO account-ban risk — pairing is the user's explicit decision, never
// something the OS does for them. The bridge holds the session; the OS's trust
// gate holds the policy (send = irreversible + approval).
// NOTE: UNVERIFIED until first paired — the mock (mock.ts) is the verified twin.
import Fastify from 'fastify';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, type WAMessage } from '@whiskeysockets/baileys';
import { DEFAULT_BRIDGE_PORT, type BridgeChat, type BridgeMessage } from './contract.js';

const AUTH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.auth');
mkdirSync(AUTH_DIR, { recursive: true });

// Local view of chats/messages, fed by history sync + live upserts. Baileys v7
// has no built-in store; a bounded ring buffer per chat is all the OS needs.
const MAX_PER_CHAT = 50;
const chats = new Map<string, BridgeChat>();
const messages = new Map<string, BridgeMessage[]>();
let paired = false;
let me = '';
let currentQr: string | null = null; // latest QR string; served at /qr, cleared on pair
const PORT = Number(process.env.WHATSAPP_BRIDGE_PORT) || DEFAULT_BRIDGE_PORT;

function msgText(m: WAMessage): string {
  const c = m.message;
  return (
    c?.conversation ??
    c?.extendedTextMessage?.text ??
    c?.imageMessage?.caption ??
    c?.videoMessage?.caption ??
    ''
  );
}

function ingest(m: WAMessage): void {
  const chatId = m.key.remoteJid;
  const text = msgText(m);
  if (!chatId || chatId === 'status@broadcast' || !text) return;
  const ts = new Date(Number(m.messageTimestamp ?? 0) * 1000).toISOString();
  const entry: BridgeMessage = {
    id: m.key.id ?? `${chatId}-${ts}`,
    chatId,
    from: m.key.fromMe ? 'me' : m.pushName || chatId.split('@')[0]!,
    fromMe: !!m.key.fromMe,
    text,
    timestamp: ts,
  };
  const list = messages.get(chatId) ?? [];
  if (list.some((x) => x.id === entry.id)) return;
  list.push(entry);
  if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);
  messages.set(chatId, list);
  const prev = chats.get(chatId);
  chats.set(chatId, {
    id: chatId,
    name: prev?.name && !prev.name.startsWith('+') ? prev.name : (m.key.fromMe ? prev?.name : m.pushName) || `+${chatId.split('@')[0]}`,
    isGroup: chatId.endsWith('@g.us'),
    unread: m.key.fromMe ? 0 : (prev?.unread ?? 0) + 1,
    lastMessageAt: ts,
  });
}

let sock: ReturnType<typeof makeWASocket>;
async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, syncFullHistory: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    if (u.qr) {
      currentQr = u.qr;
      console.log('\nScan with WhatsApp → Settings → Linked devices → Link a device');
      console.log(`(or open http://127.0.0.1:${PORT}/qr in a browser)\n`);
      qrcodeTerminal.generate(u.qr, { small: true });
    }
    if (u.connection === 'open') {
      paired = true;
      currentQr = null;
      me = sock.user?.id?.split(':')[0] ?? 'unknown';
      console.log(`[whatsapp-bridge] paired as +${me}`);
    }
    if (u.connection === 'close') {
      paired = false;
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('[whatsapp-bridge] logged out — delete .auth/ and re-pair');
      } else {
        console.warn(`[whatsapp-bridge] connection closed (${code}) — reconnecting…`);
        void connect();
      }
    }
  });
  sock.ev.on('messaging-history.set', ({ messages: hist }) => hist.forEach(ingest));
  sock.ev.on('messages.upsert', ({ messages: ms }) => ms.forEach(ingest));
}

const app = Fastify({ logger: false });
const token = process.env.WHATSAPP_BRIDGE_TOKEN;
app.addHook('onRequest', async (req, reply) => {
  // The QR pairing page is pre-auth bootstrap (localhost, shown before any
  // session exists) — exempt it so a browser with no token header can load it.
  if (req.url === '/' || req.url.startsWith('/qr')) return;
  if (token && req.headers['x-bridge-token'] !== token) return reply.code(401).send({ error: 'bad bridge token' });
});

// Browser-friendly pairing page (served at / and /qr). Renders the live QR as
// inline SVG (no external assets) and auto-refreshes so a rotated code updates.
const qrPage = async (): Promise<string> => {
  const shell = (body: string, refresh: number) =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="refresh" content="${refresh}"><title>AI OS · WhatsApp pairing</title></head>` +
    `<body style="font-family:system-ui,sans-serif;text-align:center;padding:32px 16px;background:#0e101a;color:#e6e8f0">${body}</body></html>`;
  if (paired) return shell(`<h2>✅ Paired as +${me}</h2><p style="color:#9aa0b5">The bridge is connected. You can close this tab.</p>`, 30);
  if (!currentQr) return shell(`<h2>Starting…</h2><p style="color:#9aa0b5">Waiting for WhatsApp to issue a QR. This page refreshes automatically.</p>`, 2);
  const svg = await QRCode.toString(currentQr, { type: 'svg', margin: 2, width: 320 });
  return shell(
    `<h2>Scan with WhatsApp</h2><p style="color:#9aa0b5">WhatsApp → Settings → Linked devices → Link a device</p>` +
      `<div style="display:inline-block;background:#fff;padding:12px;border-radius:12px;margin:8px">${svg}</div>` +
      `<p style="color:#565c72;font-size:13px">The code rotates every ~20s; this page keeps itself fresh. Leave the bridge running.</p>`,
    18,
  );
};
app.get('/', async (_req, reply) => reply.type('text/html').send(await qrPage()));
app.get('/qr', async (_req, reply) => reply.type('text/html').send(await qrPage()));

app.get('/health', async () => ({ ok: true, paired, me, impl: 'baileys' }));
app.get('/chats', async (req) => {
  const limit = Math.min(Number((req.query as { limit?: string }).limit) || 20, 50);
  const list = [...chats.values()].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  return { chats: list.slice(0, limit) };
});
app.get('/messages', async (req, reply) => {
  const { chatId, limit } = req.query as { chatId?: string; limit?: string };
  if (!chatId) return reply.code(400).send({ error: 'chatId is required' });
  const list = messages.get(chatId);
  if (!list) return reply.code(404).send({ error: `no such chat: ${chatId}` });
  return { messages: list.slice(-Math.min(Number(limit) || 25, MAX_PER_CHAT)) };
});
app.post('/send', async (req, reply) => {
  const { chatId, text } = (req.body ?? {}) as { chatId?: string; text?: string };
  if (!chatId || !text?.trim()) return reply.code(400).send({ error: 'chatId and text are required' });
  if (!paired) return reply.code(503).send({ error: 'bridge not paired' });
  const sent = await sock.sendMessage(chatId, { text: text.trim() });
  return { ok: true, messageId: sent?.key?.id ?? 'unknown' };
});

await connect();
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`[whatsapp-bridge] contract API on http://127.0.0.1:${PORT} (impl: baileys) — open /qr to pair`);
