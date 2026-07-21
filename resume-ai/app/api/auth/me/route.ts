import { NextRequest, NextResponse } from "next/server";
import { readSession, SESSION_COOKIE } from "@/app/lib/session";
import { getEntitlement } from "@/app/lib/entitlements";

/** Returns the signed-in email and whether the account has unlimited access. */
export async function GET(req: NextRequest) {
  const email = readSession(req.cookies.get(SESSION_COOKIE)?.value, Date.now());
  if (!email) return NextResponse.json({ signedIn: false });

  const until = await getEntitlement(email);
  return NextResponse.json({
    signedIn: true,
    email,
    unlimited: until > Date.now(),
    until,
  });
}
