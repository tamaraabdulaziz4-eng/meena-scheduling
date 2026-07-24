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
    title: `${j.title} Cover Letter Example & Template (2026) | Sira`,
    description: `A proven ${j.title} cover letter structure with a fill-in template, the keywords hiring systems look for, and the mistakes to avoid — plus an AI generator.`,
    alternates: { canonical: `${BASE}/cover-letter-examples/${j.slug}` },
  };
}

export default async function CoverLetterExamplePage({ params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  const j = getJob(job);
  if (!j) notFound();

  const related = JOBS.filter((x) => x.category === j.category && x.slug !== j.slug).slice(0, 4);
  const topSkills = j.skills.slice(0, 3);
  const topKeywords = j.atsKeywords.slice(0, 6);

  const template = `Dear Hiring Manager,

When I saw your opening for a ${j.title}, I recognized a role where my background in ${topSkills[0]?.toLowerCase() ?? "this field"} could contribute from day one. [One sentence on why THIS company specifically — reference a product, project, or value of theirs.]

In my current role, ${j.bullets[0]?.charAt(0).toLowerCase()}${j.bullets[0]?.slice(1) ?? "[your strongest, most quantified achievement]"}. I've also [second achievement — use a real number of yours, e.g. "${j.bullets[1] ?? "..."}"].

Your posting emphasizes ${topKeywords.slice(0, 3).join(", ")} — areas I work in daily. [One sentence connecting a specific requirement from the posting to a specific experience of yours.]

I'd welcome the chance to discuss how I can help your team [the goal implied by the posting]. Thank you for your consideration.

Sincerely,
[Your name]`;

  const faqs = [
    { q: `How long should a ${j.title} cover letter be?`, a: `3–4 short paragraphs, under 300 words. Hiring managers skim — one strong, quantified achievement beats three vague ones.` },
    { q: `Should I repeat my resume in the cover letter?`, a: `No. Pick your 1–2 most relevant achievements and connect them to the specific posting. The letter answers "why this role, why this company, why you" — not "what is everything I've done".` },
    { q: `Which keywords matter for a ${j.title} letter?`, a: `Mirror the posting's own language. For ${j.title} roles that typically includes: ${topKeywords.join(", ")}. Use them naturally where they're true of you.` },
    { q: `Can I generate a tailored cover letter automatically?`, a: `Yes — our AI writes one from your resume and the exact job posting, using only facts you provided. It's included with any paid pass.` },
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
          <Link href="/">Home</Link> / <Link href="/cover-letter-examples">Cover Letter Examples</Link> / <span style={{ color: "var(--muted)" }}>{j.title}</span>
        </nav>

        <div className="chip mb-4">● {j.category}</div>
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight">
          {j.title} Cover Letter <span className="accent-underline text-accent">Example &amp; Template</span>
        </h1>
        <p className="mt-4 text-lg leading-relaxed" style={{ color: "var(--muted)" }}>
          {j.demand} A strong cover letter pairs one or two quantified wins with the posting&apos;s own language — here&apos;s the structure that works for {j.title} applications, with a template you can fill in honestly.
        </p>

        {/* Structure */}
        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-bold">The 4-paragraph structure</h2>
          <div className="space-y-3">
            {[
              { n: "1", t: "The hook", d: `Name the role and one specific reason you fit — for ${j.title} roles, lead with your strongest area (e.g. ${topSkills[0]?.toLowerCase()}).` },
              { n: "2", t: "Proof", d: "Your 1–2 most relevant, quantified achievements. Real numbers only — if you don't have one, describe the concrete outcome instead." },
              { n: "3", t: "The match", d: `Connect the posting's requirements (${topKeywords.slice(0, 3).join(", ")}…) to your actual experience — this is where ATS keyword alignment happens naturally.` },
              { n: "4", t: "The close", d: "One confident sentence asking for the conversation. No begging, no clichés." },
            ].map((s) => (
              <div key={s.n} className="card flex gap-4 p-5">
                <span className="font-mono text-lg font-bold text-accent">{s.n}</span>
                <div>
                  <h3 className="font-bold">{s.t}</h3>
                  <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>{s.d}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Template */}
        <section className="mt-12">
          <h2 className="mb-2 text-2xl font-bold">Fill-in template</h2>
          <p className="mb-4 text-sm" style={{ color: "var(--muted)" }}>
            The <span style={{ color: "#fbbf24" }}>[brackets]</span> are yours to fill with real facts — the example achievements shown are illustrations of the level of specificity to aim for, not claims to copy.
          </p>
          <div className="card whitespace-pre-wrap p-6 font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>
            {template}
          </div>
        </section>

        {/* Mistake */}
        <section className="card mt-10 p-6" style={{ borderColor: "rgba(248,113,113,0.3)" }}>
          <h2 className="font-bold" style={{ color: "#f87171" }}>⚠ The most common {j.title} mistake</h2>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{j.mistake}</p>
        </section>

        {/* CTA */}
        <section className="card mt-10 p-8 text-center" style={{ borderColor: "rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.05)" }}>
          <h2 className="text-2xl font-bold">Generate yours from the actual job posting</h2>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
            Paste your resume + the posting — the AI writes a tailored letter using only facts you provided. Free ATS scan included.
          </p>
          <Link href="/optimize" className="btn-accent mt-5 inline-block px-8 py-3">Start with a free scan →</Link>
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
            <Link href={`/resume-skills/${j.slug}`} className="btn-ghost px-4 py-2" style={{ color: "var(--fg)" }}>{j.title} skills for your resume</Link>
            {related.map((r) => (
              <Link key={r.slug} href={`/cover-letter-examples/${r.slug}`} className="btn-ghost px-4 py-2" style={{ color: "var(--muted)" }}>{r.title} cover letter</Link>
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
