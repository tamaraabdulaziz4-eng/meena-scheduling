import type { Metadata } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  alternates: { canonical: `${BASE}/ar/build` },
};

export default function ArBuildLayout({ children }: { children: React.ReactNode }) {
  return children;
}
