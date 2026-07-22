import type { Metadata } from "next";
import Link from "next/link";
import ScanDemo from "../components/ScanDemo";
import CheckoutButton from "../components/CheckoutButton";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "ResumeAI — حسّن سيرتك الذاتية وتجاوز أنظمة التوظيف الآلية",
  description:
    "٧٥٪ من السير الذاتية يرفضها نظام التوظيف الآلي قبل أن يراها إنسان. اكتب بالعربي والذكاء الاصطناعي يبني لك سيرة إنجليزية احترافية تتجاوز الفلترة — أول فحص مجاني.",
  alternates: { canonical: `${BASE}/ar` },
};

export default function ArabicHome() {
  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      {/* Nav */}
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/" className="text-sm" style={{ color: "var(--muted)" }}>English</Link>
            <Link href="/ar/build" className="hidden text-sm sm:block" style={{ color: "var(--muted)" }}>إنشاء سيرة</Link>
            <a href="#pricing" className="hidden text-sm sm:block" style={{ color: "var(--muted)" }}>الأسعار</a>
            <Link href="/ar/optimize" className="btn-accent px-4 py-2 text-sm">افحص سيرتك</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden px-6 pb-24 pt-16 md:pt-24">
        <div className="hero-ambient"><div className="grid-lines" /></div>
        <div className="relative z-10 mx-auto grid max-w-6xl items-center gap-16 lg:grid-cols-2">
          <div>
            <div className="chip mb-6">● ٧٥٪ من السير الذاتية يرفضها الروبوت قبل الإنسان</div>
            <h1 className="text-4xl font-extrabold leading-[1.15] tracking-tight md:text-6xl">
              سيرتك الذاتية <span style={{ color: "#f87171" }}>تُرفض تلقائياً.</span>
              <br />
              واحنا <span className="accent-underline text-accent">نصلّحها</span> في ٦٠ ثانية.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed" style={{ color: "var(--muted)" }}>
              اكتب بالعربي براحتك — الذكاء الاصطناعي يفهم كلامك ويحوّله لسيرة ذاتية
              <strong> إنجليزية احترافية </strong>
              مطابقة للكلمات المفتاحية التي تفحصها أنظمة التوظيف في أرامكو وSTC والبنوك والشركات العالمية.
            </p>
            <div className="mt-9 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <Link href="/ar/optimize" className="btn-accent px-8 py-4 text-lg">
                افحص سيرتي مجاناً ←
              </Link>
              <Link href="/ar/build" className="text-sm underline-offset-4 hover:underline" style={{ color: "var(--muted)" }}>
                ما عندك سيرة؟ نبنيها لك من الصفر
              </Link>
            </div>
            <div className="mt-7 flex flex-wrap items-center gap-5 font-mono text-xs" style={{ color: "var(--faint)" }}>
              <span>✓ بدون تسجيل</span>
              <span>✓ النتيجة في ٦٠ ثانية</span>
              <span>✓ من ٩ دولار بدون اشتراك</span>
            </div>
          </div>
          <div className="lg:pr-8" dir="ltr">
            <ScanDemo />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-5xl px-6 py-24">
        <div className="mb-14 text-center">
          <div className="chip mb-4">كيف يعمل؟</div>
          <h2 className="text-4xl font-bold tracking-tight">ثلاث خطوات. نتيجة تعبر الفلتر.</h2>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          {[
            { n: "٠١", t: "الصق سيرتك — عربي أو إنجليزي", d: "نص عادي بدون تنسيق. اكتب بأي لغة تريحك، الذكاء الاصطناعي يفهمها." },
            { n: "٠٢", t: "أضف إعلان الوظيفة", d: "يستخرج النظام كل مهارة وكلمة مفتاحية يبحث عنها نظام التوظيف في الشركة." },
            { n: "٠٣", t: "استلم السيرة المحسّنة + النتيجة", d: "سيرة إنجليزية احترافية جاهزة، نسبة تطابق من ١٠٠، والكلمات الناقصة بالضبط." },
          ].map((s) => (
            <div key={s.n} className="card card-hover p-7">
              <div className="font-mono text-sm font-bold text-accent">{s.n}</div>
              <h3 className="mt-4 text-lg font-bold">{s.t}</h3>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="px-6 py-24" style={{ background: "rgba(74,222,128,0.025)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto max-w-5xl">
          <div className="mb-14 text-center">
            <div className="chip mb-4">كل الأدوات</div>
            <h2 className="text-4xl font-bold tracking-tight">كل ما تحتاجه للتوظيف — بمكان واحد</h2>
          </div>
          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {[
              { t: "تحسين السيرة (ATS)", d: "نسبة تطابق مع الوظيفة + إعادة كتابة كاملة بالإنجليزية.", href: "/ar/optimize" },
              { t: "إنشاء سيرة من الصفر", d: "جاوب بالعربي على أسئلة بسيطة — تستلم سيرة إنجليزية جاهزة.", href: "/ar/build" },
              { t: "خطاب التقديم", d: "خطاب مخصص لنفس الوظيفة، جاهز للإرسال." },
              { t: "تحسين لينكدإن", d: "عنوان ونبذة ومهارات تجعل مسؤولي التوظيف يجدونك." },
              { t: "تجهيز المقابلة", d: "أكثر ٨ أسئلة متوقعة مع إجابات قوية من خلفيتك أنت." },
              { t: "تصدير PDF", d: "تنزيل السيرة بتنسيق أنيق جاهز للتقديم." },
            ].map((f) => (
              <div key={f.t} className="card card-hover p-6">
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg font-mono text-sm font-bold"
                  style={{ background: "rgba(74,222,128,0.1)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.2)" }}>✓</div>
                <h3 className="font-bold">{f.t}</h3>
                <p className="mt-1.5 text-sm" style={{ color: "var(--muted)" }}>{f.d}</p>
                {f.href && <Link href={f.href} className="mt-3 inline-block text-sm font-semibold text-accent">جرّبها ←</Link>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="mx-auto max-w-4xl px-6 py-24">
        <div className="mb-14 text-center">
          <div className="chip mb-4">الأسعار</div>
          <h2 className="text-4xl font-bold tracking-tight">ادفع مرة واحدة. مو اشتراك يلاحقك.</h2>
          <p className="mx-auto mt-4 max-w-md text-sm" style={{ color: "var(--muted)" }}>
            الأدوات الأجنبية المشابهة تكلف حتى ٥٠ دولار شهرياً. أول فحص عندنا مجاني.
          </p>
        </div>
        <div className="mx-auto grid max-w-2xl gap-5 md:grid-cols-2">
          <div className="card p-8">
            <div className="font-mono text-xs uppercase tracking-widest" style={{ color: "var(--faint)" }}>مرة واحدة</div>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-5xl font-extrabold">$9</span>
              <span className="text-sm" style={{ color: "var(--muted)" }}>فقط</span>
            </div>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>مثالية لوظيفة واحدة مهمة.</p>
            <ul className="mt-6 space-y-3 text-sm">
              {["تحسين كامل للسيرة", "نسبة التطابق ATS", "تحليل الكلمات المفتاحية", "إعادة كتابة النقاط", "تقرير فجوة المهارات"].map((f) => (
                <li key={f} className="flex items-center gap-3" style={{ color: "rgba(244,245,243,0.8)" }}>
                  <span className="text-accent">✓</span> {f}
                </li>
              ))}
            </ul>
            <div className="mt-8" dir="ltr">
              <CheckoutButton plan="single" label="اشترِ تحسيناً واحداً" variant="ghost" />
            </div>
          </div>
          <div className="card p-8" style={{ borderColor: "rgba(74,222,128,0.5)", background: "rgba(74,222,128,0.05)", position: "relative" }}>
            <div className="absolute left-5 top-5 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold tracking-wider" style={{ background: "var(--accent)", color: "#05130a" }}>الأفضل قيمة</div>
            <div className="font-mono text-xs uppercase tracking-widest" style={{ color: "var(--faint)" }}>غير محدود</div>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-5xl font-extrabold">$19</span>
              <span className="text-sm" style={{ color: "var(--muted)" }}>/ شهرياً</span>
            </div>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>لبحث نشط عن وظيفة.</p>
            <ul className="mt-6 space-y-3 text-sm">
              {["تحسينات غير محدودة", "كل مزايا الباقة الأولى", "خطابات تقديم", "أولوية الدعم", "إلغاء بأي وقت"].map((f) => (
                <li key={f} className="flex items-center gap-3" style={{ color: "rgba(244,245,243,0.9)" }}>
                  <span className="text-accent">✓</span> {f}
                </li>
              ))}
            </ul>
            <div className="mt-8" dir="ltr">
              <CheckoutButton plan="monthly" label="← اشترك الآن" variant="accent" />
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden px-6 py-24 text-center">
        <div className="hero-ambient" />
        <div className="relative z-10 mx-auto max-w-2xl">
          <h2 className="text-4xl font-extrabold tracking-tight md:text-5xl">
            لا تترك الروبوت <span style={{ color: "#f87171" }}>يقرر مستقبلك.</span>
          </h2>
          <p className="mx-auto mt-6 max-w-md text-lg" style={{ color: "var(--muted)" }}>
            فحص واحد. إعادة كتابة واحدة. نتيجة تعبر. جرّبها الآن خلال ٦٠ ثانية.
          </p>
          <Link href="/ar/optimize" className="btn-accent mt-9 inline-block px-10 py-4 text-lg">افحص سيرتي مجاناً ←</Link>
          <p className="mt-4 font-mono text-xs" style={{ color: "var(--faint)" }}>فحص مجاني · بدون بطاقة</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded font-mono text-xs font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-sm font-bold">ResumeAI</span>
          </div>
          <div className="flex gap-5 text-sm">
            <Link href="/ar/build" style={{ color: "var(--muted)" }}>إنشاء سيرة</Link>
            <Link href="/ar/optimize" style={{ color: "var(--muted)" }}>تحسين سيرة</Link>
            <Link href="/" style={{ color: "var(--muted)" }}>English</Link>
          </div>
          <p className="font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 ResumeAI</p>
        </div>
      </footer>
    </main>
  );
}
