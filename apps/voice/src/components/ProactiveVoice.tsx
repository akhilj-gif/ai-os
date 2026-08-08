// Voice-out proactivity (Tier 4-4): when the OS produces a proactive
// notification (morning briefing, watch alert, screen-watch, autopilot summary),
// SPEAK it aloud — so the OS reaches out by voice, not just text. Opt-in via the
// "Speak notifications" setting (localStorage, browser-only). Self-contained: it
// polls unread notifications and announces new ones, then marks them read so
// they're never repeated. Renders nothing.
import { useEffect, useRef } from 'react';
import { api } from '../api/client';

export default function ProactiveVoice() {
  const announced = useRef<Set<string>>(new Set());
  const seeded = useRef(false);

  useEffect(() => {
    const tick = async () => {
      if (localStorage.getItem('aios-announce') !== 'on') return;
      const d = await api.notifications(true).catch(() => null);
      if (!d) return;
      // First pass: seed the backlog as "already announced" so enabling the
      // setting doesn't dump a queue of old notifications at you.
      if (!seeded.current) {
        d.notifications.forEach((n) => announced.current.add(n.id));
        seeded.current = true;
        return;
      }
      const fresh = d.notifications.filter((n) => !announced.current.has(n.id)).reverse(); // oldest first
      for (const n of fresh) {
        announced.current.add(n.id);
        try {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(`${n.title}. ${n.body.replace(/[*_#`>|•]/g, ' ').slice(0, 240)}`);
          u.rate = 1.03;
          window.speechSynthesis.speak(u);
        } catch {
          /* no TTS voice — stay silent */
        }
        void api.markNotificationRead(n.id).catch(() => undefined);
      }
    };
    const t = setInterval(() => { if (!document.hidden) void tick(); }, 20_000);
    return () => clearInterval(t);
  }, []);

  return null;
}
