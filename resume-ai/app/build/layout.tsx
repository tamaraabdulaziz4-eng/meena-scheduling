import type { Metadata } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "Free AI Resume Builder — ATS-Ready in Minutes | ResumeAI",
  description: "Build a clean, ATS-friendly resume step by step with AI help. Enter your experience and export a polished, recruiter-ready resume in minutes.",
  alternates: {
    canonical: `${BASE}/build`,
    languages: { en: `${BASE}/build`, ar: `${BASE}/ar/builder`, "x-default": `${BASE}/build` },
  },
};

export default function BuildLayout({ children }: { children: React.ReactNode }) {
  return children;
}
