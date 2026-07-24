"use client";
import { useState } from "react";

/**
 * Interactive gap-filling: the AI ASKS the user about the specific things their
 * resume is missing (skills/keywords the job wants, real numbers). If the user
 * HAS them, they type them in; we append the confirmed facts to the resume and
 * re-optimize → a higher, honest score. Nothing is invented — the user supplies
 * their own real information.
 */
export default function GapFiller({
  missingKeywords, skillsGap, ar = false, busy = false, onApply,
}: {
  missingKeywords: string[];
  skillsGap: string[];
  ar?: boolean;
  busy?: boolean;
  onApply: (additions: string) => void;
}) {
  // Build up to 6 questions from the gaps the AI found.
  const gaps = Array.from(new Set([...(skillsGap || []), ...(missingKeywords || [])])).slice(0, 6);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");

  if (gaps.length === 0) return null;

  const t = ar
    ? {
        title: "🤝 خلّنا نكمّل سيرتك سوا",
        sub: "الوظيفة تطلب هذي الأشياء وما لقيناها في سيرتك. لو عندك خبرة فيها فعلاً، اكتبها وبنضيفها ونرفع درجتك. لو ما عندها، اتركها فارغة — ما نخترع شيئاً.",
        q: (g: string) => `عندك خبرة في «${g}»؟ صفها بجملة`,
        ph: "مثال: استخدمت … في مشروع … لمدة …",
        extra: "أي إنجاز أو رقم آخر تحب تضيفه؟",
        apply: "أضِف وأعد التحسين",
        applying: "جارٍ التحسين…",
        none: "الحقول الفارغة تُتجاهَل — نضيف فقط ما كتبته.",
      }
    : {
        title: "🤝 Let's finish your resume together",
        sub: "The job asks for these and we didn't find them in your resume. If you genuinely have the experience, type it and we'll add it and raise your score. If not, leave it blank — we never invent anything.",
        q: (g: string) => `Do you have experience with "${g}"? Describe it in a sentence`,
        ph: "e.g. Used … on … project for … months",
        extra: "Any other achievement or number to add?",
        apply: "Add & re-optimize",
        applying: "Optimizing…",
        none: "Empty fields are ignored — we only add what you write.",
      };

  function apply() {
    const lines: string[] = [];
    for (const g of gaps) {
      const v = (answers[g] || "").trim();
      if (v) lines.push(`${g}: ${v}`);
    }
    if (note.trim()) lines.push(note.trim());
    if (lines.length === 0) return;
    // Hand the confirmed facts back to the page to append + re-scan.
    onApply(`\n\nADDITIONAL EXPERIENCE CONFIRMED BY THE CANDIDATE (incorporate naturally):\n- ${lines.join("\n- ")}`);
  }

  const inp = { background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" } as const;
  const anyFilled = gaps.some((g) => (answers[g] || "").trim()) || note.trim().length > 0;

  return (
    <div className="my-6 rounded-2xl p-5" style={{ background: "rgba(99,102,241,0.05)", border: "1px solid rgba(99,102,241,0.3)" }} dir={ar ? "rtl" : "ltr"}>
      <h3 className="text-lg font-bold">{t.title}</h3>
      <p className="mb-4 mt-1 text-sm" style={{ color: "var(--muted)" }}>{t.sub}</p>
      <div className="space-y-3">
        {gaps.map((g) => (
          <div key={g}>
            <label className="mb-1 block text-xs font-semibold" style={{ color: "var(--fg)" }}>{t.q(g)}</label>
            <input value={answers[g] || ""} onChange={(e) => setAnswers((a) => ({ ...a, [g]: e.target.value }))}
              placeholder={t.ph} className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none" style={inp} />
          </div>
        ))}
        <div>
          <label className="mb-1 block text-xs font-semibold" style={{ color: "var(--fg)" }}>{t.extra}</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t.ph} className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none" style={inp} />
        </div>
      </div>
      <button onClick={apply} disabled={busy || !anyFilled}
        className="btn-accent mt-4 w-full py-3 text-base font-bold disabled:opacity-40">
        {busy ? t.applying : t.apply}
      </button>
      <p className="mt-2 text-center text-[11px]" style={{ color: "var(--faint)" }}>{t.none}</p>
    </div>
  );
}
