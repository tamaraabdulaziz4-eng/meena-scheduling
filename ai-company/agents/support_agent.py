"""Support Agent — generates answers to common support questions, auto-drafts FAQ, handles tickets."""
from base import get_db, log_agent, ask_claude
from config.settings import MODEL_CHEAP, PRODUCT_NAME, PRICE_SINGLE, PRICE_MONTHLY

AGENT = "support"

COMMON_TICKETS = [
    "My optimized resume looks the same, did it actually change anything?",
    "I paid but I can't access the tool",
    "How do I cancel my subscription?",
    "Can you optimize for multiple jobs at once?",
    "Does this work for international resumes (non-US)?",
    "My ATS score is 45, is that good or bad?",
    "How is this different from ChatGPT?",
    "Will hiring managers know my resume was AI-optimized?",
]

def generate_faq() -> list[dict]:
    results = []
    for question in COMMON_TICKETS[:4]:
        prompt = f"""You are a friendly support agent for {PRODUCT_NAME}, an AI resume optimizer.
Product: Users paste their resume + job description → AI rewrites it for ATS, gives match score 0-100, lists missing keywords.
Pricing: ${PRICE_SINGLE} one-time / ${PRICE_MONTHLY}/month unlimited.

Customer question: "{question}"

Write a helpful, honest, concise answer (2-4 sentences max). Be warm and reassuring. Do NOT make up features that don't exist."""
        answer, tokens, cost = ask_claude(prompt, MODEL_CHEAP,
            system="You are a helpful customer support agent. Be friendly, honest, brief.")
        log_agent(AGENT, "faq_answer", answer[:200], tokens, cost)
        results.append({"question": question, "answer": answer})
    return results

def handle_ticket(question: str) -> str:
    prompt = f"""You are a friendly support agent for {PRODUCT_NAME}, an AI resume optimizer.
The tool: users paste resume + job description → AI rewrites it, gives ATS score 0-100, lists missing keywords, rewrites bullet points.
Pricing: ${PRICE_SINGLE} one-time / ${PRICE_MONTHLY}/month unlimited.

Customer says: "{question}"

Reply helpfully and concisely. If you don't know, say so honestly and offer to escalate."""
    answer, tokens, cost = ask_claude(prompt, MODEL_CHEAP,
        system="You are helpful customer support. Be warm, brief, honest.")
    log_agent(AGENT, "handle_ticket", answer[:200], tokens, cost)
    return answer

def save_faq(faqs: list[dict]):
    conn = get_db()
    for faq in faqs:
        conn.execute("INSERT INTO content (type, platform, content, status) VALUES (?,?,?,?)",
                     ("faq", "website", f"Q: {faq['question']}\nA: {faq['answer']}", "draft"))
    conn.commit()
    conn.close()

def run():
    print(f"[{AGENT}] Running...")
    faqs = generate_faq()
    save_faq(faqs)
    print(f"\n[FAQ Generated — {len(faqs)} entries]")
    for faq in faqs:
        print(f"\nQ: {faq['question']}")
        print(f"A: {faq['answer']}")
    print(f"\n[{AGENT}] Done.")
    return faqs

if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))
    from base import init_db
    init_db()
    run()
