import type { Metadata } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "مقابلة فيديو تجريبية بالذكاء الاصطناعي | Sira",
  description: "تدرّب على المقابلة أمام الكاميرا: الذكاء الاصطناعي يسألك أسئلة حقيقية، تجاوب بالفيديو، ويعطيك تقييماً ونصائح فورية. مجاناً وبدون تسجيل.",
  alternates: { canonical: `${BASE}/interview-live` },
};

export default function InterviewLiveLayout({ children }: { children: React.ReactNode }) {
  return children;
}
