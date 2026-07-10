# ADR-0015: M12 — the OS leaves the desk (remote control, proactive Brain, X pack, hands-free voice)

**Status:** accepted (2026-07-10) · **Milestone:** M12 (post-roadmap; scoped by Akhil same day)

## Context

M0–M11 delivered a working kernel: durable tasks, memory, trust gate, packs,
automations, the multi-agent Brain, and a voice-first UI — all reachable only
from a browser on the desk. Akhil picked all four candidate M12 scopes: the OS
should be usable from his phone, act on triggers instead of only notifying,
speak X/Twitter, and hold a hands-free conversation. M12 bundles them as four
slices, each with its own exit criteria, ordered so deterministic engineering
lands first (Groq daily quota gates model-heavy verification).

## Decisions

### M12a — WhatsApp remote control (the first remote interface)

1. **The self-chat is the command channel.** The kernel polls the (already
   paired) bridge for new messages in Akhil's *message-yourself* thread and
   treats as commands only messages that are `fromMe` AND start with the
   trigger prefix (`AIOS_WA_TRIGGER`, default `@os`). `fromMe` in the self-chat
   is the strongest identity signal the protocol offers — nobody else can write
   there; if the account itself is compromised, no allowlist would save us.
2. **A command is TRUSTED user input** — the same trust as typing into the chat
   box (it is Akhil, authenticated by his own session). It routes through the
   ordinary `/chat` path: classifier, Brain, trust gate, approval queue — no
   new execution surface.
3. **Replies are interface plumbing, not agent actions.** The remote-control
   module sends answers back to the self-chat directly through the bridge HTTP
   client — deterministic code, no tool call, exactly like the web UI rendering
   a reply. The model gains NO new send capability; `whatsapp_send_message` to
   any chat still queues for approval. Loop prevention is structural: OS
   replies never carry the trigger prefix, and the poller advances a
   watermark + skips message ids it sent.
4. **Approvals travel over WhatsApp.** A queued `pending_action` posts a
   self-chat message with the EXACT tool + args and a short id; replying
   `@os approve <id>` / `@os cancel <id>` decides it through the existing
   `pending_actions` flow. The human reading exact args on the phone is the
   same invariant as the in-chat card.

**Exit:** deterministic E2E on the mock bridge — seeded `@os` self-chat message
→ task runs → reply in the mock outbox; irreversible command → approval prompt
in outbox → `@os approve` → the exact queued call executes → confirmation; the
OS's own replies never re-trigger the poller. Live: Akhil texts himself from
his phone and gets an answer.

### M12b — Proactive Brain (jobs that act, not just notify)

1. New job kind **`act`**: on fire (cron, or watch-style change detection) it
   creates a REAL task row (`created_by='trigger'`) with the configured goal +
   trigger context and routes it through the normal executor — Brain
   classification included — with progress/results landing in notifications.
2. **Containment, not restriction:** unlike briefing/watch (fixed read-only
   pipelines, ADR-0010), an act job intentionally runs an agent loop
   unattended. The safety is the SAME architecture that guards attended runs:
   trigger context from the outside world enters as untrusted
   (`initialUntrusted`) so §8.3 blocks auto-mutations structurally, and
   approval-class tools queue `pending_actions` (which notify, and — with M12a
   — reach the phone). Nothing irreversible happens without a human, awake or
   asleep.

**Exit:** scheduler-smoke extension (deterministic): act job fires → task
created with `created_by='trigger'` + untrusted taint; its irreversible tool
call queues, never executes. Live: one real act automation runs end-to-end
with an approval round-trip.

### M12c — X/Twitter pack (mock-first; keys are Akhil's step)

1. Mirror ADR-0013's shape: pack tools speak a tiny client contract with a
   deterministic mock; the real client (official X API v2, free tier) lands
   behind `X_API_*` env keys when Akhil creates his dev account.
2. Free tier is write-mostly (~500 posts/mo; reads nearly nil) → v1 tools:
   `x_get_me` (read), `x_draft_post` (write-class: stores a draft row),
   `x_publish_post` (**irreversible + auto_approve=false, always** — publishing
   as Akhil is the pack's whole risk). Timeline/monitoring rides the existing
   internet engine (fetch/watch), not paid API reads.
3. Pack ships its own eval suite (M9 exit contract): draft-never-publishes;
   injection in fetched web/timeline content never publishes; an explicit
   "publish it now" still yields no unapproved publish.

**Exit:** pack installs live without kernel changes; smoke ALL PASS on the
mock; eval suite green on a clean-quota window; first real approved post once
keys exist.

### M12d — Hands-free voice (conversation mode)

1. **Conversation mode toggle** in the voice UI: after the spoken reply ends,
   the mic re-arms automatically; a WebAudio VAD (energy threshold + ~1.2s
   trailing silence) ends each utterance; too-short/too-quiet clips are
   discarded, never sent. Barge-in (speak to interrupt TTS) already exists.
2. **Wake word is an enhancement, not the core**: proper engines need licenses;
   Chrome's Web Speech API can cheaply listen for a phrase ("hey os") to arm
   conversation mode where available, degrading gracefully where not.
3. Trust unchanged: every transcript still enters through `/voice/transcribe`
   → `/chat`; the first mic arm stays a human gesture (browser requirement and
   our preference — the mic never self-activates from a cold page).

**Exit:** in-browser — toggle on, speak, get a reply, and ask a follow-up with
zero clicks (Akhil's real-mic test; in-page synthetic audio corrupts webm).
The VAD/state machine is unit-tested deterministically.

## Ordering & risks

Build order M12a → M12b → M12c(scaffold) → M12d: a/b are deterministic-first
(mock bridge, scheduler smoke), c is blocked on Akhil's keys beyond the mock,
d needs his real mic for final verification. Risks: WhatsApp polling adds
bridge load (poll the ONE self-chat only, modest interval); act jobs burn
quota unattended (they inherit the scheduler's INFRA-deferral + backoff
budget); X free-tier limits may force draft-only operation some months;
browser VAD false-positives (tune threshold; discard-not-send is the failure
mode). The kernel stays domain-free: a/c are pack/interface work, b is a job
kind, d is UI.
