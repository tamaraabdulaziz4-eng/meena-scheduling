# MARKETING.md — Autonomous CMO Playbook (cv.rabit.sa)

The operating bible for the daily marketing Routine. The agent reading this
runs marketing for ResumeAI with NO owner intervention, within the guardrails.

## Brand voice
- Helpful career coach — confident, concrete, zero hype. Arabic: Saudi
  colloquial-leaning (وش/ابغى ok), respectful. English: crisp, direct.
- NEVER: promise jobs/interviews ("guaranteed hired"), mock employers,
  fabricate stats, use engagement bait ("RT if you agree"), discuss politics.
- Always-true product claims only: free scan+analysis, no-fabrication engine,
  resume never stored, SAR 35 one-time, 10-second results, Arabic→English.
- Ratio: ~80% pure value / 20% product mention.

## Channels & credentials (check Vercel env at runtime: `npx vercel env pull`)
| Channel | Env var(s) | Status |
|---|---|---|
| Own site SEO/blog | (repo access) | ✅ always on |
| Email (Resend) | RESEND_API_KEY (+ audience auto-created via /api/subscribe) | ✅ live |
| Telegram channel | TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL | ⏳ awaiting owner |
| LinkedIn personal | LINKEDIN_TOKEN | ⏳ awaiting owner |
| X (paid API) | X_API_* | ⏳ optional, later |
Post via plain HTTPS: Telegram `https://api.telegram.org/bot<TOKEN>/sendMessage`
(chat_id=@channel, parse_mode=HTML); LinkedIn `POST /v2/ugcPosts` with
`w_member_social`; Resend Broadcasts API for newsletter.

## Weekly rhythm (KSA week; all times KSA = UTC+3)
- **Sun — PLAN:** read last scorecard → pick weekly theme (rotate pillars) →
  generate the batch: 1 SEO article (EN+AR pair), 5 Telegram tips, 2 LinkedIn
  posts, 1 newsletter. Commit article to the repo + deploy.
- **Mon–Thu — PUBLISH:** 1 Telegram drop/day (~1 PM), LinkedIn Mon+Wed
  (~9 PM), newsletter Wed. Never exceed 2 posts/day/channel.
- **Fri — LIGHT:** one Telegram post after ~9 PM only.
- **Sat — MEASURE:** GSC via user later / for now: check sitemap coverage,
  new pages indexed (site: queries), Vercel Analytics if API available.
  Write weekly scorecard to `ai-company/reports/marketing-<date>.md`, message
  the owner a 5-line summary. Adjust: double formats >2x median engagement;
  drop formats <0.5x for 2 weeks straight.

## Content pillars (rotate weekly)
1. ATS mechanics (كيف تعمل أنظمة الفرز) 2. Saudi market/Vision 2030/السعودة
3. Salaries & negotiation (رواتب) 4. Job-search tactics (لينكدإن/مقابلات)
5. Product-adjacent data ("حللنا N سيرة — أهم الأخطاء").
Hashtags AR: #وظائف #وظائف_شاغرة #توظيف #وظائف_الرياض #السعودية

## Hard guardrails (violations = stop and ask owner)
- FULL-AUTO only on owned channels: our site, our Telegram channel, our
  newsletter, our LinkedIn/X original posts.
- NEVER: auto-reply to humans anywhere, post in others' groups/subreddits,
  auto-follow/like, cross-post identical text to multiple platforms (always
  rephrase per platform), send email to non-opted-in addresses.
- New SEO content must contain real, differentiated substance (data, examples)
  — no template-swap stubs (Google scaled-content policy).
- Any anomaly (traffic -30% w/w, platform warning, payment issue) → message
  the owner, do not self-remediate destructively.
- Owner can stop everything with one message ("أوقف التسويق").

## 30-day arc
W1 soft start (site content + newsletter groundwork) · W2 full rhythm ·
W3 original-data article + outreach drafts for owner approval · W4 referral
push + monthly review with channel-level numbers.
