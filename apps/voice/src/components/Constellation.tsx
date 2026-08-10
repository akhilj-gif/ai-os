// The living constellation — everything the OS knows, drawn as one graph.
// Canvas (not SVG) because it stays smooth with a few hundred glowing nodes and
// a continuously running force simulation. Positions PERSIST across refreshes
// keyed by node id, so a refresh doesn't reshuffle the map — new knowledge
// blooms in where it belongs while everything you were looking at stays put.
import { useEffect, useRef, useState } from 'react';
import type { MindNode, MindLink } from '../api/client';

const COLORS: Record<string, string> = {
  // knowledge-graph entities
  person: '#38BDF8',
  project: '#A78BFA',
  tool: '#22D3EE',
  file: '#94A3B8',
  org: '#F472B6',
  concept: '#FBBF24',
  event: '#34D399',
  other: '#64748B',
  // memories
  semantic: '#60A5FA',
  procedural: '#34D399',
  episodic: '#C084FC',
  failure: '#F87171',
  preference: '#FBBF24',
  document: '#22D3EE',
};
export const colorFor = (kind: string): string => COLORS[kind] ?? '#64748B';

interface Sim extends MindNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  born: number; // ms timestamp — drives the bloom-in animation
}

export default function Constellation({
  nodes,
  links,
  onSelect,
  selectedId,
}: {
  nodes: MindNode[];
  links: MindLink[];
  onSelect: (n: MindNode | null) => void;
  selectedId: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<{ nodes: Sim[]; links: Array<{ s: Sim; t: Sim; rel: string }> }>({ nodes: [], links: [] });
  const hoverRef = useRef<Sim | null>(null);
  const dragRef = useRef<Sim | null>(null);
  const selRef = useRef<string | null>(selectedId);
  const [tip, setTip] = useState<{ x: number; y: number; node: Sim } | null>(null);

  useEffect(() => {
    selRef.current = selectedId;
  }, [selectedId]);

  // Merge incoming data into the simulation, keeping existing positions.
  useEffect(() => {
    const prev = new Map(simRef.current.nodes.map((n) => [n.id, n]));
    const w = wrapRef.current?.clientWidth ?? 900;
    const h = wrapRef.current?.clientHeight ?? 600;
    const now = performance.now();
    const simNodes: Sim[] = nodes.map((n, i) => {
      const old = prev.get(n.id);
      if (old) return { ...old, ...n, r: 5 + Math.min(9, n.weight * 1.7) };
      // Seed new nodes on a ring so they visibly arrive from the edge.
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      const rad = Math.min(w, h) * 0.36;
      return {
        ...n,
        x: w / 2 + Math.cos(a) * rad + (Math.random() - 0.5) * 40,
        y: h / 2 + Math.sin(a) * rad + (Math.random() - 0.5) * 40,
        vx: 0,
        vy: 0,
        r: 5 + Math.min(9, n.weight * 1.7),
        born: now,
      };
    });
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks = links
      .map((l) => ({ s: byId.get(l.source), t: byId.get(l.target), rel: l.rel }))
      .filter((l): l is { s: Sim; t: Sim; rel: string } => !!l.s && !!l.t);
    simRef.current = { nodes: simNodes, links: simLinks };
  }, [nodes, links]);

  // Simulation + render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let stopped = false;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = wrap.clientWidth * dpr;
      canvas.height = wrap.clientHeight * dpr;
      canvas.style.width = `${wrap.clientWidth}px`;
      canvas.style.height = `${wrap.clientHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const step = () => {
      if (stopped) return;
      const { nodes: ns, links: ls } = simRef.current;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      const cx = w / 2;
      const cy = h / 2;

      // --- forces -------------------------------------------------------
      for (let i = 0; i < ns.length; i++) {
        const a = ns[i]!;
        for (let k = i + 1; k < ns.length; k++) {
          const b = ns[k]!;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 === 0) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 1;
          }
          if (d2 > 90000) continue; // ignore distant pairs — keeps this cheap
          const d = Math.sqrt(d2);
          const f = 900 / d2; // inverse-square repulsion
          const ux = (dx / d) * f;
          const uy = (dy / d) * f;
          a.vx -= ux;
          a.vy -= uy;
          b.vx += ux;
          b.vy += uy;
        }
      }
      for (const l of ls) {
        const dx = l.t.x - l.s.x;
        const dy = l.t.y - l.s.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = (d - 96) * 0.006; // spring toward the ideal edge length
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        l.s.vx += ux;
        l.s.vy += uy;
        l.t.vx -= ux;
        l.t.vy -= uy;
      }
      for (const n of ns) {
        n.vx += (cx - n.x) * 0.0016; // gentle gravity so nothing drifts away
        n.vy += (cy - n.y) * 0.0016;
        if (dragRef.current === n) continue;
        n.vx *= 0.86;
        n.vy *= 0.86;
        n.x += Math.max(-6, Math.min(6, n.vx));
        n.y += Math.max(-6, Math.min(6, n.vy));
        n.x = Math.max(n.r + 6, Math.min(w - n.r - 6, n.x));
        n.y = Math.max(n.r + 6, Math.min(h - n.r - 6, n.y));
      }

      // --- render -------------------------------------------------------
      ctx.clearRect(0, 0, w, h);
      const hov = hoverRef.current;
      const sel = selRef.current;
      const near = new Set<string>();
      if (hov || sel) {
        for (const l of ls) {
          const id = hov?.id ?? sel;
          if (l.s.id === id) near.add(l.t.id);
          if (l.t.id === id) near.add(l.s.id);
        }
      }
      const focusId = hov?.id ?? sel;

      for (const l of ls) {
        const active = !!focusId && (l.s.id === focusId || l.t.id === focusId);
        ctx.beginPath();
        ctx.moveTo(l.s.x, l.s.y);
        // slight curve — straight lines read as a mesh, curves read as a mind
        const mx = (l.s.x + l.t.x) / 2;
        const my = (l.s.y + l.t.y) / 2;
        ctx.quadraticCurveTo(mx + (l.t.y - l.s.y) * 0.06, my - (l.t.x - l.s.x) * 0.06, l.t.x, l.t.y);
        ctx.strokeStyle = active ? 'rgba(0,212,255,0.55)' : focusId ? 'rgba(148,163,184,0.07)' : 'rgba(148,163,184,0.16)';
        ctx.lineWidth = active ? 1.6 : 1;
        ctx.stroke();
      }

      const now = performance.now();
      for (const n of ns) {
        const age = now - n.born;
        const bloom = Math.min(1, age / 900); // scale + fade in
        const ease = 1 - Math.pow(1 - bloom, 3);
        const dim = !!focusId && n.id !== focusId && !near.has(n.id);
        const r = n.r * (0.4 + 0.6 * ease) * (n.id === focusId ? 1.35 : 1);
        const color = colorFor(n.kind);

        ctx.globalAlpha = (dim ? 0.28 : 1) * (0.35 + 0.65 * ease);
        // glow
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 4);
        g.addColorStop(0, `${color}66`);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 4, 0, Math.PI * 2);
        ctx.fill();
        // core
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (n.group === 'memory') {
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        // label: only for the important/focused ones, so it never turns to soup
        if (!dim && (n.id === focusId || n.weight >= 3 || near.has(n.id))) {
          ctx.globalAlpha = dim ? 0.3 : 0.92;
          ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
          ctx.fillStyle = '#CBD5E1';
          const label = n.label.length > 26 ? `${n.label.slice(0, 26)}…` : n.label;
          ctx.fillText(label, n.x + r + 6, n.y + 4);
        }
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    // --- interaction ------------------------------------------------------
    const pick = (ev: MouseEvent): Sim | null => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      let best: Sim | null = null;
      let bd = 22;
      for (const n of simRef.current.nodes) {
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      return best;
    };
    const onMove = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (dragRef.current) {
        dragRef.current.x = ev.clientX - rect.left;
        dragRef.current.y = ev.clientY - rect.top;
        dragRef.current.vx = 0;
        dragRef.current.vy = 0;
        return;
      }
      const n = pick(ev);
      hoverRef.current = n;
      canvas.style.cursor = n ? 'pointer' : 'default';
      setTip(n ? { x: n.x, y: n.y, node: n } : null);
    };
    const onDown = (ev: MouseEvent) => {
      const n = pick(ev);
      dragRef.current = n;
      if (n) onSelect(n);
      else onSelect(null);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    const onLeave = () => {
      hoverRef.current = null;
      setTip(null);
    };
    canvas.addEventListener('mouseleave', onLeave);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, [onSelect]);

  return (
    <div ref={wrapRef} className="relative w-full h-full">
      <canvas ref={canvasRef} className="block w-full h-full" />
      {tip && (
        <div
          className="pointer-events-none absolute z-20 px-2.5 py-1.5 rounded-lg bg-[#0B1118]/95 border border-white/10 shadow-xl backdrop-blur text-[11.5px] max-w-[260px]"
          style={{ left: Math.min(tip.x + 16, (wrapRef.current?.clientWidth ?? 600) - 270), top: tip.y + 14 }}
        >
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: colorFor(tip.node.kind) }} />
            <span className="text-[#F7F9FC] font-medium">{tip.node.label}</span>
          </div>
          <div className="text-[#5B6575] mt-0.5 uppercase tracking-wide text-[10px]">{tip.node.kind}</div>
        </div>
      )}
    </div>
  );
}
