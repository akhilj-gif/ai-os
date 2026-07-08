# Graph Report - C:/Users/jinuk/Downloads/ai-os  (2026-07-09)

## Corpus Check
- 139 files · ~79,707 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 913 nodes · 1502 edges · 74 communities (57 shown, 17 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 28 edges (avg confidence: 0.66)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- API gateway (Fastify server.ts)
- ADRs 0001-0007: M0-M4 foundational decisions
- M7 automation scheduler + jobs
- Eval gym type contracts
- WhatsApp bridge contract
- Model router: providers + failover
- Memory extraction + reflection
- kernel package manifest
- M4 graph approvals + notifications
- whatsapp-bridge package manifest
- Ops lifecycle scripts (up/down/status)
- Tool registry + WhatsApp/workspace tools
- root tsconfig
- Phase-0 planning docs (VISION/PRINCIPLES/DOMAINS/EVAL-SPEC)
- M0 hello-world + M6 research engine
- web app package manifest
- web app frontend deps
- Planner + injection-defense (§8.3)
- Coding loop: propose + LLM check
- The 5 data contracts
- packs package manifest
- M10 learning loop
- shared tsconfig base
- Sandbox contract + Docker runner
- Executor loop + context assembly
- Task Inspector UI (tasks/[id])
- M5 secrets broker + audit
- kernel package manifest (variant)
- Learning-loop smoke test
- model-router package manifest
- memory package manifest
- Gmail tool
- shared package manifest (Langfuse/Anthropic)
- Google OAuth + Calendar tool
- Dashboard UI
- M10 gym-gated self-improvement (ADR-0014)
- tools package manifest
- trust package manifest
- evals package manifest
- Personal-life trust ceilings (finance/travel/home)
- System Architecture layer diagram (kernel components)
- web-app-level package manifest
- Coding-loop commit smoke test
- Automations UI
- Tool registry core
- Memory browser UI
- Tasks list UI
- Sandboxed code_exec tool
- Sandbox isolation smoke test
- Web search tool
- Capability Packs UI
- Research UI
- Settings (trust policies + models) UI
- Chat home page
- DB migration runner
- Planner (M4) core
- fetch_url tool
- web app tsconfig
- Next.js root layout
- Next.js config
- Next.js generated types
- M0 hello-task smoke
- Build vs Buy (blueprint §5)
- M8 — OS Interface (milestone)
- Metrics That Matter (blueprint §11)
- North Star (blueprint §1)
- Repository Structure (blueprint §10)
- Risk Register (blueprint §12)
- Trust & Security Model (umbrella, blueprint §8)
- Eval suite-level gates
- Eval case pipeline (corpus -> case)
- Docker Compose substrate
- pnpm workspace config

## God Nodes (most connected - your core abstractions)
1. `callModel()` - 23 edges
2. `runTask()` - 19 edges
3. `newTraceId()` - 19 edges
4. `MemoryService` - 18 edges
5. `compilerOptions` - 15 edges
6. `buildRegistry()` - 15 edges
7. `ToolRegistry` - 15 edges
8. `runGraph()` - 14 edges
9. `makePlan()` - 13 edges
10. `tick()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `Context Engine` --implements--> `assembleMemoryContext()`  [EXTRACTED]
  docs/BLUEPRINT.md → packages/kernel/src/context.ts
- `Executor Loop` --implements--> `runTask()`  [EXTRACTED]
  docs/BLUEPRINT.md → packages/kernel/src/executor.ts
- `Task Graph` --implements--> `runGraph()`  [EXTRACTED]
  docs/BLUEPRINT.md → packages/kernel/src/graph.ts
- `Memory Service` --implements--> `MemoryService`  [EXTRACTED]
  docs/BLUEPRINT.md → packages/memory/src/service.ts
- `M6 — Engines: Coding + Internet` --implements--> `runCodingTask()`  [EXTRACTED]
  docs/BLUEPRINT.md → packages/kernel/src/coding.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **S1-severity findings (real mistake shipped/executed)** — docs_failure_corpus_fc_016, docs_failure_corpus_fc_020, docs_failure_corpus_fc_022 [EXTRACTED 1.00]
- **M5 trust hardening (secrets + sandbox + structural defense)** — docs_adr_0008_secrets_broker_secrets_broker, docs_adr_0009_sandbox_substrate_sandbox_substrate, docs_blueprint_m5 [EXTRACTED 1.00]
- **M9/M9.5 personal capability packs** — docs_adr_0012_capability_packs_capability_packs, docs_adr_0013_whatsapp_pack_bridge_whatsapp_pack_bridge, docs_blueprint_m9_5 [EXTRACTED 1.00]
- **Self-verifying loops: coding (M6) and learning (M10)** — docs_adr_0014_learning_loop_learning_loop, docs_blueprint_m6, docs_failure_corpus_fc_022 [EXTRACTED 0.90]

## Communities (74 total, 17 thin omitted)

### Community 0 - "API gateway (Fastify server.ts)"
Cohesion: 0.05
Nodes (51): app, completeChatTask(), enabledPacks, fastify, FastifyRequest, GOOGLE_SCOPES, JOB_KINDS, memory (+43 more)

### Community 1 - "ADRs 0001-0007: M0-M4 foundational decisions"
Cohesion: 0.05
Nodes (45): ADR-0001: M0 skeleton choices, ADR-0002: Grok/Gemini as dev model providers, ADR-0003: Life domains first, Redash deferred, ADR-0004: M1 walking-skeleton implementation choices, ADR-0005: Groq as eval-execution provider; baseline semantics, ADR-0006: Memory embeddings & retrieval, ADR-0007: Postgres-backed task-graph executor, ADR-0010: Automation scheduler, quota-survival semantics (+37 more)

### Community 2 - "M7 automation scheduler + jobs"
Cohesion: 0.07
Nodes (34): Scheduler, pool, briefingExecutor(), defaultExecutors(), reflectExecutor(), reg(), ADR-0010, TZ() (+26 more)

### Community 3 - "Eval gym type contracts"
Cohesion: 0.08
Nodes (31): Assertion, BuildRegistry, CaseContext, EvalCase, PlanShape, ResearchShape, Suite, baselinesPath (+23 more)

### Community 4 - "WhatsApp bridge contract"
Cohesion: 0.07
Nodes (36): BridgeChat, BridgeHealth, BridgeMessage, ADR-0013, app, AUTH_DIR, chatNames, chats (+28 more)

### Community 5 - "Model router: providers + failover"
Cohesion: 0.08
Nodes (33): ADR-0002, Model Router, hits, names(), saved, ADR-0011, callAnthropicShape(), callModelOn() (+25 more)

### Community 6 - "Memory extraction + reflection"
Cohesion: 0.10
Nodes (18): Extracted, ADR-0006, pool, ReflectionReport, MemoryRecord, MemoryService, MemorySource, MemoryType (+10 more)

### Community 7 - "kernel package manifest"
Cohesion: 0.08
Nodes (25): dependencies, dotenv, pg, description, devDependencies, pm2, tsx, @types/node (+17 more)

### Community 8 - "M4 graph approvals + notifications"
Cohesion: 0.14
Nodes (13): pool, decideApproval(), executeStep(), finalText(), GraphResult, pauseTask(), resumeTask(), runGraph() (+5 more)

### Community 9 - "whatsapp-bridge package manifest"
Cohesion: 0.09
Nodes (21): dependencies, fastify, qrcode, qrcode-terminal, @whiskeysockets/baileys, devDependencies, @ai-os/packs, @ai-os/tools (+13 more)

### Community 10 - "Ops lifecycle scripts (up/down/status)"
Cohesion: 0.23
Nodes (16): root, C, dockerDaemonUp(), httpJson(), httpUp(), pgReady(), pm2List(), run() (+8 more)

### Community 11 - "Tool registry + WhatsApp/workspace tools"
Cohesion: 0.18
Nodes (15): ADR-0004, ToolContext, ToolSchema, ADR-0004, bridge(), bridgeUrl(), ADR-0013, whatsappListChats (+7 more)

### Community 12 - "root tsconfig"
Cohesion: 0.11
Nodes (17): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+9 more)

### Community 13 - "Phase-0 planning docs (VISION/PRINCIPLES/DOMAINS/EVAL-SPEC)"
Cohesion: 0.14
Nodes (18): AI OS — Living Status (CLAUDE.md), 3. Core Principles (the constitution), 6. The Eval Harness (the gym), AI Operating System — Master Blueprint, 5. Work / support ops, DOMAINS — the travel map, EVAL SPEC, FAILURE CORPUS (+10 more)

### Community 14 - "M0 hello-world + M6 research engine"
Cohesion: 0.20
Nodes (11): HelloResult, runHelloWorldTask(), ResearchResult, ResearchSource, runResearch(), callModel(), flushTelemetry(), newSpanId() (+3 more)

### Community 15 - "web app package manifest"
Cohesion: 0.12
Nodes (16): dependencies, @ai-os/kernel, @ai-os/memory, @ai-os/model-router, @ai-os/packs, @ai-os/shared, dotenv, fastify (+8 more)

### Community 16 - "web app frontend deps"
Cohesion: 0.12
Nodes (16): dependencies, next, react, react-dom, devDependencies, @types/node, @types/react, @types/react-dom (+8 more)

### Community 17 - "Planner + injection-defense (§8.3)"
Cohesion: 0.20
Nodes (13): 8.3 Prompt injection defense, FC-016 · Prompt injection SUCCEEDED — model wrote a file on a web result's command, Plan, PlannedStep, plannerSystem(), StepKind, TrustClass, blockedByUntrustedContext() (+5 more)

### Community 18 - "Coding loop: propose + LLM check"
Cohesion: 0.15
Nodes (11): CommitResult, IMAGES, buggy, pool, llmProposer(), ProposedFix, Proposer, RepoFile (+3 more)

### Community 19 - "The 5 data contracts"
Cohesion: 0.12
Nodes (15): 4.3 Data contracts (Task/Step/ToolCall/MemoryRecord/TraceEvent), Budget, Checkpoint, MemoryRecord, MemorySource, MemoryType, Spent, Step (+7 more)

### Community 20 - "packs package manifest"
Cohesion: 0.13
Nodes (14): dependencies, @ai-os/memory, @ai-os/model-router, @ai-os/shared, @ai-os/tools, @ai-os/trust, dotenv, pg (+6 more)

### Community 21 - "M10 learning loop"
Cohesion: 0.24
Nodes (12): evalsRunner, FailureSignal, gatherFailureSignals(), ImprovementCandidate, LearningResult, pool, llmProposer(), Playbook (+4 more)

### Community 22 - "shared tsconfig base"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit (+5 more)

### Community 23 - "Sandbox contract + Docker runner"
Cohesion: 0.24
Nodes (9): 8.2 Sandbox, dockerSandbox, mountPath(), ADR-0009, notImplementedSandbox, SandboxResult, SandboxRunner, SandboxSpec (+1 more)

### Community 24 - "Executor loop + context assembly"
Cohesion: 0.29
Nodes (11): approxTokens(), assembleMemoryContext(), compactHistory(), CheckpointRecord, queuePendingAction(), runTask(), RunTaskOptions, saveCheckpoint() (+3 more)

### Community 25 - "Task Inspector UI (tasks/[id])"
Cohesion: 0.18
Nodes (11): card, h2, mono, snip(), STATUS_COLOR, Step, Task, TaskInspectorPage() (+3 more)

### Community 26 - "M5 secrets broker + audit"
Cohesion: 0.17
Nodes (8): ADR-0008: Secrets broker & audit redaction, ADR-0009: Sandbox — substrate now, enforced at M6, 8.4 Audit, M5 — Trust Hardening + Sandbox, FC-012 · No audit trail — can't see what the agent did while away, SECRET_ENV_NAMES, SECRET_PATTERNS, secretsBroker

### Community 27 - "kernel package manifest (variant)"
Cohesion: 0.17
Nodes (11): dependencies, @ai-os/kernel, @ai-os/memory, @ai-os/shared, @ai-os/tools, dotenv, pg, name (+3 more)

### Community 28 - "Learning-loop smoke test"
Cohesion: 0.17
Nodes (4): bad, good, pool, ADR-0014

### Community 29 - "model-router package manifest"
Cohesion: 0.17
Nodes (11): dependencies, @ai-os/model-router, @ai-os/shared, dotenv, pg, exports, main, name (+3 more)

### Community 30 - "memory package manifest"
Cohesion: 0.17
Nodes (11): dependencies, @ai-os/memory, @ai-os/shared, @ai-os/tools, pg, exports, main, name (+3 more)

### Community 31 - "Gmail tool"
Cohesion: 0.20
Nodes (8): ADR-0003, decodeB64Url(), extractBody(), gmailCreateDraft, gmailList, gmailRead, MessageMeta, Part

### Community 32 - "shared package manifest (Langfuse/Anthropic)"
Cohesion: 0.18
Nodes (10): dependencies, @ai-os/shared, @anthropic-ai/sdk, langfuse, exports, main, name, private (+2 more)

### Community 33 - "Google OAuth + Calendar tool"
Cohesion: 0.24
Nodes (8): getGoogleAccessToken(), googleApi(), GoogleNotConnectedError, TokenRow, calendarList, GEvent, todayRange(), tzOffsetMs()

### Community 34 - "Dashboard UI"
Cohesion: 0.20
Nodes (8): Approval, card, Dash, h2, JobRow, PendingAction, STATUS_COLOR, TaskRow

### Community 35 - "M10 gym-gated self-improvement (ADR-0014)"
Cohesion: 0.33
Nodes (10): ADR-0014: Learning Loop — gym-gated self-improvement, M10 — Learning Loop, M6 — Engines: Coding + Internet, 4. Coding, FC-022 · An autonomous coder that trusts "I fixed it" ships broken code, research suite, commitApproved(), git() (+2 more)

### Community 36 - "tools package manifest"
Cohesion: 0.20
Nodes (9): dependencies, pg, zod, exports, main, name, private, type (+1 more)

### Community 37 - "trust package manifest"
Cohesion: 0.20
Nodes (9): dependencies, @ai-os/shared, pg, exports, main, name, private, type (+1 more)

### Community 38 - "evals package manifest"
Cohesion: 0.20
Nodes (9): dependencies, @ai-os/shared, pg, exports, main, name, private, type (+1 more)

### Community 39 - "Personal-life trust ceilings (finance/travel/home)"
Cohesion: 0.22
Nodes (9): 8.1 Action classes (read/write/irreversible/spend), M9.5 — Personal life expansion, 7. Memory Architecture (six typed stores), 8. Finance, 10. Home & life admin, 9. Travel & logistics, Trust policy for the support-ops wedge, The four behaviors that earn trust (+1 more)

### Community 40 - "System Architecture layer diagram (kernel components)"
Cohesion: 0.22
Nodes (7): Context Engine, Executor Loop, Memory Service, 4. System Architecture, Task Graph, Trust Gate, TrustGate

### Community 41 - "web-app-level package manifest"
Cohesion: 0.22
Nodes (8): dependencies, @ai-os/shared, exports, main, name, private, type, version

### Community 42 - "Coding-loop commit smoke test"
Cohesion: 0.25
Nodes (5): CodingResult, baseSha, escape, green, red

### Community 43 - "Automations UI"
Cohesion: 0.43
Nodes (6): AutomationsPage(), Job, LastRun, Notification, scheduleLabel(), STATUS_COLOR

### Community 44 - "Tool registry core"
Cohesion: 0.33
Nodes (4): registryFor(), reg(), buildRegistry(), ToolRegistry

### Community 45 - "Memory browser UI"
Cohesion: 0.40
Nodes (5): MemoryPage(), Rec, sourceLabel(), TYPE_COLORS, TYPES

### Community 46 - "Tasks list UI"
Cohesion: 0.33
Nodes (4): btn, STATUS_COLOR, Step, Task

### Community 47 - "Sandboxed code_exec tool"
Cohesion: 0.33
Nodes (4): ToolDef, codeExec, RUNTIMES, ADR-0009

### Community 48 - "Sandbox isolation smoke test"
Cohesion: 0.33
Nodes (3): sbx, start, ADR-0009

### Community 49 - "Web search tool"
Cohesion: 0.40
Nodes (4): decodeEntities(), stripTags(), ADR-0004, webSearch

### Community 50 - "Capability Packs UI"
Cohesion: 0.40
Nodes (3): card, Pack, ADR-0012

### Community 51 - "Research UI"
Cohesion: 0.40
Nodes (3): Report, ReportListItem, Source

### Community 52 - "Settings (trust policies + models) UI"
Cohesion: 0.40
Nodes (3): CLASSES, ModelChain, Policy

### Community 55 - "Planner (M4) core"
Cohesion: 0.67
Nodes (4): Planner, persistPlan(), planAndStart(), makePlan()

### Community 56 - "fetch_url tool"
Cohesion: 0.67
Nodes (3): decodeEntities(), extract(), fetchUrl

### Community 57 - "web app tsconfig"
Cohesion: 0.50
Nodes (3): exclude, extends, include

## Knowledge Gaps
- **424 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+419 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `planning suite` connect `ADRs 0001-0007: M0-M4 foundational decisions` to `Phase-0 planning docs (VISION/PRINCIPLES/DOMAINS/EVAL-SPEC)`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `qrPage()` connect `whatsapp-bridge package manifest` to `WhatsApp bridge contract`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _429 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `API gateway (Fastify server.ts)` be split into smaller, more focused modules?**
  _Cohesion score 0.0514216575922565 - nodes in this community are weakly interconnected._
- **Should `ADRs 0001-0007: M0-M4 foundational decisions` be split into smaller, more focused modules?**
  _Cohesion score 0.05353535353535353 - nodes in this community are weakly interconnected._
- **Should `M7 automation scheduler + jobs` be split into smaller, more focused modules?**
  _Cohesion score 0.0707070707070707 - nodes in this community are weakly interconnected._
- **Should `Eval gym type contracts` be split into smaller, more focused modules?**
  _Cohesion score 0.07928118393234672 - nodes in this community are weakly interconnected._