import type { Metadata } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "AI Resume Optimizer & Free ATS Score Checker | ResumeAI",
  description: "Paste your resume and any job description to get a free ATS match score, the missing keywords recruiters scan for, and an honest AI rewrite — no invented facts.",
  alternates: { canonical: `${BASE}/optimize` },
};

export default function OptimizeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
