import { useState } from 'react';
import { Mic, Send, Square } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAIOS } from '../state/useAIOS';

export default function VoiceInput() {
  const { send, busy, voice, toggleVoice, voiceErr, online } = useAIOS();
  const [text, setText] = useState('');

  async function submit() {
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    await send(t);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.5, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="p-8 pt-0 z-10 w-full mx-auto mt-auto"
    >
      {voiceErr && <div className="text-center text-[12.5px] text-[#F87171] mb-2">{voiceErr}</div>}
      <div className="flex items-center gap-3 bg-[#05070A]/40 border border-white/[0.06] backdrop-blur-[24px] rounded-[20px] p-2 pl-4 shadow-lg focus-within:border-white/[0.15] transition-all duration-300 mx-auto w-full max-w-[800px]">
        <button
          onClick={() => void toggleVoice()}
          title={voice === 'listening' ? 'Stop & run the command' : 'Speak a command'}
          className={`transition-colors p-2 rounded-full hover:bg-white/[0.05] ${voice === 'listening' ? 'text-[#F87171]' : 'text-[#5B6575] hover:text-[#F7F9FC]'}`}
        >
          {voice === 'listening' ? <Square size={20} /> : <Mic size={20} />}
        </button>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder={
            online === false
              ? 'Kernel offline — is the OS running?'
              : voice === 'listening'
                ? '🔴 Listening — click ⏹ to run the command'
                : voice === 'transcribing'
                  ? 'Transcribing…'
                  : busy
                    ? 'Working…'
                    : 'Type a message or use voice...'
          }
          className="flex-1 bg-transparent border-none outline-none text-[#F7F9FC] placeholder-[#5B6575] text-[15px] font-light px-2"
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
          className="w-10 h-10 rounded-full bg-[#3B82F6] disabled:bg-[#1a2436] disabled:text-[#5B6575] flex items-center justify-center text-white hover:bg-[#2563EB] hover:scale-105 active:scale-95 transition-all duration-300 group"
        >
          <Send size={16} className="ml-0.5 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </button>
      </div>
    </motion.div>
  );
}
