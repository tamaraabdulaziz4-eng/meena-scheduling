import type { Metadata } from "next";
import LandingScroll from "./components/LandingScroll";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "Free ATS Resume Scan — Real Match Score in Seconds | cv.rabit.sa",
  description:
    "Paste your resume and see it through the ATS's eyes — free, no signup. Honest AI optimization, 10 templates, English & Arabic (true RTL) downloads. Pay once, SAR 35.",
  alternates: {
    canonical: `${BASE}/`,
    languages: { en: `${BASE}/`, ar: `${BASE}/ar`, "x-default": `${BASE}/` },
  },
};

export default function Home() {
  return <LandingScroll lang="en" />;
}
