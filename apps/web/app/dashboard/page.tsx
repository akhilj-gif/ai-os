'use client';
// M8 OS Interface, slice 1: the single screen from which a day's work is
// manageable without raw logs — live tasks, the GLOBAL approvals inbox
// (one-click approve/reject → <30s round-trip), spend, notifications, jobs.
import { useCallback, useEffect, useState } from 'react';

interface Approval { step_id: string; task_id: string; title: string | null; tool: string | null; tool_args: Record<string, unknown> | null; goal: string; created_at: string }
interface TaskRow { id: string; goal: string; status: string; spent: { tokens?: number }; updated_at: string }
interface JobRow { id: string; name: string; kind: string; enabled: boolean; next_run_at: string | null; last_run: { status: string; started_at: string } | null }
interface Dash {
  approvals: Approval[];
  activeTasks: TaskRow[];
  recentTasks: TaskRow[];
  notifications: { unread: number; latest: Array<{ id: string; kind: string; title: string; read: boolean; created_at: string; meta?: { taskId?: string; stepId?: string } }> };
  jobs: JobRow[];
  spend: { todayTokens: number; totalTokens: number };
  taskCounts: Record<string, number>;
}

const STATUS_COLOR: Record<string, string> = {
  done: '#22a06b', running: '#4b78ff', planning: '#4b78ff', awaiting_approval: '#e0a13a',
  paused: '#b57edc', failed: '#f87171', draft: '#565c72', deferred: '#f5a623', missed: '#9aa0b5',
};
const card = { padding: 14, borderRadius: 12, border: '1px solid #23263a', background: '#0e101a' } as const;
const h2 = { fontSize: 13, color: '#9aa0b5', margin: '0 0 10px', letterSpacing: 0.4, textTransform: 'uppercase' } as const;

export default function DashboardPage() {
  const [d, setD] = useState<Dash | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/dashboard');
      setD((await r.json()) as Dash);
    } catch { /* kernel offline */ }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function decide(a: Approval, decision: 'approved' | 'rejected') {
    setBusy(a.step_id);
    try {
      await fetch(`/api/tasks/${a.task_id}/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stepId: a.step_id, decision }),
      });
      await refresh();
    } finally { setBusy(null); }
  }

  if (!d) return <main style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}><p style={{ color: '#565c72' }}>loading dashboard…</p></main>;

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px 80px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Dashboard</h1>
        <span style={{ color: '#4b78ff', fontSize: 11, letterSpacing: 2 }}>M8 · OS INTERFACE</span>
        <a href="/" style={{ marginLeft: 'auto', fontSize: 13, color: '#9aa0b5' }}>← chat</a>
        <a href="/tasks" style={{ fontSize: 13, color: '#9aa0b5' }}>tasks</a>
        <a href="/automations" style={{ fontSize: 13, color: '#9aa0b5' }}>automations</a>
        <a href="/packs" style={{ fontSize: 13, color: '#9aa0b5' }}>packs</a>
        <a href="/memory" style={{ fontSize: 13, color: '#9aa0b5' }}>memory</a>
      </header>

      {/* status strip */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, fontSize: 13 }}>
        <span style={{ ...card, padding: '8px 14px' }}>⚡ active: <strong>{d.activeTasks.length}</strong></span>
        <span style={{ ...card, padding: '8px 14px', borderColor: d.approvals.length ? '#7a5a1e' : '#23263a' }}>
          ⏳ approvals: <strong style={{ color: d.approvals.length ? '#e0a13a' : undefined }}>{d.approvals.length}</strong>
        </span>
        <span style={{ ...card, padding: '8px 14px' }}>🔔 unread: <strong>{d.notifications.unread}</strong></span>
        <span style={{ ...card, padding: '8px 14px' }}>🪙 tokens today: <strong>{d.spend.todayTokens.toLocaleString()}</strong> · total {d.spend.totalTokens.toLocaleString()}</span>
        <span style={{ ...card, padding: '8px 14px' }}>✅ done: {d.taskCounts.done ?? 0} · ❌ failed: {d.taskCounts.failed ?? 0}</span>
      </div>

      {/* approvals inbox — the M8 <30s round-trip */}
      <section style={{ ...card, marginBottom: 16, borderColor: d.approvals.length ? '#7a5a1e' : '#23263a' }}>
        <h2 style={h2}>Approvals inbox</h2>
        {d.approvals.length === 0 && <p style={{ color: '#565c72', fontSize: 13, margin: 0 }}>Nothing waiting on you.</p>}
        {d.approvals.map((a) => (
          <div key={a.step_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid #1a1d2e' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14 }}>{a.title ?? 'approval'}</div>
              <div style={{ fontSize: 12, color: '#9aa0b5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                task: <a href={`/tasks/${a.task_id}`} style={{ color: '#4b78ff' }}>{a.goal}</a>
                {a.tool ? <span style={{ color: '#565c72' }}> · gates {a.tool}({JSON.stringify(a.tool_args ?? {}).slice(0, 60)})</span> : null}
              </div>
            </div>
            <button onClick={() => void decide(a, 'approved')} disabled={busy === a.step_id}
              style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: '#1f7a4d', color: '#fff', fontSize: 13, cursor: 'pointer' }}>
              ✓ approve
            </button>
            <button onClick={() => void decide(a, 'rejected')} disabled={busy === a.step_id}
              style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid #5a2430', background: 'transparent', color: '#f87171', fontSize: 13, cursor: 'pointer' }}>
              ✕ reject
            </button>
          </div>
        ))}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* live + recent tasks */}
        <section style={card}>
          <h2 style={h2}>Tasks</h2>
          {d.activeTasks.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {d.activeTasks.map((t) => (
                <a key={t.id} href={`/tasks/${t.id}`} style={{ display: 'flex', gap: 8, padding: '6px 0', fontSize: 13, color: '#e6e8f0', textDecoration: 'none', borderTop: '1px solid #1a1d2e' }}>
                  <span style={{ color: STATUS_COLOR[t.status] ?? '#9aa0b5' }}>●</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.goal}</span>
                  <span style={{ color: STATUS_COLOR[t.status] ?? '#9aa0b5', fontSize: 12 }}>{t.status}</span>
                </a>
              ))}
            </div>
          )}
          <div style={{ fontSize: 12, color: '#565c72', marginBottom: 4 }}>recent</div>
          {d.recentTasks.map((t) => (
            <a key={t.id} href={`/tasks/${t.id}`} style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: 13, color: '#cfd3e0', textDecoration: 'none', borderTop: '1px solid #1a1d2e' }}>
              <span style={{ color: STATUS_COLOR[t.status] ?? '#9aa0b5' }}>●</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.goal}</span>
              <span style={{ color: '#565c72', fontSize: 12 }}>{(t.spent?.tokens ?? 0).toLocaleString()} tok</span>
            </a>
          ))}
        </section>

        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          {/* automations at a glance */}
          <section style={card}>
            <h2 style={h2}>Automations</h2>
            {d.jobs.map((j) => (
              <div key={j.id} style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: 13, borderTop: '1px solid #1a1d2e', opacity: j.enabled ? 1 : 0.5 }}>
                <span style={{ flex: 1 }}>{j.name}</span>
                {j.last_run && <span style={{ color: STATUS_COLOR[j.last_run.status] ?? '#9aa0b5', fontSize: 12 }}>last: {j.last_run.status}</span>}
                <span style={{ color: '#565c72', fontSize: 12 }}>next: {j.next_run_at ? new Date(j.next_run_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
              </div>
            ))}
            <a href="/automations" style={{ fontSize: 12, color: '#4b78ff' }}>manage →</a>
          </section>

          {/* notifications */}
          <section style={card}>
            <h2 style={h2}>Notifications {d.notifications.unread > 0 && <span style={{ color: '#f5a623' }}>({d.notifications.unread} unread)</span>}</h2>
            {d.notifications.latest.length === 0 && <p style={{ color: '#565c72', fontSize: 13, margin: 0 }}>None yet.</p>}
            {d.notifications.latest.map((n) => (
              <div key={n.id} style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: 13, borderTop: '1px solid #1a1d2e', alignItems: 'center' }}>
                {!n.read && <span style={{ color: '#f5a623', fontSize: 10 }}>●</span>}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
                {n.kind === 'approval' && !n.read && n.meta?.taskId && n.meta?.stepId ? (
                  // M8: approvals answerable from the notification itself
                  <span style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => void decide({ step_id: n.meta!.stepId!, task_id: n.meta!.taskId!, title: n.title, tool: null, tool_args: null, goal: '', created_at: n.created_at }, 'approved')}
                      style={{ padding: '2px 10px', borderRadius: 6, border: 'none', background: '#1f7a4d', color: '#fff', fontSize: 12, cursor: 'pointer' }}>✓</button>
                    <button onClick={() => void decide({ step_id: n.meta!.stepId!, task_id: n.meta!.taskId!, title: n.title, tool: null, tool_args: null, goal: '', created_at: n.created_at }, 'rejected')}
                      style={{ padding: '2px 10px', borderRadius: 6, border: '1px solid #5a2430', background: 'transparent', color: '#f87171', fontSize: 12, cursor: 'pointer' }}>✕</button>
                  </span>
                ) : (
                  <span style={{ color: '#565c72', fontSize: 12 }}>{new Date(n.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                )}
              </div>
            ))}
            <a href="/automations" style={{ fontSize: 12, color: '#4b78ff' }}>open feed →</a>
          </section>
        </div>
      </div>
    </main>
  );
}
