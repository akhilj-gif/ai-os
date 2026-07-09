// Model Router (blueprint §4.2): model selection per step class, cost tracking.
// Owns WHICH model runs and telemetry around the call — never prompt content.
import Anthropic from '@anthropic-ai/sdk';
import { Langfuse } from 'langfuse';

/** Step classes from the routing table (blueprint §5):
 *  routing/classification → cheap tier · execution → mid tier · planning/hard reasoning → top tier */
export type ModelRole = 'routing' | 'execution' | 'planning';

/** Providers are swappable behind two API shapes (ADR-0002):
 *  'anthropic' = Anthropic Messages API (Claude, xAI/Grok) · 'openai' = OpenAI-compatible
 *  chat/completions (Gemini free tier, Groq, OpenRouter). Priority when several keys are
 *  set: Anthropic > xAI > Gemini. MODEL_* env vars override any default table. */
interface Provider {
  name: 'anthropic' | 'xai' | 'gemini' | 'groq';
  kind: 'anthropic' | 'openai';
  /** Primary first; extra keys are rotated onto 429s (free-tier quota relief). */
  apiKeys: string[];
  baseURL?: string;
  defaults: Record<ModelRole, string>;
}

const PROVIDERS: Record<string, () => Provider | null> = {
  anthropic: () =>
    process.env.ANTHROPIC_API_KEY
      ? {
          name: 'anthropic',
          kind: 'anthropic',
          apiKeys: [process.env.ANTHROPIC_API_KEY],
          defaults: { routing: 'claude-haiku-4-5-20251001', execution: 'claude-sonnet-5', planning: 'claude-fable-5' },
        }
      : null,
  xai: () =>
    process.env.XAI_API_KEY
      ? {
          name: 'xai',
          kind: 'anthropic', // xAI is Anthropic-SDK-compatible
          apiKeys: [process.env.XAI_API_KEY],
          baseURL: 'https://api.x.ai',
          defaults: { routing: 'grok-4-fast-non-reasoning', execution: 'grok-4-fast-reasoning', planning: 'grok-4' },
        }
      : null,
  gemini: () =>
    process.env.GEMINI_API_KEY
      ? {
          name: 'gemini',
          kind: 'openai', // Gemini's OpenAI-compatible endpoint
          apiKeys: [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_FALLBACK].filter((k): k is string => !!k),
          baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
          defaults: { routing: 'gemini-2.5-flash-lite', execution: 'gemini-2.5-flash', planning: 'gemini-2.5-pro' },
        }
      : null,
  // Groq (NOT xAI Grok — gsk_ keys): OpenAI-compatible, generous free tier, fast
  // open models with tool-calling. Used for eval runs the Gemini free tier can't sustain.
  groq: () =>
    process.env.GROQ_API_KEY
      ? {
          name: 'groq',
          kind: 'openai',
          apiKeys: [process.env.GROQ_API_KEY],
          baseURL: 'https://api.groq.com/openai/v1',
          defaults: {
            routing: 'llama-3.1-8b-instant',
            execution: 'llama-3.3-70b-versatile',
            planning: 'llama-3.3-70b-versatile',
          },
        }
      : null,
};

// Auto-priority when MODEL_PROVIDER is unset. MODEL_PROVIDER forces one provider
// (used to point the gym at Groq without switching the chat app off Gemini).
const PROVIDER_PRIORITY = ['anthropic', 'xai', 'gemini', 'groq'] as const;

function resolveProvider(): Provider {
  const forced = process.env.MODEL_PROVIDER;
  if (forced) {
    const p = PROVIDERS[forced]?.();
    if (!p) throw new Error(`MODEL_PROVIDER=${forced} but its API key is not set (or unknown provider)`);
    return p;
  }
  for (const name of PROVIDER_PRIORITY) {
    const p = PROVIDERS[name]!();
    if (p) return p;
  }
  throw new Error('No model provider configured — set ANTHROPIC_API_KEY, XAI_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY in .env');
}

/** Provider failover order (ADR-0011). Pinning MODEL_PROVIDER means PINNED —
 *  a single-element chain, no failover — so evals and baselines stay
 *  deterministic. Unpinned: every configured provider in priority order; when
 *  the primary fails on INFRA (quota/rate-limit/network), the call falls
 *  through to the next and execution continues immediately. */
export function failoverChain(): Provider[] {
  if (process.env.MODEL_PROVIDER) return [resolveProvider()];
  const chain: Provider[] = [];
  for (const name of PROVIDER_PRIORITY) {
    const p = PROVIDERS[name]!();
    if (p) chain.push(p);
  }
  if (chain.length === 0) {
    throw new Error('No model provider configured — set ANTHROPIC_API_KEY, XAI_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY in .env');
  }
  return chain;
}

/** Failures that justify trying the NEXT provider: our INFRA_* markers, plus
 *  SDK-thrown rate-limit/overload statuses (the Anthropic SDK throws typed
 *  errors, not our markers). Anything else — bad request, auth, schema — would
 *  fail identically everywhere and must surface, not failover. */
export function isInfraFailure(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 503 || status === 413 || status === 529) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /^INFRA_(RATELIMIT|NETWORK)/.test(msg);
}

function routingTable(provider: Provider): Record<ModelRole, string> {
  return {
    routing: process.env.MODEL_ROUTING ?? provider.defaults.routing,
    execution: process.env.MODEL_EXECUTION ?? provider.defaults.execution,
    planning: process.env.MODEL_PLANNING ?? provider.defaults.planning,
  };
}

let client: { providerName: string; sdk: Anthropic } | null = null;
let langfuse: Langfuse | null | undefined; // undefined = not yet decided, null = disabled

function getAnthropicClient(provider: Provider): Anthropic {
  if (client?.providerName !== provider.name) {
    client = {
      providerName: provider.name,
      sdk: new Anthropic({ apiKey: provider.apiKeys[0], baseURL: provider.baseURL }),
    };
  }
  return client.sdk;
}

function getLangfuse(): Langfuse | null {
  if (langfuse === undefined) {
    const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST } = process.env;
    langfuse =
      LANGFUSE_PUBLIC_KEY && LANGFUSE_SECRET_KEY
        ? new Langfuse({
            publicKey: LANGFUSE_PUBLIC_KEY,
            secretKey: LANGFUSE_SECRET_KEY,
            baseUrl: LANGFUSE_HOST ?? 'http://localhost:3030',
          })
        : null;
  }
  return langfuse;
}

// ---------------------------------------------------------------------------
// Embeddings (ADR-0006). Always Gemini (gemini-embedding-001 @ 768 dims) —
// Groq/xAI don't serve embeddings, so this ignores MODEL_PROVIDER and uses
// GEMINI_API_KEY directly. Batch-capable. Returns one vector per input.
// ---------------------------------------------------------------------------
export const EMBED_DIMS = 768;
const EMBED_MODEL = 'gemini-embedding-001';

export async function embed(input: string | string[]): Promise<number[][]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('embeddings require GEMINI_API_KEY (ADR-0006)');
  const inputs = Array.isArray(input) ? input : [input];
  if (inputs.length === 0) return [];
  const res = await fetchWithRateLimitRetry(
    'https://generativelanguage.googleapis.com/v1beta/openai/embeddings',
    [key],
    (apiKey) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs, dimensions: EMBED_DIMS }),
    }),
    `gemini/${EMBED_MODEL}`,
  );
  if (!res.ok) throwHttp({ name: 'gemini' } as Provider, res.status, await res.text());
  const data = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  // Sort by index — the API preserves order but be defensive.
  const rows = (data.data ?? []).slice().sort((a, b) => a.index - b.index);
  if (rows.length !== inputs.length) {
    throw new Error(`embed: expected ${inputs.length} vectors, got ${rows.length}`);
  }
  return rows.map((r) => r.embedding);
}

/** Single-text convenience. */
export async function embedOne(text: string): Promise<number[]> {
  return (await embed(text))[0]!;
}

// ---------------------------------------------------------------------------
// Speech-to-text (voice commands). Always Groq — the only configured provider
// serving Whisper on the free tier (mirrors embed()'s Gemini-only rationale:
// modality-specific engines ignore MODEL_PROVIDER). whisper-large-v3-turbo is
// multilingual (handles Indian-English/Hinglish accents), fast, 25MB file cap.
// ---------------------------------------------------------------------------
const STT_MODEL = 'whisper-large-v3-turbo';

export async function transcribe(audio: Buffer, mime: string): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('voice transcription requires GROQ_API_KEY');
  const ext = mime.split('/')[1]?.split(';')[0] ?? 'webm';
  const res = await fetchWithRateLimitRetry(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    [key],
    (apiKey) => {
      // Rebuilt per attempt — a consumed multipart body can't be re-sent.
      const fd = new FormData();
      fd.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `audio.${ext}`);
      fd.append('model', STT_MODEL);
      // Short accented clips make Whisper's language auto-detect misfire badly
      // (real dogfooding result: English commands transcribed as Tamil and
      // Icelandic gibberish). Commands are English — pin it, zero temperature,
      // and bias with a domain prompt. AIOS_STT_LANGUAGE overrides if Akhil
      // ever wants Telugu/Hindi commands.
      fd.append('language', process.env.AIOS_STT_LANGUAGE ?? 'en');
      fd.append('temperature', '0');
      fd.append('prompt', 'Short spoken command to a personal AI assistant about calendar, email, WhatsApp, meetings, reminders, or web search.');
      return { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: fd };
    },
    `groq/${STT_MODEL}`,
  );
  if (!res.ok) throwHttp({ name: 'groq' } as Provider, res.status, await res.text());
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}

export interface ModelCallInput {
  role: ModelRole;
  prompt: string;
  system?: string;
  maxTokens?: number;
  /** Ties the Langfuse trace to the app-level trace_id (principle 6). */
  traceId: string;
  taskId?: string;
  name?: string;
}

export interface ModelCallResult {
  model: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

async function callAnthropicShape(
  provider: Provider,
  model: string,
  input: ModelCallInput,
): Promise<Omit<ModelCallResult, 'model'>> {
  const response = await getAnthropicClient(provider).messages.create({
    model,
    max_tokens: input.maxTokens ?? 1024,
    system: input.system,
    messages: [{ role: 'user', content: input.prompt }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return {
    text,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

/** POST with rate-limit resilience (FC-002/FC-013): on 429/503, first rotate to
 *  the next API key (free-tier quotas are per key), and only when every key in
 *  the round is exhausted honor Retry-After / the "retry in Xs" body hint with a
 *  capped wait. Up to 4 rounds across all keys. */
async function fetchWithRateLimitRetry(
  url: string,
  keys: string[],
  buildInit: (apiKey: string) => RequestInit,
  label: string,
  maxRounds = 4,
): Promise<Response> {
  const MAX_ROUNDS = maxRounds;
  const MAX_WAIT_MS = 70_000;
  let lastNetErr: unknown = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Reset per round so the FINAL round's outcome decides what we return — a
    // 429 from an earlier round must not shadow a network error in the last one.
    let lastRes: Response | null = null;
    for (let k = 0; k < keys.length; k++) {
      let res: Response;
      try {
        res = await fetch(url, buildInit(keys[k]!));
      } catch (err) {
        // Transient network throw (fetch failed / ECONNRESET / ETIMEDOUT) — not
        // a status we can inspect. Treat like a retryable failure (FC-017).
        lastNetErr = err;
        console.warn(`[model-router] ${label}: network error on key #${k + 1} (${err instanceof Error ? err.message : err}) — retrying`);
        continue;
      }
      if (res.status !== 429 && res.status !== 503) {
        if (k > 0) console.warn(`[model-router] ${label}: primary key rate-limited, fallback key #${k + 1} served the call`);
        return res;
      }
      lastRes = res;
      if (keys.length > 1 && k < keys.length - 1) {
        console.warn(`[model-router] ${label} got ${res.status} on key #${k + 1}, rotating to key #${k + 2}`);
      }
    }
    // Last round: return this round's 429 if it had one, else the network error.
    if (round === MAX_ROUNDS) {
      if (lastRes) return lastRes;
      throw new Error(`INFRA_NETWORK: ${lastNetErr instanceof Error ? lastNetErr.message : String(lastNetErr)}`);
    }
    const body = lastRes ? await lastRes.clone().text() : '';
    const headerWait = (lastRes && Number(lastRes.headers.get('retry-after')) * 1000) || 0;
    const bodyWait = (Number(body.match(/retry in (\d+(?:\.\d+)?)s/i)?.[1]) || 0) * 1000;
    // Jitter (0–4s): two callers that 429'd together would otherwise honor the
    // SAME hint and re-collide every round in lockstep (observed as a minutes-
    // long mutual livelock between a chat task and a background task).
    const jitter = Math.random() * 4_000;
    const waitMs = Math.min(Math.max(headerWait, bodyWait, round * 5_000) + 1_000 + jitter, MAX_WAIT_MS);
    const reason = lastRes ? `all ${keys.length} key(s) rate-limited` : 'network errors';
    // Surface the provider's own explanation (e.g. Groq's "on tokens per minute
    // (TPM): Limit 12000, Requested 15406") — a Requested>Limit request can NEVER
    // succeed by waiting, and without this line that failure mode is invisible.
    const why = body.replace(/\s+/g, ' ').slice(0, 220);
    console.warn(`[model-router] ${label}: ${reason}, waiting ${Math.round(waitMs / 1000)}s (round ${round}/${MAX_ROUNDS})${why ? ` — ${why}` : ''}`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  // Unreachable (loop returns/throws on MAX_ROUNDS), but satisfies the type.
  throw new Error(`INFRA_NETWORK: ${lastNetErr instanceof Error ? lastNetErr.message : 'exhausted retries'}`);
}

/** Classify a non-ok HTTP response into a thrown Error. 429/503 (rate-limit
 *  exhaustion after retries) get a distinct INFRA_RATELIMIT marker so the eval
 *  gym can tell genuine quota exhaustion apart from a real 4xx/5xx bug whose
 *  body merely happens to contain words like "quota" (review finding). */
function throwHttp(provider: Provider, status: number, body: string): never {
  const snippet = body.slice(0, 500);
  if (status === 429 || status === 503) {
    throw new Error(`INFRA_RATELIMIT ${status} (${provider.name}): ${snippet}`);
  }
  // 413: Groq signals per-request TPM overflow this way ("Request too large ...
  // on tokens per minute (TPM)"). Infra-class like 429 — quota geometry, not
  // model misbehavior — but NOT retryable (the same request would 413 again),
  // which is why it is classified here and never enters the retry loop.
  if (status === 413) {
    throw new Error(`INFRA_RATELIMIT ${status} (${provider.name}): ${snippet}`);
  }
  throw new Error(`${provider.name} ${status}: ${snippet}`);
}

async function callOpenAIShape(
  provider: Provider,
  model: string,
  input: ModelCallInput,
  retryRounds = 4,
): Promise<Omit<ModelCallResult, 'model'>> {
  const messages: Array<{ role: string; content: string }> = [];
  if (input.system) messages.push({ role: 'system', content: input.system });
  messages.push({ role: 'user', content: input.prompt });

  const res = await fetchWithRateLimitRetry(
    `${provider.baseURL}/chat/completions`,
    provider.apiKeys,
    (apiKey) => ({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, max_tokens: input.maxTokens ?? 1024, messages }),
    }),
    `${provider.name}/${model}`,
    retryRounds,
  );
  if (!res.ok) throwHttp(provider, res.status, await res.text());
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

async function callModelOn(provider: Provider, model: string, input: ModelCallInput, retryRounds: number): Promise<ModelCallResult> {
  const lf = getLangfuse();
  const trace = lf?.trace({
    id: input.traceId,
    name: input.name ?? `model.${input.role}`,
    metadata: { provider: provider.name, ...(input.taskId ? { taskId: input.taskId } : {}) },
  });
  const generation = trace?.generation({
    name: input.name ?? `model.${input.role}`,
    model,
    input: { system: input.system, prompt: input.prompt },
  });

  try {
    const result =
      provider.kind === 'anthropic'
        ? await callAnthropicShape(provider, model, input)
        : await callOpenAIShape(provider, model, input, retryRounds);
    generation?.end({
      output: result.text,
      usage: { input: result.usage.inputTokens, output: result.usage.outputTokens },
    });
    return { model, ...result };
  } catch (err) {
    generation?.end({ level: 'ERROR', statusMessage: String(err) });
    throw err;
  }
}

export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
  // Failover (ADR-0011): walk the provider chain; INFRA failures fall through to
  // the next provider IMMEDIATELY (non-final providers get one fast retry round,
  // only the last gets the full patient backoff). MODEL_* model-name overrides
  // apply to the PRIMARY only — fallback providers use their own role defaults
  // (a pinned model name belongs to one provider's catalog).
  const chain = failoverChain();
  let lastErr: unknown;
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i]!;
    const model = i === 0 ? routingTable(provider)[input.role] : provider.defaults[input.role];
    const retryRounds = i < chain.length - 1 ? 1 : 4;
    try {
      return await callModelOn(provider, model, input, retryRounds);
    } catch (err) {
      lastErr = err;
      if (i < chain.length - 1 && isInfraFailure(err)) {
        console.warn(`[model-router] ${provider.name} INFRA on ${input.name ?? input.role} — failing over to ${chain[i + 1]!.name}`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr; // unreachable (loop throws or returns), satisfies the type
}

/** Flush buffered Langfuse events — call before process exit. */
export async function flushTelemetry(): Promise<void> {
  await getLangfuse()?.flushAsync();
}

// ---------------------------------------------------------------------------
// chat(): multi-turn, tool-calling completion for the executor loop.
// M1 supports the OpenAI shape only (Gemini/Groq/OpenRouter); running the tool
// loop on an Anthropic-shape provider needs the provider-neutral message IR —
// deferred to M2 (ADR-0004). Message arrays are stored in task checkpoints, so
// the checkpoint format is OpenAI-shaped for now (same ADR).
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResult {
  model: string;
  message: ChatMessage;
  toolCalls: ParsedToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface ChatInput {
  role: ModelRole;
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  maxTokens?: number;
  traceId: string;
  taskId?: string;
  name?: string;
}

export async function chat(input: ChatInput): Promise<ChatResult> {
  const chain = failoverChain();
  if (chain[0]!.kind !== 'openai') {
    throw new Error(
      `chat() with tools is OpenAI-shape only at M1 (provider "${chain[0]!.name}" is ${chain[0]!.kind}) — see ADR-0004`,
    );
  }
  // Failover (ADR-0011), same semantics as callModel; only OpenAI-shape
  // providers can serve the tool loop, so others are skipped in the chain.
  const attempts = chain.filter((p) => p.kind === 'openai');
  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const provider = attempts[i]!;
    const model = i === 0 ? routingTable(provider)[input.role] : provider.defaults[input.role];
    const retryRounds = i < attempts.length - 1 ? 1 : 4;
    try {
      return await chatOn(provider, model, input, retryRounds);
    } catch (err) {
      lastErr = err;
      if (i < attempts.length - 1 && isInfraFailure(err)) {
        console.warn(`[model-router] ${provider.name} INFRA on ${input.name ?? input.role} — failing over to ${attempts[i + 1]!.name}`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function chatOn(provider: Provider, model: string, input: ChatInput, retryRounds: number): Promise<ChatResult> {
  const lf = getLangfuse();
  const trace = lf?.trace({
    id: input.traceId,
    name: input.name ?? `chat.${input.role}`,
    metadata: { provider: provider.name, ...(input.taskId ? { taskId: input.taskId } : {}) },
  });
  const generation = trace?.generation({
    name: input.name ?? `chat.${input.role}`,
    model,
    input: { messages: input.messages.slice(-6), tools: input.tools?.map((t) => t.name) },
  });

  const parseToolCalls = (msg: ChatMessage): ParsedToolCall[] =>
    (msg.tool_calls ?? []).map((tc, i) => {
      // Defensive: a provider may return a malformed tool_call with `function`
      // missing/null. Read every field safely so one bad entry can't throw and
      // abort the whole executor loop — an empty-named/arg call surfaces back to
      // the model as a normal (rejected) tool result instead.
      const fn = tc?.function ?? { name: '', arguments: '' };
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fn.arguments || '{}') as Record<string, unknown>;
      } catch {
        // leave args empty; the tool will report missing params back to the model
      }
      return { id: tc?.id ?? `call_${i}`, name: fn.name ?? '', args };
    });

  // Groq/gpt-oss's inline pseudo tool-call flake (see the two call sites below)
  // is confirmed non-deterministic but NOT reliably fixed by a single retry —
  // observed two consecutive tool_use_failed generations for the same request
  // during dogfooding (2026-07-09). Bounded, and only ever entered on this exact
  // signature, so it can't turn a real error into a retry storm.
  const MAX_TOOL_CALL_RETRIES = 2;

  try {
    const doFetch = () =>
      fetchWithRateLimitRetry(
        `${provider.baseURL}/chat/completions`,
        provider.apiKeys,
        (apiKey) => ({
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: input.maxTokens ?? 2048,
            messages: input.messages,
            ...(input.tools?.length
              ? {
                  tools: input.tools.map((t) => ({
                    type: 'function',
                    function: { name: t.name, description: t.description, parameters: t.inputSchema },
                  })),
                }
              : {}),
          }),
        }),
        `${provider.name}/${model}`,
        retryRounds,
      );

    let res = await doFetch();
    // Groq/gpt-oss occasionally emits its tool call as inline pseudo-syntax
    // (`<function=name{...}>`) instead of a proper tool_calls entry, which Groq's
    // own API then rejects as a 400 "tool_use_failed" — a generation-formatting
    // flake, not a real error. Only when tools were offered.
    for (let attempt = 1; !res.ok && res.status === 400 && input.tools?.length && attempt <= MAX_TOOL_CALL_RETRIES; attempt++) {
      const body = await res.clone().text();
      if (!/tool_use_failed/i.test(body)) break;
      console.warn(`[model-router] ${provider.name}/${model}: tool_use_failed (malformed tool-call generation) — retry ${attempt}/${MAX_TOOL_CALL_RETRIES}`);
      res = await doFetch();
    }
    if (!res.ok) throwHttp(provider, res.status, await res.text());
    type ChatResponseBody = {
      choices?: Array<{ message?: ChatMessage }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    let data = (await res.json()) as ChatResponseBody;
    let message = data.choices?.[0]?.message ?? { role: 'assistant' as const, content: '' };
    let toolCalls = parseToolCalls(message);

    // Same underlying flake as the tool_use_failed retry above, different
    // symptom: instead of Groq's own validator rejecting the generation with a
    // 400, it lets a 200 OK through with the tool call written as inline pseudo-
    // syntax in `content` (e.g. `<function=calendar_list{"timeMin":...}>`) and no
    // structured tool_calls entry — which would otherwise reach the user
    // verbatim as the "final answer".
    for (
      let attempt = 1;
      toolCalls.length === 0 && input.tools?.length && /<function=\w+\{/.test(message.content ?? '') && attempt <= MAX_TOOL_CALL_RETRIES;
      attempt++
    ) {
      console.warn(`[model-router] ${provider.name}/${model}: inline pseudo tool-call syntax in content (no structured tool_calls) — retry ${attempt}/${MAX_TOOL_CALL_RETRIES}`);
      const retryRes = await doFetch();
      if (!retryRes.ok) break; // fall through with the original (still garbled) message rather than throwing
      const retryData = (await retryRes.json()) as ChatResponseBody;
      const retryMessage = retryData.choices?.[0]?.message;
      if (!retryMessage) break;
      data = retryData;
      message = retryMessage;
      toolCalls = parseToolCalls(message);
    }

    const usage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
    generation?.end({
      output: toolCalls.length ? { toolCalls: toolCalls.map((t) => t.name) } : message.content,
      usage: { input: usage.inputTokens, output: usage.outputTokens },
    });
    return { model, message, toolCalls, usage };
  } catch (err) {
    generation?.end({ level: 'ERROR', statusMessage: String(err) });
    throw err;
  }
}
