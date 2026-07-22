import Link from "next/link";

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
}

/**
 * Shared, SEO-friendly landing layout for keyword pages.
 * Each page passes unique copy so the pages don't read as duplicates.
 */
export default function SeoLanding({ eyebrow, h1, h1Accent, intro, bullets, faqs, ctaLine }: SeoLandingProps) {
  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
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
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "rgba(74,222,128,0.1)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.2)" }}>✓</div>
              <h2 className="font-bold">{b.title}</h2>
              <p className="mt-1.5 text-sm" style={{ color: "var(--muted)" }}>{b.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 py-16" style={{ background: "rgba(74,222,128,0.025)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
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
            <div className="flex h-6 w-6 items-center justify-center rounded font-mono text-xs font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
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
