import type { Metadata } from "next";
import Journey from "./components/Journey";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "Your Resume, By Interview — AI Builds It With You | cv.rabit.sa",
  description:
    "Talk to the AI Advisor for two minutes: it interviews you, rephrases your casual words into professional ATS-ready lines, and hands you a downloadable resume — free, no signup. Arabic & English.",
  alternates: {
    canonical: `${BASE}/`,
    languages: { en: `${BASE}/`, ar: `${BASE}/ar`, "x-default": `${BASE}/` },
  },
};

export default function Home() {
  return <Journey lang="en" />;
}
