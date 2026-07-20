// Deterministic WhatsApp-pack checks (NO model, NO real WhatsApp). Boots the
// MOCK bridge in-process and drives the pack's REAL tools against it, then
// proves the policy story: send classifies irreversible + non-auto (via a real
// pack install), the structural gate blocks a send once untrusted chat content
// is in context, and the bridge-down path fails with a helpful error.
// Run: tsx apps/whatsapp-bridge/src/smoke.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { whatsappListChats, whatsappReadMessages, whatsappSendMessage } from '@ai-os/tools';
import { TrustGate, blockedByUntrustedContext } from '@ai-os/trust';
import { installPack } from '@ai-os/packs';
import { startMockBridge } from './mock.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const ctx = { pool, taskId: 'whatsapp-smoke' };

console.log('— tools ↔ mock bridge (real HTTP, real tool code) —');
const bridge = await startMockBridge(0);
process.env.WHATSAPP_BRIDGE_URL = bridge.url;

const chats = (await whatsappListChats.execute({}, ctx)) as { chats: Array<{ id: string; name: string; unread: number }> };
// Name-based, not a count: M12 added the self-chat fixture ("You (self)") for
// remote-control tests and the old `=== 3` failed silently ever since.
check(
  'list_chats returns the fixture chats',
  ['Mom', 'Flatmates 3B', 'You (self)'].every((n) => chats.chats.some((c) => c.name === n)),
  chats.chats.map((c) => c.name).join(', '),
);
check('unread counts present', chats.chats.every((c) => typeof c.unread === 'number'));

const mom = (await whatsappReadMessages.execute({ chatId: 'mom@s.whatsapp.net' }, ctx)) as { messages: Array<{ text: string; fromMe: boolean }> };
check('read_messages returns Mom’s messages', mom.messages.length === 2 && mom.messages[0]!.text.includes('Did you eat'));

let notFound = false;
try {
  await whatsappReadMessages.execute({ chatId: 'nope@s.whatsapp.net' }, ctx);
} catch (err) {
  notFound = /404|no such chat/.test(String(err));
}
check('unknown chat → clean error (no crash)', notFound);

const sent = (await whatsappSendMessage.execute({ chatId: 'mom@s.whatsapp.net', text: 'smoke says hi' }, ctx)) as { ok: boolean; messageId: string };
check('send posts to the bridge and returns a messageId', sent.ok && !!sent.messageId);
check('the send landed ONLY in the mock outbox (nothing real)', bridge.outbox.length === 1 && bridge.outbox[0]!.text === 'smoke says hi');

console.log('\n— untrusted-content wiring (§8.3) —');
check('list_chats output is marked UNTRUSTED', whatsappListChats.untrustedOutput === true);
check('read_messages output is marked UNTRUSTED (messages = the injection vector)', whatsappReadMessages.untrustedOutput === true);
check('send has no untrusted OUTPUT flag (it is an ACTION, gated instead)', !whatsappSendMessage.untrustedOutput);

console.log('\n— policy story (real install → real gate) —');
// Snapshot: restore the pre-smoke install state at the end, never assume it.
const wasInstalled = ((await pool.query(`SELECT 1 FROM capability_packs WHERE name='whatsapp'`)).rowCount ?? 0) > 0;
const install = await installPack(pool, 'whatsapp');
check('pack installs (policies applied or already present)', install.name === 'whatsapp', `policies applied: ${install.policiesApplied}`);
const gate = new TrustGate(pool);
const sendDecision = await gate.classify('whatsapp_send_message');
check('send classifies IRREVERSIBLE', sendDecision.trustClass === 'irreversible', sendDecision.trustClass);
check('send is NEVER auto-approved', sendDecision.autoApprove === false);
const readDecision = await gate.classify('whatsapp_read_messages');
check('read classifies read + auto', readDecision.trustClass === 'read' && readDecision.autoApprove === true);
check('structural gate: untrusted chat content in context BLOCKS a send', blockedByUntrustedContext('irreversible', true) === true);
check('…but never blocks further reading', blockedByUntrustedContext('read', true) === false);

console.log('\n— bridge-down honesty —');
await bridge.close();
let downMsg = '';
try {
  await whatsappListChats.execute({}, ctx);
} catch (err) {
  downMsg = String(err);
}
check('bridge down → helpful actionable error', /unreachable/.test(downMsg) && /whatsapp-bridge/.test(downMsg), downMsg.slice(20, 90));

// cleanup: restore the pre-smoke world. If whatsapp was already installed (real
// user state), the install above was an idempotent re-install — keep everything.
if (!wasInstalled) {
  await pool.query(`DELETE FROM memory_records WHERE tags @> ARRAY['pack:whatsapp']`);
  await pool.query(`DELETE FROM capability_packs WHERE name='whatsapp'`);
  await pool.query(`DELETE FROM tasks WHERE id=$1`, [install.installTaskId]);
  await pool.query(`DELETE FROM trust_policies WHERE tool LIKE 'whatsapp_%'`);
}
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
await pool.end();
process.exit(fail ? 1 : 0);
