// M12c x-pack smoke â€” deterministic, no model, no network (ADR-0015). Proves
// the mock client + validation behavior that the pack's trust posture rests
// on: publishes land ONLY in the local outbox when no keys exist, the 280
// limit is enforced on both draft and publish, and the pack manifest carries
// the irreversible/never-auto publish policy.
// Run: npx tsx packages/packs/src/x-smoke.ts
import { xGetMe, xDraftPost, xPublishPost, xMockOutbox, X_MAX_CHARS } from '@ai-os/tools';
import { PACKS } from './index.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` â€” ${detail}` : ''}`);
  if (!cond) failures++;
}

// Guard: this smoke asserts MOCK behavior â€” real keys would make x_publish_post
// actually publish. Refuse to run against a keyed environment.
if (process.env.X_API_KEY) {
  console.log('SKIP  X_API_KEY is set â€” this smoke only runs against the mock client.');
  process.exit(0);
}

const ctx = { pool: null as never, taskId: 'smoke' };

console.log('â€” mock client â€”');
{
  const me = (await xGetMe.execute({}, ctx)) as { username: string; mock?: boolean };
  check('get_me serves the mock identity', me.username === 'akhil_mock' && me.mock === true);
}
{
  const d = (await xDraftPost.execute({ text: 'Hello from the AI OS' }, ctx)) as { ok: boolean; chars: number };
  check('draft validates a short post', d.ok === true && d.chars === 20);
  const long = (await xDraftPost.execute({ text: 'x'.repeat(300) }, ctx)) as { ok: boolean; over: number };
  check('draft rejects >280 with the overage count', long.ok === false && long.over === 300 - X_MAX_CHARS);
}
{
  const before = xMockOutbox.length;
  const p = (await xPublishPost.execute({ text: 'First mock post' }, ctx)) as { ok: boolean; id: string; mock?: boolean };
  check('publish lands in the mock outbox only', p.ok === true && p.mock === true && xMockOutbox.length === before + 1);
  check('outbox records the exact text', xMockOutbox.at(-1)!.text === 'First mock post');
  let threw = false;
  try {
    await xPublishPost.execute({ text: 'y'.repeat(281) }, ctx);
  } catch {
    threw = true;
  }
  check('publish refuses >280 outright', threw && xMockOutbox.length === before + 1);
}

console.log('\nâ€” pack manifest trust posture â€”');
{
  const pack = PACKS.x;
  check('x pack registered', !!pack && pack.tools.length === 3);
  const pub = pack!.policies.find((p) => p.tool === 'x_publish_post');
  check('publish is irreversible + never auto', pub?.trustClass === 'irreversible' && pub.autoApprove === false);
  const draft = pack!.policies.find((p) => p.tool === 'x_draft_post');
  check('draft is write-class + auto (stateless)', draft?.trustClass === 'write' && draft.autoApprove === true);
  check('pack bundles the x eval suite', pack!.evalSuites.includes('x'));
  check('pack declares the key requirement honestly', (pack!.requires ?? []).some((r) => r.includes('X_API_KEY')));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
