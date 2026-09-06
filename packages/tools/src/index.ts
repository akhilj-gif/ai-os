// Tool Layer (blueprint §4.1) — M1: web search, per-task filesystem workspace,
// Gmail/Calendar read+draft. Registry shapes are MCP-compatible (ADR-0004).
import { ToolRegistry } from './registry.js';
import { webSearch } from './tools/web-search.js';
import { fetchUrl } from './tools/fetch-url.js';
import { workspaceList, workspaceRead, workspaceWrite } from './tools/workspace.js';
import { gmailList, gmailRead, gmailCreateDraft } from './tools/gmail.js';
import { calendarList, calendarCreateEvent } from './tools/calendar.js';
import { codeExec } from './tools/code-exec.js';
import { whatsappListChats, whatsappReadMessages, whatsappSearchContacts, whatsappSendMessage } from './tools/whatsapp.js';
import { xGetMe, xDraftPost, xPublishPost } from './tools/x.js';
import { instagramGetProfile, instagramRecentPosts, instagramPostInsights, instagramDraftPost, instagramPublishPost } from './tools/instagram.js';
import { appScrape, appSave, appList, appRun } from './tools/connectors.js';
import { terminalRun, terminalExec } from './tools/terminal.js';
import { fsList, fsRead, fsSearch, fsWrite, fsOpen } from './tools/files.js';
import { screenCapture } from './tools/screen.js';
import { projectCreate, projectList, projectRecord, projectRecall } from './tools/project.js';
import { graphQuery } from './tools/graph.js';
import { wmSet, wmGet, wmClear } from './tools/wm.js';
import { httpGet, httpSend, openUrl } from './tools/http.js';
import { clipboardRead, clipboardWrite, systemStatus } from './tools/desktop.js';
import { mobilityEstimate, mobilityBook } from './tools/mobility.js';
import { browserNavigate, browserRead, browserFind, browserExtract, browserAct, browserWait, browserScreenshot } from './tools/browser.js';
import { videoAnalyze } from './tools/video.js';

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
export { whatsappListChats, whatsappReadMessages, whatsappSearchContacts, whatsappSendMessage } from './tools/whatsapp.js';
export { xGetMe, xDraftPost, xPublishPost, xMockOutbox, X_MAX_CHARS } from './tools/x.js';
export { appScrape, appSave, appList, appRun, type Recipe } from './tools/connectors.js';
export {
  instagramGetProfile,
  instagramRecentPosts,
  instagramPostInsights,
  instagramDraftPost,
  instagramPublishPost,
  igMockOutbox,
  validateCaption,
  IG_MAX_CAPTION,
  IG_MAX_HASHTAGS,
} from './tools/instagram.js';
export { terminalRun, terminalExec, checkReadCommand, scrubbedEnv } from './tools/terminal.js';
export { fsList, fsRead, fsSearch, fsWrite, fsOpen, confinePath } from './tools/files.js';
export { screenCapture, captureScreen } from './tools/screen.js';
export { projectCreate, projectList, projectRecord, projectRecall } from './tools/project.js';
export { graphQuery } from './tools/graph.js';
export { wmSet, wmGet, wmClear } from './tools/wm.js';
export { httpGet, httpSend, openUrl } from './tools/http.js';
export { clipboardRead, clipboardWrite, systemStatus } from './tools/desktop.js';
export { mobilityEstimate, mobilityBook, mobilityMockOutbox, type RideOption, type Provider } from './tools/mobility.js';
export { decideRide, DEFAULT_PREFS, type MobilityPrefs, type RideContext, type RideDecision } from './tools/mobility-decide.js';
export { uberConfigured, uberAuthorizeUrl, exchangeUberCode, uberVehicleClass, encodeUberOption, decodeUberOption, isUberOption, mapUberEstimates, UberNotConnectedError, type UberPriceItem, type UberTimeItem, type Coords } from './tools/uber.js';
export { browserNavigate, browserRead, browserFind, browserExtract, browserAct, browserWait, browserScreenshot, browserMockActions } from './tools/browser.js';
export { videoAnalyze } from './tools/video.js';

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
    whatsappSearchContacts,
    whatsappSendMessage,
    xGetMe,
    xDraftPost,
    xPublishPost,
    appScrape,
    appSave,
    appList,
    appRun,
    instagramGetProfile,
    instagramRecentPosts,
    instagramPostInsights,
    instagramDraftPost,
    instagramPublishPost,
    terminalRun,
    terminalExec,
    fsList,
    fsRead,
    fsSearch,
    fsWrite,
    fsOpen,
    screenCapture,
    projectCreate,
    projectList,
    projectRecord,
    projectRecall,
    graphQuery,
    wmSet,
    wmGet,
    wmClear,
    httpGet,
    httpSend,
    openUrl,
    clipboardRead,
    clipboardWrite,
    systemStatus,
    mobilityEstimate,
    mobilityBook,
    browserNavigate,
    browserRead,
    browserFind,
    browserExtract,
    browserAct,
    browserWait,
    browserScreenshot,
    videoAnalyze,
  ]) {
    registry.register(tool);
  }
  return registry;
}
