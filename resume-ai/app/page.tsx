import type { Metadata } from "next";
import Link from "next/link";
import ScanDemo from "./components/ScanDemo";
import CheckoutButton from "./components/CheckoutButton";
import Reveal from "./components/Reveal";
import Counter from "./components/Counter";
import NavAccountLink from "./components/NavAccountLink";
import MobileMenu from "./components/MobileMenu";
import LiveTicker from "./components/LiveTicker";
import SubscribeBox from "./components/SubscribeBox";
import AtsMarquee from "./components/AtsMarquee";
import LandingExperience from "./components/LandingExperience";
import { PLANS } from "./lib/plans";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  alternates: {
    canonical: `${BASE}/`,
    languages: { en: `${BASE}/`, ar: `${BASE}/ar`, "x-default": `${BASE}/` },
  },
};

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
            <Link href="/ar" className="text-sm font-semibold" style={{ color: "var(--accent)" }}>عربي</Link>
            <Link href="/build" className="hidden text-sm sm:block" style={{ color: "var(--muted)" }}>CV Builder</Link>
            <a href="#pricing" className="hidden text-sm sm:block" style={{ color: "var(--muted)" }}>Pricing</a>
            <NavAccountLink />
            <Link href="/optimize" className="hidden btn-accent px-4 py-2 text-sm sm:inline-block">Scan my resume</Link>
            <MobileMenu />
          </div>
        </div>
      </nav>

      {/* ── Cinematic landing experience ── */}
      <LandingExperience />

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
              <span className="text-5xl font-extrabold">SAR {PLANS.single.priceSar}</span>
              <span className="text-sm" style={{ color: "var(--muted)" }}>once ({PLANS.single.priceUsd})</span>
            </div>
            <p className="mt-2 text-sm font-semibold" style={{ color: "var(--accent)" }}>{PLANS.single.accessLabel}</p>
            <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>{PLANS.single.tagline}</p>
            <ul className="mt-6 space-y-3 text-sm">
              {PLANS.single.features.map((f) => (
                <li key={f} className="flex items-center gap-3" style={{ color: "rgba(244,245,243,0.8)" }}>
                  <span className="text-accent">✓</span> {f}
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <CheckoutButton plan="single" label="Get 24-hour access" variant="ghost" />
            </div>
          </div>

          <div className="card p-8" style={{ borderColor: "rgba(74,222,128,0.5)", background: "rgba(74,222,128,0.05)", position: "relative" }}>
            <div className="absolute right-5 top-5 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold tracking-wider"
              style={{ background: "var(--accent)", color: "#05130a" }}>BEST VALUE</div>
            <div className="font-mono text-xs uppercase tracking-widest" style={{ color: "var(--faint)" }}>Complete Pack · one-time</div>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-5xl font-extrabold">SAR {PLANS.complete.priceSar}</span>
              <span className="text-sm" style={{ color: "var(--muted)" }}>once ({PLANS.complete.priceUsd})</span>
            </div>
            <p className="mt-2 text-sm font-semibold" style={{ color: "var(--accent)" }}>{PLANS.complete.accessLabel}</p>
            <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>{PLANS.complete.tagline}</p>
            <ul className="mt-6 space-y-3 text-sm">
              <li className="flex items-center gap-3 font-semibold" style={{ color: "rgba(244,245,243,0.9)" }}>
                <span className="text-accent">✓</span> Same full access — for 90 days
              </li>
              {PLANS.complete.features.map((f) => (
                <li key={f} className="flex items-center gap-3" style={{ color: "rgba(244,245,243,0.9)" }}>
                  <span className="text-accent">✓</span> {f}
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <CheckoutButton plan="complete" label="Get the Complete Pack →" variant="accent" />
            </div>
          </div>
        </div>
        <p className="mt-8 text-center font-mono text-xs" style={{ color: "var(--faint)" }}>
          Secure checkout · Instant access · Still cheaper than one week of Jobscan · 7-day money-back guarantee
        </p>
        {/* Honest trust badges — verifiable facts only, no invented numbers. */}
        <div className="mx-auto mt-8 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { icon: "🔒", label: "Secure Paylink checkout" },
            { icon: "🛡️", label: "Not stored on our servers" },
            { icon: "↩️", label: "7-day money-back" },
            { icon: "🚫", label: "No subscription, ever" },
          ].map((b) => (
            <div key={b.label} className="card flex items-center gap-2 px-3 py-3 text-xs font-semibold" style={{ color: "var(--muted)" }}>
              <span style={{ fontSize: 16 }}>{b.icon}</span> {b.label}
            </div>
          ))}
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="relative overflow-hidden px-6 py-28 text-center">
        <div className="hero-ambient" />
        <div className="relative z-10 mx-auto max-w-2xl">
          <h2 className="text-5xl font-extrabold tracking-tight">
            Present your <span className="accent-underline text-accent">real experience</span> at its best.
          </h2>
          <p className="mx-auto mt-6 max-w-md text-lg" style={{ color: "var(--muted)" }}>
            One scan. One honest rewrite. A clearer, stronger resume in the next 10 seconds.
          </p>
          <Link href="/optimize" className="btn-accent mt-10 px-10 py-4 text-lg">
            Scan my resume free →
          </Link>
          <p className="mt-4 font-mono text-xs" style={{ color: "var(--faint)" }}>Free preview · No card required</p>
        </div>
      </section>

      {/* ── FAQ (with FAQPage JSON-LD for rich results) ── */}
      <section className="px-6 py-24" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="mx-auto max-w-3xl">
          <h2 className="mb-10 text-center text-3xl font-bold tracking-tight">Questions, answered</h2>
          <div className="space-y-4">
            {[
              { q: "Is it really free?", a: "Yes — your ATS score and full analysis (missing keywords, skills gap, weak lines) are free every time, no account and no card. Only the complete rewritten resume, cover letters, and PDF export are the paid unlock (SAR 35 once or SAR 99 one-time)." },
              { q: "Does the AI invent achievements to boost my score?", a: "Never. The engine is technically constrained from adding any number, employer, skill, or credential you didn't provide. Where a metric would help but you didn't give one, it writes [add your real number] for you to fill in." },
              { q: "Do you store my resume?", a: "No. Your resume is processed instantly to generate the result and is never stored on our servers. Drafts stay in your browser only. See our privacy policy." },
              { q: "Can I write in Arabic?", a: "Yes — write casually in Arabic and the AI produces a professional English CV (what Gulf employers and ATS systems require), while the analysis can stay in Arabic." },
              { q: "How is this different from Jobscan or Rezi?", a: "Same ATS scoring and keyword analysis, plus a full honest rewrite — starting at a one-time SAR 35 (~$9) instead of a $30–50/month subscription, and with a no-fabrication guarantee." },
            ].map((f) => (
              <div key={f.q} className="card p-6">
                <h3 className="font-bold">{f.q}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{f.a}</p>
              </div>
            ))}
          </div>
        </div>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
          "@context": "https://schema.org", "@type": "FAQPage",
          mainEntity: [
            { q: "Is it really free?", a: "Your ATS score and full analysis are free every time, no card. Only the rewritten resume, cover letters, and PDF export are paid (SAR 35 once or SAR 99 one-time)." },
            { q: "Does the AI invent achievements?", a: "Never — it's constrained from adding any number, employer, skill, or credential you didn't provide; missing metrics become [add your real number]." },
            { q: "Do you store my resume?", a: "No — it's processed instantly and never stored on our servers; drafts stay in your browser only." },
            { q: "Can I write in Arabic?", a: "Yes — write in Arabic and get a professional English CV, with the analysis in Arabic." },
            { q: "How is this different from Jobscan or Rezi?", a: "Same ATS scoring plus a full honest rewrite, from a one-time SAR 35 instead of a monthly subscription, with a no-fabrication guarantee." },
          ].map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
        }) }} />
      </section>

      <SubscribeBox />

      {/* ── Footer ── */}
      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="mx-auto max-w-5xl">
          <nav className="mb-8 flex flex-wrap justify-center gap-x-8 gap-y-3 text-sm">
            <Link href="/resume-examples" style={{ color: "var(--muted)" }}>Resume Examples</Link>
            <Link href="/resume-templates" style={{ color: "var(--muted)" }}>Resume Templates</Link>
            <Link href="/cover-letter-examples" style={{ color: "var(--muted)" }}>Cover Letter Examples</Link>
            <Link href="/resume-skills" style={{ color: "var(--muted)" }}>Resume Skills</Link>
            <Link href="/ats-resume-checker" style={{ color: "var(--muted)" }}>ATS Resume Checker</Link>
            <Link href="/free-resume-checker" style={{ color: "var(--muted)" }}>Free Resume Checker</Link>
            <Link href="/build" style={{ color: "var(--muted)" }}>CV Builder</Link>
            <Link href="/linkedin" style={{ color: "var(--muted)" }}>LinkedIn Optimizer</Link>
            <Link href="/interview" style={{ color: "var(--muted)" }}>Interview Prep</Link>
            <Link href="/jobscan-alternative" style={{ color: "var(--muted)" }}>Jobscan Alternative</Link>
            <Link href="/optimize" style={{ color: "var(--muted)" }}>Optimize Now</Link>
            <Link href="/#pricing" style={{ color: "var(--muted)" }}>Pricing</Link>
            <Link href="/privacy" style={{ color: "var(--muted)" }}>Privacy</Link>
            <Link href="/terms" style={{ color: "var(--muted)" }}>Terms &amp; Refunds</Link>
          </nav>
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded font-mono text-xs font-bold"
                style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
              <span className="text-sm font-bold">ResumeAI</span>
              <span className="font-mono text-xs" style={{ color: "var(--faint)" }}>— a resume service by Rabit</span>
            </div>
            <p className="font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 ResumeAI · cv.rabit.sa · <a href="mailto:alanziabdulaziz4@gmail.com" style={{ color: "var(--muted)" }}>Support</a></p>
          </div>
        </div>
      </footer>
    </main>
  );
}
