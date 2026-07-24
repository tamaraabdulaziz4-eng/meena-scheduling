import type { Metadata } from "next";
import OrbBrand from "../components/OrbBrand";
import OrbSceneSetter from "../components/orb/OrbSceneSetter";
import Link from "next/link";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "سياسة الخصوصية | Privacy Policy — ResumeAI",
  description: "كيف نعالج سيرتك الذاتية وبياناتك: لا نخزّن سيرتك على خوادمنا، لا نستخدم بياناتك لتدريب النماذج، وتقدر تحذف كل شيء.",
  alternates: { canonical: `${BASE}/privacy` },
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-8">
    <h2 className="mb-3 text-xl font-bold">{title}</h2>
    <div className="space-y-2 text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.75)" }}>{children}</div>
  </section>
);

export default function PrivacyPage() {
  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/terms" className="text-sm" style={{ color: "var(--muted)" }}>الشروط والأحكام</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-3xl px-6 py-14">
        <div className="chip mb-4">● سياسة الخصوصية</div>
        <h1 className="mb-2 text-3xl font-extrabold">خصوصيتك وسيرتك الذاتية</h1>
        <p className="mb-10 text-sm" style={{ color: "var(--muted)" }}>
          آخر تحديث: يوليو ٢٠٢٦ · تنطبق على cv.rabit.sa — خدمة السير الذاتية المقدَّمة عبر نطاق Rabit.sa
          <span dir="ltr"> (English summary at the bottom)</span>
        </p>

        <Section title="١. هل تُخزَّن سيرتك عندنا؟ لا.">
          <p>
            نص سيرتك الذاتية <strong>لا يُحفَظ على خوادمنا</strong>. عند الفحص أو البناء يُرسَل النص لمعالجته
            فوراً ثم يُعاد إليك — لا توجد قاعدة بيانات تحتفظ بالسير الذاتية.
          </p>
          <p>
            المسودّة التي تكتبها تُحفَظ <strong>على جهازك أنت فقط</strong> (متصفحك — localStorage) لكي لا تضيع
            كتابتك عند تحديث الصفحة، وتقدر تمسحها بزر «ابدأ من جديد» أو بمسح بيانات المتصفح.
          </p>
          <p>
            الاستثناء الوحيد: إذا ضغطت أنت «انشر رابطاً عاماً» فسيُحفَظ النص الذي اخترت نشره على رابط عام،
            ومعك زر «إلغاء النشر» يحذفه نهائياً في أي وقت.
          </p>
        </Section>

        <Section title="٢. أين تتم المعالجة؟">
          <p>
            المعالجة تتم عبر مزوّد ذكاء اصطناعي سحابي (خوادم خارج المملكة — الولايات المتحدة). يُرسَل نص السيرة
            لغرض توليد النتيجة فقط. <strong>لا نستخدم بياناتك لتدريب أي نموذج</strong>، ولا نبيعها أو نشاركها مع
            أي جهة تسويقية.
          </p>
        </Section>

        <Section title="٣. ما الذي نحتفظ به فعلاً؟">
          <p>فقط الحد الأدنى لتشغيل حسابك:</p>
          <ul className="mr-5 list-disc space-y-1">
            <li>بريدك الإلكتروني (لتسجيل الدخول وربط اشتراكك) — يُحفَظ حتى تطلب حذفه.</li>
            <li>حالة اشتراكك وتاريخ انتهائه.</li>
            <li>بيانات الدفع تُعالَج بالكامل لدى بوابة الدفع المرخّصة «Paylink» — نحن لا نرى ولا نخزّن رقم بطاقتك إطلاقاً.</li>
          </ul>
        </Section>

        <Section title="٤. تعهّد عدم الاختلاق">
          <p>
            نظامنا مقيَّد برمجياً بعدم إضافة أي رقم أو خبرة أو شهادة لم تذكرها أنت في سيرتك. إذا كان الرقم
            ناقصاً يكتب النظام مكانه «[أضف رقمك الفعلي]» بدل اختراعه. سيرتك تبقى سيرتك — أوضح وأقوى، لكن صادقة.
          </p>
        </Section>

        <Section title="٥. حقوقك وطريقة الحذف">
          <ul className="mr-5 list-disc space-y-1">
            <li>حذف مسودّاتك: زر «ابدأ من جديد» أو مسح بيانات الموقع من متصفحك (فوري، بيدك).</li>
            <li>حذف رابط منشور: زر «إلغاء النشر» بجانب الرابط.</li>
            <li>حذف حسابك وبريدك نهائياً: راسلنا وسننفّذ خلال ٧ أيام.</li>
            <li>وفق نظام حماية البيانات الشخصية السعودي (PDPL) لك حق الاطلاع والتصحيح والحذف — تواصل معنا لأي منها.</li>
          </ul>
        </Section>

        <Section title="٦. من نحن وكيف تتواصل معنا؟">
          <p>
            «ResumeAI» خدمة سير ذاتية تعمل على نطاق <span dir="ltr">cv.rabit.sa</span> التابع لـ«رابِت» (Rabit).
            لأي استفسار عن بياناتك أو الدفع أو الحذف:
          </p>
          <p dir="ltr">
            📧 <a href="mailto:alanziabdulaziz4@gmail.com" className="text-accent underline">alanziabdulaziz4@gmail.com</a>
          </p>
          <p>نرد عادة خلال ٢٤–٤٨ ساعة.</p>
        </Section>

        <div className="card mt-10 p-6" dir="ltr">
          <h2 className="mb-3 text-lg font-bold">English summary</h2>
          <ul className="ml-5 list-disc space-y-1 text-sm" style={{ color: "rgba(244,245,243,0.75)" }}>
            <li><strong>Your resume text is never stored on our servers.</strong> It is processed by a cloud AI provider (US-based) to generate your result, then discarded. Drafts live only in your browser&apos;s localStorage.</li>
            <li>We never use your data to train models, and never sell or share it.</li>
            <li>We keep only your email + subscription status. Card details are handled entirely by the licensed gateway Paylink.</li>
            <li>Public resume links exist only if you publish one, and you can unpublish anytime.</li>
            <li><strong>No-fabrication pledge:</strong> the AI is technically constrained from inventing numbers, employers, or credentials you didn&apos;t provide.</li>
            <li>Account deletion: email us — done within 7 days. Contact: alanziabdulaziz4@gmail.com</li>
          </ul>
        </div>

        <div className="mt-10 flex gap-4">
          <Link href="/terms" className="btn-ghost px-6 py-2.5 text-sm font-semibold" style={{ color: "var(--fg)" }}>الشروط والأحكام ←</Link>
          <Link href="/ar" className="btn-accent px-6 py-2.5 text-sm">الرئيسية</Link>
        </div>
      </div>
    </main>
  );
}
