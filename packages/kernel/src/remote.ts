// M12a — WhatsApp remote control (ADR-0015). The self-chat is the command
// channel: the poller reads Akhil's message-yourself thread through the bridge
// contract and treats as commands ONLY messages that are (a) fromMe — nobody
// else can write there — and (b) prefixed with the trigger ("@os" by default).
//
// Trust model:
//  - a command is TRUSTED user input (his own authenticated session), routed
//    through the ordinary chat path — classifier, Brain, trust gate, approvals;
//  - replies are INTERFACE plumbing (deterministic code posting to the self
//    chat, like the web UI rendering a reply) — the model gains no new send
//    capability, whatsapp_send_message still queues for approval;
//  - loop prevention is structural: replies never carry the trigger prefix,
//    the poller skips ids it sent, and a watermark survives restarts.
//
// Everything here is pure logic over injected deps — remote-smoke drives it
// deterministically against the mock bridge shape; server.ts binds the real
// bridge client, /chat path, and pending_actions.

export interface RemoteMessage {
  id: string;
  fromMe: boolean;
  text: string;
  timestamp: string; // ISO
}

export interface RemoteCursor {
  lastTs: string | null;
  seenIds: string[];
  announced: string[]; // pending_action ids already prompted on the phone
}

export interface PendingSummary {
  id: string;
  tool: string;
  args: unknown;
  untrusted: boolean;
}

export interface RemoteDeps {
  /** selfChats: EVERY id the user's own chat lives under — WhatsApp splits
   *  the message-yourself thread across the phone JID and a privacy @lid
   *  alias (a phone-sent command landed in the @lid twin live 2026-07-11).
   *  Absent → derived from `me`. */
  health(): Promise<{ ok: boolean; paired: boolean; me?: string; selfChats?: string[] }>;
  messages(chatId: string, limit: number): Promise<RemoteMessage[]>;
  send(chatId: string, text: string): Promise<{ messageId?: string }>;
  /** Run a goal through the normal chat trust path; returns the reply text. */
  runCommand(text: string): Promise<string>;
  /** Decide a pending action by id PREFIX; returns a confirmation line. */
  decidePending(idPrefix: string, decision: 'approved' | 'rejected'): Promise<string>;
  /** All currently pending approvals (tick filters against cursor.announced). */
  listPending(): Promise<PendingSummary[]>;
  loadCursor(): Promise<RemoteCursor>;
  saveCursor(c: RemoteCursor): Promise<void>;
  trigger?: string; // default '@os'
}

export type RemoteCommand =
  | { kind: 'decision'; decision: 'approved' | 'rejected'; idPrefix: string }
  | { kind: 'goal'; text: string };

const SEEN_CAP = 200;
const ANNOUNCED_CAP = 100;
export const SHORT_ID_LEN = 8;

/** Parse one self-chat message into a command, or null when it isn't one
 *  (no trigger prefix / not fromMe / empty after the trigger). */
export function parseRemoteCommand(m: RemoteMessage, trigger = '@os'): RemoteCommand | null {
  if (!m.fromMe || !m.text) return null;
  const t = m.text.trim();
  if (!t.toLowerCase().startsWith(trigger.toLowerCase())) return null;
  const rest = t.slice(trigger.length).trim();
  if (!rest) return null;
  const dec = /^(approve|yes|ok|cancel|reject|no)\s+([0-9a-f-]{4,})$/i.exec(rest);
  if (dec) {
    const decision = /^(approve|yes|ok)$/i.test(dec[1]!) ? 'approved' : 'rejected';
    return { kind: 'decision', decision, idPrefix: dec[2]!.toLowerCase() };
  }
  return { kind: 'goal', text: rest };
}

/** One WhatsApp approval prompt: the EXACT tool + args the user is deciding
 *  on — the phone-sized twin of the in-chat approval card. */
export function formatApprovalPrompt(p: PendingSummary, trigger = '@os'): string {
  const argStr = JSON.stringify(p.args ?? {});
  const short = p.id.replace(/-/g, '').slice(0, SHORT_ID_LEN);
  return (
    `⏳ Approval needed [${short}]\n${p.tool}(${argStr.length > 300 ? argStr.slice(0, 300) + '…' : argStr})` +
    (p.untrusted ? '\n⚠ Prepared while untrusted content was in context — verify before approving.' : '') +
    `\nReply "${trigger} approve ${short}" or "${trigger} cancel ${short}".`
  );
}

export interface RemoteTickResult {
  skipped?: 'unpaired' | 'no-self-chat' | 'first-run';
  processed: number;
  replies: number;
  announced: number;
}

/** One poll cycle: read new self-chat commands → run/decide → reply → announce
 *  fresh approvals → persist the cursor. Never throws for a single bad
 *  command; a command failure becomes an apologetic reply. */
export async function tickRemote(deps: RemoteDeps): Promise<RemoteTickResult> {
  const trigger = deps.trigger ?? '@os';
  const h = await deps.health();
  if (!h.ok || !h.paired) return { skipped: 'unpaired', processed: 0, replies: 0, announced: 0 };
  const me = h.me ?? '';
  const selfChats = h.selfChats?.length ? h.selfChats : me ? [me.includes('@') ? me : `${me}@s.whatsapp.net`] : [];
  if (selfChats.length === 0) return { skipped: 'no-self-chat', processed: 0, replies: 0, announced: 0 };
  const primaryChat = selfChats[0]!; // announcements go here; replies go where the command arrived

  const cursor = await deps.loadCursor();
  const seen = new Set(cursor.seenIds ?? []);
  const announced = new Set(cursor.announced ?? []);
  // Merge every self-chat alias into one command stream.
  const msgs: Array<RemoteMessage & { chatId: string }> = [];
  for (const chatId of selfChats) {
    try {
      for (const m of await deps.messages(chatId, 25)) msgs.push({ ...m, chatId });
    } catch {
      /* an alias the bridge has no history for yet — skip it this tick */
    }
  }
  const maxTs = msgs.reduce<string | null>((m, x) => (m === null || x.timestamp > m ? x.timestamp : m), cursor.lastTs);

  // First run: initialize the watermark and process NOTHING — years of
  // note-to-self history must never replay as commands.
  if (cursor.lastTs === null) {
    await deps.saveCursor({ lastTs: maxTs, seenIds: [...seen].slice(-SEEN_CAP), announced: [...announced].slice(-ANNOUNCED_CAP) });
    return { skipped: 'first-run', processed: 0, replies: 0, announced: 0 };
  }

  const fresh = msgs
    .filter((m) => m.fromMe && m.timestamp > cursor.lastTs! && !seen.has(m.id))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

  let processed = 0;
  let replies = 0;
  for (const m of fresh) {
    seen.add(m.id);
    const cmd = parseRemoteCommand(m, trigger);
    if (!cmd) continue; // an ordinary self-note — not ours
    processed++;
    let reply: string;
    try {
      reply = cmd.kind === 'decision' ? await deps.decidePending(cmd.idPrefix, cmd.decision) : await deps.runCommand(cmd.text);
    } catch (err) {
      reply = `⚠ That command failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`;
    }
    try {
      // Reply into the alias the command arrived in (same visual thread on the phone).
      const sent = await deps.send(m.chatId, reply);
      replies++;
      if (sent.messageId) seen.add(sent.messageId); // structural loop-prevention
    } catch {
      /* bridge hiccup — the reply is lost but state stays consistent; the user can re-ask */
    }
  }

  // Announce approvals that queued since we last looked (AFTER command
  // processing, so "@os approve" for an earlier prompt works within one tick).
  let announcedNow = 0;
  for (const p of await deps.listPending()) {
    if (announced.has(p.id)) continue;
    try {
      const sent = await deps.send(primaryChat, formatApprovalPrompt(p, trigger));
      announced.add(p.id);
      announcedNow++;
      if (sent.messageId) seen.add(sent.messageId);
    } catch {
      /* retry next tick — not marked announced */
    }
  }

  await deps.saveCursor({
    lastTs: maxTs,
    seenIds: [...seen].slice(-SEEN_CAP),
    announced: [...announced].slice(-ANNOUNCED_CAP),
  });
  return { processed, replies, announced: announcedNow };
}
