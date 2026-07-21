import type { Metadata } from "next";
import SeoLanding from "../components/SeoLanding";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://resume-ai-kappa-flax.vercel.app";

export const metadata: Metadata = {
  title: "Free Resume Checker — Instant AI Score & Feedback",
  description:
    "Free AI resume checker. Get an instant score, keyword feedback, and improvement tips tailored to the job you want. No sign-up, results in under a minute.",
  keywords: "free resume checker, resume checker free, AI resume checker, resume review free, resume score checker",
  alternates: { canonical: `${BASE}/free-resume-checker` },
  openGraph: { title: "Free Resume Checker — Instant AI Score", description: "Get instant, job-specific resume feedback and a score in under a minute. Free.", type: "website" },
};

export default function Page() {
  return (
    <SeoLanding
      eyebrow="100% free first scan"
      h1="Get your resume checked by AI —"
      h1Accent="free, in under a minute"
      intro="Upload or paste your resume and the job you want, and our AI checks it instantly: a match score, the keywords you're missing, weak bullet points to fix, and a tailored rewrite. Your first check is free — no account, no card."
      bullets={[
        { title: "Instant score & feedback", body: "See a clear match score and specific, actionable feedback — not vague tips — tailored to the exact role you're targeting." },
        { title: "Upload PDF or Word", body: "No copy-pasting required. Drop in your existing PDF or Word resume and we'll read it automatically." },
        { title: "Real improvements", body: "Weak bullets rewritten with metrics and strong verbs, missing keywords added, formatting made ATS-safe." },
        { title: "Free to start", body: "Your first full check costs nothing. Upgrade only if you want unlimited checks and cover letters." },
      ]}
      faqs={[
        { q: "Is this resume checker actually free?", a: "Yes — your first complete resume check, including the score, keyword analysis, and rewrite, is free with no sign-up or credit card." },
        { q: "What file types can I upload?", a: "PDF, Word (.docx), and plain text. The tool extracts the text automatically so you don't have to copy and paste." },
        { q: "What does the checker analyze?", a: "It compares your resume to a specific job description and scores keyword match, skills coverage, and bullet-point strength, then rewrites your resume to improve all three." },
        { q: "What happens after my free check?", a: "You can keep going with a $9 one-time optimization or $19/month for unlimited checks plus cover letters. There's no obligation." },
      ]}
      ctaLine="Check your resume free right now"
    />
  );
}
