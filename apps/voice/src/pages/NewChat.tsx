import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import { MessageSquarePlus, Sparkles, Brain, Calendar } from 'lucide-react';
import { useAIOS } from '../state/useAIOS';

export default function NewChat() {
  const { newChat, send } = useAIOS();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  // Starters map to REAL capabilities (research pack, plate-today pattern, scheduler).
  const templates = [
    { title: 'Deep Research', icon: <Brain size={18} className="text-[#00D4FF]" />, desc: 'Research a topic on the web with citations', prompt: 'Research the web for: ' },
    { title: "Today's Briefing", icon: <Sparkles size={18} className="text-[#3B82F6]" />, desc: 'Calendar + inbox, synthesized', prompt: "What's on my plate today?" },
    { title: 'Schedule Something', icon: <Calendar size={18} className="text-[#22C55E]" />, desc: 'Create a calendar event (you approve it)', prompt: 'Schedule a meeting ' },
  ];

  async function start(prompt?: string) {
    if (creating) return;
    setCreating(true);
    await newChat();
    navigate('/chats');
    // Fire-and-forget: full prompts run immediately; prefixes just seed the composer via send skip.
    if (prompt && !prompt.endsWith(' ')) void send(prompt);
    setCreating(false);
  }

  return (
    <PageContainer>
      <div className="flex-1 flex flex-col items-center justify-center p-8 relative z-20 mt-[-40px]">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#3B82F6]/20 to-[#00D4FF]/20 flex items-center justify-center border border-[#3B82F6]/30 mb-6 shadow-[0_0_30px_rgba(59,130,246,0.2)]">
          <MessageSquarePlus size={28} className="text-[#3B82F6]" />
        </div>
        <h2 className="text-[32px] font-semibold tracking-tight text-[#F7F9FC] mb-2">New Conversation</h2>
        <p className="text-[16px] text-[#98A4B8] font-light max-w-md text-center mb-12">
          Start a fresh thread — shorter chats keep the OS fast on free-tier model quotas.
        </p>

        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          disabled={creating}
          onClick={() => void start()}
          className="mb-10 px-8 py-3.5 rounded-full bg-[#3B82F6] hover:bg-[#2563EB] text-white text-[15px] font-medium shadow-[0_0_30px_rgba(59,130,246,0.35)] transition-colors disabled:opacity-60"
        >
          {creating ? 'Creating…' : 'Start blank chat'}
        </motion.button>

        <div className="grid grid-cols-3 gap-4 w-full max-w-3xl">
          {templates.map((t, i) => (
            <motion.button
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              key={t.title}
              disabled={creating}
              onClick={() => void start(t.prompt)}
              className="p-5 rounded-[20px] bg-[#0B1118]/60 border border-white/[0.04] hover:bg-[#101722]/80 hover:border-[#3B82F6]/30 transition-all text-left group disabled:opacity-60"
            >
              <div className="w-10 h-10 rounded-full bg-white/[0.03] flex items-center justify-center mb-4 group-hover:bg-white/[0.06] transition-colors">{t.icon}</div>
              <h3 className="text-[15px] font-medium text-[#F7F9FC] mb-1">{t.title}</h3>
              <p className="text-[13px] text-[#5B6575] leading-snug">{t.desc}</p>
            </motion.button>
          ))}
        </div>
      </div>
    </PageContainer>
  );
}
