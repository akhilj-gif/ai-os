// Deterministic capability-pack checks (NO model). Proves the ADR-0012 claims:
// the kernel is DOMAIN-FREE (zero packs = workspace-only tool surface), packs
// compose the registry additively, install is idempotent and auditable (an
// install TASK provides provenance), and enable/disable changes the surface.
// Run: tsx packages/packs/src/packs-smoke.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { buildRegistry } from '@ai-os/tools';
import { PACKS, composeRegistry, packPrompts, loadEnabledPacks, installPack, setPackEnabled, listPacks } from './index.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const names = (r: { list(): Array<{ name: string }> }) => r.list().map((t) => t.name).sort();

console.log('— registry composition (pure) —');
const core = names(composeRegistry(new Set()));
check('ZERO packs → workspace-only surface (kernel is domain-free)', core.join(',') === 'workspace_list,workspace_read,workspace_write', core.join(','));
const research = names(composeRegistry(new Set(['research'])));
check('+research → web_search + fetch_url added, no gmail', research.includes('web_search') && research.includes('fetch_url') && !research.includes('gmail_list'));
const all = names(composeRegistry(new Set(Object.keys(PACKS))));
check('all packs == the full pre-M9 tool surface', all.join(',') === names(buildRegistry()).join(','), `packs=${all.length} tools`);
check('unknown pack name is ignored, not fatal', names(composeRegistry(new Set(['nope']))).length === 3);
const prompt = packPrompts(new Set(['support-ops', 'coding']));
check('pack prompt fragments compose (stable, labeled)', prompt.includes('[coding]') && prompt.includes('[support-ops]') && prompt.indexOf('[coding]') < prompt.indexOf('[support-ops]'));

console.log('\n— install state (DB) —');
const enabled0 = await loadEnabledPacks(pool);
check('migration seeded google+research+coding enabled', ['google', 'research', 'coding'].every((p) => enabled0.has(p)), [...enabled0].join(','));
// Snapshot: support-ops may or may not be installed (the live API demo installs
// it for real). The install test below must RESTORE this state, never assume it.
const supportOpsWasInstalled = enabled0.has('support-ops');

await setPackEnabled(pool, 'google', false);
const enabledOff = await loadEnabledPacks(pool);
check('disable google → composed surface drops gmail/calendar', !names(composeRegistry(enabledOff)).includes('gmail_list'));
await setPackEnabled(pool, 'google', true);
check('re-enable google → gmail back', names(composeRegistry(await loadEnabledPacks(pool))).includes('gmail_list'));

console.log('\n— install: idempotent + auditable —');
const r1 = await installPack(pool, 'support-ops');
check('install creates an install TASK (provenance)', !!r1.installTaskId);
const t = (await pool.query(`SELECT goal, status FROM tasks WHERE id=$1`, [r1.installTaskId])).rows[0];
check('install task is a real, done task', t?.status === 'done' && String(t?.goal).includes('support-ops'), t?.goal);
const lp = await listPacks(pool);
const so = lp.find((p) => p.name === 'support-ops');
check('listPacks shows support-ops installed+enabled', so?.installed === true && so?.enabled === true);
check(`procedural memories seeded (${r1.memoriesSeeded}/${PACKS['support-ops']!.memories.length})${r1.memoryWarning ? ' [' + r1.memoryWarning + ']' : ''}`,
  r1.memoriesSeeded === PACKS['support-ops']!.memories.length || !!r1.memoryWarning);
const rr1 = await installPack(pool, 'research');
const rr2 = await installPack(pool, 'research');
check('re-install never re-applies policies over user edits', rr1.policiesApplied === 0 && rr2.policiesApplied === 0, `applied=${rr1.policiesApplied},${rr2.policiesApplied}`);
const rows = await pool.query(`SELECT count(*) FROM capability_packs WHERE name='research'`);
check('re-install keeps a single row', Number(rows.rows[0].count) === 1);

// cleanup: RESTORE the pre-smoke world (never assume it). If support-ops was
// installed before (the live API demo is real state), keep it installed —
// installPack above was an idempotent re-install. If it wasn't, remove our test
// install completely.
if (!supportOpsWasInstalled) {
  await pool.query(`DELETE FROM memory_records WHERE tags @> ARRAY['pack:support-ops']`);
  await pool.query(`DELETE FROM capability_packs WHERE name='support-ops'`);
  await pool.query(`DELETE FROM tasks WHERE id=$1`, [r1.installTaskId]);
}
const enabledEnd = await loadEnabledPacks(pool);
check('cleanup: world restored to its pre-smoke state', enabledEnd.has('support-ops') === supportOpsWasInstalled, [...enabledEnd].join(','));

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
await pool.end();
process.exit(fail ? 1 : 0);
