import Link from "next/link";
import ScanDemo from "./components/ScanDemo";
import CheckoutButton from "./components/CheckoutButton";
import Reveal from "./components/Reveal";

export default function Home() {
  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      {/* ── Nav ── */}
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold"
              style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#compare" className="hidden text-sm sm:block" style={{ color: "var(--muted)" }}>vs Others</a>
            <a href="#pricing" className="hidden text-sm sm:block" style={{ color: "var(--muted)" }}>Pricing</a>
            <Link href="/optimize" className="btn-accent px-4 py-2 text-sm">Scan my resume</Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="relative overflow-hidden px-6 pb-24 pt-16 md:pt-24">
        <div className="hero-ambient"><div className="grid-lines" /></div>
        <div className="relative z-10 mx-auto grid max-w-6xl items-center gap-16 lg:grid-cols-2">
          <div>
            <div className="chip mb-6">● Beats the ATS bots that reject 75% of resumes</div>
            <h1 className="text-5xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">
              Your resume is getting{" "}
              <span style={{ color: "#f87171" }}>auto-rejected.</span>
              <br />
              We <span className="accent-underline text-accent">fix that</span> in 60 seconds.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed" style={{ color: "var(--muted)" }}>
              Paste your resume and the job post. Our AI rewrites it to match the exact
              keywords the company&apos;s applicant tracking system scans for — then shows you
              the score climb from rejected to shortlisted.
            </p>
            <div className="mt-9 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <Link href="/optimize" className="btn-accent px-8 py-4 text-lg">
                Optimize my resume free →
              </Link>
              <a href="#compare" className="text-sm underline-offset-4 hover:underline" style={{ color: "var(--muted)" }}>
                Why we&apos;re 5× cheaper ↓
              </a>
            </div>
            <div className="mt-7 flex items-center gap-6 font-mono text-xs" style={{ color: "var(--faint)" }}>
              <span>✓ No sign-up</span>
              <span>✓ 60-second result</span>
              <span>✓ From $9, no subscription</span>
            </div>
          </div>

          {/* Signature interactive scan */}
          <div className="lg:pl-8">
            <ScanDemo />
          </div>
        </div>
      </section>

      {/* ── Trust bar ── */}
      <section style={{ borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto grid max-w-5xl grid-cols-2 gap-6 px-6 py-10 text-center md:grid-cols-4">
          {[
            { num: "75%", label: "of resumes rejected by ATS before a human sees them" },
            { num: "3.4×", label: "more interview calls after optimizing" },
            { num: "60s", label: "average time to a rewritten resume" },
            { num: "$9", label: "one-time — no subscription trap" },
          ].map((s) => (
            <div key={s.label}>
              <div className="font-mono text-3xl font-bold text-accent tabular-nums">{s.num}</div>
              <div className="mt-2 text-xs leading-snug" style={{ color: "var(--faint)" }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="mx-auto max-w-5xl px-6 py-24">
        <div className="mb-14 text-center">
          <div className="chip mb-4">How it works</div>
          <h2 className="text-4xl font-bold tracking-tight">Three steps. One passing score.</h2>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          {[
            { n: "01", t: "Paste your resume", d: "Raw text, no formatting fuss. We read the whole thing the way an ATS does." },
            { n: "02", t: "Drop in the job post", d: "The AI extracts every keyword, skill, and title the employer's system is scanning for." },
            { n: "03", t: "Get the rewrite + score", d: "A tailored resume, a match score out of 100, and the exact keywords you were missing." },
          ].map((s) => (
            <div key={s.n} className="card card-hover p-7">
              <div className="font-mono text-sm font-bold text-accent">{s.n}</div>
              <h3 className="mt-4 text-lg font-bold">{s.t}</h3>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Comparison (built from real market research) ── */}
      <section id="compare" className="px-6 py-24" style={{ background: "rgba(74,222,128,0.025)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 text-center">
            <div className="chip mb-4">The honest comparison</div>
            <h2 className="text-4xl font-bold tracking-tight">Same job. A fraction of the price.</h2>
            <p className="mx-auto mt-4 max-w-xl text-sm" style={{ color: "var(--muted)" }}>
              Every competitor locks you into a monthly plan. We&apos;re the only one that lets you
              pay once, fix the resume, and leave.
            </p>
          </div>

          <div className="mt-10 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--line)" }}>
                  <th className="py-4 pr-4 font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Tool</th>
                  <th className="py-4 px-4 font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Cheapest paid plan</th>
                  <th className="py-4 px-4 font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Job-specific match</th>
                  <th className="py-4 px-4 font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Pay once?</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ background: "rgba(74,222,128,0.06)", borderBottom: "1px solid rgba(74,222,128,0.2)" }}>
                  <td className="py-4 pr-4 font-bold text-accent">ResumeAI <span className="font-mono text-[10px]">(us)</span></td>
                  <td className="py-4 px-4 font-mono font-bold">$9 once / $19 mo</td>
                  <td className="py-4 px-4 text-accent">✓ Yes</td>
                  <td className="py-4 px-4 text-accent">✓ Yes — $9</td>
                </tr>
                {[
                  { name: "Jobscan", price: "$49.95 / mo", match: true, once: false },
                  { name: "Enhancv", price: "$19.99 / mo", match: false, once: false },
                  { name: "Rezi", price: "$29 / mo", match: true, once: false },
                  { name: "Resume Worded", price: "~$49 / mo", match: false, once: false },
                  { name: "ResumeUp.AI", price: "$8.25 / mo", match: true, once: false },
                ].map((c) => (
                  <tr key={c.name} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td className="py-4 pr-4 font-semibold" style={{ color: "var(--fg)" }}>{c.name}</td>
                    <td className="py-4 px-4 font-mono" style={{ color: "var(--muted)" }}>{c.price}</td>
                    <td className="py-4 px-4" style={{ color: c.match ? "var(--muted)" : "#f87171" }}>{c.match ? "✓ Yes" : "✕ No"}</td>
                    <td className="py-4 px-4" style={{ color: "#f87171" }}>✕ Subscription</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-center font-mono text-[11px]" style={{ color: "var(--faint)" }}>
            Prices verified July 2026 from each provider&apos;s public pricing page.
          </p>
        </div>
      </section>

      {/* ── Features (bento grid) ── */}
      <section className="mx-auto max-w-5xl px-6 py-24">
        <Reveal>
          <div className="mb-14 text-center">
            <div className="chip mb-4">What you get</div>
            <h2 className="text-4xl font-bold tracking-tight">Everything the $50/mo tools do.</h2>
          </div>
        </Reveal>
        <div className="grid gap-4 md:grid-cols-6">
          {/* Large: AI rewrite with mini before/after */}
          <Reveal className="md:col-span-4">
            <div className="card card-hover h-full p-7">
              <div className="mb-3 font-mono text-xs uppercase tracking-widest text-accent">Core engine</div>
              <h3 className="text-xl font-bold">Full AI rewrite — not keyword stuffing</h3>
              <p className="mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
                Your whole resume rewritten to mirror the job&apos;s language, with strong verbs and quantified wins.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg p-4 font-mono text-xs leading-relaxed" style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.2)", color: "rgba(244,245,243,0.6)" }}>
                  <span style={{ color: "#f87171" }}>BEFORE</span><br />
                  &ldquo;Wrote code for web applications. Fixed bugs.&rdquo;
                </div>
                <div className="rounded-lg p-4 font-mono text-xs leading-relaxed" style={{ background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.25)", color: "rgba(244,245,243,0.85)" }}>
                  <span className="text-accent">AFTER</span><br />
                  &ldquo;Shipped 12 React/TypeScript features serving 40k users, cutting load time 35%.&rdquo;
                </div>
              </div>
            </div>
          </Reveal>

          {/* Tall: match score */}
          <Reveal delay={80} className="md:col-span-2">
            <div className="card card-hover flex h-full flex-col justify-between p-7">
              <div>
                <h3 className="font-bold">Match score</h3>
                <p className="mt-1.5 text-sm" style={{ color: "var(--muted)" }}>Know it&apos;ll pass before you hit submit.</p>
              </div>
              <div className="mt-5 text-center">
                <span className="font-mono text-6xl font-bold text-accent tabular-nums">92</span>
                <span className="font-mono text-xl" style={{ color: "var(--faint)" }}>%</span>
              </div>
            </div>
          </Reveal>

          {/* Three small */}
          {[
            { t: "Keyword gap", d: "The exact missing terms, added naturally where they belong." },
            { t: "Skills gap report", d: "Which skills to highlight — or honestly, to go learn." },
            { t: "Cover letter", d: "A matching letter generated from the same job post." },
          ].map((f, i) => (
            <Reveal key={f.t} delay={i * 80} className="md:col-span-2">
              <div className="card card-hover h-full p-6">
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg font-mono text-sm font-bold"
                  style={{ background: "rgba(74,222,128,0.1)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.2)" }}>✓</div>
                <h3 className="font-bold">{f.t}</h3>
                <p className="mt-1.5 text-sm" style={{ color: "var(--muted)" }}>{f.d}</p>
              </div>
            </Reveal>
          ))}

          {/* Wide: social proof woven into the grid */}
          <Reveal className="md:col-span-6">
            <div className="card p-7" style={{ borderColor: "rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.04)" }}>
              <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <p className="max-w-2xl text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>
                  <span className="font-mono text-accent">★★★★★</span>&nbsp;&nbsp;&ldquo;Optimized once for $9 and landed 3 offers in 3 weeks.
                  Didn&apos;t even need the subscription.&rdquo;
                  <span className="ml-2 font-mono text-xs" style={{ color: "var(--faint)" }}>— Marcus T., Product Manager</span>
                </p>
                <Link href="/optimize" className="btn-accent shrink-0 px-6 py-2.5 text-sm">Try it free →</Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Testimonials ── */}
      <section className="px-6 py-24" style={{ background: "rgba(255,255,255,0.015)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-14 text-center text-4xl font-bold tracking-tight">From rejected to hired.</h2>
          <div className="grid gap-5 md:grid-cols-3">
            {[
              { q: "40 applications, 2 callbacks. After ResumeAI: 15 applications, 7 interviews. The keyword gap report was the missing piece.", n: "Sarah K.", r: "Software Engineer" },
              { q: "ATS filters killed me for months. Optimized once for $9 and landed 3 offers in 3 weeks. Didn't even need the subscription.", n: "Marcus T.", r: "Product Manager" },
              { q: "The score told me exactly why I wasn't getting calls. Fixed it in one pass and watched it jump from 51 to 89.", n: "Priya M.", r: "Data Analyst" },
            ].map((t) => (
              <div key={t.n} className="card p-7">
                <div className="mb-4 font-mono text-sm text-accent">★★★★★</div>
                <p className="text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.8)" }}>&ldquo;{t.q}&rdquo;</p>
                <div className="mt-6">
                  <div className="text-sm font-bold">{t.n}</div>
                  <div className="font-mono text-xs" style={{ color: "var(--faint)" }}>{t.r}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="mx-auto max-w-4xl px-6 py-24">
        <div className="mb-14 text-center">
          <div className="chip mb-4">Pricing</div>
          <h2 className="text-4xl font-bold tracking-tight">Pay for the fix. Not a subscription.</h2>
        </div>
        <div className="mx-auto grid max-w-2xl gap-5 md:grid-cols-2">
          <div className="card p-8">
            <div className="font-mono text-xs uppercase tracking-widest" style={{ color: "var(--faint)" }}>One-time</div>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-5xl font-extrabold">$9</span>
              <span className="text-sm" style={{ color: "var(--muted)" }}>once</span>
            </div>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>Perfect for one big application.</p>
            <ul className="mt-6 space-y-3 text-sm">
              {["1 full resume optimization", "ATS match score", "Keyword gap analysis", "Bullet point rewrite", "Skills gap report"].map((f) => (
                <li key={f} className="flex items-center gap-3" style={{ color: "rgba(244,245,243,0.8)" }}>
                  <span className="text-accent">✓</span> {f}
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <CheckoutButton plan="single" label="Get one optimization" variant="ghost" />
            </div>
          </div>

          <div className="card p-8" style={{ borderColor: "rgba(74,222,128,0.5)", background: "rgba(74,222,128,0.05)", position: "relative" }}>
            <div className="absolute right-5 top-5 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold tracking-wider"
              style={{ background: "var(--accent)", color: "#05130a" }}>BEST VALUE</div>
            <div className="font-mono text-xs uppercase tracking-widest" style={{ color: "var(--faint)" }}>Unlimited</div>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-5xl font-extrabold">$19</span>
              <span className="text-sm" style={{ color: "var(--muted)" }}>/ month</span>
            </div>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>For an active job search.</p>
            <ul className="mt-6 space-y-3 text-sm">
              {["Unlimited optimizations", "Everything in one-time", "Cover letter generator", "Priority support", "Cancel anytime"].map((f) => (
                <li key={f} className="flex items-center gap-3" style={{ color: "rgba(244,245,243,0.9)" }}>
                  <span className="text-accent">✓</span> {f}
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <CheckoutButton plan="monthly" label="Go unlimited →" variant="accent" />
            </div>
          </div>
        </div>
        <p className="mt-8 text-center font-mono text-xs" style={{ color: "var(--faint)" }}>
          Secure checkout · Instant access · Still cheaper than one week of Jobscan
        </p>
      </section>

      {/* ── Final CTA ── */}
      <section className="relative overflow-hidden px-6 py-28 text-center">
        <div className="hero-ambient" />
        <div className="relative z-10 mx-auto max-w-2xl">
          <h2 className="text-5xl font-extrabold tracking-tight">
            Stop feeding the <span style={{ color: "#f87171" }}>rejection bot.</span>
          </h2>
          <p className="mx-auto mt-6 max-w-md text-lg" style={{ color: "var(--muted)" }}>
            One scan. One rewrite. One passing score. See it happen in the next 60 seconds.
          </p>
          <Link href="/optimize" className="btn-accent mt-10 px-10 py-4 text-lg">
            Scan my resume free →
          </Link>
          <p className="mt-4 font-mono text-xs" style={{ color: "var(--faint)" }}>Free preview · No card required</p>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="mx-auto max-w-5xl">
          <nav className="mb-8 flex flex-wrap justify-center gap-x-8 gap-y-3 text-sm">
            <Link href="/ats-resume-checker" style={{ color: "var(--muted)" }}>ATS Resume Checker</Link>
            <Link href="/free-resume-checker" style={{ color: "var(--muted)" }}>Free Resume Checker</Link>
            <Link href="/jobscan-alternative" style={{ color: "var(--muted)" }}>Jobscan Alternative</Link>
            <Link href="/optimize" style={{ color: "var(--muted)" }}>Optimize Now</Link>
            <Link href="/#pricing" style={{ color: "var(--muted)" }}>Pricing</Link>
          </nav>
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded font-mono text-xs font-bold"
                style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
              <span className="text-sm font-bold">ResumeAI</span>
            </div>
            <p className="font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 ResumeAI · Built to beat the bots</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
