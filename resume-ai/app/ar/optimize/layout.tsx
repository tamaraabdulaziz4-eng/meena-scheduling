import type { Metadata } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "افحص سيرتك الذاتية مجاناً — نتيجة ATS وتحليل فوري | ResumeAI",
  description: "الصق سيرتك (عربي أو إنجليزي) واحصل خلال ثوانٍ على نسبة التطابق، الكلمات الناقصة، وسيرة إنجليزية محسّنة — بدون اختلاق أي معلومة.",
  alternates: { canonical: `${BASE}/ar/optimize` },
};

export default function ArOptimizeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
