import type { Metadata } from "next";
import OrbBrand from "../../components/OrbBrand";
import OrbSceneSetter from "../../components/orb/OrbSceneSetter";
import Link from "next/link";
import { notFound } from "next/navigation";
import ShareButtons from "../../components/ShareButtons";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

// id encodes the score, e.g. "92" — keeps it stateless and instantly shareable.
// ?lang=ar renders the shared card in Arabic + RTL (the AR optimizer links here).
export async function generateMetadata(
  { params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ lang?: string }> }
): Promise<Metadata> {
  const { id } = await params;
  const parsed = parseInt(id);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) notFound();
  const score = parsed;
  const ar = (await searchParams).lang === "ar";
  const img = `${BASE}/api/og?score=${score}`;
  const title = ar
    ? `سيرتي حصلت ${score}/100 في فحص أنظمة التوظيف — افحص سيرتك مجاناً`
    : `My resume scored ${score}/100 on ATS — check yours free`;
  const description = ar
    ? "شوف نسبة توافق سيرتك مع أنظمة التوظيف فوراً ومجاناً — واعرف الكلمات المفتاحية الناقصة بالضبط."
    : "See your resume's ATS match score instantly and free — then get the exact keywords you're missing.";
  const ogDescription = ar ? "احصل على نتيجة توافق سيرتك مجاناً خلال ثوانٍ." : "Get your free ATS resume score in seconds.";
  return {
    title,
    description,
    openGraph: { title, description: ogDescription, images: [{ url: img, width: 1200, height: 630 }], type: "website" },
    twitter: { card: "summary_large_image", title, images: [img] },
  };
}

export default async function ScorePage(
  { params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ lang?: string }> }
) {
  const { id } = await params;
  const parsed = parseInt(id);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) notFound();
  const score = parsed;
  const ar = (await searchParams).lang === "ar";
  const accent = score >= 75 ? "#a78bfa" : score >= 55 ? "#fbbf24" : "#f87171";
  const label = ar
    ? score >= 75 ? "مرشّح للقبول" : score >= 55 ? "على الحدود" : "يحتاج تحسين"
    : score >= 75 ? "Shortlisted" : score >= 55 ? "Borderline" : "Needs work";
  const shareUrl = ar ? `${BASE}/score/${score}?lang=ar` : `${BASE}/score/${score}`;
  const shareText = ar
    ? `سيرتي حصلت ${score}/100 في فحص أنظمة التوظيف 👀 افحص سيرتك مجاناً:`
    : `My resume scored ${score}/100 on the ATS check 👀 Check yours free:`;

  return (
    <main
      dir={ar ? "rtl" : "ltr"}
      lang={ar ? "ar" : "en"}
      className="flex min-h-screen flex-col items-center justify-center px-6 py-12"
      style={{ background: "var(--bg)", color: "var(--fg)" }}
    >
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <div className="card w-full max-w-md p-8 text-center" style={{ borderColor: `${accent}55` }}>
        <div className="flex items-center justify-center gap-2.5">
          <OrbBrand size={26} />
          <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
        </div>
        <div className="mt-6 font-mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--faint)" }}>
          {ar ? "نسبة توافق سيرتي مع أنظمة التوظيف" : "ATS Resume Score"}
        </div>
        <div className="my-2 flex items-baseline justify-center gap-1" dir="ltr">
          <span className="font-mono text-7xl font-bold tabular-nums" style={{ color: accent }}>{score}</span>
          <span className="font-mono text-2xl" style={{ color: "var(--faint)" }}>/100</span>
        </div>
        <div className="mb-6 inline-block rounded-lg px-3 py-1 font-mono text-xs font-bold" style={{ background: `${accent}1a`, color: accent, border: `1px solid ${accent}40` }}>{label}</div>

        <ShareButtons url={shareUrl} text={shareText} ar={ar} />

        <Link href={ar ? "/ar/optimize" : "/optimize"} className="btn-accent mt-6 block w-full py-3">
          {ar ? "افحص سيرتي مجاناً ←" : "Check my own resume free →"}
        </Link>
        <p className="mt-3 font-mono text-xs" style={{ color: "var(--faint)" }}>
          {ar ? "مجاني · بدون تسجيل · خلال ثوانٍ" : "Free · No sign-up · seconds"}
        </p>
      </div>
    </main>
  );
}
