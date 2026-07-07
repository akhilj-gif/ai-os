// The WhatsApp BRIDGE CONTRACT (ADR-0013). The OS never touches WhatsApp
// directly — a separate bridge process owns the session (pairing, creds, socket)
// and exposes this tiny localhost HTTP API. The pack's tools speak ONLY this
// contract, so the implementation behind it (Baileys today, anything tomorrow,
// the deterministic mock in evals) is swappable without touching the OS.
//
//   GET  /health                        → { ok, paired, me? }
//   GET  /chats?limit=20                → { chats: BridgeChat[] }
//   GET  /messages?chatId=&limit=25     → { messages: BridgeMessage[] }
//   POST /send { chatId, text }         → { ok, messageId }
//
// The bridge itself enforces NO policy — the OS's trust gate does (send is
// irreversible-class + approval-required; message content is untrusted §8.3).
// Binding is 127.0.0.1-only; WHATSAPP_BRIDGE_TOKEN (optional) is a shared
// secret required in the `x-bridge-token` header when set.

export interface BridgeChat {
  id: string; // WhatsApp JID, e.g. "9198…@s.whatsapp.net" or "…@g.us" for groups
  name: string;
  isGroup: boolean;
  unread: number;
  lastMessageAt: string | null; // ISO
}

export interface BridgeMessage {
  id: string;
  chatId: string;
  from: string; // sender display name or number
  fromMe: boolean;
  text: string;
  timestamp: string; // ISO
}

export interface BridgeHealth {
  ok: boolean;
  paired: boolean;
  me?: string;
  impl: 'baileys' | 'mock';
}

export const DEFAULT_BRIDGE_PORT = 4100;
export const bridgeUrl = (): string => process.env.WHATSAPP_BRIDGE_URL ?? `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;
