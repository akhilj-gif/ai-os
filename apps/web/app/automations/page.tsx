'use client';
// Automations (M7): scheduled jobs (morning briefing, watch-flows, reflection) +
// the notifications feed — the OS's proactivity surface. Jobs are fixed read-only
// pipelines; everything an unattended run produces lands here, inspectable.
import { useCallback, useEffect, useState } from 'react';

interface LastRun { status: string; started_at: string; finished_at?: string; error?: string; output?: { summary?: string } }
interface Job {
  id: string; name: string; kind: string; enabled: boolean;
  schedule: { kind: string; time?: string; minutes?: number; at?: string };
  payload: { url?: string }; next_run_at: string | null; last_run: LastRun | null;
}
interface Notification { id: string; kind: string; title: string; body: string; read: boolean; created_at: string }

const STATUS_COLOR: Record<string, string> = { done: '#22a06b', running: '#4b78ff', failed: '#f87171', deferred: '#f5a623', missed: '#9aa0b5' };

function scheduleLabel(s: Job['schedule']): string {
  if (s.kind === 'daily') return `daily @ ${s.time}`;
  if (s.kind === 'interval') return `every ${s.minutes}m`;
  if (s.kind === 'once') return `once @ ${new Date(s.at!).toLocaleString()}`;
  return JSON.stringify(s);
}

export default function AutomationsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [openNotif, setOpenNotif] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // create form
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'briefing' | 'watch' | 'reflect'>('briefing');
  const [time, setTime] = useState('07:30');
  const [schedKind, setSchedKind] = useState<'daily' | 'interval'>('daily');
  const [minutes, setMinutes] = useState(60);
  const [url, setUrl] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [j, n] = await Promise.all([fetch('/api/jobs'), fetch('/api/notifications')]);
      setJobs(((await j.json()) as { jobs: Job[] }).jobs);
      setNotifs(((await n.json()) as { notifications: Notification[] }).notifications);
    } catch { /* kernel offline */ }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15000);
    return () => clearInterval(t);
  }, [refresh]);

  async function create() {
    if (!name.trim()) return;
    setBusy('create');
    try {
      const schedule = schedKind === 'daily' ? { kind: 'daily', time } : { kind: 'interval', minutes };
      const payload = kind === 'watch' ? { url } : {};
      await fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, kind, schedule, payload }) });
      setName(''); setUrl('');
      await refresh();
    } finally { setBusy(null); }
  }
  async function runNow(id: string) {
    setBusy(id);
    try { await fetch(`/api/jobs/${id}/run-now`, { method: 'POST' }); await refresh(); } finally { setBusy(null); }
  }
  async function toggle(j: Job) {
    await fetch(`/api/jobs/${j.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !j.enabled }) });
    await refresh();
  }
  async function remove(id: string) {
    await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
    await refresh();
  }
  async function markRead(id: string) {
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    await refresh();
  }

  const inputStyle = { padding: '8px 10px', borderRadius: 8, border: '1px solid #2a2e45', background: '#12141f', color: '#e6e8f0', fontSize: 13, outline: 'none' } as const;

  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: '24px 16px 80px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Automations</h1>
        <span style={{ color: '#4b78ff', fontSize: 11, letterSpacing: 2 }}>M7 · PROACTIVITY</span>
        <a href="/" style={{ marginLeft: 'auto', fontSize: 13, color: '#9aa0b5' }}>← chat</a>
        <a href="/research" style={{ fontSize: 13, color: '#9aa0b5' }}>research →</a>
      </header>

      {/* create */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: 12, borderRadius: 10, border: '1px solid #23263a', background: '#0e101a', marginBottom: 20 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="job name…" style={{ ...inputStyle, width: 180 }} />
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} style={inputStyle}>
          <option value="briefing">briefing (inbox+calendar)</option>
          <option value="watch">watch a URL</option>
          <option value="reflect">memory reflection</option>
        </select>
        {kind === 'watch' && <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" style={{ ...inputStyle, width: 220 }} />}
        <select value={schedKind} onChange={(e) => setSchedKind(e.target.value as typeof schedKind)} style={inputStyle}>
          <option value="daily">daily at</option>
          <option value="interval">every N minutes</option>
        </select>
        {schedKind === 'daily'
          ? <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="07:30" style={{ ...inputStyle, width: 70 }} />
          : <input type="number" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} style={{ ...inputStyle, width: 70 }} />}
        <button onClick={() => void create()} disabled={busy === 'create'} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#4b78ff', color: '#fff', fontSize: 13, cursor: 'pointer' }}>
          {busy === 'create' ? 'creating…' : '+ Create job'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 20 }}>
        {/* jobs */}
        <section>
          <h2 style={{ fontSize: 14, color: '#9aa0b5', margin: '0 0 8px' }}>Scheduled jobs</h2>
          {jobs.length === 0 && <p style={{ color: '#565c72', fontSize: 13 }}>No jobs yet — create the morning briefing above.</p>}
          <div style={{ display: 'grid', gap: 8 }}>
            {jobs.map((j) => (
              <div key={j.id} style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #23263a', background: '#12141f', opacity: j.enabled ? 1 : 0.55 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>{j.name}</strong>
                  <span style={{ fontSize: 11, color: '#4b78ff', border: '1px solid #2c3f75', borderRadius: 6, padding: '1px 6px' }}>{j.kind}</span>
                  <span style={{ fontSize: 12, color: '#9aa0b5' }}>{scheduleLabel(j.schedule)}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button onClick={() => void runNow(j.id)} disabled={busy === j.id || !j.enabled} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #2c3f75', background: 'transparent', color: '#4b78ff', cursor: 'pointer' }}>
                      {busy === j.id ? 'running…' : '▶ run now'}
                    </button>
                    <button onClick={() => void toggle(j)} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #2a2e45', background: 'transparent', color: '#9aa0b5', cursor: 'pointer' }}>
                      {j.enabled ? 'pause' : 'enable'}
                    </button>
                    <button onClick={() => void remove(j.id)} style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #3a2430', background: 'transparent', color: '#f87171', cursor: 'pointer' }}>✕</button>
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#9aa0b5', marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {j.payload?.url && <span style={{ color: '#565c72' }}>{j.payload.url}</span>}
                  <span>next: {j.next_run_at ? new Date(j.next_run_at).toLocaleString() : '—'}</span>
                  {j.last_run && (
                    <span style={{ color: STATUS_COLOR[j.last_run.status] ?? '#9aa0b5' }}>
                      ● last: {j.last_run.status}
                      {j.last_run.output?.summary ? ` — ${j.last_run.output.summary.slice(0, 60)}` : ''}
                      {j.last_run.error ? ` — ${j.last_run.error.slice(0, 60)}` : ''}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* notifications */}
        <section>
          <h2 style={{ fontSize: 14, color: '#9aa0b5', margin: '0 0 8px' }}>
            Notifications {notifs.filter((n) => !n.read).length > 0 && <span style={{ color: '#f5a623' }}>({notifs.filter((n) => !n.read).length} unread)</span>}
          </h2>
          {notifs.length === 0 && <p style={{ color: '#565c72', fontSize: 13 }}>Nothing yet — briefings and watch-alerts land here.</p>}
          <div style={{ display: 'grid', gap: 8 }}>
            {notifs.map((n) => (
              <div key={n.id} style={{ padding: '10px 12px', borderRadius: 10, border: `1px solid ${n.read ? '#23263a' : '#4b532c'}`, background: n.read ? '#0e101a' : '#15170f' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: 'pointer' }} onClick={() => setOpenNotif(openNotif === n.id ? null : n.id)}>
                  {!n.read && <span style={{ color: '#f5a623', fontSize: 10 }}>●</span>}
                  <strong style={{ fontSize: 13 }}>{n.title}</strong>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#565c72' }}>{new Date(n.created_at).toLocaleTimeString()}</span>
                </div>
                {openNotif === n.id && (
                  <div>
                    <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', marginTop: 8, color: '#cfd3e0' }}>{n.body}</div>
                    {!n.read && (
                      <button onClick={() => void markRead(n.id)} style={{ marginTop: 8, fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #2a2e45', background: 'transparent', color: '#9aa0b5', cursor: 'pointer' }}>
                        mark read
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
