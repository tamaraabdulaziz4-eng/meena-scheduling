// Free resume-template styles. Each is an indexable SEO page targeting
// "{style} resume template" + a live rendered preview + CTA to the builder.

export interface TemplateData {
  slug: string;
  name: string;          // "Modern"
  keyword: string;       // primary search target
  tagline: string;
  bestFor: string;
  accent: string;        // preview accent color
  font: string;          // preview font family
  layout: "classic" | "sidebar" | "minimal" | "bold";
  atsScore: number;      // how ATS-safe (for honesty)
  atsNote: string;
}

export const TEMPLATES: TemplateData[] = [
  { slug: "ats", name: "ATS-Optimized", keyword: "ATS resume template", tagline: "The safest choice — engineered to pass every applicant tracking system.", bestFor: "Anyone applying online at mid-to-large companies (Aramco, STC, banks).", accent: "#4ade80", font: "'Calibri', 'Segoe UI', Arial, sans-serif", layout: "classic", atsScore: 100, atsNote: "Single column, standard headings, zero graphics — parses perfectly in every ATS." },
  { slug: "modern", name: "Modern", keyword: "modern resume template", tagline: "Clean, contemporary, and still fully ATS-friendly.", bestFor: "Tech, marketing, and design-adjacent roles that want a polished look.", accent: "#6366f1", font: "'Inter', -apple-system, sans-serif", layout: "classic", atsScore: 96, atsNote: "Single column with subtle accent — safe for almost all ATS." },
  { slug: "minimal", name: "Minimal", keyword: "minimalist resume template", tagline: "Maximum whitespace, zero distraction — content does the talking.", bestFor: "Senior professionals and consultants who let results speak.", accent: "#1a1a1a", font: "'Georgia', 'Times New Roman', serif", layout: "minimal", atsScore: 98, atsNote: "Plain, elegant, and highly parseable." },
  { slug: "professional", name: "Professional", keyword: "professional resume template", tagline: "The timeless corporate standard recruiters expect.", bestFor: "Finance, accounting, law, government, and executive roles.", accent: "#1e3a5f", font: "'Georgia', serif", layout: "classic", atsScore: 97, atsNote: "Conservative single column — a safe bet for traditional industries." },
  { slug: "executive", name: "Executive", keyword: "executive resume template", tagline: "Commanding and confident — built for leadership roles.", bestFor: "Managers, directors, and C-suite candidates.", accent: "#8a6d3b", font: "'Garamond', 'Georgia', serif", layout: "classic", atsScore: 95, atsNote: "Refined typography, still single column and ATS-safe." },
  { slug: "creative", name: "Creative", keyword: "creative resume template", tagline: "Stand out with tasteful color — without breaking the ATS.", bestFor: "Designers, marketers, and creative roles at smaller companies.", accent: "#e11d48", font: "'Poppins', 'Inter', sans-serif", layout: "bold", atsScore: 88, atsNote: "More color and structure — great for humans; keep an ATS copy for online forms." },
  { slug: "simple", name: "Simple", keyword: "simple resume template", tagline: "No-nonsense and easy to read — perfect for a first resume.", bestFor: "Students, graduates, and first-time job seekers.", accent: "#0891b2", font: "'Arial', sans-serif", layout: "minimal", atsScore: 99, atsNote: "About as ATS-safe as it gets." },
  { slug: "two-column", name: "Two-Column", keyword: "two column resume template", tagline: "Fit more on one page with a clean sidebar for skills.", bestFor: "Skill-heavy roles (developers, analysts) applying at modern companies.", accent: "#7c3aed", font: "'Inter', sans-serif", layout: "sidebar", atsScore: 82, atsNote: "Two columns look great but some older ATS mis-read them — we also give you a single-column export." },
  { slug: "jadarat", name: "Jadarat (Saudi)", keyword: "Jadarat resume template", tagline: "Formatted for Saudi hiring — Jadarat/Taqat portals and Vision 2030 employers.", bestFor: "Job seekers in Saudi Arabia applying via Jadarat, Taqat, or to Saudi employers (Aramco, STC, NEOM, government).", accent: "#006c35", font: "'Calibri', 'Segoe UI', Arial, sans-serif", layout: "classic", atsScore: 100, atsNote: "Single column, standard English headings, ATS-safe — structured the way Saudi portals and recruiters expect. Add your Iqama/nationality and city as Saudi employers scan for these." },
];

export const TEMPLATE_SLUGS = TEMPLATES.map((t) => t.slug);
export const getTemplate = (slug: string) => TEMPLATES.find((t) => t.slug === slug);
