# PRINCIPLES — the constitution

**Canonical source: [BLUEPRINT.md §3](BLUEPRINT.md).** This file exists so the constitution is loadable standalone (and, later, always-mounted in the OS's own context). If the two ever diverge, the blueprint wins — then fix this file.

1. **Vertical slice first.** Every milestone ships a thinner version of the whole system, never a layer in isolation.
2. **Evals before features.** No component ships without a scored test. If you can't measure it, you can't improve it.
3. **Trust is architecture, not a phase.** Permissions, audit log, and injection defense exist from commit #1.
4. **Buy the plumbing, build the brain.** Differentiation lives in planning, memory, and learning loops — never in rebuilding queues, workflow engines, or tool protocols.
5. **One agent until evals prove two.** Specialist agents are added only when a measured task shows the split wins.
6. **Everything is inspectable.** Every plan, tool call, memory read/write, and token spent is traceable to a task ID.
7. **Interruptible by design.** Any task can be paused, redirected, or resumed. State lives in the database, not in a process.
8. **Untrusted content never gets authority.** Web pages, emails, and tool outputs can inform, never instruct.
9. **Memory has provenance and expiry.** Every remembered fact knows where it came from and when to be doubted.
10. **Cost is a feature.** Per-task token budgets, model routing, monthly caps. An OS you can't afford to run is a demo.
