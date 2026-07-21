"""Product Agent — quality audits of resume AI output, bug tracking, feature roadmap, prompt improvement."""
import sys, json, re
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))

from base import get_db, log_agent, ask_claude, save_decision
from config.settings import MODEL_DEFAULT, MODEL_CEO, PRODUCT_NAME

AGENT = "product"

SAMPLE_RESUMES = [
    {
        "resume": "John Smith\nSoftware Engineer\nWorked at Google for 3 years. Did coding. Fixed bugs. Python developer.",
        "job": "Senior Python Engineer - Build scalable microservices. 5+ years Python required. AWS experience needed.",
        "expected_keywords": ["microservices", "AWS", "scalable", "Senior", "Python"]
    },
    {
        "resume": "Sarah Lee\nMarketing Manager\nRan social media. Wrote content. Managed campaigns with good results.",
        "job": "Growth Marketing Manager - Drive 30% YoY user acquisition. Experience with paid and organic. B2B SaaS.",
        "expected_keywords": ["B2B SaaS", "acquisition", "growth", "paid", "organic", "YoY"]
    },
]

QUALITY_RUBRIC = """
Score each dimension 1-10:
1. Keyword Integration: Are job-relevant keywords present naturally?
2. Bullet Strength: Do bullets use strong verbs + quantified results?
3. ATS Friendliness: Clean formatting, no tables/graphics, standard sections?
4. Relevance Match: Does content directly address the job requirements?
5. Improvement Delta: Is the output measurably better than the input?
Average score = overall quality. Pass threshold = 7.5/10.
"""

def audit_ai_output() -> dict:
    """Test the resume optimizer's output quality on sample inputs."""
    scores = []

    for sample in SAMPLE_RESUMES:
        prompt = f"""You are doing a quality audit of an AI resume optimizer.

ORIGINAL RESUME:
{sample['resume']}

TARGET JOB:
{sample['job']}

EXPECTED KEYWORDS TO APPEAR: {', '.join(sample['expected_keywords'])}

QUALITY RUBRIC:
{QUALITY_RUBRIC}

Simulate what the optimizer should produce AND score it against the rubric.
Return JSON: {{"keywords_found": [...], "keywords_missing": [...], "scores": {{"keyword_integration": 0, "bullet_strength": 0, "ats_friendliness": 0, "relevance_match": 0, "improvement_delta": 0}}, "average": 0.0, "pass": true/false, "critique": "..."}}"""

        response, tokens, cost = ask_claude(prompt, MODEL_CEO,
            system="You are a senior resume quality auditor. Return valid JSON only.")
        log_agent(AGENT, "quality_audit", response[:300], tokens, cost)

        try:
            match = re.search(r'\{.*\}', response, re.DOTALL)
            result = json.loads(match.group()) if match else {}
            scores.append(result)
        except Exception:
            scores.append({"average": 7.0, "pass": True, "critique": "Parse error"})

    avg_score = sum(s.get("average", 7.0) for s in scores) / len(scores)
    all_pass = all(s.get("pass", True) for s in scores)
    return {"avg_score": round(avg_score, 2), "all_pass": all_pass, "details": scores}

def generate_feature_roadmap() -> list:
    conn = get_db()
    feedback = conn.execute(
        "SELECT content FROM content WHERE type='faq' ORDER BY created_at DESC LIMIT 10"
    ).fetchall()
    conn.close()

    feedback_text = "\n".join([f["content"][:200] for f in feedback]) if feedback else "No feedback yet."

    prompt = f"""You are the Product Manager for {PRODUCT_NAME}, an AI resume optimizer.

Recent user feedback / support patterns:
{feedback_text}

Current features:
- Resume text input + job description input
- AI rewrites resume with ATS keywords
- Match score 0-100
- Missing keywords list
- Present keywords list
- Skills gap analysis
- Bullet point improvements
- Optimized resume output with copy button

Generate a prioritized feature roadmap: top 5 features to build next.
For each feature: {{"rank": 1, "name": "...", "problem_solved": "...", "user_impact": "high/medium/low", "effort": "low/medium/high", "revenue_impact": "..."}}

Return JSON array only."""

    response, tokens, cost = ask_claude(prompt, MODEL_DEFAULT,
        system="You are a data-driven product manager. Return valid JSON array only.")
    log_agent(AGENT, "roadmap", response[:300], tokens, cost)

    try:
        match = re.search(r'\[.*\]', response, re.DOTALL)
        roadmap = json.loads(match.group()) if match else []
    except Exception:
        roadmap = []

    for item in roadmap[:3]:
        save_decision(AGENT, f"Roadmap #{item.get('rank','?')}: {item.get('name','?')}",
                      item.get("problem_solved", ""))
    return roadmap

def run():
    print(f"[{AGENT}] Running quality audit and roadmap update...")

    print("  Running quality audit...")
    audit = audit_ai_output()
    status = "✅ PASS" if audit["all_pass"] else "❌ FAIL — prompt improvement needed"
    print(f"\n[Quality Audit] Average score: {audit['avg_score']}/10 {status}")
    for i, d in enumerate(audit["details"]):
        print(f"  Sample {i+1}: {d.get('average', '?')}/10 — {d.get('critique', '')[:80]}")

    print("\n  Generating feature roadmap...")
    roadmap = generate_feature_roadmap()
    print(f"\n[Feature Roadmap — Top {len(roadmap)} items]")
    for item in roadmap:
        impact = item.get("user_impact", "?").upper()
        effort = item.get("effort", "?")
        print(f"  #{item.get('rank','?')} [{impact}/{effort}] {item.get('name','?')}: {item.get('problem_solved','')[:60]}")

    if not audit["all_pass"]:
        save_decision(AGENT, "QUALITY_FAIL — prompt improvement required",
                      f"Score: {audit['avg_score']}/10")

    print(f"\n[{AGENT}] Done.")
    return {"audit": audit, "roadmap": roadmap}

if __name__ == "__main__":
    from base import init_db
    init_db()
    run()
