import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicResume } from "../../lib/publicresume";

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

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <div className="mx-auto max-w-3xl px-6 py-12">
        {/* The resume, rendered clean */}
        <div className="card p-8">
          <div className="whitespace-pre-wrap font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.9)" }}>{r.text}</div>
        </div>

        {/* Subtle attribution — the free backlink / brand impression on every share */}
        <div className="mt-6 flex flex-col items-center gap-3 text-center">
          <Link href="/" className="flex items-center gap-2 text-sm" style={{ color: "var(--muted)" }}>
            <span className="flex h-5 w-5 items-center justify-center rounded font-mono text-[10px] font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</span>
            Built with ResumeAI
          </Link>
          <Link href="/optimize" className="btn-accent px-6 py-2.5 text-sm">Make my own resume free →</Link>
        </div>
      </div>
    </main>
  );
}
