/**
 * Single source of truth for what each paid plan includes.
 *
 * IMPORTANT — this mirrors the ACTUAL gating in the code: every paid feature
 * (full resume rewrite, cover letter, LinkedIn optimizer, interview prep,
 * watermark-free downloads) is unlocked by ANY valid pass. Plans differ ONLY in
 * how long access lasts — see WINDOW_MS in access.ts (single = 24h, complete =
 * 90 days). Do not describe features as exclusive to the Complete Pack; the
 * honest differentiator is duration. Every page's pricing copy should read from
 * here so the plans never contradict each other again.
 */

export interface Plan {
  id: "single" | "complete";
  name: string;
  nameAr: string;
  priceSar: number;
  priceUsd: string;
  accessLabel: string;
  accessLabelAr: string;
  tagline: string;
  taglineAr: string;
  /** Full feature list — identical for both plans; only access duration differs. */
  features: string[];
  featuresAr: string[];
}

const FULL_FEATURES = [
  "Full ATS-optimized resume rewrite",
  "Cover letter generator",
  "LinkedIn headline & about optimizer",
  "Interview prep questions & answers",
  "Watermark-free PDF & Word downloads",
];

const FULL_FEATURES_AR = [
  "إعادة كتابة السيرة كاملة ومهيّأة لأنظمة التوظيف",
  "مولّد خطاب التعريف",
  "تحسين عنوان ونبذة لينكدإن",
  "أسئلة وأجوبة تحضير المقابلة",
  "تنزيل PDF و Word بدون علامة مائية",
];

export const PLANS: Record<"single" | "complete", Plan> = {
  single: {
    id: "single",
    name: "One-time optimization",
    nameAr: "تحسين واحد",
    priceSar: 35,
    priceUsd: "~$9",
    accessLabel: "Full access for 24 hours",
    accessLabelAr: "وصول كامل لمدة ٢٤ ساعة",
    tagline: "Everything unlocked — perfect for one big application.",
    taglineAr: "كل شيء مفتوح — مثالي لتقديم واحد مهم.",
    features: FULL_FEATURES,
    featuresAr: FULL_FEATURES_AR,
  },
  complete: {
    id: "complete",
    name: "Complete Pack",
    nameAr: "الحزمة الكاملة",
    priceSar: 99,
    priceUsd: "~$26",
    accessLabel: "Full access for 90 days",
    accessLabelAr: "وصول كامل لمدة ٩٠ يوماً",
    tagline: "Same full access, 90 days — best for an active job hunt. No subscription.",
    taglineAr: "نفس الوصول الكامل لكن ٩٠ يوماً — الأفضل للبحث النشط. بدون اشتراك.",
    features: FULL_FEATURES,
    featuresAr: FULL_FEATURES_AR,
  },
};
