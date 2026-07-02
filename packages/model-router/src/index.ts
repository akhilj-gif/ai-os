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
  apiKey: string;
  baseURL?: string;
  defaults: Record<ModelRole, string>;
}

function resolveProvider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: 'anthropic',
      kind: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
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
      apiKey: process.env.XAI_API_KEY,
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
      apiKey: process.env.GEMINI_API_KEY,
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
      sdk: new Anthropic({ apiKey: provider.apiKey, baseURL: provider.baseURL }),
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

async function callOpenAIShape(
  provider: Provider,
  model: string,
  input: ModelCallInput,
): Promise<Omit<ModelCallResult, 'model'>> {
  const messages: Array<{ role: string; content: string }> = [];
  if (input.system) messages.push({ role: 'system', content: input.system });
  messages.push({ role: 'user', content: input.prompt });

  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({ model, max_tokens: input.maxTokens ?? 1024, messages }),
  });
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
