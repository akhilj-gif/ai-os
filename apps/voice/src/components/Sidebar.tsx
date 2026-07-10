import { 
  Home, 
  MessageSquarePlus, 
  MessageSquare, 
  CheckSquare, 
  Database, 
  Briefcase, 
  Settings, 
  ChevronDown, 
  Activity,
  AudioLines
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useState } from 'react';
import { NavLink } from 'react-router-dom';

export default function Sidebar() {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div 
      className="w-[260px] flex flex-col h-full bg-transparent gap-6 pb-2"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Logo */}
      <div className="flex items-center gap-4 px-4 pt-4">
        <div className="w-11 h-11 rounded-full border border-[#3B82F6]/30 flex items-center justify-center relative overflow-hidden shadow-[0_0_15px_rgba(59,130,246,0.2)]">
           <div className="absolute inset-0 bg-transparent flex items-center justify-center">
              <AudioLines className="text-[#3B82F6] w-6 h-6" />
           </div>
        </div>
        <div className="flex flex-col justify-center">
          <h1 className="text-[22px] font-medium tracking-tight text-[#F7F9FC] leading-tight">AI OS</h1>
          <span className="text-[11px] uppercase tracking-[0.2em] text-[#3B82F6] font-semibold leading-tight">Voice</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1.5 px-3 flex-1 mt-6">
         <NavItem icon={<Home size={20} />} label="Home" to="/" />
         <div className="h-4" /> {/* Spacer */}
         <NavItem icon={<MessageSquarePlus size={20} />} label="New Chat" to="/new" />
         <NavItem icon={<MessageSquare size={20} />} label="Chats" to="/chats" />
         <NavItem icon={<CheckSquare size={20} />} label="Tasks" to="/tasks" />
         <NavItem icon={<Database size={20} />} label="Memory" to="/memory" />
         <NavItem icon={<Briefcase size={20} />} label="Jobs" to="/jobs" />
         <NavItem icon={<Settings size={20} />} label="Settings" to="/settings" />
      </nav>

      <div className="mt-auto flex flex-col gap-4 px-3">
        {/* Kernel Status */}
        <div className="p-3.5 rounded-2xl bg-[#0B1118]/60 border border-white/[0.04] backdrop-blur-md relative overflow-hidden group hover:bg-[#101722]/80 hover:border-white/[0.08] transition-all cursor-pointer">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-2 h-2 rounded-full bg-[#22C55E] shadow-[0_0_10px_rgba(34,197,94,0.6)] relative">
               <div className="absolute inset-0 rounded-full bg-[#22C55E] animate-ping opacity-75" />
            </div>
            <span className="text-[13px] font-medium text-[#F7F9FC]">Kernel Online</span>
          </div>
          <div className="text-[11px] text-[#5B6575]">All systems operational</div>
          
          <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-20 group-hover:opacity-40 transition-opacity">
             <svg width="40" height="20" viewBox="0 0 40 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#3B82F6]">
                <path d="M0,10 L10,10 L15,2 L25,18 L30,10 L40,10" strokeLinejoin="round" />
             </svg>
          </div>
        </div>

        {/* User */}
        <div className="p-2.5 rounded-2xl bg-[#0B1118]/60 border border-white/[0.04] flex items-center gap-3 backdrop-blur-md hover:bg-[#101722]/80 hover:border-white/[0.08] transition-all cursor-pointer">
           <div className="w-10 h-10 rounded-[12px] bg-gradient-to-br from-[#3B82F6]/20 to-[#00D4FF]/20 flex items-center justify-center text-[#3B82F6] font-semibold border border-[#3B82F6]/30 text-lg">
              A
           </div>
           <div className="flex-1">
              <div className="text-[14px] font-medium text-[#F7F9FC] leading-tight">Akhil</div>
              <div className="text-[11px] text-[#5B6575] mt-0.5">Local User</div>
           </div>
           <ChevronDown size={16} className="text-[#5B6575] mr-1" />
        </div>
      </div>
    </div>
  );
}

function NavItem({ icon, label, to }: { icon: React.ReactNode, label: string, to: string }) {
  return (
    <NavLink to={to}>
      {({ isActive }) => (
        <motion.div 
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className={`flex items-center gap-3.5 px-4 py-3 rounded-2xl cursor-pointer transition-all duration-300 ${
            isActive 
              ? 'bg-gradient-to-r from-[#3B82F6]/15 to-transparent border border-[#3B82F6]/20 text-[#F7F9FC] shadow-[inset_2px_0_0_#3B82F6]' 
              : 'text-[#98A4B8] hover:bg-white/[0.03] hover:text-[#F7F9FC] border border-transparent'
          }`}
        >
          <div className={`${isActive ? "text-[#3B82F6]" : "text-[#5B6575]"} transition-colors duration-300`}>
            {icon}
          </div>
          <span className="text-[15px] font-medium">{label}</span>
        </motion.div>
      )}
    </NavLink>
  )
}
