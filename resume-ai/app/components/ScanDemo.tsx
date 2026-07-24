"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The signature hero element: a live-feeling ATS scan that sweeps a resume,
 * then counts the match score up from a failing 47 to a passing 92 —
 * dramatizing the exact before/after the product delivers. Loops forever
 * (video-like hero): scan → pass → hold → rewind → scan again.
 */
export default function ScanDemo({ ar = false }: { ar?: boolean }) {
  const [score, setScore] = useState(47);
  const [phase, setPhase] = useState<"scanning" | "done">("scanning");
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !started.current) {
          started.current = true;
          runSequence();
        }
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => {
      alive.current = false;
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function runSequence() {
    if (!alive.current) return;
    // Let the scan line sweep, then count the score up.
    const scanMs = 1600;
    setTimeout(() => {
      if (!alive.current) return;
      setPhase("done");
      const target = 92;
      const start = 47;
      const dur = 1100;
      const t0 = performance.now();
      const tick = (now: number) => {
        if (!alive.current) return;
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        setScore(Math.round(start + (target - start) * eased));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // Hold the passing state, then rewind and loop — unless the user
      // prefers reduced motion (then the final state simply stays).
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (!reduced) {
        setTimeout(() => {
          if (!alive.current) return;
          setScore(47);
          setPhase("scanning");
          runSequence();
        }, 5200);
      }
    }, scanMs);
  }

  const passing = score >= 75;
  const accent = passing ? "#a78bfa" : score >= 55 ? "#fbbf24" : "#f87171";
  const verdict = passing ? (ar ? "تطابق قوي" : "STRONG MATCH") : (ar ? "تطابق منخفض" : "LOW MATCH");
  const t = {
    header: ar ? "فحص ATS · تجريبي" : "ATS Scan · Demo",
    scanning: ar ? "…جارٍ الفحص" : "SCANNING…",
    matchScore: ar ? "نسبة التطابق" : "Match Score",
    before: ar ? "قبل · 47%" : "BEFORE · 47%",
    after: ar ? "بعد · 92%" : "AFTER · 92%",
  };

  const lines = ar
    ? [
        { w: "72%", key: "الكلمات المفتاحية", present: passing },
        { w: "90%", key: "تطابق المسمى", present: true },
        { w: "58%", key: "المهارات", present: passing },
        { w: "84%", key: "الخبرة", present: true },
        { w: "45%", key: "مهارات تقنية", present: passing },
        { w: "66%", key: "الأقدمية", present: passing },
      ]
    : [
        { w: "72%", key: "keywords", present: passing },
        { w: "90%", key: "title match", present: true },
        { w: "58%", key: "skills", present: passing },
        { w: "84%", key: "experience", present: true },
        { w: "45%", key: "hard skills", present: passing },
        { w: "66%", key: "seniority", present: passing },
      ];

  return (
    <div ref={ref} className="relative mx-auto w-full max-w-md">
      {/* The document card */}
      <div
        className="relative overflow-hidden rounded-2xl p-6"
        style={{
          background: "#101316",
          border: "1px solid rgba(255,255,255,0.09)",
          boxShadow: "0 30px 80px -20px rgba(0,0,0,0.7)",
        }}
      >
        {/* header row */}
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: accent, boxShadow: `0 0 10px ${accent}` }}
            />
            <span
              className="font-mono text-[11px] uppercase tracking-[0.2em]"
              style={{ color: "rgba(244,245,243,0.5)" }}
            >
              {t.header}
            </span>
          </div>
          <span
            className="font-mono text-[11px] tracking-wider transition-colors"
            style={{ color: accent }}
          >
            {phase === "scanning" ? t.scanning : verdict}
          </span>
        </div>

        {/* resume skeleton lines with scan overlay */}
        <div className="relative space-y-3">
          {lines.map((l, i) => (
            <div key={l.key} className="flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: phase === "done" ? l.w : "20%",
                    background:
                      phase === "done"
                        ? l.present
                          ? "linear-gradient(90deg,#22c55e,#a78bfa)"
                          : "rgba(248,113,113,0.6)"
                        : "rgba(255,255,255,0.15)",
                    transitionDelay: `${i * 80}ms`,
                  }}
                />
              </div>
              <span
                className="w-24 font-mono text-[10px] tracking-wide"
                style={{ color: "rgba(244,245,243,0.4)" }}
              >
                {l.key}
              </span>
            </div>
          ))}

          {/* scanning line */}
          {phase === "scanning" && (
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-8"
              style={{
                background: "linear-gradient(180deg, rgba(139,92,246,0) 0%, rgba(139,92,246,0.25) 50%, rgba(139,92,246,0) 100%)",
                animation: "scanSweep 1.6s ease-in-out",
              }}
            />
          )}
        </div>

        {/* score readout */}
        <div className="mt-6 flex items-end justify-between border-t pt-5" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: "rgba(244,245,243,0.4)" }}>
              {t.matchScore}
            </div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="font-mono text-5xl font-bold tabular-nums transition-colors" style={{ color: accent }}>
                {score}
              </span>
              <span className="font-mono text-xl" style={{ color: "rgba(244,245,243,0.3)" }}>
                %
              </span>
            </div>
          </div>
          <div
            className="rounded-lg px-3 py-2 font-mono text-[11px] font-bold tracking-wider transition-all"
            style={{
              background: passing ? "rgba(139,92,246,0.12)" : "rgba(248,113,113,0.1)",
              color: accent,
              border: `1px solid ${accent}40`,
            }}
          >
            {phase === "scanning" ? "···" : passing ? (ar ? "✓ قوي" : "✓ STRONG") : (ar ? "✕ ضعيف" : "✕ WEAK")}
          </div>
        </div>
      </div>

      {/* before badge, floats bottom-left */}
      <div
        className="absolute -bottom-4 -left-4 rotate-[-6deg] rounded-lg px-3 py-1.5 font-mono text-[10px] font-bold tracking-wider"
        style={{ background: "#f87171", color: "#1a0505", boxShadow: "0 10px 30px -8px rgba(248,113,113,0.5)" }}
      >
        {t.before}
      </div>
      {/* after badge, floats top-right, appears when done */}
      <div
        className="absolute -right-4 -top-4 rotate-[6deg] rounded-lg px-3 py-1.5 font-mono text-[10px] font-bold tracking-wider transition-all duration-500"
        style={{
          background: "#a78bfa",
          color: "#05130a",
          boxShadow: "0 10px 30px -8px rgba(139,92,246,0.5)",
          opacity: phase === "done" ? 1 : 0,
          transform: phase === "done" ? "translateY(0) rotate(6deg)" : "translateY(8px) rotate(6deg)",
        }}
      >
        {t.after}
      </div>
    </div>
  );
}
