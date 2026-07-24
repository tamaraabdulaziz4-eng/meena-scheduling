"use client";

/**
 * Active coaching on the result: a celebratory "improved" reveal + a concrete
 * "add these to go higher" guide that teaches the user exactly what their resume
 * is missing (keywords, real numbers, skills, claims to confirm) so they can push
 * the score up themselves — instead of a passive list.
 */
interface Improvement { area: string; issue: string; fix: string; source?: string }

export default function ResultCoaching({
  before, after, improvements, missingKeywords, skillsGap, hasPlaceholders, ar = false,
}: {
  before: number; after: number;
  improvements: Improvement[];
  missingKeywords: string[];
  skillsGap: string[];
  hasPlaceholders: boolean;
  ar?: boolean;
}) {
  const gain = Math.max(0, after - before);
  const confirm = improvements.filter((i) => i.source === "needs-confirmation");
  const missingReq = improvements.filter((i) => i.source === "missing-requirement");

  const t = ar
    ? {
        improved: "✨ حسّنّا سيرتك!",
        gained: gain > 0 ? `رفعنا درجتك ${before} ← ${after} (+${gain})` : "أعدنا صياغة سيرتك بشكل أقوى",
        heading: "🚀 كمّل بنفسك — أضف هذي لترفع درجتك أكثر",
        sub: "محرّكنا لا يختلق شيئاً، فالباقي بيدك. أضف هذي المعلومات الحقيقية وأعد الفحص لترتفع الدرجة:",
        numbers: "أضف أرقاماً حقيقية لإنجازاتك",
        numbersHint: "استبدل [أضف رقمك] بنسبة/رقم فعلي — مثال: «رفعت المبيعات ٣٠٪» بدل «مسؤول عن المبيعات». الأرقام ترفع الدرجة كثيراً.",
        keywords: "كلمات مفتاحية تطلبها الوظيفة وناقصة عندك",
        keywordsHint: "لو عندك خبرة فيها فعلاً، أضفها لسيرتك (لا تكتب شيئاً غير صحيح):",
        skills: "مهارات مطلوبة قد تنقصك",
        skillsHint: "لو تملكها أضفها؛ لو لا، فكّر بتعلّمها لتقوية ملفك:",
        confirm: "تأكّد أن هذي التعديلات صحيحة",
        confirmHint: "رفعنا مستوى الصياغة — تأكّد أنها تطابق دورك الحقيقي قبل الاعتماد:",
        missing: "متطلبات الوظيفة غير الظاهرة في سيرتك",
        rescan: "بعد ما تضيف، أعد الفحص وشوف الدرجة ترتفع ⬆️",
      }
    : {
        improved: "✨ Your resume is improved!",
        gained: gain > 0 ? `We raised your score ${before} → ${after} (+${gain})` : "We rewrote your resume stronger",
        heading: "🚀 Finish it yourself — add these to go higher",
        sub: "Our engine never invents anything, so the rest is in your hands. Add this REAL info and re-scan to push the score up:",
        numbers: "Add real numbers to your achievements",
        numbersHint: "Replace [add your number] with an actual metric — e.g. \"grew sales 30%\" beats \"responsible for sales\". Numbers raise the score the most.",
        keywords: "Keywords the job wants that you're missing",
        keywordsHint: "If you genuinely have this experience, add it (never write anything untrue):",
        skills: "Required skills you may be missing",
        skillsHint: "Add them if you have them; if not, consider learning them to strengthen your profile:",
        confirm: "Confirm these edits are true",
        confirmHint: "We strengthened the wording — make sure it matches your real role before using it:",
        missing: "Job requirements not shown in your resume",
        rescan: "After you add them, re-scan and watch the score rise ⬆️",
      };

  const Section = ({ icon, title, hint, items }: { icon: string; title: string; hint: string; items: string[] }) =>
    items.length === 0 ? null : (
      <div className="reveal-rise rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
        <div className="mb-1 text-sm font-bold" style={{ color: "var(--fg)" }}>{icon} {title}</div>
        <div className="mb-2 text-xs" style={{ color: "var(--muted)" }}>{hint}</div>
        <div className="flex flex-wrap gap-1.5">
          {items.slice(0, 12).map((k, i) => (
            <span key={i} className="rounded-full px-2.5 py-1 text-xs" style={{ background: "rgba(139,92,246,0.08)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.25)" }}>{k}</span>
          ))}
        </div>
      </div>
    );

  return (
    <div className="my-6">
      {/* Reveal banner */}
      <div className="improved-banner reveal-pop mb-5 rounded-2xl p-5 text-center" style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.15), rgba(139,92,246,0.05))", border: "1px solid rgba(139,92,246,0.4)" }}>
        <div className="text-2xl font-extrabold" style={{ color: "var(--accent)" }}>{t.improved}</div>
        <div className="mt-1 text-sm font-semibold" style={{ color: "var(--fg)" }}>{t.gained}</div>
      </div>

      {/* Coaching */}
      <div className="rounded-2xl p-5" style={{ background: "rgba(139,92,246,0.04)", border: "1px solid rgba(139,92,246,0.25)" }}>
        <h3 className="mb-1 text-lg font-bold">{t.heading}</h3>
        <p className="mb-4 text-sm" style={{ color: "var(--muted)" }}>{t.sub}</p>
        <div className="space-y-3">
          {hasPlaceholders && (
            <div className="reveal-rise rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid rgba(251,191,36,0.35)" }}>
              <div className="mb-1 text-sm font-bold" style={{ color: "#fbbf24" }}>🔢 {t.numbers}</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>{t.numbersHint}</div>
            </div>
          )}
          <Section icon="🎯" title={t.keywords} hint={t.keywordsHint} items={missingKeywords} />
          <Section icon="🧩" title={t.skills} hint={t.skillsHint} items={skillsGap} />
          {confirm.length > 0 && (
            <div className="reveal-rise rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid rgba(251,191,36,0.35)" }}>
              <div className="mb-2 text-sm font-bold" style={{ color: "#fbbf24" }}>⚠️ {t.confirm}</div>
              <ul className="space-y-1 text-xs" style={{ color: "var(--muted)" }}>
                {confirm.slice(0, 5).map((c, i) => <li key={i}>• {c.fix}</li>)}
              </ul>
            </div>
          )}
          {missingReq.length > 0 && (
            <div className="reveal-rise rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid rgba(248,113,113,0.3)" }}>
              <div className="mb-2 text-sm font-bold" style={{ color: "#f87171" }}>❗ {t.missing}</div>
              <ul className="space-y-1 text-xs" style={{ color: "var(--muted)" }}>
                {missingReq.slice(0, 5).map((c, i) => <li key={i}>• {c.issue}</li>)}
              </ul>
            </div>
          )}
        </div>
        <div className="mt-4 rounded-xl px-4 py-2.5 text-center text-sm font-semibold" style={{ background: "rgba(139,92,246,0.1)", color: "var(--accent)" }}>{t.rescan}</div>
      </div>
    </div>
  );
}
