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

  // Land on the account page with a welcome flag — the user must SEE that
  // sign-in worked (redirecting into a tool with an unchanged nav looked broken).
  const res = NextResponse.redirect(`${base}/account?welcome=1`);
  res.cookies.set(SESSION_COOKIE, createSession(email, Date.now()), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
