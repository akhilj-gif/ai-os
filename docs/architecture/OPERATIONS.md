# Applications & Operations — process model, HTTP API, interfaces, runbook, configuration, model router

> Scope: how the OS actually runs. Six pm2 processes, three Docker services, one
> Fastify gateway with 72 routes, four user-facing interfaces, and the lifecycle
> scripts that start/stop/heal/back up the stack. Everything here was read out of
> the source; where a design doc disagrees, see the `staleDocs` list.

## 1. The process model

The stack is two layers: **Docker** (stateful infra) and **pm2** (the Node
services). `pnpm os:up` brings up the first, migrates, then hands the second to
pm2. Everything binds `127.0.0.1` — nothing is reachable from the LAN.

### pm2 apps — `ecosystem.config.cjs`

| pm2 name | Port | Script | Runs as | Depends on |
|---|---|---|---|---|
| `ai-os-api` | **4000** | `apps/api/src/server.ts` | `node --import tsx` | Postgres, Redis (health ping only), Langfuse (optional), whatsapp-bridge :4100, browser-bridge :4200, model providers |
| `ai-os-bridge` | **4100** | `apps/whatsapp-bridge/src/index.ts` | `node --import tsx` | WhatsApp servers, `apps/whatsapp-bridge/.auth/` + `store.json`. No DB. |
| `ai-os-web` | **3000** | `apps/web/node_modules/next/dist/bin/next dev -p 3000 -H 127.0.0.1` | `node` | `ai-os-api` (through its own `/api` proxy route) |
| `ai-os-browser` | **4200** | `apps/browser-bridge/src/index.ts` | `node --import tsx` | Chromium + `apps/browser-bridge/.userdata/`. No DB. |
| `ai-os-supervisor` | — | `scripts/supervisor.ts --loop` | `node --import tsx` | pm2 daemon, Docker daemon, `:4000/health`, `:4100/health` |
| `ai-os-voice` | **3001** | `apps/voice/node_modules/vite/bin/vite.js --port=3001 --host=127.0.0.1` | `node` | `ai-os-api` (Vite `/api` proxy, target hard-coded to `http://127.0.0.1:4000`) |

Shared pm2 policy (`common`, `ecosystem.config.cjs:31-41`): `autorestart`,
`max_restarts: 10` within `min_uptime: 10s`, `restart_delay: 3s`,
`kill_timeout: 8s`, timestamped logs.

**Secret fan-out.** `ecosystem.config.cjs:17-29` parses `AIOS_API_TOKEN` and
`BROWSER_BRIDGE_TOKEN` straight out of the root `.env` with a hand-rolled line
reader (no dotenv — this file executes at `pm2 start` time) and injects them into
every app's `env`. This exists because **the Next and Vite dev servers never load
`.env` themselves** — they run under their own cwd, and their proxies need the
API token to authenticate server-side. The api/bridges do call
`dotenv.config()` on the workspace-root `.env` and see everything.

Two apps override `env` wholesale rather than extending it (object-spread order:
`{...common, env: {...}}` replaces `common.env`), so they re-list both tokens:

- `ai-os-browser`: `+ BROWSER_HEADLESS=1, BROWSER_BRIDGE_PORT=4200`
- `ai-os-supervisor`: `+ AIOS_SUPERVISOR_POLL_MS=600000` — **10 min**, overriding
  the script's own 180 s default (`scripts/supervisor.ts:207`).

**Why the supervisor lives under pm2 and not Task Scheduler** — the comment at
`ecosystem.config.cjs:89-101` records the measured reasons: (1) pm2 spawns it
detached with no console, so it never flashes a `cmd`/`conhost` window every few
minutes; (2) a Task Scheduler action running `wscript` reported *Last Result 0
while doing no work* — a false green, the exact bug class the supervisor exists
to catch. Stated honest limitation: it **cannot resurrect the pm2 daemon itself**,
so after a sleep/reboot that kills pm2, `pnpm os:up` must be run once by hand.

### Docker services — `infra/docker-compose.yml` (compose project `ai-os`)

| Service | Container | Published | Image | Notes |
|---|---|---|---|---|
| `postgres` | `ai-os-postgres-1` | `127.0.0.1:5432:5432` | `pgvector/pgvector:pg16` | Named volume `pgdata`; `./initdb` seeds `00-create-langfuse-db.sql`. Healthcheck `pg_isready`. The `127.0.0.1` prefix is deliberate — without it Docker publishes on `0.0.0.0` and a dev-password DB holding `oauth_tokens` + cached mail/WhatsApp is LAN-reachable (audit finding 2026-07-09). |
| `redis` | `ai-os-redis-1` | `127.0.0.1:6379:6379` | `redis:7-alpine` | No auth — loopback only by construction. |
| `langfuse` | `ai-os-langfuse-1` | `127.0.0.1:3030:3000` | `langfuse/langfuse:2` | Shares the Postgres instance (`langfuse` DB). Headless-initialised with dev keys `pk-lf-aios-dev` / `sk-lf-aios-dev` that are committed in the compose file — hence loopback-only. `depends_on: postgres healthy`. |

```mermaid
flowchart LR
  subgraph browser["Browser (loopback)"]
    B1[":3000 Next dashboard"]
    B2[":3001 Vite voice UI"]
  end
  subgraph pm2["pm2"]
    API["ai-os-api :4000"]
    WA["ai-os-bridge :4100"]
    BB["ai-os-browser :4200"]
    SUP["ai-os-supervisor"]
  end
  subgraph docker["Docker (127.0.0.1)"]
    PG[("postgres :5432")]
    RD[("redis :6379")]
    LF["langfuse :3030"]
  end
  B1 -- "/api/* + x-aios-token" --> API
  B2 -- "/api/* + x-aios-token" --> API
  API --> PG
  API -. "health ping only" .-> RD
  API -. traces .-> LF
  API -- "x-bridge-token" --> WA
  API -- "x-bridge-token" --> BB
  SUP --> API
  SUP --> WA
  SUP -- "pnpm os:up" --> pm2
```

### What `ai-os-api` starts at boot

Everything below runs inside the single `server.ts` process, after
`app.listen({ port, host: '127.0.0.1' })`:

| Loop | Cadence | Kill switch | Source |
|---|---|---|---|
| Boot orphan-resume — every `running`/`planning` task from the previous life | once, at boot, concurrent fire-and-forget | — | `server.ts:1828-1831`, `resumeTaskById` at `:1727` |
| Scheduler heartbeat (durable jobs, zombie reaping) | `SCHEDULER_POLL_MS`, default 30 s | — | `server.ts:1836`, `kernel/scheduler.ts:252` |
| Coordinator (stuck tasks, provider health, approval backlog, job streaks) | `COORDINATOR_POLL_MS`, default 60 s | `AIOS_COORDINATOR=off`; `AIOS_COORDINATOR_AUTORESUME=off` keeps watching but never resumes | `server.ts:1850-1862`, `kernel/coordinator.ts:273` |
| WhatsApp remote control (poll self-chat for `@os …`) | `AIOS_WA_POLL_MS`, default 12 s, with an in-flight latch | `AIOS_WA_REMOTE=off` | `server.ts:1872-1976` |
| Standing-goal advance (read-only, autopilot-gated) | `AIOS_STANDING_POLL_MS`, default 30 min | `AIOS_STANDING=off` | `server.ts:1982-1993` |
| Proactive WhatsApp delivery of notifications | `AIOS_PROACTIVE_POLL_MS`, default 5 min | `AIOS_PROACTIVE=off` | `server.ts:1997-2007` |
| Screen-watch perception (hash-diff gated) | `AIOS_SCREEN_WATCH_MS`, default 90 s | `AIOS_SCREEN_WATCH=off`; also DB setting `screen_watch` | `server.ts:2012-2022` |

Also at boot, before `listen`: `loadEnabledPacks(pool)` composes the tool surface
(`:1794`), the two meta-tool policies are upserted idempotently
(`pack_forge`=write/auto, `pack_install`=irreversible/never-auto, `:1799-1803`),
and a fire-and-forget **provider pre-warm** issues a 1-token `ping` per capability
bucket to pay DNS+TLS cost off the first real request (`:1809-1820`).

Stay-up guards: `unhandledRejection` / `uncaughtException` **log and never exit**
(`server.ts:1825-1826`) — one rejected background promise must not take down the
gateway. Both bridges do the same.

---

## 2. HTTP API reference — `apps/api/src/server.ts`

Base `http://127.0.0.1:4000`. Fastify, `bodyLimit: 20 MB` (chat attachments are
base64 JSON, well over the 1 MB default, `:112`). A raw `audio/*` content-type
parser is registered separately at 25 MB to match Groq's Whisper cap (`:606`).

### Cross-cutting request pipeline (`onRequest`, `:157-193`)

1. **Trace id** — from `x-trace-id` or freshly minted; echoed as the `x-trace-id`
   response header; a `http.request` trace event is recorded for *every* request.
   This is the tracing invariant.
2. **Rate limit** — coarse per-IP bucket, 1500 requests / 10 s → `429`. Runs
   *before* auth so unauthenticated floods are capped too. Loopback means this is
   effectively one bucket; it only trips on a runaway caller.
3. **Auth** — `x-aios-token` must equal `AIOS_API_TOKEN`, compared with
   `timingSafeEqualStr`. Failure → `401` plus a `http.unauthorized` trace event.
   - If `AIOS_API_TOKEN` is unset/blank, the API **fails open** and logs one loud
     `SECURITY:` warning (`:178-186`) — a fresh install isn't bricked, but it is
     never silently insecure.
   - **Auth-exempt: exactly five paths** — `/health` and the four OAuth routes a
     browser navigates to directly (`/oauth/google`, `/oauth/google/callback`,
     `/oauth/uber`, `/oauth/uber/callback`), held in an explicit `Set`
     (`:136`). The comment there records why a `startsWith('/oauth/')` prefix was
     wrong: it also exempted `/oauth/google/status`, leaking the connected
     account's email + granted scopes to any unauthenticated local caller.

**Error envelope** (`setErrorHandler`, `:150-155`): any uncaught throw becomes
`{ error, traceId }`. A thrown error carrying a 4xx/5xx `statusCode` keeps it;
everything else becomes a clean `500 "internal error"` so raw `pg` text never
leaks.

In the tables below, **Exempt** = skips the token check; **Mutates** = changes
domain state (every request writes a `trace_events` row regardless).

### Health, system, OAuth

| Method / path | Purpose | Exempt | Mutates |
|---|---|---|---|
| `GET /health` | Ping Postgres + Redis + Langfuse; `{ ok, milestone, services }`. `ok` requires postgres **and** redis ok. | ✅ | – |
| `GET /system/models` | Provider failover chain + resolved model ids per role. Names only, never key material. | – | – |
| `POST /hello` | M0 smoke: `runHelloWorldTask`. | – | ✅ (creates a task) |
| `GET /oauth/google` | Redirect to Google consent; mints a CSRF `state` into an in-memory `Set`. Scopes: openid, userinfo.email, gmail.readonly, gmail.compose, calendar.readonly, **calendar.events** (not the broad `calendar` scope — least privilege). | ✅ | ✅ (in-memory state) |
| `GET /oauth/google/callback` | Exchange code → upsert `oauth_tokens`; email parsed from the `id_token` payload. Redirects to `http://localhost:3000/?google=connected`. | ✅ | ✅ |
| `GET /oauth/google/status` | `{ connected, email, scopes }`. | – | – |
| `GET /oauth/uber` | Uber consent redirect; `400` if `uberConfigured()` is false. | ✅ | ✅ |
| `GET /oauth/uber/callback` | `exchangeUberCode`; `502` on failure. | ✅ | ✅ |
| `GET /oauth/uber/status` | `{ connected, configured }`. | – | – |

> A refresh token issued under the **old** scope list does not gain
> `calendar.events` automatically — the user must re-run `/oauth/google`
> (`server.ts:256-259`).

### Chat, voice, sessions

| Method / path | Purpose | Mutates |
|---|---|---|
| `POST /chat` | The main entry. `{ text?, sessionId?, agentMode?, attachments? }`. Creates a task, appends the user message, runs `completeChatTask`, returns `{ sessionId, taskId, reply }`. `400` if neither text nor an attachment. An unknown `sessionId` silently falls back to the default session (a bad id used to FK-violate and 500). | ✅ |
| `POST /voice/transcribe` | Raw `audio/*` bytes → Whisper text. `502` on failure, with a distinct message for `INFRA_RATELIMIT`. | – |
| `POST /voice/speak` | `{ text }` → WAV audio bytes. `502` on failure and the UI falls back to browser `speechSynthesis`. | – |
| `GET /messages?sessionId=` | Thread **plus** that session's `pending_actions`, so approvals render inline in chat. | – |
| `POST /sessions` | New session (`title` defaults to `"New chat"`). | ✅ |
| `GET /sessions` | Last 100 sessions with `message_count` + `first_message` (used as the label — a title is never asked for). | – |
| `DELETE /sessions/:id` | Delete; messages cascade. `404` if absent. | ✅ |

`completeChatTask` (`:393-477`) is the chat brain:

- Replays the last **12** user/assistant turns, each truncated to **500 chars**
  (`CHAT_HISTORY_TURNS` / `CHAT_HISTORY_MSG_CHARS`). The truncation exists because
  one pasted wall of text pushed the prompt past Groq's free-tier TPM cap and the
  chat "hung" inside the rate-limit retry loop for minutes — dogfooded on a
  102-message session.
- `agentMode: 'auto'` runs `classifyGoal` **in parallel** with
  `assembleMemoryContext` (they are independent; running them serially was the
  original latency bug) and forwards `memory.untrusted` alongside the block — the
  comment at `:442-445` notes this is exactly the path that would otherwise drop
  the taint latch. `'force'` → `runAgentTask`; `'off'` → plain `runTask` with no
  memory prefetch (used by boot-resume, which has its own checkpoint).
- Fires two best-effort background writes: `recordExperience` (episodic/failure
  memory) and `updateKnowledgeGraph` (kg nodes/edges). Neither may hold up the
  reply.

**Attachments and vision** (`:479-554`): images go through `describeImages`
(Gemini) with a thorough OCR/table/chart instruction; non-image files are decoded
as UTF-8 and truncated to 8000 chars. The digest becomes the task's goal text, so
the text-only executor needs no changes. A per-session `RECENT_IMAGES` cache
(20 min TTL) lets a follow-up re-run vision on the same image — but only when the
follow-up matches `VISUAL_REF_RE`, a deliberately precise regex requiring a visual
noun or a spatial/zoom verb, never bare "it/this".

### Memory & cognition

| Method / path | Purpose | Mutates |
|---|---|---|
| `GET /memory?includeSuperseded=` | List memory records. | – |
| `GET /memory/search?q=&type=` | Semantic recall; **degrades to `ILIKE` keyword match** when embeddings are unavailable, returning `mode: 'keyword (embeddings unavailable)'`. Search must never be down. | – |
| `DELETE /memory/:id` | Delete a memory (`{ deleted }`, `404` if absent). | ✅ |
| `GET /memory/analytics` | Dashboard snapshot. | – |
| `GET /cognition/briefing?refresh=1` | Forward-looking briefing (predictions / suggestions / questions). **10-minute in-process cache** because it is an LLM call and must not fire on every page load. | – |
| `POST /cognition/consolidate` | Synthesise experience into generalized insights; invalidates the briefing cache. | ✅ |
| `POST /cognition/autopilot` | Run one autopilot cycle now. | ✅ |

### Autonomy — settings, governor, standing goals, perception

| Method / path | Purpose | Mutates |
|---|---|---|
| `GET /settings` | All `os_settings` rows as a flat object. | – |
| `PUT /settings/:key` | Set one key (`{ value }` string). No key allowlist. | ✅ |
| `GET /governor` | `{ used, max, ok }` — today's unattended-task count vs the ceiling. | – |
| `GET /standing` | Standing goals. | – |
| `POST /standing` | Create; `cadenceMinutes` clamped to `>= 30`, default 360. | ✅ |
| `PATCH /standing/:id` | `status` ∈ `active|paused|done`. | ✅ |
| `POST /standing/:id/advance` | Advance one goal **now** — user-initiated, so it ignores cadence and the autopilot gate. `404` if absent. | ✅ |
| `POST /notifications/deliver` | Push undelivered notifications to the WhatsApp self-chat. | ✅ |
| `POST /perception/screen-watch` | Force one screen capture + vision analysis, ignoring the `screen_watch` setting. | ✅ (writes a notification) |

**The autonomy governor** (`:760-769`) is the one hard ceiling on unattended
activity: `count(tasks WHERE created_by='trigger' AND created_at::date = today)`
against `os_settings.autonomy_daily_max` (default **20**; `0` is valid and pauses
all autonomy). Checked before every autopilot cycle and before advancing standing
goals. The user's own requests are never counted or capped.

`autopilot` has three values: `off`, `read` (executor refuses any
mutate/send/spend), `propose` (writes queue as pending approvals). A cycle takes
the top **2** actionable briefing suggestions, runs each as a `created_by='trigger'`
task, and writes one summary notification.

`screenWatchTick` (`:912-929`) SHA-256s the frame and only spends a vision call
when the hash actually changes — baseline and unchanged frames cost nothing.

### Trust

| Method / path | Purpose | Mutates |
|---|---|---|
| `GET /trust/ladder` | Per-tool approvals/rejections + `promotable` flag; `threshold: 3`. | – |
| `POST /trust/promote` | Set `auto_approve=true` for a tool. `400` for `spend`; `400` unless `hasEarnedTrust` passes; `404` for an unknown tool. | ✅ |
| `POST /trust/demote` | `auto_approve=false`. Always `200`. | ✅ |
| `GET /policies` | All `trust_policies`. | – |
| `PUT /policies/:tool` | Set `trustClass` and/or `autoApprove`. `404` if no such policy row. | ✅ |
| `POST /pending/:id/decide` | `{ decision: 'approved'|'rejected' }`. Executes the exact queued call via the pack registry, posts a confirmation line into chat, resolves the task. | ✅ |

`hasEarnedTrust` (`:948-961`) is the **single** earned-trust check: ≥3 approvals
with **zero** rejections. It is shared by `/trust/promote` and `PUT /policies/:tool`
because the two previously disagreed — `/trust/promote` didn't check it at all,
and the raw policy endpoint had no concept of it, so setting `auto_approve` on an
irreversible tool bypassed earned trust entirely (2026-08-12 sharp-edges hunt).

`PUT /policies/:tool` evaluates the **effective resulting state**, not just this
call's fields (`:1629-1640`). That matters because the real Settings UI issues one
PUT per control: toggle auto-approve on while the tool is `write` (legal), then
reclassify to `irreversible`/`spend` with a second PUT that omits `autoApprove`.
Falling back to the stored value is what makes the second call still get checked.
Migration `0025_trust_invariant.sql` backstops the `spend` case with a DB CHECK
constraint regardless of code path.

`decidePendingAction` (`:1173-1222`) is one fail-closed implementation behind two
surfaces (HTTP and the WhatsApp `@os approve <id>` channel). Only a still-`pending`
row can be acted on — no double-send. On failure it unwraps nested JSON-in-JSON
bridge errors to surface the innermost human-readable message, because the chat
once rendered `⚠ whatsapp_send_message failed: {"error":"whatsapp bridge 500:
{\"statusCode\":500,…}"}`.

### Tasks, planner, research, code

| Method / path | Purpose | Mutates |
|---|---|---|
| `POST /plan` | `planAndStart` on `{ text }`. | ✅ |
| `GET /tasks` | Last 50 tasks incl. `parent_task_id` for the M11 tree view. | – |
| `GET /tasks/:id` | Task + steps + specialist children. `404` if absent. | – |
| `GET /tasks/:id/trace` | Task + `tool_calls` (joined to steps) + up to 500 `trace_events`. | – |
| `POST /tasks/:id/pause` | `pauseTask`. **Always `200 {ok:true}`** — no existence check. | ✅ |
| `POST /tasks/:id/resume` | `resumeTask` → `runGraph`. | ✅ |
| `POST /tasks/:id/redirect` | Store a `pending_directive`. **Always `200`.** | ✅ |
| `POST /tasks/:id/approve` | Graph-step approval: `{ stepId, decision, note? }`. | ✅ |
| `POST /research` | `runResearch` — cited report over fetched sources. | ✅ |
| `GET /research` / `GET /research/:id` | List (50) / fetch one. `404` on miss. | – |
| `POST /code` | TDD fix loop in the Docker sandbox. `maxRounds` **clamped to 1–6** — unbounded rounds meant unbounded sandbox spawns + planning-tier LLM calls from one request. The mutating `commitApproved` step is deliberately a library call, never exposed over HTTP. | ✅ |

### Jobs & notifications

| Method / path | Purpose | Mutates |
|---|---|---|
| `GET /jobs` | Jobs with their most recent `job_runs` row inlined. | – |
| `POST /jobs` | Create. `kind` ∈ `briefing | watch | reflect | act | learn`. `watch` requires `payload.url` (http/https); `act` requires `payload.goal`. | ✅ |
| `PUT /jobs/:id` | `{ enabled: boolean }` only. `404` if absent. | ✅ |
| `DELETE /jobs/:id` | Delete. `404` if absent. | ✅ |
| `POST /jobs/:id/run-now` | Sets `next_run_at=now()` then calls `tick()` — which runs **every due job**, not just this one — and returns the tick report plus this job's last run. `404` if not found *or* not enabled. | ✅ |
| `GET /notifications?unread=1` | Last 50. | – |
| `POST /notifications/:id/read` | Mark read. `404` if absent. | ✅ |

### Packs & the forge

| Method / path | Purpose | Mutates |
|---|---|---|
| `GET /packs` | Installed/available packs. | – |
| `POST /packs/:name/install` | Install a static pack; recomposes the live tool registry. `404` for an unknown name. | ✅ |
| `PUT /packs/:name` | `{ enabled }`; recomposes. `404` if not installed. | ✅ |
| `POST /packs/forge` | Forge a new pack from a natural-language request. **Stages inert source only.** `422` on failure. | ✅ (writes staged source) |
| `GET /packs/forge/stream?request=` | Same, as SSE (`draft → verify → rejected → repair → staged`). GET because `EventSource` can only issue GETs and cannot set headers — it reaches the API through the token-injecting UI proxy. `reply.hijack()` + a 15 s `: ping` heartbeat. | ✅ |
| `GET /packs/staged` | Staged (inactive) packs awaiting install. | – |
| `POST /packs/staged/:name/install` | **Activate** a staged pack. `422` on failure. | ✅ |

Two meta-tools are registered directly on the composed registry, not in a pack
(`server.ts:61-99`): `pack_forge` (write-class, auto-approve — staging is inert)
and `pack_install` (irreversible-class, never auto — **the approval card is the
activation gate**). From chat, install always queues an approval; from the UI, the
HTTP endpoint *is* the approval.

### Learning, dashboard, the Mind

| Method / path | Purpose | Mutates |
|---|---|---|
| `GET /improvements` | Last 100 improvements + recent failure signals. | – |
| `POST /learning/run` | Full LLM proposer + gym verifier. `autoAdopt` defaults to **false** over HTTP — propose+verify+queue, adoption stays explicit. | ✅ |
| `POST /improvements/:id/adopt` | Turn the artifact into a procedural memory. `404` unknown; `409` refuses a gym-**rejected** improvement; idempotent if already adopted. | ✅ |
| `GET /dashboard` | One aggregate: graph approvals, chat `pendingActions`, active/recent tasks, notification counts, jobs, token spend today/total, task counts by status. 8 parallel queries. | – |
| `GET /coordinator/status` | `{ enabled, autoResume, lastTick }` — the last in-memory `CoordinatorReport`. | – |
| `GET /mind/graph` | One constellation: ≤90 kg entities + ≤70 memories, cross-linked where a memory's text actually names an entity, plus tag-clusters (max 8). The raw kg is sparse alone; fusing it with memories is what makes one picture. | – |
| `GET /mind/live?taskId=` | Reasoning timeline for a task (defaults to the active or most recent): steps, tool calls (args/result truncated to 220 chars), agent children, plus 8 recent root tasks. | – |

### Known wart: HTTP 200 with a failure in the body

These return `200` while carrying a failure. A caller checking only `res.ok`
cannot tell them from success.

| Route | What arrives as 200 |
|---|---|
| `GET /health` | `{ ok: false, services: { postgres: "error: …" } }` — **always 200**, even with the database down. This is what lets `httpUp()` (and therefore the supervisor's `healthy()`) report a green stack while Postgres is dead. |
| `POST /pending/:id/decide` | Tool threw, or the tool is unavailable because its pack is disabled → `{ ok:false, executed:false, result:{ error } }`. Only `404` (no such action) and `409` (already decided) get real status codes. |
| `POST /research` | `{ status: 'failed', report: <error prose>, sources: [] }` (`kernel/research.ts:57`). |
| `POST /cognition/autopilot` | `{ ran: [], note: 'daily autonomy budget reached (n/m)…' }`. |
| `POST /notifications/deliver` | `{ sent: 0, skipped: 'bridge not paired' | 'disabled' }`. |
| `POST /perception/screen-watch` | `{ analyzed: false, note: 'no capture (no active desktop session?)' }`. |
| `GET /memory/search` | `{ mode: 'keyword (embeddings unavailable)' }` — a deliberate degrade, but silent. |
| `POST /tasks/:id/pause`, `POST /tasks/:id/redirect` | `{ ok: true }` for a task id that does not exist (both are bare `UPDATE`s with no `rowCount` check). |
| `GET /packs/forge/stream` | Headers are written before the work starts, so every failure is a `data: {"phase":"failed","error":…}` frame on a 200 stream. |

---

## 3. The interfaces

Four surfaces reach the same kernel. Two are browser UIs, two are session-owning
bridges.

### Web dashboard — `apps/web`, Next 16, port 3000

| Route | Reads |
|---|---|
| `/` | Chat shell with multi-session support, inline approval cards, voice input, Google-connect banner (`/sessions`, `/messages`, `/chat`, `/pending/:id/decide`, `/voice/transcribe`, `/oauth/google/status`) |
| `/dashboard` | `/dashboard`, decides both graph approvals (`/tasks/:id/approve`) and chat pending actions (`/pending/:id/decide`) |
| `/tasks`, `/tasks/[id]` | `/tasks`, `/plan`, `/tasks/:id`, `/tasks/:id/trace`, pause/resume/redirect |
| `/memory` | `/memory`, `/memory/search`, `/memory/:id` |
| `/automations` | `/jobs`, `/notifications`, run-now, enable/disable, delete |
| `/packs` | `/packs`, install, enable/disable |
| `/research` | `/research`, `/research/:id` |
| `/settings` | `/policies`, `/policies/:tool`, `/system/models` |

### Voice UI — `apps/voice`, Vite + React Router, port 3001

Routes: `/` (Home), `/nexus`, `/forge`, `/mind`, `/new`, `/chats`, `/tasks`,
`/memory`, `/jobs`, `/settings`. It is the richer of the two surfaces: wake-word
and VAD (`src/lib/vad.ts`), an orb, a proactive-voice component, an approval
popup, and the forge streamed live over `EventSource`. All calls go through the
typed client `src/api/client.ts`, which only ever fetches `/api/…` — the kernel
sends no CORS headers by design, so a direct `:4000` call from the page cannot
work.

The voice `Settings` page is the one surface for the autonomy switches:
`autopilot`, `proactive_delivery`, `screen_watch`, `autonomy_daily_max` (all
`os_settings` keys, seeded by migration `0022_os_settings.sql`). The web
`/settings` page covers trust policies and the model chain instead — they do not
overlap.

### Both UI proxies inject the API token server-side

This is the single most security-load-bearing piece of the interface layer.

- **Next**: `apps/web/app/api/[...path]/route.ts` — a catch-all
  GET/POST/PUT/PATCH/DELETE handler that forwards to `AIOS_API_BASE`
  (default `http://localhost:4000`) and sets `x-aios-token` from
  `process.env.AIOS_API_TOKEN` (supplied by pm2). It strips `host` and
  `content-length`, uses `redirect: 'manual'`, and strips `content-encoding` /
  `content-length` from the response.
- **Vite**: `apps/voice/vite.config.ts` — `server.proxy['/api']` rewrites
  `/api/*` → `127.0.0.1:4000/*` and sets the same header in a `proxyReq` hook.

Both are guarded identically, and the guards are an **allowlist**, not a denylist:
the request must have `Sec-Fetch-Site: same-origin` **and** a loopback `Host`
name. The reasoning, recorded in both files from a real browser rig on
2026-08-13:

- Sec-Fetch-Site has four values and three were previously trusted. A page served
  from **any other port on localhost** is a different origin but the *same site*,
  so it sends `same-site` — and drove the API with the admin token on 4 of 4
  vectors (no-cors fetch POST, `img` GET, `sendBeacon`, cross-origin form POST).
  On loopback, "same-site" spans every port and is worth nothing.
- A request with **no** `Sec-Fetch-Site` header was allowed on the reasoning that
  non-browser clients "stay token-gated as before". That was backwards: *this
  proxy gives them the token*, re-opening the exact "any local process can act as
  the user" hole the API token exists to close.
- The loopback-`Host` check kills DNS rebinding: point `evil.example` at
  `127.0.0.1`, have the victim load `http://evil.example:3000/`, and that page's
  fetch to `/api/*` **is** same-origin to the browser. Checking the hostname
  (port-agnostic) pins the request to a name the attacker cannot own.
- An allowlist also disposes of header-shape tricks for free — a duplicated header
  joins to `"cross-site, same-origin"`, which simply is not `'same-origin'`.

Stated limit, from the comment itself: this stops **browser-driven CSRF**, not a
non-browser local process, which can set the header itself — and any process able
to read `.env` already has the token. Both guards are pinned by
`apps/web/proxy-guard-smoke.mts` and `apps/voice/proxy-guard-smoke.mts`, which
assert not merely the status code but **whether the token reached the API**.

The Vite guard runs as a `configureServer` middleware rather than inside the
proxy's `configure` hook, because rejecting there meant `proxyReq.destroy()`,
which logged a full stack trace per blocked request — a remote-triggerable
disk-growth nuisance.

### WhatsApp bridge — `apps/whatsapp-bridge`, port 4100

Baileys (unofficial WhatsApp Web protocol), ADR-0013. **Opt-in**: unofficial
clients violate WhatsApp ToS and carry nonzero ban risk, so pairing is always the
user's explicit act. The bridge owns the session; the OS's trust gate owns the
policy (send = irreversible + approval).

| Method / path | Purpose | Auth |
|---|---|---|
| `GET /` and `GET /qr` | Self-refreshing HTML pairing page rendering the live QR as inline SVG | **exempt** (pre-auth bootstrap) |
| `GET /health` | `{ ok, paired, needsRepair, me, selfChats, impl }` | token |
| `GET /chats?limit=&search=` | Synced chat list with resolved display names (limit capped at 200) | token |
| `GET /contacts?search=` | Full address-book search → sendable phone JIDs (max 50) | token |
| `GET /messages?chatId=&limit=` | Up to 50/chat. `400` no chatId, `404` unknown chat | token |
| `POST /send { chatId, text }` | Send. `503` if unpaired; bare digits are normalised to `…@s.whatsapp.net`; a non-JID gets a usable `400` instead of the opaque 500 Baileys used to throw | token |

Design notes worth carrying:

- `ok` means **ready**, not "listening": `ok = paired && !needsRepair`
  (`index.ts:327`). Reporting `ok:true` while `paired:false` is how an unpaired
  bridge stayed invisible for days (2026-08-09: 14k reconnect lines, every monitor
  green).
- On `DisconnectReason.loggedOut` the bridge **does not die and does not
  reconnect-loop** — it stays up serving cached reads and sets `needsRepair` so
  `pnpm os:status` surfaces "re-pair needed" instead of silence.
- `selfChats` returns **every** id the user's own "message yourself" thread lives
  under (phone JID *and* the privacy `@lid` alias) — a command sent from the phone
  landed in the `@lid` twin and the remote poller never saw it.
- Name resolution bridges `@lid` ↔ phone JID and rejects masked-number "names"
  (`hasLetter`), because an addressbook name must beat a chat title that WhatsApp
  often sets to the bare number.
- `store.json` is a debounced (2 s), atomically-renamed snapshot of the synced
  view — without it every restart would need a fresh QR scan, since WhatsApp only
  pushes full history at link time.
- Blank-token handling: `(process.env.WHATSAPP_BRIDGE_TOKEN ?? '').trim() ||
  undefined` — `.env.example` ships the key with an empty value, and without the
  trim `token && …` short-circuits false so **every** request is accepted.

A deterministic twin, `src/mock.ts`, serves the same contract with fixtures and an
inspectable `/outbox` — nothing leaves the machine.

### Browser bridge — `apps/browser-bridge`, port 4200

One persistent Playwright Chromium behind a tiny contract (ADR-0018). Headless
under pm2 (`BROWSER_HEADLESS=1`); run it headed by hand to sign in to gated sites
— the persistent `.userdata` profile keeps you logged in afterwards. OTP and
CAPTCHA are always the human's manual steps.

| Method / path | Purpose |
|---|---|
| `GET /health` | `{ ok, impl, url, headless }` — **unauthenticated** (liveness only) |
| `POST /navigate {url}` | Absolute http/https only; one automatic retry after 800 ms; `502` if both fail |
| `POST /read` | `body.innerText` (≤20 000 chars) + element snapshot |
| `POST /wait {selector?,text?,state?,timeoutMs?}` | Timeout clamped 500 ms–30 s; `504` on timeout |
| `POST /screenshot` | JPEG q55 as a data URL |
| `POST /find {query}` | Tagged `[data-aios-ref]` matches |
| `POST /act {action,ref,text}` | `click | type | select | key | scroll`; `404` on a stale ref |
| `POST /extract {instruction}` | Page text for downstream extraction |

`navigate`/`read`/`act`/`wait` all return a fresh `elements` snapshot (≤30) so the
model never has to guess at stale refs — **each `/find` re-tags from scratch**, so
a ref from an earlier call may resolve to nothing or the wrong element. All
outbound requests pass `installSsrfGuard(context)` (`ssrf-route.ts`), which covers
**every** http(s) request, not just document loads — pinned by
`ssrf-route-smoke.ts`. Playwright's ANSI-coloured error text is stripped before it
reaches a JSON body.

---

## 4. Operations runbook

### Commands (`package.json`)

| Command | What it does |
|---|---|
| `pnpm os:up` | Cold → running. Health-gated, idempotent. |
| `pnpm os:down` | Stop pm2 apps + `docker compose stop`. **Never removes volumes.** |
| `pnpm os:status` | Read-only green/red across every department. |
| `pnpm os:logs` | `pm2 logs` |
| `pnpm os:watch` | One supervisor pass (`--loop` for the daemon form pm2 runs) |
| `pnpm os:backup` | Postgres dump; `--verify` proves the restore |
| `pnpm os:install-autostart` | Windows Task Scheduler + logon launcher (`--logon`, `--uninstall`) |
| `pnpm db:migrate` | `tsx infra/migrate.ts` |
| `pnpm test` | 19 deterministic smoke suites, no Docker/DB/quota |
| `pnpm eval` | The eval gym (needs a model key) |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | `tsc --noEmit` / ESLint / Prettier |
| `pnpm dev` | api + web only, in parallel, outside pm2 |

### Starting the stack — what `pnpm os:up` actually does

1. **Docker daemon check.** If down, launches Docker Desktop and waits up to
   150 s — *unless* `AIOS_NO_GUI=1`, which the supervisor always sets, because
   Docker Desktop is a windowed app and only an explicit human `os:up` may
   interrupt the user. Bails with a hint about renaming
   `%LOCALAPPDATA%\Docker\run` if it never comes up.
2. `docker compose up -d` in `infra/`.
3. Wait up to 90 s for `pg_isready` **inside the container**.
4. Run migrations (`node --import tsx infra/migrate.ts`, 90 s cap); abort on
   non-zero.
5. `pm2 delete <ecosystem>` then `pm2 start <ecosystem>` — a clean slate each time.
6. **Assert log rotation**: `pm2 install pm2-logrotate` + `pm2 set` for
   `max_size=10M`, `retain=10`, `compress=true`. Both are idempotent. This is
   re-asserted on every `up` because pm2 modules are not repo files and don't
   survive a `pm2 kill`/reinstall — `bridge.log` had reached 42 MB with no
   rotation, an unbounded-disk path to taking down the whole machine, Postgres
   included (2026-08-13 DoS sweep).
7. Health gate: API `/health` (45 s), bridge `/health` (30 s), web (60 s, soft —
   the first Next compile is slow).

### Migrations

Plain SQL, no ORM (ADR-0001). `infra/migrate.ts` applies `infra/migrations/*.sql`
in filename order, **each in its own transaction**, tracked in
`schema_migrations(name, applied_at)`; already-applied files print `skip`. 26
migrations through `0026_working_memory_untrusted.sql`. A failure rolls back that
file and throws. `infra/initdb/` runs only on first volume creation and just
creates the `langfuse` database.

### Tests

`pnpm test` (`scripts/test.ts`) runs 19 suites that need **no Docker, Postgres, or
model quota** — safe in CI and as a fast local gate. Security-critical ones are
called out in the list: `ssrf-smoke`, `trust/smoke` (trust gate + §8.3 injection
defense), `terminal-smoke` (allowlist), `forge-scan-smoke` (16 pinned code-exec
vectors through the Pack Forge AST gate), and the bridge's `ssrf-route-smoke`.

Three groups deliberately live **outside** this runner:

- DB/model-backed suites (memory, scheduler, graph, learning, whatsapp, forge,
  kernel/memory-taint) — run against a live stack.
- The eval gym — `pnpm eval`.
- The two proxy-guard smokes, which **bind ports 4000 and 3001** to stand up a
  fake kernel, so they need the stack **down**:
  `cd apps/web && npx tsx proxy-guard-smoke.mts`,
  `cd apps/voice && npx tsx proxy-guard-smoke.mts`.

### Backups — and how to verify one

Postgres holds 100% of the irreplaceable state: every memory, the knowledge graph,
sessions, tasks, `oauth_tokens`. None of it is reconstructible from the repo.

```
pnpm os:backup             # pg_dump -Fc → $AIOS_BACKUP_DIR, prune to the newest KEEP
pnpm os:backup --verify    # dump, then PROVE it by restoring and comparing row counts
```

- Custom format (`-Fc`) so a single table can be restored selectively.
- Dumps land in `~/AIOS-Backups` by default — **outside the repo by design**: a
  backup inside a gitignored folder in the thing you are backing up is not a
  backup.
- Retention: newest `AIOS_BACKUP_KEEP` (default 7) files matching `aios-*.dump`.
- A dump under 1024 bytes is treated as failure.
- `--verify` drops/creates a scratch database `aios_restore_verify`, **creates the
  `vector` extension before restoring** (the classic pgvector restore trap —
  without it every embedding column fails), restores over stdin, and compares row
  counts for five witness tables: `memory_records`, `tasks`, `kg_nodes`,
  `messages`, `oauth_tokens`. `pg_restore` exits non-zero on benign warnings, so
  the **row-count comparison is the real gate**, not the exit code. The scratch DB
  is dropped either way; any mismatch exits 1 with `RESTORE NOT PROVEN`.

The supervisor triggers `pnpm os:backup` (no `--verify`) at most once per 20 h,
and **only when the stack is healthy** — never a half-broken one.

### Reading logs

`logs/{api,bridge,web,browser-bridge,voice,supervisor}.log` plus `.err.log` twins,
timestamped by pm2, rotated at 10 MB × 10 compressed. `pnpm os:logs` tails them
all. The supervisor additionally appends its own ANSI-stripped lines to
`logs/supervisor.log` and keeps `logs/supervisor-state.json`
(`{ attempts[], lastBackup }`) and `logs/supervisor.lock`.

### What the supervisor does

One idempotent `tick()` (`scripts/supervisor.ts:160-204`), every 10 min under pm2:

1. **`assertInstalled()`** — if `scripts/aios-autostart.vbs` exists (i.e. autostart
   was installed on purpose) but the `AI-OS-Supervisor` scheduled task is gone,
   reinstall it. A deliberate `--uninstall` removes the shim too, so it stays
   uninstalled. Disable with `AIOS_SUPERVISOR_SELFHEAL=off`.
2. **`reportNeedsHuman()`** — things a restart cannot fix are reported *loudly on
   every pass* rather than silently looping recovery: an unpaired or
   `needsRepair` WhatsApp bridge needs a QR re-scan at
   `http://127.0.0.1:4100/qr`. This is the gap that let the bridge sit unpaired
   for days while every monitor said "healthy".
3. **`healthy()`** — `GET :4000/health` responds **and** all five of
   `ai-os-api`, `ai-os-bridge`, `ai-os-web`, `ai-os-browser`, `ai-os-voice` are
   `online` in `pm2 jlist`. If healthy: log, run `backupIfDue()`, done.
4. **Recovery, budgeted.** A lock file younger than 5 min means another recovery
   is running — skip. If the Docker daemon is down it **refuses to launch Docker
   Desktop** (that would pop a window in the user's face) and reports. Otherwise:
   at most **3 recoveries per rolling hour**; past that it backs off and tells the
   human to run `pnpm os:up` and read `logs/api.err.log`. The rationale is
   explicit: *thrashing is worse than being down*.
5. **Alert.** Still unhealthy after recovery → a best-effort WhatsApp self-chat
   message via the bridge, which is pm2-supervised independently and may be alive
   even when the API is not. Note the bridge uses its **own** secret
   (`x-bridge-token`), not the API token — sending the wrong one previously made
   every supervisor bridge call 401 and silently disabled this path.

---

## 5. Configuration

All variables live in the workspace-root `.env`. `apps/api`,
`apps/whatsapp-bridge` and `apps/browser-bridge` each `dotenv.config()` it
explicitly by URL so they work regardless of cwd. The web/voice dev servers
**do not** read it — they only see what `ecosystem.config.cjs` injects.

### Required

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string. Matches compose: `postgresql://postgres:aios@localhost:5432/aios`. Without it every query fails. |
| `AIOS_API_TOKEN` | *(unset ⇒ fail-open)* | The API shared secret. **Unset means every endpoint is unauthenticated**, with one loud warning. Also fanned out to the UI proxies by pm2. |
| *one model key* | — | At least one of `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `GROQ_API_KEY`, or the router throws `No model provider configured`. |

### Core runtime

| Variable | Default | Notes |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Read once. Its **only** consumer in the whole codebase is the `/health` ping — yet `ok` is false without it. |
| `API_PORT` | `4000` | API listen port (loopback only). |
| `AIOS_TZ` | `Asia/Kolkata` | "Today" semantics for calendar defaults and the system-prompt clock. |
| `AIOS_API_BASE` | `http://localhost:4000` | Upstream for the Next proxy only. Never set by pm2. |
| `AIOS_CONTEXT_TOKEN_BUDGET` | `6400` | Executor context budget. |
| `AIOS_AGENT_CONCURRENCY` | (engine default) | Ceiling on parallel specialist agents. |
| `SCHEDULER_POLL_MS` | `30000` | Job scheduler tick. |
| `COORDINATOR_POLL_MS` | `60000` | Coordinator tick. |
| `AIOS_WORKSPACES_DIR` | `<cwd>/workspaces` | Workspace tool root. |
| `AIOS_DYNAMIC_PACKS_DIR` | `<cwd>/packs-dynamic` | Where forged packs are staged/installed. |
| `SANDBOX_MEMORY` / `SANDBOX_CPUS` | `512m` / `1` | Docker code-sandbox limits. |

### Model providers & routing

| Variable | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Premium tier; wins unconditionally when set. |
| `XAI_API_KEY` | Premium; Anthropic-SDK-compatible, `https://api.x.ai`. |
| `GEMINI_API_KEY` | Free tier via the OpenAI-compatible endpoint. **Also mandatory** for embeddings, vision and video regardless of routing. |
| `GEMINI_API_KEY_FALLBACK` | Second Gemini key; rotated onto 429s. |
| `GROQ_API_KEY` | OpenAI-compatible. **Also mandatory** for STT (Whisper) and TTS (Orpheus). |
| `NVIDIA_API_KEY` | NVIDIA NIM, `https://integrate.api.nvidia.com/v1`. |
| `MODEL_PROVIDER` | Force one provider (`anthropic|xai|gemini|nvidia|groq`). **Pins a single-element chain — no failover, capability ignored.** Throws at resolve time if that provider's key is missing. |
| `MODEL_ROUTING` / `MODEL_EXECUTION` / `MODEL_PLANNING` | Per-role model-id overrides. Apply to the **primary provider only**. |
| `MODEL_TTS` | Default `canopylabs/orpheus-v1-english`. |
| `MODEL_VIDEO` | Default `gemini-2.5-flash`. |
| `AIOS_TTS_VOICE` | Default `autumn`. Orpheus serves only `autumn diana hannah austin daniel troy` and 400s on anything else — the old default `tara` was retired. |
| `AIOS_STT_LANGUAGE` | Default `en`; `auto` omits the language param. Pinned because short accented clips made Whisper's auto-detect transcribe English commands as Tamil and Icelandic. |

### Observability

`LANGFUSE_HOST` (default `http://localhost:3030`), `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`. Tracing is **entirely optional** — if either key is
missing, `getLangfuse()` returns `null` and every span call is a no-op via
optional chaining.

### Integrations

| Variable | Notes |
|---|---|
| `GOOGLE_CLIENT_ID` / `_SECRET` / `GOOGLE_REDIRECT_URI` | Gmail + Calendar. Redirect defaults to `http://localhost:4000/oauth/google/callback`. |
| `UBER_CLIENT_ID` / `_SECRET` / `UBER_REDIRECT_URI`, `UBER_API_BASE` | Ride booking (ADR-0017). `uberConfigured()` gates both Uber routes. |
| `WHATSAPP_BRIDGE_URL` | Default `http://127.0.0.1:4100` (used by proactive delivery + WA remote). |
| `WHATSAPP_BRIDGE_TOKEN` | Bridge shared secret. Blank ⇒ bridge is unauthenticated (loud warning). |
| `WHATSAPP_BRIDGE_PORT` | Bridge listen port. |
| `BROWSER_BRIDGE_URL` | Default `http://127.0.0.1:4200`. Unset ⇒ the browser pack falls back to a mock fixture site. |
| `BROWSER_BRIDGE_TOKEN` / `BROWSER_BRIDGE_PORT` / `BROWSER_HEADLESS` / `BROWSER_USER_DATA_DIR` / `AIOS_BROWSER_START_URL` | Browser bridge. |
| `AIOS_BROWSER_ALLOW` / `AIOS_BROWSER_BLOCK` | Comma-separated domain fences for the browser pack. |
| `MOBILITY_BRIDGE_URL` / `_TOKEN`, `AIOS_MOBILITY_WEATHER` | Mobility pack; unset ⇒ sample fares. |
| `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` | X/Twitter; all four required or the pack mocks. |
| `AIOS_TERMINAL_ROOT` | Root the OS may touch (fs tools + terminal cwd). Unset ⇒ the home directory. |
| `AIOS_FFMPEG` / `AIOS_FFPROBE` / `AIOS_YTDLP` | Binary paths for the video pack. |

### Feature kill switches and cadences

`AIOS_AGENTS=off` (multi-agent brain), `AIOS_COORDINATOR=off`,
`AIOS_COORDINATOR_AUTORESUME=off`, `AIOS_WA_REMOTE=off` + `AIOS_WA_TRIGGER`
(default `@os`) + `AIOS_WA_POLL_MS` (12 s), `AIOS_STANDING=off` +
`AIOS_STANDING_POLL_MS` (30 min), `AIOS_PROACTIVE=off` +
`AIOS_PROACTIVE_POLL_MS` (5 min), `AIOS_SCREEN_WATCH=off` +
`AIOS_SCREEN_WATCH_MS` (90 s).

### Ops-only

`AIOS_NO_GUI=1` (never launch a GUI app — set by the supervisor),
`AIOS_DOCKER_DESKTOP` / `AIOS_DOCKER_BIN` / `AIOS_FFMPEG_DIR` / `AIOS_YTDLP_DIR`
(PATH assembly for the autostart wrapper), `AIOS_SUPERVISOR_POLL_MS`,
`AIOS_SUPERVISOR_SELFHEAL=off`, `AIOS_PG_CONTAINER` / `AIOS_PG_DB` /
`AIOS_PG_USER` / `AIOS_BACKUP_DIR` / `AIOS_BACKUP_KEEP`.

### Runtime settings that live in the DB, not `.env`

`os_settings` (migration 0022), edited through `GET/PUT /settings`:

| Key | Values | Effect |
|---|---|---|
| `autopilot` | `off` (seeded) / `read` / `propose` | Gates autopilot cycles **and** standing-goal advancement |
| `proactive_delivery` | `off` (seeded) / `on` | Push notifications to the WhatsApp self-chat |
| `screen_watch` | `off` / `on` | Continuous screen perception |
| `autonomy_daily_max` | integer, default `20` | Daily ceiling on `created_by='trigger'` tasks; `0` pauses all autonomy |

---

## 6. The model router — `packages/model-router/src/index.ts`

Owns *which* model runs and telemetry around the call — never prompt content.

### Providers

| `name` | `kind` | Base URL | routing / execution / planning defaults |
|---|---|---|---|
| `anthropic` | anthropic | (SDK default) | `claude-haiku-4-5-20251001` / `claude-sonnet-5` / `claude-fable-5` |
| `xai` | anthropic | `https://api.x.ai` | `grok-4-fast-non-reasoning` / `grok-4-fast-reasoning` / `grok-4` |
| `gemini` | openai | `…/v1beta/openai` | `gemini-2.5-flash-lite` / `gemini-2.5-flash` / `gemini-2.5-pro` |
| `groq` | openai | `https://api.groq.com/openai/v1` | `llama-3.1-8b-instant` / `llama-3.3-70b-versatile` / `llama-3.3-70b-versatile` |
| `nvidia` | openai | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.1-8b-instruct` / `meta/llama-3.1-8b-instruct` / `meta/llama-3.1-70b-instruct` |

A provider factory returns `null` when its key is absent, so **a missing key is
simply absence from the chain** — never an error, unless *every* provider is
absent (then: `No model provider configured — set …`).

NVIDIA's `execution` tier uses the **8b** model, not 70b. The comment at
`index.ts:77-82` gives the measurement: the free tier's latency is *high
variance*, not merely slow — 2.9 s on one call and 27–48 s minutes later for the
identical model and prompt. 70b is confined to `planning`, which is used less
often and is already latency-tolerant.

### Roles

Three step classes (`ModelRole`), from the blueprint routing table:

| Role | Tier | Real callers |
|---|---|---|
| `routing` | cheap | `agents.ts` (goal classification), `memory/extract.ts`, `memory/experience.ts`, `memory/graph.ts`, the boot pre-warm |
| `execution` | mid | `executor.ts` (the ReAct loop), `graph.ts`, `research.ts`, `jobs.ts`, `agents.ts`, `memory/cognition.ts`, `tools/video.ts` |
| `planning` | top | `planner.ts`, `coding.ts`, `learning.ts`, `agents.ts`, `packs/forge.ts` ("pack authorship is the hardest codegen we do") |

Resolution per role: `process.env.MODEL_<ROLE>` ?? `provider.defaults[role]`,
**for the primary provider only** — a fallback uses its own defaults, because a
pinned model name belongs to one provider's catalog.

### Capability routing (ADR-0019)

Each call is classified into a `Capability` with **no extra model round-trip**
(`classifyCapability`, `:135-149`):

1. `role === 'routing'` short-circuits to `fast`.
2. Tool names offered on the call are the strongest signal:
   `^(gmail_|calendar_|workspace_|web_search|fetch_url|screen_capture)` →
   `workspace`; `^code_exec` → `coding`.
3. Otherwise prompt/message text: `WORKSPACE_TEXT_RE` → `workspace`,
   `CODING_TEXT_RE` → `coding`.
4. Fallback → `coding`, which is deliberately also the catch-all bucket.

```
PREMIUM_PRIORITY = [anthropic, xai]           // always first when configured
CAPABILITY_CHAINS = {
  workspace: [gemini, nvidia, groq],
  coding:    [nvidia, groq, gemini],
  fast:      [groq, gemini, nvidia],
}
```

`failoverChain(capability)` = premium providers (if configured) followed by every
configured provider in that capability's order. **`MODEL_PROVIDER` pins a
single-element chain** — no failover, capability ignored entirely — so evals and
baselines stay deterministic.

### Failure handling — three nested layers

**Layer 1 — key rotation and backoff inside one provider**
(`fetchWithRateLimitRetry`, `:534-591`). On `429`/`503`: rotate to the next API
key first (free-tier quotas are per key), and only when every key in the round is
exhausted honour `Retry-After` / a `"retry in Xs"` body hint. Up to 4 rounds,
each wait capped at 70 s and **jittered 0–4 s** — without the jitter two callers
that 429'd together honour the same hint and re-collide in lockstep, observed as a
minutes-long mutual livelock between a chat task and a background task. The
provider's own explanation is logged verbatim, because a
`Requested > Limit` request can *never* succeed by waiting and that failure mode
is otherwise invisible. Network throws are treated as retryable and tracked
separately, so a final-round network error is not shadowed by an earlier 429.

**Layer 2 — status classification** (`throwHttp`, `:623-636`). `429`/`503` →
`INFRA_RATELIMIT`. `413` → also `INFRA_RATELIMIT` (Groq signals per-request TPM
overflow this way) but **never enters the retry loop**, since the identical
request would 413 again. Everything else → `<provider> <status>: <body snippet>`.

**Layer 3 — provider failover** (`callModel` `:705-731`, `chat` `:789-819`). Walk
the chain; on `isInfraFailure(err)` move to the next provider immediately.
Non-final providers get **one** retry round (rotation, no backoff sleeps); only
the last gets the full patient 4-round backoff — measured failover latency 26 ms.

`isInfraFailure` (`:190-201`) covers status 429/503/413/529, the `INFRA_*`
markers, **and provider capability limits** — `only supports single tool-call`,
`is unsupported for assistant role`, `does not support tools`. The reasoning:
the request is fine, this backend just cannot serve it, and failing the task is the
wrong answer when the next provider handles it. Anything else — bad request, auth,
schema — surfaces immediately, because it would fail identically everywhere and
retrying elsewhere hides bugs.

### Two more real-world defenses in `chat()`

- **`sanitizeMessages`** (`:604-617`) strips every key a provider did not ask to
  receive back, keeping only `role`, `content`, `tool_calls`, `tool_call_id`.
  Reasoning models return extras (`reasoning_content`, `reasoning`, `thinking`,
  `refusal`); the whole message is persisted into `tasks.checkpoints` and replayed
  next turn, and the provider then rejects **its own output**
  (`groq 400: 'reasoning_content' property is unsupported for assistant role`),
  killing the task. 86 stored histories carried that key — and it detonates
  hardest on failover, where one provider's extras are sent to another.
- **Pseudo tool-call retries** (`:885-925`). Groq/gpt-oss sometimes emits a tool
  call as inline `<function=name{…}>` syntax. Two symptoms, both handled with a
  bounded 2 retries, entered only on that exact signature: a `400 tool_use_failed`
  from the provider's own validator, and a `200 OK` whose `content` carries the
  pseudo-syntax with no structured `tool_calls` — which would otherwise reach the
  user verbatim as the final answer.

### Modality engines that ignore routing entirely

These are pinned to one provider by capability, not preference, so
`MODEL_PROVIDER` and the failover chain do not apply:

| Function | Provider / model | Key | Notes |
|---|---|---|---|
| `embed` / `embedOne` | Gemini `gemini-embedding-001` @ 768 dims | `GEMINI_API_KEY` | ADR-0006: vectors from a different model live in a different space, so a rate-limited embed stays a retry/defer, never a failover. |
| `transcribe` | Groq `whisper-large-v3-turbo` | `GROQ_API_KEY` | 25 MB cap, `temperature=0`, domain-biased prompt. |
| `synthesize` | Groq `canopylabs/orpheus-v1-english` | `GROQ_API_KEY` | 900-char cap matching the UI's `speakable()`. |
| `describeImages` | Gemini `gemini-2.5-flash`, `max_tokens: 2048` | `GEMINI_API_KEY` (+fallback) | 2048 because full OCR of a dense screenshot is long. |
| `describeVideo` | Gemini native File API + `generateContent` | `GEMINI_API_KEY` | Resumable upload → poll to `ACTIVE` (240 s deadline) → generate → delete. Auth via the `x-goog-api-key` **header**, never a key in a URL. |

`GET /system/models` exposes the chain to the Settings UI — but it calls
`failoverChain()` with no argument, so it always shows the **`coding`** chain and
never reveals that a workspace or routing call would take a different order.

