// Failure recovery policy — the difference between an agent and a script.
//
// WHY THIS EXISTS. Measured on the live DB 2026-09-19: 135 failed steps, of
// which 115 (85%) were transient — Groq/Gemini 429s, provider timeouts, one
// 503, a handful of `fetch failed`. 130 of the 135 were `reason` steps: pure
// model calls with NO side effects, where retrying is not merely safe but
// obviously correct. The graph driver retried exactly none of them. It caught
// the error, wrote status='failed', and the task died with the literal text
// "A step failed." 151 tasks are sitting in that state.
//
// The providers are not even being subtle about it. A real error body from the
// steps table:
//
//   INFRA_RATELIMIT 429 (groq): ... on tokens per day (TPD): Limit 200000,
//   Used 199005, Requested 3118. Please try again in 15m17.136s.
//
// The service says exactly how long to wait and the OS throws that away and
// gives up permanently. On a free tier capped near 8,000 tokens/min, quota
// exhaustion is not an exceptional condition — it is the normal weather. A
// system that treats the normal weather as fatal cannot be left alone with a
// goal, which is the entire point of the thing.
//
// WHAT IS DELIBERATELY *NOT* RETRIED. A trust-gate refusal (§8.3) is a
// decision, not a fault. Retrying a security control until it yields is the
// definition of defeating it, so a refusal is always fatal here. Likewise a
// MUTATING tool that failed for a non-infra reason is parked for a human
// rather than re-fired: the call may have already sent the message or spent
// the money before it threw, and this module cannot know which. Both rules
// fail toward doing less, which is the only safe direction.
//
// Pure and dependency-light on purpose: every rule below is decided with no
// model call and no DB round trip, so recovery costs zero quota — it would be
// absurd to need the rate-limited resource in order to handle a rate limit.
import { isInfraFailure } from '@ai-os/model-router';

/** Inline retries happen inside one runGraph call, blocking that step. */
export const MAX_INLINE_RETRIES = 2;
/** Total attempts across resumes before we stop and tell the truth. */
export const MAX_TOTAL_RETRIES = 6;
/** Longer than this and we park instead of blocking a worker on a sleep.
 *  A per-minute limit clears inside this; a per-DAY limit (the 15m17s above)
 *  does not, and holding a step open for 15 minutes to find that out is how a
 *  task looks "hung" to the user. */
export const INLINE_WAIT_CEILING_MS = 60_000;

export type Recovery =
  /** Sleep and run the same step again, right now. */
  | { action: 'retry'; waitMs: number; why: string }
  /** Not now, but not dead: come back at `retryAt` and continue the task. */
  | { action: 'park'; retryAt: Date; why: string }
  /** The plan itself was wrong. Hand the error back to the planner. */
  | { action: 'replan'; why: string }
  /** Genuinely over. Report it honestly. */
  | { action: 'fatal'; why: string };

/** A trust-gate refusal is a verdict, never a fault — see the header. */
export function isTrustRefusal(error: string): boolean {
  return /Refused by the trust gate/i.test(error);
}

/** Transient from the STEP's point of view, which is a wider surface than the
 *  router's. isInfraFailure() is anchored on our own `INFRA_*` markers because
 *  it answers a narrower question — "should the model chain fail over to the
 *  next provider?" — and by the time it runs, the marker has been attached.
 *  A step can also fail on a raw error from a tool's own fetch: the live table
 *  holds five bare `fetch failed` rows that never went through the router at
 *  all. Widening isInfraFailure() would change provider-failover behaviour for
 *  everything, so the extra cases are ORed in here instead, matching the
 *  pattern executor.ts::humanizeFailure already treats as network trouble. */
export function isTransient(error: string): boolean {
  return (
    isInfraFailure(error) ||
    // UNANCHORED, unlike isInfraFailure's `/^INFRA_/`. A step error is often a
    // wrapped one — graph.ts prefixes a failed tool call with its tool name —
    // and the anchored test silently stops matching the moment anything is
    // prepended. That exact bug turned a 15-minute quota park into a hard
    // failure in testing, and it fails in the invisible direction: the string
    // still SAYS rate limit, the code just no longer sees it.
    /INFRA_(RATELIMIT|NETWORK)/.test(error) ||
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(error) ||
    // Untagged provider errors — 31 rows on the live DB read `gemini 429: ...`
    // with no INFRA_ marker at all, because they never went through the
    // router's failover path.
    /\b(429|503|502|504)\b|rate.?limit|too many requests|overloaded|quota/i.test(error)
  );
}

/** Pull the provider's own advice out of an error body.
 *  Handles Groq's "Please try again in 15m17.136s", a bare "retry-after: 30",
 *  and Gemini's "retryDelay": "42s". Returns 0 when the error says nothing. */
export function parseRetryAfterMs(error: string): number {
  const phrase = /try again in\s+([0-9hms.\s]+)/i.exec(error);
  const header = /retry[-_ ]?after["':\s]+([0-9.]+)\s*(s|ms)?/i.exec(error);
  const gemini = /"retryDelay"\s*:\s*"?([0-9.]+)s/i.exec(error);
  if (phrase) return durationToMs(phrase[1]!);
  if (gemini) return Math.round(Number(gemini[1]) * 1000);
  if (header) {
    const n = Number(header[1]);
    if (Number.isFinite(n)) return header[2]?.toLowerCase() === 'ms' ? n : n * 1000;
  }
  return 0;
}

/** "15m17.136s" -> 917136. "1.5s" -> 1500. "500ms" -> 500. */
function durationToMs(text: string): number {
  let ms = 0;
  let matched = false;
  // `ms` must precede `s` in the alternation or "500ms" reads as 500 seconds.
  for (const m of text.matchAll(/([0-9.]+)\s*(ms|s|m|h)/gi)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    matched = true;
    const unit = m[2]!.toLowerCase();
    ms += unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(ms) : 0;
}

/** Exponential fallback for an infra error that gave us no advice. */
function backoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** attempt, 40_000);
}

export interface FailureContext {
  error: string;
  /** 'reason' steps are pure model calls — no side effects, always safe to rerun. */
  kind: 'reason' | 'tool' | 'approval';
  /** True for a tool classified write/irreversible/spend. Never auto-retried
   *  on a non-infra error: it may have half-happened. */
  mutating: boolean;
  /** steps.retries so far (the column has existed since the first migration
   *  and nothing has ever incremented it — all 1,395 rows read 0). */
  retries: number;
  /** Whether this task has already been replanned once. Capped at one because
   *  replanning costs a full planner call, and on this quota a replan loop
   *  would burn the budget that the retry is waiting for. */
  replanned: boolean;
  now: Date;
}

export function planRecovery(ctx: FailureContext): Recovery {
  // 1. A refusal is the system working correctly. Do not "recover" from it.
  if (isTrustRefusal(ctx.error)) {
    return { action: 'fatal', why: 'trust-gate refusal — a decision, not a fault' };
  }

  // 2. Out of attempts. Stop and say so rather than looping forever.
  if (ctx.retries >= MAX_TOTAL_RETRIES) {
    return { action: 'fatal', why: `gave up after ${ctx.retries} attempts` };
  }

  // 3. A MUTATING tool that failed is never auto-retried — not even when the
  //    error looks transient, which is the subtle half of this rule. A
  //    `whatsapp_send_message` that throws `fetch failed` may have delivered
  //    the message and lost the response, and nothing here can tell the two
  //    apart. "Transient" describes the connection, not the side effect. This
  //    check therefore sits ABOVE the transient branch on purpose; inverting
  //    the order is how a retry policy turns into a double-send.
  //    It costs nothing in practice: of the 5 tool-step failures on the live
  //    DB, all 5 are trust refusals, and the 130 rate-limited steps are all
  //    `reason` steps, which call no tools at all.
  if (ctx.kind === 'tool' && ctx.mutating) {
    return { action: 'fatal', why: 'a mutating tool failed — not retried, the side effect may already have landed' };
  }

  // 4. Transient. This is the 85% case.
  if (isTransient(ctx.error)) {
    const advised = parseRetryAfterMs(ctx.error);
    const waitMs = advised || backoffMs(ctx.retries);
    // Trust the provider's own number when it is small; park when it is large.
    // A day-quota reset is 15 minutes away and nobody should hold a worker for it.
    if (ctx.retries < MAX_INLINE_RETRIES && waitMs <= INLINE_WAIT_CEILING_MS) {
      return { action: 'retry', waitMs, why: advised ? `provider said ${Math.round(waitMs / 1000)}s` : 'transient, backing off' };
    }
    return {
      action: 'park',
      retryAt: new Date(ctx.now.getTime() + Math.max(waitMs, 30_000)),
      why: advised ? `provider said ${Math.round(waitMs / 1000)}s — parking until then` : 'transient, parking',
    };
  }

  // 5. A real error the plan should adapt to (bad args, wrong tool, missing
  //    capability). THIS is the one that makes the system look like it is
  //    figuring something out, so it is worth one planner call.
  if (!ctx.replanned) {
    return { action: 'replan', why: 'non-transient failure — revise the plan once with the error as evidence' };
  }

  return { action: 'fatal', why: 'already replanned once; the second attempt failed too' };
}
