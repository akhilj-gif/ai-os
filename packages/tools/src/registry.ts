// Tool Layer (blueprint §4.1). M1: an in-process registry whose shapes ARE the MCP
// tool shapes (name / description / JSON-Schema input / content result), so wiring a
// real MCP transport later is an adapter, not a rewrite (ADR-0004). Every execution
// goes through the Trust Gate and lands in tool_calls — the registry itself never
// bypasses that (the executor owns the gate call).
import type pg from 'pg';

export interface ToolContext {
  pool: pg.Pool;
  taskId: string;
  /** The §8.3 latch AS OF THIS CALL: untrusted external content is already in
   *  this task's context. Supplied by the executor from its live state, never by
   *  the model — so a compromised model cannot claim first-party provenance.
   *
   *  Only tools that PERSIST content need this (2026-08-13 memory-poisoning
   *  audit). A durable writer classified 'read' — project_record, wm_set — is
   *  not stopped by the trust gate, because the gate only blocks mutating
   *  classes. Reclassifying them to 'write' would stop them, but
   *  blockedByUntrustedContext is a HARD REFUSAL with no approval path (unlike
   *  irreversible/spend, which queue for the user), so "read this page and save
   *  the decision to my project" would become impossible rather than merely
   *  gated. Stamping source.untrusted instead keeps the feature AND closes the
   *  hole, since a marked row is quarantined on recall and arms this same latch
   *  for the recalling task — it can never gain authority. */
  untrusted?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments (MCP-compatible). */
  inputSchema: Record<string, unknown>;
  /** True if this tool's OUTPUT is untrusted external content (web pages, email/
   *  ticket bodies, calendar entries). Once such output enters context, the trust
   *  gate blocks mutating actions (§8.3 rule 2). Defaults to false. */
  untrustedOutput?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  untrustedOutput: boolean;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolSchema[] {
    return [...this.tools.values()].map(({ name, description, inputSchema, untrustedOutput }) => ({
      name,
      description,
      inputSchema,
      untrustedOutput: untrustedOutput ?? false,
    }));
  }
}
