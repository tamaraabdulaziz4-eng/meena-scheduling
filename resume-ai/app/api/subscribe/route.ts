import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";

export const maxDuration = 20;

/**
 * Newsletter signup → Resend Audiences. The audience is created lazily on
 * first use and its id cached (also settable via RESEND_AUDIENCE_ID).
 */
let cachedAudienceId: string | null = process.env.RESEND_AUDIENCE_ID || null;

async function getAudienceId(key: string): Promise<string> {
  if (cachedAudienceId) return cachedAudienceId;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const list = await fetch("https://api.resend.com/audiences", { headers });
  if (list.ok) {
    const d = await list.json();
    const first = d?.data?.[0]?.id;
    if (first) { cachedAudienceId = first; return first; }
  }
  const created = await fetch("https://api.resend.com/audiences", {
    method: "POST", headers, body: JSON.stringify({ name: "Sira Newsletter" }),
  });
  if (!created.ok) throw new Error(`audience create ${created.status}`);
  const d = await created.json();
  cachedAudienceId = d.id;
  return d.id;
}

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
      return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
    if (!allow(`sub:${clientIp(req)}`, 5, 60 * 60 * 1000)) {
      return NextResponse.json({ error: "rate" }, { status: 429 });
    }
    const key = process.env.RESEND_API_KEY;
    if (!key) return NextResponse.json({ error: "unavailable" }, { status: 503 });

    const audienceId = await getAudienceId(key);
    const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: String(email).toLowerCase(), unsubscribed: false }),
    });
    if (!res.ok && res.status !== 409) throw new Error(`contact ${res.status}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Subscribe error:", err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
