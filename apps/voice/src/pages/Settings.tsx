import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import PageContainer from '../components/PageContainer';
import { Shield, Zap, Volume2, Activity } from 'lucide-react';
import { api } from '../api/client';
import { useAIOS } from '../state/useAIOS';

export default function Settings() {
  const { autoSpeak, setAutoSpeak, conversation, setConversation, online } = useAIOS();
  const [google, setGoogle] = useState<{ connected: boolean; email?: string | null } | null>(null);
  const [milestone, setMilestone] = useState<string>('');

  useEffect(() => {
    api.google().then(setGoogle).catch(() => undefined);
    api.health().then((h) => setMilestone(h.milestone)).catch(() => undefined);
  }, []);

  return (
    <PageContainer>
      <div className="flex flex-col h-full p-8 relative z-20 max-w-3xl">
        <div className="mb-8">
          <h2 className="text-[28px] font-semibold tracking-tight text-[#F7F9FC]">Settings</h2>
          <p className="text-[14px] text-[#5B6575] mt-1">Voice preferences and kernel status.</p>
        </div>

        <div className="space-y-4 overflow-y-auto scrollbar-hide pr-2">
          <Section icon={<Volume2 size={18} className="text-[#3B82F6]" />} title="Voice">
            <Row label="Speak replies aloud" desc="Replies are spoken with a natural voice (Groq PlayAI, falls back to the browser voice)">
              <button
                onClick={() => setAutoSpeak(!autoSpeak)}
                className={`w-12 h-7 rounded-full transition-colors relative ${autoSpeak ? 'bg-[#3B82F6]' : 'bg-[#1a2436]'}`}
              >
                <motion.div layout className="absolute top-1 w-5 h-5 rounded-full bg-white shadow" style={{ left: autoSpeak ? 26 : 4 }} />
              </button>
            </Row>
            <Row label="Conversation mode" desc="Hands-free: the mic re-arms after each spoken reply; silence ends your turn automatically (nothing is sent if you stay quiet)">
              <button
                onClick={() => setConversation(!conversation)}
                className={`w-12 h-7 rounded-full transition-colors relative ${conversation ? 'bg-[#00D4FF]' : 'bg-[#1a2436]'}`}
              >
                <motion.div layout className="absolute top-1 w-5 h-5 rounded-full bg-white shadow" style={{ left: conversation ? 26 : 4 }} />
              </button>
            </Row>
            <Row label="Speech-to-text" desc="Groq Whisper (English-pinned) via the kernel — nothing leaves your machine except the audio to Groq" />
          </Section>

          <Section icon={<Activity size={18} className="text-[#22C55E]" />} title="Kernel">
            <Row label="Status" desc={online ? `Online · ${milestone}` : online === false ? 'Unreachable — run pnpm os:up' : 'Checking…'}>
              <span className={`w-2.5 h-2.5 rounded-full ${online ? 'bg-[#22C55E]' : 'bg-[#F87171]'}`} />
            </Row>
            <Row
              label="Google account"
              desc={google?.connected ? `Connected: ${google.email}` : 'Not connected'}
            >
              {!google?.connected && (
                <a
                  href="http://localhost:4000/oauth/google"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12.5px] text-[#3B82F6] hover:text-[#00D4FF] font-medium"
                >
                  Connect →
                </a>
              )}
            </Row>
          </Section>

          <Section icon={<Shield size={18} className="text-[#F2C14E]" />} title="Trust">
            <Row
              label="Irreversible actions"
              desc="WhatsApp sends and calendar events always pop an approval — nothing runs without your click. Manage per-tool policies in the classic UI at localhost:3000/settings"
            />
          </Section>

          <Section icon={<Zap size={18} className="text-[#00D4FF]" />} title="About">
            <Row label="AI OS Voice" desc="Voice-first surface for your personal AI Operating System — design by Akhil, wired to the kernel on 127.0.0.1:4000" />
          </Section>
        </div>
      </div>
    </PageContainer>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[20px] bg-[#0B1118]/40 border border-white/[0.04] p-5">
      <div className="flex items-center gap-2.5 mb-4">
        {icon}
        <h3 className="text-[15px] font-medium text-[#F7F9FC]">{title}</h3>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Row({ label, desc, children }: { label: string; desc: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="text-[14px] text-[#F7F9FC]">{label}</div>
        <div className="text-[12.5px] text-[#5B6575] mt-0.5 leading-relaxed">{desc}</div>
      </div>
      {children}
    </div>
  );
}
