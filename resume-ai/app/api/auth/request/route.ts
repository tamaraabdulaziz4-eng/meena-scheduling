import { NextRequest, NextResponse } from "next/server";
import { createMagicToken } from "@/app/lib/session";
import { allow, clientIp } from "@/app/lib/ratelimit";

export const maxDuration = 20;

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";
// No sandbox fallback: if EMAIL_FROM is unset we refuse to send (below) rather
// than silently mailing from an unverified sandbox address.
const FROM = process.env.EMAIL_FROM;

/** Sends a magic sign-in link to the given email via Resend. */
export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
    }

    // Throttle to stop email-bombing: max 4 links/hour per address, 8 per IP.
    // Charged up front, before the send — a failed send (bouncing address,
    // provider hiccup) must still count, otherwise a bad address could drive
    // unbounded outbound attempts by never consuming the quota.
    const ipKey = `auth:ip:${clientIp(req)}`;
    const emKey = `auth:em:${String(email).toLowerCase()}`;
    if (!allow(ipKey, 8, 60 * 60 * 1000) || !allow(emKey, 4, 60 * 60 * 1000)) {
      return NextResponse.json({ error: "Too many sign-in requests. Please wait a bit and try again." }, { status: 429 });
    }

    const token = createMagicToken(email, Date.now());
    const link = `${BASE}/api/auth/verify?token=${encodeURIComponent(token)}`;

    const key = process.env.RESEND_API_KEY;
    if (!key || !FROM) {
      // Not configured (missing API key or sender) — surface a clear message
      // rather than pretending to send or mailing from a sandbox address.
      return NextResponse.json({ error: "Email sign-in isn't configured yet." }, { status: 503 });
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: "Your ResumeAI sign-in link",
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2>Sign in to ResumeAI</h2>
          <p>Click the button below to sign in. This link expires in 15 minutes.</p>
          <p><a href="${link}" style="display:inline-block;background:#22c55e;color:#05130a;font-weight:bold;padding:12px 24px;border-radius:8px;text-decoration:none">Sign in →</a></p>
          <p style="color:#888;font-size:12px">If you didn't request this, you can ignore it.</p>
        </div>`,
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Auth request error:", err);
    return NextResponse.json({ error: "Could not send the sign-in link. Please try again." }, { status: 500 });
  }
}
