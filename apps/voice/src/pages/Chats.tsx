import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import PageContainer from '../components/PageContainer';
import VoiceInput from '../components/VoiceInput';
import { Search, MessageSquare, Trash2, Plus, Volume2 } from 'lucide-react';
import { useAIOS } from '../state/useAIOS';

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function Chats() {
  const { sessions, sessionId, switchTo, deleteSession, newChat, messages, busy } = useAIOS();
  const [q, setQ] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy]);

  const filtered = q.trim() ? sessions.filter((s) => (s.first_message ?? '').toLowerCase().includes(q.toLowerCase())) : sessions;

  function speakMessage(text: string) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/[*_#`>|]/g, '').slice(0, 900));
      window.speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
  }

  return (
    <PageContainer>
      <div className="flex h-full relative z-20 gap-5 p-6">
        {/* Session list */}
        <div className="w-[320px] flex flex-col shrink-0">
          <div className="flex justify-between items-center mb-5">
            <h2 className="text-[22px] font-semibold tracking-tight text-[#F7F9FC]">Conversations</h2>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => void newChat()}
              title="New chat"
              className="w-9 h-9 rounded-full bg-[#3B82F6]/10 border border-[#3B82F6]/30 flex items-center justify-center text-[#3B82F6]"
            >
              <Plus size={16} />
            </motion.button>
          </div>
          <div className="relative mb-4">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5B6575]" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search chats..."
              className="bg-[#0B1118]/80 border border-white/[0.08] backdrop-blur-[24px] rounded-full py-2 pl-9 pr-4 text-[13px] text-[#F7F9FC] placeholder-[#5B6575] focus:outline-none focus:border-[#3B82F6]/50 w-full"
            />
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-hide space-y-2 pr-1">
            {filtered.map((s) => (
              <div
                key={s.id}
                onClick={() => switchTo(s.id)}
                className={`p-3.5 rounded-[16px] cursor-pointer transition-all border group ${
                  s.id === sessionId
                    ? 'bg-gradient-to-r from-[#3B82F6]/10 to-transparent border-[#3B82F6]/30 shadow-[0_0_20px_rgba(59,130,246,0.1)]'
                    : 'bg-[#0B1118]/40 border-white/[0.04] hover:bg-[#101722]/80 hover:border-white/[0.1]'
                }`}
              >
                <div className="flex justify-between items-center gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${s.id === sessionId ? 'bg-[#3B82F6]/20 text-[#3B82F6]' : 'bg-white/[0.05] text-[#98A4B8]'}`}>
                      <MessageSquare size={12} />
                    </div>
                    <span className={`text-[13.5px] truncate ${s.id === sessionId ? 'text-[#F7F9FC] font-medium' : 'text-[#98A4B8]'}`}>
                      {s.first_message ?? 'New chat'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-[#5B6575]">{timeAgo(s.updated_at)}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteSession(s.id);
                      }}
                      title="Delete chat"
                      className="opacity-0 group-hover:opacity-100 text-[#F87171]/70 hover:text-[#F87171] transition-all"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {filtered.length === 0 && <div className="text-[13px] text-[#5B6575] px-2 py-4">No chats yet.</div>}
          </div>
        </div>

        {/* Thread */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#080B10]/50 border border-white/[0.04] backdrop-blur-[24px] rounded-[24px] overflow-hidden">
          <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-hide">
            {messages.length === 0 && (
              <div className="h-full flex items-center justify-center text-[#5B6575] text-[14px]">Say something — voice or text.</div>
            )}
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[78%] px-4.5 py-3 rounded-[18px] text-[14px] leading-relaxed whitespace-pre-wrap break-words group relative px-4 ${
                    m.role === 'user'
                      ? 'bg-[#3B82F6]/15 border border-[#3B82F6]/25 text-[#F7F9FC]'
                      : 'bg-[#0B1118]/80 border border-white/[0.05] text-[#E6EAF2]'
                  }`}
                >
                  {m.content}
                  {m.role === 'assistant' && (
                    <button
                      onClick={() => speakMessage(m.content)}
                      title="Read aloud"
                      className="absolute -right-8 top-2 opacity-0 group-hover:opacity-100 text-[#5B6575] hover:text-[#00D4FF] transition-all"
                    >
                      <Volume2 size={15} />
                    </button>
                  )}
                </div>
              </motion.div>
            ))}
            {busy && <div className="text-[13px] text-[#5B6575] animate-pulse pl-1">⏳ kernel working…</div>}
            <div ref={bottomRef} />
          </div>
          <VoiceInput />
        </div>
      </div>
    </PageContainer>
  );
}
