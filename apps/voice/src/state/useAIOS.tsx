/* eslint-disable react-refresh/only-export-components */
// The app's single brainstem: session resolution, message/pending polling,
// send (typed or voice), the voice state machine (record → Whisper transcribe
// → chat → spoken reply), and approval decisions. Components stay presentational.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Msg, type PendingAction, type SessionSummary } from '../api/client';

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

interface AIOS {
  sessionId: string | null;
  sessions: SessionSummary[];
  messages: Msg[];
  pending: PendingAction[];
  voice: VoiceState;
  busy: boolean;
  online: boolean | null;
  voiceErr: string | null;
  autoSpeak: boolean;
  setAutoSpeak: (v: boolean) => void;
  send: (text: string) => Promise<void>;
  toggleVoice: () => Promise<void>;
  decide: (id: string, decision: 'approved' | 'rejected') => Promise<void>;
  newChat: () => Promise<string | null>;
  switchTo: (id: string) => void;
  deleteSession: (id: string) => Promise<void>;
  stopSpeaking: () => void;
}

const Ctx = createContext<AIOS | null>(null);
const LAST_SESSION_KEY = 'aios-voice-last-session';

/** Strip markdown/citations/URLs so TTS reads like a person, not a parser. */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/\[([^\]]*)\]\((https?:[^)]+)\)/g, '$1 (link)')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\[(mail|event|file):[^\]]*\]/g, '')
    .replace(/[*_#`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

export function AIOSProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(() => localStorage.getItem('aios-voice-autospeak') !== 'off');
  const recRef = useRef<MediaRecorder | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const spokenRef = useRef<Set<string>>(new Set()); // message ids already spoken

  useEffect(() => localStorage.setItem('aios-voice-autospeak', autoSpeak ? 'on' : 'off'), [autoSpeak]);

  const refreshSessions = useCallback(async () => {
    try {
      const d = await api.sessions();
      setSessions(d.sessions);
      return d.sessions;
    } catch {
      return [];
    }
  }, []);

  // First-load session resolution: saved → most recent → create.
  useEffect(() => {
    void (async () => {
      try {
        const list = await refreshSessions();
        const saved = localStorage.getItem(LAST_SESSION_KEY);
        if (saved && list.some((s) => s.id === saved)) setSessionId(saved);
        else if (list.length) setSessionId(list[0]!.id);
        else setSessionId((await api.createSession()).id);
        setOnline(true);
      } catch {
        setOnline(false);
      }
    })();
  }, [refreshSessions]);

  useEffect(() => {
    if (sessionId) localStorage.setItem(LAST_SESSION_KEY, sessionId);
  }, [sessionId]);

  const speak = useCallback((m: Msg) => {
    if (spokenRef.current.has(m.id)) return;
    spokenRef.current.add(m.id);
    const text = speakable(m.content);
    if (!text) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.04;
      u.onstart = () => setVoice((v) => (v === 'idle' || v === 'thinking' ? 'speaking' : v));
      u.onend = () => setVoice((v) => (v === 'speaking' ? 'idle' : v));
      window.speechSynthesis.speak(u);
    } catch {
      /* no TTS voice available — stay silent */
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    setVoice((v) => (v === 'speaking' ? 'idle' : v));
  }, []);

  // The heartbeat: poll messages + pending for the active session.
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const d = await api.messages(sessionId);
      setMessages((prev) => {
        // Speak newly-arrived assistant messages (only ones we hadn't seen and
        // only after the first load, so history doesn't get read aloud).
        if (prev.length > 0 && autoSpeak) {
          const known = new Set(prev.map((m) => m.id));
          const fresh = d.messages.filter((m) => m.role === 'assistant' && !known.has(m.id));
          const last = fresh.at(-1);
          if (last) speak(last);
        } else if (prev.length === 0) {
          d.messages.forEach((m) => spokenRef.current.add(m.id)); // seed: never voice history
        }
        return d.messages;
      });
      setPending(d.pendingActions ?? []);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, [sessionId, autoSpeak, speak]);

  useEffect(() => {
    spokenRef.current = new Set();
    setMessages([]);
    setPending([]);
    void refresh();
    const t = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 3500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !sessionId || busy) return;
      setBusy(true);
      setVoice('thinking');
      setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: trimmed, created_at: new Date().toISOString() }]);
      try {
        await api.chat(trimmed, sessionId);
      } catch {
        /* poller will surface whatever the kernel reached */
      }
      await refresh();
      void refreshSessions();
      setBusy(false);
      setVoice((v) => (v === 'thinking' ? 'idle' : v));
    },
    [sessionId, busy, refresh, refreshSessions],
  );

  // Voice: record (webm/opus) → /voice/transcribe → send. 60s hard cap;
  // sub-3KB blips are dropped (Whisper hallucinates on them).
  const toggleVoice = useCallback(async () => {
    if (voice === 'speaking') {
      stopSpeaking(); // barge-in: interrupting always wins
      return;
    }
    if (voice === 'listening') {
      recRef.current?.stop();
      return;
    }
    if (voice !== 'idle' || busy) return;
    setVoiceErr(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setVoiceErr('Microphone blocked — allow mic access for this site and try again.');
      return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = async () => {
      clearTimeout(autoStopRef.current);
      stream.getTracks().forEach((t) => t.stop());
      setVoice('transcribing');
      try {
        const blob = new Blob(chunks, { type: mime });
        if (blob.size < 3000) {
          setVoiceErr("Didn't catch that — hold the mic a bit longer and speak clearly.");
          setVoice('idle');
          return;
        }
        const d = await api.transcribe(blob, mime);
        if (d.text) {
          setVoice('idle');
          await send(d.text);
        } else {
          setVoiceErr(d.error ?? "Didn't catch that — try again closer to the mic.");
          setVoice('idle');
        }
      } catch {
        setVoiceErr('Transcription failed — is the kernel online?');
        setVoice('idle');
      }
    };
    rec.start();
    recRef.current = rec;
    autoStopRef.current = setTimeout(() => {
      if (rec.state === 'recording') rec.stop();
    }, 60_000);
    setVoice('listening');
  }, [voice, busy, send, stopSpeaking]);

  const decide = useCallback(
    async (id: string, decision: 'approved' | 'rejected') => {
      setPending((ps) => ps.filter((p) => p.id !== id)); // optimistic — the poller re-surfaces on failure
      try {
        await api.decide(id, decision);
      } catch {
        /* poller re-surfaces */
      }
      await refresh();
    },
    [refresh],
  );

  const newChat = useCallback(async () => {
    try {
      const s = await api.createSession();
      setSessionId(s.id);
      void refreshSessions();
      return s.id;
    } catch {
      return null;
    }
  }, [refreshSessions]);

  const switchTo = useCallback((id: string) => setSessionId(id), []);

  const deleteSession = useCallback(
    async (id: string) => {
      await api.deleteSession(id).catch(() => undefined);
      const list = await refreshSessions();
      if (id === sessionId) {
        if (list.length) setSessionId(list[0]!.id);
        else await newChat();
      }
    },
    [sessionId, refreshSessions, newChat],
  );

  const value = useMemo<AIOS>(
    () => ({
      sessionId,
      sessions,
      messages,
      pending,
      voice,
      busy,
      online,
      voiceErr,
      autoSpeak,
      setAutoSpeak,
      send,
      toggleVoice,
      decide,
      newChat,
      switchTo,
      deleteSession,
      stopSpeaking,
    }),
    [sessionId, sessions, messages, pending, voice, busy, online, voiceErr, autoSpeak, send, toggleVoice, decide, newChat, switchTo, deleteSession, stopSpeaking],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAIOS(): AIOS {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAIOS outside AIOSProvider');
  return v;
}
