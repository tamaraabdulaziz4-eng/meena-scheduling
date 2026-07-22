import type { MetadataRoute } from "next";
import { JOB_SLUGS } from "./lib/jobs";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://resume-ai-kappa-flax.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    "", "/optimize", "/build", "/linkedin", "/interview",
    "/ats-resume-checker", "/jobscan-alternative", "/free-resume-checker",
    "/resume-examples",
    "/ar", "/ar/build", "/ar/optimize",
  ];
  const examplePages = JOB_SLUGS.map((slug) => `/resume-examples/${slug}`);

  return [...routes, ...examplePages].map((path) => ({
    url: `${BASE}${path}`,
    changeFrequency: "weekly",
    priority: path === "" ? 1 : path.startsWith("/resume-examples/") ? 0.7 : 0.8,
  }));
}
