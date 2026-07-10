// Typed client for the AI OS kernel API. Everything goes through the Vite
// same-origin proxy (/api/* → 127.0.0.1:4000/*) — the kernel sends no CORS
// headers by design, so the UI must never call :4000 directly.

export interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  task_id?: string | null;
}

export interface PendingAction {
  id: string;
  task_id: string;
  tool: string;
  args: Record<string, unknown>;
  untrusted_context: boolean;
  created_at: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  first_message: string | null;
}

export interface TaskSummary {
  id: string;
  goal: string;
  status: 'draft' | 'planning' | 'running' | 'paused' | 'awaiting_approval' | 'done' | 'failed';
  /** set on an orchestration's specialist children (M11) — the UI nests them under this parent */
  parent_task_id?: string | null;
}

export interface TaskDetail {
  task: TaskSummary & { spent?: { tokens?: number }; untrusted?: boolean; parent_task_id?: string | null };
  steps: Array<{ id: string; kind: string; title: string | null; status: string; tool: string | null; output: { text?: string } | null; error: string | null }>;
  children: Array<{ id: string; goal: string; status: string; untrusted: boolean }>;
}

export interface MemoryRecord {
  id: string;
  type: string;
  content: string;
  subject: string | null;
  confidence: number;
  source: { task_id?: string; user_stated?: boolean };
  relevance?: number;
}

export interface JobRow {
  id: string;
  name: string;
  kind: string;
  schedule: Record<string, unknown>;
  state: Record<string, unknown>;
  enabled: boolean;
  next_run_at: string | null;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  health: () => j<{ ok: boolean; milestone: string }>('/health'),

  chat: (text: string, sessionId: string) =>
    j<{ sessionId: string; taskId: string; reply: string }>('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, sessionId }),
    }),

  messages: (sessionId: string) =>
    j<{ sessionId: string; messages: Msg[]; pendingActions: PendingAction[] }>(`/messages?sessionId=${sessionId}`),

  sessions: () => j<{ sessions: SessionSummary[] }>('/sessions'),
  createSession: () => j<SessionSummary>('/sessions', { method: 'POST' }),
  deleteSession: (id: string) => j<unknown>(`/sessions/${id}`, { method: 'DELETE' }),

  decide: (id: string, decision: 'approved' | 'rejected') =>
    j<{ ok: boolean; executed: boolean }>(`/pending/${id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    }),

  transcribe: async (blob: Blob, mime: string) => {
    const res = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': mime }, body: blob });
    return (await res.json()) as { text?: string; error?: string };
  },

  tasks: () => j<{ tasks: TaskSummary[] }>('/tasks'),
  task: (id: string) => j<TaskDetail>(`/tasks/${id}`),

  memory: () => j<{ records: MemoryRecord[] }>('/memory?includeSuperseded=false'),
  memorySearch: (q: string) => j<{ records: MemoryRecord[]; mode: string }>(`/memory/search?q=${encodeURIComponent(q)}`),
  memoryDelete: (id: string) => j<unknown>(`/memory/${id}`, { method: 'DELETE' }),

  jobs: () => j<{ jobs: JobRow[] }>('/jobs'),
  jobRun: (id: string) => j<unknown>(`/jobs/${id}/run-now`, { method: 'POST' }),

  google: () => j<{ connected: boolean; email?: string | null }>('/oauth/google/status'),
};

/** Human one-liner for an approval popup, per tool. */
export function describeAction(p: PendingAction): string {
  const a = p.args as Record<string, string>;
  if (p.tool === 'whatsapp_send_message') return `Send WhatsApp to ${a.chatId}: “${a.text}”`;
  if (p.tool === 'calendar_create_event') return `Create calendar event “${a.summary}” · ${a.start}${a.end ? ` → ${a.end}` : ''}`;
  if (p.tool === 'gmail_create_draft') return `Draft email to ${a.to}: “${a.subject}”`;
  const s = JSON.stringify(p.args);
  return `${p.tool}(${s.length > 140 ? s.slice(0, 140) + '…' : s})`;
}
