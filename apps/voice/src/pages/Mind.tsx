import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import { Brain, Eye, Sparkles, HelpCircle, Lightbulb, Loader2, Wand2, Play, Bot, Target, Plus, Pause } from 'lucide-react';
import { api, type CognitiveBriefing, type Suggestion, type StandingGoal } from '../api/client';
import { useAIOS } from '../state/useAIOS';

export default function Mind() {
  const { send } = useAIOS();
  const navigate = useNavigate();
  const [b, setB] = useState<CognitiveBriefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [thinking, setThinking] = useState(false);
  const [auto, setAuto] = useState<{ running: boolean; ran: Array<{ action: string; status: string; text: string }> | null; mode: string }>({ running: false, ran: null, mode: '' });
  const [goals, setGoals] = useState<StandingGoal[]>([]);
  const [newGoal, setNewGoal] = useState('');
  const [advancing, setAdvancing] = useState<string | null>(null);

  const load = () => api.cognitionBriefing().then(setB).catch(() => undefined).finally(() => setLoading(false));
  const loadGoals = () => api.standingList().then((d) => setGoals(d.goals)).catch(() => undefined);
  useEffect(() => { load(); loadGoals(); }, []);

  async function addGoal() {
    const g = newGoal.trim();
    if (!g) return;
    setNewGoal('');
    await api.standingCreate(g).catch(() => undefined);
    await loadGoals();
  }
  async function advanceGoal(id: string) {
    setAdvancing(id);
    await api.standingAdvance(id).catch(() => undefined);
    await loadGoals();
    setAdvancing(null);
  }
  async function toggleGoal(id: string, status: string) {
    await api.standingSetStatus(id, status === 'active' ? 'paused' : 'active').catch(() => undefined);
    await loadGoals();
  }

  async function think() {
    setThinking(true);
    await api.cognitionConsolidate().catch(() => undefined); // consolidate experience → insights
    await load(); // refresh the briefing (picks up new insights + fresh foresight)
    setThinking(false);
  }

  // Autopilot: let the OS run its own top read-safe suggestions unattended
  // (read-only — mutations are refused). Requires Settings → Autonomy = on.
  async function runAutopilot() {
    setAuto({ running: true, ran: null, mode: '' });
    const r = await api.cognitionAutopilot().catch(() => ({ mode: 'error', ran: [] }));
    setAuto({ running: false, ran: r.ran, mode: r.mode });
  }

  // Act on a self-generated prediction: run it through the normal trust-gated
  // pipeline (irreversible/spend still pop an approval card) and go watch it.
  function runAction(action: string) {
    void send(action);
    navigate('/chats');
  }

  const s = b?.signals;

  return (
    <PageContainer>
      <div className="flex flex-col h-full p-8 relative z-20">
        <div className="flex justify-between items-start mb-6 shrink-0">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#B57EDC]/20 to-[#3B82F6]/20 flex items-center justify-center border border-[#B57EDC]/30 shadow-[0_0_25px_rgba(181,126,220,0.2)]">
              <Brain size={24} className="text-[#B57EDC]" />
            </div>
            <div>
              <h2 className="text-[28px] font-semibold tracking-tight text-[#F7F9FC] leading-tight">Mind</h2>
              <p className="text-[13.5px] text-[#5B6575]">What the OS has learned, what it foresees, and what it wants to ask.</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => void runAutopilot()}
              disabled={auto.running}
              title="Run the OS's own read-safe suggestions unattended (read-only — nothing is sent, written, or spent). Enable in Settings → Autonomy."
              className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-[#00D4FF]/12 border border-[#00D4FF]/35 text-[#00D4FF] text-[13.5px] font-medium hover:bg-[#00D4FF]/22 transition-colors disabled:opacity-60"
            >
              {auto.running ? <Loader2 size={16} className="animate-spin" /> : <Bot size={16} />}
              {auto.running ? 'Running…' : 'Auto-pilot'}
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => void think()}
              disabled={thinking}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-[#B57EDC]/15 border border-[#B57EDC]/40 text-[#B57EDC] text-[13.5px] font-medium hover:bg-[#B57EDC]/25 transition-colors disabled:opacity-60"
            >
              {thinking ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
              {thinking ? 'Thinking…' : 'Think now'}
            </motion.button>
          </div>
        </div>

        {auto.ran !== null && (
          <div className="mb-4 shrink-0 rounded-[14px] bg-[#00D4FF]/[0.06] border border-[#00D4FF]/25 px-4 py-3">
            {auto.mode !== 'read' ? (
              <div className="text-[13px] text-[#98A4B8]">Auto-pilot is off — turn it on in <span className="text-[#00D4FF]">Settings → Autonomy</span>, then it runs its own read-safe actions here.</div>
            ) : auto.ran.length === 0 ? (
              <div className="text-[13px] text-[#98A4B8]">Auto-pilot ran — no read-safe actions to take right now.</div>
            ) : (
              <div className="space-y-1.5">
                <div className="text-[12px] font-medium text-[#00D4FF] flex items-center gap-1.5"><Bot size={13} /> Auto-pilot did {auto.ran.length} read-only action{auto.ran.length === 1 ? '' : 's'}:</div>
                {auto.ran.map((r, i) => (
                  <div key={i} className="text-[13px] text-[#E6EAF2] leading-relaxed"><span className="text-[#5B6575]">{r.status} ·</span> {r.text}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-[#5B6575] text-[14px]">
            <Loader2 size={18} className="animate-spin mr-2" /> reading its own memory…
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto scrollbar-hide pr-2 space-y-5">
            <AnimatePresence mode="wait">
              <motion.div key={b?.generatedAt} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <Section icon={<Eye size={17} className="text-[#00D4FF]" />} title="Foresees you'll need" accent="#00D4FF" items={b?.predictions ?? []} empty="Nothing predicted yet — use the OS and it'll anticipate." />
                <SuggestionSection suggestions={b?.suggestions ?? []} onRun={runAction} />
                <Section icon={<HelpCircle size={17} className="text-[#F2C14E]" />} title="Wants to ask you" accent="#F2C14E" items={b?.questions ?? []} empty="No open questions — it's confident about what it knows." />
              </motion.div>
            </AnimatePresence>

            <div className="rounded-[18px] bg-gradient-to-br from-[#B57EDC]/[0.06] to-transparent border border-[#B57EDC]/20 p-5">
              <div className="flex items-center gap-2.5 mb-3">
                <Lightbulb size={17} className="text-[#B57EDC]" />
                <h3 className="text-[15px] font-medium text-[#F7F9FC]">Insights it has formed</h3>
                <span className="text-[11px] text-[#5B6575]">· generalized from experience while "dreaming"</span>
              </div>
              {b?.insights.length ? (
                <div className="space-y-2.5">
                  {b.insights.map((ins, i) => (
                    <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className="flex gap-2.5 text-[14px] text-[#E6EAF2] leading-relaxed">
                      <span className="text-[#B57EDC] shrink-0">✦</span>
                      <span>{ins}</span>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="text-[13.5px] text-[#5B6575]">No insights yet. Hit <span className="text-[#B57EDC]">Think now</span> to consolidate recent experience into durable lessons.</div>
              )}
            </div>

            <div className="rounded-[18px] bg-[#0B1118]/50 border border-white/[0.05] p-5">
              <div className="flex items-center gap-2.5 mb-3">
                <Target size={17} className="text-[#00D4FF]" />
                <h3 className="text-[15px] font-medium text-[#F7F9FC]">Standing goals</h3>
                <span className="text-[11px] text-[#5B6575]">· long-horizon goals the OS advances on its own (read-only), between sessions</span>
              </div>
              <div className="flex items-center gap-2 mb-3">
                <input
                  value={newGoal}
                  onChange={(e) => setNewGoal(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void addGoal()}
                  placeholder="Give it a standing goal — e.g. 'track pgvector releases and summarize changes'"
                  className="flex-1 bg-[#05070A]/60 border border-white/[0.08] rounded-full py-2 px-4 text-[13px] text-[#F7F9FC] placeholder-[#5B6575] focus:outline-none focus:border-[#00D4FF]/40"
                />
                <button onClick={() => void addGoal()} className="w-9 h-9 rounded-full bg-[#00D4FF]/12 border border-[#00D4FF]/35 flex items-center justify-center text-[#00D4FF] hover:bg-[#00D4FF]/22 transition-colors shrink-0"><Plus size={16} /></button>
              </div>
              {goals.length === 0 ? (
                <div className="text-[13px] text-[#5B6575]">No standing goals yet. Add one and the OS will chip away at it on its own.</div>
              ) : (
                <div className="space-y-2.5">
                  {goals.map((g) => {
                    const last = g.progress ? g.progress.split('\n').pop() : '';
                    return (
                      <div key={g.id} className="rounded-[13px] bg-[#05070A]/40 border border-white/[0.05] px-4 py-3">
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-[13.5px] text-[#F7F9FC] leading-snug">{g.goal}</div>
                            <div className="text-[11.5px] text-[#5B6575] mt-1">{g.steps} step{g.steps === 1 ? '' : 's'} · {g.status}{last ? ` · latest: ${last.replace(/^\[[^\]]*\]\s*/, '').slice(0, 90)}` : ''}</div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button onClick={() => void advanceGoal(g.id)} disabled={advancing === g.id} title="Advance one read-only step now" className="w-8 h-8 rounded-full bg-[#00D4FF]/10 border border-[#00D4FF]/30 flex items-center justify-center text-[#00D4FF] hover:bg-[#00D4FF]/20 transition-colors disabled:opacity-50">
                              {advancing === g.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={12} className="fill-current" />}
                            </button>
                            <button onClick={() => void toggleGoal(g.id, g.status)} title={g.status === 'active' ? 'Pause' : 'Resume'} className="w-8 h-8 rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-[#98A4B8] hover:text-white transition-colors">
                              {g.status === 'active' ? <Pause size={12} /> : <Play size={12} className="fill-current" />}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {s && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-[#5B6575] px-1">
                <span className="text-[#98A4B8]">grounded in:</span>
                <span>{s.episodes} episodes</span>
                <span>· {s.failures} failures</span>
                <span>· {s.openTodos} todos</span>
                <span>· {s.entities} graph entities</span>
                {s.contradictions > 0 && <span className="text-[#F2C14E]">· {s.contradictions} conflicts</span>}
                {s.lowConfidence > 0 && <span>· {s.lowConfidence} uncertain facts</span>}
                {b && <span className="ml-auto">{b.context.weekday}, {String(b.context.hour).padStart(2, '0')}:00</span>}
              </div>
            )}
          </div>
        )}
      </div>
    </PageContainer>
  );
}

function SuggestionSection({ suggestions, onRun }: { suggestions: Suggestion[]; onRun: (action: string) => void }) {
  return (
    <div className="rounded-[18px] bg-[#0B1118]/50 border border-white/[0.05] p-5 flex flex-col">
      <div className="flex items-center gap-2 mb-3.5">
        <Sparkles size={17} className="text-[#22C55E]" />
        <h3 className="text-[14px] font-medium text-[#F7F9FC]">Could do for you now</h3>
      </div>
      {suggestions.length ? (
        <div className="space-y-3">
          {suggestions.map((sg, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="text-[13.5px] text-[#E6EAF2] leading-relaxed">
              <div className="flex gap-2">
                <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-[#22C55E]" />
                <span>{sg.text}</span>
              </div>
              {sg.action && (
                <button
                  onClick={() => onRun(sg.action!)}
                  title={sg.action}
                  className="mt-1.5 ml-3.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#22C55E]/12 border border-[#22C55E]/35 text-[#22C55E] text-[11.5px] font-medium hover:bg-[#22C55E]/22 transition-colors"
                >
                  <Play size={11} className="fill-current" /> Do it
                </button>
              )}
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="text-[12.5px] text-[#5B6575] leading-relaxed">No proactive actions surfaced yet.</div>
      )}
    </div>
  );
}

function Section({ icon, title, accent, items, empty }: { icon: React.ReactNode; title: string; accent: string; items: string[]; empty: string }) {
  return (
    <div className="rounded-[18px] bg-[#0B1118]/50 border border-white/[0.05] p-5 flex flex-col">
      <div className="flex items-center gap-2 mb-3.5">
        {icon}
        <h3 className="text-[14px] font-medium text-[#F7F9FC]">{title}</h3>
      </div>
      {items.length ? (
        <div className="space-y-2.5">
          {items.map((it, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="flex gap-2 text-[13.5px] text-[#E6EAF2] leading-relaxed">
              <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accent }} />
              <span>{it}</span>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="text-[12.5px] text-[#5B6575] leading-relaxed">{empty}</div>
      )}
    </div>
  );
}
