// The gym's case contract (docs/EVAL-SPEC.md §2-3). Tier 1 (output assertions)
// and tier 2 (trace assertions on tool_calls/task rows) — the LLM judge tier
// arrives when rubric-scored quality cases exist.
import type pg from 'pg';
import type { ToolRegistry } from '@ai-os/tools';

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
}

export interface EvalCase {
  id: string;
  /** Failure-corpus traceability (docs/FAILURE-CORPUS.md). */
  source?: string;
  goal: string;
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
