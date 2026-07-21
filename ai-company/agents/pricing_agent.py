"""Pricing Agent — monitors conversion rates, recommends and logs pricing experiments."""
import datetime
from base import get_db, log_agent, ask_claude, save_decision, get_latest_metrics
from config.settings import MODEL_DEFAULT, PRODUCT_NAME, PRICE_SINGLE, PRICE_MONTHLY

AGENT = "pricing"

PRICING_VARIANTS = [
    {"name": "control",   "single": 9,  "monthly": 19},
    {"name": "premium",   "single": 14, "monthly": 29},
    {"name": "value",     "single": 7,  "monthly": 15},
    {"name": "annual",    "single": 9,  "monthly": 19, "annual": 149},
]

def get_pricing_history() -> str:
    conn = get_db()
    tests = conn.execute(
        "SELECT * FROM pricing_tests ORDER BY created_at DESC LIMIT 10"
    ).fetchall()
    conn.close()
    if not tests:
        return "No pricing tests run yet."
    lines = []
    for t in tests:
        conv = round(t["conversions"] / t["visitors"] * 100, 2) if t["visitors"] else 0
        lines.append(f"  {t['variant']}: ${t['price_single']}/${t['price_monthly']}/mo — "
                     f"{t['visitors']} visitors, {t['conversions']} conversions ({conv}%)")
    return "\n".join(lines)

def recommend_pricing() -> dict:
    metrics = get_latest_metrics()
    history = get_pricing_history()

    prompt = f"""You are the Pricing Agent for {PRODUCT_NAME}, an AI resume optimizer.

Current pricing: ${PRICE_SINGLE} one-time / ${PRICE_MONTHLY}/month
Current metrics:
- MRR: ${metrics.get('mrr', 0)}
- Subscribers: {metrics.get('active_subscribers', 0)}
- Conversion rate: {metrics.get('conversion_rate', 0)}%
- Weekly visitors: ~{metrics.get('visitors', 0)}

Pricing test history:
{history}

Available variants to test next:
{chr(10).join(f"  - {v['name']}: ${v['single']} one-time / ${v.get('monthly', PRICE_MONTHLY)}/mo" for v in PRICING_VARIANTS)}

Recommend:
1. Which pricing variant to test next and WHY
2. What conversion rate improvement do you expect
3. At what conversion rate should we kill this test and revert
4. Estimated MRR impact if it works

Return as JSON: {{"variant": "name", "rationale": "...", "expected_lift": "...", "kill_threshold": 0.0, "mrr_impact": 0}}"""

    response, tokens, cost = ask_claude(prompt, MODEL_DEFAULT,
        system="You are a SaaS pricing expert. Return valid JSON only.")
    log_agent(AGENT, "pricing_recommendation", response, tokens, cost)

    try:
        import json, re
        match = re.search(r'\{.*\}', response, re.DOTALL)
        rec = json.loads(match.group()) if match else {}
    except Exception:
        rec = {"variant": "control", "rationale": response[:200]}

    save_decision(AGENT, f"Test variant: {rec.get('variant', '?')}", rec.get("rationale", ""))
    return rec

def log_pricing_test(variant: str, single: float, monthly: float):
    conn = get_db()
    conn.execute(
        "INSERT INTO pricing_tests (variant, price_single, price_monthly) VALUES (?,?,?)",
        (variant, single, monthly)
    )
    conn.commit()
    conn.close()
    log_agent(AGENT, "start_test", f"variant={variant} ${single}/${monthly}")

def run():
    print(f"[{AGENT}] Running...")
    rec = recommend_pricing()
    print(f"\n[Pricing Recommendation]\n{rec}\n")

    # Auto-log the test
    variant_name = rec.get("variant", "control")
    variant_data = next((v for v in PRICING_VARIANTS if v["name"] == variant_name), PRICING_VARIANTS[0])
    log_pricing_test(variant_name, variant_data["single"], variant_data.get("monthly", PRICE_MONTHLY))
    print(f"[{AGENT}] Test logged: {variant_name}")
    return rec

if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))
    from base import init_db
    init_db()
    run()
