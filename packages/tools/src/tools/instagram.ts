// Instagram pack tools — same shape as the X pack (ADR-0015): a tiny in-module
// CLIENT seam where the real Instagram Graph API activates once both IG_* env
// keys are set, and a deterministic MOCK serves fixtures otherwise (nothing
// leaves the machine). Built mock-first on purpose: the official API needs a
// professional (Business or Creator) account plus a Meta app, so the pack has to
// be testable and shippable before any of that exists.
//
// WHY THE OFFICIAL API AND NOT A SCRAPER. instagrapi and the headless-browser
// MCP servers reach more surface (personal accounts, DM-first, other people's
// feeds) but Meta tightened hard through 2025-26 — device fingerprinting, 2FA
// enforcement, higher suspension rates, and DMCA takedowns aimed at the library
// authors. A ban costs the user their real account. The WhatsApp bridge already
// carries that class of risk once; it is not worth carrying twice.
//
// WHAT THE OFFICIAL API CANNOT DO, stated so nobody designs around a tool that
// cannot exist: you cannot DM someone first. Messaging only works inside a 24h
// window after THEY message you, and automated DMs cap at 200/hour. There is
// therefore no instagram_send_dm here — a WhatsApp-style inbox assistant is not
// buildable on the sanctioned API.
//
// Trust: PUBLISHING as the user is the pack's whole risk — irreversible-class,
// auto_approve=false, always (policy lives in the pack manifest). Drafting is
// stateless validation; reads are read-class.
import { assertPublicHttpUrl, SsrfBlockedError } from '@ai-os/shared';
import type { ToolDef } from '../registry.js';

// TWO auth paths, because Meta has two and they need different hosts.
//
//  1. Instagram Login (July 2024, the EASY one) — graph.instagram.com, the token
//     is an Instagram user token, and the account is addressed as `me`. It needs
//     NO Facebook Page and no Facebook account in the loop. Set IG_ACCESS_TOKEN
//     alone and this is what you get.
//  2. Facebook Login — graph.facebook.com, addressed by the IG business account
//     id, and the account must be linked to a Facebook Page. Set
//     IG_BUSINESS_ACCOUNT_ID as well and the pack switches to this.
//
// Both require a Business or CREATOR account; neither works with a personal one.
// Creator is the low-friction answer: converting is free, instant, needs zero
// followers and is reversible — the one real cost being that professional
// accounts cannot be private.
const GRAPH_FB = 'https://graph.facebook.com/v21.0';
const GRAPH_IG = 'https://graph.instagram.com/v21.0';
/** Instagram's own caption ceiling. Hashtags beyond 30 are silently DROPPED by
 *  Instagram, so checking both here turns a silent truncation into an error. */
export const IG_MAX_CAPTION = 2_200;
export const IG_MAX_HASHTAGS = 30;

interface IgCreds {
  token: string;
  /** The path segment identifying the account: a numeric id on the Facebook
   *  Login path, the literal 'me' on the Instagram Login path. */
  accountId: string;
  base: string;
}

/** Exported as pickAuthPath for the smoke suite: choosing the wrong host is a
 *  silent 400 against the wrong API, so it is worth asserting directly. */
export function creds(): IgCreds | null {
  const { IG_ACCESS_TOKEN, IG_BUSINESS_ACCOUNT_ID } = process.env;
  if (!IG_ACCESS_TOKEN) return null;
  // The account id is what selects the path. Present => the caller went through
  // Facebook Login and has a Page; absent => Instagram Login, which addresses
  // the account as `me` and needs no Page at all.
  return IG_BUSINESS_ACCOUNT_ID
    ? { token: IG_ACCESS_TOKEN, accountId: IG_BUSINESS_ACCOUNT_ID, base: GRAPH_FB }
    : { token: IG_ACCESS_TOKEN, accountId: 'me', base: GRAPH_IG };
}

const NOT_CONFIGURED =
  'IG_ACCESS_TOKEN is not set — running against the deterministic mock. The real API needs an Instagram Business or CREATOR account (personal accounts have no API access at all). Set IG_ACCESS_TOKEN alone for the Instagram Login path (no Facebook Page needed), or add IG_BUSINESS_ACCOUNT_ID to use Facebook Login.';

/** Mock outbox — "published" posts when no real keys are configured. Exported
 *  for the smoke suite, exactly like xMockOutbox. */
export const igMockOutbox: Array<{ id: string; caption: string; imageUrl: string; at: string }> = [];

const MOCK_PROFILE = {
  id: 'mock-ig-1',
  username: 'akhil_mock',
  name: 'Akhil (mock)',
  followers_count: 1234,
  follows_count: 321,
  media_count: 42,
};
const MOCK_MEDIA = [
  { id: 'mock-media-1', caption: 'Shipping the AI OS', media_type: 'IMAGE', permalink: 'https://instagram.com/p/mock1', timestamp: '2026-09-01T10:00:00+0000', like_count: 87, comments_count: 6 },
  { id: 'mock-media-2', caption: 'Late-night debugging', media_type: 'REELS', permalink: 'https://instagram.com/reel/mock2', timestamp: '2026-08-28T19:30:00+0000', like_count: 210, comments_count: 19 },
];

async function graph<T>(method: 'GET' | 'POST', path: string, c: IgCreds, params: Record<string, string> = {}): Promise<T> {
  const body = new URLSearchParams({ ...params, access_token: c.token });
  const target = method === 'GET' ? `${c.base}${path}?${body.toString()}` : `${c.base}${path}`;
  const res = await fetch(target, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
    body: method === 'POST' ? body : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (res.status === 429) throw new Error(`INFRA_RATELIMIT 429 (instagram): ${text.slice(0, 200)}`);
  if (!res.ok) {
    // Long-lived tokens expire after 60 DAYS. As a generic 400 that is an
    // invisible cliff — the pack simply stops working two months after setup,
    // which is the silent-failure class this repo keeps paying for. Meta signals
    // it as code 190, so name it and say exactly what to do about it.
    if (/"code"\s*:\s*190/.test(text)) {
      throw new Error(
        'instagram token is invalid or EXPIRED (Meta code 190). Long-lived tokens last 60 days — generate a new one and update IG_ACCESS_TOKEN.',
      );
    }
    throw new Error(`instagram graph ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

export const instagramGetProfile: ToolDef = {
  name: 'instagram_get_profile',
  description:
    "The user's own Instagram professional account: username, name, follower/following/media counts. Mocked until IG_ACCESS_TOKEN is configured.",
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const c = creds();
    if (!c) return { ...MOCK_PROFILE, mock: true, note: NOT_CONFIGURED };
    return graph('GET', `/${c.accountId}`, c, {
      fields: 'id,username,name,followers_count,follows_count,media_count,profile_picture_url',
    });
  },
};

export const instagramRecentPosts: ToolDef = {
  name: 'instagram_recent_posts',
  description:
    "The user's own recent Instagram posts with engagement counts (likes, comments), newest first. Use this to answer questions like \"how is my content doing\".",
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'integer', description: 'How many posts to return (1-25, default 10)' } },
  },
  async execute(args) {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
    const c = creds();
    if (!c) return { posts: MOCK_MEDIA.slice(0, limit), mock: true, note: NOT_CONFIGURED };
    const r = await graph<{ data?: unknown[] }>('GET', `/${c.accountId}/media`, c, {
      fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
      limit: String(limit),
    });
    return { posts: r.data ?? [] };
  },
};

export const instagramPostInsights: ToolDef = {
  name: 'instagram_post_insights',
  description:
    "Performance metrics for ONE of the user's own posts (reach, impressions, saves, likes, comments). Get the media id from instagram_recent_posts.",
  inputSchema: {
    type: 'object',
    properties: { mediaId: { type: 'string', description: 'Media id, from instagram_recent_posts' } },
    required: ['mediaId'],
  },
  async execute(args) {
    const mediaId = String(args.mediaId ?? '').trim();
    if (!mediaId) throw new Error('mediaId is required');
    const c = creds();
    if (!c) return { mediaId, metrics: { reach: 1520, impressions: 2310, saved: 44, likes: 87, comments: 6 }, mock: true, note: NOT_CONFIGURED };
    const r = await graph<{ data?: Array<{ name: string; values?: Array<{ value: number }> }> }>('GET', `/${mediaId}/insights`, c, {
      metric: 'reach,impressions,saved,likes,comments',
    });
    return { mediaId, metrics: Object.fromEntries((r.data ?? []).map((m) => [m.name, m.values?.[0]?.value ?? 0])) };
  },
};

interface CaptionCheck {
  ok: boolean;
  chars: number;
  hashtags: number;
  error?: string;
}

/** Shared by draft AND publish so the two can never disagree about what is
 *  postable — that drift is what makes a "validated" draft fail at publish. */
export function validateCaption(caption: string): CaptionCheck {
  const chars = [...caption].length;
  const hashtags = (caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (chars > IG_MAX_CAPTION) {
    return { ok: false, chars, hashtags, error: `caption is ${chars - IG_MAX_CAPTION} chars over the ${IG_MAX_CAPTION} limit — shorten it` };
  }
  if (hashtags > IG_MAX_HASHTAGS) {
    return { ok: false, chars, hashtags, error: `${hashtags} hashtags exceeds Instagram's limit of ${IG_MAX_HASHTAGS} — Instagram would silently drop the rest` };
  }
  return { ok: true, chars, hashtags };
}

/** Meta's servers fetch the image URL, so a private address is both useless to
 *  them AND would make the OS a proxy for probing internal hosts. Reject it here
 *  rather than shipping it to Meta and reading the failure back. */
async function assertPostableImage(imageUrl: string): Promise<string | null> {
  try {
    await assertPublicHttpUrl(imageUrl);
    return null;
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return `imageUrl is not publicly reachable: ${err.message}. Instagram fetches it server-side, so it must be a public https URL.`;
    }
    throw err;
  }
}

export const instagramDraftPost: ToolDef = {
  name: 'instagram_draft_post',
  description:
    'Draft/validate an Instagram post BEFORE publishing: checks the 2,200-char caption limit, the 30-hashtag limit, and that the image URL is publicly reachable (Meta fetches it server-side, so a localhost or private URL silently fails). No side effects — publishing is a separate, approval-gated step (instagram_publish_post).',
  inputSchema: {
    type: 'object',
    properties: {
      caption: { type: 'string', description: 'The exact caption text to validate' },
      imageUrl: { type: 'string', description: 'Public https URL of the image to post' },
    },
    required: ['caption'],
  },
  async execute(args) {
    const caption = String(args.caption ?? '');
    const imageUrl = String(args.imageUrl ?? '').trim();
    const v = validateCaption(caption);
    const out: Record<string, unknown> = { ...v, draft: caption, limit: IG_MAX_CAPTION, hashtagLimit: IG_MAX_HASHTAGS };
    if (!imageUrl) return out;
    const bad = await assertPostableImage(imageUrl);
    return bad ? { ...out, ok: false, error: bad } : { ...out, imageUrl };
  },
};

export const instagramPublishPost: ToolDef = {
  name: 'instagram_publish_post',
  description:
    "PUBLISH a post to Instagram as the user — irreversible, so every call is queued for the user's one-click approval (nothing publishes until they approve). Once the user has asked to post and the caption is final, call this DIRECTLY — do not ask for confirmation in prose first.",
  inputSchema: {
    type: 'object',
    properties: {
      caption: { type: 'string', description: 'Exact final caption (max 2,200 chars, max 30 hashtags)' },
      imageUrl: { type: 'string', description: 'Public https URL of the image to post' },
    },
    required: ['caption', 'imageUrl'],
  },
  async execute(args) {
    const caption = String(args.caption ?? '');
    const imageUrl = String(args.imageUrl ?? '').trim();
    if (!imageUrl) throw new Error('imageUrl is required — Instagram has no text-only post type');
    const v = validateCaption(caption);
    if (!v.ok) throw new Error(`${v.error} — run instagram_draft_post first`);
    const bad = await assertPostableImage(imageUrl);
    if (bad) throw new Error(bad);

    const c = creds();
    if (!c) {
      const id = `mock-ig-post-${igMockOutbox.length + 1}`;
      igMockOutbox.push({ id, caption, imageUrl, at: new Date().toISOString() });
      return { ok: true, id, url: `https://instagram.com/p/${id}`, mock: true, note: `${NOT_CONFIGURED} Recorded in the mock outbox — nothing left the machine.` };
    }
    // Publishing is TWO calls: create an unpublished container, then publish it.
    // Both belong inside this one approved action — a container created and left
    // unpublished is invisible litter on the account that the user never sees.
    const container = await graph<{ id: string }>('POST', `/${c.accountId}/media`, c, { image_url: imageUrl, caption });
    const published = await graph<{ id: string }>('POST', `/${c.accountId}/media_publish`, c, { creation_id: container.id });
    return { ok: true, id: published.id, containerId: container.id };
  },
};

/** Alias so the smoke suite reads clearly about what it is pinning. */
export { creds as pickAuthPath };
