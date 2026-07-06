'use client';
// M8 Task Inspector: the "why did it do that?" view. One task's plan (steps +
// dependencies), its full tool-call audit (trust class, approver, duration,
// redacted args/results), and the raw trace timeline — no psql needed.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface Step { id: string; kind: string; title: string | null; local_id: string | null; depends_on: string[]; status: string; tool: string | null; error: string | null; output: { text?: string; clarify?: string } | null }
interface ToolCall { id: string; tool: string; args: Record<string, unknown>; result: unknown; trust_class: string; approved_by: string | null; duration_ms: number | null; created_at: string; step_title: string | null; local_id: string | null }
interface TraceEvent { ts: string; component: string; event: string; payload: Record<string, unknown> }
interface Task { id: string; goal: string; status: string; spent: { tokens?: number }; trace_id: string; created_at: string; updated_at: string }

const STATUS_COLOR: Record<string, string> = {
  done: '#22a06b', running: '#4b78ff', planning: '#4b78ff', awaiting_approval: '#e0a13a',
  paused: '#b57edc', failed: '#f87171', pending: '#565c72', skipped: '#9aa0b5', draft: '#565c72',
};
const TRUST_COLOR: Record<string, string> = { read: '#22a06b', write: '#e0a13a', irreversible: '#f87171', spend: '#f87171' };
const card = { padding: 14, borderRadius: 12, border: '1px solid #23263a', background: '#0e101a', marginBottom: 16 } as const;
const h2 = { fontSize: 13, color: '#9aa0b5', margin: '0 0 10px', letterSpacing: 0.4, textTransform: 'uppercase' } as const;
const mono = { fontFamily: 'ui-monospace, monospace', fontSize: 11.5 } as const;

const snip = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
};

export default function TaskInspectorPage() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<Task | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([fetch(`/api/tasks/${id}`), fetch(`/api/tasks/${id}/trace`)]);
      if (!a.ok) { setErr('no such task'); return; }
      const d1 = (await a.json()) as { task: Task; steps: Step[] };
      // task comes from the TRACE endpoint — /tasks/:id omits trace_id.
      const d2 = (await b.json()) as { task: Task; toolCalls: ToolCall[]; events: TraceEvent[] };
      setTask(d2.task ?? d1.task); setSteps(d1.steps); setToolCalls(d2.toolCalls); setEvents(d2.events);
    } catch { /* kernel offline */ }
  }, [id]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  if (err) return <main style={{ maxWidth: 980, margin: '0 auto', padding: 24 }}><p style={{ color: '#f87171' }}>{err}</p></main>;
  if (!task) return <main style={{ maxWidth: 980, margin: '0 auto', padding: 24 }}><p style={{ color: '#565c72' }}>loading task…</p></main>;

  const idToLocal = new Map(steps.map((s) => [s.id, s.local_id ?? s.title ?? s.id.slice(0, 6)]));

  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: '24px 16px 80px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Task inspector</h1>
        <span style={{ color: '#4b78ff', fontSize: 11, letterSpacing: 2 }}>M8</span>
        <a href="/dashboard" style={{ marginLeft: 'auto', fontSize: 13, color: '#9aa0b5' }}>← dashboard</a>
        <a href="/tasks" style={{ fontSize: 13, color: '#9aa0b5' }}>all tasks</a>
      </header>

      <section style={card}>
        <div style={{ fontSize: 15, marginBottom: 6 }}>{task.goal}</div>
        <div style={{ display: 'flex', gap: 14, fontSize: 12.5, color: '#9aa0b5', flexWrap: 'wrap' }}>
          <span style={{ color: STATUS_COLOR[task.status] ?? '#9aa0b5' }}>● {task.status}</span>
          <span>🪙 {(task.spent?.tokens ?? 0).toLocaleString()} tokens</span>
          <span>created {new Date(task.created_at).toLocaleString()}</span>
          {task.trace_id && <span style={mono}>trace {task.trace_id.slice(0, 8)}</span>}
        </div>
      </section>

      {steps.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Plan · {steps.length} steps</h2>
          {steps.map((s) => (
            <div key={s.id} style={{ padding: '7px 0', borderTop: '1px solid #1a1d2e', fontSize: 13 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ color: STATUS_COLOR[s.status] ?? '#9aa0b5' }}>●</span>
                {s.local_id && <span style={{ ...mono, color: '#565c72' }}>{s.local_id}</span>}
                <span style={{ flex: 1 }}>{s.title ?? s.kind}</span>
                <span style={{ fontSize: 11, color: '#4b78ff', border: '1px solid #2c3f75', borderRadius: 6, padding: '0 6px' }}>{s.kind}</span>
                {s.tool && <span style={{ ...mono, color: '#9aa0b5' }}>{s.tool}</span>}
                {s.depends_on.length > 0 && (
                  <span style={{ fontSize: 11, color: '#565c72' }}>needs {s.depends_on.map((d) => idToLocal.get(d) ?? d.slice(0, 6)).join(', ')}</span>
                )}
              </div>
              {s.error && <div style={{ color: '#f87171', fontSize: 12, marginTop: 3 }}>{snip(s.error, 200)}</div>}
              {s.output?.clarify && <div style={{ color: '#e0a13a', fontSize: 12, marginTop: 3 }}>clarify: {snip(s.output.clarify, 200)}</div>}
            </div>
          ))}
        </section>
      )}

      <section style={card}>
        <h2 style={h2}>Tool calls · {toolCalls.length} <span style={{ color: '#565c72', textTransform: 'none' }}>(args/results redacted at write time)</span></h2>
        {toolCalls.length === 0 && <p style={{ color: '#565c72', fontSize: 13, margin: 0 }}>No tool calls recorded.</p>}
        {toolCalls.map((c) => (
          <div key={c.id} style={{ padding: '6px 0', borderTop: '1px solid #1a1d2e', fontSize: 13 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', cursor: 'pointer' }} onClick={() => setOpenCall(openCall === c.id ? null : c.id)}>
              <span style={mono}>{c.tool}</span>
              <span style={{ fontSize: 11, color: TRUST_COLOR[c.trust_class] ?? '#9aa0b5', border: `1px solid ${TRUST_COLOR[c.trust_class] ?? '#2a2e45'}44`, borderRadius: 6, padding: '0 6px' }}>{c.trust_class}</span>
              {c.approved_by && <span style={{ fontSize: 11, color: '#22a06b' }}>approved: {c.approved_by}</span>}
              <span style={{ flex: 1, color: '#565c72', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{snip(c.args, 90)}</span>
              <span style={{ color: '#565c72', fontSize: 11 }}>{c.duration_ms != null ? `${c.duration_ms}ms` : ''}</span>
            </div>
            {openCall === c.id && (
              <div style={{ ...mono, background: '#12141f', borderRadius: 8, padding: 10, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#cfd3e0' }}>
                args: {JSON.stringify(c.args, null, 1)}{'\n'}result: {snip(c.result, 800)}
              </div>
            )}
          </div>
        ))}
      </section>

      <section style={card}>
        <h2 style={h2}>Trace timeline · {events.length} events</h2>
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {events.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '4px 0', borderTop: '1px solid #1a1d2e', fontSize: 12.5 }}>
              <span style={{ ...mono, color: '#565c72', flexShrink: 0 }}>{new Date(e.ts).toLocaleTimeString(undefined, { hour12: false })}</span>
              <span style={{ color: '#4b78ff', flexShrink: 0, width: 74 }}>{e.component}</span>
              <span style={{ flexShrink: 0, width: 170 }}>{e.event}</span>
              <span style={{ ...mono, color: '#9aa0b5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{snip(e.payload, 120)}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
