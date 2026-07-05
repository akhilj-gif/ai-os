'use client';
// M1 chat shell: one persistent session against the kernel API. Polling keeps the
// thread current even if the server was killed mid-task and resumed (exit test).
// The real OS interface (dashboard, task inspector, approvals) is M8.
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

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/messages');
      const data = (await res.json()) as { messages: Msg[] };
      setMessages(data.messages);
      setApiOk(true);
      const g = await fetch('/api/oauth/google/status');
      setGoogle((await g.json()) as GoogleStatus);
    } catch {
      setApiOk(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
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
        body: JSON.stringify({ text }),
      });
    } catch {
      /* the poller will pick up whatever state the server reached */
    }
    await refresh();
    setBusy(false);
  }

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px 120px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>AI OS</h1>
        <a href="/tasks" style={{ fontSize: 13, color: '#9aa0b5' }}>tasks</a>
        <a href="/memory" style={{ fontSize: 13, color: '#9aa0b5' }}>memory →</a>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: apiOk ? '#4ade80' : '#f87171' }}>
          {apiOk === null ? '…' : apiOk ? '● kernel online' : '● kernel unreachable'}
        </span>
      </header>

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
            disabled={busy}
            style={{
              padding: '0 22px',
              borderRadius: 10,
              border: 'none',
              background: busy ? '#2a2e45' : '#4b78ff',
              color: 'white',
              fontSize: 14,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy ? '…' : 'Send'}
          </button>
        </div>
      </form>
    </main>
  );
}
