"""Design Agent — reviews conversion metrics, recommends UX/copy improvements to the product."""
from base import get_db, log_agent, ask_claude, save_decision, get_latest_metrics
from config.settings import MODEL_DEFAULT, PRODUCT_NAME

AGENT = "design"

CURRENT_PAGES = {
    "landing": "Hero with headline, stats, how-it-works, features grid, 3 testimonials, pricing (2 plans), CTA footer",
    "optimizer": "Two textareas (resume + JD), submit button, results: score badge, tab for optimized resume, tab for analysis (keywords, improvements)",
}

def generate_design_improvements() -> list[dict]:
    metrics = get_latest_metrics()

    prompt = f"""You are the Design/CRO Agent for {PRODUCT_NAME}, an AI resume optimizer SaaS.

Current pages:
- Landing page: {CURRENT_PAGES['landing']}
- Optimizer tool: {CURRENT_PAGES['optimizer']}

Current metrics:
- Conversion rate: {metrics.get('conversion_rate', 0)}% (visitors → paid)
- Weekly visitors: {metrics.get('visitors', 0)}

Your job: identify 5 high-impact UX/copy improvements to increase conversion rate.
Focus on: above-the-fold copy, social proof, friction reduction, CTA placement, trust signals.

For each improvement specify:
- Page: landing or optimizer
- Element: what to change
- Current state: what it is now
- Proposed change: exactly what to change to
- Expected impact: why this will increase conversions
- Priority: high/medium/low

Return as JSON array: [{{"page": "...", "element": "...", "current": "...", "proposed": "...", "impact": "...", "priority": "..."}}]"""

    response, tokens, cost = ask_claude(prompt, MODEL_DEFAULT,
        system="You are a CRO expert. Return valid JSON array only.")
    log_agent(AGENT, "design_improvements", response[:300], tokens, cost)

    import json, re
    try:
        match = re.search(r'\[.*\]', response, re.DOTALL)
        improvements = json.loads(match.group()) if match else []
    except Exception:
        improvements = []

    for imp in improvements:
        if imp.get("priority") == "high":
            save_decision(AGENT, f"Design: {imp.get('element', '?')}", imp.get("proposed", ""))
    return improvements

def run():
    print(f"[{AGENT}] Running...")
    improvements = generate_design_improvements()
    print(f"\n[Design Improvements — {len(improvements)} recommendations]")
    for imp in sorted(improvements, key=lambda x: x.get("priority", "low")):
        print(f"\n[{imp.get('priority','?').upper()}] {imp.get('page','?')} → {imp.get('element','?')}")
        print(f"  Now:      {imp.get('current','')[:80]}")
        print(f"  Change to: {imp.get('proposed','')[:80]}")
        print(f"  Why:      {imp.get('impact','')[:80]}")
    print(f"\n[{AGENT}] Done.")
    return improvements

if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))
    from base import init_db
    init_db()
    run()
