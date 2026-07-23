import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicResume } from "../../lib/publicresume";
import AiOrb from "../../components/AiOrb";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const r = await getPublicResume(slug);
  if (!r) return { title: "Resume not found" };
  const title = `${r.name || "Resume"}${r.role ? " — " + r.role : ""}`;
  return {
    title,
    description: `${r.name}'s professional resume${r.role ? " for " + r.role : ""}.`,
    // Shareable by link, but keep personal resumes (PII) out of search indexes.
    robots: { index: false, follow: true },
    openGraph: { title, description: `View ${r.name}'s resume.`, type: "profile" },
  };
}

export default async function PublicResumePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const r = await getPublicResume(slug);
  if (!r) notFound();

  // The public "showing" world is GLASS (light): a clean frosted frame on a
  // soft gradient. dir="auto" lets an Arabic resume render RTL (documented fix).
  const ar = /[؀-ۿ]/.test((r.text || "").slice(0, 400));
  return (
    <main className="min-h-screen" style={{ background: "radial-gradient(1200px 600px at 50% -10%, #e9ecf5, var(--glass-bg))", color: "var(--glass-text)" }}>
      <div className="mx-auto max-w-3xl px-5 py-12">
        {/* The resume inside a light glass frame */}
        <div className="glass-surface p-8" style={{ background: "rgba(255,255,255,0.9)" }}>
          <div dir="auto" className="whitespace-pre-wrap font-mono text-sm leading-relaxed" style={{ color: "#1f2937" }}>{r.text}</div>
        </div>

        {/* Viral footer — orb + "make your own" (free growth channel on every share) */}
        <div className="mt-7 flex flex-col items-center gap-4 text-center">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--glass-muted)" }}>
            <AiOrb size={22} />
            {ar ? "سُوِّيت بـ cv.rabit.sa" : "Built with cv.rabit.sa"}
          </Link>
          <Link href={ar ? "/ar" : "/"} className="rounded-full px-7 py-3 text-sm font-bold text-white" style={{ background: "#16a34a", boxShadow: "0 6px 24px rgba(22,163,74,0.3)" }}>
            {ar ? "سوّ سيرتك مثلها — مجاناً ↗" : "Make your own like this — free ↗"}
          </Link>
        </div>
      </div>
    </main>
  );
}
