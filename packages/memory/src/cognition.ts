// The Cognitive Layer (Memory OS Phase 6) — where the OS stops merely storing
// and starts THINKING about what it holds:
//   • consolidateInsights: like sleep, it reads raw experience (episodes +
//     failures) and abstracts GENERALIZED insights — episodic → semantic wisdom.
//   • cognitiveBriefing: reaches forward — predicts what the user will need,
//     proposes proactive actions, and surfaces what it does NOT know as
//     questions to ask (active learning).
// Both are best-effort LLM passes over the memory kernel; failures degrade to
// empty, never throw.
import type pg from 'pg';
import { callModel } from '@ai-os/model-router';
import { parseModelJson } from '@ai-os/shared';
import { MemoryService } from './service.js';
import { graphStats } from './graph.js';

const TRACE = '00000000-0000-4000-8000-000000000006'; // stable trace id for cognition passes

// ---------------------------------------------------------------------------
// Consolidation ("dreaming"): experiences → generalized insight.
// ---------------------------------------------------------------------------
const INSIGHT_SYSTEM = `You are the reflective consolidation faculty of a personal AI OS — like sleep turning experiences into wisdom.
Read the recent EPISODES (things the OS did) and FAILURES, and synthesize GENERALIZED, durable INSIGHTS that will improve future decisions.
An insight is a principle / recurring pattern / strategy — NOT a restatement of a single event. Prefer few (1-3), high-value, non-obvious, actionable.
Return STRICT JSON only: {"insights":[{"content":"<=1 sentence principle","confidence":0.0-1.0}]}. If nothing worth generalizing, return {"insights":[]}.`;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Parse a JSON object out of a model reply that may be wrapped in ```json
 *  fences and/or surrounded by prose. Returns null on anything unparseable. */
function parseJsonObject<T>(text: string): T | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1]!.trim();
  // Shared extractor: balanced-object scan + truncation repair (a cut-off
  // "thinking model" response used to lose the whole briefing).
  return parseModelJson<T>(t);
}

export async function consolidateInsights(pool: pg.Pool, opts: { traceId?: string } = {}): Promise<{ synthesized: number; insights: string[] }> {
  const { rows } = await pool.query<{ type: string; content: string }>(
    `SELECT type, content FROM memory_records
     WHERE superseded_by IS NULL AND type IN ('episodic','failure')
     ORDER BY created_at DESC LIMIT 40`,
  );
  if (rows.length < 3) return { synthesized: 0, insights: [] };

  try {
    const res = await callModel({
      role: 'execution',
      system: INSIGHT_SYSTEM,
      prompt: rows.map((r) => `[${r.type}] ${r.content}`).join('\n'),
      maxTokens: 2048,
      traceId: opts.traceId ?? TRACE,
      name: 'cognition-consolidate',
      capability: 'workspace', // Gemini — strongest instruction-following/JSON here, and most reliable on this box
    });
    const parsed = parseJsonObject<{ insights?: Array<{ content?: string; confidence?: number }> }>(res.text);
    if (!parsed) return { synthesized: 0, insights: [] };
    const mem = new MemoryService(pool);
    const stored: string[] = [];
    for (const ins of parsed.insights ?? []) {
      const content = ins.content?.trim();
      if (!content) continue;
      await mem.remember({
        type: 'semantic',
        content,
        subject: `insight:${slug(content)}`, // subject-keyed → re-derived insights refine, not duplicate
        tags: ['insight'],
        confidence: Math.min(1, Math.max(0.5, ins.confidence ?? 0.8)),
        source: { task_id: undefined, user_stated: false, tool_call_id: 'cognition' },
      });
      stored.push(content);
    }
    return { synthesized: stored.length, insights: stored };
  } catch (err) {
    console.warn('[cognition] consolidation failed (non-fatal):', err instanceof Error ? err.message : err);
    return { synthesized: 0, insights: [] };
  }
}

// ---------------------------------------------------------------------------
// Foresight + self-questioning: the forward-looking briefing.
// ---------------------------------------------------------------------------
/** A proactive suggestion. `action`, when present, is an imperative command the
 *  OS can run right now through the normal trust-gated executor (one-tap). */
export interface Suggestion {
  text: string;
  action: string | null;
}

export interface CognitiveBriefing {
  generatedAt: string;
  context: { weekday: string; hour: number };
  predictions: string[]; // what the user will likely need / do next
  suggestions: Suggestion[]; // proactive actions the OS could take now (tap to run)
  questions: string[]; // knowledge gaps the OS should ask about
  insights: string[]; // durable insights it has already formed
  signals: { episodes: number; failures: number; openTodos: number; contradictions: number; lowConfidence: number; entities: number };
}

const BRIEFING_SYSTEM = `You are the anticipatory cognition of a personal AI OS. Given the user's MEMORY STATE, think FORWARD.
Produce a concise briefing as STRICT JSON only:
{
 "predictions": ["what the user will likely need or do next, grounded in the signals"],
 "suggestions": [{"text":"a proactive thing the OS could do now","action":"the imperative command to run it, phrased as the user would ask (e.g. 'Check whether my PM2 processes are running and report status'), or null if it is advice not a runnable command"}],
 "questions":  ["gaps/uncertainties the OS should ask the user to resolve — only genuinely useful ones"]
}
Rules: ground every item in the provided signals (don't invent facts). 2-4 items per list, terse, high-value. For each suggestion, give a concrete runnable "action" whenever the OS could actually do it with its tools (files, terminal, screen, calendar, whatsapp, web, projects, memory); use null only for pure advice. Empty lists are fine if a section has nothing worthy.`;

export async function cognitiveBriefing(pool: pg.Pool, opts: { traceId?: string } = {}): Promise<CognitiveBriefing> {
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  const hour = now.getHours();

  // Gather signals from every memory subsystem.
  const [episodes, failures, todos, contradictions, lowConf, insightRows, graph] = await Promise.all([
    pool.query<{ content: string }>(`SELECT content FROM memory_records WHERE superseded_by IS NULL AND type='episodic' ORDER BY created_at DESC LIMIT 8`),
    pool.query<{ content: string }>(`SELECT content FROM memory_records WHERE superseded_by IS NULL AND type='failure' ORDER BY created_at DESC LIMIT 6`),
    pool.query<{ content: string; tags: string[] }>(`SELECT content, tags FROM memory_records WHERE superseded_by IS NULL AND 'kind:todo' = ANY(tags) ORDER BY created_at DESC LIMIT 10`),
    new MemoryService(pool).getContradictions(),
    pool.query<{ subject: string; content: string }>(`SELECT subject, content FROM memory_records WHERE superseded_by IS NULL AND type='semantic' AND confidence < 0.5 ORDER BY confidence ASC LIMIT 8`),
    pool.query<{ content: string }>(`SELECT content FROM memory_records WHERE superseded_by IS NULL AND 'insight' = ANY(tags) ORDER BY last_confirmed_at DESC LIMIT 8`),
    graphStats(pool),
  ]);

  const signals = {
    episodes: episodes.rowCount ?? 0,
    failures: failures.rowCount ?? 0,
    openTodos: todos.rowCount ?? 0,
    contradictions: contradictions.length,
    lowConfidence: lowConf.rowCount ?? 0,
    entities: graph.nodes,
  };
  const insights = insightRows.rows.map((r) => r.content);

  const empty: CognitiveBriefing = { generatedAt: now.toISOString(), context: { weekday, hour }, predictions: [], suggestions: [], questions: [], insights, signals };

  // If there's essentially nothing to reason over, return the shell.
  if (signals.episodes + signals.failures + signals.openTodos + signals.contradictions === 0) return empty;

  const prompt = [
    `NOW: ${weekday}, hour ${hour} (24h).`,
    episodes.rows.length ? `RECENT EPISODES:\n${episodes.rows.map((r) => '- ' + r.content).join('\n')}` : '',
    failures.rows.length ? `RECENT FAILURES:\n${failures.rows.map((r) => '- ' + r.content).join('\n')}` : '',
    todos.rows.length ? `OPEN TODOS:\n${todos.rows.map((r) => '- ' + r.content).join('\n')}` : '',
    contradictions.length ? `UNRESOLVED CONTRADICTIONS:\n${contradictions.map((c) => `- ${c.subject}: ${c.options.join(' vs ')}`).join('\n')}` : '',
    lowConf.rows.length ? `LOW-CONFIDENCE FACTS:\n${lowConf.rows.map((r) => `- ${r.subject}: ${r.content}`).join('\n')}` : '',
    graph.topNodes.length ? `TOP ENTITIES: ${graph.topNodes.map((n) => n.name).join(', ')}` : '',
    insights.length ? `EXISTING INSIGHTS:\n${insights.map((i) => '- ' + i).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const res = await callModel({ role: 'execution', system: BRIEFING_SYSTEM, prompt, maxTokens: 2048, traceId: opts.traceId ?? TRACE, name: 'cognition-briefing', capability: 'workspace' });
    const parsed = parseJsonObject<{ predictions?: unknown; suggestions?: unknown; questions?: unknown }>(res.text);
    if (!parsed) return empty;
    const cleanStr = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 5) : []);
    // Suggestions may arrive as {text, action} objects or (fallback) bare strings.
    const cleanSuggestions = (a: unknown): Suggestion[] =>
      Array.isArray(a)
        ? a
            .map((x): Suggestion | null => {
              if (typeof x === 'string' && x.trim()) return { text: x.trim(), action: null };
              if (x && typeof x === 'object') {
                const o = x as { text?: unknown; action?: unknown };
                const text = typeof o.text === 'string' ? o.text.trim() : '';
                if (!text) return null;
                const action = typeof o.action === 'string' && o.action.trim() ? o.action.trim() : null;
                return { text, action };
              }
              return null;
            })
            .filter((s): s is Suggestion => s !== null)
            .slice(0, 5)
        : [];
    return {
      ...empty,
      predictions: cleanStr(parsed.predictions),
      suggestions: cleanSuggestions(parsed.suggestions),
      questions: cleanStr(parsed.questions),
    };
  } catch (err) {
    console.warn('[cognition] briefing failed (non-fatal):', err instanceof Error ? err.message : err);
    return empty;
  }
}
