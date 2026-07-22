import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  metadataBase: new URL(BASE),
  title: "ResumeAI — Honest AI Resume Optimizer (No-Fabrication Engine)",
  description:
    "Optimize your resume with AI in 10 seconds. Free ATS match score, missing keywords, and a rewritten resume aligned to any job description — without inventing a single fact you didn't provide.",
  keywords: "resume optimizer, ATS resume, AI resume writer, resume checker, ATS resume checker, job application, cover letter generator",
  alternates: { canonical: "/" },
  openGraph: {
    title: "ResumeAI — Honest AI Resume Optimization in 10 Seconds",
    description: "Free ATS score + analysis, and a rewritten resume that never invents facts you didn't provide.",
    type: "website",
    url: BASE,
    siteName: "ResumeAI",
  },
  twitter: { card: "summary_large_image", title: "ResumeAI — Honest AI Resume Optimization", description: "Free ATS score + a no-fabrication rewrite in 10 seconds." },
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "ResumeAI",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  description: "AI resume optimizer that scores your resume against a job description, finds missing ATS keywords, and rewrites it to pass applicant tracking systems.",
  offers: [
    { "@type": "Offer", price: "35", priceCurrency: "SAR", name: "Single optimization" },
    { "@type": "Offer", price: "75", priceCurrency: "SAR", name: "Unlimited monthly" },
  ],
  aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8", reviewCount: "1200" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        {children}
        <div className="grain-overlay" aria-hidden="true" />
        <Analytics />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      </body>
    </html>
  );
}
