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
  // اربط hreflang بالنسخة الإنجليزية إن وُجدت لنفس المهنة.
  const hasEn = !!getJob(job);
  return {
    title: `مثال سيرة ذاتية ${j.title} + كلمات ATS (2026)`,
    description: `نموذج سيرة ذاتية ${j.title} مجاني مع كلمات ATS والمهارات التي تبحث عنها أنظمة التوظيف. حسّن أو ابنِ سيرتك بالثواني.`,
    keywords: `سيرة ذاتية ${j.title}, نموذج سيرة ذاتية ${j.title}, مهارات ${j.title}, كلمات مفتاحية ${j.title}, ${j.titleEn} resume`,
    alternates: {
      canonical: `${BASE}/ar/resume-examples/${j.slug}`,
      languages: hasEn
        ? { ar: `${BASE}/ar/resume-examples/${j.slug}`, en: `${BASE}/resume-examples/${j.slug}`, "x-default": `${BASE}/resume-examples/${j.slug}` }
        : { ar: `${BASE}/ar/resume-examples/${j.slug}` },
    },
    openGraph: { title: `مثال سيرة ذاتية ${j.title} + المهارات (2026)`, description: `كلمات ATS والمهارات ونموذج كامل لسيرة ${j.title}.`, type: "article" },
  };
}

export default async function Page({ params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  const j = getJobAr(job);
  if (!j) notFound();

  const siblings = JOBS_AR.filter((x) => x.category === j.category && x.slug !== j.slug).slice(0, 6);
  const others = JOBS_AR.filter((x) => x.category !== j.category).slice(0, 4);

  const faqs = [
    { q: `ما المهارات التي يجب أن يضعها ${j.title} في السيرة الذاتية؟`, a: `أهم مهارات سيرة ${j.title}: ${j.skills.slice(0, 6).join("، ")}. طابقها مع صياغة الإعلان الوظيفي ليرفع نظام ATS تقييم سيرتك.` },
    { q: `ما كلمات ATS التي تحتاجها سيرة ${j.title}؟`, a: `تفحص أنظمة التوظيف سير ${j.title} عن مصطلحات مثل ${j.keywords.slice(0, 6).join("، ")}. أدرج ما تملكه فعلاً بنفس صياغة الإعلان.` },
    { q: `كم يجب أن يكون طول سيرة ${j.title}؟`, a: `صفحة واحدة لأقل من ١٠ سنوات خبرة، وصفحتان كحد أقصى للأدوار الكبيرة. اجعلها بعمود واحد ومتوافقة مع ATS دون جداول أو رسومات.` },
    { q: `كيف أجعل سيرة ${j.title} تعبر نظام ATS؟`, a: `استخدم عناوين قياسية، طابق المسمى الوظيفي، أدرج كلمات ${j.title} أعلاه، وصغ إنجازاتك بأرقام. أو الصقها في الفاحص المجاني لترى نسبة تطابقك فوراً.` },
  ];

  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "الرئيسية", item: `${BASE}/ar` },
        { "@type": "ListItem", position: 2, name: "أمثلة السير الذاتية", item: `${BASE}/ar/resume-examples` },
        { "@type": "ListItem", position: 3, name: j.title, item: `${BASE}/ar/resume-examples/${j.slug}` },
      ]},
      { "@type": "FAQPage", mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) },
    ],
  };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="mt-10">
      <h2 className="mb-4 text-2xl font-bold tracking-tight">{title}</h2>
      {children}
    </section>
  );

  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="14%" size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">سيرة</span>
          </Link>
          <Link href="/ar/optimize" className="btn-accent px-4 py-2 text-sm">افحص سيرتي</Link>
        </div>
      </nav>

      <article className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-6 font-mono text-xs" style={{ color: "var(--faint)" }}>
          <Link href="/ar" style={{ color: "var(--faint)" }}>الرئيسية</Link> ›{" "}
          <Link href="/ar/resume-examples" style={{ color: "var(--faint)" }}>أمثلة السير</Link> › {j.title}
        </div>

        <div className="chip mb-4">{j.category} · متوافقة مع ATS</div>
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight">مثال سيرة ذاتية {j.title} + كلمات ATS (2026)</h1>
        <p className="mt-4 text-lg leading-relaxed" style={{ color: "var(--muted)" }}>
          {j.demand} نطاق الراتب التقريبي: {j.salary}. تجد أدناه نموذج سيرة {j.title} كاملاً مع الكلمات المفتاحية التي تفحصها أنظمة التوظيف (ATS) — ثم ابنِ سيرتك مجاناً بالثواني.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/ar/optimize" className="btn-accent px-6 py-3">افحص سيرة {j.title} مجاناً ←</Link>
          <Link href="/ar/builder" className="btn-ghost px-6 py-3 font-semibold" style={{ color: "var(--fg)" }}>ابنِ واحدة من الصفر</Link>
        </div>

        <Section title={`مثال ملخص مهني لـ ${j.title}`}>
          <div className="card p-5 text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>{j.summary}</div>
        </Section>

        <Section title={`كلمات ATS لسيرة ${j.title}`}>
          <p className="mb-3 text-sm" style={{ color: "var(--muted)" }}>هذه المصطلحات التي يفحصها نظام ATS. أدرج ما تملكه فعلاً بصياغة الإعلان الوظيفي:</p>
          <div className="flex flex-wrap gap-2">
            {j.keywords.map((k) => (
              <span key={k} dir="ltr" className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(139,92,246,0.14)", color: "var(--accent)" }}>{k}</span>
            ))}
          </div>
        </Section>

        <Section title={`أهم مهارات ${j.title}`}>
          <ul className="grid gap-2 sm:grid-cols-2">
            {j.skills.map((s) => (
              <li key={s} className="flex items-center gap-2 text-sm" style={{ color: "rgba(244,245,243,0.85)" }}><span className="text-accent">✓</span> {s}</li>
            ))}
          </ul>
        </Section>

        <Section title="أمثلة على إنجازات الخبرة العملية">
          <ul className="space-y-3">
            {j.bullets.map((b) => (
              <li key={b} className="card p-4 text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>• {b}</li>
            ))}
          </ul>
        </Section>

        <Section title={`شهادات تقوّي سيرة ${j.title}`}>
          <div className="flex flex-wrap gap-2">
            {j.certs.map((c) => (
              <span key={c} className="rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--muted)" }}>{c}</span>
            ))}
          </div>
        </Section>

        <Section title={`خطأ شائع في سيرة ${j.title}`}>
          <div className="card p-5 text-sm leading-relaxed" style={{ borderColor: "rgba(248,113,113,0.3)", color: "rgba(244,245,243,0.85)" }}>
            <span style={{ color: "#f87171" }}>تجنّب هذا:</span> {j.mistake}
          </div>
        </Section>

        <div className="card mt-10 p-7 text-center" style={{ borderColor: "rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.05)" }}>
          <h2 className="text-2xl font-bold">هل سيرة {j.title} جاهزة لأنظمة ATS؟</h2>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>الصقها واحصل على نسبة تطابق فورية + الكلمات الناقصة — مجاناً وبدون تسجيل.</p>
          <Link href="/ar/optimize" className="btn-accent mt-5 inline-block px-8 py-3">افحص سيرتي مجاناً ←</Link>
        </div>

        <Section title="الأسئلة الشائعة">
          <div className="space-y-4">
            {faqs.map((f) => (
              <div key={f.q} className="card p-5">
                <h3 className="font-bold">{f.q}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{f.a}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section title="لهذه المهنة">
          <div className="flex flex-wrap gap-3">
            <Link href={`/ar/cover-letter-examples/${j.slug}`} className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>خطاب تعريف {j.title} ←</Link>
            <Link href={`/ar/resume-skills/${j.slug}`} className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>مهارات وكلمات ATS لـ {j.title} ←</Link>
          </div>
        </Section>

        <Section title={`مزيد من أمثلة سير ${j.category}`}>
          <div className="flex flex-wrap gap-2">
            {[...siblings, ...others].map((s) => (
              <Link key={s.slug} href={`/ar/resume-examples/${s.slug}`} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--muted)" }}>{s.title}</Link>
            ))}
          </div>
          <Link href="/ar/resume-examples" className="mt-4 inline-block text-sm font-semibold text-accent">كل أمثلة السير ←</Link>
        </Section>
      </article>

      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="text-center font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 سيرة · خدمة سير ذاتية من Rabit</p>
      </footer>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
    </main>
  );
}
