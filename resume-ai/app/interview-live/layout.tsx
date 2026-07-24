import type { Metadata } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "AI Video Mock Interview — Practice on Camera | Sira",
  description: "Practice the interview on camera: the AI asks real questions, you answer on video, and get an instant score and coaching. Bilingual (English & Arabic). Your video stays on your device.",
  alternates: {
    canonical: `${BASE}/interview-live`,
    languages: { en: `${BASE}/interview-live`, ar: `${BASE}/interview-live?lang=ar`, "x-default": `${BASE}/interview-live` },
  },
};

export default function InterviewLiveLayout({ children }: { children: React.ReactNode }) {
  return children;
}
