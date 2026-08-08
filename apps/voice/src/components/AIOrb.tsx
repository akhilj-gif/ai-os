import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Mic, Square, Loader2, AudioLines, Ear } from 'lucide-react';
import type { VoiceState } from '../state/useAIOS';

// The orb is the app's face — its motion is driven by the live voice state.
const STATE = {
  idle: { accent: '#3B82F6', ring: '#00D4FF', pulse: 6, corePulse: 3 },
  listening: { accent: '#00D4FF', ring: '#00D4FF', pulse: 1.6, corePulse: 0.9 },
  transcribing: { accent: '#3B82F6', ring: '#F2C14E', pulse: 1.2, corePulse: 0.8 },
  thinking: { accent: '#3B82F6', ring: '#3B82F6', pulse: 2.4, corePulse: 1.4 },
  speaking: { accent: '#22C55E', ring: '#00D4FF', pulse: 2.0, corePulse: 1.2 },
} as const;

// The orb is authored at a fixed 400px "design box"; the whole thing is then
// uniformly scaled to `size` so EVERY element (rings, glow, waveform, icon,
// particles) keeps the same proportion at any size. Scaling only the rings —
// the old bug — made the glow/waveform/icon look wrong at smaller sizes.
const DESIGN = 400;

function CoreIcon({ state }: { state: VoiceState }) {
  const cls = 'drop-shadow-[0_0_15px_rgba(255,255,255,0.5)]';
  if (state === 'listening') return <Square size={44} strokeWidth={1.5} className={cls} />;
  if (state === 'transcribing') return <Ear size={52} strokeWidth={1.5} className={cls} />;
  if (state === 'thinking') return <Loader2 size={52} strokeWidth={1.5} className={`${cls} animate-spin`} />;
  if (state === 'speaking') return <AudioLines size={52} strokeWidth={1.5} className={cls} />;
  return <Mic size={56} strokeWidth={1.5} className={cls} />;
}

export default function AIOrb({ state = 'idle', onClick, size = 400 }: { state?: VoiceState; onClick?: () => void; size?: number }) {
  const cfg = STATE[state];
  const scale = size / DESIGN;

  // Compute particle geometry ONCE (not on every render) so they don't teleport
  // when the voice state changes. Positions are deterministic per-index with a
  // stable random jitter captured at mount.
  const particles = useMemo(
    () =>
      Array.from({ length: 24 }).map((_, i) => {
        const radius = 180 + Math.random() * 80;
        const angle = (i * 15 * Math.PI) / 180;
        return {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
          jitterX: Math.random() * 20 - 10,
          jitterY: Math.random() * 20 - 10,
          duration: 3 + Math.random() * 4,
          delay: Math.random() * 3,
        };
      }),
    [],
  );

  return (
    <button
      onClick={onClick}
      style={{ width: size, height: size }}
      className="relative flex items-center justify-center outline-none cursor-pointer shrink-0"
      aria-label={state === 'idle' ? 'Tap to speak' : state}
    >
      {/* The fixed 400px design box, uniformly scaled to `size`. */}
      <div
        className="absolute left-1/2 top-1/2"
        style={{ width: DESIGN, height: DESIGN, transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        {/* Deep Background Glow */}
        <motion.div
          animate={{ scale: [1, 1.05, 1], opacity: state === 'idle' ? [0.15, 0.25, 0.15] : [0.25, 0.45, 0.25] }}
          transition={{ duration: cfg.pulse, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute inset-0 blur-[100px] rounded-full mix-blend-screen pointer-events-none"
          style={{ backgroundColor: cfg.accent }}
        />

        {/* Horizontal Sound Waveform Background Line */}
        <div className="absolute top-1/2 left-[-60%] right-[-60%] h-[200px] -translate-y-1/2 pointer-events-none opacity-40 mix-blend-screen flex items-center">
          <svg viewBox="0 0 1000 200" className="w-full h-full" preserveAspectRatio="none" style={{ color: cfg.accent }}>
            <motion.path
              d="M0,100 Q100,80 200,100 T400,100 T600,100 T800,100 T1000,100"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              animate={{
                d: [
                  'M0,100 Q100,80 200,100 T400,100 T600,100 T800,100 T1000,100',
                  'M0,100 Q150,140 300,100 T600,100 T800,100 T1000,100',
                  'M0,100 Q100,60 200,100 T400,100 T600,100 T800,100 T1000,100',
                  'M0,100 Q100,80 200,100 T400,100 T600,100 T800,100 T1000,100',
                ],
              }}
              transition={{ duration: state === 'listening' || state === 'speaking' ? 2.5 : 8, repeat: Infinity, ease: 'easeInOut' }}
              className="opacity-40"
            />
            <motion.path
              d="M0,100 Q150,120 300,100 T600,100 T900,100 T1000,100"
              fill="none"
              stroke="#00D4FF"
              strokeWidth="0.8"
              animate={{
                d: [
                  'M0,100 Q150,120 300,100 T600,100 T900,100 T1000,100',
                  'M0,100 Q120,60 240,100 T600,100 T900,100 T1000,100',
                  'M0,100 Q150,120 300,100 T600,100 T900,100 T1000,100',
                ],
              }}
              transition={{ duration: state === 'listening' || state === 'speaking' ? 2 : 6, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
              className="opacity-60"
            />
            <line x1="0" y1="100" x2="1000" y2="100" stroke={cfg.accent} strokeWidth="0.5" className="opacity-20" />
          </svg>
        </div>

        {/* Rotating dashed ring outer */}
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: state === 'thinking' ? 14 : 60, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-0 rounded-full border border-dashed"
          style={{ borderColor: `${cfg.accent}33` }}
        />

        {/* Middle rotating ring */}
        <motion.div
          animate={{ rotate: -360 }}
          transition={{ duration: state === 'thinking' ? 10 : 40, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-[30px] rounded-full border border-dashed"
          style={{ borderWidth: '1.5px', borderColor: `${cfg.ring}4D` }}
        />

        {/* Inner glowing plasma ring */}
        <motion.div
          animate={{ scale: [1, 1.03, 1], opacity: [0.6, 0.9, 0.6] }}
          transition={{ duration: cfg.corePulse + 1, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute inset-[60px] rounded-full border"
          style={{ borderColor: `${cfg.accent}80`, boxShadow: `0 0 40px ${cfg.accent}4D inset, 0 0 40px ${cfg.accent}4D` }}
        />

        {/* The Solid Core */}
        <div
          className="absolute inset-[85px] rounded-full border-[1.5px] bg-gradient-to-b from-[#05070A] to-[#101722] backdrop-blur-xl flex items-center justify-center overflow-hidden"
          style={{ borderColor: `${cfg.ring}99`, boxShadow: `0 0 60px ${cfg.accent}99` }}
        >
          <motion.div
            animate={{ scale: [0.8, 1.2, 0.8], opacity: [0.3, 0.6, 0.3] }}
            transition={{ duration: cfg.corePulse, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute inset-[-20px] mix-blend-screen"
            style={{ background: `radial-gradient(circle at center, ${cfg.accent} 0%, transparent 60%)` }}
          />
          <div className="relative z-10 text-[#F7F9FC]">
            <CoreIcon state={state} />
          </div>
        </div>

        {/* Floating particles around orb (positions fixed at mount — no jitter) */}
        {particles.map((p, i) => (
          <motion.div
            key={i}
            animate={{
              x: [p.x, p.x + p.jitterX, p.x],
              y: [p.y, p.y + p.jitterY, p.y],
              opacity: [0.1, 0.7, 0.1],
              scale: [0.5, 1.2, 0.5],
            }}
            transition={{ duration: p.duration, repeat: Infinity, delay: p.delay, ease: 'easeInOut' }}
            className="absolute w-1 h-1 rounded-full bg-[#00D4FF] blur-[0.5px]"
            style={{ left: '50%', top: '50%', marginLeft: '-2px', marginTop: '-2px' }}
          />
        ))}
      </div>
    </button>
  );
}
