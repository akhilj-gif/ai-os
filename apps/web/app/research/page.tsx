'use client';
// Research engine (M6): ask a question → a cited report synthesized over fetched
// web sources. Read-only and inherently safe; sources are shown so every claim
// is checkable (inspectability).
import { useCallback, useEffect, useState } from 'react';

interface Source { n: number; title: string; url: string }
interface ReportListItem { id: string; question: string; status: string; sources: Source[]; created_at: string }
interface Report { id: string; question: string; report: string; sources: Source[]; status: string }

export default function ResearchPage() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<ReportListItem[]>([]);
  const [current, setCurrent] = useState<Report | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/research');
      setList(((await r.json()) as { reports: ReportListItem[] }).reports);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function open(id: string) {
    const r = await fetch(`/api/research/${id}`);
    setCurrent((await r.json()) as Report);
  }

  async function ask() {
    if (!q.trim() || busy) return;
    setBusy(true);
    setCurrent(null);
    try {
      const r = await fetch('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) });
      const d = (await r.json()) as Report;
      setCurrent(d);
      setQ('');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px 80px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Research</h1>
        <span style={{ color: '#4b78ff', fontSize: 11, letterSpacing: 2 }}>M6 · INTERNET ENGINE</span>
        <a href="/" style={{ marginLeft: 'auto', fontSize: 13, color: '#9aa0b5' }}>← chat</a>
        <a href="/tasks" style={{ fontSize: 13, color: '#9aa0b5' }}>tasks →</a>
      </header>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void ask()}
          placeholder="Ask a research question — it searches, reads sources, and cites them…"
          style={{ flex: 1, padding: '10px 14px', borderRadius: 10, border: '1px solid #2a2e45', background: '#12141f', color: '#e6e8f0', fontSize: 14, outline: 'none' }}
        />
        <button onClick={() => void ask()} disabled={busy} style={{ padding: '0 20px', borderRadius: 10, border: 'none', background: busy ? '#2a2e45' : '#4b78ff', color: '#fff', fontSize: 14, cursor: 'pointer' }}>
          {busy ? 'researching…' : 'Research'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16 }}>
        <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
          {list.map((r) => (
            <button key={r.id} onClick={() => void open(r.id)} style={{ textAlign: 'left', padding: '8px 10px', borderRadius: 8, background: current?.id === r.id ? '#1d2c55' : '#12141f', border: `1px solid ${current?.id === r.id ? '#2c3f75' : '#23263a'}`, color: '#e6e8f0', cursor: 'pointer' }}>
              <div style={{ fontSize: 11, color: r.status === 'done' ? '#22a06b' : '#f87171' }}>● {r.status} · {r.sources?.length ?? 0} sources</div>
              <div style={{ fontSize: 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.question}</div>
            </button>
          ))}
        </div>

        <div>
          {busy && <p style={{ color: '#9aa0b5', fontSize: 14 }}>⏳ searching the web, reading sources, and synthesizing a cited answer…</p>}
          {!busy && !current && <p style={{ color: '#565c72', fontSize: 14 }}>Ask a question, or open a past report.</p>}
          {current && (
            <article>
              <h2 style={{ fontSize: 17, marginTop: 0 }}>{current.question}</h2>
              <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{current.report}</div>
              {current.sources?.length > 0 && (
                <div style={{ marginTop: 20, borderTop: '1px solid #23263a', paddingTop: 12 }}>
                  <div style={{ fontSize: 12, color: '#9aa0b5', marginBottom: 6 }}>Sources</div>
                  {current.sources.map((s) => (
                    <div key={s.n} style={{ fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: '#565c72' }}>[{s.n}]</span>{' '}
                      <a href={s.url} target="_blank" rel="noreferrer" style={{ color: '#4b78ff' }}>{s.title || s.url}</a>
                    </div>
                  ))}
                </div>
              )}
            </article>
          )}
        </div>
      </div>
    </main>
  );
}
