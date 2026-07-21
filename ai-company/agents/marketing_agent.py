"""Marketing Agent — generates daily content: tweets, LinkedIn posts, SEO blog drafts, email sequences."""
import datetime
from base import get_db, log_agent, ask_claude
from config.settings import MODEL_DEFAULT, PRODUCT_NAME, PRODUCT_URL

AGENT = "marketing"

CONTENT_TYPES = [
    ("twitter", "A viral tweet thread (5 tweets) about resume mistakes that cost people jobs"),
    ("linkedin", "A LinkedIn post about how AI is changing the job search in 2026"),
    ("twitter", "A single punchy tweet with a resume tip + soft CTA to try ResumeAI"),
    ("seo_blog", "SEO blog post outline: '10 ATS Keywords That Will Get Your Resume Noticed in 2026'"),
    ("email", "Cold email sequence (3 emails) to job seekers who visited but didn't buy"),
    ("twitter", "Tweet: Before/After example of a weak resume bullet vs strong one"),
    ("linkedin", "LinkedIn post: Story about someone who got 0 interviews → 5 offers after optimizing"),
]

def get_todays_content_type() -> tuple[str, str]:
    day = datetime.date.today().weekday()
    return CONTENT_TYPES[day % len(CONTENT_TYPES)]

def generate_content(platform: str, brief: str) -> str:
    prompt = f"""You are the Marketing Agent for {PRODUCT_NAME} ({PRODUCT_URL}).
{PRODUCT_NAME} is an AI resume optimizer: users paste their resume + a job description and get a fully rewritten, ATS-optimized resume in 60 seconds. Pricing: $9 one-time or $19/month unlimited.

Today's content task: {brief}

Requirements:
- Platform: {platform}
- Tone: helpful, confident, relatable — NOT salesy or spammy
- Include a soft CTA to {PRODUCT_URL} where appropriate
- Use real pain points: ATS rejections, spending hours on resumes, no callbacks
- Make it shareable and valuable even without clicking the link

Write the content now. Return only the final content, ready to post."""

    content, tokens, cost = ask_claude(prompt, MODEL_DEFAULT,
        system="You are a growth marketer who writes content that converts. Be concise and human.")
    log_agent(AGENT, f"generate_{platform}", content[:300], tokens, cost)
    return content

def save_content(platform: str, content: str):
    conn = get_db()
    conn.execute("INSERT INTO content (type, platform, content, status) VALUES (?,?,?,?)",
                 ("marketing", platform, content, "draft"))
    conn.commit()
    conn.close()

def get_content_queue() -> list:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM content WHERE status='draft' ORDER BY created_at DESC LIMIT 5"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def run():
    print(f"[{AGENT}] Running...")
    platform, brief = get_todays_content_type()
    print(f"  Generating {platform} content: {brief[:60]}...")
    content = generate_content(platform, brief)
    save_content(platform, content)
    print(f"\n[{platform.upper()} CONTENT]\n{content}\n")
    print(f"[{AGENT}] Content saved to queue. {len(get_content_queue())} items in queue.")
    return {"platform": platform, "content": content}

if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))
    from base import init_db
    init_db()
    run()
