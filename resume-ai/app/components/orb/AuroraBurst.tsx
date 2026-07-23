"use client";
/** One-shot aurora particle burst — fires when the payment lock opens. 2.2s. */
const COLORS = ["#8b5cf6", "#ec4899", "#f59e0b", "#22c55e", "#22d3ee"];
const PARTS = Array.from({ length: 28 }, (_, i) => {
  const ang = (i / 28) * Math.PI * 2;
  const dist = 90 + (i % 5) * 26;
  return { bx: Math.cos(ang) * dist, by: Math.sin(ang) * dist, color: COLORS[i % COLORS.length] };
});
export default function AuroraBurst() {
  return (
    <div className="aurora-burst" aria-hidden>
      {PARTS.map((p, i) => (
        <span key={i} style={{ background: p.color, boxShadow: `0 0 8px ${p.color}`, ["--bx" as string]: `${p.bx}px`, ["--by" as string]: `${p.by}px` }} />
      ))}
    </div>
  );
}
