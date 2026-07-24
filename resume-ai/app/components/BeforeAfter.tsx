"use client";
import { useEffect, useState } from "react";

/** Before/after proof bar — the single biggest "show the value" lever from the
 *  audits. Animates the current score climbing to the projected score the
 *  rewrite would honestly reach on the same rubric. `after` is a projection,
 *  labelled as such — never presented as a guaranteed outcome. */
export default function BeforeAfter({
  before,
  after,
  ar = false,
}: {
  before: number;
  after: number;
  ar?: boolean;
}) {
  const gain = Math.max(0, after - before);
  // Animate the "after" fill on mount for a live before→after feel.
  const [shown, setShown] = useState(before);
  useEffect(() => {
    const id = setTimeout(() => setShown(after), 250);
    return () => clearTimeout(id);
  }, [after]);

  const barColor = (v: number) => (v >= 75 ? "#a78bfa" : v >= 55 ? "#fbbf24" : "#f87171");
  const t = (en: string, arText: string) => (ar ? arText : en);

  if (gain <= 0) return null;

  return (
    <div className="card mt-6 p-6" dir={ar ? "rtl" : "ltr"} style={{ borderColor: "rgba(139,92,246,0.3)" }}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-bold">{t("Before → after the rewrite", "قبل ← بعد إعادة الكتابة")}</h3>
        <span
          className="rounded-lg px-3 py-1 font-mono text-xs font-bold"
          style={{ background: "rgba(139,92,246,0.14)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}
        >
          +{gain} {t("pts", "نقطة")}
        </span>
      </div>

      {/* Before row */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between text-xs" style={{ color: "var(--faint)" }}>
          <span>{t("Your resume now", "سيرتك الآن")}</span>
          <span className="font-mono tabular-nums">{before}%</span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
          <div
            className="h-full rounded-full"
            style={{ width: `${before}%`, background: barColor(before), transition: "width 0.6s ease" }}
          />
        </div>
      </div>

      {/* After row */}
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs" style={{ color: "var(--muted)" }}>
          <span className="font-semibold">{t("With the ResumeAI rewrite", "بعد إعادة كتابة ResumeAI")}</span>
          <span className="font-mono font-bold tabular-nums" style={{ color: "var(--accent)" }}>{shown}%</span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
          <div
            className="h-full rounded-full"
            style={{
              width: `${shown}%`,
              background: "linear-gradient(90deg, var(--accent-deep), var(--accent))",
              transition: "width 1.1s cubic-bezier(0.22,1,0.36,1)",
            }}
          />
        </div>
      </div>

      <p className="mt-4 text-xs leading-relaxed" style={{ color: "var(--faint)" }}>
        {t(
          "Projection based on the same ATS rubric — a rewrite reorganizes and sharpens your real experience; it never invents skills you don't have.",
          "توقّع مبني على نفس معايير الـ ATS — إعادة الكتابة ترتّب خبرتك الحقيقية وتبرزها بوضوح، ولا تختلق مهارات لا تملكها.",
        )}
      </p>
    </div>
  );
}
