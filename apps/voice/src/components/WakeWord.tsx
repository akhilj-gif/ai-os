// Wake word (Tier 4-4): hands-free activation. When the "Wake word" setting is
// on, a background SpeechRecognition stream listens for "hey OS" / "okay OS" and
// arms the mic — so you never have to tap or press Space. Opt-in (localStorage,
// browser-only; experimental — recognition and the recorder share the mic).
// Renders nothing.
import { useEffect } from 'react';
import { useAIOS } from '../state/useAIOS';

// Loose matcher — recognizers mishear "OS" as oss/oz/aus/os's.
const WAKE_RE = /\b(hey|hi|ok|okay)\s+(os|oss|oz|aus|a\.?o\.?s)\b/i;

export default function WakeWord() {
  const { toggleVoice } = useAIOS();

  useEffect(() => {
    if (localStorage.getItem('aios-wakeword') !== 'on') return;
    const SR = (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (!SR) return;

    let stopped = false;
    let firedAt = 0;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (e: SpeechRecognitionEventLike) => {
      const txt = Array.from(e.results).map((r) => r[0]?.transcript ?? '').join(' ');
      // debounce: one wake per 3s (interim results repeat the phrase)
      if (WAKE_RE.test(txt) && Date.now() - firedAt > 3000) {
        firedAt = Date.now();
        void toggleVoice();
      }
    };
    rec.onend = () => { if (!stopped) { try { rec.start(); } catch { /* already starting */ } } };
    rec.onerror = () => { /* transient (no-speech/network) — onend restarts */ };
    try { rec.start(); } catch { /* ignore */ }

    return () => { stopped = true; try { rec.stop(); } catch { /* ignore */ } };
  }, [toggleVoice]);

  return null;
}

// Minimal shapes for the Web Speech API (not in TS DOM lib by default).
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
