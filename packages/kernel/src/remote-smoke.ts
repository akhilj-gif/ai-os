// M12a remote-control smoke — deterministic, no DB, no model. Drives
// tickRemote against the REAL mock bridge over real HTTP (in-process), with
// stubbed runCommand/decidePending. Proves the ADR-0015 exit criteria:
// command → reply in outbox; approval prompt → "@os approve" → decided;
// self-notes ignored; first run replays nothing; own replies never re-trigger.
// Run: npx tsx packages/kernel/src/remote-smoke.ts
import { startMockBridge, MOCK_ME } from '../../../apps/whatsapp-bridge/src/mock.js';
import { tickRemote, parseRemoteCommand, formatApprovalPrompt, type RemoteCursor, type PendingSummary, type RemoteDeps } from './remote.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

console.log('— parseRemoteCommand —');
{
  const msg = (text: string, fromMe = true) => ({ id: 'x', fromMe, text, timestamp: '2026-07-10T00:00:00Z' });
  check('plain goal parses', parseRemoteCommand(msg('@os what is on my calendar?'))?.kind === 'goal');
  check('trigger is case-insensitive', parseRemoteCommand(msg('@OS hello'))?.kind === 'goal');
  check('approve parses with short id', JSON.stringify(parseRemoteCommand(msg('@os approve a1b2c3d4'))) === '{"kind":"decision","decision":"approved","idPrefix":"a1b2c3d4"}');
  check('cancel parses', (parseRemoteCommand(msg('@os cancel a1b2c3d4')) as { decision?: string })?.decision === 'rejected');
  check('self-note without trigger ignored', parseRemoteCommand(msg('buy milk, call electrician')) === null);
  check('not-fromMe ignored even with trigger', parseRemoteCommand(msg('@os do something', false)) === null);
  check('bare trigger ignored', parseRemoteCommand(msg('@os   ')) === null);
}

console.log('\n— tickRemote against the mock bridge —');
const bridge = await startMockBridge(0);
const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${bridge.url}${path}`, { headers: { 'content-type': 'application/json' }, ...init });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
};

let cursor: RemoteCursor = { lastTs: null, seenIds: [], announced: [] };
const ranCommands: string[] = [];
const decided: string[] = [];
let pending: PendingSummary[] = [];

const deps: RemoteDeps = {
  health: () => call('/health'),
  messages: (chatId, limit) => call<{ messages: RemoteDeps extends never ? never : Array<{ id: string; fromMe: boolean; text: string; timestamp: string }> }>(`/messages?chatId=${encodeURIComponent(chatId)}&limit=${limit}`).then((r) => r.messages),
  send: (chatId, text) => call('/send', { method: 'POST', body: JSON.stringify({ chatId, text }) }),
  runCommand: async (text) => {
    ranCommands.push(text);
    return `Answer to: ${text}`;
  },
  decidePending: async (idPrefix, decision) => {
    decided.push(`${decision}:${idPrefix}`);
    pending = pending.filter((p) => !p.id.replace(/-/g, '').startsWith(idPrefix));
    return decision === 'approved' ? '✅ Done — executed.' : '❌ Cancelled.';
  },
  listPending: async () => pending,
  loadCursor: async () => cursor,
  saveCursor: async (c) => {
    cursor = c;
  },
};

// 1. First run: fixture self-note exists → watermark set, nothing processed.
{
  const r = await tickRemote(deps);
  check('first run replays nothing', r.skipped === 'first-run' && ranCommands.length === 0);
  check('first run sets the watermark', cursor.lastTs !== null);
}

// 2. A self-note arrives → still nothing (no trigger).
{
  await call('/inbox', { method: 'POST', body: JSON.stringify({ chatId: MOCK_ME, text: 'remember to sleep' }) });
  const r = await tickRemote(deps);
  check('post-watermark self-note ignored', r.processed === 0 && ranCommands.length === 0);
}

// 3. A command arrives → runs through runCommand, reply lands in the outbox.
{
  await call('/inbox', { method: 'POST', body: JSON.stringify({ chatId: MOCK_ME, text: '@os what is on my plate today?' }) });
  const r = await tickRemote(deps);
  check('command processed once', r.processed === 1 && ranCommands.join() === 'what is on my plate today?');
  check('reply sent to the self-chat', bridge.outbox.some((o) => o.chatId === MOCK_ME && o.text === 'Answer to: what is on my plate today?'));
}

// 4. The OS's own reply is now IN the chat history (mock mirrors sends) — the
//    next tick must not re-trigger on it, even though it is fromMe and fresh.
{
  const r = await tickRemote(deps);
  check('own reply never re-triggers (no loop)', r.processed === 0 && ranCommands.length === 1);
}

// 5. An approval queues → prompt announced on the phone with the exact tool+args.
{
  pending = [{ id: 'f00dfeed-1111-2222-3333-444455556666', tool: 'whatsapp_send_message', args: { chatId: 'mom@s.whatsapp.net', text: 'hi' }, untrusted: true }];
  const r = await tickRemote(deps);
  const prompt = bridge.outbox.at(-1)!;
  check('approval announced once', r.announced === 1 && prompt.text.includes('whatsapp_send_message') && prompt.text.includes('f00dfeed'));
  check('untrusted warning included', prompt.text.includes('untrusted content'));
  const r2 = await tickRemote(deps);
  check('not re-announced next tick', r2.announced === 0);
}

// 6. "@os approve <short>" decides it through decidePending.
{
  await call('/inbox', { method: 'POST', body: JSON.stringify({ chatId: MOCK_ME, text: '@os approve f00dfeed' }) });
  const r = await tickRemote(deps);
  check('approve decided the pending action', decided.join() === 'approved:f00dfeed' && r.processed === 1);
  check('confirmation reply sent', bridge.outbox.at(-1)!.text.includes('Done'));
}

// 7. A failing command becomes an apologetic reply, never a crash.
{
  deps.runCommand = async () => {
    throw new Error('INFRA_RATELIMIT 429');
  };
  await call('/inbox', { method: 'POST', body: JSON.stringify({ chatId: MOCK_ME, text: '@os broken thing' }) });
  const r = await tickRemote(deps);
  check('command failure → apologetic reply', r.replies === 1 && bridge.outbox.at(-1)!.text.startsWith('⚠ That command failed'));
}

// 8. Restart survival: a FRESH process (cursor reloaded from "DB") sees the
//    same history and processes nothing new.
{
  const before = ranCommands.length;
  const r = await tickRemote(deps); // same persisted cursor
  check('restart replays nothing', r.processed === 0 && ranCommands.length === before);
}

// 9. formatApprovalPrompt is phone-sized and self-describing.
{
  const p = formatApprovalPrompt({ id: 'aaaabbbb-0000-0000-0000-000000000000', tool: 'x_publish_post', args: { text: 'hello world' }, untrusted: false });
  check('prompt carries tool, args, and reply instructions', p.includes('x_publish_post') && p.includes('hello world') && p.includes('@os approve aaaabbbb'));
}

await bridge.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
// No process.exit: it races Fastify's socket teardown on Windows (libuv
// UV_HANDLE_CLOSING assertion). Let the loop drain; set the code instead.
process.exitCode = failures === 0 ? 0 : 1;
