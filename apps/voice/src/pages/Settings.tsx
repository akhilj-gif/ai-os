import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import PageContainer from '../components/PageContainer';
import { Shield, Zap, Volume2, Activity, Bot, ShieldCheck } from 'lucide-react';
import { api, type TrustRung } from '../api/client';
import { useAIOS } from '../state/useAIOS';

export default function Settings() {
  const { autoSpeak, setAutoSpeak, conversation, setConversation, online } = useAIOS();
  const [google, setGoogle] = useState<{ connected: boolean; email?: string | null } | null>(null);
  const [milestone, setMilestone] = useState<string>('');
  const [autopilot, setAutopilot] = useState<string>('off');
  const [proactive, setProactive] = useState<string>('off');
  const [screenWatch, setScreenWatch] = useState<string>('off');
  const [announce, setAnnounce] = useState(() => localStorage.getItem('aios-announce') === 'on');
  const [wake, setWake] = useState(() => localStorage.getItem('aios-wakeword') === 'on');

  function toggleAnnounce() { const n = !announce; setAnnounce(n); localStorage.setItem('aios-announce', n ? 'on' : 'off'); }
  function toggleWake() { const n = !wake; setWake(n); localStorage.setItem('aios-wakeword', n ? 'on' : 'off'); }
  const [ladder, setLadder] = useState<TrustRung[]>([]);
  const [gov, setGov] = useState<{ used: number; max: number } | null>(null);

  const loadLadder = () => api.trustLadder().then((d) => setLadder(d.ladder)).catch(() => undefined);
  const loadGov = () => api.governor().then((g) => setGov({ used: g.used, max: g.max })).catch(() => undefined);
  useEffect(() => {
    api.google().then(setGoogle).catch(() => undefined);
    api.health().then((h) => setMilestone(h.milestone)).catch(() => undefined);
    api.settings().then((s) => { setAutopilot(s.settings.autopilot ?? 'off'); setProactive(s.settings.proactive_delivery ?? 'off'); setScreenWatch(s.settings.screen_watch ?? 'off'); }).catch(() => undefined);
    loadLadder();
    loadGov();
  }, []);

  function toggleScreenWatch() {
    const next = screenWatch === 'on' ? 'off' : 'on';
    setScreenWatch(next);
    void api.setSetting('screen_watch', next).catch(() => undefined);
  }

  async function setBudget(delta: number) {
    if (!gov) return;
    const next = Math.max(0, gov.max + delta);
    setGov({ ...gov, max: next });
    await api.setSetting('autonomy_daily_max', String(next)).catch(() => undefined);
  }

  function setAutopilotMode(mode: string) {
    setAutopilot(mode);
    void api.setSetting('autopilot', mode).catch(() => undefined);
  }
  async function promote(tool: string) { await api.trustPromote(tool).catch(() => undefined); await loadLadder(); }
  async function demote(tool: string) { await api.trustDemote(tool).catch(() => undefined); await loadLadder(); }
  function toggleProactive() {
    const next = proactive === 'on' ? 'off' : 'on';
    setProactive(next);
    void api.setSetting('proactive_delivery', next).catch(() => undefined);
  }

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
            <Row label="Speak notifications aloud" desc="When the OS reaches out (briefing, screen-watch, auto-pilot), it reads the notification to you out loud — proactive by voice, not just on-screen.">
              <button onClick={toggleAnnounce} className={`w-12 h-7 rounded-full transition-colors relative ${announce ? 'bg-[#3B82F6]' : 'bg-[#1a2436]'}`}>
                <motion.div layout className="absolute top-1 w-5 h-5 rounded-full bg-white shadow" style={{ left: announce ? 26 : 4 }} />
              </button>
            </Row>
            <Row label="Wake word (“Hey OS”)" desc="Hands-free: say “Hey OS” and the mic arms itself — no tap, no Space. Experimental (uses the browser's speech recognition).">
              <button onClick={toggleWake} className={`w-12 h-7 rounded-full transition-colors relative ${wake ? 'bg-[#3B82F6]' : 'bg-[#1a2436]'}`}>
                <motion.div layout className="absolute top-1 w-5 h-5 rounded-full bg-white shadow" style={{ left: wake ? 26 : 4 }} />
              </button>
            </Row>
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

          <Section icon={<Bot size={18} className="text-[#B57EDC]" />} title="Autonomy">
            <Row label="Auto-pilot" desc="Off: nothing runs unattended. Read-only: it runs its own read-safe suggestions and reports (never writes/sends/spends). Prepare: it also drafts write actions and QUEUES them for your one-tap approval — still nothing runs without you.">
              <div className="flex items-center gap-1 bg-[#05070A]/60 border border-white/[0.08] rounded-full p-0.5">
                {[['off', 'Off'], ['read', 'Read-only'], ['propose', 'Prepare']].map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setAutopilotMode(v)}
                    className={`px-3 py-1 rounded-full text-[11.5px] font-medium transition-colors ${autopilot === v ? 'bg-[#B57EDC]/25 text-[#B57EDC]' : 'text-[#5B6575] hover:text-[#98A4B8]'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="Proactive delivery (WhatsApp)" desc="Let the OS reach out first: your morning briefing, watch alerts, and auto-pilot summaries are pushed to your own WhatsApp chat. Requires the WhatsApp bridge paired.">
              <button
                onClick={toggleProactive}
                className={`w-12 h-7 rounded-full transition-colors relative ${proactive === 'on' ? 'bg-[#22C55E]' : 'bg-[#1a2436]'}`}
              >
                <motion.div layout className="absolute top-1 w-5 h-5 rounded-full bg-white shadow" style={{ left: proactive === 'on' ? 26 : 4 }} />
              </button>
            </Row>
            <Row label="Watch my screen" desc="The OS glances at your screen on a light cadence and only speaks up when something meaningfully changes (an error, a message, a task waiting). Nothing leaves your machine except the frames it analyzes; off by default.">
              <button
                onClick={toggleScreenWatch}
                className={`w-12 h-7 rounded-full transition-colors relative ${screenWatch === 'on' ? 'bg-[#00D4FF]' : 'bg-[#1a2436]'}`}
              >
                <motion.div layout className="absolute top-1 w-5 h-5 rounded-full bg-white shadow" style={{ left: screenWatch === 'on' ? 26 : 4 }} />
              </button>
            </Row>
            {gov && (
              <Row label="Daily autonomy budget" desc={`A hard ceiling on unattended runs per day (auto-pilot + standing goals). Used ${gov.used} of ${gov.max} today — your own requests never count against it.`}>
                <div className="flex items-center gap-2">
                  <button onClick={() => void setBudget(-5)} className="w-7 h-7 rounded-full border border-white/[0.12] text-[#98A4B8] hover:text-white transition-colors">−</button>
                  <span className="text-[14px] text-[#F7F9FC] tabular-nums w-14 text-center">{gov.used}/{gov.max}</span>
                  <button onClick={() => void setBudget(5)} className="w-7 h-7 rounded-full border border-white/[0.12] text-[#98A4B8] hover:text-white transition-colors">+</button>
                </div>
              </Row>
            )}
          </Section>

          <Section icon={<Shield size={18} className="text-[#F2C14E]" />} title="Trust ladder">
            <div className="text-[12.5px] text-[#5B6575] -mt-1 mb-1 leading-relaxed">
              The OS learns from what you approve. Tools you consistently approve can be promoted to run without a prompt — you stay in control, money actions can never be promoted, and you can revoke anytime.
            </div>
            {ladder.filter((r) => r.approvals + r.rejections > 0).length === 0 ? (
              <div className="text-[13px] text-[#5B6575]">No decisions yet — approve or reject a few actions and they'll show up here.</div>
            ) : (
              <div className="space-y-2">
                {ladder
                  .filter((r) => r.approvals + r.rejections > 0)
                  .map((r) => (
                    <div key={r.tool} className="flex items-center gap-3 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13.5px] text-[#F7F9FC] font-mono truncate">{r.tool}</span>
                          {r.auto_approve && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#22C55E]/15 text-[#22C55E] border border-[#22C55E]/30">auto</span>}
                          {r.trust_class === 'spend' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#F87171]/15 text-[#F87171] border border-[#F87171]/30">spend · locked</span>}
                        </div>
                        <div className="text-[11.5px] text-[#5B6575] mt-0.5">
                          {r.trust_class} · <span className="text-[#22C55E]">{r.approvals} approved</span>{r.rejections > 0 && <> · <span className="text-[#F87171]">{r.rejections} rejected</span></>}
                        </div>
                      </div>
                      {r.trust_class !== 'spend' && (r.auto_approve ? (
                        <button onClick={() => void demote(r.tool)} className="text-[11.5px] px-2.5 py-1 rounded-full border border-white/[0.12] text-[#98A4B8] hover:text-white transition-colors shrink-0">Revoke</button>
                      ) : (
                        <button
                          onClick={() => void promote(r.tool)}
                          className={`flex items-center gap-1 text-[11.5px] px-2.5 py-1 rounded-full border transition-colors shrink-0 ${r.promotable ? 'border-[#22C55E]/40 text-[#22C55E] hover:bg-[#22C55E]/10' : 'border-white/[0.1] text-[#5B6575] hover:text-[#98A4B8]'}`}
                          title={r.promotable ? 'You approve this consistently — trust it to run automatically' : 'Trust this tool to run without a prompt'}
                        >
                          <ShieldCheck size={12} /> {r.promotable ? 'Trust it' : 'Auto-approve'}
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            )}
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
