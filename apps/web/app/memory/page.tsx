'use client';
// Memory browser (blueprint §7.2): every record with its source + a delete button.
// Trust requires inspectability — you can see and remove anything the OS remembers.
import { useCallback, useEffect, useState } from 'react';

interface Rec {
  id: string;
  type: string;
  content: string;
  source: { task_id?: string; tool_call_id?: string; user_stated?: boolean };
  confidence: number;
  subject: string | null;
  tags: string[];
  created_at: string;
  last_confirmed_at: string;
  superseded_by: string | null;
}

const TYPE_COLORS: Record<string, string> = {
  preference: '#4b78ff',
  semantic: '#22a06b',
  procedural: '#b57edc',
  project: '#e0a13a',
  episodic: '#8a8f9c',
  document: '#3a9bd6',
};

function sourceLabel(s: Rec['source']): string {
  if (s.user_stated) return 'you stated';
  if (s.task_id) return `task ${s.task_id.slice(0, 8)}`;
  if (s.tool_call_id) return `tool ${s.tool_call_id.slice(0, 8)}`;
  return 'unknown';
}

export default function MemoryPage() {
  const [records, setRecords] = useState<Rec[]>([]);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/memory?includeSuperseded=${showSuperseded}`);
      const data = (await res.json()) as { records: Rec[] };
      setRecords(data.records);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [showSuperseded]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function del(id: string) {
    await fetch(`/api/memory/${id}`, { method: 'DELETE' });
    setRecords((r) => r.filter((x) => x.id !== id));
  }

  const active = records.filter((r) => !r.superseded_by);

  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '24px 16px 80px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Memory</h1>
        <span style={{ color: '#4b78ff', fontSize: 11, letterSpacing: 2 }}>M3</span>
        <a href="/" style={{ marginLeft: 'auto', fontSize: 13, color: '#9aa0b5' }}>← chat</a>
      </header>
      <p style={{ color: '#9aa0b5', fontSize: 13, marginTop: 0 }}>
        Everything the OS remembers about you, with its source. Delete anything — trust requires inspectability.
      </p>

      <label style={{ fontSize: 12, color: '#9aa0b5', display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0 18px' }}>
        <input type="checkbox" checked={showSuperseded} onChange={(e) => setShowSuperseded(e.target.checked)} />
        show superseded (the auditable history)
      </label>

      {loaded && active.length === 0 && (
        <p style={{ color: '#565c72', fontSize: 14 }}>No memories yet. Tell the assistant a preference and it&rsquo;ll appear here.</p>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {records.map((r) => (
          <div
            key={r.id}
            style={{
              padding: '12px 14px',
              borderRadius: 10,
              background: r.superseded_by ? '#0f1016' : '#14162200',
              border: `1px solid ${r.superseded_by ? '#23263a' : '#2a2e45'}`,
              opacity: r.superseded_by ? 0.5 : 1,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: TYPE_COLORS[r.type] ?? '#9aa0b5',
                  border: `1px solid ${TYPE_COLORS[r.type] ?? '#9aa0b5'}55`,
                  borderRadius: 5,
                  padding: '1px 7px',
                }}
              >
                {r.type}
              </span>
              {r.subject && <span style={{ fontSize: 11, color: '#9aa0b5' }}>· {r.subject}</span>}
              <span style={{ fontSize: 11, color: '#565c72' }}>· conf {r.confidence.toFixed(2)}</span>
              <span style={{ fontSize: 11, color: '#565c72' }}>· from {sourceLabel(r.source)}</span>
              {r.superseded_by && <span style={{ fontSize: 11, color: '#e0a13a' }}>· superseded</span>}
              <button
                onClick={() => void del(r.id)}
                style={{
                  marginLeft: 'auto',
                  fontSize: 12,
                  background: 'transparent',
                  border: '1px solid #5c2a33',
                  color: '#f87171',
                  borderRadius: 6,
                  padding: '2px 10px',
                  cursor: 'pointer',
                }}
              >
                delete
              </button>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>{r.content}</div>
          </div>
        ))}
      </div>
    </main>
  );
}
