import type { Metadata } from "next";
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
    title: `مهارات وكلمات ATS لسيرة ${j.title} (2026)`,
    description: `أهم مهارات ${j.title} وكلمات ATS التي يبحث عنها مسؤولو التوظيف. أضف الصحيحة منها لترفع نسبة تطابق سيرتك.`,
    keywords: `مهارات ${j.title}, كلمات ATS ${j.title}, مهارات السيرة الذاتية ${j.title}, ${j.titleEn} skills`,
    alternates: {
      canonical: `${BASE}/ar/resume-skills/${j.slug}`,
      languages: hasEn
        ? { ar: `${BASE}/ar/resume-skills/${j.slug}`, en: `${BASE}/resume-skills/${j.slug}`, "x-default": `${BASE}/resume-skills/${j.slug}` }
        : { ar: `${BASE}/ar/resume-skills/${j.slug}` },
    },
  };
}

export default async function Page({ params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  const j = getJobAr(job);
  if (!j) notFound();

  const siblings = JOBS_AR.filter((x) => x.category === j.category && x.slug !== j.slug).slice(0, 8);

  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "الرئيسية", item: `${BASE}/ar` },
      { "@type": "ListItem", position: 2, name: j.title, item: `${BASE}/ar/resume-skills/${j.slug}` },
    ],
  };

  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/ar/optimize" className="btn-accent px-4 py-2 text-sm">افحص سيرتي</Link>
        </div>
      </nav>

      <article className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-6 font-mono text-xs" style={{ color: "var(--faint)" }}>
          <Link href="/ar" style={{ color: "var(--faint)" }}>الرئيسية</Link> › {j.title}
        </div>
        <div className="chip mb-4">● {j.category}</div>
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight">مهارات وكلمات ATS لسيرة {j.title}</h1>
        <p className="mt-4 text-lg leading-relaxed" style={{ color: "var(--muted)" }}>
          لتعبر سيرة {j.title} أنظمة التوظيف، تحتاج المهارات والكلمات المفتاحية الصحيحة بصياغة الإعلان الوظيفي. أدرج ما تملكه فعلاً فقط.
        </p>

        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-bold">كلمات ATS الأساسية</h2>
          <div className="flex flex-wrap gap-2">
            {j.keywords.map((k) => (
              <span key={k} dir="ltr" className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(74,222,128,0.14)", color: "var(--accent)" }}>{k}</span>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-bold">المهارات الأساسية (Hard & Soft)</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {j.skills.map((s) => (
              <li key={s} className="flex items-center gap-2 text-sm" style={{ color: "rgba(244,245,243,0.85)" }}><span className="text-accent">✓</span> {s}</li>
            ))}
          </ul>
        </section>

        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-bold">شهادات تعزّز فرصك</h2>
          <div className="flex flex-wrap gap-2">
            {j.certs.map((c) => (
              <span key={c} className="rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--muted)" }}>{c}</span>
            ))}
          </div>
        </section>

        <div className="card mt-10 p-7 text-center" style={{ borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.05)" }}>
          <h2 className="text-2xl font-bold">أضف هذه المهارات لسيرتك تلقائياً</h2>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>الصق سيرتك واحصل على الكلمات الناقصة ونسبة التطابق فوراً — مجاناً.</p>
          <Link href="/ar/optimize" className="btn-accent mt-5 inline-block px-8 py-3">افحص سيرتي مجاناً ←</Link>
        </div>

        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-bold">روابط مفيدة</h2>
          <div className="flex flex-wrap gap-3">
            <Link href={`/ar/resume-examples/${j.slug}`} className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>مثال سيرة {j.title} ←</Link>
            <Link href={`/ar/cover-letter-examples/${j.slug}`} className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>خطاب تعريف {j.title} ←</Link>
          </div>
        </section>

        {siblings.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-4 text-2xl font-bold">مهارات مهن {j.category} الأخرى</h2>
            <div className="flex flex-wrap gap-2">
              {siblings.map((s) => (
                <Link key={s.slug} href={`/ar/resume-skills/${s.slug}`} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--muted)" }}>{s.title}</Link>
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
