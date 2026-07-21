import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ResumeAI — AI Resume Optimizer That Beats ATS Filters",
  description: "Optimize your resume with AI in 60 seconds. Get a match score, missing keywords, and a fully rewritten resume tailored to any job description. Beat ATS filters and get 3x more interviews.",
  keywords: "resume optimizer, ATS resume, AI resume writer, resume checker, job application",
  openGraph: {
    title: "ResumeAI — Get 3x More Interviews",
    description: "AI-powered resume optimization. Paste your resume + job description, get a fully optimized resume in 60 seconds.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
