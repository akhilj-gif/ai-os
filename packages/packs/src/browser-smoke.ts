// M15 browser smoke — deterministic, no browser, no network (ADR-0018). Proves
// the mock browser flow + the pack's trust posture: navigate→read returns the
// page, find returns refs, act records to a log (and a link-click navigates),
// and the pack classifies browser_act irreversible/never-auto while the read
// family is auto. No real web action happens.
// Run: npx tsx packages/packs/src/browser-smoke.ts
import { browserNavigate, browserRead, browserFind, browserExtract, browserAct, browserMockActions } from '@ai-os/tools';
import { PACKS } from './index.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

// Guard: mock-only assertions — a configured bridge would drive a real browser.
if (process.env.BROWSER_BRIDGE_URL) {
  console.log('SKIP  BROWSER_BRIDGE_URL is set — this smoke only runs against the mock.');
  process.exit(0);
}
const ctx = { pool: null as never, taskId: 'smoke' };

console.log('— navigate + read —');
{
  const nav = (await browserNavigate.execute({ url: 'https://example.com' }, ctx)) as { title?: string; error?: string };
  check('navigate to home returns its title', nav.title === 'Example Home', nav.error ?? nav.title);
  const bad = (await browserNavigate.execute({ url: 'not-a-url' }, ctx)) as { error?: string };
  check('non-absolute url refused', !!bad.error);
  const read = (await browserRead.execute({}, ctx)) as { text?: string };
  check('read returns the page text', (read.text ?? '').includes('Welcome to Example'));
}

console.log('\n— find + read-only navigation via act(click link) —');
{
  await browserNavigate.execute({ url: 'https://example.com/contact' }, ctx);
  const found = (await browserFind.execute({ query: 'button' }, ctx)) as { matches: Array<{ ref: string; name: string }> };
  check('find returns the contact-page buttons', found.matches.some((m) => m.ref === 'b-submit') && found.matches.some((m) => m.ref === 'b-delete'));
  const extract = (await browserExtract.execute({ instruction: 'the message' }, ctx)) as { text?: string };
  check('extract returns page text (untrusted)', (extract.text ?? '').includes('message'));
}

console.log('\n— act records to the mock log (no real web change) —');
{
  const before = browserMockActions.length;
  const r = (await browserAct.execute({ action: 'type', ref: 'f-message', text: 'hello there' }, ctx)) as { ok?: boolean };
  check('type action recorded', r.ok === true && browserMockActions.length === before + 1);
  const click = (await browserAct.execute({ action: 'click', ref: 'l-home' }, ctx)) as { navigatedTo?: string };
  check('clicking a link navigates in the mock', click.navigatedTo === 'https://example.com/');
}

console.log('\n— pack manifest trust posture —');
{
  const pack = PACKS.browser;
  check('browser pack registered with all five tools', !!pack && pack.tools.length === 5);
  const reads = ['browser_navigate', 'browser_read', 'browser_find', 'browser_extract'];
  check('read family is read + auto', reads.every((t) => { const p = pack!.policies.find((x) => x.tool === t); return p?.trustClass === 'read' && p.autoApprove === true; }));
  const act = pack!.policies.find((p) => p.tool === 'browser_act');
  check('browser_act is irreversible + NEVER auto', act?.trustClass === 'irreversible' && act.autoApprove === false);
  const untrusted = pack!.tools.filter((t) => t.untrustedOutput).map((t) => t.name);
  check('read family flagged untrustedOutput (injection defense)', ['browser_navigate', 'browser_read', 'browser_find', 'browser_extract'].every((t) => untrusted.includes(t)));
  check('browser_act is NOT untrustedOutput', !untrusted.includes('browser_act'));
  check('pack bundles the browser eval suite', pack!.evalSuites.includes('browser'));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
