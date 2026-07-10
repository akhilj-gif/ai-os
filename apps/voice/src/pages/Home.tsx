import { useEffect } from 'react';
import { Menu, SlidersHorizontal, Sun } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import AIOrb from '../components/AIOrb';
import QuickActions from '../components/QuickActions';
import VoiceInput from '../components/VoiceInput';
import PageContainer from '../components/PageContainer';
import { useAIOS } from '../state/useAIOS';

const STATUS_LINE: Record<string, string> = {
  listening: 'Listening… tap the orb to run the command',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
  speaking: 'Speaking — tap the orb to interrupt',
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Up late, Akhil';
  if (h < 12) return 'Good morning, Akhil';
  if (h < 17) return 'Good afternoon, Akhil';
  return 'Good evening, Akhil';
}

export default function Home() {
  const { voice, toggleVoice, messages, busy, conversation } = useAIOS();
  const navigate = useNavigate();

  // Space = push-to-talk toggle (when not typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        void toggleVoice();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleVoice]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  return (
    <PageContainer>
      {/* Top Bar */}
      <div className="flex items-center justify-between p-6 z-20">
        <motion.button
          whileHover={{ scale: 1.05, backgroundColor: 'rgba(255,255,255,0.08)' }}
          whileTap={{ scale: 0.95 }}
          onClick={() => navigate('/chats')}
          title="Conversations"
          className="w-11 h-11 rounded-full bg-transparent border border-white/[0.08] flex items-center justify-center text-[#98A4B8] hover:text-white transition-colors"
        >
          <Menu size={20} />
        </motion.button>

        <div className="flex items-center gap-3">
          <motion.button
            whileHover={{ scale: 1.05, backgroundColor: 'rgba(255,255,255,0.08)' }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate('/settings')}
            title="Settings"
            className="w-11 h-11 rounded-full bg-transparent border border-white/[0.08] flex items-center justify-center text-[#98A4B8] hover:text-white transition-colors"
          >
            <SlidersHorizontal size={18} />
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05, backgroundColor: 'rgba(255,255,255,0.08)' }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate('/jobs')}
            title="Automations"
            className="w-11 h-11 rounded-full bg-transparent border border-white/[0.08] flex items-center justify-center text-[#98A4B8] hover:text-white transition-colors"
          >
            <Sun size={20} />
          </motion.button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 z-10 relative mt-[-40px]">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="text-center mb-10"
        >
          <h2 className="text-[36px] font-semibold tracking-tight text-[#F7F9FC] mb-2 drop-shadow-sm">{greeting()}</h2>
          <p className="text-[20px] text-[#98A4B8] font-light">How can I help you today?</p>
        </motion.div>

        <AIOrb state={voice} onClick={() => void toggleVoice()} />
        {conversation && (
          <div className="mt-4 flex items-center gap-2 text-[12.5px] text-[#00D4FF]/80">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00D4FF] animate-pulse" />
            Conversation mode — the mic re-arms after each reply
          </div>
        )}

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8, duration: 1 }} className="mt-10 text-center min-h-[64px]">
          <AnimatePresence mode="wait">
            {voice !== 'idle' || busy ? (
              <motion.div key="status" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
                <div className="text-[#00D4FF] font-medium text-[16px] tracking-wide mb-2.5">
                  {STATUS_LINE[voice] ?? (busy ? 'Working…' : '')}
                </div>
              </motion.div>
            ) : lastAssistant ? (
              <motion.div key="last" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="max-w-[640px] mx-auto">
                <div className="text-[#98A4B8] text-[14px] leading-relaxed line-clamp-2">{lastAssistant.content}</div>
                <div className="text-[#5B6575] text-[12px] mt-2">
                  Tap the orb or press <kbd className="px-2 py-0.5 rounded-md bg-[#0B1118] border border-white/[0.08] text-[#98A4B8] text-xs font-sans mx-1">Space</kbd> to speak
                </div>
              </motion.div>
            ) : (
              <motion.div key="hint" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
                <div className="text-[#3B82F6] font-medium text-[16px] tracking-wide mb-2.5">Tap to speak</div>
                <div className="text-[#5B6575] text-[13px]">
                  or press{' '}
                  <kbd className="px-2.5 py-1 rounded-md bg-[#0B1118] border border-white/[0.08] text-[#98A4B8] text-xs font-sans mx-1 shadow-sm">Space</kbd> to
                  start
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        <QuickActions />
      </div>

      <VoiceInput />
    </PageContainer>
  );
}
