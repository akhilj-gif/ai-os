// The gym's case contract (docs/EVAL-SPEC.md §2-3). Tier 1 (output assertions)
// and tier 2 (trace assertions on tool_calls/task rows) — the LLM judge tier
// arrives when rubric-scored quality cases exist.
import type pg from 'pg';
import type { ToolRegistry } from '@ai-os/tools';
import type { MemoryType } from '@ai-os/memory';

export interface CaseContext {
  /** Final assistant text produced by the task. */
  text: string;
  /** Task row after the run. */
  task: { status: string; spent: { tokens: number } };
  /** True when the task failed due to provider rate-limit/quota (not a real
   *  assertion result). Such cases are SKIPPED, never scored (FC-017). */
  infraFailed: boolean;
  /** All tool_calls made during the task (joined via steps). */
  toolCalls: Array<{
    tool: string;
    trust_class: string;
    approved_by: string | null;
    args: Record<string, unknown>;
    result: unknown;
  }>;
  pool: pg.Pool;
}

export interface Assertion {
  name: string;
  /** Return true to pass, or a string explaining the failure. */
  check: (ctx: CaseContext) => boolean | string | Promise<boolean | string>;
  /** Soft assertions are reported but DO NOT gate: their pass/fail never changes a
   *  case's verdict or the baseline. Use for text-QUALITY checks that a regex can't
   *  judge reliably across non-deterministic model output (did it *verbalize* a
   *  refusal? phrase an honest "not found"?) — these flap run-to-run and would cause
   *  false regressions. The deterministic security/safety property (no forbidden
   *  tool_call) stays HARD. Soft checks graduate to hard once the LLM-judge tier
   *  (EVAL-SPEC §3) can score them stably. See FC-021. */
  soft?: boolean;
  /** A trace/tool_call-based assertion whose verdict is meaningful even when the
   *  task failed on infra (a recorded forbidden tool_call is a REAL result, not a
   *  rate-limit artifact). These are evaluated on infra-failed cases; a failure
   *  here is a genuine FAIL, not a SKIP. Output/text assertions must be false
   *  here — they can't be judged if the task never produced its final answer. */
  traceBased?: boolean;
}

export interface EvalCase {
  id: string;
  /** Failure-corpus traceability (docs/FAILURE-CORPUS.md). */
  source?: string;
  goal: string;
  /** Precondition: the tool(s) the case exists to exercise. If, after the run,
   *  none of these was actually invoked, the case is INVALID (fails as a
   *  precondition breach) rather than passing vacuously — a model or registry
   *  that never delivers the payload cannot earn a green. */
  requiresTool?: string | string[];
  /** Memory-recall cases: records to seed BEFORE the run (tagged 'eval-seed' and
   *  purged after), plus enableMemory to force memory injection under the mocked
   *  registry. The task can then only answer correctly by RECALLING the seed. */
  seedMemory?: Array<{ type: MemoryType; content: string; subject?: string; source: { user_stated?: boolean; task_id?: string } }>;
  enableMemory?: boolean;
  /** Mock tool executors by name; unmocked tools run for real. Extra tools may
   *  be added via `extraTools`. */
  mocks?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  extraTools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  }>;
  assertions: Assertion[];
}

export interface Suite {
  name: string;
  /** This suite must score 100% or the whole run fails (injection-defense). */
  gate100?: boolean;
  cases: EvalCase[];
}

export type BuildRegistry = (evalCase: EvalCase) => ToolRegistry;
