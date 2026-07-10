import { Sun, MessageSquare, Calendar } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAIOS } from '../state/useAIOS';

export default function QuickActions() {
  const { send } = useAIOS();
  return (
    <div className="flex gap-4 mt-8 justify-center w-full max-w-[800px] mx-auto px-4">
      <ActionCard
        icon={<Sun size={20} className="text-[#3B82F6]" />}
        title="What's on"
        subtitle="my plate today?"
        delay={0.1}
        onClick={() => void send("What's on my plate today?")}
      />
      <ActionCard
        icon={<MessageSquare size={20} className="text-[#3B82F6]" />}
        title="Send Sanju a WhatsApp"
        subtitle="saying I'll be late"
        delay={0.2}
        onClick={() => void send("Send Sanju a WhatsApp saying I'll be late")}
      />
      <ActionCard
        icon={<Calendar size={20} className="text-[#3B82F6]" />}
        title="Schedule a meeting"
        subtitle="tomorrow at 3pm"
        delay={0.3}
        onClick={() => void send('Schedule a meeting tomorrow at 3pm')}
      />
    </div>
  );
}

function ActionCard({ icon, title, subtitle, delay, onClick }: { icon: React.ReactNode; title: string; subtitle: string; delay: number; onClick: () => void }) {
  return (
    <motion.button
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -2, scale: 1.01 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className="flex items-center gap-4 px-5 py-4 rounded-[16px] bg-[#0B1118]/80 border border-white/[0.04] hover:bg-[#101722] hover:border-white/[0.1] transition-all group backdrop-blur-xl shadow-lg flex-1 text-left"
    >
      <div className="text-[#3B82F6] flex-shrink-0 group-hover:scale-110 transition-transform duration-300">{icon}</div>
      <div className="flex flex-col">
        <span className="text-[13.5px] font-medium text-[#F7F9FC] leading-snug">{title}</span>
        <span className="text-[13.5px] text-[#98A4B8] leading-snug">{subtitle}</span>
      </div>
    </motion.button>
  );
}
