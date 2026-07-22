"use client";
import { useEffect, useState } from "react";

/**
 * A rotating illustrative sample chip in the hero: shows the kind of ATS
 * score jump the optimizer produces for a given role. These are generic,
 * role-only examples of the score range — no named individuals, no claimed
 * real users (house rule: never invent testimonials/stats).
 */
const EVENTS_EN = [
  { d: "Software Engineer", from: 44, to: 91 },
  { d: "Project Manager", from: 52, to: 88 },
  { d: "Accountant", from: 39, to: 86 },
  { d: "Sales Manager", from: 47, to: 90 },
  { d: "HR Specialist", from: 55, to: 93 },
  { d: "Data Analyst", from: 41, to: 89 },
];
const EVENTS_AR = [
  { d: "مهندس برمجيات", from: 44, to: 91 },
  { d: "مدير مشاريع", from: 52, to: 88 },
  { d: "محاسب", from: 39, to: 86 },
  { d: "مدير مبيعات", from: 47, to: 90 },
  { d: "أخصائي موارد بشرية", from: 55, to: 93 },
  { d: "محلل بيانات", from: 41, to: 89 },
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
      <span className="font-bold" style={{ color: "var(--faint)" }}>{ar ? "مثال:" : "Sample:"}</span>
      <span style={{ color: "var(--muted)" }}>
        {e.d}
      </span>
      <span dir="ltr" className="font-bold tabular-nums">
        <span style={{ color: "#f87171" }}>{e.from}%</span>
        <span style={{ color: "var(--faint)" }}> → </span>
        <span style={{ color: "var(--accent)" }}>{e.to}%</span>
      </span>
    </div>
  );
}
