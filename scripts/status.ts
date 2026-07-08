// `pnpm status` — every department, green/red, at a glance. Read-only.
import { C, run, dockerDaemonUp, pgReady, httpJson, httpUp, pm2List, API, BRIDGE, WEB } from './ops.js';

const dot = (ok: boolean) => (ok ? C.green('● up') : C.red('● down'));
const line = (name: string, status: string, detail = '') => console.log(`  ${name.padEnd(20)} ${status}${detail ? '  ' + C.dim(detail) : ''}`);

console.log(C.bold('\nai-os status\n'));

// --- infra ---
const daemon = await dockerDaemonUp();
line('docker daemon', dot(daemon));
if (daemon) {
  // NOTE: no SPACE in the --format template — under Windows shell:true a space
  // splits it into two args and breaks the Go template. Use a spaceless separator.
  const ps = await run('docker', ['ps', '--filter', 'name=ai-os-', '--format', '{{.Names}}::{{.Status}}'], { timeoutMs: 12_000 });
  for (const c of ['postgres', 'redis', 'langfuse']) {
    const row = ps.out.split('\n').find((l) => l.includes(`ai-os-${c}-1`));
    const st = row?.split('::')[1] ?? '';
    line(`  ${c}`, dot(!!row && /Up/.test(st)), row ? st : 'not running');
  }
  line('  postgres ready', dot(await pgReady()));
}

// --- pm2 services ---
console.log();
const pm2 = await pm2List();
for (const [label, name] of [['api', 'ai-os-api'], ['whatsapp-bridge', 'ai-os-bridge'], ['web', 'ai-os-web']] as const) {
  const st = pm2[name];
  line(`pm2: ${label}`, st === 'online' ? C.green('● online') : st ? C.yellow(`● ${st}`) : C.red('● not managed'));
}

// --- live endpoints + department detail ---
console.log();
const api = await httpJson(`${API}/health`);
line('api /health', dot(api.ok), api.ok ? `milestone ${(api.body as { milestone?: string })?.milestone ?? '?'}` : '');
const bridge = await httpJson(`${BRIDGE}/health`);
const b = bridge.body as { paired?: boolean; needsRepair?: boolean; me?: string } | null;
line('whatsapp bridge', dot(bridge.ok),
  bridge.ok ? (b?.needsRepair ? C.yellow('NEEDS RE-PAIR') : b?.paired ? `paired +${b?.me}` : 'not paired') : '');
line('web', dot(await httpUp(WEB)));

// --- automations at a glance (proves the scheduler dept is alive) ---
if (api.ok) {
  const dash = await httpJson(`${API}/dashboard`);
  const d = dash.body as { activeTasks?: unknown[]; approvals?: unknown[]; jobs?: Array<{ name: string; last_run?: { status?: string } }> } | null;
  if (d) {
    console.log();
    line('active tasks', C.dim(String(d.activeTasks?.length ?? 0)));
    line('pending approvals', C.dim(String(d.approvals?.length ?? 0)));
    for (const j of d.jobs ?? []) line(`job: ${j.name}`.slice(0, 20), C.dim(j.last_run?.status ?? 'never run'));
  }
}
console.log();
