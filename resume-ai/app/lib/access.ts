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
// Signed, httpOnly fallback record of an ACCOUNT entitlement (email + expiry),
// written on purchase alongside the server store. If the store write misses
// (not configured, or the API call fails) a paid, signed-in buyer still keeps
// unlimited access on this browser because the entitlement check reads this
// cookie as a fallback. Mirrors the paid-pass pattern below.
export const ENT_COOKIE = "ra_ent";

const WINDOW_MS: Record<string, number> = {
  single: 24 * 60 * 60 * 1000, // day pass
  complete: 90 * 24 * 60 * 60 * 1000, // one-time complete pack — 90 days full access
  monthly: 30 * 24 * 60 * 60 * 1000, // legacy 30-day plan (backward-compat)
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

export interface EntPass {
  email: string;
  exp: number; // epoch ms
}

/** Signed cookie value recording an account entitlement — fallback for when the
 * server-side entitlement store (Edge Config / Upstash) can't be read/written. */
export function grantEntPass(email: string, exp: number): string {
  const payload: EntPass = { email: email.toLowerCase().trim(), exp };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Returns the entitlement (email + expiry) if the cookie is validly signed and
 * unexpired, else null. Callers must still confirm the email matches the caller. */
export function verifyEntPass(token: string | undefined, now: number): EntPass | null {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (sign(body) !== sig) return null; // bad signature
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as EntPass;
    if (typeof payload.exp !== "number" || payload.exp < now) return null; // expired
    if (typeof payload.email !== "string" || !payload.email) return null;
    return payload;
  } catch {
    return null;
  }
}
