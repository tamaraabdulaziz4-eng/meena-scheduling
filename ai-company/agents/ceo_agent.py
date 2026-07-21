"""CEO Agent — runs daily, reads all agent outputs, makes top-level decisions, sets weekly priorities."""
import sys, datetime
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))

from base import get_db, log_agent, ask_claude, save_decision, init_db, get_latest_metrics
from config.settings import MODEL_CEO, PRODUCT_NAME

AGENT = "ceo"

def get_all_recent_decisions(limit: int = 20) -> str:
    conn = get_db()
    rows = conn.execute(
        "SELECT agent, decision, rationale, created_at FROM decisions ORDER BY created_at DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    if not rows:
        return "No decisions logged yet."
    lines = []
    for r in rows:
        lines.append(f"  [{r['agent'].upper()}] {r['decision']}: {(r['rationale'] or '')[:100]}")
    return "\n".join(lines)

def get_cost_summary() -> str:
    conn = get_db()
    rows = conn.execute(
        "SELECT agent, COUNT(*) as runs, SUM(tokens_used) as tokens, SUM(cost_usd) as cost "
        "FROM agent_logs WHERE created_at > datetime('now', '-7 days') GROUP BY agent"
    ).fetchall()
    conn.close()
    lines = []
    total_cost = 0
    for r in rows:
        lines.append(f"  {r['agent']}: {r['runs']} runs, {r['tokens']:,} tokens, ${r['cost']:.4f}")
        total_cost += r['cost'] or 0
    lines.append(f"  TOTAL 7-day cost: ${total_cost:.4f}")
    return "\n".join(lines) if lines else "No agent activity yet."

def ceo_daily_brief() -> str:
    metrics = get_latest_metrics()
    decisions = get_all_recent_decisions()
    costs = get_cost_summary()

    prompt = f"""You are the CEO of {PRODUCT_NAME}, an AI-run bootstrapped SaaS company.
Today is {datetime.date.today().isoformat()}.

COMPANY METRICS:
- MRR: ${metrics.get('mrr', 0)}
- Active Subscribers: {metrics.get('active_subscribers', 0)}
- Conversion Rate: {metrics.get('conversion_rate', 0)}%
- Weekly Visitors: {metrics.get('visitors', 0)}
- Churn (recent): {metrics.get('churn_count', 0)}

RECENT AGENT DECISIONS:
{decisions}

AGENT COSTS (7 days):
{costs}

As CEO, write a daily brief that covers:
1. **Company Status** (1 sentence: green/yellow/red and why)
2. **Top Priority This Week** (one specific thing to focus on)
3. **Blocker / Risk** (what could kill growth right now)
4. **Decision**: one concrete action to take TODAY
5. **Agent Instructions**: tell each agent what to prioritize differently this week
6. **30-day Goal**: specific, measurable target

Be direct. This is for an automated company — every word becomes an action."""

    brief, tokens, cost = ask_claude(prompt, MODEL_CEO,
        system="You are a decisive startup CEO. Be specific and action-oriented. No fluff.",
        max_tokens=1500)
    log_agent(AGENT, "daily_brief", brief[:500], tokens, cost)
    save_decision(AGENT, "daily_brief_complete", brief[:300])
    return brief

def run():
    print(f"\n{'='*60}")
    print(f"  {PRODUCT_NAME} — CEO AGENT  [{datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}]")
    print(f"{'='*60}\n")
    init_db()

    # Run all agents in sequence
    print("▶ Running Analytics Agent...")
    import analytics_agent
    analytics_result = analytics_agent.run()

    print("\n▶ Running Pricing Agent...")
    import pricing_agent
    pricing_result = pricing_agent.run()

    print("\n▶ Running Marketing Agent...")
    import marketing_agent
    marketing_result = marketing_agent.run()

    print("\n▶ Running Growth Agent...")
    import growth_agent
    growth_result = growth_agent.run()

    print("\n▶ Running Design Agent...")
    import design_agent
    design_result = design_agent.run()

    print("\n▶ Running Support Agent...")
    import support_agent
    support_result = support_agent.run()

    # CEO synthesizes everything
    print(f"\n{'='*60}")
    print("  CEO DAILY BRIEF")
    print(f"{'='*60}\n")
    brief = ceo_daily_brief()
    print(brief)

    print(f"\n{'='*60}")
    print("  ALL AGENTS COMPLETE")
    print(f"{'='*60}\n")
    return brief

if __name__ == "__main__":
    run()
