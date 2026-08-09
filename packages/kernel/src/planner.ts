// Planner (blueprint §4.2): goal → clarifying question (when genuinely ambiguous)
// or a task graph. It interprets and decomposes; it NEVER executes tools. Output
// is a DAG of typed steps the graph executor (graph.ts) then drives.
import type pg from 'pg';
import { callModel } from '@ai-os/model-router';
import { parseModelJson } from '@ai-os/shared';
import { buildRegistry, type ToolRegistry } from '@ai-os/tools';
import { classifyTool, requiresApproval, type TrustPolicy } from '@ai-os/trust';
import { assembleMemoryContext } from './context.js';

export type StepKind = 'reason' | 'tool' | 'approval';

export interface PlannedStep {
  local_id: string;
  title: string;
  kind: StepKind;
  depends_on: string[];
  instruction: string;
  tool?: string;
  tool_args?: Record<string, unknown>;
}

export interface Plan {
  clarify: string | null;
  steps: PlannedStep[];
}

function plannerSystem(tools: { name: string; description: string; trust: string }[]): string {
  const toolList = tools.map((t) => `  - ${t.name} [${t.trust}]: ${t.description}`).join('\n');
  return `You are the PLANNER of a personal AI Operating System. Turn the user's goal into a plan.
You do NOT execute anything — you only decompose.

Available tools (name [trust-class]: what it does):
${toolList}

Return STRICT JSON, no prose:
{
  "clarify": "<a single question, ONLY if the goal is genuinely ambiguous or missing critical info; else null>",
  "steps": [
    { "local_id": "s1", "title": "short label", "kind": "reason|tool|approval",
      "depends_on": ["<local_ids that must finish first>"],
      "instruction": "what this step must accomplish",
      "tool": "<tool name, for kind=tool only>", "tool_args": { } }
  ]
}

Rules:
- Prefer the SMALLEST correct graph. A trivial goal = one reason step.
- kind "tool": exactly one tool call (set tool + tool_args). kind "reason": synthesize/decide over prior steps' outputs (no tools). kind "approval": PAUSE for the user to confirm before something irreversible.
- Parallelism is implicit: steps with no shared depends_on run concurrently. Use depends_on only for real ordering.
- Insert an "approval" step (and make the risky step depend on it) BEFORE any tool whose trust-class is "irreversible" or "spend", or any externally-visible action.
- End with a reason step that produces the final answer for the user, depending on the steps it needs.
- Only clarify when you truly cannot proceed — do not ask when a sensible default exists (FC-011).`;
}

const PLAN_SCHEMA_HINT = ''; // schema is described in the system prompt; we parse JSON

export async function makePlan(
  pool: pg.Pool,
  opts: { taskId: string; traceId: string; goal: string; registry?: ToolRegistry; directive?: string },
): Promise<Plan> {
  const registry = opts.registry ?? buildRegistry();
  // Trust class per tool, from policy (fail-closed) — so the planner knows what needs approval.
  const policyRows = (
    await pool.query<{ tool: string; trust_class: string; auto_approve: boolean }>(
      `SELECT tool, trust_class, auto_approve FROM trust_policies`,
    )
  ).rows;
  const policies: TrustPolicy[] = policyRows.map((r) => ({ tool: r.tool, trustClass: r.trust_class as TrustPolicy['trustClass'], autoApprove: r.auto_approve }));
  const tools = registry.list().map((t) => ({
    name: t.name,
    description: t.description,
    trust: classifyTool(t.name, policies),
  }));

  let memoryBlock = '';
  if (!opts.registry) {
    try {
      memoryBlock = await assembleMemoryContext(pool, { goal: opts.goal });
    } catch {
      /* best-effort */
    }
  }

  const prompt = [
    memoryBlock,
    `GOAL: ${opts.goal}`,
    opts.directive ? `MID-RUN DIRECTIVE from the user (fold this into the plan): ${opts.directive}` : '',
    PLAN_SCHEMA_HINT,
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await callModel({
    role: 'planning',
    system: plannerSystem(tools),
    prompt,
    maxTokens: 1500,
    traceId: opts.traceId,
    taskId: opts.taskId,
    name: 'planner',
  });

  const parsed = parseModelJson<Plan>(res.text);
  if (!parsed) throw new Error(`planner returned no parseable JSON: ${res.text.slice(0, 200)}`);

  // Validation + fail-closed backstop: any tool step whose tool needs approval
  // must be gated. If the planner forgot, inject an approval step before it.
  const steps = (parsed.steps ?? []).filter((s) => s.local_id && s.kind);
  const byId = new Map(steps.map((s) => [s.local_id, s]));
  for (const s of steps) {
    if (s.kind === 'tool' && s.tool) {
      const trust = classifyTool(s.tool, policies);
      const hasApprovalDep = (s.depends_on ?? []).some((d) => byId.get(d)?.kind === 'approval');
      if (requiresApproval(trust) && !hasApprovalDep) {
        const gate: PlannedStep = {
          local_id: `${s.local_id}-approve`,
          title: `Approve: ${s.title}`,
          kind: 'approval',
          depends_on: s.depends_on ?? [],
          instruction: `Confirm before running ${s.tool} (${trust} action).`,
        };
        steps.push(gate);
        s.depends_on = [gate.local_id];
        byId.set(gate.local_id, gate);
      }
    }
  }

  return { clarify: parsed.clarify ?? null, steps };
}
