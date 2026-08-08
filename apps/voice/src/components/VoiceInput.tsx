import { useRef, useState } from 'react';
import { Mic, Send, Square, Paperclip, X, FileText } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAIOS } from '../state/useAIOS';
import type { Attachment } from '../api/client';

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // matches the API's 20MB JSON body budget across up to 4 files

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export default function VoiceInput() {
  const { send, busy, voice, toggleVoice, voiceErr, online, conversation, setConversation } = useAIOS();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFilesPicked(files: FileList | null) {
    if (!files?.length) return;
    setAttachErr(null);
    const room = MAX_ATTACHMENTS - attachments.length;
    const picked = Array.from(files).slice(0, Math.max(room, 0));
    if (files.length > picked.length) setAttachErr(`Up to ${MAX_ATTACHMENTS} attachments at a time.`);
    for (const file of picked) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachErr(`"${file.name}" is too large — max 8MB.`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        setAttachments((a) => [...a, { name: file.name, mime: file.type || 'application/octet-stream', dataUrl }]);
      } catch {
        setAttachErr(`Couldn't read "${file.name}".`);
      }
    }
  }

  function removeAttachment(i: number) {
    setAttachments((a) => a.filter((_, idx) => idx !== i));
  }

  async function submit() {
    const t = text.trim();
    if ((!t && attachments.length === 0) || busy) return;
    setText('');
    const files = attachments;
    setAttachments([]);
    await send(t, files);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.5, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="px-8 pb-5 pt-2 z-10 w-full mx-auto mt-auto shrink-0"
    >
      {voiceErr && <div className="text-center text-[12.5px] text-[#F87171] mb-2">{voiceErr}</div>}
      {attachErr && <div className="text-center text-[12.5px] text-[#F87171] mb-2">{attachErr}</div>}

      <div className="mx-auto w-full max-w-[800px] flex items-center justify-center gap-2 mb-2.5">
        <ModeButton active={conversation} onClick={() => setConversation(true)} label="Conversation" title="Hands-free — the mic re-arms after each reply" />
        <ModeButton
          active={!conversation}
          onClick={() => setConversation(false)}
          label="Normal"
          title="Push-to-talk only — the mic never auto-listens, so talking to someone nearby won't trigger a command"
        />
      </div>

      {attachments.length > 0 && (
        <div className="mx-auto w-full max-w-[800px] flex flex-wrap gap-2 mb-3">
          {attachments.map((a, i) => (
            <div
              key={`${a.name}-${i}`}
              className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-full bg-[#0B1118]/80 border border-white/[0.08] text-[12.5px] text-[#98A4B8]"
            >
              {a.mime.startsWith('image/') ? (
                <img src={a.dataUrl} alt={a.name} className="w-6 h-6 rounded-full object-cover" />
              ) : (
                <FileText size={14} className="text-[#3B82F6]" />
              )}
              <span className="max-w-[140px] truncate">{a.name}</span>
              <button
                onClick={() => removeAttachment(i)}
                title="Remove"
                className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-white/10 text-[#5B6575] hover:text-[#F87171] transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 bg-[#05070A]/40 border border-white/[0.06] backdrop-blur-[24px] rounded-[20px] p-2 pl-3 shadow-lg focus-within:border-white/[0.15] transition-all duration-300 mx-auto w-full max-w-[800px]">
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          accept="image/*,.txt,.md,.csv,.json"
          onChange={(e) => {
            void onFilesPicked(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          title="Attach an image or file"
          className="p-2 rounded-full text-[#5B6575] hover:text-[#F7F9FC] hover:bg-white/[0.05] transition-colors"
        >
          <Paperclip size={19} />
        </button>
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
          className="flex-1 bg-transparent border-none outline-none text-[#F7F9FC] placeholder-[#5B6575] text-[15px] font-light px-2 min-w-0"
        />
        <button
          onClick={() => void submit()}
          disabled={busy || (!text.trim() && attachments.length === 0)}
          className="w-10 h-10 rounded-full bg-[#3B82F6] disabled:bg-[#1a2436] disabled:text-[#5B6575] flex items-center justify-center text-white hover:bg-[#2563EB] hover:scale-105 active:scale-95 transition-all duration-300 group shrink-0"
        >
          <Send size={16} className="ml-0.5 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </button>
      </div>
    </motion.div>
  );
}

function ModeButton({ active, onClick, label, title }: { active: boolean; onClick: () => void; label: string; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-3.5 py-1.5 rounded-full text-[12px] font-medium transition-all border ${
        active
          ? 'bg-[#00D4FF]/15 border-[#00D4FF]/40 text-[#00D4FF]'
          : 'bg-transparent border-white/[0.06] text-[#5B6575] hover:text-[#98A4B8] hover:border-white/[0.12]'
      }`}
    >
      {label}
    </button>
  );
}
