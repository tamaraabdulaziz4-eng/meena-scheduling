import { NextRequest, NextResponse } from "next/server";
import {
  getMetaCreds,
  createCampaign,
  readInsights,
  setAdStatus,
  setAdSetDailyBudget,
  DAILY_BUDGET_CAP_SAR,
} from "@/lib/metaAds";

/**
 * Admin-only Meta ads control. Protected by ADMIN_SECRET (Bearer token). Every
 * spend path underneath is clamped to DAILY_BUDGET_CAP_SAR, and the Meta account
 * spend cap is the hard backstop. Returns 404 unless BOTH the secret and the Meta
 * credentials are configured — no attack surface until the account is connected.
 *
 *   POST /api/ads   Authorization: Bearer <ADMIN_SECRET>
 *   { "action": "create" | "insights" | "pause" | "activate" | "budget", ... }
 */
export async function POST(req: NextRequest) {
  const secret = process.env.ADMIN_SECRET;
  const creds = getMetaCreds();
  // Hide the endpoint entirely until it's fully configured.
  if (!secret || !creds) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = String(body.action || "");

  try {
    switch (action) {
      case "create": {
        const daily = typeof body.dailyBudgetSar === "number" ? body.dailyBudgetSar : DAILY_BUDGET_CAP_SAR;
        const ids = await createCampaign(creds, daily);
        return NextResponse.json({ ok: true, created: ids, note: "Created PAUSED. Activate when ready." });
      }
      case "insights": {
        const days = typeof body.days === "number" ? body.days : 3;
        return NextResponse.json({ ok: true, insights: await readInsights(creds, days) });
      }
      case "pause":
      case "activate": {
        const adId = String(body.adId || "");
        if (!adId) return NextResponse.json({ error: "adId required" }, { status: 400 });
        await setAdStatus(creds, adId, action === "activate" ? "ACTIVE" : "PAUSED");
        return NextResponse.json({ ok: true, adId, status: action === "activate" ? "ACTIVE" : "PAUSED" });
      }
      case "budget": {
        const adSetId = String(body.adSetId || "");
        const daily = Number(body.dailyBudgetSar);
        if (!adSetId || !Number.isFinite(daily)) return NextResponse.json({ error: "adSetId and dailyBudgetSar required" }, { status: 400 });
        await setAdSetDailyBudget(creds, adSetId, daily);
        return NextResponse.json({ ok: true, adSetId, dailyBudgetSar: Math.min(daily, DAILY_BUDGET_CAP_SAR), cap: DAILY_BUDGET_CAP_SAR });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Ads operation failed" }, { status: 500 });
  }
}
