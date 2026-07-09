# BUILD PROMPT — "AI OS Voice" · a voice-first control surface for my personal AI Operating System

> Copy everything below this line into the app builder (Lovable / v0 / Bolt / Cursor / Windsurf).
> The backend ALREADY EXISTS and runs on my machine — you are building ONLY the front-end.

---

## Mission

Build a **voice-first web app** that is the primary way I talk to my personal AI OS.
Today I type into a plain chat page; I want to **speak commands** ("what's on my plate today", "send Sanju a WhatsApp saying I'll be late", "schedule a meeting tomorrow at 3pm") and **hear** the answers, with a beautiful, minimal, futuristic UI. Typing stays as a fallback, never the star.

The backend is a Fastify API on `http://127.0.0.1:4000` (localhost ONLY, no CORS headers). It already does: chat with tool-calling (Gmail read/draft, Google Calendar read/create, WhatsApp read/send, web search/research, sandboxed code), speech-to-text, sessions, a human-approval queue for irreversible actions, memory, scheduled automations, and a task inspector. Do not rebuild any backend logic. Do not add auth screens — it is a single-user local app.

## Non-negotiable constraints

1. **Same-origin proxy, no CORS.** The API sends no CORS headers by design (security). Configure the dev server to proxy `/api/*` → `http://127.0.0.1:4000/*` (Vite: `server.proxy = { '/api': { target: 'http://127.0.0.1:4000', rewrite: p => p.replace(/^\/api/, '') } }`). ALL fetches in app code go to `/api/...`, never to `:4000` directly.
2. **Mock mode.** Cloud previews cannot reach my localhost. Ship a `MOCK` flag (env or `?mock=1`): when on, every endpoint returns realistic fixtures (provided below-ish; invent plausible data matching the contract) with fake latency (300–1500ms) so the whole UI is demoable in the builder's preview. When off, hit the proxy. One switch, zero code changes elsewhere (wrap fetch in a tiny `api()` helper).
3. **The approval invariant (trust model — do not weaken):** irreversible actions (WhatsApp send, calendar create) are NEVER executed by the assistant directly. The backend queues them and the UI must show an **approval card with the exact action** (tool + args, human-readable). Nothing runs until the user approves. The UI may let the user approve BY VOICE (rules in §7) but the card must always be visible, and the exact content must be shown/read verbatim.
4. **`POST /chat` is synchronous and can take 2–30s+** (it runs the whole task). Never block the UI on it: fire it, show the "thinking" state, and let the message poller render whatever arrives. Handle timeouts gracefully (the poller will still pick up the reply).
5. **Speech synthesis (TTS) is client-side**: use the browser's `speechSynthesis` API (free, offline). Pick a natural default voice, expose rate/voice in settings. The backend does STT only.
6. Single user, dark theme only, desktop-first (1280×800) but fully usable at 380px width.
7. Stack: **React + TypeScript + Vite + Tailwind**. No heavy UI kits; framer-motion allowed for the orb/transitions. Keep bundle lean.

## §1 — Complete API contract (the UI's world)

Base path (through proxy): `/api`. All bodies JSON unless stated. Poll-friendly, no websockets (yet — see §10).

### Core loop
| Endpoint | Shape |
|---|---|
| `GET /api/health` | `{ ok, milestone, services: { postgres, redis, langfuse } }` — poll ~10s for the "kernel online" dot |
| `POST /api/chat` | body `{ text: string, sessionId: string }` → `{ sessionId, taskId, reply }` (slow; see constraint 4) |
| `POST /api/voice/transcribe` | **raw audio bytes as the body** (NOT multipart/form), header `content-type: audio/webm;codecs=opus` (or `audio/wav`), ≤25MB → `{ text }`. Errors: `{ error }` with 400/502. STT is Whisper pinned to English |
| `GET /api/messages?sessionId=…` | `{ sessionId, messages: [{ id, role: 'user'\|'assistant', content, created_at }], pendingActions: [{ id, task_id, tool, args, untrusted_context, created_at }] }` — **the heartbeat: poll every 3–4s** |
| `POST /api/pending/:id/decide` | body `{ decision: 'approved' \| 'rejected' }` → `{ ok, executed, ... }`. 409 if already decided (treat as stale card, drop it) |

### Sessions ("New chat")
| Endpoint | Shape |
|---|---|
| `POST /api/sessions` | → `{ id, title, created_at, updated_at }` |
| `GET /api/sessions` | `{ sessions: [{ id, title, created_at, updated_at, message_count, first_message }] }` ordered by recency |
| `DELETE /api/sessions/:id` | cascades messages |

Persist last-used session id in `localStorage` (`aios-voice-last-session`); on boot: saved id if it still exists → else most recent → else create. **Prefer new sessions per topic** — long sessions degrade the free-tier model quota.

### Glance data (secondary screens)
| Endpoint | Notes |
|---|---|
| `GET /api/dashboard` | aggregate: `{ approvals, pendingActions, activeTasks, recentTasks, notifications: { unread, latest }, jobs, spend, counts }` — render defensively (extra fields may exist) |
| `GET /api/tasks` / `GET /api/tasks/:id` | list `{ tasks: [{ id, goal, status }] }`; detail `{ task, steps: [{ id, kind, title, status, tool, output, error }] }`. Status colors: done green, running blue, awaiting_approval amber, failed red |
| `GET /api/memory?includeSuperseded=false` · `GET /api/memory/search?q=…` · `DELETE /api/memory/:id` | records `{ id, type, content, subject, confidence, source, relevance? }` |
| `GET /api/jobs` · `POST /api/jobs/:id/run-now` · `PUT /api/jobs/:id` · `DELETE /api/jobs/:id` | automations; render name/kind/schedule/state, run-now + pause buttons |
| `GET /api/notifications` · `POST /api/notifications/:id/read` | notification feed |
| `GET /api/packs` | capability packs (name, version, enabled, tools, requires) — read-only display is fine |
| `GET /api/oauth/google/status` | `{ connected, email? }` — if false, show a quiet banner linking to `http://localhost:4000/oauth/google` (open in new tab; do NOT proxy this one — it's a browser redirect flow) |
| `POST /api/research` `{ question }` · `GET /api/research` · `GET /api/research/:id` | cited research reports (secondary screen) |

Anything not listed: don't call it.

## §2 — App structure

```
src/
  api/client.ts          # fetch wrapper: base '/api', MOCK switch, typed helpers
  api/mock.ts            # fixtures for every endpoint above
  state/                 # tiny store (zustand): session, messages, pending, voiceState, settings
  voice/recorder.ts      # MediaRecorder wrapper (webm/opus, 60s cap, min-size guard)
  voice/speaker.ts       # speechSynthesis wrapper (queue, barge-in cancel, voice/rate prefs)
  voice/machine.ts       # the voice state machine (§4)
  components/
    Orb.tsx              # the centerpiece (§5)
    TranscriptThread.tsx # message list w/ live partial states
    ApprovalCard.tsx     # §6/§7 — visual + voice approval
    Composer.tsx         # text fallback input + mic + send
    SessionDrawer.tsx    # history: switch / new / delete
    GlanceBar.tsx        # kernel dot, google status, unread count, active tasks
    ErrorToast.tsx
  screens/
    Home.tsx             # orb + thread + composer (THE app)
    Tasks.tsx  Memory.tsx  Automations.tsx  Research.tsx  Packs.tsx   # thin utility screens
  settings.ts            # voice prefs, auto-speak, hands-free, wake behavior
```

Routing: Home is `/`; utility screens under a collapsible left rail (icons only). 90% of life happens on Home.

## §3 — Home layout (the one screen that matters)

- **Center-top: the Orb** — a breathing gradient sphere that IS the app's face (states in §5). Clicking it = push-to-talk toggle. Space bar = hold-to-talk (keyup stops). 
- Under the orb: **live status line** — "Listening…", "Heard: *what's on my plate today*", "Thinking…", "Speaking — tap to interrupt", or empty when idle.
- Below: **TranscriptThread** — the conversation, newest at bottom, auto-scroll; user bubbles right, assistant left; approval cards inline in-flow (amber, §6). Assistant messages get a small 🔊 replay button.
- Bottom: **Composer** — a slim text input ("or type…"), mic button mirroring orb state, Send.
- Top bar: GlanceBar (● kernel, Google account chip, ⏳ n pending, 🕘 sessions button).
- Session drawer slides from left; "＋ New chat" is prominent (voice command "new chat" also works — see §8 client-side intents).

## §4 — The voice state machine (the heart — implement exactly)

States: `idle → arming → listening → transcribing → thinking → speaking → idle`, plus parallel flag `awaitingApproval`.

- **idle**: orb slow-breathes. Enter listening via: orb click, mic button, holding Space, or (hands-free mode) automatically after speech ends.
- **arming**: `getUserMedia` permission moment; if denied → toast with fix instructions, back to idle.
- **listening**: MediaRecorder running (webm/opus). Orb pulses with real mic amplitude (AnalyserNode). Auto-stop at 60s. In v1 stop = click/keyup; in v1.5 add VAD auto-stop: ~1.2s of RMS below threshold ends the recording (tunable in settings).
- **transcribing**: blob ≥3KB → `POST /api/voice/transcribe`; blob <3KB → discard, toast "didn't catch that". On `{ text }`: **render the transcript as the user's bubble immediately**, then → thinking. Empty text → toast, idle.
- **thinking**: fire `POST /api/chat { text, sessionId }` (don't await for UI); poller owns rendering. Orb spins slowly. New assistant message arrives → speaking (if auto-speak on).
- **speaking**: `speechSynthesis.speak()` of the assistant reply — **strip markdown, code blocks, URLs (say "link"), and citation brackets before speaking**. Orb ripples outward. **Barge-in: any click on the orb or Space press CANCELS speech instantly and starts listening** — interruption must always win.
- **hands-free mode** (settings toggle, default off in v1): after speaking ends, auto-return to listening; exit by saying "stop listening" or pressing Esc.
- Every transition plays a **subtle earcon** (2 short synthesized blips ≤120ms via WebAudio — listen-start, listen-stop; no audio files needed).

## §5 — The Orb (design centerpiece)

- ~180px circle, radial gradient `#4b78ff → #7aa2ff → transparent`, soft outer glow; on `#0c0d14` background.
- idle: 4s breathing scale (1.00→1.04). listening: glow shifts teal `#2dd4bf`, ring pulses with mic level. transcribing: quick shimmer sweep. thinking: slow internal orbit of 2–3 light particles. speaking: concentric ripples synced to a ~300ms tick. awaitingApproval: the orb dims and an **amber halo** (`#f2c14e`) appears — the eye goes to the card.
- Reduced-motion media query: swap animations for opacity fades.

## §6 — Approval cards (the trust surface — pixel-serious)

Rendered inline in the thread whenever `pendingActions` is non-empty, and mirrored as a compact chip in GlanceBar.

```
⏳  WAITING FOR YOUR APPROVAL — nothing has happened yet
    Send WhatsApp to Sanju Goud: "I'll be late, start without me"
    [⚠ shown ONLY if untrusted_context=true: "This task read external
     content (email/web) before proposing this — review carefully."]
    [ ✓ Approve & run ]   [ ✕ Cancel ]
```

- Humanize per tool: `whatsapp_send_message` → `Send WhatsApp to {chatId}: “{text}”` · `calendar_create_event` → `Create event “{summary}”, {start}–{end}` · `gmail_create_draft` → `Draft email to {to}: “{subject}”` · unknown tool → `{tool}({args JSON, truncated})`.
- Approve → `POST /api/pending/:id/decide {decision:'approved'}`; Cancel → `'rejected'`. Optimistically remove the card; on 409 just drop it (someone already decided). The result message ("✅ Done…" / "❌ Cancelled…") arrives via the poller.
- Amber border `#6b551f`, bg `#231b0c`, headline `#f2c14e`. Never auto-dismiss.

## §7 — Voice approval (the flagship voice feature — follow these rules exactly)

When a new pendingAction appears and auto-speak is on:
1. TTS reads it **verbatim**: "Waiting for your approval: send WhatsApp to Sanju Goud, saying: I'll be late, start without me. Say approve, or cancel."
2. The app enters a **20-second approval-listening window** (auto-opens the mic, distinct purple ring on the orb).
3. The decision transcript is matched with a **strict whitelist**, whole-utterance only: `approve|approved|yes send it|send it|confirm` → approve; `cancel|reject|no|stop|don't send` → cancel. **Anything else is treated as a normal chat message** (falls through to /chat) and the card stays.
4. Window expires → normal idle; card remains for manual click. Multiple pending cards → read and decide one at a time, oldest first.
5. Never voice-approve without having read the FULL exact content aloud in the same breath. The visual card stays on screen the whole time. (These rules keep the human-sees-exact-action guarantee intact.)

## §8 — Client-side voice intents (no backend call needed)

Match these on the transcript BEFORE sending to /chat (exact-ish, case-insensitive):
- "new chat" / "start a new chat" → create session, switch, say "Fresh chat."
- "stop" / "stop talking" → cancel TTS.
- "stop listening" → exit hands-free.
- "read that again" / "repeat" → re-speak last assistant message.
- "open tasks / memory / automations" → navigate.
Everything else → `/chat` untouched (the backend owns real intelligence — do NOT build command parsing beyond this tiny list).

## §9 — Error & edge UX (voice-first means audible errors)

| Case | UX |
|---|---|
| mic permission denied | toast + card with browser instructions; orb shows 🚫 microbadge |
| transcribe 4xx/5xx | toast "Transcription hiccup — try again"; if auto-speak, say it too |
| reply contains "rate-limited" | speak: "The model is rate-limited, try again in a minute." |
| kernel unreachable (health fails) | GlanceBar dot red; orb greys out; queue nothing |
| stale approval (409) | silently drop card, refresh |
| TTS voice unavailable | fall back to default voice, log once |
| tab backgrounded | pause hands-free loop; resume on focus |

## §10 — Performance & polish

- Poll `/api/messages` every 3.5s (skip while a transcription is in flight); `/api/health` every 10s; pause all polling when tab hidden.
- Debounce localStorage writes; memoize thread rows; virtualize the thread only if >200 messages.
- Keyboard map: Space hold-to-talk (when composer unfocused) · Enter send · Esc cancel speech/hands-free · `n` new chat.
- Typography: Inter or system-ui; 14px body, 1.55 line height; text `#e6e8f0`, muted `#9aa0b5`; surfaces `#12141f` with `#23263a` borders; user bubbles `#1d2c55`/`#2c3f75`.
- Every state change ≤200ms visual response, even while awaiting network (optimism + skeletons).

## §11 — Milestones (build in this order)

- **M1 (core, must fully work in mock mode):** Home screen — orb, push-to-talk → transcribe → chat → spoken reply, thread, approval cards with click approve/cancel, sessions drawer, composer fallback, settings (auto-speak, voice, rate), error toasts.
- **M2:** voice approval window (§7), client intents (§8), hands-free VAD loop, earcons, replay buttons, glance bar chips, Tasks + Memory screens.
- **M3 (future-facing stubs are fine):** wake word ("hey OS") via Porcupine WASM behind a settings flag; barge-in refinement; multilingual STT toggle (backend accepts `AIOS_STT_LANGUAGE`, UI just exposes the preference for later); streaming/partial transcript UI treatment; a Tauri wrapper note for a global OS hotkey; PWA manifest for phone-on-same-network use (document that the API is loopback-only — remote use would need Tailscale, out of scope).

## §12 — Acceptance checklist (self-verify before done)

- [ ] Mock mode demos the ENTIRE loop in cloud preview, including a scripted pendingAction appearing 5s in.
- [ ] Real mode works with only the Vite proxy config against `127.0.0.1:4000`.
- [ ] Speak "what's on my plate today" → transcript bubble appears < 1.5s after stop → reply speaks aloud.
- [ ] A WhatsApp-send request produces the amber card; voice "approve" decides it; gibberish during the window becomes a normal chat message and the card SURVIVES.
- [ ] Barge-in: clicking the orb mid-speech stops audio in <100ms and starts listening.
- [ ] Nothing ever auto-approves; 409s handled; no fetch goes to `:4000` directly; no console errors through a full session.
