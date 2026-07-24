import type { Metadata } from "next";
import OrbBrand from "../../components/OrbBrand";
import OrbSceneSetter from "../../components/orb/OrbSceneSetter";
import Link from "next/link";
import { JOBS_AR, AR_CATEGORIES } from "../../lib/jobs-ar";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "أمثلة سير ذاتية عربية لكل مهنة + كلمات ATS (2026)",
  description: "دليل أمثلة السير الذاتية العربية لكل مهنة — كلمات ATS، المهارات، ونماذج جاهزة. اختر مهنتك وابنِ سيرتك المتوافقة مع أنظمة التوظيف مجاناً.",
  alternates: {
    canonical: `${BASE}/ar/resume-examples`,
    languages: { ar: `${BASE}/ar/resume-examples`, en: `${BASE}/resume-examples`, "x-default": `${BASE}/resume-examples` },
  },
};

export default function Hub() {
  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="14%" size={100} />
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/ar/optimize" className="btn-accent px-4 py-2 text-sm">افحص سيرتي</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-12">
        <div className="chip mb-4">● أمثلة السير الذاتية</div>
        <h1 className="text-4xl font-extrabold tracking-tight">أمثلة سير ذاتية عربية لكل مهنة</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed" style={{ color: "var(--muted)" }}>
          اختر مهنتك لترى نموذج سيرة ذاتية كاملاً، كلمات ATS التي تفحصها أنظمة التوظيف، المهارات، وخطاب تعريف جاهز — ثم ابنِ سيرتك مجاناً.
        </p>

        {AR_CATEGORIES.map((cat) => (
          <section key={cat} className="mt-10">
            <h2 className="mb-4 text-xl font-bold">{cat}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {JOBS_AR.filter((j) => j.category === cat).map((j) => (
                <Link key={j.slug} href={`/ar/resume-examples/${j.slug}`}
                  className="card card-hover p-4" style={{ color: "var(--fg)" }}>
                  <div className="font-bold">{j.title}</div>
                  <div className="mt-1 text-xs" style={{ color: "var(--faint)" }}>مثال سيرة · مهارات · خطاب تعريف</div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="text-center font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 ResumeAI · خدمة سير ذاتية من Rabit</p>
      </footer>
    </main>
  );
}
