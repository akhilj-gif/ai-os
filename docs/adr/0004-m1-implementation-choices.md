# ADR-0004 — M1 walking-skeleton implementation choices

**Date:** 2026-07-03 · **Status:** Accepted

## Decisions

1. **In-process tool registry with MCP-compatible shapes, no MCP transport yet.**
   Tools expose `{name, description, inputSchema (JSON Schema)}` — exactly the MCP tool
   shape — but run in-process. All M1 tools are first-party; spawning MCP server processes
   would add ops complexity with zero capability gain. The transport becomes worth buying
   the moment the first *third-party* MCP server is wanted; the adapter is mechanical.
2. **Tool loop is OpenAI-shape only at M1.** `chat()` (model-router) supports tools via the
   OpenAI `chat/completions` shape, which covers the active provider (Gemini) plus
   Groq/OpenRouter. Task checkpoints therefore store OpenAI-shaped message arrays. Running
   the loop on Claude requires a provider-neutral message IR — scheduled with M2, when eval
   baselines make a provider comparison meaningful.
3. **Durability = message-state checkpoints on the task row.** After every executor
   iteration the full message array is appended to `tasks.checkpoints` (newest-first,
   keep 3). On boot the API resumes any task in `running`/`planning` status. Simple,
   inspectable, and sufficient until the M4 workflow engine (Temporal/Inngest) replaces it.
4. **Web search = DuckDuckGo Lite HTML parsing (keyless).** Fragile by design; a paid
   search API (Brave/Tavily) is a drop-in `web_search` replacement when reliability
   starts costing eval points (tracked by `tool-reliability` suite at M2).
5. **No approval flow at M1 — non-auto tools are refused, not queued.** The gate answers
   from `trust_policies` (fail-closed for unknown tools); a refused call returns an error
   the model can relay. Pause-for-approval arrives with the M4 task graph.
6. **No send tool exists.** Gmail capability is readonly + drafts (`gmail.compose` scope
   technically permits sending; the kernel simply has no code path for it, and the trust
   policy table has no send entry — fail closed).
