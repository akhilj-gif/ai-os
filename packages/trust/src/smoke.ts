// Deterministic unit checks for the trust rules — no DB, no model. Proves the
// structural injection-defense decision (blockedByUntrustedContext) that the
// executor relies on. Run: tsx packages/trust/src/smoke.ts
import { isMutating, requiresApproval, blockedByUntrustedContext, classifyTool, UNKNOWN_TOOL_CLASS } from './index.js';

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

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
