// Memory extraction: after a task, pull durable facts/preferences worth keeping
// out of the conversation and store them typed, with provenance. Best-effort —
// an extraction failure must never break the task.
import type pg from 'pg';
import { callModel } from '@ai-os/model-router';
import { MemoryService, type MemoryType } from './service.js';

interface Extracted {
  type: MemoryType;
  content: string;
  subject?: string;
  confidence?: number;
}

const EXTRACT_SYSTEM = `You extract DURABLE memories from a support/assistant exchange for a personal AI OS.
Return ONLY facts worth remembering weeks later. Prefer few, high-value items.

Types:
- preference: how the user likes things done ("prefers concise replies", "wants citations"). Give a short stable "subject" (e.g. "reply-style", "tone").
- semantic: durable facts about the user or their world ("their KB lives at Downloads/kb", "works on billing"). subject = the thing the fact is about.
- project: an active goal/constraint the user stated.
Do NOT store: one-off task details, transient state, pleasantries, or anything already obvious.

Output STRICT JSON: {"memories":[{"type","content","subject","confidence"}]}. confidence 0..1.
If nothing is worth keeping, return {"memories":[]}.`;

export async function extractAndStore(
  pool: pg.Pool,
  opts: { taskId: string; traceId: string; userText: string; assistantText: string },
): Promise<number> {
  const memory = new MemoryService(pool);
  try {
    const res = await callModel({
      role: 'routing', // cheap tier — extraction is lightweight
      system: EXTRACT_SYSTEM,
      prompt: `USER:\n${opts.userText}\n\nASSISTANT:\n${opts.assistantText.slice(0, 2000)}`,
      maxTokens: 500,
      traceId: opts.traceId,
      taskId: opts.taskId,
      name: 'memory-extract',
    });
    const json = res.text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return 0;
    const parsed = JSON.parse(json) as { memories?: Extracted[] };
    const items = (parsed.memories ?? []).filter((m) => m.content && ['preference', 'semantic', 'project'].includes(m.type));
    let stored = 0;
    for (const item of items) {
      await memory.remember({
        type: item.type,
        content: item.content,
        subject: item.subject,
        confidence: item.confidence ?? 0.7,
        source: { task_id: opts.taskId, user_stated: true },
      });
      stored++;
    }
    return stored;
  } catch (err) {
    console.warn('[memory] extraction failed (non-fatal):', err instanceof Error ? err.message : err);
    return 0;
  }
}
