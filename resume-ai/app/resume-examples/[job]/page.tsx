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
  if (!j) return {};
  return {
    title: `${j.title} Resume Example & ATS Keywords (2026)`,
    description: `Free ${j.title} resume example plus the exact ATS keywords and skills recruiters scan for. Build or optimize your ${j.title} resume in 60 seconds.`,
    keywords: `${j.title} resume example, resume for ${j.title}, ${j.title} resume skills, resume keywords for ${j.title}, ${j.title} CV example`,
    alternates: { canonical: `${BASE}/resume-examples/${j.slug}` },
    openGraph: { title: `${j.title} Resume Example & Skills (2026)`, description: `The ATS keywords, skills, and a full example for a ${j.title} resume.`, type: "article" },
  };
}

export default async function Page({ params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  const j = getJob(job);
  if (!j) notFound();

  const siblings = JOBS.filter((x) => x.category === j.category && x.slug !== j.slug).slice(0, 6);
  const others = JOBS.filter((x) => x.category !== j.category).slice(0, 4);

  const faqs = [
    { q: `What skills should a ${j.title} put on a resume?`, a: `The most important ${j.title} resume skills are: ${j.skills.slice(0, 6).join(", ")}. Match these to the exact wording in the job posting so the ATS scores your resume higher.` },
    { q: `What ATS keywords do ${j.title} resumes need?`, a: `Applicant tracking systems scan ${j.title} resumes for terms like ${j.atsKeywords.slice(0, 6).join(", ")}. Include the ones you genuinely have, using the exact phrasing from the job description.` },
    { q: `How long should a ${j.title} resume be?`, a: `One page for under 10 years of experience, two pages maximum for senior ${j.title} roles. Keep it single-column and ATS-safe — no tables or graphics.` },
    { q: `How do I make my ${j.title} resume pass the ATS?`, a: `Use standard headings, mirror the job title, include the ${j.title} keywords above, and quantify your bullets. Or paste it into our free scanner to see your match score instantly.` },
  ];

  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: BASE },
        { "@type": "ListItem", position: 2, name: "Resume Examples", item: `${BASE}/resume-examples` },
        { "@type": "ListItem", position: 3, name: j.title, item: `${BASE}/resume-examples/${j.slug}` },
      ]},
      { "@type": "FAQPage", mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) },
    ],
  };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="mt-10">
      <h2 className="mb-4 text-2xl font-bold tracking-tight">{title}</h2>
      {children}
    </section>
  );

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">Sira</span>
          </Link>
          <Link href="/optimize" className="btn-accent px-4 py-2 text-sm">Scan my resume</Link>
        </div>
      </nav>

      <article className="mx-auto max-w-3xl px-6 py-10">
        {/* Breadcrumb */}
        <div className="mb-6 font-mono text-xs" style={{ color: "var(--faint)" }}>
          <Link href="/" style={{ color: "var(--faint)" }}>Home</Link> ›{" "}
          <Link href="/resume-examples" style={{ color: "var(--faint)" }}>Resume Examples</Link> › {j.title}
        </div>

        <div className="chip mb-4">● {j.category} · ATS-optimized</div>
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight">{j.title} Resume Example &amp; ATS Keywords (2026)</h1>
        <p className="mt-4 text-lg leading-relaxed" style={{ color: "var(--muted)" }}>
          {j.demand} Typical salary: {j.salary}. Below is a complete {j.title} resume example plus the exact keywords applicant tracking systems (ATS) scan for — then build yours free in 60 seconds.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/optimize" className="btn-accent px-6 py-3">Check my {j.title} resume free →</Link>
          <Link href="/build" className="btn-ghost px-6 py-3 font-semibold" style={{ color: "var(--fg)" }}>Build one from scratch</Link>
        </div>

        <Section title={`Professional summary example for a ${j.title}`}>
          <div className="card p-5 font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>{j.summary}</div>
        </Section>

        <Section title={`ATS keywords for a ${j.title} resume`}>
          <p className="mb-3 text-sm" style={{ color: "var(--muted)" }}>These are the exact terms an ATS scans for. Include the ones you genuinely have, worded like the job posting:</p>
          <div className="flex flex-wrap gap-2">
            {j.atsKeywords.map((k) => (
              <span key={k} className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(139,92,246,0.14)", color: "var(--accent)" }}>{k}</span>
            ))}
          </div>
        </Section>

        <Section title={`Top skills for a ${j.title}`}>
          <ul className="grid gap-2 sm:grid-cols-2">
            {j.skills.map((s) => (
              <li key={s} className="flex items-center gap-2 text-sm" style={{ color: "rgba(244,245,243,0.85)" }}><span className="text-accent">✓</span> {s}</li>
            ))}
          </ul>
        </Section>

        <Section title={`Work experience bullet examples`}>
          <ul className="space-y-3">
            {j.bullets.map((b) => (
              <li key={b} className="card p-4 text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>• {b}</li>
            ))}
          </ul>
        </Section>

        <Section title={`Certifications that strengthen a ${j.title} resume`}>
          <div className="flex flex-wrap gap-2">
            {j.certs.map((c) => (
              <span key={c} className="rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--muted)" }}>{c}</span>
            ))}
          </div>
        </Section>

        <Section title={`Common ${j.title} resume mistake`}>
          <div className="card p-5 text-sm leading-relaxed" style={{ borderColor: "rgba(248,113,113,0.3)", color: "rgba(244,245,243,0.85)" }}>
            <span style={{ color: "#f87171" }}>Avoid this:</span> {j.mistake}
          </div>
        </Section>

        {/* CTA */}
        <div className="card mt-10 p-7 text-center" style={{ borderColor: "rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.05)" }}>
          <h2 className="text-2xl font-bold">Is your {j.title} resume ATS-ready?</h2>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>Paste it and get an instant match score plus the missing keywords — free, no sign-up.</p>
          <Link href="/optimize" className="btn-accent mt-5 inline-block px-8 py-3">Scan my resume free →</Link>
        </div>

        <Section title="FAQ">
          <div className="space-y-4">
            {faqs.map((f) => (
              <div key={f.q} className="card p-5">
                <h3 className="font-bold">{f.q}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{f.a}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* Cross-links to this job's cover-letter + skills pages */}
        <Section title="For this role">
          <div className="flex flex-wrap gap-3">
            <Link href={`/cover-letter-examples/${j.slug}`} className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>{j.title} cover letter example →</Link>
            <Link href={`/resume-skills/${j.slug}`} className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>{j.title} skills &amp; ATS keywords →</Link>
          </div>
        </Section>

        {/* Internal linking — siblings + others */}
        <Section title={`More ${j.category} resume examples`}>
          <div className="flex flex-wrap gap-2">
            {siblings.map((s) => (
              <Link key={s.slug} href={`/resume-examples/${s.slug}`} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--muted)" }}>{s.title}</Link>
            ))}
            {others.map((s) => (
              <Link key={s.slug} href={`/resume-examples/${s.slug}`} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--muted)" }}>{s.title}</Link>
            ))}
          </div>
          <Link href="/resume-examples" className="mt-4 inline-block text-sm font-semibold text-accent">See all resume examples →</Link>
        </Section>
      </article>

      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="text-center font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 Sira · a resume service by Rabit</p>
      </footer>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
    </main>
  );
}
