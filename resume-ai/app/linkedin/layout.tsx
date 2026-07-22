import type { Metadata } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "Free LinkedIn Profile Optimizer — Headline, About & Skills | ResumeAI",
  description: "Paste your resume and target role — get a keyword-rich LinkedIn headline, a compelling About section, and the exact skills recruiters search for.",
  alternates: { canonical: `${BASE}/linkedin` },
};

export default function LinkedinLayout({ children }: { children: React.ReactNode }) {
  return children;
}
