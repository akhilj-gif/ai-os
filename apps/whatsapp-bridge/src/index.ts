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
import qrcode from 'qrcode-terminal';
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
      console.log('\nScan with WhatsApp → Settings → Linked devices → Link a device:\n');
      qrcode.generate(u.qr, { small: true });
    }
    if (u.connection === 'open') {
      paired = true;
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
  if (token && req.headers['x-bridge-token'] !== token) return reply.code(401).send({ error: 'bad bridge token' });
});
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
await app.listen({ port: DEFAULT_BRIDGE_PORT, host: '127.0.0.1' });
console.log(`[whatsapp-bridge] contract API on http://127.0.0.1:${DEFAULT_BRIDGE_PORT} (impl: baileys)`);
