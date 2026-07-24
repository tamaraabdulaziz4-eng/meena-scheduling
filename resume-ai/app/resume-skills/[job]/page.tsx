import type { Metadata } from "next";
import OrbBrand from "../../components/OrbBrand";
import OrbSceneSetter from "../../components/orb/OrbSceneSetter";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JOBS, JOB_SLUGS, getJob } from "../../lib/jobs";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export function generateStaticParams() {
  return JOB_SLUGS.map((job) => ({ job }));
}

export async function generateMetadata({ params }: { params: Promise<{ job: string }> }): Promise<Metadata> {
  const { job } = await params;
  const j = getJob(job);
  if (!j) return { title: "Not found" };
  return {
    title: `Top ${j.title} Skills for Your Resume (2026) — ATS Keywords | Sira`,
    description: `The ${j.atsKeywords.length} keywords ATS software scans for in ${j.title} resumes, the skills recruiters shortlist for, and how to present them honestly.`,
    alternates: { canonical: `${BASE}/resume-skills/${j.slug}` },
  };
}

export default async function ResumeSkillsPage({ params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  const j = getJob(job);
  if (!j) notFound();

  const related = JOBS.filter((x) => x.category === j.category && x.slug !== j.slug).slice(0, 4);

  const faqs = [
    { q: `How many skills should a ${j.title} resume list?`, a: `8–14, grouped by category, front-loading what the specific posting asks for. A wall of 30 skills dilutes the signal — ATS ranking favors focused matches.` },
    { q: `Should I list skills I'm still learning?`, a: `Not in the skills section. If a posting requires something you're learning, mention it honestly in context ("currently completing X certification") — never present it as a working skill.` },
    { q: `Do soft skills belong on a ${j.title} resume?`, a: `Show them through achievements instead of listing them. "Coordinated a 4-person team to deliver X" proves teamwork better than the word "teamwork" ever will.` },
    { q: `How do I know which of these keywords a specific job wants?`, a: `Paste the posting into our free scanner — it extracts the exact terms that employer's system looks for and shows which ones your resume is missing.` },
  ];

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">Sira</span>
          </Link>
          <Link href="/optimize" className="btn-accent px-4 py-2 text-sm">Scan my resume</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-3xl px-6 py-12">
        <nav className="mb-6 font-mono text-xs" style={{ color: "var(--faint)" }}>
          <Link href="/">Home</Link> / <Link href="/resume-skills">Resume Skills</Link> / <span style={{ color: "var(--muted)" }}>{j.title}</span>
        </nav>

        <div className="chip mb-4">{j.category}</div>
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight">
          {j.title} skills <span className="accent-underline text-accent">for your resume</span>
        </h1>
        <p className="mt-4 text-lg leading-relaxed" style={{ color: "var(--muted)" }}>
          {j.demand} Typical range: {j.salary}. Below: the exact terms applicant tracking software scans for in {j.title} resumes, and the skills recruiters actually shortlist on.
        </p>

        {/* ATS keywords */}
        <section className="mt-10">
          <h2 className="mb-2 text-2xl font-bold">ATS keywords ({j.atsKeywords.length})</h2>
          <p className="mb-4 text-sm" style={{ color: "var(--muted)" }}>
            These are the terms hiring systems match against {j.title} postings. Include the ones that are genuinely true of you — in your skills section AND woven into experience bullets.
          </p>
          <div className="flex flex-wrap gap-2">
            {j.atsKeywords.map((k) => (
              <span key={k} className="rounded-full px-4 py-1.5 text-sm font-medium" style={{ background: "rgba(139,92,246,0.1)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.25)" }}>{k}</span>
            ))}
          </div>
        </section>

        {/* Core skills */}
        <section className="mt-10">
          <h2 className="mb-2 text-2xl font-bold">Core skills recruiters look for</h2>
          <ul className="mt-4 space-y-2">
            {j.skills.map((s) => (
              <li key={s} className="card flex items-center gap-3 px-5 py-3 text-sm">
                <span className="text-accent">✓</span> {s}
              </li>
            ))}
          </ul>
        </section>

        {/* How to present */}
        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-bold">How to present them (example)</h2>
          <p className="mb-3 text-sm" style={{ color: "var(--muted)" }}>
            A grouped skills section parses cleanly in ATS software. Then prove your top skills inside experience bullets — like this example of the level to aim for:
          </p>
          <div className="card whitespace-pre-wrap p-6 font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>
            {`SKILLS
${j.atsKeywords.slice(0, 4).join(" · ")}
${j.skills.slice(0, 3).join(" · ")}

EXPERIENCE (example bullet)
• ${j.bullets[0] ?? ""}`}
          </div>
          <p className="mt-3 text-xs" style={{ color: "var(--faint)" }}>
            Illustrative example — your bullets must use your own real numbers. Where you don&apos;t have one, our tool writes [add your real number] instead of inventing it.
          </p>
        </section>

        {/* Certs */}
        {j.certs.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-3 text-2xl font-bold">Certifications worth listing</h2>
            <div className="flex flex-wrap gap-2">
              {j.certs.map((c) => (
                <span key={c} className="rounded-lg px-4 py-2 text-sm" style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "rgba(244,245,243,0.8)" }}>{c}</span>
              ))}
            </div>
          </section>
        )}

        {/* Mistake */}
        <section className="card mt-10 p-6" style={{ borderColor: "rgba(248,113,113,0.3)" }}>
          <h2 className="font-bold" style={{ color: "#f87171" }}>⚠ Common {j.title} mistake</h2>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{j.mistake}</p>
        </section>

        {/* CTA */}
        <section className="card mt-10 p-8 text-center" style={{ borderColor: "rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.05)" }}>
          <h2 className="text-2xl font-bold">Which of these is YOUR resume missing?</h2>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
            Paste your resume + a real posting — see your match score and the exact missing keywords, free, in ~10 seconds.
          </p>
          <Link href="/optimize" className="btn-accent mt-5 inline-block px-8 py-3">Check my skills gap free →</Link>
        </section>

        {/* FAQ */}
        <section className="mt-12">
          <h2 className="mb-6 text-2xl font-bold">Frequently asked questions</h2>
          <div className="space-y-4">
            {faqs.map((f) => (
              <div key={f.q} className="card p-5">
                <h3 className="font-bold">{f.q}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Cross-links */}
        <section className="mt-12">
          <h2 className="mb-4 text-lg font-bold">Keep going</h2>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link href={`/resume-examples/${j.slug}`} className="btn-ghost px-4 py-2" style={{ color: "var(--fg)" }}>{j.title} resume example</Link>
            <Link href={`/cover-letter-examples/${j.slug}`} className="btn-ghost px-4 py-2" style={{ color: "var(--fg)" }}>{j.title} cover letter</Link>
            {related.map((r) => (
              <Link key={r.slug} href={`/resume-skills/${r.slug}`} className="btn-ghost px-4 py-2" style={{ color: "var(--muted)" }}>{r.title} skills</Link>
            ))}
          </div>
        </section>
      </div>

      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="text-center font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 Sira · a resume service by Rabit</p>
      </footer>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
          }),
        }}
      />
    </main>
  );
}
