"""Analytics Agent — tracks metrics, computes KPIs, seeds daily snapshots."""
import datetime
import random
from base import get_db, log_agent, ask_claude, save_decision
from config.settings import MODEL_CHEAP, PRODUCT_NAME

AGENT = "analytics"

def seed_todays_metrics():
    """In production: pull from Stripe, Vercel Analytics, etc. Here we seed realistic data."""
    conn = get_db()
    today = datetime.date.today().isoformat()
    existing = conn.execute("SELECT id FROM metrics WHERE date=?", (today,)).fetchone()
    if existing:
        conn.close()
        return

    last = conn.execute("SELECT * FROM metrics ORDER BY date DESC LIMIT 1").fetchone()
    if last:
        visitors = max(10, int(last["visitors"] * random.uniform(0.9, 1.15)))
        subs = last["active_subscribers"] + random.randint(-1, 3)
        subs = max(0, subs)
        churn = random.randint(0, max(0, int(subs * 0.03)))
        signups = random.randint(0, max(1, int(visitors * 0.04)))
        rev_s = random.randint(0, 5) * 9
        mrr = subs * 19
    else:
        visitors, subs, churn, signups, rev_s, mrr = 120, 8, 0, 3, 9, 152

    conv = round(signups / visitors * 100, 2) if visitors else 0
    conn.execute("""INSERT INTO metrics
        (date, visitors, signups, revenue_single, revenue_monthly, mrr, active_subscribers, churn_count, support_tickets, conversion_rate)
        VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (today, visitors, signups, rev_s, mrr, mrr, subs, churn, random.randint(0, 4), conv))
    conn.commit()
    conn.close()
    log_agent(AGENT, "seed_metrics", f"date={today} visitors={visitors} mrr={mrr} subs={subs}")

def compute_weekly_report() -> str:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM metrics ORDER BY date DESC LIMIT 7"
    ).fetchall()
    conn.close()
    if not rows:
        return "No data yet."

    total_visitors = sum(r["visitors"] for r in rows)
    total_signups = sum(r["signups"] for r in rows)
    total_rev = sum(r["revenue_single"] + r["revenue_monthly"] for r in rows)
    latest_mrr = rows[0]["mrr"]
    avg_conv = round(sum(r["conversion_rate"] for r in rows) / len(rows), 2)
    total_churn = sum(r["churn_count"] for r in rows)

    report = f"""
WEEKLY REPORT — {PRODUCT_NAME}
Period: {rows[-1]['date']} to {rows[0]['date']}
━━━━━━━━━━━━━━━━━━━━━━
Visitors:         {total_visitors:,}
Signups:          {total_signups}
Revenue:          ${total_rev:.0f}
MRR:              ${latest_mrr:.0f}
Avg Conversion:   {avg_conv}%
Churn (7d):       {total_churn}
Subscribers:      {rows[0]['active_subscribers']}
━━━━━━━━━━━━━━━━━━━━━━"""
    return report

def run():
    print(f"[{AGENT}] Running...")
    seed_todays_metrics()
    report = compute_weekly_report()

    prompt = f"""You are the Analytics Agent for {PRODUCT_NAME}.
Here is this week's data:

{report}

Analyze the metrics. Identify:
1. What's working well
2. Top concern / risk
3. One specific action the team should take this week
4. Forecast: MRR in 30 days if trend continues

Be concise and data-driven."""

    analysis, tokens, cost = ask_claude(prompt, MODEL_CHEAP,
        system="You are a sharp SaaS analytics expert. Be brief and actionable.")
    log_agent(AGENT, "weekly_analysis", analysis, tokens, cost)
    save_decision(AGENT, "weekly_analysis_complete", analysis[:500])
    print(report)
    print(f"\n[AI Analysis]\n{analysis}\n")
    print(f"[{AGENT}] Done. Tokens: {tokens}, Cost: ${cost:.4f}")
    return {"report": report, "analysis": analysis}

if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))
    from base import init_db
    init_db()
    run()
