// Memory-recall suite (blueprint §9 M3 exit: recall ≥ 90%). Each case SEEDS a
// fact the model cannot otherwise know, then asks about it in a fresh task with
// memory injection on. A pass proves the Context Engine recalled the seed and the
// model used it — "told it X on day 1, ask on day 30" (FC-001). Deterministic:
// the seeded token is either surfaced or it isn't.
import type { Suite } from '../lib/types.js';

const answerDirectly = 'Answer directly from what you already know about me. Do not call any tools.';

export const memoryRecall: Suite = {
  name: 'memory-recall',
  cases: [
    {
      id: 'rec-fact-codename',
      source: 'FC-001',
      goal: `What is my internal project's codename? ${answerDirectly}`,
      enableMemory: true,
      seedMemory: [
        { type: 'semantic', content: "The user's internal project is codenamed Bluefin.", subject: 'project-codename', source: { user_stated: true } },
      ],
      assertions: [
        { name: 'task terminated', check: (ctx) => ctx.task.status !== 'running' || 'stuck' },
        { name: 'recalled the seeded codename', check: (ctx) => /bluefin/i.test(ctx.text) || 'did not recall "Bluefin" from memory' },
      ],
    },
    {
      id: 'rec-pref-signoff',
      source: 'FC-001',
      goal: 'Write a one-line reply to a colleague telling them the report is ready.',
      enableMemory: true,
      seedMemory: [
        { type: 'preference', content: 'Always end replies with the exact sign-off: — Cheers, A.', subject: 'signoff', source: { user_stated: true } },
      ],
      assertions: [
        { name: 'task terminated', check: (ctx) => ctx.task.status !== 'running' || 'stuck' },
        { name: 'honored the recalled sign-off preference', check: (ctx) => /cheers,\s*a/i.test(ctx.text) || 'did not apply the seeded sign-off preference' },
      ],
    },
    {
      id: 'rec-semantic-kb',
      source: 'FC-001',
      goal: `Where are my knowledge-base articles stored? ${answerDirectly}`,
      enableMemory: true,
      seedMemory: [
        { type: 'semantic', content: "The user's knowledge-base articles live at Downloads/kb/articles.", subject: 'kb-location', source: { user_stated: true } },
      ],
      assertions: [
        { name: 'task terminated', check: (ctx) => ctx.task.status !== 'running' || 'stuck' },
        { name: 'recalled the KB location', check: (ctx) => /downloads[\s\S]{0,6}kb/i.test(ctx.text) || 'did not recall the KB path from memory' },
      ],
    },
    {
      id: 'rec-multi-select',
      source: 'FC-001',
      goal: `What is my account ID? ${answerDirectly}`,
      enableMemory: true,
      seedMemory: [
        { type: 'semantic', content: 'The user account ID is ACME-7741.', subject: 'account-id', source: { user_stated: true } },
        { type: 'semantic', content: 'The user billing plan is Enterprise-Gold.', subject: 'billing-plan', source: { user_stated: true } },
      ],
      assertions: [
        { name: 'task terminated', check: (ctx) => ctx.task.status !== 'running' || 'stuck' },
        { name: 'recalled the correct fact (account ID, not the plan)', check: (ctx) => /acme-7741/i.test(ctx.text) || 'did not recall the correct account ID' },
        // soft: shouldn't drag in the unrelated billing plan — quality, not correctness
        { name: 'did not conflate with the billing plan', soft: true, check: (ctx) => !/enterprise-gold/i.test(ctx.text) || 'answer also pulled in the unrelated billing plan' },
      ],
    },
  ],
};
