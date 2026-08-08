// Context Engine (blueprint §7.3): decide what enters the model under a token
// budget. M3 owns two jobs — (1) inject always-loaded preferences + task-relevant
// recalled memories at task start, and (2) compact long in-task history so a
// many-iteration task stays under budget. It stores nothing (that's the Memory
// Service); it only ranks and assembles.
import type pg from 'pg';
import { MemoryService, graphForText, type MemoryType } from '@ai-os/memory';
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

  const [prefs, recalled, relations, contradictions] = await Promise.all([
    memory.getPreferences(),
    memory.recall({
      query: opts.goal,
      types: ['semantic', 'procedural', 'project', 'episodic', 'document', 'failure'] as MemoryType[],
      tags: opts.tags,
      limit: 10,
      // Global task context never pulls another project's memories (Phase 2
      // isolation); project-scoped recall is explicit via the project pack.
      excludeProjects: !opts.tags?.some((t) => t.startsWith('project:')),
    }),
    // Knowledge-graph connections for any entity named in the goal (Phase 3).
    graphForText(pool, opts.goal, 6).catch(() => []),
    // Unresolved contradictions to confirm with the user (Phase 4, §16).
    memory.getContradictions().catch(() => []),
  ]);

  if (prefs.length === 0 && recalled.length === 0 && relations.length === 0 && contradictions.length === 0) return '';

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
    // Failures get their own warning block — the whole point of failure memory
    // is that the model treats a past mistake as something to actively avoid,
    // not as one more neutral "fact".
    const failures = recalled.filter((r) => r.type === 'failure');
    const relevant = recalled.filter((r) => r.type !== 'preference' && r.type !== 'failure');

    if (failures.length) {
      lines.push('', '⚠ Past failures on similar tasks — do NOT repeat these; apply the prevention:');
      for (const f of failures) {
        const line = `- ${f.content}`;
        if (used + approxTokens(line) > budget) break;
        lines.push(line);
        used += approxTokens(line);
      }
    }

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

  if (contradictions.length) {
    lines.push('', '⚠ Conflicting facts — if relevant, ask the user which is current (do not assume):');
    for (const c of contradictions) {
      const line = `- ${c.subject}: ${c.options.map((o) => `"${o}"`).join(' vs ')}`;
      if (used + approxTokens(line) > budget) break;
      lines.push(line);
      used += approxTokens(line);
    }
  }

  if (relations.length) {
    lines.push('', 'Known connections (knowledge graph):');
    for (const r of relations) {
      const line = `- ${r.subject} → ${r.rel} → ${r.object}`;
      if (used + approxTokens(line) > budget) break;
      lines.push(line);
      used += approxTokens(line);
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
/** Fit the NEXT request inside a provider's per-request token ceiling by
 *  truncating the OLDEST tool-result messages first (a web page the model
 *  already extracted findings from rarely needs to ride along verbatim).
 *  Groq free tier enforces 8k tokens per request: one oversized request can
 *  NEVER succeed by waiting/retrying (Requested > Limit — dogfooded live
 *  2026-07-10 when a researcher's 2nd fetch_url pushed the context to 8.9k).
 *  Guarantees: never drops a message (tool_call/result pairing intact), never
 *  touches non-tool messages, never touches the CURRENT round's results (the
 *  model still needs what it just read), and preserves the [UNTRUSTED …]
 *  provenance banner because truncation keeps the content head. No-op when
 *  already under budget. */
export function shrinkToolResults(messages: ChatMessage[], budgetTokens: number, keepChars = 400): ChatMessage[] {
  const size = (m: ChatMessage): number =>
    approxTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')) +
    (m.tool_calls?.length ? approxTokens(JSON.stringify(m.tool_calls)) : 0);
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= budgetTokens) return messages;

  // The last assistant-with-tool-calls turn starts the current round — its
  // results stay verbatim.
  let currentRound = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant' && messages[i]!.tool_calls?.length) {
      currentRound = i;
      break;
    }
  }

  const marker = '\n…[older tool output truncated to fit the model window; re-run the tool if the full content is needed]';
  const out = messages.map((m) => ({ ...m }));
  for (let i = 0; i < currentRound && total > budgetTokens; i++) {
    const m = out[i]!;
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= keepChars + marker.length) continue;
    total -= approxTokens(m.content);
    m.content = m.content.slice(0, keepChars) + marker;
    total += approxTokens(m.content);
  }
  return out;
}

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
