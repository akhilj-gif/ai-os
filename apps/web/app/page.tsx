'use client';
// M1 chat shell, now with multiple sessions ("New chat", like ChatGPT/Claude) —
// sessions.ts always had the concept, the UI just never exposed it, so every
// message piled into one endless thread. Polling keeps the thread current even
// if the server was killed mid-task and resumed (exit test).
import { useCallback, useEffect, useRef, useState } from 'react';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

interface GoogleStatus {
  connected: boolean;
  email?: string | null;
}

interface PendingAction {
  id: string;
  task_id: string;
  tool: string;
  args: Record<string, unknown>;
  untrusted_context: boolean;
  created_at: string;
}

// Human-friendly one-liner for an approval card, per tool.
function describeAction(p: PendingAction): string {
  const a = p.args;
  if (p.tool === 'calendar_create_event') return `Create calendar event: “${a.summary as string}” at ${a.start as string}`;
  if (p.tool === 'whatsapp_send_message') return `Send WhatsApp to ${a.chatId as string}: “${a.text as string}”`;
  if (p.tool === 'gmail_create_draft') return `Draft email to ${a.to as string}: “${a.subject as string}”`;
  return `${p.tool}(${JSON.stringify(a).slice(0, 120)})`;
}

interface SessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  first_message: string | null;
}

const LAST_SESSION_KEY = 'aios-last-session-id';
const sessionLabel = (s: SessionSummary): string =>
  (s.first_message || (s.title !== 'main' && s.title !== 'New chat' ? s.title : '') || 'New chat').slice(0, 46);

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshSessions = useCallback(async (): Promise<SessionSummary[]> => {
    const res = await fetch('/api/sessions');
    const data = (await res.json()) as { sessions: SessionSummary[] };
    setSessions(data.sessions);
    return data.sessions;
  }, []);

  // Resolve which session to show on first load: localStorage's last-used one,
  // else the most recently active session, else create a fresh one.
  useEffect(() => {
    void (async () => {
      try {
        const list = await refreshSessions();
        const saved = localStorage.getItem(LAST_SESSION_KEY);
        if (saved && list.some((s) => s.id === saved)) {
          setSessionId(saved);
        } else if (list.length > 0) {
          setSessionId(list[0]!.id);
        } else {
          const created = await fetch('/api/sessions', { method: 'POST' }).then((r) => r.json() as Promise<SessionSummary>);
          setSessionId(created.id);
          void refreshSessions();
        }
      } catch {
        setApiOk(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sessionId) localStorage.setItem(LAST_SESSION_KEY, sessionId);
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/messages?sessionId=${sessionId}`);
      const data = (await res.json()) as { messages: Msg[]; pendingActions?: PendingAction[] };
      setMessages(data.messages);
      setPending(data.pendingActions ?? []);
      setApiOk(true);
      const g = await fetch('/api/oauth/google/status');
      setGoogle((await g.json()) as GoogleStatus);
    } catch {
      setApiOk(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, pending.length, busy]);

  // Approve / reject an action in-chat — no dashboard trip. The server runs the
  // exact queued call on approve and posts the result back into the thread.
  async function decide(id: string, decision: 'approved' | 'rejected') {
    setDeciding(id);
    setPending((ps) => ps.filter((p) => p.id !== id)); // optimistic: drop the card
    try {
      await fetch(`/api/pending/${id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
    } catch {
      /* the poller re-surfaces it if the call failed */
    }
    await refresh();
    setDeciding(null);
  }

  async function newChat() {
    const created = (await fetch('/api/sessions', { method: 'POST' }).then((r) => r.json())) as SessionSummary;
    setMessages([]);
    setPending([]);
    setSessionId(created.id);
    setShowHistory(false);
    void refreshSessions();
  }

  function switchTo(id: string) {
    if (id === sessionId) return setShowHistory(false);
    setMessages([]);
    setPending([]);
    setSessionId(id);
    setShowHistory(false);
  }

  async function deleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    const list = await refreshSessions();
    if (id === sessionId) {
      if (list.length > 0) switchTo(list[0]!.id);
      else void newChat();
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !sessionId) return;
    setInput('');
    setBusy(true);
    setMessages((m) => [
      ...m,
      { id: `tmp-${Date.now()}`, role: 'user', content: text, created_at: new Date().toISOString() },
    ]);
    try {
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, sessionId }),
      });
    } catch {
      /* the poller will pick up whatever state the server reached */
    }
    await refresh();
    void refreshSessions(); // updated_at / preview changed
    setBusy(false);
  }

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px 120px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>AI OS</h1>
        <a href="/dashboard" style={{ fontSize: 13, color: '#e0a13a' }}>dashboard</a>
        <a href="/tasks" style={{ fontSize: 13, color: '#9aa0b5' }}>tasks</a>
        <a href="/research" style={{ fontSize: 13, color: '#9aa0b5' }}>research</a>
        <a href="/automations" style={{ fontSize: 13, color: '#9aa0b5' }}>automations</a>
        <a href="/packs" style={{ fontSize: 13, color: '#9aa0b5' }}>packs</a>
        <a href="/memory" style={{ fontSize: 13, color: '#9aa0b5' }}>memory</a>
        <a href="/settings" style={{ fontSize: 13, color: '#9aa0b5' }}>trust →</a>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: apiOk ? '#4ade80' : '#f87171' }}>
          {apiOk === null ? '…' : apiOk ? '● kernel online' : '● kernel unreachable'}
        </span>
      </header>

      <div style={{ position: 'relative', display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => void newChat()}
          style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#4b78ff', color: '#fff', fontSize: 13, cursor: 'pointer' }}
        >
          + New chat
        </button>
        <button
          onClick={() => setShowHistory((v) => !v)}
          style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #2a2e45', background: 'transparent', color: '#9aa0b5', fontSize: 13, cursor: 'pointer' }}
        >
          {showHistory ? '✕ close' : `🕘 chats (${sessions.length})`}
        </button>

        {showHistory && (
          <div
            style={{
              position: 'absolute', top: '110%', left: 0, right: 0, zIndex: 10,
              maxHeight: 340, overflowY: 'auto', background: '#12141f',
              border: '1px solid #2a2e45', borderRadius: 10, padding: 6,
            }}
          >
            {sessions.length === 0 && <p style={{ color: '#565c72', fontSize: 13, margin: 8 }}>No past chats yet.</p>}
            {sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => switchTo(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8,
                  cursor: 'pointer', background: s.id === sessionId ? '#1d2c55' : 'transparent',
                }}
              >
                <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sessionLabel(s)}
                </span>
                <span style={{ fontSize: 11, color: '#565c72', flexShrink: 0 }}>{s.message_count} msgs</span>
                <button
                  onClick={(e) => void deleteSession(s.id, e)}
                  title="Delete chat"
                  style={{ fontSize: 12, padding: '2px 7px', borderRadius: 6, border: '1px solid #3a2430', background: 'transparent', color: '#f87171', cursor: 'pointer', flexShrink: 0 }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {google && !google.connected && (
        <div
          style={{
            border: '1px solid #5c4a1f',
            background: '#2a230f',
            borderRadius: 8,
            padding: '10px 14px',
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          Gmail/Calendar not connected —{' '}
          <a href="http://localhost:4000/oauth/google" style={{ color: '#f2c14e' }}>
            connect your Google account
          </a>{' '}
          to unlock &ldquo;what&rsquo;s on my plate today?&rdquo;
        </div>
      )}
      {google?.connected && (
        <p style={{ fontSize: 12, color: '#9aa0b5', margin: '0 0 16px' }}>
          Google connected: {google.email}
        </p>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {messages.length === 0 && (
          <p style={{ color: '#565c72', fontSize: 14 }}>
            Ask something. Try: <em>what&rsquo;s on my plate today?</em>
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              justifySelf: m.role === 'user' ? 'end' : 'start',
              maxWidth: '85%',
              padding: '10px 14px',
              borderRadius: 10,
              fontSize: 14,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              background: m.role === 'user' ? '#1d2c55' : '#161825',
              border: `1px solid ${m.role === 'user' ? '#2c3f75' : '#23263a'}`,
            }}
          >
            {m.content}
          </div>
        ))}

        {pending.map((p) => (
          <div
            key={p.id}
            style={{
              justifySelf: 'start',
              maxWidth: '92%',
              width: '92%',
              padding: '12px 14px',
              borderRadius: 10,
              fontSize: 14,
              lineHeight: 1.5,
              background: '#231b0c',
              border: '1px solid #6b551f',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 15 }}>⏳</span>
              <strong style={{ color: '#f2c14e', fontSize: 13, letterSpacing: 0.2 }}>
                Waiting for your approval — nothing has happened yet
              </strong>
            </div>
            <div style={{ color: '#e7e3d4', marginBottom: 4 }}>{describeAction(p)}</div>
            {p.untrusted_context && (
              <div style={{ fontSize: 12, color: '#c99', marginBottom: 8 }}>
                ⚠ This task read untrusted content (email/web) before proposing this — review carefully.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                disabled={deciding === p.id}
                onClick={() => void decide(p.id, 'approved')}
                style={{
                  padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: '#2f9e44', color: '#fff', fontSize: 13, fontWeight: 600,
                  opacity: deciding === p.id ? 0.6 : 1,
                }}
              >
                ✓ Approve &amp; run
              </button>
              <button
                disabled={deciding === p.id}
                onClick={() => void decide(p.id, 'rejected')}
                style={{
                  padding: '7px 16px', borderRadius: 8, border: '1px solid #3a2430', cursor: 'pointer',
                  background: 'transparent', color: '#f87171', fontSize: 13,
                  opacity: deciding === p.id ? 0.6 : 1,
                }}
              >
                ✕ Cancel
              </button>
            </div>
          </div>
        ))}

        {busy && (
          <div style={{ color: '#9aa0b5', fontSize: 13 }}>⏳ kernel working — tools may take a moment…</div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          padding: 16,
          background: 'linear-gradient(transparent, #0c0d14 30%)',
        }}
      >
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask AI OS…"
            style={{
              flex: 1,
              padding: '12px 16px',
              borderRadius: 10,
              border: '1px solid #2a2e45',
              background: '#12141f',
              color: '#e6e8f0',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={busy || !sessionId}
            style={{
              padding: '0 22px',
              borderRadius: 10,
              border: 'none',
              background: busy || !sessionId ? '#2a2e45' : '#4b78ff',
              color: 'white',
              fontSize: 14,
              cursor: busy || !sessionId ? 'default' : 'pointer',
            }}
          >
            {busy ? '…' : 'Send'}
          </button>
        </div>
      </form>
    </main>
  );
}
