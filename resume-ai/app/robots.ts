import type { MetadataRoute } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/pay/"] },
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
