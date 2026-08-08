import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import PageContainer from '../components/PageContainer';
import { Search, Trash2 } from 'lucide-react';
import { api, type MemoryRecord, type MemoryAnalytics } from '../api/client';

const TYPE_COLORS: Record<string, string> = {
  preference: 'text-[#3B82F6] border-[#3B82F6]/40',
  semantic: 'text-[#22C55E] border-[#22C55E]/40',
  procedural: 'text-[#B57EDC] border-[#B57EDC]/40',
  project: 'text-[#F2C14E] border-[#F2C14E]/40',
  episodic: 'text-[#98A4B8] border-[#98A4B8]/40',
  document: 'text-[#00D4FF] border-[#00D4FF]/40',
  failure: 'text-[#F87171] border-[#F87171]/40',
};

export default function Memory() {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<string | null>(null);
  const [stats, setStats] = useState<MemoryAnalytics | null>(null);

  const load = () => api.memory().then((d) => { setRecords(d.records); setMode(null); }).catch(() => undefined);
  useEffect(() => { load(); api.memoryAnalytics().then(setStats).catch(() => undefined); }, []);

  async function search() {
    if (!q.trim()) return load();
    try {
      const d = await api.memorySearch(q.trim());
      setRecords(d.records);
      setMode(d.mode);
    } catch {
      /* keep current */
    }
  }

  async function del(id: string) {
    await api.memoryDelete(id).catch(() => undefined);
    setRecords((r) => r.filter((x) => x.id !== id));
  }

  return (
    <PageContainer>
      <div className="flex flex-col h-full p-8 relative z-20">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h2 className="text-[28px] font-semibold tracking-tight text-[#F7F9FC]">Core Memory</h2>
            <p className="text-[14px] text-[#5B6575] mt-1">Everything the OS remembers about you, with its source. Delete anything.</p>
          </div>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5B6575]" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void search()}
              placeholder="Search memories by meaning…"
              className="bg-[#0B1118]/80 border border-white/[0.08] backdrop-blur-[24px] rounded-full py-2 pl-9 pr-4 text-[13px] text-[#F7F9FC] placeholder-[#5B6575] focus:outline-none focus:border-[#3B82F6]/50 w-[260px]"
            />
          </div>
        </div>

        {stats && !mode && (
          <div className="mb-5 shrink-0">
            <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-6 gap-2.5 mb-3">
              <Stat label="Memories" value={stats.total} accent="#3B82F6" />
              <Stat label="Graph nodes" value={stats.graph.nodes} accent="#00D4FF" />
              <Stat label="Graph links" value={stats.graph.edges} accent="#00D4FF" />
              <Stat label="Skills" value={stats.skills} accent="#B57EDC" />
              <Stat label="Projects" value={stats.projects} accent="#F2C14E" />
              <Stat label="New · 7d" value={stats.createdLast7d} accent="#22C55E" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {Object.entries(stats.byType).map(([t, n]) => (
                <span key={t} className={`text-[11px] font-medium px-2 py-0.5 rounded-md border ${TYPE_COLORS[t] ?? 'text-[#98A4B8] border-white/20'}`}>{t} · {n}</span>
              ))}
              {stats.knownIssues > 0 && <span className="text-[11px] px-2 py-0.5 rounded-md border text-[#F87171] border-[#F87171]/40">known issues · {stats.knownIssues}</span>}
              {stats.contradictions > 0 && <span className="text-[11px] px-2 py-0.5 rounded-md border text-[#F2C14E] border-[#F2C14E]/40">⚠ conflicts · {stats.contradictions}</span>}
              <span className="text-[11px] text-[#5B6575] ml-auto">
                confidence: <span className="text-[#22C55E]">{stats.confidence.high} high</span> · {stats.confidence.medium} med · {stats.confidence.low} low · <span className="text-[#5B6575]">{stats.superseded} archived</span>
              </span>
            </div>
          </div>
        )}

        {mode && (
          <div className="text-[12.5px] text-[#F2C14E] mb-4">
            search results · {mode} ·{' '}
            <button onClick={() => { setQ(''); load(); }} className="underline text-[#98A4B8] hover:text-white">clear</button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto pr-4 scrollbar-hide space-y-3">
          {records.map((r, i) => (
            <motion.div
              key={r.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.4) }}
              className="p-4 rounded-[16px] bg-[#0B1118]/40 border border-white/[0.04] hover:border-white/[0.1] transition-all group"
            >
              <div className="flex items-center gap-2.5 mb-2 flex-wrap">
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border ${TYPE_COLORS[r.type] ?? 'text-[#98A4B8] border-white/20'}`}>{r.type}</span>
                {r.subject && <span className="text-[12px] text-[#98A4B8]">· {r.subject}</span>}
                <span className="text-[11px] text-[#5B6575]">· conf {r.confidence.toFixed(2)}</span>
                {r.relevance !== undefined && <span className="text-[11px] text-[#00D4FF]">· match {r.relevance.toFixed(2)}</span>}
                <span className="text-[11px] text-[#5B6575]">· from {r.source.user_stated ? 'you' : r.source.task_id ? `task ${r.source.task_id.slice(0, 8)}` : 'unknown'}</span>
                <button onClick={() => void del(r.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-[#F87171]/70 hover:text-[#F87171] transition-all" title="Delete memory">
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="text-[14px] text-[#E6EAF2] leading-relaxed">{r.content}</div>
            </motion.div>
          ))}
          {records.length === 0 && <div className="text-[14px] text-[#5B6575]">No memories yet — tell the OS a preference and it'll appear here.</div>}
        </div>
      </div>
    </PageContainer>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-[14px] bg-[#0B1118]/60 border border-white/[0.05] px-3.5 py-3">
      <div className="text-[22px] font-semibold leading-none" style={{ color: accent }}>{value}</div>
      <div className="text-[11px] text-[#98A4B8] mt-1.5">{label}</div>
    </div>
  );
}
