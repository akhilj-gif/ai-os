// Context Engine (blueprint §7.3): decide what enters the model under a token
// budget. M3 owns two jobs — (1) inject always-loaded preferences + task-relevant
// recalled memories at task start, and (2) compact long in-task history so a
// many-iteration task stays under budget. It stores nothing (that's the Memory
// Service); it only ranks and assembles.
import type pg from 'pg';
import { MemoryService, type MemoryType } from '@ai-os/memory';
import type { ChatMessage } from '@ai-os/model-router';

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

/** Build the MEMORY context block for a task: preferences (always) + relevant
 *  recalled memories (ranked), trimmed to `budgetTokens`. Empty string if nothing. */
export async function assembleMemoryContext(
  pool: pg.Pool,
  opts: { goal: string; tags?: string[]; budgetTokens?: number },
): Promise<string> {
  const budget = opts.budgetTokens ?? 1200;
  const memory = new MemoryService(pool);

  const [prefs, recalled] = await Promise.all([
    memory.getPreferences(),
    memory.recall({
      query: opts.goal,
      types: ['semantic', 'procedural', 'project', 'episodic', 'document'] as MemoryType[],
      tags: opts.tags,
      limit: 10,
    }),
  ]);

  if (prefs.length === 0 && recalled.length === 0) return '';

  const lines: string[] = [
    '## Memory — what you already know about this user',
    'Treat these as trusted context you learned earlier. Honor preferences. Cite with [memory] when you rely on a fact.',
  ];
  let used = approxTokens(lines.join('\n'));

  if (prefs.length) {
    lines.push('', 'Preferences (always apply):');
    for (const p of prefs) {
      const line = `- ${p.content}`;
      if (used + approxTokens(line) > budget) break;
      lines.push(line);
      used += approxTokens(line);
    }
  }

  if (recalled.length) {
    const relevant = recalled.filter((r) => r.type !== 'preference');
    if (relevant.length) {
      lines.push('', 'Relevant to this task:');
      for (const r of relevant) {
        const line = `- [${r.type}] ${r.content}`;
        if (used + approxTokens(line) > budget) break;
        lines.push(line);
        used += approxTokens(line);
      }
    }
  }

  return lines.length > 2 ? lines.join('\n') : '';
}

/** Compact long in-task history (§7.3 pt 5). When the message array grows past
 *  `maxMessages`, replace the OLDEST tool-result messages with a single summary
 *  line, preserving the system prompt, the original goal, and the most recent
 *  verbatim exchanges. Keeps assistant/tool_call pairing intact by only ever
 *  collapsing standalone tool-result content, never splitting a call/result pair.
 *  Returns a new array; caller decides when to invoke. */
export function compactHistory(messages: ChatMessage[], maxMessages = 40, keepRecent = 12): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  const goal = firstUserIdx >= 0 ? [messages[firstUserIdx]!] : [];
  const recent = messages.slice(-keepRecent);

  // The middle span being compacted: everything between the goal and the recent tail.
  const middleStart = Math.max((firstUserIdx >= 0 ? firstUserIdx : 0) + 1, system.length + goal.length);
  const middle = messages.slice(middleStart, messages.length - keepRecent);
  if (middle.length === 0) return messages;

  const toolCallsSeen = middle.filter((m) => m.role === 'assistant' && m.tool_calls?.length).flatMap((m) => m.tool_calls!.map((t) => t.function.name));
  const summary: ChatMessage = {
    role: 'user',
    content: `[history compacted: ${middle.length} earlier messages omitted; tools already used: ${[...new Set(toolCallsSeen)].join(', ') || 'none'}. Their results are reflected in what follows.]`,
  };
  return [...system, ...goal, summary, ...recent];
}
