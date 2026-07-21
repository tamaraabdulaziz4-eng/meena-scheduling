import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const BASE = process.env.PAYLINK_BASE_URL || "https://restapi.paylink.sa";

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
    return NextResponse.json({
      paid: status === "paid",
      status: inv.orderStatus || "Unknown",
      amount: inv.amount,
      orderNumber: inv.orderNumber,
    });
  } catch (err) {
    console.error("Verify error:", err);
    return NextResponse.json({ error: "Could not verify payment.", paid: false }, { status: 500 });
  }
}
