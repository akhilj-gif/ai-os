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
  name: 'anthropic' | 'xai' | 'gemini';
  kind: 'anthropic' | 'openai';
  /** Primary first; extra keys are rotated onto 429s (free-tier quota relief). */
  apiKeys: string[];
  baseURL?: string;
  defaults: Record<ModelRole, string>;
}

function resolveProvider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: 'anthropic',
      kind: 'anthropic',
      apiKeys: [process.env.ANTHROPIC_API_KEY],
      defaults: {
        routing: 'claude-haiku-4-5-20251001',
        execution: 'claude-sonnet-5',
        planning: 'claude-fable-5',
      },
    };
  }
  if (process.env.XAI_API_KEY) {
    return {
      name: 'xai',
      kind: 'anthropic', // xAI is Anthropic-SDK-compatible
      apiKeys: [process.env.XAI_API_KEY],
      baseURL: 'https://api.x.ai',
      defaults: {
        routing: 'grok-4-fast-non-reasoning',
        execution: 'grok-4-fast-reasoning',
        planning: 'grok-4',
      },
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      name: 'gemini',
      kind: 'openai', // Gemini's OpenAI-compatible endpoint
      apiKeys: [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_FALLBACK].filter(
        (k): k is string => !!k,
      ),
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaults: {
        routing: 'gemini-2.5-flash-lite',
        execution: 'gemini-2.5-flash',
        planning: 'gemini-2.5-pro',
      },
    };
  }
  throw new Error(
    'No model provider configured — set ANTHROPIC_API_KEY, XAI_API_KEY, or GEMINI_API_KEY in .env',
  );
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
): Promise<Response> {
  const MAX_ROUNDS = 4;
  const MAX_WAIT_MS = 70_000;
  let lastRes: Response | null = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (let k = 0; k < keys.length; k++) {
      const res = await fetch(url, buildInit(keys[k]!));
      if (res.status !== 429 && res.status !== 503) {
        if (k > 0) console.warn(`[model-router] ${label}: primary key rate-limited, fallback key #${k + 1} served the call`);
        return res;
      }
      lastRes = res;
      if (keys.length > 1 && k < keys.length - 1) {
        console.warn(`[model-router] ${label} got ${res.status} on key #${k + 1}, rotating to key #${k + 2}`);
      }
    }
    if (round === MAX_ROUNDS) break;
    const body = await lastRes!.clone().text();
    const headerWait = Number(lastRes!.headers.get('retry-after')) * 1000 || 0;
    const bodyWait = (Number(body.match(/retry in (\d+(?:\.\d+)?)s/i)?.[1]) || 0) * 1000;
    const waitMs = Math.min(Math.max(headerWait, bodyWait, round * 5_000) + 1_000, MAX_WAIT_MS);
    console.warn(`[model-router] ${label}: all ${keys.length} key(s) rate-limited, waiting ${Math.round(waitMs / 1000)}s (round ${round}/${MAX_ROUNDS})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return lastRes!;
}

async function callOpenAIShape(
  provider: Provider,
  model: string,
  input: ModelCallInput,
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
  );
  if (!res.ok) {
    throw new Error(`${provider.name} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
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

export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
  const provider = resolveProvider();
  const model = routingTable(provider)[input.role];
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
        : await callOpenAIShape(provider, model, input);
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
  const provider = resolveProvider();
  if (provider.kind !== 'openai') {
    throw new Error(
      `chat() with tools is OpenAI-shape only at M1 (provider "${provider.name}" is ${provider.kind}) — see ADR-0004`,
    );
  }
  const model = routingTable(provider)[input.role];
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

  try {
    const res = await fetchWithRateLimitRetry(
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
    );
    if (!res.ok) {
      throw new Error(`${provider.name} ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: ChatMessage }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = data.choices?.[0]?.message ?? { role: 'assistant' as const, content: '' };
    const toolCalls: ParsedToolCall[] = (message.tool_calls ?? []).map((tc, i) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        // leave args empty; the tool will report missing params back to the model
      }
      return { id: tc.id ?? `call_${i}`, name: tc.function.name, args };
    });
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
