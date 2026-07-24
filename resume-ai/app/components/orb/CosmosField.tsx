"use client";
/**
 * COSMOS — the living purple sky, painted on a single canvas as the deepest
 * layer of AmbientField (so it shows on every route):
 *   gradient sky  → deep violet that darkens toward the bottom
 *   stars         → three depth layers, twinkling, with pointer/scroll parallax
 *   nebulae       → four huge soft sprites drifting on slow orbits
 * One lerped rAF loop (144Hz-smooth), DPR-capped, fully static under
 * prefers-reduced-motion.
 */
import { useEffect, useRef } from "react";

interface Star { x: number; y: number; r: number; p: number; ph: number; sp: number }
interface Neb { spr: HTMLCanvasElement; x: number; y: number; sc: number; dx: number; dy: number; ph: number }

function makeSprite(color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 300;
  const g = c.getContext("2d");
  if (g) {
    const rg = g.createRadialGradient(150, 150, 0, 150, 150, 150);
    rg.addColorStop(0, color);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, 300, 300);
  }
  return c;
}

export default function CosmosField() {
  const cvsRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = cvsRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = 0, H = 0, raf = 0, running = true;
    let stars: Star[] = [], nebs: Neb[] = [], bg: CanvasGradient | null = null;
    const ptr = { x: 0.5, y: 0.35, tx: 0.5, ty: 0.35, sy: 0, tsy: 0 };
    const t0 = performance.now();

    const sprViolet = makeSprite("rgba(124,58,237,.34)");
    const sprMagenta = makeSprite("rgba(192,38,211,.22)");
    const sprDeep = makeSprite("rgba(76,29,149,.4)");

    function resize() {
      const DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      cv!.width = W * DPR; cv!.height = H * DPR;
      cv!.style.width = `${W}px`; cv!.style.height = `${H}px`;
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
      stars = [];
      const layers = [
        { n: 46, p: 0.12, s: 1 },
        { n: 34, p: 0.28, s: 1.6 },
        { n: 20, p: 0.5, s: 2.3 },
      ];
      for (const L of layers) {
        for (let i = 0; i < L.n; i++) {
          stars.push({
            x: Math.random() * W, y: Math.random() * H,
            r: L.s * (0.5 + Math.random() * 0.9),
            p: L.p, ph: Math.random() * 6.28, sp: 0.4 + Math.random() * 0.8,
          });
        }
      }
      nebs = [
        { spr: sprViolet, x: W * 0.82, y: H * 0.12, sc: 2.6, dx: 0.012, dy: 0.008, ph: 0 },
        { spr: sprMagenta, x: W * 0.1, y: H * 0.3, sc: 2.2, dx: 0.01, dy: 0.012, ph: 2 },
        { spr: sprDeep, x: W * 0.5, y: H * 0.85, sc: 3.2, dx: 0.008, dy: 0.01, ph: 4 },
        { spr: sprMagenta, x: W * 0.9, y: H * 0.7, sc: 1.9, dx: 0.011, dy: 0.007, ph: 1 },
      ];
      bg = ctx!.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#3d2388");
      bg.addColorStop(0.3, "#2c1672");
      bg.addColorStop(0.6, "#1b0f52");
      bg.addColorStop(1, "#0b0626");
    }

    function paint(t: number) {
      if (!ctx || !bg) return;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      for (const n of nebs) {
        const nx = n.x + Math.sin(t * n.dx * 10 + n.ph) * 46 - (ptr.x - W / 2) * 0.03;
        const ny = n.y + Math.cos(t * n.dy * 10 + n.ph) * 36 - (ptr.y - H / 2) * 0.02 - ptr.sy * 0.06;
        const s = 300 * n.sc;
        ctx.drawImage(n.spr, nx - s / 2, ny - s / 2, s, s);
      }
      for (const s of stars) {
        const px = s.x - (ptr.x - W / 2) * s.p * 0.08;
        let py = (s.y - (ptr.y - H / 2) * s.p * 0.06 - ptr.sy * s.p) % H;
        if (py < 0) py += H;
        ctx.globalAlpha = 0.25 + 0.55 * Math.abs(Math.sin(t * s.sp + s.ph));
        ctx.fillStyle = "#e9d5ff";
        ctx.beginPath(); ctx.arc(px, py, s.r, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    const onMove = (e: PointerEvent) => { ptr.tx = e.clientX; ptr.ty = e.clientY; };
    const onScroll = () => { ptr.tsy = window.scrollY || 0; };

    resize();
    if (reduce) {
      paint(1.5); // one static frame, no loop
    } else {
      const loop = (now: number) => {
        if (!running) return;
        const t = (now - t0) / 1000;
        ptr.x += (ptr.tx - ptr.x) * 0.045;
        ptr.y += (ptr.ty - ptr.y) * 0.045;
        ptr.sy += (ptr.tsy - ptr.sy) * 0.09;
        paint(t);
        raf = requestAnimationFrame(loop);
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("scroll", onScroll, { passive: true });
      raf = requestAnimationFrame(loop);
    }
    window.addEventListener("resize", resize);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return <canvas ref={cvsRef} className="cosmos-field" aria-hidden />;
}
