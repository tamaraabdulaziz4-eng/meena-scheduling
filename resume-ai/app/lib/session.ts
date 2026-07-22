import crypto from "crypto";

/**
 * Stateless signed tokens for auth: session cookies and short-lived magic links.
 * Both are `base64url(payload).hmac`, signed with ACCESS_SECRET — no DB needed
 * to issue or validate them (entitlements live in Redis; see lib/entitlements).
 * Note: with no server-side state a magic link isn't truly single-use — it stays
 * valid for its full 15-minute window, so keep that window short.
 */

const SECRET = process.env.ACCESS_SECRET || "dev-insecure-secret-change-me";

export const SESSION_COOKIE = "ra_session";

function sign(data: string): string {
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}

function encode(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode<T>(token: string | undefined, now: number): T | null {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (sign(body) !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as { exp: number };
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    return payload as T;
  } catch {
    return null;
  }
}

// ── Magic link (15-minute, purpose-scoped) ──
export function createMagicToken(email: string, now: number): string {
  return encode({ email: email.toLowerCase().trim(), purpose: "magic", exp: now + 15 * 60 * 1000 });
}
export function verifyMagicToken(token: string | undefined, now: number): string | null {
  const p = decode<{ email: string; purpose: string }>(token, now);
  return p && p.purpose === "magic" ? p.email : null;
}

// ── Session (30-day) ──
export function createSession(email: string, now: number): string {
  return encode({ email: email.toLowerCase().trim(), purpose: "session", exp: now + 30 * 24 * 60 * 60 * 1000 });
}
export function readSession(token: string | undefined, now: number): string | null {
  const p = decode<{ email: string; purpose: string }>(token, now);
  return p && p.purpose === "session" ? p.email : null;
}
