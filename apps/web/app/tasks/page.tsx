'use client';
// Task inspector + approvals inbox (M4). Plan a goal, watch the step graph, and
// control the run: approve/reject at gates, pause, redirect, resume. A thin seed
// of the M8 OS interface.
import { useCallback, useEffect, useState } from 'react';

interface Step {
  id: string;
  kind: string;
  title: string | null;
  status: string;
  depends_on: string[];
  tool: string | null;
  approval: { status?: string } | null;
  output: { text?: string; clarify?: string } | null;
  error: string | null;
}
interface Task {
  id: string;
  goal: string;
  status: string;
}

const STATUS_COLOR: Record<string, string> = {
  done: '#22a06b',
  running: '#4b78ff',
  planning: '#4b78ff',
  awaiting_approval: '#e0a13a',
  paused: '#b57edc',
  failed: '#f87171',
  pending: '#565c72',
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [detail, setDetail] = useState<Task | null>(null);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [directive, setDirective] = useState('');

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch('/api/tasks');
      setTasks(((await r.json()) as { tasks: Task[] }).tasks);
    } catch { /* ignore */ }
  }, []);

  const loadTask = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/tasks/${id}`);
      const d = (await r.json()) as { task: Task; steps: Step[] };
      setDetail(d.task);
      setSteps(d.steps);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void loadTasks();
    const t = setInterval(() => {
      void loadTasks();
      if (selected) void loadTask(selected);
    }, 3000);
    return () => clearInterval(t);
  }, [loadTasks, loadTask, selected]);

  async function plan() {
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: goal }) });
      const d = (await r.json()) as { taskId?: string };
      setGoal('');
      await loadTasks();
      if (d.taskId) { setSelected(d.taskId); await loadTask(d.taskId); }
    } finally {
      setBusy(false);
    }
  }

  async function control(path: string, body?: unknown) {
    if (!selected) return;
    await fetch(`/api/tasks/${selected}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    await loadTask(selected);
    await loadTasks();
  }

  const pendingApprovals = steps.filter((s) => s.kind === 'approval' && s.approval?.status === 'pending' && s.status === 'pending');

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px 80px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Tasks</h1>
        <span style={{ color: '#4b78ff', fontSize: 11, letterSpacing: 2 }}>M4 · PLANNER + GRAPH</span>
        <a href="/" style={{ marginLeft: 'auto', fontSize: 13, color: '#9aa0b5' }}>← chat</a>
        <a href="/memory" style={{ fontSize: 13, color: '#9aa0b5' }}>memory →</a>
      </header>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void plan()}
          placeholder="Give the planner a multi-step goal…"
          style={{ flex: 1, padding: '10px 14px', borderRadius: 10, border: '1px solid #2a2e45', background: '#12141f', color: '#e6e8f0', fontSize: 14, outline: 'none' }}
        />
        <button onClick={() => void plan()} disabled={busy} style={{ padding: '0 20px', borderRadius: 10, border: 'none', background: busy ? '#2a2e45' : '#4b78ff', color: '#fff', fontSize: 14, cursor: 'pointer' }}>
          {busy ? 'planning…' : 'Plan'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, alignContent: 'start', minWidth: 0 }}>
          {tasks.map((t) => (
            <button
              key={t.id}
              onClick={() => { setSelected(t.id); void loadTask(t.id); }}
              style={{ textAlign: 'left', padding: '8px 10px', borderRadius: 8, background: selected === t.id ? '#1d2c55' : '#12141f', border: `1px solid ${selected === t.id ? '#2c3f75' : '#23263a'}`, color: '#e6e8f0', cursor: 'pointer', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}
            >
              <div style={{ fontSize: 12, color: STATUS_COLOR[t.status] ?? '#9aa0b5' }}>● {t.status}</div>
              <div style={{ fontSize: 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.goal}</div>
            </button>
          ))}
        </div>

        <div>
          {!detail && <p style={{ color: '#565c72', fontSize: 14 }}>Select a task, or plan a new one.</p>}
          {detail && (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: STATUS_COLOR[detail.status] ?? '#9aa0b5', alignSelf: 'center' }}>● {detail.status}</span>
                {detail.status === 'running' && <button onClick={() => void control('pause')} style={btn}>pause</button>}
                {detail.status === 'paused' && <button onClick={() => void control('resume')} style={btn}>resume</button>}
                {(detail.status === 'running' || detail.status === 'paused' || detail.status === 'awaiting_approval') && (
                  <>
                    <input value={directive} onChange={(e) => setDirective(e.target.value)} placeholder="redirect: e.g. use the other account" style={{ flex: 1, minWidth: 200, padding: '6px 10px', borderRadius: 8, border: '1px solid #2a2e45', background: '#12141f', color: '#e6e8f0', fontSize: 12 }} />
                    <button onClick={() => { void control('redirect', { directive }); setDirective(''); }} style={btn}>redirect</button>
                  </>
                )}
              </div>

              {pendingApprovals.length > 0 && (
                <div style={{ border: '1px solid #5c4a1f', background: '#2a230f', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 13, color: '#f2c14e', marginBottom: 8 }}>⏸ Awaiting your approval</div>
                  {pendingApprovals.map((s) => (
                    <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontSize: 13, flex: 1 }}>{s.title}</span>
                      <button onClick={() => void control('approve', { stepId: s.id, decision: 'approved' })} style={{ ...btn, borderColor: '#1f4d3a', color: '#4ade80' }}>approve</button>
                      <button onClick={() => void control('approve', { stepId: s.id, decision: 'rejected' })} style={{ ...btn, borderColor: '#5c2a33', color: '#f87171' }}>reject</button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'grid', gap: 6 }}>
                {steps.map((s, i) => (
                  <div key={s.id} style={{ padding: '10px 12px', borderRadius: 8, background: '#12141f', border: '1px solid #23263a' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#565c72' }}>{i + 1}</span>
                      <span style={{ fontSize: 11, color: '#9aa0b5', border: '1px solid #2a2e45', borderRadius: 5, padding: '1px 6px' }}>{s.kind}{s.tool ? `:${s.tool}` : ''}</span>
                      <span style={{ fontSize: 13, flex: 1 }}>{s.title}</span>
                      <span style={{ fontSize: 11, color: STATUS_COLOR[s.status] ?? '#9aa0b5' }}>{s.status}</span>
                    </div>
                    {s.output?.text && <div style={{ fontSize: 12, color: '#9aa0b5', marginTop: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{s.output.text.slice(0, 400)}</div>}
                    {s.output?.clarify && <div style={{ fontSize: 12, color: '#f2c14e', marginTop: 6 }}>❓ {s.output.clarify}</div>}
                    {s.error && <div style={{ fontSize: 12, color: '#f87171', marginTop: 6 }}>{s.error.slice(0, 200)}</div>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

const btn: React.CSSProperties = { fontSize: 12, background: 'transparent', border: '1px solid #2a2e45', color: '#9aa0b5', borderRadius: 8, padding: '4px 12px', cursor: 'pointer' };
