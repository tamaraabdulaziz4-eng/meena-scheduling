import type { MetadataRoute } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://resume-ai-kappa-flax.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["", "/optimize", "/ats-resume-checker", "/jobscan-alternative", "/free-resume-checker", "/build"];
  return routes.map((path) => ({
    url: `${BASE}${path}`,
    changeFrequency: "weekly",
    priority: path === "" ? 1 : 0.8,
  }));
}
