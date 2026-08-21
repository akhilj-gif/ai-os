// Camera — a live camera surface with real-time filters, a drawing layer, and a
// one-tap path into the OS's existing vision pipeline.
//
// ARCHITECTURE, and why it is three canvases rather than one:
//   <video>        hidden; the raw MediaStream.
//   canvas #stage  the video redrawn every frame with the active filter. Cleared
//                  and repainted at ~60fps, so nothing persistent can live here.
//   canvas #ink    the drawing overlay. NEVER cleared per frame, which is the
//                  whole reason it is separate — if strokes lived on #stage they
//                  would be wiped by the next video frame, and if the video were
//                  drawn onto #ink the filter would re-process the strokes every
//                  frame and smear them.
// Capture composites #stage + #ink into a throwaway canvas, so what gets sent is
// exactly what the user sees, filters and drawings included.
//
// PRIVACY — a deliberate design decision, not an oversight. There is NO
// `camera_capture` tool and the model cannot open the camera. `screen_capture`
// exists as a read-class auto-approved tool, but a camera is materially
// different: it watches the user and the room they are in. A model-callable
// camera would mean a prompt injection on any web page the OS reads could switch
// on the webcam. So the camera is a USER-INITIATED surface only; the model only
// ever sees a still frame the user explicitly chose to send, arriving through the
// same attachment path as any pasted image. If a model-callable version is ever
// wanted it must be trustClass 'irreversible' (one-click approval per shot), and
// never 'read'.
import { useEffect, useRef, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import PageContainer from '../components/PageContainer';
import { Camera as CameraIcon, CameraOff, Pencil, Eraser, Undo2, Send, RefreshCw, FlipHorizontal, Download, Sparkles } from 'lucide-react';
import { api, type Attachment } from '../api/client';

// --- filters ---------------------------------------------------------------
// `css` uses the canvas 2D `filter` property (hardware-accelerated, free).
// `custom` marks the ones that need per-pixel work, done at reduced resolution
// so they stay real-time.
type FilterId = 'none' | 'mono' | 'sepia' | 'vivid' | 'cool' | 'warm' | 'dream' | 'invert' | 'pixel' | 'edges' | 'echo';
const FILTERS: Array<{ id: FilterId; label: string; css?: string; custom?: boolean }> = [
  { id: 'none', label: 'None' },
  { id: 'mono', label: 'Mono', css: 'grayscale(1) contrast(1.15)' },
  { id: 'sepia', label: 'Sepia', css: 'sepia(0.75) saturate(1.3)' },
  { id: 'vivid', label: 'Vivid', css: 'saturate(1.8) contrast(1.2)' },
  { id: 'cool', label: 'Cool', css: 'hue-rotate(180deg) saturate(1.3)' },
  { id: 'warm', label: 'Warm', css: 'sepia(0.3) saturate(1.6) hue-rotate(-15deg)' },
  { id: 'dream', label: 'Dream', css: 'blur(1.5px) brightness(1.12) saturate(1.4)' },
  { id: 'invert', label: 'Invert', css: 'invert(1) hue-rotate(180deg)' },
  { id: 'pixel', label: 'Pixel', custom: true },
  { id: 'edges', label: 'Edges', custom: true },
  { id: 'echo', label: 'Echo', custom: true },
];

const INK_COLORS = ['#FF3B6B', '#FFD23F', '#3FE0A8', '#4DA3FF', '#C084FC', '#FFFFFF'];

interface Stroke {
  color: string;
  size: number;
  pts: Array<[number, number]>;
}

const QUICK_PROMPTS = ['What am I looking at?', 'Read any text you can see', 'Describe this scene in detail', 'What should I do about this?'];

export default function CameraPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  // Kept in refs, not state: the render loop reads them every frame and must not
  // re-subscribe (a state read inside rAF would capture a stale closure).
  const filterRef = useRef<FilterId>('none');
  const mirrorRef = useRef(true);
  const echoRef = useRef<HTMLCanvasElement | null>(null);

  const [live, setLive] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>('none');
  const [mirror, setMirror] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>();

  const [drawing, setDrawing] = useState(false);
  const [inkColor, setInkColor] = useState(INK_COLORS[0]!);
  const [inkSize, setInkSize] = useState(6);
  const strokesRef = useRef<Stroke[]>([]);
  const activeStroke = useRef<Stroke | null>(null);

  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);
  useEffect(() => {
    mirrorRef.current = mirror;
  }, [mirror]);

  // --- the render loop -----------------------------------------------------
  const renderFrame = useCallback(() => {
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(renderFrame);
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (stage.width !== w || stage.height !== h) {
      stage.width = w;
      stage.height = h;
      const ink = inkRef.current;
      if (ink) {
        ink.width = w;
        ink.height = h;
      }
    }
    const ctx = stage.getContext('2d');
    if (!ctx) return;
    const f = FILTERS.find((x) => x.id === filterRef.current);

    ctx.save();
    // Mirror front-facing video so movement feels natural. Applied here, so the
    // ink layer (drawn in screen coordinates) needs no flip and capture can just
    // stack the two.
    if (mirrorRef.current) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.filter = f?.css ?? 'none';

    if (filterRef.current === 'pixel') {
      // Downscale then upscale with smoothing off — the cheapest real pixelate.
      const s = Math.max(1, Math.round(w / 64));
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(video, 0, 0, Math.ceil(w / s), Math.ceil(h / s));
      ctx.drawImage(stage, 0, 0, Math.ceil(w / s), Math.ceil(h / s), 0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
    } else if (filterRef.current === 'echo') {
      // Trails: blend the previous composited frame under the new one.
      const prev = echoRef.current;
      ctx.drawImage(video, 0, 0, w, h);
      if (prev && prev.width === w) {
        ctx.globalAlpha = 0.55;
        ctx.drawImage(prev, 0, 0);
        ctx.globalAlpha = 1;
      }
      if (!prev || prev.width !== w) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        echoRef.current = c;
      }
      const ec = echoRef.current!.getContext('2d');
      if (ec) {
        ec.clearRect(0, 0, w, h);
        ec.drawImage(stage, 0, 0);
      }
    } else {
      ctx.drawImage(video, 0, 0, w, h);
    }
    ctx.restore();

    if (filterRef.current === 'edges') {
      // Sobel-ish luminance gradient at 1/2 resolution, then upscaled: full-res
      // per-pixel work in JS cannot hold 60fps at 720p.
      const sw = Math.floor(w / 2);
      const sh = Math.floor(h / 2);
      const tmp = document.createElement('canvas');
      tmp.width = sw;
      tmp.height = sh;
      const tc = tmp.getContext('2d');
      if (tc) {
        tc.drawImage(stage, 0, 0, sw, sh);
        const img = tc.getImageData(0, 0, sw, sh);
        const d = img.data;
        const out = new Uint8ClampedArray(d.length);
        const lum = (i: number): number => (d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114);
        for (let y = 1; y < sh - 1; y++) {
          for (let x = 1; x < sw - 1; x++) {
            const i = (y * sw + x) * 4;
            const gx = lum(i + 4) - lum(i - 4);
            const gy = lum(i + sw * 4) - lum(i - sw * 4);
            const m = Math.min(255, Math.hypot(gx, gy) * 2.2);
            out[i] = m * 0.35;
            out[i + 1] = m;
            out[i + 2] = m * 0.85;
            out[i + 3] = 255;
          }
        }
        tc.putImageData(new ImageData(out, sw, sh), 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(tmp, 0, 0, w, h);
      }
    }
    rafRef.current = requestAnimationFrame(renderFrame);
  }, []);

  // --- camera lifecycle ----------------------------------------------------
  const start = useCallback(
    async (id?: string) => {
      setErr(null);
      try {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        const stream = await navigator.mediaDevices.getUserMedia({
          video: id ? { deviceId: { exact: id } } : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setLive(true);
        // Labels are only populated after permission is granted, so enumerate
        // AFTER getUserMedia rather than before.
        const all = await navigator.mediaDevices.enumerateDevices();
        setDevices(all.filter((d) => d.kind === 'videoinput'));
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(renderFrame);
      } catch (e) {
        const name = e instanceof Error ? e.name : '';
        setErr(
          name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow it in the browser’s site settings, then press Start again.'
            : name === 'NotFoundError'
              ? 'No camera found on this machine.'
              : name === 'NotReadableError'
                ? 'The camera is in use by another app. Close that app and try again.'
                : `Could not start the camera: ${e instanceof Error ? e.message : String(e)}`,
        );
        setLive(false);
      }
    },
    [renderFrame],
  );

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLive(false);
  }, []);

  // Release the camera when the page unmounts — a forgotten track leaves the
  // hardware light on, which reads as the OS spying.
  useEffect(() => stop, [stop]);

  // --- drawing -------------------------------------------------------------
  const redrawInk = useCallback(() => {
    const ink = inkRef.current;
    const ctx = ink?.getContext('2d');
    if (!ink || !ctx) return;
    ctx.clearRect(0, 0, ink.width, ink.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokesRef.current) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  }, []);

  // Pointer coords are in CSS pixels; the canvas is at video resolution. Without
  // this scale the strokes land in the wrong place on any non-1:1 layout.
  const toCanvas = (e: React.PointerEvent): [number, number] => {
    const ink = inkRef.current!;
    const r = ink.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * ink.width, ((e.clientY - r.top) / r.height) * ink.height];
  };

  const onDown = (e: React.PointerEvent): void => {
    if (!drawing || !live) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    activeStroke.current = { color: inkColor, size: inkSize, pts: [toCanvas(e)] };
    strokesRef.current.push(activeStroke.current);
  };
  const onMove = (e: React.PointerEvent): void => {
    if (!activeStroke.current) return;
    activeStroke.current.pts.push(toCanvas(e));
    redrawInk();
  };
  const onUp = (): void => {
    activeStroke.current = null;
  };

  const undo = (): void => {
    strokesRef.current.pop();
    redrawInk();
  };
  const clearInk = (): void => {
    strokesRef.current = [];
    redrawInk();
  };

  // --- capture -------------------------------------------------------------
  /** Composite exactly what the user sees: filtered video + their drawing. */
  const composite = (): HTMLCanvasElement | null => {
    const stage = stageRef.current;
    const ink = inkRef.current;
    if (!stage || !stage.width) return null;
    const out = document.createElement('canvas');
    out.width = stage.width;
    out.height = stage.height;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(stage, 0, 0);
    if (ink) ctx.drawImage(ink, 0, 0);
    return out;
  };

  const savePng = (): void => {
    const c = composite();
    if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `aios-camera-${Date.now()}.png`;
    a.click();
  };

  async function askAboutFrame(question: string): Promise<void> {
    const c = composite();
    if (!c || sending) return;
    setSending(true);
    setAnswer(null);
    try {
      // JPEG, not PNG: a 720p PNG is several MB of base64 and the /chat body cap
      // is 20MB — quality 0.82 keeps a frame well under 200KB.
      const dataUrl = c.toDataURL('image/jpeg', 0.82);
      const att: Attachment = { name: `camera-${Date.now()}.jpg`, mime: 'image/jpeg', dataUrl };
      sessionRef.current ??= (await api.createSession()).id;
      const res = await api.chat(question, sessionRef.current, [att]);
      setAnswer(res.reply);
    } catch (e) {
      setAnswer(`Could not reach the OS: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <PageContainer>
      <div className="flex flex-col h-full p-8 relative z-20 overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-[28px] font-semibold tracking-tight text-[#F7F9FC]">Camera</h2>
            <p className="text-[14px] text-[#5B6575] mt-1">
              Live view with filters and drawing. Send a frame and the OS will look at it — nothing leaves this machine until you press Ask.
            </p>
          </div>
          <div className="flex gap-2">
            {live && (
              <>
                <button onClick={() => setMirror((m) => !m)} title="Mirror" className={`p-2.5 rounded-xl border transition ${mirror ? 'bg-[#4DA3FF]/15 border-[#4DA3FF]/40 text-[#4DA3FF]' : 'bg-white/5 border-white/10 text-[#8792A6]'}`}>
                  <FlipHorizontal size={18} />
                </button>
                {devices.length > 1 && (
                  <button
                    onClick={() => {
                      const i = devices.findIndex((d) => d.deviceId === deviceId);
                      const next = devices[(i + 1) % devices.length]!;
                      setDeviceId(next.deviceId);
                      void start(next.deviceId);
                    }}
                    title="Switch camera"
                    className="p-2.5 rounded-xl bg-white/5 border border-white/10 text-[#8792A6] hover:text-[#F7F9FC] transition"
                  >
                    <RefreshCw size={18} />
                  </button>
                )}
              </>
            )}
            <button
              onClick={() => (live ? stop() : void start(deviceId))}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-[14px] transition ${
                live ? 'bg-[#FF3B6B]/15 border border-[#FF3B6B]/40 text-[#FF3B6B]' : 'bg-[#3FE0A8]/15 border border-[#3FE0A8]/40 text-[#3FE0A8]'
              }`}
            >
              {live ? <CameraOff size={18} /> : <CameraIcon size={18} />}
              {live ? 'Stop camera' : 'Start camera'}
            </button>
          </div>
        </div>

        {err && <div className="mb-4 px-4 py-3 rounded-xl bg-[#FF3B6B]/10 border border-[#FF3B6B]/30 text-[#FF8FA8] text-[14px]">{err}</div>}

        <div className="grid grid-cols-[1fr_320px] gap-6 min-h-0">
          {/* --- stage ------------------------------------------------------ */}
          <div>
            <div className="relative rounded-2xl overflow-hidden bg-black/60 border border-white/10 aspect-video">
              <video ref={videoRef} playsInline muted className="hidden" />
              <canvas ref={stageRef} className="absolute inset-0 w-full h-full object-contain" />
              <canvas
                ref={inkRef}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerLeave={onUp}
                className={`absolute inset-0 w-full h-full object-contain ${drawing ? 'cursor-crosshair' : 'pointer-events-none'}`}
              />
              {!live && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[#5B6575]">
                  <CameraIcon size={40} />
                  <p className="text-[14px]">Camera is off</p>
                </div>
              )}
            </div>

            {/* --- filter strip --------------------------------------------- */}
            <div className="flex gap-2 mt-4 flex-wrap">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`px-3 py-1.5 rounded-lg text-[13px] font-medium border transition ${
                    filter === f.id ? 'bg-[#C084FC]/20 border-[#C084FC]/50 text-[#E9D5FF]' : 'bg-white/5 border-white/10 text-[#8792A6] hover:text-[#F7F9FC]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* --- drawing toolbar ----------------------------------------- */}
            <div className="flex items-center gap-3 mt-4 flex-wrap">
              <button
                onClick={() => setDrawing((d) => !d)}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl text-[13px] font-medium border transition ${
                  drawing ? 'bg-[#FFD23F]/15 border-[#FFD23F]/40 text-[#FFD23F]' : 'bg-white/5 border-white/10 text-[#8792A6]'
                }`}
              >
                <Pencil size={16} />
                {drawing ? 'Drawing on' : 'Draw'}
              </button>
              {INK_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setInkColor(c);
                    setDrawing(true);
                  }}
                  style={{ background: c }}
                  className={`w-7 h-7 rounded-full border-2 transition ${inkColor === c ? 'border-white scale-110' : 'border-white/20'}`}
                />
              ))}
              <input type="range" min={2} max={28} value={inkSize} onChange={(e) => setInkSize(Number(e.target.value))} className="w-24 accent-[#4DA3FF]" />
              <button onClick={undo} title="Undo stroke" className="p-2 rounded-xl bg-white/5 border border-white/10 text-[#8792A6] hover:text-[#F7F9FC]">
                <Undo2 size={16} />
              </button>
              <button onClick={clearInk} title="Clear drawing" className="p-2 rounded-xl bg-white/5 border border-white/10 text-[#8792A6] hover:text-[#F7F9FC]">
                <Eraser size={16} />
              </button>
              <button onClick={savePng} title="Save PNG" className="p-2 rounded-xl bg-white/5 border border-white/10 text-[#8792A6] hover:text-[#F7F9FC]">
                <Download size={16} />
              </button>
            </div>
          </div>

          {/* --- ask the OS ------------------------------------------------- */}
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-4">
              <div className="flex items-center gap-2 mb-3 text-[#C084FC]">
                <Sparkles size={16} />
                <span className="text-[13px] font-semibold">Ask about what you see</span>
              </div>
              <div className="flex flex-col gap-2">
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q}
                    disabled={!live || sending}
                    onClick={() => void askAboutFrame(q)}
                    className="text-left px-3 py-2 rounded-lg text-[13px] bg-white/5 border border-white/10 text-[#B8C2D4] hover:text-[#F7F9FC] hover:border-white/20 disabled:opacity-40 transition"
                  >
                    {q}
                  </button>
                ))}
              </div>
              <div className="flex gap-2 mt-3">
                <input
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && prompt.trim()) void askAboutFrame(prompt.trim());
                  }}
                  placeholder="Ask something else…"
                  className="flex-1 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-[13px] text-[#F7F9FC] placeholder:text-[#5B6575] outline-none focus:border-[#4DA3FF]/50"
                />
                <button
                  disabled={!live || sending || !prompt.trim()}
                  onClick={() => void askAboutFrame(prompt.trim())}
                  className="p-2 rounded-lg bg-[#4DA3FF]/15 border border-[#4DA3FF]/40 text-[#4DA3FF] disabled:opacity-40"
                >
                  <Send size={16} />
                </button>
              </div>
            </div>

            {(sending || answer) && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl bg-white/[0.03] border border-white/10 p-4 text-[13px] leading-relaxed text-[#B8C2D4] whitespace-pre-wrap">
                {sending ? <span className="text-[#5B6575]">Looking…</span> : answer}
              </motion.div>
            )}

            <p className="text-[12px] text-[#5B6575] leading-relaxed mt-auto">
              The camera runs only while this page is open and only after you press Start. The OS cannot switch it on by itself — a frame reaches
              the model only when you press Ask, and it travels the same path as any image you paste into chat.
            </p>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
