"use client";
/**
 * THE LIVING BACKGROUND — one global field, mounted by OrbProvider on every
 * route. It reacts to EVERYTHING:
 *   cursor  → a soft light follows the hand (lerped, never jumpy)
 *   click   → a ripple rings out from the touch point
 *   mood    → the whole wash tints with the orb's state (thinking violet,
 *             listening blue, golden payment, mint success)
 *   scroll  → the aurora drifts parallax against the page
 */
import { useEffect, useRef } from "react";
import type { OrbState } from "../AiOrb";

const TINTS: Record<string, string> = {
  idle: "rgba(232,236,245,0.04)",
  thinking: "rgba(139,92,246,0.075)",
  listening: "rgba(120,170,255,0.065)",
  golden: "rgba(245,184,64,0.06)",
  done: "rgba(120,220,170,0.05)",
};

export default function AmbientField({ mood, active }: { mood: OrbState; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useRef({ x: 0.5, y: 0.32, tx: 0.5, ty: 0.32 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let running = true;

    const onMove = (e: PointerEvent) => {
      pos.current.tx = e.clientX / window.innerWidth;
      pos.current.ty = e.clientY / window.innerHeight;
    };
    const onDown = (e: PointerEvent) => {
      const r = document.createElement("span");
      r.className = "amb-ripple";
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      el.appendChild(r);
      window.setTimeout(() => r.remove(), 1400);
    };
    const loop = () => {
      if (!running) return;
      const p = pos.current;
      p.x += (p.tx - p.x) * 0.055;
      p.y += (p.ty - p.y) * 0.055;
      el.style.setProperty("--mx", `${(p.x * 100).toFixed(2)}%`);
      el.style.setProperty("--my", `${(p.y * 100).toFixed(2)}%`);
      el.style.setProperty("--scy", String(window.scrollY || 0));
      raf = requestAnimationFrame(loop);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    raf = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
    };
  }, []);

  return (
    <div ref={ref} className={`ambient-field ${active ? "is-active" : ""}`} aria-hidden>
      <div className="amb-tint" style={{ background: TINTS[mood] ?? TINTS.idle }} />
      <div className="amb-parallax">
        <div className="amb-drift d1" />
        <div className="amb-drift d2" />
      </div>
      <div className="amb-light" />
    </div>
  );
}
