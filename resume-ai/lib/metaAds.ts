/**
 * Autonomous Meta (Facebook/Instagram) ads module.
 *
 * Drives the Meta Marketing API (Graph API) to create and manage the paid
 * acquisition campaign for ResumeAI without manual steps. Reads all credentials
 * from environment variables — nothing is ever hard-coded (this repo is public):
 *
 *   META_SYSTEM_USER_TOKEN   non-expiring system-user token, scope ads_management
 *   META_AD_ACCOUNT_ID       e.g. act_1234567890
 *   META_PAGE_ID             the Facebook Page the ads run under
 *
 * SAFETY: every spend path is bounded by DAILY_BUDGET_CAP_SAR. The module never
 * raises budget above it, and the user's Meta-side account spend cap is the hard
 * backstop underneath. Read-only insights are always safe to call.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

// Hard ceiling this module will never exceed on its own. Raising it is a
// deliberate, human-approved change to this constant — not something a shift does.
export const DAILY_BUDGET_CAP_SAR = 15;

export interface MetaCreds {
  token: string;
  adAccountId: string; // act_XXXX
  pageId: string;
}

export function getMetaCreds(): MetaCreds | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  const pageId = process.env.META_PAGE_ID;
  if (!token || !adAccountId || !pageId) return null;
  return { token, adAccountId, pageId };
}

/** Meta expects minor units (halalas for SAR). */
function sar(amount: number): string {
  return String(Math.round(amount * 100));
}

async function graph(
  path: string,
  method: "GET" | "POST",
  token: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  const res =
    method === "GET"
      ? await fetch(`${url}?${body}`)
      : await fetch(url, { method, body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || json.error) {
    const err = json.error as { message?: string } | undefined;
    throw new Error(`Meta API ${res.status}: ${err?.message || JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

/** The ready Arabic ad — mirrors CAMPAIGN.md, points at the Arabic landing page. */
export const AD_CREATIVE = {
  message:
    "٧٥٪ من السير الذاتية يرفضها نظام التوظيف قبل أن يراها بشر. افحص سيرتك مجاناً، اكتشف الكلمات الناقصة، واحصل على نسخة محسّنة تعبر الفلتر — بدون اختلاق أي معلومة.",
  link: "https://cv.rabit.sa/ar",
  name: "حسّن سيرتك الذاتية بالذكاء الاصطناعي — فحص مجاني",
  description: "نسبة توافق سيرتك مع الوظيفة + الكلمات الناقصة، بالثواني.",
};

/**
 * Create the full campaign → ad set → ad, PAUSED, so a human (or the next shift
 * after review) flips it live. Targets Saudi Arabia, job-seeker interests.
 * Daily budget is clamped to DAILY_BUDGET_CAP_SAR.
 */
export async function createCampaign(
  creds: MetaCreds,
  dailyBudgetSar = DAILY_BUDGET_CAP_SAR,
): Promise<{ campaignId: string; adSetId: string; adId: string }> {
  const budget = Math.min(dailyBudgetSar, DAILY_BUDGET_CAP_SAR);
  const { token, adAccountId, pageId } = creds;

  const campaign = await graph(`${adAccountId}/campaigns`, "POST", token, {
    name: "ResumeAI — SA Traffic (auto)",
    objective: "OUTCOME_TRAFFIC",
    status: "PAUSED",
    special_ad_categories: "[]",
  });
  const campaignId = campaign.id as string;

  const adSet = await graph(`${adAccountId}/adsets`, "POST", token, {
    name: "SA — job seekers",
    campaign_id: campaignId,
    daily_budget: sar(budget),
    billing_event: "IMPRESSIONS",
    optimization_goal: "LINK_CLICKS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    status: "PAUSED",
    targeting: JSON.stringify({
      geo_locations: { countries: ["SA"] },
      age_min: 20,
      age_max: 45,
      publisher_platforms: ["facebook", "instagram"],
    }),
  });
  const adSetId = adSet.id as string;

  const creative = await graph(`${adAccountId}/adcreatives`, "POST", token, {
    name: "ResumeAI AR creative",
    object_story_spec: JSON.stringify({
      page_id: pageId,
      link_data: {
        message: AD_CREATIVE.message,
        link: AD_CREATIVE.link,
        name: AD_CREATIVE.name,
        description: AD_CREATIVE.description,
        call_to_action: { type: "LEARN_MORE", value: { link: AD_CREATIVE.link } },
      },
    }),
  });
  const creativeId = creative.id as string;

  const ad = await graph(`${adAccountId}/ads`, "POST", token, {
    name: "ResumeAI AR ad",
    adset_id: adSetId,
    creative: JSON.stringify({ creative_id: creativeId }),
    status: "PAUSED",
  });

  return { campaignId, adSetId, adId: ad.id as string };
}

export interface AdInsight {
  adId: string;
  name: string;
  spendSar: number;
  clicks: number;
  impressions: number;
  cpcSar: number | null;
  purchases: number;
  costPerPurchaseSar: number | null;
}

/** Read per-ad performance (last N days) so a shift can decide what to pause/scale. */
export async function readInsights(creds: MetaCreds, days = 3): Promise<AdInsight[]> {
  const { token, adAccountId } = creds;
  const json = await graph(`${adAccountId}/insights`, "GET", token, {
    level: "ad",
    date_preset: days <= 1 ? "today" : days <= 7 ? "last_7d" : "last_30d",
    fields: "ad_id,ad_name,spend,clicks,impressions,cpc,actions",
  });
  const rows = (json.data as Record<string, unknown>[]) || [];
  return rows.map((r) => {
    const actions = (r.actions as { action_type: string; value: string }[]) || [];
    const purchases = actions
      .filter((a) => a.action_type.includes("purchase"))
      .reduce((n, a) => n + Number(a.value || 0), 0);
    const spend = Number(r.spend || 0);
    return {
      adId: String(r.ad_id || ""),
      name: String(r.ad_name || ""),
      spendSar: spend,
      clicks: Number(r.clicks || 0),
      impressions: Number(r.impressions || 0),
      cpcSar: r.cpc ? Number(r.cpc) : null,
      purchases,
      costPerPurchaseSar: purchases > 0 ? spend / purchases : null,
    };
  });
}

export async function setAdStatus(
  creds: MetaCreds,
  adId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<void> {
  await graph(adId, "POST", creds.token, { status });
}

/** Clamp helper the shift must route every budget change through. */
export async function setAdSetDailyBudget(
  creds: MetaCreds,
  adSetId: string,
  dailyBudgetSar: number,
): Promise<void> {
  const clamped = Math.min(dailyBudgetSar, DAILY_BUDGET_CAP_SAR);
  await graph(adSetId, "POST", creds.token, { daily_budget: sar(clamped) });
}
