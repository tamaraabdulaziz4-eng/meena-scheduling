import { NextRequest } from "next/server";

/**
 * Best-effort in-memory rate limiter. On serverless this is per-instance and
 * resets on cold start, so it's not a hard guarantee — but it meaningfully
 * blunts casual abuse (email-bombing the magic-link, hammering the LLM endpoint)
 * with zero infrastructure. For hard limits, back this with Upstash/Redis later.
 */

type Hit = { count: number; reset: number };
const buckets = new Map<string, Hit>();

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/**
 * Returns true if the action is allowed, false if the caller is over the limit.
 * @param key    unique bucket key (e.g. `optimize:<ip>` or `auth:<email>`)
 * @param limit  max actions per window
 * @param windowMs window length in ms
 */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const hit = buckets.get(key);
  if (!hit || now > hit.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    // Opportunistic cleanup so the map can't grow unbounded.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
    }
    return true;
  }
  if (hit.count >= limit) return false;
  hit.count++;
  return true;
}
