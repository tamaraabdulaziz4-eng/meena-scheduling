"""CEO Agent — orchestrates all 8 agents, writes daily brief, makes top-level decisions."""
import sys, datetime
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))

from base import get_db, log_agent, ask_claude, save_decision, init_db, get_latest_metrics
from config.settings import MODEL_CEO, PRODUCT_NAME

AGENT = "ceo"

def get_all_recent_decisions(limit=25) -> str:
    conn = get_db()
    rows = conn.execute(
        "SELECT agent, decision, rationale, created_at FROM decisions ORDER BY created_at DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    if not rows:
        return "No decisions logged yet."
    return "\n".join(f"  [{r['agent'].upper()}] {r['decision']}: {(r['rationale'] or '')[:100]}"
                     for r in rows)

def get_cost_summary() -> str:
    conn = get_db()
    rows = conn.execute(
        "SELECT agent, COUNT(*) as runs, SUM(tokens_used) as tokens, SUM(cost_usd) as cost "
        "FROM agent_logs WHERE created_at > datetime('now', '-7 days') GROUP BY agent"
    ).fetchall()
    conn.close()
    lines = []
    total = 0
    for r in rows:
        lines.append(f"  {r['agent']:12s}: {r['runs']:3d} runs | {(r['tokens'] or 0):>8,} tokens | ${r['cost'] or 0:.4f}")
        total += r['cost'] or 0
    lines.append(f"  {'TOTAL':12s}: {'':>3s}      | {'':>8s}        | ${total:.4f}")
    return "\n".join(lines) if lines else "No activity yet."

def get_content_queue_summary() -> str:
    conn = get_db()
    rows = conn.execute(
        "SELECT platform, COUNT(*) as count FROM content WHERE status='draft' GROUP BY platform"
    ).fetchall()
    conn.close()
    return ", ".join(f"{r['platform']}:{r['count']}" for r in rows) if rows else "empty"

def ceo_daily_brief() -> str:
    metrics = get_latest_metrics()
    decisions = get_all_recent_decisions()
    costs = get_cost_summary()
    content = get_content_queue_summary()

    prompt = f"""You are the CEO of {PRODUCT_NAME}, a bootstrapped AI SaaS company run by autonomous agents.
Today: {datetime.date.today().isoformat()}

━━ COMPANY METRICS ━━
MRR:                ${metrics.get('mrr', 0):.0f}
Active Subscribers: {metrics.get('active_subscribers', 0)}
Conversion Rate:    {metrics.get('conversion_rate', 0)}%
Weekly Visitors:    {metrics.get('visitors', 0):,}
Churn (recent):     {metrics.get('churn_count', 0)}
Revenue Today:      ${metrics.get('revenue_single', 0) + metrics.get('revenue_monthly', 0):.0f}

━━ AGENT ACTIVITY (7 DAYS) ━━
{costs}

━━ RECENT DECISIONS ━━
{decisions}

━━ CONTENT QUEUE ━━
{content}

Write the Daily CEO Brief:
## Status: [GREEN/YELLOW/RED]
One sentence on company health.

## Top Priority This Week
Single most important thing. Be specific.

## Risk / Blocker
What could kill growth right now.

## Today's Decision
One concrete action to take today.

## Agent Instructions
Quick directive for each agent: Analytics | BI | Pricing | Marketing | Growth | Design | Support | Product

## 30-Day Target
Specific MRR/subscriber goal.

Be sharp. Every word is an action for an autonomous system."""

    brief, tokens, cost = ask_claude(prompt, MODEL_CEO,
        system="You are a decisive startup CEO. Direct, specific, no fluff.", max_tokens=1500)
    log_agent(AGENT, "daily_brief", brief[:500], tokens, cost)
    save_decision(AGENT, "daily_brief", brief[:300])
    return brief

def run():
    sep = "═" * 62
    print(f"\n{sep}")
    print(f"  🤖 {PRODUCT_NAME} — AI COMPANY OS  [{datetime.datetime.now().strftime('%Y-%m-%d %H:%M UTC')}]")
    print(f"{sep}\n")
    init_db()

    agents = [
        ("📊 Analytics",   "analytics_agent"),
        ("💼 Business BI",  "bi_agent"),
        ("💰 Pricing",      "pricing_agent"),
        ("📢 Marketing",    "marketing_agent"),
        ("🚀 Growth",       "growth_agent"),
        ("🎨 Design/CRO",  "design_agent"),
        ("🎧 Support",      "support_agent"),
        ("🔧 Product",      "product_agent"),
    ]

    results = {}
    for label, module_name in agents:
        print(f"▶ Running {label} Agent...")
        try:
            mod = __import__(module_name)
            results[module_name] = mod.run()
            print(f"  ✅ {label} complete\n")
        except Exception as e:
            print(f"  ❌ {label} error: {e}\n")
            log_agent(AGENT, f"agent_error_{module_name}", str(e))

    print(f"\n{sep}")
    print("  🧠 CEO DAILY BRIEF")
    print(f"{sep}\n")
    brief = ceo_daily_brief()
    print(brief)

    print(f"\n{sep}")
    print(f"  ✅ ALL 8 AGENTS COMPLETE — {datetime.datetime.now().strftime('%H:%M UTC')}")
    print(f"{sep}\n")
    return brief

if __name__ == "__main__":
    run()
