// pnpm os:backup — the thing that makes a dead SSD survivable.
//
// Postgres holds 100% of the OS's irreplaceable state: every memory, the
// knowledge graph, sessions, tasks, and the Google OAuth tokens. None of it is
// reconstructible from the repo. Until now it lived in exactly ONE Docker volume
// on ONE laptop with no copy anywhere.
//
//   pnpm os:backup            → dump to AIOS_BACKUP_DIR, prune old dumps
//   pnpm os:backup --verify   → dump, then PROVE it by restoring into a scratch
//                               database and comparing row counts
//
// Custom format (-Fc) so a single table can be restored selectively later.
// Dumps live OUTSIDE the repo by design — a backup inside a gitignored folder in
// the thing you are backing up is not a backup.
import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { C } from './ops.js';

const CONTAINER = process.env.AIOS_PG_CONTAINER ?? 'ai-os-postgres-1';
const DB = process.env.AIOS_PG_DB ?? 'aios';
const USER = process.env.AIOS_PG_USER ?? 'postgres';
const DIR = process.env.AIOS_BACKUP_DIR ?? join(homedir(), 'AIOS-Backups');
const KEEP = Number(process.env.AIOS_BACKUP_KEEP) || 7;
// Tables whose row counts must survive the round-trip for a restore to count as
// proven. pgvector columns live on memory_records — the classic restore trap.
const WITNESS = ['memory_records', 'tasks', 'kg_nodes', 'messages', 'oauth_tokens'];

/** Run a docker command, streaming stdout to a file (binary-safe: no shell). */
function dumpTo(file: string): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    const out = createWriteStream(file);
    const child = spawn('docker', ['exec', CONTAINER, 'pg_dump', '-Fc', '-U', USER, DB], { windowsHide: true });
    let err = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ ok: false, err: e.message }));
    child.on('close', (code) => out.close(() => resolve({ ok: code === 0, err: err.trim() })));
  });
}

/** psql -c, capturing output. */
function psql(sql: string, db = DB): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', CONTAINER, 'psql', '-U', USER, '-d', db, '-t', '-A', '-c', sql], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ ok: false, out: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }));
  });
}

/** Feed a dump file into pg_restore inside the container via stdin. */
function restoreFrom(file: string, db: string): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', '-i', CONTAINER, 'pg_restore', '-U', USER, '-d', db, '--no-owner', '--no-privileges'], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ ok: false, err: e.message }));
    // pg_restore exits non-zero on benign warnings; the row-count check is the real gate.
    child.on('close', () => resolve({ ok: true, err: err.trim() }));
    createReadStream(file).pipe(child.stdin);
  });
}

async function counts(db: string): Promise<Record<string, number>> {
  const sql = WITNESS.map((t) => `SELECT '${t}' t, count(*) n FROM ${t}`).join(' UNION ALL ');
  const r = await psql(sql, db);
  const out: Record<string, number> = {};
  for (const line of r.out.split('\n')) {
    const [t, n] = line.split('|');
    if (t && n !== undefined) out[t.trim()] = Number(n.trim());
  }
  return out;
}

async function main(): Promise<void> {
  const verify = process.argv.includes('--verify');
  mkdirSync(DIR, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 10);
  const file = join(DIR, `aios-${stamp}.dump`);
  process.stdout.write(`▶ dumping ${DB} → ${file}\n`);
  const d = await dumpTo(file);
  const size = statSync(file).size;
  if (!d.ok || size < 1024) {
    console.log(C.red(`✗ backup FAILED (${size} bytes) ${d.err}`));
    process.exit(1);
  }
  console.log(C.green(`✓ dumped ${(size / 1024 / 1024).toFixed(1)} MB`));

  // Prune: keep the newest KEEP dumps.
  const old = readdirSync(DIR)
    .filter((f) => f.startsWith('aios-') && f.endsWith('.dump'))
    .sort()
    .slice(0, -KEEP);
  for (const f of old) {
    try {
      unlinkSync(join(DIR, f));
      console.log(C.dim(`  pruned ${f}`));
    } catch {
      /* ignore */
    }
  }

  if (!verify) {
    console.log(C.dim(`  ${KEEP}-dump retention · verify a restore with: pnpm os:backup --verify`));
    return;
  }

  // ---- Prove it restores. An unverified backup is a guess. ----
  const scratch = 'aios_restore_verify';
  process.stdout.write('\n▶ verifying by restoring into a scratch database\n');
  const source = await counts(DB);
  await psql(`DROP DATABASE IF EXISTS ${scratch}`, 'postgres');
  const created = await psql(`CREATE DATABASE ${scratch}`, 'postgres');
  if (!created.ok) {
    console.log(C.red(`✗ could not create ${scratch}: ${created.out}`));
    process.exit(1);
  }
  // THE TRAP: pgvector must exist BEFORE restore or every embedding column fails.
  await psql('CREATE EXTENSION IF NOT EXISTS vector', scratch);
  const r = await restoreFrom(file, scratch);
  const restored = await counts(scratch);

  let bad = 0;
  for (const t of WITNESS) {
    const a = source[t] ?? -1;
    const b = restored[t] ?? -1;
    const ok = a >= 0 && a === b;
    if (!ok) bad++;
    console.log(`  ${ok ? C.green('✓') : C.red('✗')} ${t}: source ${a} · restored ${b}`);
  }
  await psql(`DROP DATABASE IF EXISTS ${scratch}`, 'postgres');

  if (bad) {
    console.log(C.red(`\n✗ RESTORE NOT PROVEN — ${bad} table(s) mismatched. ${r.err.slice(0, 300)}`));
    process.exit(1);
  }
  console.log(C.green('\n✓ restore proven — every witness table round-tripped, pgvector included'));
}

await main();
