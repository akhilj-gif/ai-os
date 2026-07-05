// Tool Layer (blueprint §4.1) — M1: web search, per-task filesystem workspace,
// Gmail/Calendar read+draft. Registry shapes are MCP-compatible (ADR-0004).
import { ToolRegistry } from './registry.js';
import { webSearch } from './tools/web-search.js';
import { fetchUrl } from './tools/fetch-url.js';
import { workspaceList, workspaceRead, workspaceWrite } from './tools/workspace.js';
import { gmailList, gmailRead, gmailCreateDraft } from './tools/gmail.js';
import { calendarList } from './tools/calendar.js';

export type { ToolDef, ToolContext, ToolSchema } from './registry.js';
export { ToolRegistry } from './registry.js';
export { GoogleNotConnectedError, getGoogleAccessToken, googleApi } from './google.js';
export { todayRange } from './tools/calendar.js';
export { type SandboxRunner, type SandboxSpec, type SandboxResult, notImplementedSandbox } from './sandbox.js';

export function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    webSearch,
    fetchUrl,
    workspaceList,
    workspaceRead,
    workspaceWrite,
    gmailList,
    gmailRead,
    gmailCreateDraft,
    calendarList,
  ]) {
    registry.register(tool);
  }
  return registry;
}
