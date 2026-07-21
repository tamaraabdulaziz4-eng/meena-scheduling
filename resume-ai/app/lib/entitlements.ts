/**
 * Per-account entitlements stored in Vercel Edge Config (provisioned via API,
 * no external signup). Key: `ent_<sanitized email>` -> epoch ms until which
 * the account has unlimited access.
 *
 * Reads: edge-config.vercel.com with a scoped read token (fast, global).
 * Writes: api.vercel.com with an API token (one write per purchase — low volume).
 * Falls back to Upstash Redis if configured, else no-access.
 */

const EC_ID = process.env.EDGE_CONFIG_ID;
const EC_READ = process.env.EDGE_CONFIG_READ_TOKEN;
const EC_TEAM = process.env.EDGE_CONFIG_TEAM_ID;
const EC_WRITE = process.env.VERCEL_API_TOKEN;

const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const edgeConfigured = () => !!(EC_ID && EC_READ && EC_WRITE);
const upstashConfigured = () => !!(UP_URL && UP_TOKEN);
export const storeConfigured = () => edgeConfigured() || upstashConfigured();

// Edge Config keys must be alphanumeric/_- ; encode the email safely.
const key = (email: string) =>
  "ent_" + Buffer.from(email.toLowerCase().trim()).toString("base64url").replace(/-/g, "_");

async function edgeGet(k: string): Promise<number> {
  const res = await fetch(`https://edge-config.vercel.com/${EC_ID}/item/${k}?token=${EC_READ}`, { cache: "no-store" });
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`edge-config read ${res.status}`);
  const v = await res.json();
  return parseInt(String(v)) || 0;
}

async function edgeSet(k: string, value: string): Promise<void> {
  const team = EC_TEAM ? `?teamId=${EC_TEAM}` : "";
  const res = await fetch(`https://api.vercel.com/v1/edge-config/${EC_ID}/items${team}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${EC_WRITE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ operation: "upsert", key: k, value }] }),
  });
  if (!res.ok) throw new Error(`edge-config write ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function upstash(args: (string | number)[]): Promise<unknown> {
  const res = await fetch(UP_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${UP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return (await res.json()).result;
}

/** Grant/extend unlimited access to an account until `until` (epoch ms). */
export async function grantEntitlement(email: string, until: number): Promise<void> {
  if (edgeConfigured()) return edgeSet(key(email), String(until));
  if (upstashConfigured()) {
    await upstash(["SET", `ent:${email.toLowerCase().trim()}`, String(until)]);
  }
}

/** Returns the entitlement expiry (epoch ms) or 0 if none / not configured. */
export async function getEntitlement(email: string): Promise<number> {
  try {
    if (edgeConfigured()) return await edgeGet(key(email));
    if (upstashConfigured()) {
      const v = await upstash(["GET", `ent:${email.toLowerCase().trim()}`]);
      return v ? parseInt(String(v)) || 0 : 0;
    }
  } catch {
    /* fall through */
  }
  return 0;
}

export async function hasActiveEntitlement(email: string, now: number): Promise<boolean> {
  return (await getEntitlement(email)) > now;
}

// ── Order -> buyer email mapping (set at invoice creation, read at verify) ──
const orderKey = (orderNumber: string) => "ord_" + orderNumber.replace(/[^a-zA-Z0-9_]/g, "_");

export async function setOrderEmail(orderNumber: string, email: string): Promise<void> {
  if (edgeConfigured()) return edgeSet(orderKey(orderNumber), email.toLowerCase().trim());
  if (upstashConfigured()) {
    await upstash(["SET", `ord:${orderNumber}`, email.toLowerCase().trim()]);
  }
}

export async function getOrderEmail(orderNumber: string): Promise<string | null> {
  try {
    if (edgeConfigured()) {
      const res = await fetch(`https://edge-config.vercel.com/${EC_ID}/item/${orderKey(orderNumber)}?token=${EC_READ}`, { cache: "no-store" });
      if (!res.ok) return null;
      const v = await res.json();
      return typeof v === "string" && v.includes("@") ? v : null;
    }
    if (upstashConfigured()) {
      const v = await upstash(["GET", `ord:${orderNumber}`]);
      return v && String(v).includes("@") ? String(v) : null;
    }
  } catch {
    /* fall through */
  }
  return null;
}
