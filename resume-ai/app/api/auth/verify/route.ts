import { NextRequest, NextResponse } from "next/server";
import { verifyMagicToken, createSession, SESSION_COOKIE } from "@/app/lib/session";

/** Validates a magic-link token, sets a 30-day session cookie, redirects to the app. */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || undefined;
  const email = verifyMagicToken(token, Date.now());
  const base = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;

  if (!email) {
    return NextResponse.redirect(`${base}/login?error=expired`);
  }

  const res = NextResponse.redirect(`${base}/optimize`);
  res.cookies.set(SESSION_COOKIE, createSession(email, Date.now()), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
