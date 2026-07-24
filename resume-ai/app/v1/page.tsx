import type { Metadata } from "next";
import LandingScroll from "../components/LandingScroll";

// v1 scrollytelling landing, kept for A-B comparison against the v2 Advisor.
export const metadata: Metadata = {
  title: "Sira — v1",
  robots: { index: false, follow: false },
};

export default function V1() {
  return <LandingScroll lang="en" />;
}
