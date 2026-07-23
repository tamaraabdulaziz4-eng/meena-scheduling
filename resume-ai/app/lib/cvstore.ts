/**
 * Per-account saved résumés — cloud storage so a user's CVs survive a cleared
 * browser (a gap vs competitors who save to an account). Keyed by email in
 * Vercel Edge Config: `res_<sanitized email>` → JSON array of SavedCV.
 *
 * Edge Config is read-optimized; writes go through the Vercel API and are
 * low-volume here (a save happens only when a user generates/keeps a CV). We
 * cap the list per user to bound the stored size.
 */

const EC_ID = process.env.EDGE_CONFIG_ID;
const EC_READ = process.env.EDGE_CONFIG_READ_TOKEN;
const EC_TEAM = process.env.EDGE_CONFIG_TEAM_ID;
const EC_WRITE = process.env.VERCEL_API_TOKEN;

export const cvStoreConfigured = () => !!(EC_ID && EC_READ && EC_WRITE);

const MAX_PER_USER = 25;

export interface SavedCV {
  id: string;
  title: string;
  text: string;
  source: string;   // "built" | "optimized" | …
  savedAt: number;
}

const key = (email: string) =>
  "res_" + Buffer.from(email.toLowerCase().trim()).toString("base64url").replace(/-/g, "_");

async function readList(email: string): Promise<SavedCV[]> {
  try {
    const res = await fetch(`https://edge-config.vercel.com/${EC_ID}/item/${key(email)}?token=${EC_READ}`, { cache: "no-store" });
    if (res.status === 404) return [];
    if (!res.ok) return [];
    const v = await res.json();
    const arr = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(arr) ? (arr as SavedCV[]) : [];
  } catch {
    return [];
  }
}

async function writeList(email: string, list: SavedCV[]): Promise<void> {
  const team = EC_TEAM ? `?teamId=${EC_TEAM}` : "";
  const res = await fetch(`https://api.vercel.com/v1/edge-config/${EC_ID}/items${team}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${EC_WRITE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ operation: "upsert", key: key(email), value: JSON.stringify(list) }] }),
  });
  if (!res.ok) throw new Error(`edge-config write ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function listUserCVs(email: string): Promise<SavedCV[]> {
  if (!cvStoreConfigured()) return [];
  const list = await readList(email);
  return list.sort((a, b) => b.savedAt - a.savedAt);
}

export async function saveUserCV(email: string, cv: { id?: string; title: string; text: string; source?: string; savedAt: number }): Promise<SavedCV[]> {
  if (!cvStoreConfigured()) return [];
  const list = await readList(email);
  const entry: SavedCV = {
    id: cv.id || `${cv.savedAt}-${Math.abs(hash(cv.text)).toString(36)}`,
    title: cv.title.slice(0, 120),
    text: cv.text.slice(0, 12000),
    source: cv.source || "built",
    savedAt: cv.savedAt,
  };
  // De-dupe by id, newest first, cap the list.
  const next = [entry, ...list.filter((c) => c.id !== entry.id)].slice(0, MAX_PER_USER);
  await writeList(email, next);
  return next;
}

export async function deleteUserCV(email: string, id: string): Promise<SavedCV[]> {
  if (!cvStoreConfigured()) return [];
  const list = await readList(email);
  const next = list.filter((c) => c.id !== id);
  await writeList(email, next);
  return next;
}

// Stable non-crypto hash for a fallback id (Date-independent-safe).
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}
