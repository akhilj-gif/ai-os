// The BROWSER BRIDGE CONTRACT (ADR-0018). The OS never drives a browser
// directly — this bridge process owns one persistent Playwright browser and
// exposes a tiny localhost HTTP API. The `browser` pack's tools speak ONLY
// this contract, so the implementation behind it (real Chromium here, the
// in-module mock in tests) is swappable without touching the OS. Pointed at
// Ola/Rapido, the SAME bridge is M14's ride-booking substrate.
//
//   GET  /health                         → BridgeHealth
//   POST /navigate { url }               → { url, title }
//   POST /read     { }                   → { url, title, text }   (untrusted)
//   POST /find     { query }             → { matches: ElementRef[] }
//   POST /act      { action, ref, text } → { ok, url, title, elements }
//   POST /extract  { instruction }       → { url, instruction, text } (untrusted)
//   POST /wait     { selector?, text?, state?, timeoutMs? } → { ok, url, title, elements }
//   POST /screenshot { }                 → { url, title, dataUrl } (jpeg, untrusted)
//
// navigate/read/act/wait also return `elements: ElementRef[]` — a fresh snapshot
// of the CURRENT page's interactive controls, so refs are never stale.
//
// The bridge enforces NO policy — the OS trust gate does (browser_act is
// irreversible + approval-gated; page content is untrusted §8.3). Binds
// 127.0.0.1 only; BROWSER_BRIDGE_TOKEN (optional) is a shared-secret header.

export interface BridgeHealth {
  ok: boolean;
  impl: 'playwright' | 'mock';
  url: string; // current page URL
  headless: boolean;
}

export interface ElementRef {
  ref: string; // opaque handle valid until the next navigation (data-aios-ref)
  role: string; // link | button | field | ...
  name: string; // accessible text / placeholder / value
}

export type BrowserAction = 'click' | 'type' | 'select' | 'scroll' | 'key';

export const DEFAULT_BROWSER_BRIDGE_PORT = 4200;
export const browserBridgeUrl = (): string =>
  process.env.BROWSER_BRIDGE_URL ?? `http://127.0.0.1:${DEFAULT_BROWSER_BRIDGE_PORT}`;
