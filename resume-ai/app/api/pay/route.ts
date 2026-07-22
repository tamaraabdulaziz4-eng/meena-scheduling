import { NextRequest, NextResponse } from "next/server";
import { setOrderEmail } from "@/app/lib/entitlements";

export const maxDuration = 30;

/**
 * Creates a Paylink invoice and returns the hosted payment-page URL.
 * Flow: authenticate (apiId + secretKey) -> addInvoice -> return `url`.
 * Credentials live only in server-side env vars, never in the client bundle.
 */

const BASE = process.env.PAYLINK_BASE_URL || "https://restapi.paylink.sa";
const CURRENCY = process.env.PAY_CURRENCY || "USD";

const PLANS: Record<string, { title: string; amount: number }> = {
  single: { title: "ResumeAI — Single Optimization", amount: Number(process.env.PRICE_SINGLE || 9) },
  monthly: { title: "ResumeAI — Unlimited (1 month)", amount: Number(process.env.PRICE_MONTHLY || 19) },
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
  if (!res.ok) throw new Error(`Paylink auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!data.id_token) throw new Error("Paylink auth returned no token");
  return data.id_token;
}

export async function POST(req: NextRequest) {
  try {
    const { plan, name, email, mobile } = await req.json();

    const chosen = PLANS[plan];
    if (!chosen) return NextResponse.json({ error: "Unknown plan." }, { status: 400 });
    if (!name || String(name).trim().length < 2) {
      return NextResponse.json({ error: "Please enter your name." }, { status: 400 });
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
      return NextResponse.json({ error: "Please enter a valid email — it's how your access is unlocked." }, { status: 400 });
    }
    if (!mobile || !/^\d{6,15}$/.test(String(mobile).replace(/[\s+]/g, ""))) {
      return NextResponse.json({ error: "Please enter a valid mobile number." }, { status: 400 });
    }

    const token = await authenticate();

    const origin = req.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";
    // Encode the plan in the order number — Paylink echoes it back on Get Invoice,
    // so verification can trust which plan was actually paid for.
    const orderNumber = `RA-${plan}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const res = await fetch(`${BASE}/api/addInvoice`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        orderNumber,
        amount: chosen.amount,
        currency: CURRENCY,
        clientName: String(name).trim(),
        clientMobile: String(mobile).replace(/[\s+]/g, ""),
        callBackUrl: `${origin}/pay/callback`,
        note: chosen.title,
        products: [{ title: chosen.title, price: chosen.amount, qty: 1 }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`addInvoice ${res.status}: ${body.slice(0, 300)}`);
    }
    const invoice = await res.json();
    if (!invoice.url) throw new Error("Paylink did not return a payment URL");

    // Remember which email bought this order so verification can unlock the account.
    try {
      await setOrderEmail(orderNumber, String(email));
    } catch (e) {
      console.error("setOrderEmail failed:", e);
    }

    return NextResponse.json({ url: invoice.url, orderNumber, transactionNo: invoice.transactionNo });
  } catch (err) {
    console.error("Pay error:", err);
    return NextResponse.json(
      { error: "Could not start checkout. Please try again.", detail: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
