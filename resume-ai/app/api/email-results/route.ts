import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";
import { sendEmail, emailShell } from "@/app/lib/email";

export const maxDuration = 20;

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * "Send my results to my email" — self-service delivery of the user's own
 * optimized resume, which doubles as opt-in email capture. Rate-limited and
 * size-capped so it can't be used as an open relay.
 */
export async function POST(req: NextRequest) {
  if (!allow(`emailres:${clientIp(req)}`, 8, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests. Please wait a minute." }, { status: 429 });
  }
  let body: { email?: string; resume?: string; score?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const email = String(body?.email || "").trim().toLowerCase();
  const resume = String(body?.resume || "").slice(0, 12000);
  const score = Number(body?.score);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
  if (resume.trim().length < 40) return NextResponse.json({ error: "Nothing to send yet." }, { status: 400 });

  const scoreLine = Number.isFinite(score) ? `<p>Your job-match score: <strong>${Math.round(score)}%</strong></p>` : "";
  const ok = await sendEmail({
    to: email,
    subject: "Your optimized resume — ResumeAI",
    html: emailShell(`
      <h2 style="margin:0 0 8px">Here's your optimized resume</h2>
      ${scoreLine}
      <pre style="white-space:pre-wrap;font-family:inherit;background:#f7f7f7;border:1px solid #eee;border-radius:8px;padding:16px;font-size:13px">${escapeHtml(resume)}</pre>
      <p><a href="${APP_URL}/optimize" style="color:#0f766e;font-weight:bold">Refine it again →</a></p>`),
  });
  if (!ok) return NextResponse.json({ error: "Email isn't available right now." }, { status: 503 });
  return NextResponse.json({ ok: true });
}
