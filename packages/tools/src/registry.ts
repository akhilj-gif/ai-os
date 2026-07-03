// Tool Layer (blueprint §4.1). M1: an in-process registry whose shapes ARE the MCP
// tool shapes (name / description / JSON-Schema input / content result), so wiring a
// real MCP transport later is an adapter, not a rewrite (ADR-0004). Every execution
// goes through the Trust Gate and lands in tool_calls — the registry itself never
// bypasses that (the executor owns the gate call).
import type pg from 'pg';

export interface ToolContext {
  pool: pg.Pool;
  taskId: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments (MCP-compatible). */
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }
}
