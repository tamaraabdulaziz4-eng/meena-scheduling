"use client";

/**
 * Circular score gauge — the single "north-star" number on the result screen,
 * far more legible than a flat percentage (research: Jobscan/Teal use a ring).
 * `value` is the animated display value; `color` is the band color.
 */
export default function ScoreRing({ value, color, label, sub }: { value: number; color: string; label?: string; sub?: string }) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const dash = (pct / 100) * c;
  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: 140, height: 140 }}>
        <svg width="140" height="140" viewBox="0 0 140 140">
          <circle cx="70" cy="70" r={r} fill="none" stroke="var(--line)" strokeWidth="10" />
          <circle cx="70" cy="70" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`} transform="rotate(-90 70 70)" style={{ transition: "stroke-dasharray 0.3s ease" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-4xl font-bold tabular-nums" style={{ color }}>{Math.round(value)}</span>
          <span className="font-mono text-[11px]" style={{ color: "var(--faint)" }}>/ 100</span>
        </div>
      </div>
      {label && <div className="mt-2 font-mono text-xs uppercase tracking-[0.15em]" style={{ color: "var(--faint)" }}>{label}</div>}
      {sub && <div className="mt-1 text-xs" style={{ color: "var(--faint)" }}>{sub}</div>}
    </div>
  );
}
