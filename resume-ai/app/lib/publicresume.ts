// Public shareable resumes stored in Vercel Edge Config (same store as
// entitlements). Key: `pub_<slug>` -> JSON {name, role, text, created}.

const EC_ID = process.env.EDGE_CONFIG_ID;
const EC_READ = process.env.EDGE_CONFIG_READ_TOKEN;
const EC_TEAM = process.env.EDGE_CONFIG_TEAM_ID;
const EC_WRITE = process.env.VERCEL_API_TOKEN;

export const publicResumeConfigured = () => !!(EC_ID && EC_READ && EC_WRITE);

export interface PublicResume {
  name: string;
  role: string;
  text: string;
  created: number;
}

const key = (slug: string) => "pub_" + slug.replace(/[^a-z0-9_]/gi, "").toLowerCase();

export async function savePublicResume(slug: string, data: PublicResume): Promise<void> {
  if (!publicResumeConfigured()) throw new Error("storage not configured");
  const team = EC_TEAM ? `?teamId=${EC_TEAM}` : "";
  const res = await fetch(`https://api.vercel.com/v1/edge-config/${EC_ID}/items${team}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${EC_WRITE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ operation: "upsert", key: key(slug), value: JSON.stringify(data) }] }),
  });
  if (!res.ok) throw new Error(`edge-config write ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function getPublicResume(slug: string): Promise<PublicResume | null> {
  if (!publicResumeConfigured()) return null;
  try {
    const res = await fetch(`https://edge-config.vercel.com/${EC_ID}/item/${key(slug)}?token=${EC_READ}`, { cache: "no-store" });
    if (!res.ok) return null;
    const v = await res.json();
    return typeof v === "string" ? (JSON.parse(v) as PublicResume) : (v as PublicResume);
  } catch {
    return null;
  }
}

/** Build a URL-safe, human-readable slug from a name + short random suffix. */
export function makeSlug(name: string, rand: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "resume";
  return `${base}-${rand}`;
}
