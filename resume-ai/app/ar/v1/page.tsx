import type { Metadata } from "next";
import LandingScroll from "../../components/LandingScroll";

// v1 scrollytelling landing (Arabic), kept for A-B comparison against v2.
export const metadata: Metadata = {
  title: "Sira — v1",
  robots: { index: false, follow: false },
};

export default function V1Ar() {
  return <LandingScroll lang="ar" />;
}
