import { NextRequest, NextResponse } from "next/server";
import { grantPass, grantEntPass, ACCESS_COOKIE, ENT_COOKIE } from "@/app/lib/access";
import { readSession, createSession, SESSION_COOKIE } from "@/app/lib/session";
import { grantEntitlement, getOrderEmail } from "@/app/lib/entitlements";
import { signTx, PAY_BIND_COOKIE } from "@/app/lib/paybind";

export const maxDuration = 30;

const BASE = process.env.PAYLINK_BASE_URL || "https://restapi.paylink.sa";

// The expected price per plan — must match app/api/pay/route.ts. Verification
// checks the amount Paylink actually collected against this so an underpaid or
// tampered invoice can't unlock a full entitlement.
const PLAN_PRICE: Record<string, number> = {
  single: Number(process.env.PRICE_SINGLE || 35),
  complete: Number(process.env.PRICE_COMPLETE || 99),
  monthly: Number(process.env.PRICE_MONTHLY || 75), // legacy (backward-compat)
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

    // The order number carries the plan we invoiced (RA-<plan>-...). Paylink
    // returns it nested under gatewayOrderRequest, not at the top level.
    const orderNumber = String(inv.orderNumber || inv.gatewayOrderRequest?.orderNumber || "");
    const orderPlanRaw = orderNumber.split("-")[1];
    const orderPlan =
      orderPlanRaw === "complete" ? "complete"
      : orderPlanRaw === "monthly" ? "monthly"
      : orderPlanRaw === "single" ? "single"
      : "";

    // Derive the plan from what Paylink ACTUALLY collected — the amount is the
    // source of truth for entitlement value, so a monthly buyer is never
    // silently downgraded to single just because the order number was missing or
    // garbled. Cross-checked with the order plan: if they disagree the amount
    // wins (grant exactly what was paid for — never more, never a downgrade).
    const EPS = 0.01;
    const paidAmount = Number(inv.amount) || 0;
    // Ladder from highest price down — grant exactly the tier the amount covers.
    const amountPlan =
      paidAmount + EPS >= PLAN_PRICE.complete ? "complete"
      : paidAmount + EPS >= PLAN_PRICE.monthly ? "monthly"
      : paidAmount + EPS >= PLAN_PRICE.single ? "single"
      : "";
    const plan = amountPlan || orderPlan || "single";

    // Guard against underpaid / tampered invoices: the amount Paylink actually
    // collected must cover the resolved plan's price before we grant anything.
    const expected = PLAN_PRICE[plan] ?? Infinity;
    const amountOk = paidAmount + EPS >= expected;
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

    // A device pass must be EARNED — never handed out on a bare transactionNo, or
    // a leaked/shared reference would unlock free access (revenue leak). The
    // strongest proof is the pay-bind cookie (this browser started the checkout).
    // But that cookie has only a 2h TTL, so a genuine buyer who lingers on the
    // hosted payment page would be wrongly denied once it expires. For them we
    // fall back to the server-side re-verification we just performed: the invoice
    // is confirmed PAID, the amount matches a known plan price, and the order
    // number is one of ours (RA-<plan>-...). Either proof grants the same-device
    // pass; only the bind cookie is trusted enough to ALSO auto-sign-in / write
    // the account entitlement (that path is unchanged below).
    const orderIsOurs = /^RA-(single|complete|monthly)-/.test(orderNumber);
    const reverified = orderIsOurs && amountPlan !== "";
    const grantDevicePass = entitled && (boundToCaller || reverified);

    if (grantDevicePass) {
      const now = Date.now();
      const windowSec =
        plan === "complete" ? 90 * 24 * 60 * 60
        : plan === "monthly" ? 30 * 24 * 60 * 60
        : 24 * 60 * 60;
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
      const orderEmail = await getOrderEmail(orderNumber);
      // Always write the durable, buyer-email-keyed account entitlement — even
      // when the 2h bind cookie has expired. Keyed strictly to getOrderEmail (the
      // buyer's own email from checkout), never the caller, so it can't leak
      // access, yet it means a genuine buyer who later clears cookies or switches
      // device isn't permanently locked out. The caller-device fallbacks below
      // (auto-sign-in + ENT_COOKIE) stay gated on boundToCaller.
      if (orderEmail) {
        try {
          await grantEntitlement(orderEmail, now + windowSec * 1000);
        } catch (e) {
          console.error("grantEntitlement (order) failed:", e);
        }
      }
      const buyerEmail =
        orderEmail ||
        readSession(req.cookies.get(SESSION_COOKIE)?.value, now);
      if (buyerEmail && boundToCaller) {
        const until = now + windowSec * 1000;
        try {
          await grantEntitlement(buyerEmail, until);
        } catch (e) {
          console.error("grantEntitlement failed:", e);
        }
        // Fallback record of the account entitlement: a signed httpOnly cookie
        // read by the entitlement check when the server store misses (write
        // failed above, or the store isn't configured) — so a paid, signed-in
        // buyer is never locked out by an infra hiccup. Never grants access on
        // its own: the caller must also be signed in as this same email.
        res2.cookies.set(ENT_COOKIE, grantEntPass(buyerEmail, until), {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: windowSec,
        });
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
