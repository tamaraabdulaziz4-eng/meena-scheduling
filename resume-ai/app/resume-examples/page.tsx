import type { Metadata } from "next";
import Link from "next/link";
import { JOBS, CATEGORIES } from "../lib/jobs";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://resume-ai-kappa-flax.vercel.app";

export const metadata: Metadata = {
  title: "Resume Examples & ATS Keywords by Job Title (2026) — Free",
  description: "Free resume examples for 50+ job titles, each with the exact ATS keywords, skills, and bullet examples recruiters scan for. Build or optimize yours in 60 seconds.",
  keywords: "resume examples, resume example by job, ATS resume examples, resume samples, cv examples",
  alternates: { canonical: `${BASE}/resume-examples` },
};

export default function Hub() {
  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/optimize" className="btn-accent px-4 py-2 text-sm">Scan my resume</Link>
        </div>
      </nav>

      <section className="relative overflow-hidden px-6 py-16 text-center">
        <div className="hero-ambient"><div className="grid-lines" /></div>
        <div className="relative z-10 mx-auto max-w-3xl">
          <div className="chip mb-4">● Free · ATS-optimized</div>
          <h1 className="text-4xl font-extrabold tracking-tight md:text-5xl">Resume examples &amp; ATS keywords by job</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg" style={{ color: "var(--muted)" }}>
            Pick your role for a complete resume example plus the exact keywords applicant tracking systems scan for — then build or check yours free.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-6 pb-16">
        {CATEGORIES.map((cat) => (
          <div key={cat} className="mb-10">
            <h2 className="mb-4 text-xl font-bold tracking-tight">{cat}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {JOBS.filter((j) => j.category === cat).map((j) => (
                <Link key={j.slug} href={`/resume-examples/${j.slug}`} className="card card-hover p-4">
                  <div className="font-bold">{j.title} Resume Example</div>
                  <div className="mt-1 text-xs" style={{ color: "var(--faint)" }}>ATS keywords · skills · bullet examples</div>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="text-center font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 ResumeAI · Built to beat the ATS</p>
      </footer>
    </main>
  );
}
