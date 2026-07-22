import type { Metadata } from "next";
import SeoLanding from "../components/SeoLanding";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

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
      eyebrow="Free check — always"
      h1="Get your resume checked by AI —"
      h1Accent="free, in under a minute"
      intro="Upload or paste your resume — with or without a target job — and our AI checks it instantly: a match score with the reasons behind it, the keywords you're missing, your skills gap, and the weak lines to fix. The check and full analysis are free, every time, no account and no card. Only the complete rewritten resume is a paid unlock — and we tell you that upfront."
      bullets={[
        { title: "What's free (always)", body: "The 0–100 score and why, missing vs present keywords, skills-gap report, and the specific weak points to fix. Unlimited checks, no card." },
        { title: "What's paid (and why)", body: "The complete rewritten resume, PDF export, and cover letter — SAR 35 (~$9) once or SAR 75/month. The analysis tells you exactly what you'd be paying for first." },
        { title: "Upload PDF or Word", body: "No copy-pasting required. Drop in your existing PDF or Word resume and we'll read it automatically — and never store it on our servers." },
        { title: "No invented facts", body: "The rewrite never adds a number, skill, or credential you didn't provide. Missing metrics are marked [add your real number] for you to fill in." },
      ]}
      faqs={[
        { q: "Is this resume checker actually free?", a: "Yes — the score, keyword analysis, skills gap, and improvement list are free every time, with no sign-up or credit card. The complete rewritten resume is the paid part (SAR 35 one-time or SAR 75/month)." },
        { q: "What file types can I upload?", a: "PDF, Word (.docx), and plain text. The tool extracts the text automatically so you don't have to copy and paste — and your file is never stored on our servers." },
        { q: "What does the checker analyze?", a: "In target mode it compares your resume to a specific job description: keyword match, skills coverage, and bullet strength. In general mode it scores overall quality: impact, structure, and clarity." },
        { q: "Will it invent achievements to boost my score?", a: "Never. The engine is constrained from adding any fact you didn't provide — where a metric is missing it writes [add your real number] instead of making one up." },
      ]}
      ctaLine="Check your resume free right now"
    />
  );
}
