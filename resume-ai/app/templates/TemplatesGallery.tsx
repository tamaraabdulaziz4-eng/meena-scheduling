"use client";
import Link from "next/link";
import ResumeTemplate, { type TemplateVariant } from "../components/ResumeTemplate";

const SAMPLE = `Sara Al-Otaibi
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

Marketing Intern — Agency X (2020–2021)
- Produced content and monthly performance reports

EDUCATION
BSc Marketing — King Saud University, 2020`;

interface Tpl { slug: string; name: string; nameAr: string; variant: TemplateVariant; accent: string; tag: string; tagAr: string }

const TEMPLATES: Tpl[] = [
  { slug: "onyx", name: "Onyx", nameAr: "أونيكس", variant: "classic", accent: "#0f766e", tag: "Two-column · ATS-safe", tagAr: "عمودان · آمن ATS" },
  { slug: "riyadh", name: "Riyadh", nameAr: "الرياض", variant: "classic", accent: "#b45309", tag: "Warm · Gulf", tagAr: "دافئ · خليجي" },
  { slug: "azure", name: "Azure", nameAr: "أزور", variant: "modern", accent: "#1d4ed8", tag: "Sidebar right · Modern", tagAr: "شريط يمين · عصري" },
  { slug: "executive", name: "Executive", nameAr: "تنفيذي", variant: "elegant", accent: "#111827", tag: "Centered · Formal", tagAr: "متوسّط · رسمي" },
  { slug: "minimal", name: "Minimalist", nameAr: "بسيط", variant: "minimal", accent: "#0f766e", tag: "Clean · No fill", tagAr: "نظيف · بلا تعبئة" },
  { slug: "emerald", name: "Emerald", nameAr: "زمرّد", variant: "classic", accent: "#047857", tag: "Fresh · Green", tagAr: "منعش · أخضر" },
  { slug: "crimson", name: "Crimson", nameAr: "قرمزي", variant: "modern", accent: "#b91c1c", tag: "Bold · Creative", tagAr: "جريء · إبداعي" },
  { slug: "slate", name: "Slate", nameAr: "سليت", variant: "minimal", accent: "#334155", tag: "Neutral · Corporate", tagAr: "محايد · مؤسسي" },
  { slug: "royal", name: "Royal", nameAr: "ملكي", variant: "elegant", accent: "#6d28d9", tag: "Elegant · Purple", tagAr: "أنيق · بنفسجي" },
  { slug: "teal-pro", name: "Teal Pro", nameAr: "تيل برو", variant: "modern", accent: "#0d9488", tag: "Tech · Sidebar right", tagAr: "تقني · شريط يمين" },
];

// 794px design width scaled into a ~280px card → ratio ~0.353.
const SCALE = 0.35;

export default function TemplatesGallery({ ar = false }: { ar?: boolean }) {
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {TEMPLATES.map((t) => (
        <div key={t.slug} className="card overflow-hidden p-4 card-hover">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="font-bold">{ar ? t.nameAr : t.name}</div>
              <div className="font-mono text-[11px]" style={{ color: "var(--faint)" }}>{ar ? t.tagAr : t.tag}</div>
            </div>
            <span className="rounded-full px-2 py-0.5 font-mono text-[10px] font-bold" style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>ATS</span>
          </div>
          {/* Scaled preview */}
          <div className="mb-4 overflow-hidden rounded-lg" style={{ height: 794 * SCALE * 0.62, border: "1px solid var(--line)" }}>
            <div style={{ width: 794, transform: `scale(${SCALE})`, transformOrigin: "top left" }}>
              <ResumeTemplate text={SAMPLE} accent={t.accent} variant={t.variant} preview />
            </div>
          </div>
          <Link href={`/build?template=${t.slug}`} className="btn-accent block w-full py-2.5 text-center text-sm font-semibold">
            {ar ? "استخدم هذا القالب ←" : "Use this template →"}
          </Link>
        </div>
      ))}
    </div>
  );
}
