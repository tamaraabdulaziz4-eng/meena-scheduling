import type { Metadata } from "next";
import SeoLanding from "../components/SeoLanding";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://resume-ai-kappa-flax.vercel.app";

export const metadata: Metadata = {
  title: "The Best Jobscan Alternative (2026) — Same ATS Scan, From $9",
  description:
    "Looking for a cheaper Jobscan alternative? Get the same ATS match score and keyword analysis plus a full AI rewrite — from $9 one-time, no $49.95/mo subscription.",
  keywords: "Jobscan alternative, cheaper than Jobscan, Jobscan vs, ATS resume tool, resume optimizer alternative",
  alternates: { canonical: `${BASE}/jobscan-alternative` },
  openGraph: { title: "The Best Jobscan Alternative (2026)", description: "Same ATS scan and keyword match, plus a full rewrite — from $9, no subscription.", type: "website" },
};

export default function Page() {
  return (
    <SeoLanding
      eyebrow="Jobscan alternative"
      h1="Everything Jobscan does —"
      h1Accent="without the $49.95/month"
      intro="Jobscan pioneered ATS resume scanning, but at $49.95/month it's the priciest tool on the market. ResumeAI gives you the same job-specific match score and keyword analysis — plus a complete AI rewrite Jobscan doesn't include — starting at just $9 once, with no subscription."
      bullets={[
        { title: "Same ATS match score", body: "Paste your resume and the job post and get an instant 0–100 match score and keyword gap analysis — the core of what you pay Jobscan for." },
        { title: "A full rewrite, included", body: "Jobscan tells you what's wrong; we fix it. Every scan includes a rewritten, keyword-optimized resume ready to submit." },
        { title: "Pay once, not every month", body: "$9 for a single optimization or $19/month for unlimited — versus Jobscan's $49.95/month. No subscription trap for a one-week job hunt." },
        { title: "Cover letters too", body: "Generate a matching cover letter from the same job description — no extra tool, no extra fee on the unlimited plan." },
      ]}
      faqs={[
        { q: "Is ResumeAI really cheaper than Jobscan?", a: "Yes. Jobscan's cheapest paid plan is $49.95/month. ResumeAI is $9 one-time or $19/month for unlimited — and includes a full resume rewrite that Jobscan charges more for." },
        { q: "Does it do the same ATS keyword matching?", a: "Yes — you get a job-specific match score, the keywords present in your resume, and the keywords you're missing, just like Jobscan's core scan." },
        { q: "What does ResumeAI do that Jobscan doesn't?", a: "It rewrites your entire resume automatically — injecting missing keywords, strengthening bullet points, and fixing ATS-unfriendly formatting — and it generates matching cover letters." },
        { q: "Do I need a subscription?", a: "No. You can pay $9 one time for a single optimization. The $19/month unlimited plan is optional for active job seekers applying to many roles." },
      ]}
      ctaLine="Try the cheaper Jobscan alternative free"
    />
  );
}
