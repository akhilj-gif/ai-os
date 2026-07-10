/* eslint-disable react-refresh/only-export-components */
// The app's single brainstem: session resolution, message/pending polling,
// send (typed or voice), the voice state machine (record → Whisper transcribe
// → chat → spoken reply), and approval decisions. Components stay presentational.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Msg, type PendingAction, type SessionSummary } from '../api/client';
import { isSpeech, rmsFromByteTimeDomain, vadDecision } from '../lib/vad';

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
  /** M12d hands-free conversation mode: VAD ends each utterance; the mic
   *  re-arms automatically after the spoken reply. */
  conversation: boolean;
  setConversation: (v: boolean) => void;
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
  // Hands-free is the product's whole point — conversation mode defaults ON
  // (Akhil's feedback 2026-07-11: "I have to manually press to speak").
  const [conversation, setConversationState] = useState(() => localStorage.getItem('aios-voice-convo') !== 'off');
  const recRef = useRef<MediaRecorder | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const spokenRef = useRef<Set<string>>(new Set()); // message ids already spoken
  // Long-lived callbacks (TTS onend, VAD poller) need CURRENT values, not the
  // closure at definition time.
  const conversationRef = useRef(conversation);
  const voiceRef = useRef<VoiceState>('idle');
  const busyRef = useRef(false);
  const startListeningRef = useRef<(() => Promise<void>) | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null); // server-TTS playback (barge-in target)

  useEffect(() => localStorage.setItem('aios-voice-autospeak', autoSpeak ? 'on' : 'off'), [autoSpeak]);
  useEffect(() => {
    conversationRef.current = conversation;
    localStorage.setItem('aios-voice-convo', conversation ? 'on' : 'off');
  }, [conversation]);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Conversation mode rides on the spoken reply (the re-arm hooks its `onend`),
  // so enabling it force-enables auto-speak.
  const setConversation = useCallback((v: boolean) => {
    setConversationState(v);
    if (v) setAutoSpeak(true);
  }, []);

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

  // M12d hands-free turn-taking: after the spoken reply ends (either TTS
  // path), re-arm the mic. Also fires after a barge-in stop — interrupting to
  // talk is exactly when the user wants the mic. Never while the tab is hidden.
  const onReplyEnd = useCallback(() => {
    setVoice((v) => (v === 'speaking' ? 'idle' : v));
    if (conversationRef.current && !document.hidden) {
      setTimeout(() => {
        if (conversationRef.current && voiceRef.current === 'idle' && !busyRef.current && !document.hidden) {
          void startListeningRef.current?.();
        }
      }, 350);
    }
  }, []);

  /** Browser fallback voice: prefer a natural-sounding FEMALE voice over the
   *  robotic default (Neerja = Indian English; Natural/Online = Edge neural). */
  const pickBrowserVoice = useCallback((): SpeechSynthesisVoice | null => {
    const voices = window.speechSynthesis.getVoices();
    const prefs = [
      /neerja/i,
      /(jenny|aria|sonia|emma|michelle).*(natural|online)/i,
      /(natural|online).*(jenny|aria|sonia|emma|michelle)/i,
      /google uk english female/i,
      /zira/i,
      /heera/i,
      /female/i,
    ];
    for (const p of prefs) {
      const v = voices.find((v) => p.test(v.name));
      if (v) return v;
    }
    return null;
  }, []);

  const speak = useCallback(
    (m: Msg) => {
      if (spokenRef.current.has(m.id)) return;
      spokenRef.current.add(m.id);
      const text = speakable(m.content);
      if (!text) return;
      void (async () => {
        // Preferred path: the kernel's natural TTS (Groq PlayAI, female voice).
        try {
          const blob = await api.speakAudio(text);
          if (blob && blob.size > 0) {
            window.speechSynthesis.cancel();
            audioRef.current?.pause();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onplay = () => setVoice((v) => (v === 'idle' || v === 'thinking' ? 'speaking' : v));
            audio.onended = () => {
              URL.revokeObjectURL(url);
              onReplyEnd();
            };
            audio.onerror = () => {
              URL.revokeObjectURL(url);
              onReplyEnd();
            };
            await audio.play();
            return;
          }
        } catch {
          /* server TTS unavailable → browser fallback below */
        }
        try {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(text);
          const v = pickBrowserVoice();
          if (v) u.voice = v;
          u.rate = 1.04;
          u.pitch = 1.03;
          u.onstart = () => setVoice((vv) => (vv === 'idle' || vv === 'thinking' ? 'speaking' : vv));
          u.onend = onReplyEnd;
          window.speechSynthesis.speak(u);
        } catch {
          /* no TTS voice available — stay silent */
        }
      })();
    },
    [onReplyEnd, pickBrowserVoice],
  );

  const stopSpeaking = useCallback(() => {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    if (audioRef.current) {
      audioRef.current.onended = null; // pausing must not double-fire the re-arm
      audioRef.current.pause();
      audioRef.current = null;
    }
    onReplyEnd(); // barge-in: interrupting = wanting to talk → re-arm applies
  }, [onReplyEnd]);

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
  // sub-3KB blips are dropped (Whisper hallucinates on them). In conversation
  // mode a WebAudio VAD ends each utterance (trailing silence) and a silent
  // arming ABORTS — discard-not-send is always the failure mode (ADR-0015).
  const startListening = useCallback(async () => {
    if (voiceRef.current !== 'idle' || busyRef.current) return;
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
    let aborted = false; // VAD heard nothing → discard, never transcribe
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    // VAD (conversation mode only): poll mic energy; end the utterance on
    // trailing silence, abort a fully-silent arming. The manual button flow
    // keeps its tap-to-stop behavior untouched.
    let vadCleanup: (() => void) | null = null;
    if (conversationRef.current && typeof AudioContext !== 'undefined') {
      try {
        const ac = new AudioContext();
        const srcNode = ac.createMediaStreamSource(stream);
        const an = ac.createAnalyser();
        an.fftSize = 512;
        srcNode.connect(an);
        const buf = new Uint8Array(an.fftSize);
        const t0 = Date.now();
        let sawSpeech = false;
        let lastSpeechAt = t0;
        const iv = setInterval(() => {
          an.getByteTimeDomainData(buf);
          const now = Date.now();
          if (isSpeech(rmsFromByteTimeDomain(buf))) {
            sawSpeech = true;
            lastSpeechAt = now;
          }
          const verdict = vadDecision({ sawSpeech, sinceSpeechMs: now - lastSpeechAt, sinceStartMs: now - t0 });
          if (verdict === 'continue') return;
          if (verdict === 'abort-silent') aborted = true;
          if (rec.state === 'recording') rec.stop();
        }, 100);
        vadCleanup = () => {
          clearInterval(iv);
          void ac.close().catch(() => undefined);
        };
      } catch {
        /* no AudioContext → fall back to tap-to-stop */
      }
    }

    rec.onstop = async () => {
      vadCleanup?.();
      clearTimeout(autoStopRef.current);
      stream.getTracks().forEach((t) => t.stop());
      if (aborted) {
        setVoice('idle'); // heard nothing — silently stand down (no error, no send)
        return;
      }
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
  }, [send]);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

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
    await startListening();
  }, [voice, busy, startListening, stopSpeaking]);

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
      conversation,
      setConversation,
      send,
      toggleVoice,
      decide,
      newChat,
      switchTo,
      deleteSession,
      stopSpeaking,
    }),
    [sessionId, sessions, messages, pending, voice, busy, online, voiceErr, autoSpeak, conversation, setConversation, send, toggleVoice, decide, newChat, switchTo, deleteSession, stopSpeaking],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAIOS(): AIOS {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAIOS outside AIOSProvider');
  return v;
}
