"use client";
import { useState } from "react";
import Link from "next/link";
import ResumeTemplate, { type TemplateVariant } from "../components/ResumeTemplate";

// Sample content per language mode so previews look right in each direction.
const SAMPLE_EN = `Sara Al-Otaibi
Riyadh, Saudi Arabia · sara@email.com · +966 5X XXX XXXX

PROFESSIONAL SUMMARY
Marketing specialist with 4 years driving social and content campaigns for retail brands. Grew engagement 40% and led a team of 3.

CORE SKILLS
- SEO & content strategy
- Google Analytics
- Paid social (Meta, TikTok)
- Team leadership

LANGUAGES
- Arabic (native)
- English (professional)

EXPERIENCE
Marketing Specialist — Retail Co, Riyadh (2021–Present)
- Led social strategy across 4 channels, +40% engagement
- Managed SAR 200K annual campaign budget

EDUCATION
BSc Marketing — King Saud University, 2020`;

const SAMPLE_AR = `سارة العتيبي
الرياض، السعودية · sara@email.com · +966 5X XXX XXXX

الملخص المهني
أخصائية تسويق بخبرة ٤ سنوات في حملات التواصل والمحتوى لعلامات التجزئة. رفعت التفاعل ٤٠٪ وقادت فريقاً من ٣ أفراد.

المهارات الأساسية
- استراتيجية المحتوى والـ SEO
- تحليلات جوجل
- الإعلانات المدفوعة (ميتا، تيك توك)
- قيادة الفريق

اللغات
- العربية (اللغة الأم)
- الإنجليزية (احترافية)

الخبرة العملية
أخصائية تسويق — شركة تجزئة، الرياض (٢٠٢١–الآن)
- قدت استراتيجية التواصل عبر ٤ قنوات، +٤٠٪ تفاعل
- أدرت ميزانية حملات سنوية ٢٠٠ ألف ريال

التعليم
بكالوريوس تسويق — جامعة الملك سعود، ٢٠٢٠`;

const SAMPLE_BI = `Sara Al-Otaibi · سارة العتيبي
Riyadh, Saudi Arabia · sara@email.com · +966 5X XXX XXXX

PROFESSIONAL SUMMARY · الملخص المهني
Marketing specialist with 4 years in social & content. · أخصائية تسويق بخبرة ٤ سنوات في التواصل والمحتوى.

CORE SKILLS · المهارات
- SEO & content strategy · استراتيجية المحتوى
- Google Analytics · تحليلات جوجل
- Team leadership · قيادة الفريق

EXPERIENCE · الخبرة
Marketing Specialist — Retail Co, Riyadh (2021–Present)
- Led social strategy, +40% engagement · قدت استراتيجية التواصل، +٤٠٪ تفاعل

EDUCATION · التعليم
BSc Marketing — King Saud University, 2020`;

type LangMode = "en" | "ar" | "bi";

interface Tpl { slug: string; name: string; nameAr: string; variant: TemplateVariant; accent: string; tag: string; tagAr: string; best?: boolean }

const TEMPLATES: Tpl[] = [
  { slug: "ats-pro", name: "ATS Pro", nameAr: "إيه تي إس برو", variant: "column", accent: "#0f766e", tag: "Single-column · Best ATS pass-rate", tagAr: "عمود واحد · الأعلى في اجتياز ATS", best: true },
  { slug: "onyx", name: "Onyx", nameAr: "أونيكس", variant: "classic", accent: "#0f766e", tag: "Two-column · Balanced", tagAr: "عمودان · متوازن" },
  { slug: "riyadh", name: "Riyadh", nameAr: "الرياض", variant: "classic", accent: "#b45309", tag: "Warm · Gulf", tagAr: "دافئ · خليجي" },
  { slug: "azure", name: "Azure", nameAr: "أزور", variant: "modern", accent: "#1d4ed8", tag: "Sidebar · Modern", tagAr: "شريط جانبي · عصري" },
  { slug: "executive", name: "Executive", nameAr: "تنفيذي", variant: "elegant", accent: "#111827", tag: "Centered · Formal", tagAr: "متوسّط · رسمي" },
  { slug: "minimal", name: "Minimalist", nameAr: "بسيط", variant: "minimal", accent: "#0f766e", tag: "Clean · No fill", tagAr: "نظيف · بلا تعبئة" },
  { slug: "emerald", name: "Emerald", nameAr: "زمرّد", variant: "classic", accent: "#047857", tag: "Fresh · Green", tagAr: "منعش · أخضر" },
  { slug: "crimson", name: "Crimson", nameAr: "قرمزي", variant: "modern", accent: "#b91c1c", tag: "Bold · Creative", tagAr: "جريء · إبداعي" },
  { slug: "slate", name: "Slate", nameAr: "سليت", variant: "minimal", accent: "#334155", tag: "Neutral · Corporate", tagAr: "محايد · مؤسسي" },
  { slug: "royal", name: "Royal", nameAr: "ملكي", variant: "elegant", accent: "#6d28d9", tag: "Elegant · Purple", tagAr: "أنيق · بنفسجي" },
];

const SCALE = 0.35;

export default function TemplatesGallery({ ar = false }: { ar?: boolean }) {
  const [mode, setMode] = useState<LangMode>(ar ? "ar" : "en");
  const sample = mode === "ar" ? SAMPLE_AR : mode === "bi" ? SAMPLE_BI : SAMPLE_EN;
  const dir = mode === "ar" ? "rtl" : "ltr";

  const modeBtns: { id: LangMode; label: string }[] = [
    { id: "en", label: ar ? "إنجليزي" : "English" },
    { id: "ar", label: ar ? "عربي" : "العربية" },
    { id: "bi", label: ar ? "ثنائي اللغة" : "Bilingual" },
  ];

  return (
    <div>
      {/* Language mode toggle */}
      <div className="mb-8 flex justify-center gap-2">
        {modeBtns.map((b) => (
          <button key={b.id} onClick={() => setMode(b.id)}
            className="rounded-lg px-4 py-2 text-sm font-semibold transition-all"
            style={mode === b.id ? { background: "var(--accent)", color: "#05130a" } : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>
            {b.label}
          </button>
        ))}
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {TEMPLATES.map((t) => (
          <div key={t.slug} className="card overflow-hidden p-4 card-hover" style={t.best ? { borderColor: "rgba(74,222,128,0.5)" } : undefined}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 font-bold">
                  {ar ? t.nameAr : t.name}
                  {t.best && <span className="rounded-full px-2 py-0.5 font-mono text-[9px] font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>{ar ? "الأفضل" : "BEST"}</span>}
                </div>
                <div className="font-mono text-[11px]" style={{ color: "var(--faint)" }}>{ar ? t.tagAr : t.tag}</div>
              </div>
              <span className="rounded-full px-2 py-0.5 font-mono text-[10px] font-bold" style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>ATS</span>
            </div>
            <div className="mb-4 overflow-hidden rounded-lg" style={{ height: 794 * SCALE * 0.62, border: "1px solid var(--line)" }}>
              <div style={{ width: 794, transform: `scale(${SCALE})`, transformOrigin: dir === "rtl" ? "top right" : "top left" }}>
                <ResumeTemplate text={sample} accent={t.accent} variant={t.variant} dir={dir} preview />
              </div>
            </div>
            <Link href={`/build?template=${t.slug}&lang=${mode}`} className="btn-accent block w-full py-2.5 text-center text-sm font-semibold">
              {ar ? "استخدم هذا القالب ←" : "Use this template →"}
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
