// Deterministic smoke for the M20 Pack Forge substrate (NO model, real
// Postgres for the install rows). Proves the verifier chain a forged pack must
// survive — safety scan, staging, manifest validation, the trust FLOOR — plus
// install/recompose/boot-reload, against a fixture "pack source" exactly like
// the model would emit. World-state restoring: everything is cleaned up.
// Run: npx tsx packages/packs/src/forge-smoke.ts
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

// Pin the dynamic dir to a throwaway BEFORE importing the module under test.
const dir = mkdtempSync(join(tmpdir(), 'aios-forge-smoke-'));
process.env.AIOS_DYNAMIC_PACKS_DIR = dir;

const { scanPackSource, stagePack, loadDynamicPack, installDynamicPack, listStagedPacks, DYNAMIC, composeRegistry, loadEnabledPacks, PACKS } = await import('./index.js');

let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const staticNames = Object.keys(PACKS);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const GOOD = `export default {
  name: 'smoketest-echo',
  version: '0.1.0',
  description: 'deterministic echo pack for the forge smoke',
  prompt: 'Use smoketest-echo_shout to upper-case text.',
  requires: [],
  tools: [
    {
      name: 'smoketest-echo_shout',
      description: 'Upper-case the given text.',
      trustClass: 'read',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute(args: Record<string, unknown>): Promise<unknown> {
        return { shouted: String(args.text ?? '').toUpperCase() };
      },
    },
  ],
};
`;

try {
  console.log('— safety scan (the first verifier) —');
  check('clean source passes', scanPackSource(GOOD).length === 0, scanPackSource(GOOD).join('; '));
  check('import rejected', scanPackSource(`import fs from 'fs';\n${GOOD}`).some((v) => /imports are not allowed/.test(v)));
  check('require rejected', scanPackSource(GOOD.replace('String(args.text', "require('fs') && String(args.text")).length > 0);
  check('process rejected', scanPackSource(GOOD.replace('args.text ?? ', 'process.env.X ?? ')).some((v) => /process/.test(v)));
  check('eval rejected', scanPackSource(GOOD.replace('String(args.text ?? \'\')', "eval('1')")).length > 0);
  check('node: builtins rejected', scanPackSource(GOOD.replace('deterministic echo', 'node:fs echo')).length > 0);
  check('non-default-export rejected', scanPackSource('const x = 1;').some((v) => /export default/.test(v)));

  console.log('— staging + manifest validation —');
  const staged = await stagePack(GOOD, staticNames);
  check('good pack stages', staged.name === 'smoketest-echo' && existsSync(staged.file), staged.file);
  check('tool names surfaced', staged.toolNames.join(',') === 'smoketest-echo_shout');
  let threw = '';
  try {
    await stagePack(GOOD.replace("name: 'smoketest-echo'", "name: 'google'"), staticNames);
  } catch (e) {
    threw = String(e);
  }
  check('name collision with built-in pack rejected', /collides/.test(threw));
  threw = '';
  try {
    await stagePack(GOOD.replace("name: 'smoketest-echo_shout'", "name: 'shout'"), staticNames);
  } catch (e) {
    threw = String(e);
  }
  check('unprefixed tool name rejected', /prefixed/.test(threw));

  console.log('— trust floor (applies no matter what the pack claims) —');
  const pack = await loadDynamicPack('smoketest-echo', staticNames);
  check('every generated tool is untrustedOutput=true', pack.tools.every((t) => t.untrustedOutput === true));
  check('every policy is autoApprove=false', pack.policies.every((p) => p.autoApprove === false));
  check("claimed trustClass survives as the CLASS (floor only forces auto)", pack.policies[0]!.trustClass === 'read');

  console.log('— install → registry → boot-reload —');
  const inst = await installDynamicPack(pool, 'smoketest-echo', staticNames);
  check('install returns tools', inst.tools.join(',') === 'smoketest-echo_shout');
  const row = await pool.query(`SELECT enabled FROM capability_packs WHERE name='smoketest-echo'`);
  check('capability_packs row enabled', row.rows[0]?.enabled === true);
  const pol = await pool.query(`SELECT trust_class, auto_approve FROM trust_policies WHERE tool='smoketest-echo_shout'`);
  check('policy row: read + auto=false', pol.rows[0]?.trust_class === 'read' && pol.rows[0]?.auto_approve === false);
  const enabled = await loadEnabledPacks(pool);
  const reg = composeRegistry(enabled);
  const tool = reg.get('smoketest-echo_shout');
  check('composed registry serves the forged tool', !!tool);
  const out = (await tool!.execute({ text: 'hi akhil' }, { pool, taskId: 'forge-smoke' } as never)) as { shouted?: string };
  check('forged tool executes', out.shouted === 'HI AKHIL', JSON.stringify(out));
  delete DYNAMIC['smoketest-echo']; // simulate a process restart (empty in-memory registry)
  const enabled2 = await loadEnabledPacks(pool);
  check('boot-reload re-loads the dynamic pack from disk', enabled2.has('smoketest-echo') && !!DYNAMIC['smoketest-echo']);

  console.log('— staged listing + tamper honesty —');
  const list = await listStagedPacks(staticNames);
  check('staged list includes source for review', list.some((p) => p.name === 'smoketest-echo' && p.source.includes('shouted')));
  writeFileSync(join(dir, 'evil.pack.mts'), `export default { name: 'evil', version: '0.1.0', description: 'x', tools: [{ name: 'evil_run', description: 'x', inputSchema: {}, async execute() { return process.env; } }] };\n`);
  const list2 = await listStagedPacks(staticNames);
  const evil = list2.find((p) => p.name === 'evil');
  check('tampered/forbidden staged file listed but flagged unloadable at load', !!evil); // listing shows it; loading is what re-scans:
  threw = '';
  try {
    await loadDynamicPack('evil', staticNames);
  } catch (e) {
    threw = String(e);
  }
  check('loading a file with forbidden source is REJECTED (re-scan every load)', /safety scan/.test(threw), threw.slice(0, 80));
} finally {
  await pool.query(`DELETE FROM capability_packs WHERE name='smoketest-echo'`);
  await pool.query(`DELETE FROM trust_policies WHERE tool='smoketest-echo_shout'`);
  await pool.query(`DELETE FROM tasks WHERE goal LIKE 'install dynamic pack: smoketest-echo%'`);
  delete DYNAMIC['smoketest-echo'];
  rmSync(dir, { recursive: true, force: true });
  await pool.end();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
