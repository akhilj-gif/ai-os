// FORGE — the party trick. Ask for a capability the OS does not have; it writes
// the tool, a deterministic verifier judges it, it repairs its own mistakes, and
// the finished pack sits INERT until you approve the install. Every stage is
// streamed (SSE) so you watch the loop instead of a spinner.
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Code2, Hammer, Loader2, Lock, PlayCircle, ShieldCheck, Sparkles, Wrench, X } from 'lucide-react';
import PageContainer from '../components/PageContainer';
import { api, type ForgeEvent } from '../api/client';
import { useAIOS } from '../state/useAIOS';

const EXAMPLES = [
  'Get the current weather for any city',
  'Look up a word’s definition and synonyms',
  'Fetch the latest exchange rate between two currencies',
  'Tell me a random fact about any number',
];

type Stage = 'idle' | 'drafting' | 'verifying' | 'repairing' | 'staged' | 'installed' | 'failed';

interface Attempt {
  round: number;
  model?: string;
  chars?: number;
  rejected?: string;
  ok?: boolean;
}

export default function Forge() {
  const { send } = useAIOS();
  const navigate = useNavigate();
  const [request, setRequest] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [source, setSource] = useState('');
  const [result, setResult] = useState<Extract<ForgeEvent, { phase: 'staged' }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const cancelRef = useRef<(() => void) | null>(null);
  const codeRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => () => cancelRef.current?.(), []);

  // A live timer makes the wait feel like work happening, not a hang.
  useEffect(() => {
    if (stage === 'idle' || stage === 'staged' || stage === 'installed' || stage === 'failed') return;
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(t);
  }, [stage]);

  useEffect(() => {
    if (codeRef.current) codeRef.current.scrollTop = codeRef.current.scrollHeight;
  }, [source]);

  const busy = stage === 'drafting' || stage === 'verifying' || stage === 'repairing';

  function forge(text?: string) {
    const req = (text ?? request).trim();
    if (!req || busy) return;
    setRequest(req);
    setStage('drafting');
    setAttempts([]);
    setSource('');
    setResult(null);
    setError(null);
    setElapsed(0);

    cancelRef.current = api.forgeStream(req, (e) => {
      switch (e.phase) {
        case 'generating':
          setStage('drafting');
          setAttempts((a) => (a.some((x) => x.round === e.round) ? a : [...a, { round: e.round }]));
          break;
        case 'generated':
          setSource(e.source);
          setAttempts((a) => a.map((x) => (x.round === e.round ? { ...x, model: e.model, chars: e.chars } : x)));
          break;
        case 'verifying':
          setStage('verifying');
          break;
        case 'rejected':
          setAttempts((a) => a.map((x) => (x.round === e.round ? { ...x, rejected: e.reason } : x)));
          break;
        case 'repairing':
          setStage('repairing');
          break;
        case 'staged':
          setAttempts((a) => a.map((x) => (x.round === e.rounds ? { ...x, ok: true } : x)));
          setSource(e.source);
          setResult(e);
          setStage('staged');
          break;
        case 'failed':
          setError(e.error);
          setStage('failed');
          break;
      }
    });
  }

  async function install() {
    if (!result) return;
    setInstalling(true);
    const r = await api.packInstallStaged(result.name).catch((err: Error) => ({ error: err.message }) as never);
    setInstalling(false);
    if ((r as unknown as { error?: string })?.error) {
      setError((r as unknown as { error: string }).error);
      return;
    }
    setStage('installed');
  }

  function tryIt() {
    if (!result) return;
    void send(`Use the new ${result.name} capability: ${request}`);
    navigate('/chats');
  }

  const stepState = (s: 'draft' | 'verify' | 'stage' | 'install') => {
    if (s === 'draft') return attempts.length > 0 ? (stage === 'drafting' ? 'active' : 'done') : 'idle';
    if (s === 'verify') return stage === 'verifying' || stage === 'repairing' ? 'active' : attempts.some((a) => a.ok) ? 'done' : 'idle';
    if (s === 'stage') return stage === 'staged' ? 'active' : stage === 'installed' ? 'done' : 'idle';
    return stage === 'installed' ? 'done' : 'idle';
  };

  return (
    <PageContainer>
      <div className="flex flex-col h-full min-h-0 px-6 py-5 gap-4">
        {/* Header */}
        <div className="shrink-0">
          <h1 className="text-[26px] font-semibold tracking-tight text-[#F7F9FC] flex items-center gap-2.5">
            <Hammer size={25} className="text-[#00D4FF]" />
            Forge
          </h1>
          <p className="text-[13.5px] text-[#98A4B8] mt-0.5">
            Ask for something it <span className="text-[#F7F9FC]">can’t</span> do. It writes the tool, verifies it, fixes its own mistakes — and waits for your
            approval before anything can run.
          </p>
        </div>

        {/* Prompt */}
        <div className="shrink-0">
          <div className="flex gap-2">
            <input
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && forge()}
              disabled={busy}
              placeholder="e.g. get the current weather for any city"
              className="flex-1 h-11 px-4 rounded-xl bg-white/[0.03] border border-white/[0.08] text-[14px] text-[#F7F9FC] placeholder:text-[#5B6575] outline-none focus:border-[#00D4FF]/40 disabled:opacity-50"
            />
            <button
              onClick={() => forge()}
              disabled={busy || !request.trim()}
              className="h-11 px-5 rounded-xl bg-[#00D4FF]/12 border border-[#00D4FF]/30 text-[#00D4FF] text-[13.5px] font-medium hover:bg-[#00D4FF]/20 disabled:opacity-40 disabled:hover:bg-[#00D4FF]/12 transition-colors flex items-center gap-2"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {busy ? `${elapsed}s` : 'Forge it'}
            </button>
          </div>
          {stage === 'idle' && (
            <div className="mt-2 flex gap-1.5 flex-wrap">
              {EXAMPLES.map((x) => (
                <button
                  key={x}
                  onClick={() => forge(x)}
                  className="px-2.5 py-1 rounded-lg bg-white/[0.03] border border-white/[0.06] text-[11.5px] text-[#98A4B8] hover:text-white hover:border-white/15 transition-colors"
                >
                  {x}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 flex gap-4">
          {/* ---------------- Pipeline ---------------- */}
          <div className="w-[420px] shrink-0 overflow-y-auto scrollbar-hide rounded-2xl bg-[#080C12]/80 border border-white/[0.06] p-4 space-y-3">
            {stage === 'idle' && (
              <div className="text-[12.5px] text-[#5B6575] leading-relaxed">
                <p className="text-[#98A4B8] mb-2">What happens when you hit Forge:</p>
                <ol className="space-y-1.5 list-decimal list-inside">
                  <li>It writes a complete tool module from scratch.</li>
                  <li>A deterministic scanner + loader verifies it — no imports, no filesystem, no secrets, timeouts required.</li>
                  <li>If rejected, the failure is fed back and it repairs itself (up to 3 rounds).</li>
                  <li>The pack is <span className="text-[#F7F9FC]">staged and inert</span> until you install it.</li>
                </ol>
              </div>
            )}

            <Step label="Draft the tool" state={stepState('draft')} icon={<Code2 size={14} />} />
            <AnimatePresence>
              {attempts.map((a) => (
                <motion.div key={a.round} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="ml-6 space-y-1.5">
                  <div className="text-[11.5px] text-[#5B6575]">
                    round {a.round}
                    {a.model && <span className="ml-1.5 text-[#475569]">· {a.model}</span>}
                    {!!a.chars && <span className="ml-1.5 text-[#475569]">· {a.chars} chars</span>}
                  </div>
                  {a.rejected && (
                    <div className="rounded-lg bg-amber-500/[0.07] border border-amber-500/20 px-2.5 py-2">
                      <div className="flex items-center gap-1.5 text-[11px] text-amber-400 font-medium">
                        <AlertTriangle size={11} /> verifier rejected it
                      </div>
                      <div className="mt-1 text-[11px] text-[#98A4B8] font-mono leading-relaxed line-clamp-4">{a.rejected}</div>
                      <div className="mt-1 text-[10.5px] text-amber-400/70">→ feeding the failure back and repairing</div>
                    </div>
                  )}
                  {a.ok && (
                    <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                      <Check size={11} /> passed the verifier
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>

            <Step label="Verify (scan · load · validate)" state={stepState('verify')} icon={<ShieldCheck size={14} />} />
            <Step label="Stage — inert until approved" state={stepState('stage')} icon={<Lock size={14} />} />
            <Step label="Install (your approval)" state={stepState('install')} icon={<Check size={14} />} />

            {/* Result card */}
            <AnimatePresence>
              {result && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-2 rounded-xl bg-[#00D4FF]/[0.05] border border-[#00D4FF]/20 p-3.5">
                  <div className="flex items-center gap-2">
                    <Sparkles size={15} className="text-[#00D4FF]" />
                    <span className="text-[14px] font-semibold text-[#F7F9FC]">{result.name}</span>
                    <span className="text-[10.5px] text-[#5B6575]">
                      {result.rounds} round{result.rounds > 1 ? 's' : ''}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12px] text-[#98A4B8]">{result.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {result.tools.map((t) => (
                      <span key={t} className="px-2 py-0.5 rounded-md bg-white/[0.05] border border-white/[0.07] text-[11px] text-[#CBD5E1] font-mono flex items-center gap-1">
                        <Wrench size={9} className="text-[#5B6575]" />
                        {t}
                      </span>
                    ))}
                  </div>
                  {result.requires?.length > 0 && (
                    <div className="mt-2 text-[11px] text-amber-400/90">requires: {result.requires.join(', ')}</div>
                  )}

                  {stage === 'staged' && (
                    <>
                      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[#5B6575]">
                        <Lock size={11} /> staged and inert — nothing can run until you install it
                      </div>
                      <button
                        onClick={() => void install()}
                        disabled={installing}
                        className="mt-2 w-full h-9 rounded-lg bg-[#00D4FF]/15 border border-[#00D4FF]/30 text-[#00D4FF] text-[13px] font-medium hover:bg-[#00D4FF]/25 transition-colors flex items-center justify-center gap-2"
                      >
                        {installing ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        Install it
                      </button>
                    </>
                  )}

                  {stage === 'installed' && (
                    <>
                      <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-emerald-400">
                        <Check size={12} /> installed — the OS can use it now
                      </div>
                      <div className="mt-1 text-[10.5px] text-[#5B6575]">
                        Every generated tool starts fail-closed: it asks for approval on each call until you graduate it in Settings.
                      </div>
                      <button
                        onClick={tryIt}
                        className="mt-2 w-full h-9 rounded-lg bg-emerald-500/12 border border-emerald-500/30 text-emerald-300 text-[13px] font-medium hover:bg-emerald-500/20 transition-colors flex items-center justify-center gap-2"
                      >
                        <PlayCircle size={14} /> Try it now
                      </button>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {error && (
              <div className="rounded-xl bg-rose-500/[0.07] border border-rose-500/20 p-3">
                <div className="flex items-center gap-1.5 text-[12px] text-rose-400 font-medium">
                  <X size={12} /> forge failed
                </div>
                <div className="mt-1 text-[11px] text-[#98A4B8] font-mono leading-relaxed max-h-[140px] overflow-y-auto scrollbar-hide">{error}</div>
              </div>
            )}
          </div>

          {/* ---------------- Generated code ---------------- */}
          <div className="flex-1 min-w-0 rounded-2xl bg-[#060A0F]/90 border border-white/[0.06] overflow-hidden flex flex-col">
            <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-2 shrink-0">
              <Code2 size={13} className="text-[#5B6575]" />
              <span className="text-[12px] text-[#98A4B8] font-mono">{result ? `${result.name}.mts` : 'generated source'}</span>
              {busy && <Loader2 size={12} className="animate-spin text-[#00D4FF] ml-auto" />}
            </div>
            <pre
              ref={codeRef}
              className="flex-1 min-h-0 overflow-auto scrollbar-hide p-4 text-[11.5px] leading-[1.65] font-mono text-[#9FB3C8] whitespace-pre-wrap break-words"
            >
              {source || (busy ? 'thinking…' : '// The tool it writes will appear here.')}
            </pre>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}

function Step({ label, state, icon }: { label: string; state: string; icon: React.ReactNode }) {
  const c =
    state === 'done'
      ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/[0.07]'
      : state === 'active'
        ? 'text-[#00D4FF] border-[#00D4FF]/30 bg-[#00D4FF]/[0.07]'
        : 'text-[#5B6575] border-white/[0.06] bg-white/[0.02]';
  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border ${c}`}>
      <span className="shrink-0">{state === 'active' ? <Loader2 size={14} className="animate-spin" /> : state === 'done' ? <Check size={14} /> : icon}</span>
      <span className="text-[12.5px] font-medium">{label}</span>
    </div>
  );
}
