import type { Metadata } from "next";
import OrbBrand from "../components/OrbBrand";
import OrbSceneSetter from "../components/orb/OrbSceneSetter";
import Link from "next/link";
import { JOBS, CATEGORIES } from "../lib/jobs";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "Resume Skills by Job (2026) — ATS Keywords for 50 Roles | ResumeAI",
  description: "The exact skills and ATS keywords to put on your resume, role by role — plus a free scanner that shows which ones your resume is missing.",
  alternates: { canonical: `${BASE}/resume-skills` },
};

export default function ResumeSkillsHub() {
  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/optimize" className="btn-accent px-4 py-2 text-sm">Scan my resume</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-14">
        <div className="text-center">
          <div className="chip mb-4">● Resume skills</div>
          <h1 className="text-4xl font-extrabold tracking-tight">The right skills <span className="accent-underline text-accent">for every resume</span></h1>
          <p className="mx-auto mt-4 max-w-2xl" style={{ color: "var(--muted)" }}>
            Role-by-role: the ATS keywords hiring systems scan for, the skills recruiters shortlist on, and how to present them honestly.
          </p>
        </div>

        {CATEGORIES.map((cat) => (
          <section key={cat} className="mt-12">
            <h2 className="mb-4 text-xl font-bold">{cat}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {JOBS.filter((j) => j.category === cat).map((j) => (
                <Link key={j.slug} href={`/resume-skills/${j.slug}`} className="card card-hover p-4 text-sm font-semibold">
                  {j.title} skills →
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="text-center font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 ResumeAI · a resume service by Rabit</p>
      </footer>
    </main>
  );
}
