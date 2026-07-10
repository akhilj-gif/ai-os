// The approval POPUP (Akhil's design call: not a persistent inline card — a
// popup that shows the options and then disappears). Trust invariant kept:
// the exact action is always shown before deciding, and DISMISSING without a
// decision collapses to a floating chip instead of vanishing — an undecided
// irreversible action can never be silently lost.
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, Check, X, Hourglass } from 'lucide-react';
import { useAIOS } from '../state/useAIOS';
import { describeAction } from '../api/client';

export default function ApprovalPopup() {
  const { pending, decide } = useAIOS();
  const [minimized, setMinimized] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);

  const current = pending[0] ?? null;

  // A newly-arrived approval always pops open (even if a previous one was minimized).
  useEffect(() => {
    if (current) setMinimized(false);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && current && !minimized) setMinimized(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, minimized]);

  async function act(decision: 'approved' | 'rejected') {
    if (!current || deciding) return;
    setDeciding(current.id);
    await decide(current.id, decision);
    setDeciding(null);
    setMinimized(false); // popup disappears; next pending (if any) pops fresh
  }

  return (
    <>
      <AnimatePresence>
        {current && !minimized && (
          <motion.div
            key="approval-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-[6px] flex items-center justify-center p-6"
            onClick={() => setMinimized(true)}
          >
            <motion.div
              key={current.id}
              initial={{ opacity: 0, scale: 0.92, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[520px] rounded-[24px] border border-[#F2C14E]/25 bg-[#0B0F14]/95 backdrop-blur-[24px] shadow-[0_0_60px_rgba(242,193,78,0.15)] p-6"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-[#F2C14E]/10 border border-[#F2C14E]/30 flex items-center justify-center">
                  <Hourglass size={18} className="text-[#F2C14E]" />
                </div>
                <div>
                  <div className="text-[15px] font-semibold text-[#F2C14E] tracking-wide">Waiting for your approval</div>
                  <div className="text-[12px] text-[#98A4B8]">Nothing has happened yet — this runs only if you approve.</div>
                </div>
              </div>

              <div className="rounded-[14px] bg-[#05070A]/70 border border-white/[0.06] px-4 py-3.5 text-[14.5px] leading-relaxed text-[#F7F9FC] mb-3 break-words">
                {describeAction(current)}
              </div>

              {current.untrusted_context && (
                <div className="flex items-start gap-2 text-[12.5px] text-[#F87171] mb-3">
                  <ShieldAlert size={15} className="mt-0.5 shrink-0" />
                  <span>This task read external content (email/web) before proposing this — verify the recipient and text carefully.</span>
                </div>
              )}

              <div className="flex items-center gap-3 mt-4">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                  disabled={deciding === current.id}
                  onClick={() => void act('approved')}
                  className="flex-1 h-11 rounded-[13px] bg-[#22C55E] hover:bg-[#1FAE53] text-[#05070A] text-[14px] font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
                >
                  <Check size={16} /> Approve &amp; run
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                  disabled={deciding === current.id}
                  onClick={() => void act('rejected')}
                  className="flex-1 h-11 rounded-[13px] bg-transparent border border-[#F87171]/40 text-[#F87171] hover:bg-[#F87171]/10 text-[14px] font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
                >
                  <X size={16} /> Cancel
                </motion.button>
              </div>

              {pending.length > 1 && (
                <div className="text-center text-[11.5px] text-[#5B6575] mt-3">+{pending.length - 1} more waiting after this one</div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Minimized: a floating chip — the approval is parked, never lost. */}
      <AnimatePresence>
        {current && minimized && (
          <motion.button
            key="approval-chip"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            onClick={() => setMinimized(false)}
            className="fixed bottom-6 right-6 z-[85] flex items-center gap-2.5 pl-3.5 pr-4 h-11 rounded-full bg-[#0B0F14]/95 border border-[#F2C14E]/40 text-[#F2C14E] text-[13px] font-medium shadow-[0_0_24px_rgba(242,193,78,0.2)] backdrop-blur-xl hover:scale-[1.03] transition-transform"
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#F2C14E] opacity-60" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#F2C14E]" />
            </span>
            {pending.length} approval{pending.length > 1 ? 's' : ''} waiting
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}
