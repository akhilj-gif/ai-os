import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import PageContainer from '../components/PageContainer';
import { Briefcase, Play, Clock } from 'lucide-react';
import { api, type JobRow } from '../api/client';

function scheduleLabel(j: JobRow): string {
  const s = j.schedule as { kind?: string; at?: string; everyMinutes?: number };
  if (s.kind === 'daily' || s.at) return `daily @ ${s.at ?? '—'}`;
  if (s.everyMinutes) return `every ${s.everyMinutes}m`;
  return JSON.stringify(j.schedule).slice(0, 30);
}

export default function Jobs() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [running, setRunning] = useState<string | null>(null);

  const load = () => api.jobs().then((d) => setJobs(d.jobs)).catch(() => undefined);
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 8000);
    return () => clearInterval(t);
  }, []);

  async function runNow(id: string) {
    setRunning(id);
    await api.jobRun(id).catch(() => undefined);
    await load();
    setRunning(null);
  }

  return (
    <PageContainer>
      <div className="flex flex-col h-full p-8 relative z-20">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h2 className="text-[28px] font-semibold tracking-tight text-[#F7F9FC]">Automations</h2>
            <p className="text-[14px] text-[#5B6575] mt-1">Scheduled jobs the OS runs proactively — briefings, watchers, reflections.</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-4 scrollbar-hide space-y-3">
          {jobs.map((j, i) => {
            const state = j.state as { lastStatus?: string; last?: string };
            const last = (state.lastStatus ?? state.last ?? '') as string;
            return (
              <motion.div
                key={j.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="flex items-center gap-4 p-4 rounded-[16px] bg-[#0B1118]/40 border border-white/[0.04] hover:border-white/[0.1] transition-all"
              >
                <div className="w-10 h-10 rounded-xl bg-[#101722] border border-white/[0.06] flex items-center justify-center shrink-0">
                  <Briefcase size={16} className="text-[#3B82F6]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[14.5px] text-[#F7F9FC] font-medium">{j.name}</div>
                  <div className="text-[12px] text-[#5B6575] mt-0.5 flex items-center gap-3">
                    <span>{j.kind}</span>
                    <span>· {scheduleLabel(j)}</span>
                    {j.next_run_at && (
                      <span className="flex items-center gap-1">
                        <Clock size={11} /> next {new Date(j.next_run_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {last && <span className="truncate">· last: {String(last).slice(0, 60)}</span>}
                  </div>
                </div>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  disabled={running === j.id}
                  onClick={() => void runNow(j.id)}
                  className="px-3.5 py-1.5 rounded-full bg-[#3B82F6]/10 border border-[#3B82F6]/30 flex items-center gap-1.5 text-[#3B82F6] text-[12.5px] font-medium disabled:opacity-50"
                >
                  <Play size={13} /> {running === j.id ? 'Running…' : 'Run now'}
                </motion.button>
              </motion.div>
            );
          })}
          {jobs.length === 0 && <div className="text-[14px] text-[#5B6575]">No automations yet.</div>}
        </div>
      </div>
    </PageContainer>
  );
}
