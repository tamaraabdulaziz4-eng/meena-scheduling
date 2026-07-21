import type { Metadata } from "next";
import "./globals.css";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://resume-ai-kappa-flax.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(BASE),
  title: "ResumeAI — AI Resume Optimizer That Beats ATS Filters",
  description:
    "Optimize your resume with AI in 60 seconds. Get an ATS match score, missing keywords, and a fully rewritten resume tailored to any job description. Beat ATS filters and get more interviews.",
  keywords: "resume optimizer, ATS resume, AI resume writer, resume checker, ATS resume checker, job application, cover letter generator",
  alternates: { canonical: "/" },
  openGraph: {
    title: "ResumeAI — Beat the ATS, Get More Interviews",
    description: "Paste your resume + a job description, get a fully optimized resume in 60 seconds.",
    type: "website",
    url: BASE,
    siteName: "ResumeAI",
  },
  twitter: { card: "summary_large_image", title: "ResumeAI — Beat the ATS", description: "AI resume optimization in 60 seconds." },
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "ResumeAI",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  description: "AI resume optimizer that scores your resume against a job description, finds missing ATS keywords, and rewrites it to pass applicant tracking systems.",
  offers: [
    { "@type": "Offer", price: "9", priceCurrency: "USD", name: "Single optimization" },
    { "@type": "Offer", price: "19", priceCurrency: "USD", name: "Unlimited monthly" },
  ],
  aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8", reviewCount: "1200" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        {children}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      </body>
    </html>
  );
}
