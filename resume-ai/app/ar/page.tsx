import type { Metadata } from "next";
import Journey from "../components/Journey";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "سيرتك بمقابلة — الذكاء الاصطناعي يبنيها معك | cv.rabit.sa",
  description:
    "كلم المستشار دقيقتين: يسألك، يعيد صياغة كلامك العادي لصياغة احترافية تعبر أنظمة التوظيف (ATS)، ويسلمك سيرة جاهزة للتنزيل — مجاناً وبدون تسجيل. عربي وإنجليزي.",
  alternates: {
    canonical: `${BASE}/ar`,
    languages: { en: `${BASE}/`, ar: `${BASE}/ar`, "x-default": `${BASE}/` },
  },
};

export default function ArabicHome() {
  return <Journey lang="ar" />;
}
