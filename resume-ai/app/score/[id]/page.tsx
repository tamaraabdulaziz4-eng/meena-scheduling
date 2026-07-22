import type { Metadata } from "next";
import Link from "next/link";
import ShareButtons from "../../components/ShareButtons";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

// id encodes the score, e.g. "92" — keeps it stateless and instantly shareable.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const score = Math.max(0, Math.min(100, parseInt(id) || 0));
  const img = `${BASE}/api/og?score=${score}`;
  const title = `My resume scored ${score}/100 on ATS — check yours free`;
  return {
    title,
    description: "See your resume's ATS match score instantly and free — then get the exact keywords you're missing.",
    openGraph: { title, description: "Get your free ATS resume score in 60 seconds.", images: [{ url: img, width: 1200, height: 630 }], type: "website" },
    twitter: { card: "summary_large_image", title, images: [img] },
  };
}

export default async function ScorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const score = Math.max(0, Math.min(100, parseInt(id) || 0));
  const accent = score >= 75 ? "#4ade80" : score >= 55 ? "#fbbf24" : "#f87171";
  const label = score >= 75 ? "Shortlisted" : score >= 55 ? "Borderline" : "Needs work";
  const shareUrl = `${BASE}/score/${score}`;
  const shareText = `My resume scored ${score}/100 on the ATS check 👀 Check yours free:`;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <div className="card w-full max-w-md p-8 text-center" style={{ borderColor: `${accent}55` }}>
        <div className="flex items-center justify-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
          <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
        </div>
        <div className="mt-6 font-mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--faint)" }}>ATS Resume Score</div>
        <div className="my-2 flex items-baseline justify-center gap-1">
          <span className="font-mono text-7xl font-bold tabular-nums" style={{ color: accent }}>{score}</span>
          <span className="font-mono text-2xl" style={{ color: "var(--faint)" }}>/100</span>
        </div>
        <div className="mb-6 inline-block rounded-lg px-3 py-1 font-mono text-xs font-bold" style={{ background: `${accent}1a`, color: accent, border: `1px solid ${accent}40` }}>{label}</div>

        <ShareButtons url={shareUrl} text={shareText} />

        <Link href="/optimize" className="btn-accent mt-6 block w-full py-3">Check my own resume free →</Link>
        <p className="mt-3 font-mono text-xs" style={{ color: "var(--faint)" }}>Free · No sign-up · 60 seconds</p>
      </div>
    </main>
  );
}
