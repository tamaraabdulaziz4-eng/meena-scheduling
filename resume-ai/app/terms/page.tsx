import type { Metadata } from "next";
import Link from "next/link";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "الشروط والأحكام وسياسة الاسترجاع | Terms — ResumeAI",
  description: "شروط استخدام خدمة ResumeAI على cv.rabit.sa، الأسعار، وسياسة الاسترجاع.",
  alternates: { canonical: `${BASE}/terms` },
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-8">
    <h2 className="mb-3 text-xl font-bold">{title}</h2>
    <div className="space-y-2 text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.75)" }}>{children}</div>
  </section>
);

export default function TermsPage() {
  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/privacy" className="text-sm" style={{ color: "var(--muted)" }}>سياسة الخصوصية</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-3xl px-6 py-14">
        <div className="chip mb-4">● الشروط والأحكام</div>
        <h1 className="mb-2 text-3xl font-extrabold">شروط الاستخدام وسياسة الاسترجاع</h1>
        <p className="mb-10 text-sm" style={{ color: "var(--muted)" }}>آخر تحديث: يوليو ٢٠٢٦ · تنطبق على cv.rabit.sa</p>

        <Section title="١. الخدمة">
          <p>
            ResumeAI أداة ذكاء اصطناعي تساعدك على تحسين وضوح سيرتك الذاتية وملاءمتها لمتطلبات الوظائف،
            وبناء سيرة إنجليزية من إجاباتك. النتائج <strong>مساعدة تحريرية</strong> — لا نضمن قبولك في وظيفة
            ولا اجتياز أي نظام توظيف معيّن، لأن قرارات التوظيف بيد جهات التوظيف وأنظمتها المختلفة.
          </p>
          <p>أنت مسؤول عن مراجعة النتيجة قبل استخدامها، خاصة المواضع المعلَّمة بـ«[أضف رقمك الفعلي]».</p>
        </Section>

        <Section title="٢. الأسعار">
          <ul className="mr-5 list-disc space-y-1">
            <li><strong>تحسين واحد — ٣٥ ريالاً (دفعة واحدة):</strong> وصول لمدة ٢٤ ساعة يشمل السيرة المحسّنة كاملة وخطاب التعريف.</li>
            <li><strong>باحث نشط — ٧٥ ريالاً شهرياً:</strong> تحسينات غير محدودة وكل المزايا لمدة ٣٠ يوماً. التجديد يدوي (لا يوجد خصم تلقائي حالياً).</li>
            <li>فحص الدرجة والتحليل مجاني دائماً بدون بطاقة.</li>
          </ul>
        </Section>

        <Section title="٣. سياسة الاسترجاع">
          <p>ندفع لك فلوسك كاملة إذا لم تحصل على الخدمة:</p>
          <ul className="mr-5 list-disc space-y-1">
            <li>إذا دفعت ولم تُفعَّل خدمتك، أو فشل النظام بتوليد سيرتك المحسّنة — <strong>استرجاع كامل</strong> خلال ٧ أيام من الدفع.</li>
            <li>راسلنا بالبريد مع رقم العملية وسنعالج الطلب خلال ٣ أيام عمل، ويعود المبلغ عبر نفس وسيلة الدفع.</li>
            <li>لا يشمل الاسترجاع حالة استخدام الخدمة الكامل ثم طلب الاسترجاع لعدم الإعجاب بالأسلوب — لكن راسلنا وسنحاول إرضاءك.</li>
          </ul>
        </Section>

        <Section title="٤. الاستخدام المقبول">
          <ul className="mr-5 list-disc space-y-1">
            <li>لا تستخدم الخدمة لإنشاء سير بمعلومات كاذبة عن هوية شخص آخر أو مؤهلات مزوّرة.</li>
            <li>روابط النشر العامة مخصّصة لسيرتك أنت — يُحذَف أي محتوى مخالف أو مسيء.</li>
            <li>يُحظر الاستخدام الآلي المفرط (سكربتات/هجمات) وقد يُقيَّد.</li>
          </ul>
        </Section>

        <Section title="٥. الدفع">
          <p>
            المدفوعات تُعالَج عبر بوابة «Paylink» المرخّصة في السعودية (مدى، فيزا، ماستركارد) بالريال السعودي.
            لا نطّلع على بيانات بطاقتك ولا نخزّنها.
          </p>
        </Section>

        <Section title="٦. التواصل">
          <p>
            الخدمة تعمل على نطاق <span dir="ltr">cv.rabit.sa</span> التابع لـ«رابِت» (Rabit).
            لأي مشكلة دفع أو استفسار:
          </p>
          <p dir="ltr">📧 <a href="mailto:alanziabdulaziz4@gmail.com" className="text-accent underline">alanziabdulaziz4@gmail.com</a></p>
        </Section>

        <div className="card mt-10 p-6" dir="ltr">
          <h2 className="mb-3 text-lg font-bold">English summary</h2>
          <ul className="ml-5 list-disc space-y-1 text-sm" style={{ color: "rgba(244,245,243,0.75)" }}>
            <li>ResumeAI is an editorial AI aid — we don&apos;t guarantee hiring outcomes or passage through any specific ATS.</li>
            <li>Pricing: SAR 35 one-time (24h full access) or SAR 75/month (30 days unlimited, manual renewal — no auto-charge).</li>
            <li><strong>Refunds:</strong> full refund within 7 days if you paid and the service failed to deliver. Processed within 3 business days via Paylink.</li>
            <li>Payments handled by licensed Saudi gateway Paylink; we never see your card details.</li>
            <li>Contact: alanziabdulaziz4@gmail.com</li>
          </ul>
        </div>

        <div className="mt-10 flex gap-4">
          <Link href="/privacy" className="btn-ghost px-6 py-2.5 text-sm font-semibold" style={{ color: "var(--fg)" }}>سياسة الخصوصية ←</Link>
          <Link href="/ar" className="btn-accent px-6 py-2.5 text-sm">الرئيسية</Link>
        </div>
      </div>
    </main>
  );
}
