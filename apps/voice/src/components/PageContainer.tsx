import { motion } from 'framer-motion';

export default function PageContainer({ children, className = '' }: { children: React.ReactNode, className?: string }) {
  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={`flex-1 flex flex-col h-full bg-[#05070A]/40 border border-white/[0.04] backdrop-blur-[24px] rounded-[32px] overflow-hidden relative shadow-[0_0_40px_rgba(0,0,0,0.5)] z-10 ${className}`}
    >
      {/* Deep inner shadow for the main area to give depth */}
      <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_100px_rgba(0,0,0,0.5)] z-0" />
      
      {/* Page Content */}
      <div className="relative z-10 flex flex-col h-full">
        {children}
      </div>
    </motion.div>
  );
}
