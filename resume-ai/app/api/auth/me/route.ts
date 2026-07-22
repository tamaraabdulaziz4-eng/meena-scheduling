import { NextRequest, NextResponse } from "next/server";
import { readSession, SESSION_COOKIE } from "@/app/lib/session";
import { getEntitlement } from "@/app/lib/entitlements";
import { verifyPass, ACCESS_COOKIE } from "@/app/lib/access";

/** Returns sign-in state, account entitlement, AND device-pass access —
 * `hasAccess` is the single flag the UI needs: can this browser get the
 * full (unlocked) resume right now? */
export async function GET(req: NextRequest) {
  const now = Date.now();
  const pass = verifyPass(req.cookies.get(ACCESS_COOKIE)?.value, now);
  const email = readSession(req.cookies.get(SESSION_COOKIE)?.value, now);

  if (!email) {
    return NextResponse.json({ signedIn: false, hasAccess: !!pass });
  }

  const until = await getEntitlement(email);
  const unlimited = until > now;
  return NextResponse.json({
    signedIn: true,
    email,
    unlimited: unlimited || !!pass,
    until,
    hasAccess: unlimited || !!pass,
  });
}
