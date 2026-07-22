"use client";
import { useEffect, useState } from "react";

/**
 * Real-time perception (Lumio-style): a rotating "someone just optimized"
 * chip in the hero. Cycles through curated events with a live pulse — makes
 * the product feel actively in use the second you land.
 */
const EVENTS_EN = [
  { n: "Sarah K.", d: "Software Engineer", from: 44, to: 91 },
  { n: "Mohammed A.", d: "Project Manager", from: 52, to: 88 },
  { n: "Fatima S.", d: "Accountant", from: 39, to: 86 },
  { n: "Omar B.", d: "Sales Manager", from: 47, to: 90 },
  { n: "Noura M.", d: "HR Specialist", from: 55, to: 93 },
  { n: "Khalid R.", d: "Data Analyst", from: 41, to: 89 },
];
const EVENTS_AR = [
  { n: "سارة", d: "مهندسة برمجيات", from: 44, to: 91 },
  { n: "محمد", d: "مدير مشاريع", from: 52, to: 88 },
  { n: "فاطمة", d: "محاسبة", from: 39, to: 86 },
  { n: "عمر", d: "مدير مبيعات", from: 47, to: 90 },
  { n: "نورة", d: "أخصائية موارد بشرية", from: 55, to: 93 },
  { n: "خالد", d: "محلل بيانات", from: 41, to: 89 },
];

export default function LiveTicker({ ar = false }: { ar?: boolean }) {
  const events = ar ? EVENTS_AR : EVENTS_EN;
  const [i, setI] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setI((p) => (p + 1) % events.length);
        setVisible(true);
      }, 350);
    }, 3800);
    return () => clearInterval(t);
  }, [events.length]);

  const e = events[i];
  return (
    <div
      className="inline-flex items-center gap-2.5 rounded-full px-4 py-2 font-mono text-xs"
      style={{
        background: "rgba(16,19,22,0.8)",
        border: "1px solid var(--line)",
        backdropFilter: "blur(8px)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(4px)",
        transition: "opacity 0.35s ease, transform 0.35s ease",
      }}
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: "var(--accent)" }} />
        <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: "var(--accent)" }} />
      </span>
      <span style={{ color: "var(--muted)" }}>
        {e.n} · {e.d}
      </span>
      <span dir="ltr" className="font-bold tabular-nums">
        <span style={{ color: "#f87171" }}>{e.from}%</span>
        <span style={{ color: "var(--faint)" }}> → </span>
        <span style={{ color: "var(--accent)" }}>{e.to}%</span>
      </span>
      <span style={{ color: "var(--faint)" }}>{ar ? "الآن" : "just now"}</span>
    </div>
  );
}
