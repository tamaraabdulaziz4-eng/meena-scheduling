import { NextRequest, NextResponse } from "next/server";
import { createMagicToken } from "@/app/lib/session";

export const maxDuration = 20;

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://resume-ai-kappa-flax.vercel.app";
const FROM = process.env.EMAIL_FROM || "ResumeAI <onboarding@resend.dev>";

/** Sends a magic sign-in link to the given email via Resend. */
export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
    }

    const token = createMagicToken(email, Date.now());
    const link = `${BASE}/api/auth/verify?token=${encodeURIComponent(token)}`;

    const key = process.env.RESEND_API_KEY;
    if (!key) {
      // Not configured yet — surface a clear message rather than pretending to send.
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
