import type { TemplateVariant } from "../components/ResumeTemplate";

// Single source for the designed-resume template catalogue — used by the
// /templates gallery AND the picker on the optimize result, so they never drift.
export interface TemplateDef {
  slug: string;
  name: string;
  nameAr: string;
  variant: TemplateVariant;
  accent: string;
  best?: boolean;
}

export const TEMPLATE_CATALOG: TemplateDef[] = [
  { slug: "ats-pro", name: "ATS Pro", nameAr: "إيه تي إس برو", variant: "column", accent: "#0f766e", best: true },
  { slug: "onyx", name: "Onyx", nameAr: "أونيكس", variant: "classic", accent: "#0f766e" },
  { slug: "riyadh", name: "Riyadh", nameAr: "الرياض", variant: "classic", accent: "#b45309" },
  { slug: "azure", name: "Azure", nameAr: "أزور", variant: "modern", accent: "#1d4ed8" },
  { slug: "executive", name: "Executive", nameAr: "تنفيذي", variant: "elegant", accent: "#111827" },
  { slug: "minimal", name: "Minimalist", nameAr: "بسيط", variant: "minimal", accent: "#0f766e" },
  { slug: "emerald", name: "Emerald", nameAr: "زمرّد", variant: "classic", accent: "#047857" },
  { slug: "crimson", name: "Crimson", nameAr: "قرمزي", variant: "modern", accent: "#b91c1c" },
  { slug: "slate", name: "Slate", nameAr: "سليت", variant: "minimal", accent: "#334155" },
  { slug: "royal", name: "Royal", nameAr: "ملكي", variant: "elegant", accent: "#6d28d9" },
];
