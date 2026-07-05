'use client';
// Trust policies (M5, blueprint §8.1): policies are DATA, not code. Tighten or
// loosen any tool's class / auto-approval. Tightening a tool to require approval
// routes it through the M4 approval flow.
import { useCallback, useEffect, useState } from 'react';

interface Policy {
  tool: string;
  trust_class: 'read' | 'write' | 'irreversible' | 'spend';
  auto_approve: boolean;
}

const CLASSES: Policy['trust_class'][] = ['read', 'write', 'irreversible', 'spend'];

export default function SettingsPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/policies');
      setPolicies(((await r.json()) as { policies: Policy[] }).policies);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function update(tool: string, patch: Partial<Pick<Policy, 'trust_class' | 'auto_approve'>>) {
    await fetch(`/api/policies/${tool}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trustClass: patch.trust_class, autoApprove: patch.auto_approve }),
    });
    await refresh();
  }

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px 80px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Trust policies</h1>
        <span style={{ color: '#4b78ff', fontSize: 11, letterSpacing: 2 }}>M5</span>
        <a href="/tasks" style={{ marginLeft: 'auto', fontSize: 13, color: '#9aa0b5' }}>tasks →</a>
      </header>
      <p style={{ color: '#9aa0b5', fontSize: 13, marginTop: 0 }}>
        Per-tool action class and auto-approval. Read = auto; write = auto+logged; irreversible/spend = approval.
        Untrusted content can never trigger a mutating tool regardless of these (§8.3).
      </p>

      <div style={{ display: 'grid', gap: 6, marginTop: 16 }}>
        {policies.map((p) => (
          <div key={p.tool} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, background: '#12141f', border: '1px solid #23263a' }}>
            <span style={{ fontSize: 14, fontFamily: 'ui-monospace, monospace', flex: 1 }}>{p.tool}</span>
            <select
              value={p.trust_class}
              onChange={(e) => void update(p.tool, { trust_class: e.target.value as Policy['trust_class'] })}
              style={{ background: '#0f1016', color: '#e6e8f0', border: '1px solid #2a2e45', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
            >
              {CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label style={{ fontSize: 12, color: '#9aa0b5', display: 'flex', gap: 5, alignItems: 'center' }}>
              <input type="checkbox" checked={p.auto_approve} onChange={(e) => void update(p.tool, { auto_approve: e.target.checked })} />
              auto
            </label>
          </div>
        ))}
      </div>
    </main>
  );
}
