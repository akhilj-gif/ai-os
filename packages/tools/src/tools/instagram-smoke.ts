// Instagram pack smoke — deterministic, no network, no DB, no credentials.
// Run: tsx packages/tools/src/tools/instagram-smoke.ts
//
// The pack ships MOCK-FIRST (the official Graph API needs a Business account
// linked to a Facebook Page plus Meta app review), so the mock is the only
// thing anyone can exercise until those exist. That makes pinning it the whole
// point: these assertions are what stop the mock from drifting away from the
// real client's contract while nobody can run the real one.
import {
  instagramGetProfile,
  instagramRecentPosts,
  instagramPostInsights,
  instagramDraftPost,
  instagramPublishPost,
  igMockOutbox,
  IG_MAX_CAPTION,
  IG_MAX_HASHTAGS,
} from './instagram.js';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const run = (t: { execute: (a: Record<string, unknown>, c: never) => Promise<unknown> }, args: Record<string, unknown> = {}) =>
  t.execute(args, {} as never);

// No credentials in this process — assert that, or every "mock" check below is
// meaningless and might be silently hitting the live API.
delete process.env.IG_ACCESS_TOKEN;
delete process.env.IG_BUSINESS_ACCOUNT_ID;

console.log('— reads fall back to the mock, and SAY they are mocked —');
const profile = (await run(instagramGetProfile)) as { username?: string; mock?: boolean; note?: string };
check('get_profile returns a profile', !!profile.username, profile.username);
check('...flagged mock:true so no one mistakes it for real data', profile.mock === true);
check('...and the note says what is missing', /IG_ACCESS_TOKEN/.test(profile.note ?? ''));

const posts = (await run(instagramRecentPosts, { limit: 1 })) as { posts?: unknown[]; mock?: boolean };
check('recent_posts honours the limit', posts.posts?.length === 1, `got ${posts.posts?.length}`);
const insights = (await run(instagramPostInsights, { mediaId: 'mock-media-1' })) as { metrics?: Record<string, number> };
check('post_insights returns metrics', typeof insights.metrics?.reach === 'number', JSON.stringify(insights.metrics));

console.log('\n— draft validation: the limits Instagram enforces silently —');
const okDraft = (await run(instagramDraftPost, { caption: 'hello #ai #os' })) as { ok?: boolean; chars?: number; hashtags?: number };
check('a normal caption validates', okDraft.ok === true, `chars=${okDraft.chars} hashtags=${okDraft.hashtags}`);
check('...and hashtags are counted, not guessed', okDraft.hashtags === 2, String(okDraft.hashtags));

const longCap = (await run(instagramDraftPost, { caption: 'x'.repeat(IG_MAX_CAPTION + 5) })) as { ok?: boolean; error?: string };
check(`a caption over ${IG_MAX_CAPTION} chars is rejected`, longCap.ok === false, (longCap.error ?? '').slice(0, 60));

const manyTags = (await run(instagramDraftPost, {
  caption: Array.from({ length: IG_MAX_HASHTAGS + 1 }, (_, i) => `#t${i}`).join(' '),
})) as { ok?: boolean; error?: string };
// Instagram DROPS hashtags past 30 without telling you, so silence here would
// mean the user's post quietly loses tags they thought they had published.
check(`more than ${IG_MAX_HASHTAGS} hashtags is rejected, not silently dropped`, manyTags.ok === false, (manyTags.error ?? '').slice(0, 60));

console.log('\n— the image URL is fetched by META, so it must be public —');
for (const [url, why] of [
  ['http://127.0.0.1:3001/img.png', 'loopback'],
  ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
  ['http://10.0.0.5/img.png', 'RFC1918 private'],
] as const) {
  const d = (await run(instagramDraftPost, { caption: 'hi', imageUrl: url })) as { ok?: boolean; error?: string };
  check(`draft rejects a ${why} image URL`, d.ok === false && /not publicly reachable/.test(d.error ?? ''), url);
  let threw = '';
  await run(instagramPublishPost, { caption: 'hi', imageUrl: url }).catch((e: unknown) => (threw = String(e)));
  check(`publish also refuses it (draft and publish agree)`, /not publicly reachable/.test(threw), threw.slice(0, 50));
}

console.log('\n— publishing —');
igMockOutbox.length = 0;
let noImage = '';
await run(instagramPublishPost, { caption: 'text only' }).catch((e: unknown) => (noImage = String(e)));
check('publish refuses a text-only post (Instagram has no such type)', /imageUrl is required/.test(noImage), noImage.slice(0, 60));

let overLimit = '';
await run(instagramPublishPost, { caption: 'x'.repeat(IG_MAX_CAPTION + 1), imageUrl: 'https://example.com/a.jpg' }).catch((e: unknown) => (overLimit = String(e)));
check('publish re-validates the caption itself, not trusting the draft step', /over the 2200 limit/.test(overLimit), overLimit.slice(0, 60));

const published = (await run(instagramPublishPost, { caption: 'shipped #aios', imageUrl: 'https://example.com/a.jpg' })) as { ok?: boolean; id?: string; mock?: boolean };
check('a valid post "publishes" to the mock outbox', published.ok === true && !!published.id, published.id);
check('...flagged mock:true', published.mock === true);
check('...and nothing left the machine — it is in the outbox', igMockOutbox.length === 1 && igMockOutbox[0]!.caption === 'shipped #aios', `outbox=${igMockOutbox.length}`);

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
