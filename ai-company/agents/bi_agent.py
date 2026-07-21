"""Business Intelligence Agent — Stripe metrics, cohort analysis, LTV/CAC, financial health."""
import sys, datetime, json
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))

from base import get_db, log_agent, ask_claude, save_decision, get_latest_metrics
from config.settings import MODEL_DEFAULT, PRODUCT_NAME, PRICE_MONTHLY

AGENT = "bi"

def compute_cohort_retention() -> str:
    conn = get_db()
    rows = conn.execute(
        "SELECT date, active_subscribers, churn_count, mrr FROM metrics ORDER BY date DESC LIMIT 30"
    ).fetchall()
    conn.close()
    if len(rows) < 2:
        return "Insufficient data for cohort analysis."

    lines = ["Date         Subs   Churn   MRR"]
    for r in rows[:7]:
        lines.append(f"{r['date']}   {r['active_subscribers']:4d}   {r['churn_count']:5d}   ${r['mrr']:.0f}")
    return "\n".join(lines)

def compute_ltv_estimate() -> dict:
    conn = get_db()
    rows = conn.execute(
        "SELECT churn_count, active_subscribers FROM metrics ORDER BY date DESC LIMIT 30"
    ).fetchall()
    conn.close()
    if not rows:
        return {}

    avg_subs = sum(r["active_subscribers"] for r in rows) / len(rows)
    avg_churn = sum(r["churn_count"] for r in rows) / len(rows)
    monthly_churn_rate = (avg_churn / avg_subs) if avg_subs else 0.05
    avg_lifetime_months = 1 / monthly_churn_rate if monthly_churn_rate else 20
    ltv = avg_lifetime_months * PRICE_MONTHLY
    return {
        "avg_lifetime_months": round(avg_lifetime_months, 1),
        "ltv_usd": round(ltv, 2),
        "monthly_churn_rate_pct": round(monthly_churn_rate * 100, 2),
    }

def generate_bi_report() -> str:
    metrics = get_latest_metrics()
    cohort = compute_cohort_retention()
    ltv = compute_ltv_estimate()

    prompt = f"""You are the Business Intelligence Agent for {PRODUCT_NAME}.

CURRENT METRICS:
- MRR: ${metrics.get('mrr', 0):.0f}
- Active subscribers: {metrics.get('active_subscribers', 0)}
- Conversion rate: {metrics.get('conversion_rate', 0)}%
- Revenue (single): ${metrics.get('revenue_single', 0):.0f}

LTV ANALYSIS:
- Estimated LTV: ${ltv.get('ltv_usd', 0):.2f}
- Avg lifetime: {ltv.get('avg_lifetime_months', 0)} months
- Monthly churn rate: {ltv.get('monthly_churn_rate_pct', 0)}%

SUBSCRIBER TREND (last 7 days):
{cohort}

Write a concise BI report covering:
1. Financial health status (GREEN / YELLOW / RED) with reason
2. MRR growth rate trend
3. Churn risk assessment
4. LTV:CAC ratio assessment (assume CAC=$0 for organic traffic)
5. One financial metric that needs immediate attention
6. 30-day MRR projection

Be precise. Use numbers. This goes to the CEO Agent."""

    report, tokens, cost = ask_claude(prompt, MODEL_DEFAULT,
        system="You are a CFO-level financial analyst. Data-driven, precise, concise.")
    log_agent(AGENT, "bi_report", report[:500], tokens, cost)
    return report

def run():
    print(f"[{AGENT}] Running Business Intelligence analysis...")
    ltv = compute_ltv_estimate()
    report = generate_bi_report()
    save_decision(AGENT, "bi_report_complete",
                  f"LTV=${ltv.get('ltv_usd',0):.0f} churn={ltv.get('monthly_churn_rate_pct',0)}%")
    print(f"\n[BI Report]\n{report}\n")
    print(f"[{AGENT}] LTV data: {ltv}")
    print(f"[{AGENT}] Done.")
    return {"ltv": ltv, "report": report}

if __name__ == "__main__":
    from base import init_db
    init_db()
    run()
