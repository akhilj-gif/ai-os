// Tool Layer (blueprint §4.1) — M1: web search, per-task filesystem workspace,
// Gmail/Calendar read+draft. Registry shapes are MCP-compatible (ADR-0004).
import { ToolRegistry } from './registry.js';
import { webSearch } from './tools/web-search.js';
import { fetchUrl } from './tools/fetch-url.js';
import { workspaceList, workspaceRead, workspaceWrite } from './tools/workspace.js';
import { gmailList, gmailRead, gmailCreateDraft } from './tools/gmail.js';
import { calendarList, calendarCreateEvent } from './tools/calendar.js';
import { codeExec } from './tools/code-exec.js';
import { whatsappListChats, whatsappReadMessages, whatsappSendMessage } from './tools/whatsapp.js';

export type { ToolDef, ToolContext, ToolSchema } from './registry.js';
export { ToolRegistry } from './registry.js';
export { GoogleNotConnectedError, getGoogleAccessToken, googleApi } from './google.js';
export { todayRange } from './tools/calendar.js';
export { type SandboxRunner, type SandboxSpec, type SandboxResult, notImplementedSandbox } from './sandbox.js';
export { DockerSandbox, dockerSandbox } from './docker-sandbox.js';
// Individual tool defs — capability packs (M9, @ai-os/packs) group these into
// installable manifests; buildRegistry() below remains the ALL-tools builder
// (used by the eval gym, whose closed world stubs whatever a case doesn't mock).
export { webSearch } from './tools/web-search.js';
export { fetchUrl } from './tools/fetch-url.js';
export { workspaceList, workspaceRead, workspaceWrite } from './tools/workspace.js';
export { gmailList, gmailRead, gmailCreateDraft } from './tools/gmail.js';
export { calendarList, calendarCreateEvent } from './tools/calendar.js';
export { codeExec } from './tools/code-exec.js';
export { whatsappListChats, whatsappReadMessages, whatsappSendMessage } from './tools/whatsapp.js';

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
    calendarCreateEvent,
    codeExec,
    whatsappListChats,
    whatsappReadMessages,
    whatsappSendMessage,
  ]) {
    registry.register(tool);
  }
  return registry;
}
