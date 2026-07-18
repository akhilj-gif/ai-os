// Deterministic smoke for the M19 desktop file tools (NO model, NO DB, NO
// network). Runs against a throwaway directory and pins AIOS_TERMINAL_ROOT to
// it, so nothing outside the fixture is ever touched and confinement is tested
// for real. Run: npx tsx packages/packs/src/files-smoke.ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsList, fsRead, fsSearch, fsWrite, fsOpen, confinePath } from '@ai-os/tools';

let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};
const ctx = { pool: null as never, taskId: 'files-smoke' };
type R = Record<string, unknown> & { error?: string };

const root = mkdtempSync(join(tmpdir(), 'aios-files-smoke-'));
const savedRoot = process.env.AIOS_TERMINAL_ROOT;
process.env.AIOS_TERMINAL_ROOT = root;

try {
  console.log('— confinement (the security boundary) —');
  let threw = '';
  try {
    confinePath('../outside.txt');
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check('relative escape (..) rejected', /escapes the allowed root/.test(threw), threw.slice(0, 60));
  threw = '';
  try {
    confinePath('C:\\Windows\\system32\\drivers\\etc\\hosts');
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check('absolute path outside root rejected', /escapes the allowed root/.test(threw));
  const wOut = (await fsWrite.execute({ path: '..\\evil.txt', content: 'x' }, ctx)) as R;
  check('fs_write escape returns error, writes nothing', !!wOut.error && !existsSync(join(root, '..', 'evil.txt')));

  console.log('— write → read → list round trip —');
  const w = (await fsWrite.execute({ path: 'demo/notes.txt', content: 'hello desktop\nline two' }, ctx)) as R;
  check('fs_write creates file + parent dir', !w.error && existsSync(join(root, 'demo', 'notes.txt')), JSON.stringify(w).slice(0, 80));
  check('fs_write reports overwrote=false on create', w.overwrote === false);
  const w2 = (await fsWrite.execute({ path: 'demo/notes.txt', content: 'replaced' }, ctx)) as R;
  check('fs_write reports overwrote=true on overwrite', w2.overwrote === true);
  const r = (await fsRead.execute({ path: 'demo/notes.txt' }, ctx)) as R;
  check('fs_read returns the written content', r.text === 'replaced', String(r.text));
  const l = (await fsList.execute({ path: 'demo' }, ctx)) as R;
  const entries = (l.entries ?? []) as Array<{ name: string; kind: string; size: number | null }>;
  check('fs_list shows the file with kind+size', entries.some((e) => e.name === 'notes.txt' && e.kind === 'file' && e.size === 8), JSON.stringify(entries));

  console.log('— honest failure modes —');
  const missing = (await fsRead.execute({ path: 'demo/nope.txt' }, ctx)) as R;
  check('fs_read missing file → clear error', /not found/.test(String(missing.error)));
  writeFileSync(join(root, 'demo', 'blob.bin'), Buffer.from([1, 0, 2, 0, 3]));
  const bin = (await fsRead.execute({ path: 'demo/blob.bin' }, ctx)) as R;
  check('fs_read binary file → refuses politely', /binary/.test(String(bin.error)), String(bin.error));
  const dir = (await fsRead.execute({ path: 'demo' }, ctx)) as R;
  check('fs_read on a directory → points to fs_list', /is a directory/.test(String(dir.error)));
  const big = (await fsWrite.execute({ path: 'demo/big.txt', content: 'x'.repeat(600_000) }, ctx)) as R;
  check('fs_write over cap → refused', /cap is/.test(String(big.error)));

  console.log('— read cap —');
  writeFileSync(join(root, 'demo', 'long.txt'), 'a'.repeat(60_000));
  const long = (await fsRead.execute({ path: 'demo/long.txt' }, ctx)) as R;
  check('oversized read is truncated with a marker', long.truncated === true && /truncated/.test(String(long.text)));

  console.log('— search —');
  mkdirSync(join(root, 'proj', 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'proj', 'node_modules', 'dep', 'target-name.txt'), 'needle');
  writeFileSync(join(root, 'proj', 'target-name.md'), 'no match here');
  writeFileSync(join(root, 'proj', 'other.md'), 'contains the needle word');
  const byName = (await fsSearch.execute({ path: '.', nameContains: 'target-name' }, ctx)) as R;
  const nameMatches = (byName.matches ?? []) as Array<{ path: string }>;
  check('search by name finds the file', nameMatches.some((m) => m.path.endsWith('target-name.md')));
  check('search skips node_modules', !nameMatches.some((m) => m.path.includes('node_modules')), JSON.stringify(nameMatches));
  const byContent = (await fsSearch.execute({ path: 'proj', contentContains: 'NEEDLE' }, ctx)) as R;
  const contentMatches = (byContent.matches ?? []) as Array<{ path: string }>;
  check('search by content is case-insensitive', contentMatches.some((m) => m.path.endsWith('other.md')));
  const noQ = (await fsSearch.execute({ path: '.' }, ctx)) as R;
  check('search without any query → clear error', /nameContains/.test(String(noQ.error)));

  console.log('— fs_open refusal paths (never launches anything in this smoke) —');
  writeFileSync(join(root, 'demo', 'danger.exe'), 'MZ-not-really');
  const exe = (await fsOpen.execute({ path: 'demo/danger.exe' }, ctx)) as R;
  check('fs_open refuses executables (allowlist, not blocklist)', /viewer-safe/.test(String(exe.error)), String(exe.error));
  writeFileSync(join(root, 'demo', 'script.ps1'), 'Write-Host hi');
  const ps1 = (await fsOpen.execute({ path: 'demo/script.ps1' }, ctx)) as R;
  check('fs_open refuses scripts', /viewer-safe/.test(String(ps1.error)));
  const escOpen = (await fsOpen.execute({ path: '..\\..\\Windows\\notepad.exe' }, ctx)) as R;
  check('fs_open escape rejected', /escapes the allowed root/.test(String(escOpen.error)));
  const missingOpen = (await fsOpen.execute({ path: 'demo/ghost.html' }, ctx)) as R;
  check('fs_open missing file → clear error', /not found/.test(String(missingOpen.error)));
} finally {
  process.env.AIOS_TERMINAL_ROOT = savedRoot;
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
