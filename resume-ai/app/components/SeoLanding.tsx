import Link from "next/link";
import OrbBrand from "./OrbBrand";
import OrbSceneSetter from "./orb/OrbSceneSetter";

export interface Faq {
  q: string;
  a: string;
}

export interface SeoLandingProps {
  eyebrow: string;
  h1: string;
  h1Accent: string;
  intro: string;
  bullets: { title: string; body: string }[];
  faqs: Faq[];
  ctaLine: string;
  /** Optional transparent scoring rubric — differentiates the page and shows how the score is computed. */
  methodology?: { label: string; weight: number; note: string }[];
}

/**
 * Shared, SEO-friendly landing layout for keyword pages.
 * Each page passes unique copy so the pages don't read as duplicates.
 */
export default function SeoLanding({ eyebrow, h1, h1Accent, intro, bullets, faqs, ctaLine, methodology }: SeoLandingProps) {
  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/optimize" className="btn-accent px-4 py-2 text-sm">Scan my resume</Link>
        </div>
      </nav>

      <section className="relative overflow-hidden px-6 pb-16 pt-16">
        <div className="hero-ambient"><div className="grid-lines" /></div>
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <div className="chip mb-6">{eyebrow}</div>
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight md:text-5xl">
            {h1} <span className="accent-underline text-accent">{h1Accent}</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed" style={{ color: "var(--muted)" }}>{intro}</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/optimize" className="btn-accent px-7 py-3.5 text-base">Check my resume free →</Link>
            <Link href="/#pricing" className="btn-ghost px-7 py-3.5 text-base" style={{ color: "var(--fg)" }}>See pricing</Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-16">
        <div className="grid gap-5 md:grid-cols-2">
          {bullets.map((b) => (
            <div key={b.title} className="card p-6">
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "rgba(139,92,246,0.1)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.2)" }}>✓</div>
              <h2 className="font-bold">{b.title}</h2>
              <p className="mt-1.5 text-sm" style={{ color: "var(--muted)" }}>{b.body}</p>
            </div>
          ))}
        </div>
      </section>

      {methodology && (
        <section className="px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <h2 className="mb-3 text-center text-3xl font-bold tracking-tight">How the score is calculated</h2>
            <p className="mx-auto mb-10 max-w-xl text-center text-sm" style={{ color: "var(--muted)" }}>
              No black box — this is the exact weighted rubric the AI is instructed to apply when a job description is provided.
            </p>
            <div className="card overflow-hidden">
              {methodology.map((m, i) => (
                <div key={m.label} className="flex items-center gap-4 px-6 py-4" style={{ borderTop: i > 0 ? "1px solid var(--line)" : "none" }}>
                  <span className="font-mono text-lg font-bold text-accent tabular-nums" style={{ minWidth: "3.2rem" }}>{m.weight}%</span>
                  <div>
                    <div className="text-sm font-bold">{m.label}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{m.note}</div>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-center font-mono text-[11px]" style={{ color: "var(--faint)" }}>
              Different employers use different ATS software — the score measures alignment and clarity, not a guaranteed outcome.
            </p>
          </div>
        </section>
      )}

      <section className="px-6 py-16" style={{ background: "rgba(139,92,246,0.025)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto max-w-3xl">
          <h2 className="mb-10 text-center text-3xl font-bold tracking-tight">Frequently asked questions</h2>
          <div className="space-y-4">
            {faqs.map((f) => (
              <div key={f.q} className="card p-6">
                <h3 className="font-bold">{f.q}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{f.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden px-6 py-24 text-center">
        <div className="hero-ambient" />
        <div className="relative z-10 mx-auto max-w-2xl">
          <h2 className="text-4xl font-extrabold tracking-tight">{ctaLine}</h2>
          <Link href="/optimize" className="btn-accent mt-8 inline-block px-10 py-4 text-lg">Scan my resume free →</Link>
          <p className="mt-4 font-mono text-xs" style={{ color: "var(--faint)" }}>Free scan · No card required</p>
        </div>
      </section>

      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2">
            <OrbBrand size={20} />
            <span className="text-sm font-bold">ResumeAI</span>
          </div>
          <p className="font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 ResumeAI · a resume service by Rabit</p>
        </div>
      </footer>

      {/* FAQ structured data for rich results */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faqs.map((f) => ({
              "@type": "Question",
              name: f.q,
              acceptedAnswer: { "@type": "Answer", text: f.a },
            })),
          }),
        }}
      />
    </main>
  );
}
