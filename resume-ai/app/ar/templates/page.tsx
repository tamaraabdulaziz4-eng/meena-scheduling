import type { Metadata } from "next";
import OrbBrand from "../../components/OrbBrand";
import OrbSceneSetter from "../../components/orb/OrbSceneSetter";
import Link from "next/link";
import TemplatesGallery from "../../templates/TemplatesGallery";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "قوالب السيرة — متوافقة مع ATS، عربية وإنجليزية | سيرة",
  description:
    "تصفّح قوالب سيرة احترافية متوافقة مع أنظمة الفرز ATS بالعربية والإنجليزية. اختر التصميم، والذكاء يعبّئه بخبرتك الحقيقية — بدون اختلاق. ابدأ مجاناً.",
  alternates: {
    canonical: `${BASE}/ar/templates`,
    languages: { en: `${BASE}/templates`, ar: `${BASE}/ar/templates`, "x-default": `${BASE}/templates` },
  },
  openGraph: { title: "قوالب سيرة متوافقة مع ATS", description: "قوالب احترافية تعبر أنظمة الفرز، بالعربية والإنجليزية.", url: `${BASE}/ar/templates` },
};

export default function ArabicTemplatesPage() {
  return (
    <main className="min-h-screen" dir="rtl" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">سيرة</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/templates" className="text-sm font-semibold" style={{ color: "var(--muted)" }}>EN</Link>
            <Link href="/ar/optimize" className="btn-accent px-4 py-2 text-sm">فحص مجاني ←</Link>
          </div>
        </div>
      </nav>

      <section className="relative mx-auto max-w-6xl px-6 py-14">
        <div className="hero-ambient" aria-hidden />
        <div className="relative mb-10 text-center">
          <div className="chip mb-4">القوالب</div>
          <h1 className="text-4xl font-extrabold tracking-tight">قوالب سيرة احترافية</h1>
          <p className="mx-auto mt-3 max-w-2xl" style={{ color: "var(--muted)" }}>
            كل قالب <strong>متوافق مع ATS</strong> ويعمل بالعربية والإنجليزية. اختر التصميم — والذكاء يعبّئه بخبرتك <em>الحقيقية</em>، بدون اختلاق أي حقيقة.
          </p>
        </div>
        <TemplatesGallery ar />
        <p className="mt-10 text-center text-sm" style={{ color: "var(--faint)" }}>
          الـ PDF المصمّم ممتاز للمسؤولين ولينكدإن. وللتقديم عبر أنظمة الفرز استخدم PDF/Word النصي — كلاهما مشمول.
        </p>
      </section>
    </main>
  );
}
