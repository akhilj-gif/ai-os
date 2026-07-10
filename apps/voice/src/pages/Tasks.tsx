import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import PageContainer from '../components/PageContainer';
import { CheckCircle2, Activity, Hourglass, XCircle, CircleDashed, Bot, ChevronDown } from 'lucide-react';
import { api, type TaskSummary, type TaskDetail } from '../api/client';

const META: Record<string, { label: string; color: string; icon: React.ReactNode; spin?: boolean }> = {
  running: { label: 'Running', color: 'text-[#3B82F6]', icon: <Activity size={16} className="text-[#3B82F6]" />, spin: true },
  planning: { label: 'Planning', color: 'text-[#3B82F6]', icon: <Bot size={16} className="text-[#3B82F6]" />, spin: true },
  awaiting_approval: { label: 'Needs approval', color: 'text-[#F2C14E]', icon: <Hourglass size={16} className="text-[#F2C14E]" /> },
  done: { label: 'Done', color: 'text-[#22C55E]', icon: <CheckCircle2 size={16} className="text-[#22C55E]" /> },
  failed: { label: 'Failed', color: 'text-[#F87171]', icon: <XCircle size={16} className="text-[#F87171]" /> },
  paused: { label: 'Paused', color: 'text-[#98A4B8]', icon: <CircleDashed size={16} className="text-[#98A4B8]" /> },
  draft: { label: 'Draft', color: 'text-[#5B6575]', icon: <CircleDashed size={16} className="text-[#5B6575]" /> },
};

export default function Tasks() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);

  useEffect(() => {
    const load = () => api.tasks().then((d) => setTasks(d.tasks)).catch(() => undefined);
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 6000);
    return () => clearInterval(t);
  }, []);

  async function toggle(id: string) {
    if (open === id) {
      setOpen(null);
      setDetail(null);
      return;
    }
    setOpen(id);
    setDetail(null);
    try {
      setDetail(await api.task(id));
    } catch {
      /* leave closed */
    }
  }

  // M11 tree view: an orchestration's specialist children nest under their
  // parent instead of appearing as their own top-level rows.
  const childrenByParent = new Map<string, TaskSummary[]>();
  for (const t of tasks) {
    if (!t.parent_task_id) continue;
    const list = childrenByParent.get(t.parent_task_id) ?? [];
    list.push(t);
    childrenByParent.set(t.parent_task_id, list);
  }
  // children arrive newest-first from the API; show them in creation order
  for (const list of childrenByParent.values()) list.reverse();
  const roots = tasks.filter((t) => !t.parent_task_id);

  const groups = [
    { title: 'Active', tasks: roots.filter((t) => ['running', 'planning', 'awaiting_approval', 'paused'].includes(t.status)) },
    { title: 'Recent', tasks: roots.filter((t) => t.status === 'done').slice(0, 15) },
    { title: 'Failed', tasks: roots.filter((t) => t.status === 'failed').slice(0, 8) },
  ];

  return (
    <PageContainer>
      <div className="flex flex-col h-full p-8 relative z-20">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h2 className="text-[28px] font-semibold tracking-tight text-[#F7F9FC]">Tasks</h2>
            <p className="text-[14px] text-[#5B6575] mt-1">Everything the OS has run — click one to see its steps and agents.</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-4 scrollbar-hide flex flex-col gap-8">
          {groups.map(
            (group) =>
              group.tasks.length > 0 && (
                <div key={group.title}>
                  <h3 className="text-[13px] font-semibold text-[#5B6575] uppercase tracking-wider mb-4 pl-2">{group.title}</h3>
                  <div className="flex flex-col gap-3">
                    {group.tasks.map((task, i) => {
                      const meta = META[task.status] ?? META.draft!;
                      const isOpen = open === task.id;
                      return (
                        <motion.div key={task.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}>
                          <div
                            onClick={() => void toggle(task.id)}
                            className={`flex items-center gap-4 p-4 rounded-[16px] bg-[#0B1118]/40 border transition-all cursor-pointer group ${
                              isOpen ? 'border-[#3B82F6]/30 bg-[#101722]/80' : 'border-white/[0.04] hover:bg-[#101722]/80 hover:border-white/[0.1]'
                            }`}
                          >
                            <div className="w-10 h-10 rounded-xl bg-[#101722] border border-white/[0.06] flex items-center justify-center shrink-0">{meta.icon}</div>
                            <div className="flex-1 min-w-0">
                              <div className="text-[14.5px] text-[#F7F9FC] font-medium truncate">{task.goal}</div>
                            </div>
                            <span className={`text-[13px] font-medium shrink-0 ${meta.color}`}>{meta.label}</span>
                            <ChevronDown size={15} className={`text-[#5B6575] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                          </div>

                          {isOpen && (
                            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden">
                              <div className="ml-14 mt-2 mb-1 p-4 rounded-[14px] bg-[#05070A]/60 border border-white/[0.04] space-y-2.5">
                                {!detail && <div className="text-[12.5px] text-[#5B6575]">Loading…</div>}
                                {detail?.steps
                                  .filter((s) => s.output?.text || s.error)
                                  .slice(-3)
                                  .map((s) => (
                                    <div key={s.id} className="text-[13px] leading-relaxed">
                                      {s.error ? (
                                        <span className="text-[#F87171]">{s.error.slice(0, 220)}</span>
                                      ) : (
                                        <span className="text-[#98A4B8] whitespace-pre-wrap">{s.output!.text!.slice(0, 400)}</span>
                                      )}
                                    </div>
                                  ))}
                              </div>
                            </motion.div>
                          )}

                          {/* M11 tree: specialist children nested under the orchestration parent */}
                          {(childrenByParent.get(task.id) ?? []).length > 0 && (
                            <div className="ml-9 mt-1 pl-5 border-l border-[#00D4FF]/20 flex flex-col gap-1">
                              {childrenByParent.get(task.id)!.map((c) => {
                                const cMeta = META[c.status] ?? META.draft!;
                                const cOpen = open === c.id;
                                return (
                                  <div key={c.id}>
                                    <div
                                      onClick={() => void toggle(c.id)}
                                      className={`flex items-center gap-3 py-2 px-3 rounded-[12px] border transition-all cursor-pointer ${
                                        cOpen ? 'border-[#00D4FF]/25 bg-[#101722]/70' : 'border-transparent hover:bg-[#101722]/60 hover:border-white/[0.06]'
                                      }`}
                                    >
                                      <Bot size={14} className={`shrink-0 ${cMeta.spin ? 'text-[#3B82F6]' : 'text-[#00D4FF]'}`} />
                                      <span className="text-[13px] text-[#98A4B8] truncate flex-1">{c.goal}</span>
                                      <span className={`text-[12px] font-medium shrink-0 ${cMeta.color}`}>{cMeta.label}</span>
                                    </div>
                                    {cOpen && (
                                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden">
                                        <div className="ml-7 mt-1 mb-1 p-3 rounded-[12px] bg-[#05070A]/60 border border-white/[0.04] space-y-2">
                                          {!detail && <div className="text-[12.5px] text-[#5B6575]">Loading…</div>}
                                          {detail?.steps
                                            .filter((s) => s.output?.text || s.error)
                                            .slice(-3)
                                            .map((s) => (
                                              <div key={s.id} className="text-[12.5px] leading-relaxed">
                                                {s.error ? (
                                                  <span className="text-[#F87171]">{s.error.slice(0, 220)}</span>
                                                ) : (
                                                  <span className="text-[#98A4B8] whitespace-pre-wrap">{s.output!.text!.slice(0, 400)}</span>
                                                )}
                                              </div>
                                            ))}
                                        </div>
                                      </motion.div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              ),
          )}
          {tasks.length === 0 && <div className="text-[14px] text-[#5B6575] pl-2">No tasks yet.</div>}
        </div>
      </div>
    </PageContainer>
  );
}
