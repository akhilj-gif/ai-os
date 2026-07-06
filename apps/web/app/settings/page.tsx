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
interface ModelChain {
  pinned: string | null;
  chain: Array<{ name: string; position: string; models: { routing: string; execution: string; planning: string } }>;
}

const CLASSES: Policy['trust_class'][] = ['read', 'write', 'irreversible', 'spend'];

export default function SettingsPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [models, setModels] = useState<ModelChain | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, m] = await Promise.all([fetch('/api/policies'), fetch('/api/system/models')]);
      setPolicies(((await r.json()) as { policies: Policy[] }).policies);
      setModels((await m.json()) as ModelChain);
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

      {/* M8: models & failover (ADR-0011) — which provider serves each role, in order */}
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '32px 0 4px' }}>
        <h2 style={{ fontSize: 17, margin: 0 }}>Models &amp; failover</h2>
        <span style={{ color: '#4b78ff', fontSize: 11, letterSpacing: 2 }}>M8 · ADR-0011</span>
      </header>
      <p style={{ color: '#9aa0b5', fontSize: 13, marginTop: 0 }}>
        Calls try the primary first; on quota/rate-limit/network failures they fall over to the next provider immediately.
        {models?.pinned && <strong style={{ color: '#e0a13a' }}> Pinned to {models.pinned} (MODEL_PROVIDER) — failover off.</strong>}
      </p>
      <div style={{ display: 'grid', gap: 6 }}>
        {(models?.chain ?? []).map((p, i) => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 10, background: '#12141f', border: `1px solid ${i === 0 ? '#2c3f75' : '#23263a'}`, fontSize: 13 }}>
            <span style={{ fontWeight: 600, width: 80 }}>{p.name}</span>
            <span style={{ fontSize: 11, color: i === 0 ? '#4b78ff' : '#9aa0b5', border: '1px solid #2a2e45', borderRadius: 6, padding: '1px 8px' }}>{p.position}</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9aa0b5', fontFamily: 'ui-monospace, monospace' }}>
              route {p.models.routing} · exec {p.models.execution} · plan {p.models.planning}
            </span>
          </div>
        ))}
        {models && models.chain.length === 0 && <p style={{ color: '#f87171', fontSize: 13 }}>No providers configured.</p>}
      </div>
    </main>
  );
}
