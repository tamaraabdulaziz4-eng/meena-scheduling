"""Growth Agent — finds new acquisition channels, generates experiments, tracks growth levers."""
from base import get_db, log_agent, ask_claude, save_decision, get_latest_metrics
from config.settings import MODEL_DEFAULT, PRODUCT_NAME

AGENT = "growth"

CHANNELS = [
    "Reddit (r/jobs, r/resumes, r/cscareerquestions)",
    "LinkedIn organic posting",
    "SEO / blog content",
    "Product Hunt launch",
    "Twitter/X organic",
    "Partnership with career coaches",
    "YouTube tutorial videos",
    "Referral program",
    "Cold email to recent grads",
    "TikTok resume tip videos",
]

def generate_growth_experiments() -> list[dict]:
    metrics = get_latest_metrics()

    prompt = f"""You are the Growth Agent for {PRODUCT_NAME}, a bootstrapped AI resume optimizer.

Current state:
- MRR: ${metrics.get('mrr', 0)}
- Active subscribers: {metrics.get('active_subscribers', 0)}
- Weekly visitors: ~{metrics.get('visitors', 0)}
- Conversion rate: {metrics.get('conversion_rate', 0)}%
- Budget: $0 (bootstrapped, no paid ads)

Available channels:
{chr(10).join(f'  - {c}' for c in CHANNELS)}

Generate 3 specific growth experiments for this week. For each:
- Channel to use
- Exact action to take (be very specific, e.g. "Post in r/resumes on Tuesday at 6pm with title X")
- Expected outcome (e.g. "50 visitors, 3 signups")
- Time investment required
- How to measure success

Return as JSON array: [{{"channel": "...", "action": "...", "expected_outcome": "...", "time_hours": 0, "success_metric": "..."}}]"""

    response, tokens, cost = ask_claude(prompt, MODEL_DEFAULT,
        system="You are a growth hacker. Return valid JSON array only.")
    log_agent(AGENT, "growth_experiments", response[:300], tokens, cost)

    import json, re
    try:
        match = re.search(r'\[.*\]', response, re.DOTALL)
        experiments = json.loads(match.group()) if match else []
    except Exception:
        experiments = []

    for exp in experiments:
        save_decision(AGENT, f"Experiment: {exp.get('channel', '?')}", exp.get("action", ""))
    return experiments

def run():
    print(f"[{AGENT}] Running...")
    experiments = generate_growth_experiments()
    print(f"\n[Growth Experiments This Week — {len(experiments)} planned]")
    for i, exp in enumerate(experiments, 1):
        print(f"\n{i}. {exp.get('channel', '?')}")
        print(f"   Action: {exp.get('action', '')}")
        print(f"   Expected: {exp.get('expected_outcome', '')}")
        print(f"   Time: {exp.get('time_hours', '?')}h")
        print(f"   Measure: {exp.get('success_metric', '')}")
    print(f"\n[{AGENT}] Done.")
    return experiments

if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))
    from base import init_db
    init_db()
    run()
