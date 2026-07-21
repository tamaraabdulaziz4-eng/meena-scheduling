/**
 * Per-account entitlements stored in Upstash Redis (REST API, plain fetch).
 * Key: `ent:<email>` -> epoch ms until which the account has unlimited access.
 * Falls back gracefully (returns no-access) if Redis isn't configured yet.
 */

const URL_BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const redisConfigured = () => !!(URL_BASE && TOKEN);

async function cmd(args: (string | number)[]): Promise<unknown> {
  if (!redisConfigured()) throw new Error("Redis not configured");
  const res = await fetch(URL_BASE!, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  const data = await res.json();
  return data.result;
}

const key = (email: string) => `ent:${email.toLowerCase().trim()}`;

/** Grant/extend unlimited access to an account until `until` (epoch ms). */
export async function grantEntitlement(email: string, until: number): Promise<void> {
  if (!redisConfigured()) return;
  await cmd(["SET", key(email), String(until)]);
}

/** Returns the entitlement expiry (epoch ms) or 0 if none / not configured. */
export async function getEntitlement(email: string): Promise<number> {
  if (!redisConfigured()) return 0;
  try {
    const v = await cmd(["GET", key(email)]);
    return v ? parseInt(String(v)) || 0 : 0;
  } catch {
    return 0;
  }
}

export async function hasActiveEntitlement(email: string, now: number): Promise<boolean> {
  return (await getEntitlement(email)) > now;
}
