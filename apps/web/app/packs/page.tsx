'use client';
// Capability Packs (M9, ADR-0012): the OS's capability surface as installable,
// toggleable manifests. The kernel is domain-free — everything domain-shaped
// (Google, the internet, code exec, support-ops) lives here.
import { useCallback, useEffect, useState } from 'react';

interface Pack {
  name: string; version: string; description: string;
  installed: boolean; enabled: boolean; installedVersion?: string;
  tools: string[]; evalSuites: string[]; verifiedBy?: string; requires?: string[];
}

const card = { padding: 14, borderRadius: 12, border: '1px solid #23263a', background: '#0e101a' } as const;

export default function PacksPage() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastInstall, setLastInstall] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/packs');
      setPacks(((await r.json()) as { packs: Pack[] }).packs);
    } catch { /* kernel offline */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function install(name: string) {
    setBusy(name);
    try {
      const r = await fetch(`/api/packs/${name}/install`, { method: 'POST' });
      const d = (await r.json()) as { policiesApplied: number; memoriesSeeded: number; memoryWarning?: string };
      setLastInstall(`${name} installed — ${d.policiesApplied} policies applied, ${d.memoriesSeeded} memories seeded${d.memoryWarning ? ` (${d.memoryWarning})` : ''}`);
      await refresh();
    } finally { setBusy(null); }
  }
  async function toggle(p: Pack) {
    setBusy(p.name);
    try {
      await fetch(`/api/packs/${p.name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !p.enabled }) });
      await refresh();
    } finally { setBusy(null); }
  }

  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '24px 16px 80px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Capability packs</h1>
        <span style={{ color: '#4b78ff', fontSize: 11, letterSpacing: 2 }}>M9 · THE OS GOES PERSONAL</span>
        <a href="/dashboard" style={{ marginLeft: 'auto', fontSize: 13, color: '#9aa0b5' }}>← dashboard</a>
        <a href="/settings" style={{ fontSize: 13, color: '#9aa0b5' }}>settings →</a>
      </header>
      <p style={{ color: '#9aa0b5', fontSize: 13, marginTop: 0 }}>
        The kernel is domain-free — every capability (tools, prompts, procedural memories, policies, evals) installs as a pack.
        Disabling a pack removes its tools from every future task immediately.
      </p>
      {lastInstall && <p style={{ fontSize: 13, color: '#22a06b', border: '1px solid #1f4d38', borderRadius: 8, padding: '8px 12px' }}>{lastInstall}</p>}

      <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        {packs.map((p) => (
          <section key={p.name} style={{ ...card, opacity: p.installed && !p.enabled ? 0.6 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <strong style={{ fontSize: 15 }}>{p.name}</strong>
              <span style={{ fontSize: 11, color: '#565c72' }}>v{p.version}</span>
              {p.installed ? (
                <span style={{ fontSize: 11, color: p.enabled ? '#22a06b' : '#9aa0b5', border: `1px solid ${p.enabled ? '#1f4d38' : '#2a2e45'}`, borderRadius: 6, padding: '1px 8px' }}>
                  {p.enabled ? '● enabled' : '○ disabled'}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: '#e0a13a', border: '1px solid #7a5a1e', borderRadius: 6, padding: '1px 8px' }}>not installed</span>
              )}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {!p.installed && (
                  <button onClick={() => void install(p.name)} disabled={busy === p.name}
                    style={{ padding: '5px 14px', borderRadius: 8, border: 'none', background: '#4b78ff', color: '#fff', fontSize: 13, cursor: 'pointer' }}>
                    {busy === p.name ? 'installing…' : '⬇ install'}
                  </button>
                )}
                {p.installed && (
                  <button onClick={() => void toggle(p)} disabled={busy === p.name}
                    style={{ padding: '5px 14px', borderRadius: 8, border: '1px solid #2a2e45', background: 'transparent', color: '#9aa0b5', fontSize: 13, cursor: 'pointer' }}>
                    {p.enabled ? 'disable' : 'enable'}
                  </button>
                )}
              </span>
            </div>
            <p style={{ fontSize: 13, color: '#cfd3e0', margin: '8px 0' }}>{p.description}</p>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: '#9aa0b5' }}>
              <span>tools: {p.tools.length ? p.tools.map((t) => <code key={t} style={{ fontFamily: 'ui-monospace, monospace', marginRight: 6 }}>{t}</code>) : '(none yet)'}</span>
              {p.evalSuites.length > 0 && <span>evals: {p.evalSuites.join(', ')}</span>}
              {p.verifiedBy && <span style={{ color: '#22a06b' }}>✓ {p.verifiedBy}</span>}
            </div>
            {p.requires && p.requires.length > 0 && (
              <div style={{ fontSize: 12, color: '#e0a13a', marginTop: 6 }}>requires: {p.requires.join(' · ')}</div>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
