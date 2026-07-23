"use client";
import { useEffect, useRef, useState } from "react";
import AiOrb from "../AiOrb";

/**
 * <ScoreOrb> — the counter and the Orb become one thing. A living orb sits at
 * the center while a colored arc sweeps from 0 to the real score; the number
 * counts up in step. Band color: red < 55, amber 55–74, green ≥ 75. Used on
 * the result screen and (mini) on account scan cards, so "your score" always
 * looks the same across the whole site.
 */
export default function ScoreOrb({
  value, size = 180, label, sub, animate = true, color: colorOverride,
}: { value: number; size?: number; label?: string; sub?: string; animate?: boolean; color?: string }) {
  const target = Math.max(0, Math.min(100, Math.round(value)));
  const [display, setDisplay] = useState(animate ? 0 : target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!animate) { setDisplay(target); return; }
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setDisplay(target); return; }
    const dur = 1300;
    let start: number | null = null;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setDisplay(Math.round(target * eased));
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, animate]);

  const color = colorOverride ?? (display < 55 ? "#E5484D" : display < 75 ? "#f59e0b" : "#22C55E");
  const stroke = Math.max(8, Math.round(size * 0.055));
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const dash = (display / 100) * c;
  const cx = size / 2;

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        {/* glowing orb core behind the arc — tinted with the band color */}
        <AiOrb
          size={size * 0.62}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ ["--c1" as string]: color, ["--c2" as string]: color, ["--atmo-o" as string]: "0.6" }}
        />
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="relative">
          <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={stroke} />
          <circle
            cx={cx} cy={cx} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`} transform={`rotate(-90 ${cx} ${cx})`}
            style={{ filter: `drop-shadow(0 0 6px ${color})` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ textShadow: "0 2px 12px rgba(0,0,0,0.5)" }}>
          <span className="font-mono font-black tabular-nums" style={{ color: "#fff", fontSize: size * 0.28, lineHeight: 1 }}>{display}</span>
          <span className="font-mono" style={{ color: "rgba(255,255,255,0.6)", fontSize: size * 0.075 }}>/ 100</span>
        </div>
      </div>
      {label && <div className="mt-2 font-mono text-xs uppercase tracking-[0.15em]" style={{ color: "var(--faint)" }}>{label}</div>}
      {sub && <div className="mt-1 text-xs" style={{ color: "var(--faint)" }}>{sub}</div>}
    </div>
  );
}
