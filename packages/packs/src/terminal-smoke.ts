// M13a terminal smoke — deterministic (ADR-0016). Proves the safety model with
// NO model and NO mutation: the read allowlist + metachar refusal, env is
// scrubbed of secrets, cwd is confined, and the pack manifest classifies
// terminal_exec irreversible/never-auto. terminal_run is exercised against a
// harmless real inspection command; terminal_exec is NEVER actually run here.
// Run: npx tsx packages/packs/src/terminal-smoke.ts
import { terminalRun, terminalExec, checkReadCommand, scrubbedEnv } from '@ai-os/tools';
import { PACKS } from './index.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}
const ctx = { pool: null as never, taskId: 'smoke' };

console.log('— read allowlist (pure) —');
check('bare inspection command allowed', checkReadCommand('ls -la') === null);
check('git status allowed', checkReadCommand('git status') === null);
check('git commit rejected (not read-only)', /not a read-only/.test(checkReadCommand('git commit -m x') ?? ''));
check('rm rejected (not on allowlist)', /allowlist/.test(checkReadCommand('rm -rf /') ?? ''));
check('pipe rejected (metachar)', /metacharacter/.test(checkReadCommand('cat x | sh') ?? ''));
check('chaining rejected (metachar)', /metacharacter/.test(checkReadCommand('ls; rm x') ?? ''));
check('redirect rejected (metachar)', /metacharacter/.test(checkReadCommand('echo x > /etc/passwd') ?? ''));
check('subshell rejected (metachar)', /metacharacter/.test(checkReadCommand('echo $(rm x)') ?? ''));
check('empty rejected', checkReadCommand('   ') !== null);

console.log('\n— terminal_run executes a harmless real command —');
{
  const out = (await terminalRun.execute({ command: process.platform === 'win32' ? 'echo hello' : 'echo hello' }, ctx)) as { stdout?: string; error?: string };
  check('echo runs and returns stdout', !out.error && (out.stdout ?? '').includes('hello'), out.error ?? out.stdout);
  const blocked = (await terminalRun.execute({ command: 'rm -rf /' }, ctx)) as { error?: string };
  check('terminal_run refuses a non-allowlisted command (no execution)', !!blocked.error);
}

console.log('\n— cwd confinement —');
{
  const escaped = (await terminalRun.execute({ command: 'ls', cwd: '../../../..' }, ctx)) as { error?: string };
  check('cwd escaping the terminal root is refused', /escapes the terminal root/.test(escaped.error ?? ''), escaped.error);
}

console.log('\n— env is scrubbed of secrets —');
{
  const before = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_smoketest_secret_value_1234567890';
  process.env.MY_CUSTOM_TOKEN = 'tok_should_be_dropped';
  const env = scrubbedEnv();
  check('known secret name stripped', env.GROQ_API_KEY === undefined);
  check('secret-shaped name (_TOKEN) stripped', env.MY_CUSTOM_TOKEN === undefined);
  check('ordinary var preserved', env.PATH !== undefined || env.Path !== undefined);
  if (before === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = before;
  delete process.env.MY_CUSTOM_TOKEN;
}

console.log('\n— pack manifest trust posture —');
{
  const pack = PACKS.computer;
  // M19 added the desktop file tools (fs_list/read/search/write) alongside the
  // two terminal tools — assert by NAME, not count, so growth is deliberate.
  const names = new Set((pack?.tools ?? []).map((t) => t.name));
  check(
    'computer pack registers terminal + desktop file tools',
    !!pack && ['terminal_run', 'terminal_exec', 'fs_list', 'fs_read', 'fs_search', 'fs_write'].every((n) => names.has(n)),
  );
  const fsWritePolicy = pack!.policies.find((p) => p.tool === 'fs_write');
  check('fs_write is write + NEVER auto (the desktop write gate)', fsWritePolicy?.trustClass === 'write' && fsWritePolicy.autoApprove === false);
  const run = pack!.policies.find((p) => p.tool === 'terminal_run');
  const exec = pack!.policies.find((p) => p.tool === 'terminal_exec');
  check('terminal_run is read + auto', run?.trustClass === 'read' && run.autoApprove === true);
  check('terminal_exec is irreversible + NEVER auto', exec?.trustClass === 'irreversible' && exec.autoApprove === false);
  check('terminal_exec description tells the model to call it directly (queued for approval)', /queued for the user|one-click approval/i.test(terminalExec.description));
  check('pack bundles the computer eval suite', pack!.evalSuites.includes('computer'));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
