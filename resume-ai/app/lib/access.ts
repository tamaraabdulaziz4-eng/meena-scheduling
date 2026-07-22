import crypto from "crypto";

/**
 * Lightweight signed access passes — no database required.
 * A pass is `base64(payload).signature`, signed with ACCESS_SECRET (HMAC-SHA256).
 * Payment grants a pass; the optimizer checks it. Tamper-resistant (can't forge
 * without the secret), though clearing cookies resets the free-scan counter —
 * acceptable for an MVP, tighten with real accounts later.
 */

const SECRET = process.env.ACCESS_SECRET || "dev-insecure-secret-change-me";

// In production the secret MUST be set — the fallback is publicly known and
// would let anyone forge access passes / sessions. Checked at request time
// (not module load) so `next build` doesn't fail before env vars are injected.
function assertSecret() {
  if (process.env.NODE_ENV === "production" && !process.env.ACCESS_SECRET) {
    throw new Error("ACCESS_SECRET must be set in production");
  }
}

export const ACCESS_COOKIE = "ra_access";
export const FREE_COOKIE = "ra_free";
export const FREE_LIMIT = 1; // free optimizations before payment is required

const WINDOW_MS: Record<string, number> = {
  single: 24 * 60 * 60 * 1000, // day pass
  monthly: 30 * 24 * 60 * 60 * 1000, // 30 days
};

export interface Pass {
  plan: string;
  exp: number; // epoch ms
}

function sign(data: string): string {
  assertSecret();
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}

export function grantPass(plan: string, now: number): string {
  const window = WINDOW_MS[plan] ?? WINDOW_MS.single;
  const payload: Pass = { plan, exp: now + window };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyPass(token: string | undefined, now: number): Pass | null {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (sign(body) !== sig) return null; // bad signature
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as Pass;
    if (typeof payload.exp !== "number" || payload.exp < now) return null; // expired
    return payload;
  } catch {
    return null;
  }
}
