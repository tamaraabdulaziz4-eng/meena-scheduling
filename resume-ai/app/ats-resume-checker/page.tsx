import type { Metadata } from "next";
import SeoLanding from "../components/SeoLanding";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "ATS Resume Checker — Score Your Resume Against Any Job (Free)",
  description:
    "Free ATS resume checker with a transparent scoring rubric. Paste your resume and a job description for an instant ATS match score, missing keywords, and an honest rewrite in 10 seconds.",
  keywords: "ATS resume checker, ATS resume scanner, resume ATS score, applicant tracking system checker, resume keyword checker",
  alternates: { canonical: `${BASE}/ats-resume-checker` },
  openGraph: { title: "ATS Resume Checker — Free Instant Score", description: "Get your ATS match score and a rewritten, keyword-optimized resume in 60 seconds.", type: "website" },
};

export default function Page() {
  return (
    <SeoLanding
      eyebrow="Free ATS resume checker"
      h1="See exactly how an ATS scores your resume —"
      h1Accent="before a recruiter does"
      intro="Many resumes lose visibility in applicant tracking software before a recruiter reads them. Our free ATS resume checker scores your resume against the exact job you are applying to, shows the keywords you are missing, and rewrites it for clarity and alignment — without inventing anything."
      bullets={[
        { title: "Instant ATS match score", body: "A clear 0–100 score showing how well your resume matches the job description — the same signal recruiters' systems use." },
        { title: "Missing keyword detection", body: "See the exact skills, tools, and phrases the job asks for that your resume is missing, so you can add them naturally." },
        { title: "Full AI rewrite", body: "Not just a score — get your whole resume rewritten with strong action verbs, quantified results, and ATS-safe formatting." },
        { title: "Works for any job", body: "Engineering, marketing, finance, healthcare — paste any job description and the checker tailors to it." },
      ]}
      faqs={[
        { q: "What is an ATS resume checker?", a: "An ATS (applicant tracking system) resume checker analyzes your resume the way employer software does — scanning for keywords, formatting, and relevance to a specific job — and gives you a score plus fixes so your resume gets past the automated filter." },
        { q: "Is the ATS resume checker free?", a: "Yes — your first resume scan is completely free, no account or card required. For unlimited scans and cover letters, plans start at SAR 35 (~$9) one-time or SAR 99 one-time." },
        { q: "How do I improve my ATS score?", a: "Mirror the exact keywords from the job description, use standard section headings, quantify your achievements, and avoid tables or graphics that confuse parsers. Our checker does all of this automatically in the rewrite." },
        { q: "Will an ATS reject my resume for formatting?", a: "It can. Complex tables, columns, images, and unusual fonts often break ATS parsing. Our tool outputs clean, ATS-safe text you can paste into any application." },
      ]}
      ctaLine="Check your ATS score in 10 seconds"
      methodology={[
        { label: "Hard skills & tools match", weight: 40, note: "The technologies, tools, and hard skills the posting names, checked against your resume (synonyms included)." },
        { label: "Relevant experience & achievements", weight: 20, note: "Whether your experience genuinely maps to what the role needs." },
        { label: "Job title / seniority alignment", weight: 15, note: "How closely your title and level match what they're hiring for." },
        { label: "Keyword & terminology coverage", weight: 15, note: "Domain language and terminology the employer's system scans for." },
        { label: "Required qualifications & certifications", weight: 10, note: "Degrees and certifications the posting explicitly requires." },
      ]}
    />
  );
}
