// NEXUS — the OS made visible. Two halves of the same idea:
//   • the constellation: everything it KNOWS (entities + memories, cross-linked)
//   • the glass box: what it's THINKING right now (steps, tool calls, trust
//     decisions, agent children) — the reasoning that is otherwise invisible.
// Everything here is real data from /mind/graph and /mind/live.
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, Boxes, BrainCircuit, Check, Clock, Lock, Loader2, RefreshCw, Sparkles, Wrench, Zap } from 'lucide-react';
import PageContainer from '../components/PageContainer';
import Constellation, { colorFor } from '../components/Constellation';
import { api, type MindGraph, type MindLive, type MindNode } from '../api/client';

const LEGEND: Array<[string, string]> = [
  ['person', 'People'],
  ['project', 'Projects'],
  ['tool', 'Tools'],
  ['concept', 'Concepts'],
  ['semantic', 'Facts'],
  ['procedural', 'Skills'],
  ['episodic', 'Episodes'],
  ['failure', 'Failures'],
];

const RUNNING = new Set(['running', 'planning', 'awaiting_approval']);

function Stat({ icon, value, label }: { icon: React.ReactNode; value: number | string; label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
      <span className="text-[#00D4FF]">{icon}</span>
      <span className="text-[15px] font-semibold text-[#F7F9FC] tabular-nums">{value}</span>
      <span className="text-[11.5px] text-[#5B6575]">{label}</span>
    </div>
  );
}

/** Trust badge — the security posture, visible at a glance. */
function TrustBadge({ trust, approvedBy }: { trust: string; approvedBy: string | null }) {
  const map: Record<string, { bg: string; fg: string; text: string; icon: React.ReactNode }> = {
    read: { bg: 'bg-emerald-500/10', fg: 'text-emerald-400', text: 'auto', icon: <Zap size={10} /> },
    write: { bg: 'bg-sky-500/10', fg: 'text-sky-400', text: 'write', icon: <Check size={10} /> },
    irreversible: { bg: 'bg-amber-500/10', fg: 'text-amber-400', text: approvedBy === 'user' ? 'approved' : 'gated', icon: <Lock size={10} /> },
    spend: { bg: 'bg-rose-500/10', fg: 'text-rose-400', text: approvedBy === 'user' ? 'approved' : 'gated', icon: <Lock size={10} /> },
  };
  const s = map[trust] ?? map.read!;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium ${s.bg} ${s.fg}`}>
      {s.icon}
      {s.text}
    </span>
  );
}

export default function Nexus() {
  const [graph, setGraph] = useState<MindGraph | null>(null);
  const [live, setLive] = useState<MindLive | null>(null);
  const [sel, setSel] = useState<MindNode | null>(null);
  const [pinned, setPinned] = useState<string | null>(null); // task id being watched
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const loadGraph = useCallback(async () => {
    const g = await api.mindGraph().catch(() => null);
    if (g) setGraph(g);
  }, []);

  useEffect(() => {
    void loadGraph().finally(() => setLoading(false));
  }, [loadGraph]);

  // The glass box polls — a running task streams in front of you.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const l = await api.mindLive(pinned ?? undefined).catch(() => null);
      if (alive && l) setLive(l);
    };
    void tick();
    const t = setInterval(() => {
      if (!document.hidden) void tick();
    }, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pinned]);

  // Knowledge grows as tasks complete — refresh the map when a task finishes.
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const s = live?.task?.status ?? null;
    if (lastStatus.current && RUNNING.has(lastStatus.current) && s && !RUNNING.has(s)) void loadGraph();
    lastStatus.current = s;
  }, [live?.task?.status, loadGraph]);

  const refresh = async () => {
    setRefreshing(true);
    await loadGraph();
    setRefreshing(false);
  };

  const running = !!live?.task && RUNNING.has(live.task.status);
  const callsByStep = new Map<string, MindLive['toolCalls']>();
  for (const c of live?.toolCalls ?? []) {
    if (!callsByStep.has(c.step_id)) callsByStep.set(c.step_id, []);
    callsByStep.get(c.step_id)!.push(c);
  }

  return (
    <PageContainer>
      <div className="flex flex-col h-full min-h-0 px-6 py-5 gap-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 shrink-0">
          <div>
            <h1 className="text-[26px] font-semibold tracking-tight text-[#F7F9FC] flex items-center gap-2.5">
              <BrainCircuit size={26} className="text-[#00D4FF]" />
              Nexus
            </h1>
            <p className="text-[13.5px] text-[#98A4B8] mt-0.5">Everything it knows, and everything it's thinking — live.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {graph && (
              <>
                <Stat icon={<Sparkles size={13} />} value={graph.stats.memories} label="memories" />
                <Stat icon={<Boxes size={13} />} value={graph.stats.entities} label="entities" />
                <Stat icon={<Wrench size={13} />} value={graph.stats.toolCalls} label="tool calls" />
                <Stat icon={<Activity size={13} />} value={graph.stats.tasks} label="tasks" />
              </>
            )}
            <button
              onClick={() => void refresh()}
              className="w-9 h-9 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center text-[#98A4B8] hover:text-white hover:bg-white/[0.07] transition-colors"
              title="Rebuild the map"
            >
              <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex gap-4">
          {/* ---------------- Constellation ---------------- */}
          <div className="flex-1 min-w-0 relative rounded-2xl bg-[#080C12]/80 border border-white/[0.06] overflow-hidden">
            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center text-[#5B6575] gap-2">
                <Loader2 size={16} className="animate-spin" /> mapping the mind…
              </div>
            ) : graph && graph.nodes.length > 0 ? (
              <Constellation nodes={graph.nodes} links={graph.links} onSelect={setSel} selectedId={sel?.id ?? null} />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-[#5B6575] text-[13px] gap-1">
                <span>No knowledge captured yet.</span>
                <span className="text-[11.5px]">Have a few conversations — entities and memories appear here automatically.</span>
              </div>
            )}

            {/* legend */}
            <div className="absolute left-4 bottom-4 flex flex-wrap gap-x-3 gap-y-1.5 max-w-[70%] pointer-events-none">
              {LEGEND.map(([kind, label]) => (
                <span key={kind} className="flex items-center gap-1.5 text-[10.5px] text-[#5B6575]">
                  <span className="w-2 h-2 rounded-full" style={{ background: colorFor(kind) }} />
                  {label}
                </span>
              ))}
            </div>

            {/* selected node detail */}
            <AnimatePresence>
              {sel && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute right-4 top-4 w-[290px] rounded-xl bg-[#0B1118]/95 border border-white/10 backdrop-blur p-3.5 shadow-2xl"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colorFor(sel.kind) }} />
                    <span className="text-[14px] font-semibold text-[#F7F9FC] truncate">{sel.label}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10.5px] uppercase tracking-wide text-[#5B6575]">
                    <span>{sel.kind}</span>
                    <span className="text-[#2A3441]">•</span>
                    <span>{sel.group === 'memory' ? 'memory' : 'entity'}</span>
                  </div>
                  {sel.detail && <p className="mt-2 text-[12px] leading-relaxed text-[#98A4B8] max-h-[160px] overflow-y-auto scrollbar-hide">{sel.detail}</p>}
                  <button onClick={() => setSel(null)} className="mt-3 text-[11.5px] text-[#5B6575] hover:text-[#98A4B8]">
                    close
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ---------------- Glass box ---------------- */}
          <div className="w-[400px] shrink-0 flex flex-col min-h-0 rounded-2xl bg-[#080C12]/80 border border-white/[0.06] overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] shrink-0">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-[#F7F9FC] flex items-center gap-2">
                  <Activity size={14} className="text-[#00D4FF]" />
                  Glass Box
                </span>
                {running ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-[#00D4FF]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00D4FF] animate-pulse" />
                    thinking
                  </span>
                ) : (
                  <span className="text-[11px] text-[#5B6575]">idle</span>
                )}
              </div>
              {live?.task && <p className="mt-1.5 text-[12px] text-[#98A4B8] line-clamp-2">{live.task.goal}</p>}
              {live?.task && (
                <div className="mt-2 flex items-center gap-2 text-[10.5px] text-[#5B6575]">
                  <span className="px-1.5 py-0.5 rounded-md bg-white/[0.04]">{live.task.status}</span>
                  {!!live.task.spent?.tokens && <span>{live.task.spent.tokens.toLocaleString()} tokens</span>}
                  <span>{live.steps.length} steps</span>
                  <span>{live.toolCalls.length} calls</span>
                </div>
              )}
            </div>

            {/* reasoning timeline */}
            <div ref={feedRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-4 py-3 space-y-2.5">
              {!live?.task && <div className="text-[12px] text-[#5B6575]">No tasks yet — ask the OS to do something.</div>}

              {live?.children && live.children.length > 0 && (
                <div className="mb-2 p-2.5 rounded-xl bg-[#00D4FF]/[0.05] border border-[#00D4FF]/15">
                  <div className="text-[10.5px] uppercase tracking-wide text-[#00D4FF]/80 mb-1.5">Agents dispatched</div>
                  <div className="space-y-1">
                    {live.children.map((c) => (
                      <button key={c.id} onClick={() => setPinned(c.id)} className="w-full text-left text-[11.5px] text-[#98A4B8] hover:text-white truncate">
                        ↳ {c.goal}
                        <span className="text-[#5B6575]"> · {c.status}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {live?.steps.map((s, i) => (
                <motion.div key={s.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} className="relative pl-5">
                  <span className="absolute left-0 top-1.5 w-2 h-2 rounded-full bg-[#3B82F6]" />
                  {i < live.steps.length - 1 && <span className="absolute left-[3.5px] top-4 bottom-[-10px] w-px bg-white/[0.07]" />}
                  <div className="text-[12px] text-[#CBD5E1]">{s.title || `${s.kind} step`}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-[#5B6575]">
                    {s.model_used && <span className="truncate max-w-[150px]">{s.model_used}</span>}
                    {!!s.tokens && <span>{s.tokens} tok</span>}
                    {s.status === 'failed' && <span className="text-rose-400">failed</span>}
                  </div>
                  {s.error && <div className="mt-1 text-[11px] text-rose-400/90 line-clamp-2">{s.error}</div>}

                  {(callsByStep.get(s.id) ?? []).map((c) => (
                    <div key={c.id} className="mt-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11.5px] font-medium text-[#E2E8F0] flex items-center gap-1.5 truncate">
                          <Wrench size={11} className="text-[#5B6575] shrink-0" />
                          {c.tool}
                        </span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          <TrustBadge trust={c.trust_class} approvedBy={c.approved_by} />
                          {c.duration_ms != null && (
                            <span className="text-[10px] text-[#5B6575] flex items-center gap-0.5">
                              <Clock size={9} />
                              {c.duration_ms}ms
                            </span>
                          )}
                        </span>
                      </div>
                      {c.result && <div className="mt-1 text-[10.5px] text-[#5B6575] line-clamp-2 font-mono">{c.result}</div>}
                    </div>
                  ))}
                </motion.div>
              ))}
            </div>

            {/* task switcher */}
            {live?.recent && live.recent.length > 0 && (
              <div className="border-t border-white/[0.06] px-3 py-2.5 shrink-0">
                <div className="text-[10px] uppercase tracking-wide text-[#5B6575] mb-1.5">Replay a task</div>
                <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
                  <button
                    onClick={() => setPinned(null)}
                    className={`px-2 py-1 rounded-lg text-[11px] whitespace-nowrap border transition-colors ${
                      pinned === null ? 'bg-[#00D4FF]/10 border-[#00D4FF]/30 text-[#00D4FF]' : 'bg-white/[0.03] border-white/[0.06] text-[#98A4B8] hover:text-white'
                    }`}
                  >
                    live
                  </button>
                  {live.recent.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setPinned(t.id)}
                      title={t.goal}
                      className={`px-2 py-1 rounded-lg text-[11px] whitespace-nowrap border max-w-[160px] truncate transition-colors ${
                        pinned === t.id ? 'bg-[#00D4FF]/10 border-[#00D4FF]/30 text-[#00D4FF]' : 'bg-white/[0.03] border-white/[0.06] text-[#98A4B8] hover:text-white'
                      }`}
                    >
                      {t.goal}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
