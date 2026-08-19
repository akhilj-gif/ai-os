# Troubleshooting

Start here, always:

```bash
pnpm os:doctor
```

It walks every dependency outside-in (docker → postgres → migrations → processes
→ readiness → config → backups → recent failures → autostart), prints the **fix**
next to each failure, and exits non-zero if anything FAILED. Because the checks
run outside-in, **fix the first ✗ and re-run** — the ones below it are usually
symptoms of the same cause.

Two things it will tell you that nothing else does:

- **`scheduler activity`** — if the last job run was hours or days ago, the
  scheduler is *dead*, not idle. "Zero failed jobs" looks healthy and is not: the
  autonomous jobs once sat dead for ~13 days while every monitor said fine.
  Absence of failure is not health; absence of **activity** is the signal.
- **`autostart`** — if this warns, the OS will not come back after a reboot. That
  is currently the single largest availability gap (see `ROADMAP.md` Phase 0).

## Then: reconstruct the incident

```bash
pnpm os:trace --recent          # recent tasks, failures first, each with its id
pnpm os:trace <taskId|traceId>  # one incident, end to end
```

`os:trace` joins what the OS already persists into one screen: the task and its
window, every step in order with model / tokens / duration, the exact error, any
approval it queued, the memories it wrote, and the trace events around it. It
accepts a task id **or** a trace id, because during an incident you rarely know
which one you are holding.

A real example — a task that failed in 5 seconds:

```
  steps (2)
     1. 14:41:01  done      reason   3.7s  meta/llama-3.1-8b-instruct 10019tok
        output {"text":";","toolCalls":["fetch_url","browser_extract"]}
     2. 14:41:05  failed    reason   1.7s
        error  nvidia 500: Failed to apply prompt template: invalid oper…
  trace events (4)
   14:41:05  executor   tool.executed  {"tool":"fetch_url","queued":false,"blocked":false,…}
```

That is a provider-side failure, not an OS bug — visible in one command instead of
grepping a 43 MB log file.

## Reading the logs

Every service writes to `logs/*.log`, rotated by pm2-logrotate (10 MB × 10,
compressed). `pnpm os:logs` tails them all.

The kernel emits **one JSON object per line** with a stable event name and the
correlation keys, so logs can be filtered and joined rather than eyeballed:

```json
{"ts":"…","level":"info","svc":"kernel","evt":"model.call","taskId":"…","traceId":"…","ms":812}
```

| Field | Use |
|---|---|
| `evt` | Stable dotted name (`model.call`, `memory.context.failed`). Grep by *what happened*, not by prose that changes when someone edits a string |
| `traceId` / `taskId` | The join key to `trace_events`, `steps`, `tasks` — and to `os:trace` |
| `ms` | Duration, on events that close something timed |
| `err` | Flattened `{message, stack}` — a raw `Error` JSON-stringifies to `{}`, which is the classic lost-stack bug |

Useful shapes:

```bash
# everything for one task, across services
grep '"taskId":"<id>"' logs/*.log

# only failures
grep '"level":"error"' logs/*.log | tail -40

# slowest model calls
grep '"evt":"model.call"' logs/api.log | node -e "let a=[];process.stdin.on('data',d=>a.push(d)).on('end',()=>console.log(Buffer.concat(a).toString().split('\n').filter(Boolean).map(JSON.parse).sort((x,y)=>y.ms-x.ms).slice(0,10)))"
```

Two environment knobs:

- `AIOS_LOG_LEVEL=debug` — more detail while reproducing something.
- `AIOS_LOG_PRETTY=1` — human columns instead of JSON, for a live terminal.

## Symptom → first move

| Symptom | Do this |
|---|---|
| Nothing responds at all | `pnpm os:doctor` — almost always Docker is down (Postgres lives in it) or pm2 has nothing running |
| The UI loads but every request fails | `curl http://127.0.0.1:4000/health` — it returns **503** with the failing dependency named. It used to return 200 while the database was dead |
| Autonomy stopped happening | The `scheduler activity` check. If it says DEAD, the api process (which owns the scheduler) is not running |
| WhatsApp stopped replying | The `whatsapp pairing` check. If UNPAIRED, **restarting cannot fix it** — re-scan the QR at `http://127.0.0.1:4100/qr` |
| A task did the wrong thing | `pnpm os:trace <taskId>` — the step list shows which tools ran, whether any was blocked or queued, and whether untrusted content was in scope |
| An action never happened | Check `approvals waiting`. The OS may be blocked on you, not broken |
| It feels slow | `grep '"evt":"model.call"' logs/*.log` and sort by `ms`; the model call is usually the whole latency |
| Disk filling up | The `logs on disk` check. pm2-logrotate is asserted by `os:up`, so it only gets configured when `os:up` actually runs |

## What the harness does not yet do

Honest list, so nobody assumes coverage that is not there:

- **No external watchdog.** `os:doctor` must be run by something. An OS that is
  down cannot alert on its own behalf — `ROADMAP.md` Phase 0.
- **No metrics history.** Every check is point-in-time; there is no series to see
  "when did this start". `job_runs` is the closest thing.
- **No spend surface.** Token counts are on `/dashboard`; cumulative cost against
  a cap is Phase 1.
- **Only the kernel is fully structured.** The API uses Fastify's own JSON logger
  (which is fine and already correlatable by `reqId`); the bridges still use bare
  `console.*` and are the next adoption target.
