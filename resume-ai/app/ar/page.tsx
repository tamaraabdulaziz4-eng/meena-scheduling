import type { Metadata } from "next";
import LandingScroll from "../components/LandingScroll";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "افحص سيرتك الذاتية مجاناً بمعايير ATS — خلال ثوانٍ | cv.rabit.sa",
  description:
    "الصق سيرتك وشفها بعيون أنظمة التوظيف — مجاناً وبدون تسجيل. تحسين صادق بدون اختلاق، 10 قوالب، تنزيل عربي RTL وإنجليزي. دفعة وحدة 35 ريال.",
  alternates: {
    canonical: `${BASE}/ar`,
    languages: { en: `${BASE}/`, ar: `${BASE}/ar`, "x-default": `${BASE}/` },
  },
};

export default function ArabicHome() {
  return <LandingScroll lang="ar" />;
}
