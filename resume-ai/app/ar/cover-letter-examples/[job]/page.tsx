import type { Metadata } from "next";
import OrbBrand from "../../../components/OrbBrand";
import OrbSceneSetter from "../../../components/orb/OrbSceneSetter";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JOBS_AR, AR_SLUGS, getJobAr } from "../../../lib/jobs-ar";
import { getJob } from "../../../lib/jobs";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export function generateStaticParams() {
  return AR_SLUGS.map((job) => ({ job }));
}

export async function generateMetadata({ params }: { params: Promise<{ job: string }> }): Promise<Metadata> {
  const { job } = await params;
  const j = getJobAr(job);
  if (!j) return {};
  const hasEn = !!getJob(job);
  return {
    title: `مثال خطاب تعريف ${j.title} (2026)`,
    description: `نموذج خطاب تعريف (Cover Letter) لوظيفة ${j.title} جاهز للتخصيص، مع نصائح لكتابته بشكل احترافي مقنع.`,
    keywords: `خطاب تعريف ${j.title}, خطاب تقديم ${j.title}, cover letter ${j.titleEn}`,
    alternates: {
      canonical: `${BASE}/ar/cover-letter-examples/${j.slug}`,
      languages: hasEn
        ? { ar: `${BASE}/ar/cover-letter-examples/${j.slug}`, en: `${BASE}/cover-letter-examples/${j.slug}`, "x-default": `${BASE}/cover-letter-examples/${j.slug}` }
        : { ar: `${BASE}/ar/cover-letter-examples/${j.slug}` },
    },
  };
}

export default async function Page({ params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  const j = getJobAr(job);
  if (!j) notFound();

  const siblings = JOBS_AR.filter((x) => x.category === j.category && x.slug !== j.slug).slice(0, 8);

  const letter = `السادة/ مسؤولي التوظيف المحترمين،

يسعدني التقدّم لوظيفة ${j.title} لديكم. أحمل خبرة عملية في ${j.skills.slice(0, 3).join("، ")}، وأسعى لإضافة قيمة حقيقية لفريقكم.

في دوري السابق، ${j.bullets[0].replace(/\[أضف رقمك\]/g, "…")}. كما أتقن العمل على ${j.keywords.slice(0, 4).join("، ")}، وهي من المتطلبات الأساسية لهذا الدور.

يمكنني تحقيق نتائج ملموسة تنسجم مع أهدافكم، وأتطلّع لفرصة مقابلتكم لمناقشة كيف يمكنني المساهمة في نجاح فريقكم.

مع خالص التقدير،
[اسمك]`;

  const tips = [
    `خصّص الخطاب لكل وظيفة — اذكر اسم الشركة ومطابقة مهاراتك لمتطلبات ${j.title} المحددة.`,
    `ابدأ بإنجاز رقمي قوي من خبرتك بدل عبارات عامة مثل «أنا مجتهد».`,
    `اربط خبرتك بكلمات ATS الخاصة بـ ${j.title} مثل ${j.keywords.slice(0, 3).join("، ")}.`,
    `اجعله من ٣ إلى ٤ فقرات قصيرة في صفحة واحدة، وأنهِه بدعوة واضحة للمقابلة.`,
  ];

  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "الرئيسية", item: `${BASE}/ar` },
      { "@type": "ListItem", position: 2, name: `خطاب تعريف ${j.title}`, item: `${BASE}/ar/cover-letter-examples/${j.slug}` },
    ],
  };

  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="14%" size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/ar/optimize" className="btn-accent px-4 py-2 text-sm">افحص سيرتي</Link>
        </div>
      </nav>

      <article className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-6 font-mono text-xs" style={{ color: "var(--faint)" }}>
          <Link href="/ar" style={{ color: "var(--faint)" }}>الرئيسية</Link> › خطاب تعريف {j.title}
        </div>
        <div className="chip mb-4">● {j.category}</div>
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight">مثال خطاب تعريف {j.title}</h1>
        <p className="mt-4 text-lg leading-relaxed" style={{ color: "var(--muted)" }}>
          نموذج خطاب تعريف احترافي لوظيفة {j.title} — انسخه وخصّصه بمعلوماتك، أو أنشئ خطاباً مخصصاً لوظيفتك تلقائياً.
        </p>

        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-bold">نموذج الخطاب (قابل للنسخ)</h2>
          <div className="card whitespace-pre-wrap p-6 text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>{letter}</div>
        </section>

        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-bold">نصائح لخطاب {j.title} مقنع</h2>
          <ul className="space-y-3">
            {tips.map((t) => (
              <li key={t} className="card p-4 text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}><span className="text-accent">←</span> {t}</li>
            ))}
          </ul>
        </section>

        <div className="card mt-10 p-7 text-center" style={{ borderColor: "rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.05)" }}>
          <h2 className="text-2xl font-bold">أنشئ خطاب تعريف مخصصاً بالذكاء الاصطناعي</h2>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>الصق سيرتك وإعلان الوظيفة، واحصل على خطاب جاهز للإرسال خلال ثوانٍ.</p>
          <Link href="/ar/optimize" className="btn-accent mt-5 inline-block px-8 py-3">ابدأ مجاناً ←</Link>
        </div>

        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-bold">لهذه المهنة</h2>
          <div className="flex flex-wrap gap-3">
            <Link href={`/ar/resume-examples/${j.slug}`} className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>مثال سيرة {j.title} ←</Link>
            <Link href={`/ar/resume-skills/${j.slug}`} className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>مهارات {j.title} ←</Link>
          </div>
        </section>

        {siblings.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-4 text-2xl font-bold">خطابات تعريف لمهن {j.category}</h2>
            <div className="flex flex-wrap gap-2">
              {siblings.map((s) => (
                <Link key={s.slug} href={`/ar/cover-letter-examples/${s.slug}`} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--muted)" }}>{s.title}</Link>
              ))}
            </div>
          </section>
        )}
      </article>

      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="text-center font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 ResumeAI · خدمة سير ذاتية من Rabit</p>
      </footer>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
    </main>
  );
}
