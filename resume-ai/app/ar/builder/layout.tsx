import type { Metadata } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  alternates: {
    canonical: `${BASE}/ar/builder`,
    languages: { en: `${BASE}/build`, ar: `${BASE}/ar/builder`, "x-default": `${BASE}/build` },
  },
};

export default function ArBuilderLayout({ children }: { children: React.ReactNode }) {
  return children;
}
