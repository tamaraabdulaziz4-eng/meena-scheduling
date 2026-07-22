import { NextRequest, NextResponse } from "next/server";
import { readSession, SESSION_COOKIE } from "@/app/lib/session";
import { getEntitlement } from "@/app/lib/entitlements";
import { verifyPass, verifyEntPass, ACCESS_COOKIE, ENT_COOKIE } from "@/app/lib/access";

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
  // Fall back to the signed entitlement cookie when the server store misses, but
  // only if it belongs to THIS signed-in email — so an infra hiccup can't lock a
  // paid buyer out, and the cookie can never unlock a different account.
  const entCookie = verifyEntPass(req.cookies.get(ENT_COOKIE)?.value, now);
  const cookieUntil = entCookie?.email === email.toLowerCase().trim() ? entCookie.exp : 0;
  const effectiveUntil = Math.max(until, cookieUntil);
  const unlimited = effectiveUntil > now;
  return NextResponse.json({
    signedIn: true,
    email,
    unlimited: unlimited || !!pass,
    until: effectiveUntil,
    hasAccess: unlimited || !!pass,
  });
}
