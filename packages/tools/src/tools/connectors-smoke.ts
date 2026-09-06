// App-connector smoke — no network, no DB, no browser. Pins the pure logic:
// name normalisation and the argument contracts.
//
// The save/list/run round trip needs Postgres AND the Playwright bridge, so it
// lives in the live check rather than here; what IS pinned here is the piece
// that silently broke first — slug(). The initial version turned
// "HN Top Stories!!" into "hn-top-stories-" (trailing punctuation became a
// hyphen), so saving under a human name and then running the obvious slug threw
// `no connector named "hn-top-stories"`. A connector you cannot call by its own
// name is worse than no connector, and nothing else would have caught it.
import { slug, appScrape, appSave, appRun } from './connectors.js';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

console.log('— name normalisation: save and run must agree —');
for (const [input, want] of [
  ['HN Top Stories!!', 'hn-top-stories'],
  ['HN Top Stories', 'hn-top-stories'],
  ['  Instagram  Notifications  ', 'instagram-notifications'],
  ['instagram-notifications', 'instagram-notifications'],
  ['LinkedIn / Messages', 'linkedin-messages'],
  ['---weird---', 'weird'],
] as const) {
  check(`"${input}" -> ${want}`, slug(input) === want, slug(input));
}
// The actual regression: the messy form and the tidy form must collide, because
// that is what makes app_run findable after app_save.
check('a messy name and its tidy form resolve to the SAME key', slug('HN Top Stories!!') === slug('hn-top-stories'), `${slug('HN Top Stories!!')} vs ${slug('hn-top-stories')}`);
check('an empty name slugs to empty (so save can reject it)', slug('   ') === '');

console.log('\n— argument contracts fail loudly, never silently —');
const ctx = { pool: null, taskId: null } as never;
const err = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return '(no error — IT WENT THROUGH)';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

check('app_scrape without fields is rejected', /fields is required/.test(await err(() => appScrape.execute({}, ctx))));
check('app_scrape with empty fields is rejected', /fields is required/.test(await err(() => appScrape.execute({ fields: {} }, ctx))));
check('app_save without a name is rejected', /name is required/.test(await err(() => appSave.execute({ name: '!!!', url: 'https://x.com', fields: { a: 'b' } }, ctx))));
// A non-http url would be stored and then handed to the browser on every replay.
check('app_save rejects a non-http url', /http\(s\) URL/.test(await err(() => appSave.execute({ name: 'x', url: 'file:///etc/passwd', fields: { a: 'b' } }, ctx))));
check('app_save rejects empty fields', /fields is required/.test(await err(() => appSave.execute({ name: 'x', url: 'https://example.com', fields: {} }, ctx))));
check('app_run without a name cannot silently no-op', (await err(() => appRun.execute({}, ctx))).length > 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
