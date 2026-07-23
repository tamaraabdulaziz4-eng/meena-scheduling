import type { Metadata } from "next";
import { headers } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  metadataBase: new URL(BASE),
  title: "ResumeAI — Honest AI Resume Optimizer (No-Fabrication Engine)",
  description:
    "Optimize your resume with AI in 10 seconds. Free ATS match score, missing keywords, and a rewritten resume aligned to any job description — without inventing a single fact you didn't provide.",
  keywords: "resume optimizer, ATS resume, AI resume writer, resume checker, ATS resume checker, job application, cover letter generator",
  openGraph: {
    title: "ResumeAI — Honest AI Resume Optimization in 10 Seconds",
    description: "Free ATS score + analysis, and a rewritten resume that never invents facts you didn't provide.",
    type: "website",
    url: BASE,
    siteName: "ResumeAI",
  },
  twitter: { card: "summary_large_image", title: "ResumeAI — Honest AI Resume Optimization", description: "Free ATS score + a no-fabrication rewrite in 10 seconds." },
};

// Rich structured data — Organization + SoftwareApplication (with real SAR
// offers) + FAQPage. No aggregateRating/review is emitted because we have no
// verified ratings yet, and the brand promise is zero fabrication.
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${BASE}/#org`,
      name: "ResumeAI",
      url: BASE,
      description: "Honest AI resume optimizer for the Saudi, Gulf, and global job markets.",
    },
    {
      "@type": "SoftwareApplication",
      name: "ResumeAI",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      publisher: { "@id": `${BASE}/#org` },
      description: "AI resume optimizer that scores your resume against a job description, finds missing ATS keywords, and rewrites it to pass applicant tracking systems — without inventing facts you didn't provide.",
      offers: [
        { "@type": "Offer", price: "35", priceCurrency: "SAR", name: "One-time optimization — 24-hour full access" },
        { "@type": "Offer", price: "99", priceCurrency: "SAR", name: "Complete Pack — 90-day full access (one-time)" },
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: "Is the resume scan free?", acceptedAnswer: { "@type": "Answer", text: "Yes. The ATS match score, missing keywords, skills-gap analysis, and a preview of improvements are free. The full rewritten resume and downloads unlock with a one-time payment." } },
        { "@type": "Question", name: "Does it invent experience or skills?", acceptedAnswer: { "@type": "Answer", text: "No. The engine can only reorganize and reword your own facts. It never adds a number, employer, degree, or skill you didn't provide — it marks missing metrics with a placeholder instead." } },
        { "@type": "Question", name: "Is it a subscription?", acceptedAnswer: { "@type": "Answer", text: "No subscription. Pay once — SAR 35 for 24-hour full access or SAR 99 for 90 days. There is a 7-day money-back guarantee." } },
        { "@type": "Question", name: "Does it support Arabic?", acceptedAnswer: { "@type": "Answer", text: "Yes. Full Arabic (RTL) interface, Saudi/Gulf resume fields, and you can even write in Arabic and get a polished English resume back." } },
      ],
    },
  ],
};

// Meta (Facebook/Instagram) Pixel — measures ad-driven visits and, via the
// Purchase event on the pay callback, real revenue from paid campaigns. Fully
// dormant until NEXT_PUBLIC_META_PIXEL_ID is set (no ID → no script), so it can
// ship now and activate the moment the ad account is connected.
const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The Arabic UI lives under /ar — serve it with the correct lang/dir on the
  // <html> root (proxy.ts forwards the pathname). Fixes lang="en" on /ar (a11y/SEO).
  const pathname = (await headers()).get("x-pathname") || "";
  const isArabic = pathname === "/ar" || pathname.startsWith("/ar/");

  return (
    <html lang={isArabic ? "ar" : "en"} dir={isArabic ? "rtl" : "ltr"}>
      <body style={{ margin: 0, padding: 0 }}>
        {children}
        <div className="grain-overlay" aria-hidden="true" />
        <Analytics />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
        {META_PIXEL_ID && (
          <script
            dangerouslySetInnerHTML={{
              __html: `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');fbq('track','PageView');`,
            }}
          />
        )}
      </body>
    </html>
  );
}
