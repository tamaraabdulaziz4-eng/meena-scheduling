import { NextRequest, NextResponse } from "next/server";
import { grantPass, ACCESS_COOKIE } from "@/app/lib/access";
import { readSession, createSession, SESSION_COOKIE } from "@/app/lib/session";
import { grantEntitlement, getOrderEmail } from "@/app/lib/entitlements";
import { signTx, PAY_BIND_COOKIE } from "@/app/lib/paybind";

export const maxDuration = 30;

const BASE = process.env.PAYLINK_BASE_URL || "https://restapi.paylink.sa";

// The expected price per plan — must match app/api/pay/route.ts. Verification
// checks the amount Paylink actually collected against this so an underpaid or
// tampered invoice can't unlock a full entitlement.
const PLAN_PRICE: Record<string, number> = {
  single: Number(process.env.PRICE_SINGLE || 9),
  monthly: Number(process.env.PRICE_MONTHLY || 19),
};

async function authenticate(): Promise<string> {
  const apiId = process.env.PAYLINK_API_ID;
  const secretKey = process.env.PAYLINK_SECRET_KEY;
  if (!apiId || !secretKey) throw new Error("Paylink credentials are not configured");
  const res = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apiId, secretKey, persistToken: "false" }),
  });
  if (!res.ok) throw new Error(`auth ${res.status}`);
  return (await res.json()).id_token;
}

/** Confirm a payment server-side via Get Invoice — never trust the redirect alone. */
export async function GET(req: NextRequest) {
  try {
    const transactionNo = req.nextUrl.searchParams.get("transactionNo");
    if (!transactionNo) return NextResponse.json({ error: "Missing transactionNo" }, { status: 400 });

    const token = await authenticate();
    const res = await fetch(`${BASE}/api/getInvoice/${encodeURIComponent(transactionNo)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`getInvoice ${res.status}`);
    const inv = await res.json();

    const status = String(inv.orderStatus || "").toLowerCase();
    const paid = status === "paid";

    // Derive the plan from our own order number (RA-<plan>-...). Paylink returns
    // it nested under gatewayOrderRequest, not at the top level.
    const orderNumber = String(inv.orderNumber || inv.gatewayOrderRequest?.orderNumber || "");
    const plan = orderNumber.split("-")[1] === "monthly" ? "monthly" : "single";

    // Guard against underpaid / tampered invoices: the amount Paylink actually
    // collected must cover the plan's price before we grant any entitlement.
    const paidAmount = Number(inv.amount) || 0;
    const expected = PLAN_PRICE[plan] ?? Infinity;
    const amountOk = paidAmount + 0.01 >= expected;
    const entitled = paid && amountOk;

    const res2 = NextResponse.json({
      paid,
      status: inv.orderStatus || "Unknown",
      amount: inv.amount,
      orderNumber,
      plan,
      amountOk,
    });

    // Is this the browser that initiated the checkout? Only then do we trust it
    // enough to auto-sign-in / write the cross-device account entitlement.
    const bindCookie = req.cookies.get(PAY_BIND_COOKIE)?.value || "";
    const [bindTx, bindSig] = bindCookie.split(".");
    const boundToCaller = !!bindTx && bindTx === transactionNo && bindSig === signTx(transactionNo);

    // On confirmed AND fully-paid payment, grant a signed access pass on THIS
    // device (safe — they hold a valid paid transactionNo on this browser).
    if (entitled) {
      const now = Date.now();
      const windowSec = plan === "monthly" ? 30 * 24 * 60 * 60 : 24 * 60 * 60;
      res2.cookies.set(ACCESS_COOKIE, grantPass(plan, now), {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: windowSec,
      });
      // Clear the one-time binding cookie now that it's been used.
      res2.cookies.set(PAY_BIND_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
      // Persist the entitlement to the buyer's ACCOUNT and auto-sign-in — but
      // ONLY for the browser that started this checkout. Without the binding,
      // a replayed/guessed transactionNo would otherwise sign the caller in as
      // the buyer. Prefer the email captured at checkout, else the session.
      const buyerEmail =
        (await getOrderEmail(orderNumber)) ||
        readSession(req.cookies.get(SESSION_COOKIE)?.value, now);
      if (buyerEmail && boundToCaller) {
        try {
          await grantEntitlement(buyerEmail, now + windowSec * 1000);
        } catch (e) {
          console.error("grantEntitlement failed:", e);
        }
        // Auto-sign the buyer in on this device — paying IS proof of the email's owner intent.
        res2.cookies.set(SESSION_COOKIE, createSession(buyerEmail, now), {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: 30 * 24 * 60 * 60,
        });
      }
    }
    return res2;
  } catch (err) {
    console.error("Verify error:", err);
    return NextResponse.json({ error: "Could not verify payment.", paid: false }, { status: 500 });
  }
}
