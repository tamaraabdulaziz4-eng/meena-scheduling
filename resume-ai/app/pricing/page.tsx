import type { Metadata } from "next";
import OrbBrand from "../components/OrbBrand";
import OrbSceneSetter from "../components/orb/OrbSceneSetter";
import Link from "next/link";
import CheckoutButton from "../components/CheckoutButton";
import { PLANS } from "../lib/plans";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "Pricing — One-time, No Subscription | ResumeAI",
  description:
    "Simple one-time pricing: SAR 35 for 24-hour full access or SAR 99 for 90 days. Every feature is included in both — the only difference is how long access lasts. No subscription, 7-day money-back guarantee.",
  alternates: {
    canonical: `${BASE}/pricing`,
    languages: { en: `${BASE}/pricing`, ar: `${BASE}/pricing`, "x-default": `${BASE}/pricing` },
  },
  openGraph: { title: "ResumeAI Pricing — Pay once, no subscription", description: "SAR 35 (24h) or SAR 99 (90 days). Every feature in both.", url: `${BASE}/pricing` },
};

function PlanCard({ id, highlight }: { id: "single" | "complete"; highlight?: boolean }) {
  const p = PLANS[id];
  return (
    <div className="card p-8" style={highlight ? { borderColor: "rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.05)", position: "relative" } : undefined}>
      {highlight && (
        <div className="absolute right-5 top-5 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold tracking-wider" style={{ background: "var(--accent)", color: "#05130a" }}>BEST VALUE</div>
      )}
      <div className="font-mono text-xs uppercase tracking-widest" style={{ color: "var(--faint)" }}>{p.name} · one-time</div>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-5xl font-extrabold">SAR {p.priceSar}</span>
        <span className="text-sm" style={{ color: "var(--muted)" }}>once ({p.priceUsd})</span>
      </div>
      <p className="mt-2 text-sm font-semibold" style={{ color: "var(--accent)" }}>{p.accessLabel}</p>
      <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>{p.tagline}</p>
      <ul className="mt-6 space-y-3 text-sm">
        {p.features.map((f) => (
          <li key={f} className="flex items-center gap-3" style={{ color: "rgba(244,245,243,0.85)" }}>
            <span className="text-accent">✓</span> {f}
          </li>
        ))}
      </ul>
      <div className="mt-8">
        <CheckoutButton plan={id} label={id === "single" ? "Get 24-hour access" : "Get the Complete Pack →"} variant={highlight ? "accent" : "ghost"} />
      </div>
    </div>
  );
}

export default function PricingPage() {
  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/optimize" className="btn-accent px-4 py-2 text-sm">Free scan →</Link>
        </div>
      </nav>

      <section className="mx-auto max-w-3xl px-6 py-16">
        <div className="mb-12 text-center">
          <div className="chip mb-4">Pricing</div>
          <h1 className="text-4xl font-extrabold tracking-tight">Pay once. No subscription.</h1>
          <p className="mx-auto mt-3 max-w-xl" style={{ color: "var(--muted)" }}>
            Both plans include <strong>every feature</strong> — full resume rewrite, cover letter, LinkedIn, interview prep, and watermark-free downloads. The only difference is how long your access lasts.
          </p>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <PlanCard id="single" />
          <PlanCard id="complete" highlight />
        </div>
        <p className="mt-8 text-center font-mono text-xs" style={{ color: "var(--faint)" }}>
          Secure Paylink checkout · Instant access · 7-day money-back guarantee · No subscription, ever
        </p>

        <div className="mt-16">
          <h2 className="mb-6 text-2xl font-bold">Frequently asked</h2>
          <div className="space-y-4">
            {[
              ["Is the scan free?", "Yes — the ATS score, missing keywords, skills-gap, and a preview of improvements are free. The full rewrite and downloads unlock with a one-time payment."],
              ["Is this a subscription?", "No. Pay once. SAR 35 gives 24-hour full access; SAR 99 gives 90 days. Nothing recurs."],
              ["What's the difference between the two plans?", "Nothing in features — both unlock everything. SAR 99 simply keeps your access open for 90 days, ideal for an active job hunt."],
              ["Can I get a refund?", "Yes, there's a 7-day money-back guarantee."],
            ].map(([q, a]) => (
              <div key={q} className="card p-5">
                <h3 className="font-bold">{q}</h3>
                <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>{a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
