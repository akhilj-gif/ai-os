// Experiential memory (Memory OS Phase 1): turn a COMPLETED task into durable
// experience the OS can learn from — an episodic record of what happened, and,
// when it failed, a failure record (cause + prevention) so the same mistake
// surfaces as a warning on similar future tasks. This is the differentiator a
// chat assistant can't build: it runs on the OS's own execution signals (task
// status, the failed step's raw error, tool usage), not on conversation text.
//
// Sits alongside extractAndStore (which mines the exchange for preferences/
// facts): that path skips failures and never writes episodes — this one owns
// the "learn from doing" half. Best-effort + fire-and-forget: a failure here
// must never affect the task or its reply.
import type pg from 'pg';
import { callModel } from '@ai-os/model-router';
import { MemoryService } from './service.js';

const SYSTEM = `You distill a just-finished task of a personal AI OS into durable experiential memory.
Return ONE compact JSON object, nothing else:
{
 "episode": "<=1 sentence: what was attempted and how it turned out (past tense)",
 "lesson": "<=1 sentence actionable takeaway, or empty string if none",
 "failure": { "cause": "why it failed (concrete)", "prevention": "what to do differently next time" },
 "procedure": { "subject": "kebab-case name of the reusable workflow", "steps": "numbered steps, terse" }
}
Set "failure" to null unless the task actually failed.
Set "procedure" to null UNLESS the task SUCCEEDED and followed a reusable multi-step workflow worth repeating
(e.g. "deploy-nextjs", "triage-billing-ticket"). A one-off answer or a single lookup is NOT a procedure.
Be specific and terse — no filler.`;

interface Distilled {
  episode?: string;
  lesson?: string;
  failure?: { cause?: string; prevention?: string } | null;
  procedure?: { subject?: string; steps?: string } | null;
}

/** Record experiential memory for a finished task. Returns how many memories it
 *  stored. Self-contained: fetches the task's goal/trace/status and (on failure)
 *  the failed step's error, so the call site is a one-liner. */
export async function recordExperience(pool: pg.Pool, opts: { taskId: string; replyText: string }): Promise<number> {
  const { rows } = await pool.query<{ goal: string; trace_id: string; status: string }>(
    `SELECT goal, trace_id, status FROM tasks WHERE id = $1`,
    [opts.taskId],
  );
  const task = rows[0];
  if (!task) return 0;
  // Not finished yet (waiting on the user's approval) — capture when it resolves.
  if (task.status === 'awaiting_approval') return 0;

  // Only worth an episode if the task actually DID something (used tools) or
  // failed outright. Trivial Q&A ("what's 17+25") isn't an experience —
  // extractAndStore already mines any durable fact, and episodes here are noise.
  // Tool calls hang off 'reason' steps (there is no kind='tool' step), so count
  // via tool_calls joined to this task's steps — the real "did it act" signal.
  const toolCount = (
    await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM tool_calls tc JOIN steps s ON s.id = tc.step_id WHERE s.task_id = $1`,
      [opts.taskId],
    )
  ).rows[0]?.n ?? '0';
  if (task.status !== 'failed' && Number(toolCount) === 0) return 0;

  // A "failure worth remembering" is broader than task.status='failed': the most
  // valuable ones are tool-level errors the model reported or recovered from
  // (a WhatsApp send that errored, a rate-limit) — the task still ends 'done'.
  // Detect a failed step OR any tool call whose result carried an `error`, and
  // pass the raw error to the distiller (which decides if a lesson is warranted).
  const stepErr = (
    await pool.query<{ error: string }>(
      `SELECT error FROM steps WHERE task_id = $1 AND status = 'failed' AND error IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [opts.taskId],
    )
  ).rows[0]?.error;
  const toolErr = (
    await pool.query<{ result: unknown }>(
      `SELECT tc.result FROM tool_calls tc JOIN steps s ON s.id = tc.step_id
       WHERE s.task_id = $1 AND tc.result ? 'error' ORDER BY tc.created_at DESC LIMIT 1`,
      [opts.taskId],
    )
  ).rows[0]?.result;
  const toolErrText = toolErr && typeof toolErr === 'object' && 'error' in toolErr ? String((toolErr as { error: unknown }).error) : '';
  const errText = stepErr ?? toolErrText;
  const failed = task.status === 'failed' || !!errText;

  const memory = new MemoryService(pool);

  // Best-effort distillation (cheap tier is demonstrably flaky on this box). It
  // only ENRICHES — we always store a baseline below, so a flaked model never
  // costs us a failure lesson, the highest-value memory there is.
  let d: Distilled = {};
  try {
    const res = await callModel({
      role: 'routing',
      system: SYSTEM,
      prompt: [
        `GOAL:\n${task.goal.slice(0, 800)}`,
        `OUTCOME (${task.status}):\n${opts.replyText.slice(0, 800)}`,
        errText ? `RAW ERROR:\n${errText.slice(0, 600)}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      maxTokens: 300,
      traceId: task.trace_id,
      taskId: opts.taskId,
      name: 'memory-experience',
    });
    const json = res.text.match(/\{[\s\S]*\}/)?.[0];
    if (json) d = JSON.parse(json) as Distilled;
  } catch (err) {
    console.warn('[memory] experience distill failed (using baseline):', err instanceof Error ? err.message : err);
  }

  const day = new Date().toISOString().slice(0, 10);
  const goalShort = task.goal.replace(/\s+/g, ' ').slice(0, 120);
  let stored = 0;

  // Episode: distilled if available, else a plain baseline from goal + outcome.
  const episode = d.episode?.trim() || `${goalShort} — ${failed ? 'failed' : 'completed'}`;
  const lesson = d.lesson?.trim() ? ` Lesson: ${d.lesson.trim()}` : '';
  await memory.remember({ type: 'episodic', content: `On ${day}: ${episode}${lesson}`, confidence: 0.7, source: { task_id: opts.taskId } });
  stored++;

  // Failure: distilled cause/prevention if available, else the raw error as the
  // cause — the lesson is preserved either way (failures persist longer via
  // higher confidence + the reflection decay curve).
  if (failed && errText) {
    const cause = d.failure?.cause?.trim() || errText.replace(/\s+/g, ' ').slice(0, 200);
    const prevention = d.failure?.prevention?.trim() || 'n/a';
    await memory.remember({ type: 'failure', content: `Failed: "${goalShort}" — cause: ${cause}. Prevention: ${prevention}.`, confidence: 0.85, source: { task_id: opts.taskId } });
    stored++;
  }

  // Skill/procedure learning (the Learning Engine): a SUCCESSFUL multi-step
  // workflow becomes a reusable procedure, subject-keyed so each run supersedes
  // the prior version (it sharpens over time instead of duplicating). Recall
  // already surfaces `procedural` on similar tasks — next time the OS starts
  // from the known workflow.
  if (!failed && Number(toolCount) >= 2 && d.procedure?.subject?.trim() && d.procedure?.steps?.trim()) {
    const subject = d.procedure.subject.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (subject) {
      await memory.remember({
        type: 'procedural',
        content: `How to ${subject.replace(/-/g, ' ')}: ${d.procedure.steps.trim()}`,
        subject: `skill:${subject}`,
        confidence: 0.75,
        source: { task_id: opts.taskId },
      });
      stored++;
    }
  }

  return stored;
}
