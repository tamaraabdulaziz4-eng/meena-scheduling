import type { Metadata } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "AI Interview Prep — Likely Questions & Strong Answers | Sira",
  description: "Paste your resume and the job description — get the 8 most likely interview questions with strong personalized answers, plus the red flags to prepare for.",
  alternates: { canonical: `${BASE}/interview` },
};

export default function InterviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
