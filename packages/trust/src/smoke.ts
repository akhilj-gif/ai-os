// Deterministic unit checks for the trust rules — no DB, no model. Proves the
// structural injection-defense decision (blockedByUntrustedContext) that the
// executor relies on. Run: tsx packages/trust/src/smoke.ts
import type pg from 'pg';
import type { TrustClass } from '@ai-os/shared';
import { isMutating, requiresApproval, blockedByUntrustedContext, classifyTool, UNKNOWN_TOOL_CLASS, TrustGate } from './index.js';

let fail = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) fail++;
};

// isMutating: read is not; write/irreversible/spend are.
check('read is not mutating', !isMutating('read'));
check('write is mutating', isMutating('write'));
check('irreversible is mutating', isMutating('irreversible'));
check('spend is mutating', isMutating('spend'));

// requiresApproval: irreversible/spend by default.
check('read auto', !requiresApproval('read'));
check('write auto', !requiresApproval('write'));
check('irreversible needs approval', requiresApproval('irreversible'));
check('spend needs approval', requiresApproval('spend'));

// THE structural rule: untrusted-in-context blocks ALL mutations, allows reads.
check('no untrusted → write allowed', !blockedByUntrustedContext('write', false));
check('untrusted → read allowed', !blockedByUntrustedContext('read', true));
check('untrusted → write BLOCKED', blockedByUntrustedContext('write', true));
check('untrusted → irreversible BLOCKED', blockedByUntrustedContext('irreversible', true));
check('untrusted → spend BLOCKED', blockedByUntrustedContext('spend', true));

// classifyTool: fail-closed for unknown tools.
check('unknown tool → irreversible (fail closed)', classifyTool('nope', []) === UNKNOWN_TOOL_CLASS);
check('known tool classified from policy', classifyTool('gmail_list', [{ tool: 'gmail_list', trustClass: 'read', autoApprove: true }]) === 'read');

// ---------------------------------------------------------------------------
// TrustGate.classify() — the ONE function every TrustDecision is built from, so
// its backstop is the last line of defense if any endpoint ever persists a bad
// row. Driven with a stub pool: no DB needed, which is why these can live in
// the CI-safe gate.
//
// These two invariants are a matched PAIR and must be tested together, because
// getting them confused is a mistake that was actually made and shipped-then-
// caught during the 2026-08-12 hardening pass: a first-pass fix treated
// 'irreversible' exactly like 'spend' here, which silently killed the entire
// graduated-trust feature (read/write auto-approve by default and spend can
// never promote, so if irreversible can't either, NOTHING is ever promotable
// and Tier 3 is dead code). requiresApproval() answers "does this class need
// approval BY DEFAULT" — a DIFFERENT question from "can this class ever be
// promoted". Only money is permanently exempt.
// ---------------------------------------------------------------------------
const stubPool = (row: { trust_class: TrustClass; auto_approve: boolean } | null): pg.Pool =>
  ({ query: async () => ({ rows: row ? [row] : [] }) }) as unknown as pg.Pool;

const classifyWith = (trust_class: TrustClass, auto_approve: boolean) =>
  new TrustGate(stubPool({ trust_class, auto_approve })).classify('t');

// INVARIANT 1: spend can NEVER be auto-approved, regardless of the stored row.
const spendAuto = await classifyWith('spend', true);
check('spend + auto_approve=true in DB → autoApprove STRIPPED to false', spendAuto.autoApprove === false);
check('spend keeps its class', spendAuto.trustClass === 'spend');

// INVARIANT 2: irreversible MUST retain a promoted auto_approve — this is the
// graduated-trust feature working as designed, not a hole.
const irrevAuto = await classifyWith('irreversible', true);
check('irreversible + auto_approve=true in DB → autoApprove PRESERVED (graduated trust lives)', irrevAuto.autoApprove === true);
check('irreversible + auto_approve=false → stays false', (await classifyWith('irreversible', false)).autoApprove === false);

// read/write pass through untouched.
check('read + auto → auto', (await classifyWith('read', true)).autoApprove === true);
check('write + auto → auto', (await classifyWith('write', true)).autoApprove === true);

// No policy row at all → fail closed.
const missing = await new TrustGate(stubPool(null)).classify('never-registered');
check('no policy row → irreversible + no auto + unknownTool flag', missing.trustClass === UNKNOWN_TOOL_CLASS && missing.autoApprove === false && missing.unknownTool === true);

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
