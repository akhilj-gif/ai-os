// Real WhatsApp bridge (ADR-0013) — Baileys (unofficial WhatsApp Web protocol).
// Run: pnpm --filter @ai-os/whatsapp-bridge start  → scan the QR with WhatsApp
// (Linked devices). Session creds persist in .auth/ (gitignored) so pairing is
// one-time. ⚠ OPT-IN: unofficial clients violate WhatsApp ToS and carry a
// NONZERO account-ban risk — pairing is the user's explicit decision, never
// something the OS does for them. The bridge holds the session; the OS's trust
// gate holds the policy (send = irreversible + approval).
// NOTE: UNVERIFIED until first paired — the mock (mock.ts) is the verified twin.
import Fastify from 'fastify';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, type WAMessage } from '@whiskeysockets/baileys';
import { DEFAULT_BRIDGE_PORT, type BridgeChat, type BridgeMessage } from './contract.js';

const AUTH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.auth');
mkdirSync(AUTH_DIR, { recursive: true });
// The synced view persists here so a restart reloads instantly — WhatsApp only
// pushes full history at LINK time, so without this every restart would need a
// re-scan. Holds message content → gitignored.
const STORE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'store.json');

// Local view of chats/messages/contacts, fed by history sync + live upserts.
const MAX_PER_CHAT = 50;
const chats = new Map<string, BridgeChat>();
const messages = new Map<string, BridgeMessage[]>();
// Name resolution (full sync): WhatsApp addresses chats by phone-JID or @lid, but
// the human name lives in the CONTACTS/CHATS sync. The address book is keyed by
// phone-JID, while many chats are keyed by @lid — so we ALSO keep a lid↔phone map
// and bridge across it when resolving a name.
const contactNames = new Map<string, string>(); // jid/lid -> addressbook / notify name
const chatNames = new Map<string, string>(); // jid -> group subject or chat title
const lidToPn = new Map<string, string>(); // @lid -> @s.whatsapp.net
const pnToLid = new Map<string, string>(); // @s.whatsapp.net -> @lid
let historyChats = 0; // progress counter for the initial full-history burst

/** Record a bidirectional lid↔phone link (the key to naming @lid chats). */
function linkLidPn(lid?: string | null, pn?: string | null): void {
  if (!lid || !pn || !lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return;
  if (lidToPn.get(lid) !== pn) { lidToPn.set(lid, pn); pnToLid.set(pn, lid); scheduleSave(); }
}

// A REAL display name has at least one letter. WhatsApp also sends masked-number
// "notify" strings (e.g. "+91••••••39") for contacts you haven't saved — those are
// NOT names, and storing them shadows the real addressbook name reachable via the
// lid↔phone bridge (this was the "Anish shows as a number" bug).
const hasLetter = (s: string | undefined | null): s is string => !!s && /\p{L}/u.test(s);

type NamedContact = { id?: string; lid?: string; name?: string; notify?: string; verifiedName?: string };
function rememberContact(c: NamedContact): void {
  // A contact entry that carries both a phone id and a lid is a mapping goldmine.
  if (c.id?.endsWith('@s.whatsapp.net') && c.lid) linkLidPn(c.lid, c.id);
  const name = c.name || c.verifiedName || c.notify;
  if (!hasLetter(name)) return; // masked/number "names" are not names
  if (c.id) contactNames.set(c.id, name);
  if (c.lid) contactNames.set(c.lid, name); // same human under their @lid alias
  scheduleSave();
}
function rememberChat(c: { id?: string; name?: string; subject?: string }): void {
  const name = c.name || c.subject;
  if (c.id && name) { chatNames.set(c.id, name); scheduleSave(); }
}

/** Resolve @lid → phone JID: our accumulated map first, then Baileys' own signal
 *  repository if it exposes one (defensive — API differs across versions). */
function pnForLid(lid: string): string | undefined {
  const known = lidToPn.get(lid);
  if (known) return known;
  try {
    const pn = (sock as unknown as { signalRepository?: { lidMapping?: { getPNForLID?: (l: string) => string | undefined } } })
      ?.signalRepository?.lidMapping?.getPNForLID?.(lid);
    if (pn?.endsWith('@s.whatsapp.net')) { linkLidPn(lid, pn); return pn; }
  } catch {
    /* no mapping available */
  }
  return undefined;
}

/** Best display name for a chat id. Priority matters: an ADDRESSBOOK name (direct
 *  or via the lid↔phone bridge) must beat a chat "title", because WhatsApp often
 *  sets a DM's title to the bare phone number — which would otherwise shadow the
 *  real saved name (this was the "Anish shows as a number" bug). */
function resolveName(jid: string, fallback: string): string {
  // Only accept LETTER-bearing names; skip masked-number junk already in the store
  // (loaded from an older sync) so it can't shadow the real bridged name.
  const direct = contactNames.get(jid);
  if (hasLetter(direct)) return direct;
  if (jid.endsWith('@lid')) {
    const pn = pnForLid(jid);
    if (pn && hasLetter(contactNames.get(pn))) return contactNames.get(pn)!;
  } else if (jid.endsWith('@s.whatsapp.net')) {
    const lid = pnToLid.get(jid);
    if (lid && hasLetter(contactNames.get(lid))) return contactNames.get(lid)!;
  }
  const title = chatNames.get(jid);
  return hasLetter(title) ? title : fallback; // group subject / chat title, else the number
}

// ---- persistence (debounced; atomic write) --------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) return; // coalesce the history burst into one write per 2s
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const data = {
        v: 1,
        chats: [...chats.entries()],
        messages: [...messages.entries()],
        contactNames: [...contactNames.entries()],
        chatNames: [...chatNames.entries()],
        lidToPn: [...lidToPn.entries()],
      };
      const tmp = `${STORE_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, STORE_FILE); // atomic swap — a crash never leaves a half file
    } catch (e) {
      console.error('[whatsapp-bridge] store save failed:', e instanceof Error ? e.message : e);
    }
  }, 2000);
  saveTimer.unref?.();
}
function loadStore(): void {
  if (!existsSync(STORE_FILE)) return;
  try {
    const d = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as {
      chats?: [string, BridgeChat][]; messages?: [string, BridgeMessage[]][];
      contactNames?: [string, string][]; chatNames?: [string, string][]; lidToPn?: [string, string][];
    };
    for (const [k, v] of d.chats ?? []) chats.set(k, v);
    for (const [k, v] of d.messages ?? []) messages.set(k, v);
    for (const [k, v] of d.contactNames ?? []) contactNames.set(k, v);
    for (const [k, v] of d.chatNames ?? []) chatNames.set(k, v);
    for (const [lid, pn] of d.lidToPn ?? []) { lidToPn.set(lid, pn); pnToLid.set(pn, lid); }
    console.log(`[whatsapp-bridge] store loaded: ${chats.size} chats, ${contactNames.size} contacts, ${lidToPn.size} lid maps`);
  } catch (e) {
    console.error('[whatsapp-bridge] store load failed (starting empty):', e instanceof Error ? e.message : e);
  }
}
let paired = false;
let me = '';
let currentQr: string | null = null; // latest QR string; served at /qr, cleared on pair
let needsRepair = false; // WhatsApp invalidated the session (logout) — a human must re-scan
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
 try {
  const chatId = m.key.remoteJid;
  const text = msgText(m);
  if (!chatId || chatId === 'status@broadcast' || !text) return;
  // Baileys 7 carries the alternate address on the key — the reliable per-chat
  // lid↔phone link. Capture whichever direction is present.
  const k = m.key as { remoteJid?: string; remoteJidAlt?: string; participant?: string; participantAlt?: string };
  if (k.remoteJidAlt) {
    if (chatId.endsWith('@lid')) linkLidPn(chatId, k.remoteJidAlt);
    else linkLidPn(k.remoteJidAlt, chatId);
  }
  if (k.participant && k.participantAlt) {
    if (k.participant.endsWith('@lid')) linkLidPn(k.participant, k.participantAlt);
    else linkLidPn(k.participantAlt, k.participant);
  }
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
  scheduleSave();
 } catch {
  /* one malformed history/live message must never crash the bridge */
 }
}

let sock: ReturnType<typeof makeWASocket>;
async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, syncFullHistory: true });
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
      needsRepair = false; // a good connection clears any prior logout flag
      currentQr = null;
      me = sock.user?.id?.split(':')[0] ?? 'unknown';
      console.log(`[whatsapp-bridge] paired as +${me}`);
    }
    if (u.connection === 'close') {
      paired = false;
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        // WhatsApp invalidated the session. Do NOT die and do NOT reconnect-loop:
        // stay up, keep serving CACHED chats from the store, and flag needsRepair so
        // `pnpm status` / the dashboard surfaces "re-pair needed" instead of silence.
        needsRepair = true;
        console.error('[whatsapp-bridge] logged out — RE-PAIR NEEDED: open /qr and re-scan (cached reads still served)');
        return;
      }
      // Everything else — including 515 restart-required, which Baileys ALWAYS
      // emits right after a successful pairing — means reconnect. Use the saved
      // creds (no new QR); catch the reconnect promise so a transient failure
      // can never become an unhandledRejection that kills the process.
      const delay = code === DisconnectReason.restartRequired ? 250 : 2000;
      console.warn(`[whatsapp-bridge] connection closed (code ${code ?? '?'}) — reconnecting in ${delay}ms`);
      setTimeout(() => {
        connect().catch((e) => console.error('[whatsapp-bridge] reconnect failed (will retry on next close):', e instanceof Error ? e.message : e));
      }, delay);
    }
  });
  // Full-history burst: chats + contacts + messages arrive here in batches.
  sock.ev.on('messaging-history.set', ({ chats: hChats, contacts: hContacts, messages: hist }) => {
    (hContacts ?? []).forEach((c) => rememberContact(c as NamedContact));
    (hChats ?? []).forEach((c) => rememberChat(c as { id?: string; name?: string }));
    (hist ?? []).forEach(ingest);
    historyChats += hChats?.length ?? 0;
    console.log(`[whatsapp-bridge] history batch: +${hChats?.length ?? 0} chats, +${hContacts?.length ?? 0} contacts (total chats seen: ${chats.size})`);
  });
  // Live updates keep names fresh after the initial sync.
  sock.ev.on('contacts.upsert', (cs) => cs.forEach((c) => rememberContact(c as NamedContact)));
  sock.ev.on('contacts.update', (cs) => cs.forEach((c) => rememberContact(c as NamedContact)));
  sock.ev.on('chats.upsert', (cs) => cs.forEach((c) => rememberChat(c as { id?: string; name?: string })));
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

app.get('/health', async () => {
  // M12a: WhatsApp splits the user's own "message yourself" thread across TWO
  // ids — the phone JID and a privacy @lid alias (dogfooded 2026-07-11: a
  // command sent from the phone landed in the @lid twin and the remote poller
  // never saw it). Report EVERY id the self-chat lives under so the poller
  // can watch them all.
  const selfChats: string[] = [];
  if (me) {
    const pn = `${me}@s.whatsapp.net`;
    selfChats.push(pn);
    const lid = pnToLid.get(pn);
    if (lid) selfChats.push(lid);
  }
  return { ok: true, paired, needsRepair, me, selfChats, impl: 'baileys' };
});
app.get('/chats', async (req) => {
  const { limit: limitRaw, search } = req.query as { limit?: string; search?: string };
  const limit = Math.min(Number(limitRaw) || 20, 200);
  const q = (search ?? '').trim().toLowerCase();
  let list = [...chats.values()]
    .map((c) => ({ ...c, name: resolveName(c.id, c.name) })) // apply addressbook names
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  return { total: chats.size, chats: list.slice(0, limit) };
});

// Search the full ADDRESS BOOK (not just chats) — reach anyone by name and get a
// sendable JID, even with no existing conversation. Phone JIDs only (messageable).
app.get('/contacts', async (req) => {
  const q = ((req.query as { search?: string }).search ?? '').trim().toLowerCase();
  const seen = new Set<string>();
  const all = [...contactNames.entries()]
    .filter(([jid]) => jid.endsWith('@s.whatsapp.net'))
    .map(([jid, name]) => ({ jid, name }))
    .filter((c) => (seen.has(c.jid) ? false : seen.add(c.jid)));
  const list = (q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all).sort((a, b) => a.name.localeCompare(b.name));
  return { total: all.length, contacts: list.slice(0, 50) };
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

// Backstop: an always-on personal bridge must OUTLIVE transient Baileys errors.
// Baileys emits socket errors during the normal pair→restart→resync churn; an
// unhandled one would otherwise exit the process (this is exactly what killed
// the first pairing — exit 4). Log and stay up; the reconnect logic recovers.
process.on('unhandledRejection', (r) => console.error('[whatsapp-bridge] unhandledRejection (staying up):', r instanceof Error ? r.message : r));
process.on('uncaughtException', (e) => console.error('[whatsapp-bridge] uncaughtException (staying up):', e instanceof Error ? e.message : e));

loadStore(); // reload the synced view before connecting — restarts need no re-scan
await connect();
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`[whatsapp-bridge] contract API on http://127.0.0.1:${PORT} (impl: baileys) — open /qr to pair`);
