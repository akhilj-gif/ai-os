import { useEffect, useState } from 'react';
import { CheckCircle2, MessageSquare, Activity, Bot, XCircle, Hourglass, CircleDashed } from 'lucide-react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { api, type TaskSummary } from '../api/client';
import { useAIOS } from '../state/useAIOS';

const STATUS_META: Record<string, { label: string; color: string; icon: React.ReactNode; spin?: boolean }> = {
  running: { label: 'Running', color: 'text-[#3B82F6]', icon: <Activity size={18} className="text-[#3B82F6]" />, spin: true },
  planning: { label: 'Planning', color: 'text-[#3B82F6]', icon: <Bot size={18} className="text-[#3B82F6]" />, spin: true },
  awaiting_approval: { label: 'Needs you', color: 'text-[#F2C14E]', icon: <Hourglass size={18} className="text-[#F2C14E]" /> },
  done: { label: 'Done', color: 'text-[#22C55E]', icon: <CheckCircle2 size={18} className="text-[#22C55E]" /> },
  failed: { label: 'Failed', color: 'text-[#F87171]', icon: <XCircle size={18} className="text-[#F87171]" /> },
  paused: { label: 'Paused', color: 'text-[#98A4B8]', icon: <CircleDashed size={18} className="text-[#98A4B8]" /> },
  draft: { label: 'Draft', color: 'text-[#5B6575]', icon: <CircleDashed size={18} className="text-[#5B6575]" /> },
};

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function RightPanel() {
  const { sessions, sessionId, switchTo } = useAIOS();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    const load = () => api.tasks().then((d) => setTasks(d.tasks.slice(0, 5))).catch(() => undefined);
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 6000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="w-[360px] flex flex-col h-full gap-5 z-10">
      {/* Tasks Panel */}
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="bg-[#080B10]/80 border border-white/[0.04] backdrop-blur-[24px] rounded-[24px] p-5 flex flex-col gap-4 shadow-lg relative overflow-hidden h-[360px]"
      >
        <div className="flex justify-between items-center mb-1 relative z-10 px-1">
          <h3 className="text-[16px] font-medium text-[#F7F9FC]">Tasks</h3>
          <button onClick={() => navigate('/tasks')} className="text-[#3B82F6] text-[13px] hover:text-[#00D4FF] transition-colors">
            View all
          </button>
        </div>
        <div className="flex flex-col gap-1 relative z-10 overflow-y-auto scrollbar-hide">
          {tasks.length === 0 && <div className="text-[13px] text-[#5B6575] px-1 py-3">No tasks yet — ask something.</div>}
          {tasks.map((t) => {
            const meta = STATUS_META[t.status] ?? STATUS_META.draft!;
            // M11: a specialist child renders as an indented tree node under
            // the flow of its orchestration, not as a full-width row.
            const isChild = !!t.parent_task_id;
            return (
              <div key={t.id} className={`flex items-center gap-3 p-2.5 rounded-[14px] hover:bg-white/[0.03] transition-colors cursor-default ${isChild ? 'ml-6 border-l border-[#00D4FF]/20 pl-3' : ''}`}>
                <div className={`${isChild ? 'w-7 h-7' : 'w-9 h-9'} rounded-xl bg-[#101722] border border-white/[0.06] flex items-center justify-center shrink-0`}>{meta.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className={`${isChild ? 'text-[12.5px] text-[#98A4B8]' : 'text-[13.5px] text-[#F7F9FC]'} truncate`}>{t.goal}</div>
                </div>
                <span className={`text-[12px] font-medium shrink-0 ${meta.color}`}>{meta.label}</span>
              </div>
            );
          })}
        </div>
      </motion.div>

      {/* Recent Chats Panel */}
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        className="flex-1 bg-[#080B10]/80 border border-white/[0.04] backdrop-blur-[24px] rounded-[24px] p-5 flex flex-col gap-4 shadow-lg relative overflow-hidden"
      >
        <div className="flex justify-between items-center mb-1 relative z-10 px-1">
          <h3 className="text-[16px] font-medium text-[#F7F9FC]">Recent Chats</h3>
          <button onClick={() => navigate('/chats')} className="text-[#3B82F6] text-[13px] hover:text-[#00D4FF] transition-colors">
            View all
          </button>
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto pr-1 scrollbar-hide relative z-10">
          {sessions.slice(0, 8).map((s) => (
            <button
              key={s.id}
              onClick={() => switchTo(s.id)}
              className={`flex items-center gap-3 p-2.5 rounded-[14px] transition-colors text-left ${
                s.id === sessionId ? 'bg-[#3B82F6]/10 border border-[#3B82F6]/20' : 'hover:bg-white/[0.03] border border-transparent'
              }`}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${s.id === sessionId ? 'bg-[#3B82F6]/20 text-[#3B82F6]' : 'bg-white/[0.05] text-[#98A4B8]'}`}>
                <MessageSquare size={14} />
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-[13px] truncate ${s.id === sessionId ? 'text-[#F7F9FC]' : 'text-[#98A4B8]'}`}>
                  {s.first_message ?? 'New chat'}
                </div>
              </div>
              <span className="text-[11px] text-[#5B6575] shrink-0">{timeAgo(s.updated_at)}</span>
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
