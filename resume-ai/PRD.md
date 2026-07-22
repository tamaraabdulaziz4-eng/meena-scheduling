# PRD — ResumeAI (cv.rabit.sa)

## Product
AI resume optimizer + builder for the global and Gulf/Saudi market. Arabic-first UX,
English CV output (what ATS systems and Gulf employers require).

## Problem
75% of resumes are rejected by ATS software before a human reads them. Arabic
speakers are doubly hurt: the strong tools are English-only and subscription-priced.

## Users
1. Saudi/Gulf job seeker (primary) — writes casually in Arabic, needs an English CV
   for Jadarat/Taqat/Aramco/banks. Pays one-time, hates subscriptions.
2. Global job seeker — wants an ATS score + rewrite cheaper than Jobscan ($49.95/mo).

## Core loops
- **Value loop:** free scan → see score + gaps (hook) → pay to unlock rewritten
  resume + cover letter (SAR 35 once / SAR 75 mo).
- **Growth loops:** shareable score cards (/score/[id] + OG image), public resume
  links with attribution (/r/[slug]), 50+8+1 programmatic SEO pages.

## Feature inventory (live)
| Feature | Route | Free? |
|---|---|---|
| ATS scan: score, missing/present keywords, gaps, improvements | /optimize, /ar/optimize | ✅ always free |
| Rewritten English resume | same | 🔒 paid |
| Cover letter | /api/cover-letter | 🔒 paid |
| CV builder (casual Arabic/English → English CV) | /build, /ar/build | ✅ |
| LinkedIn optimizer, Interview prep | /linkedin, /interview | ✅ |
| Templates (incl. Jadarat Saudi), examples | /resume-templates, /resume-examples | ✅ SEO |
| Share score, publish resume link | /score/[id], /r/[slug] | ✅ |
| Account, magic-link auth | /account, /login | ✅ |

## Monetization
- Single: SAR 35 → 24h device pass + account entitlement.
- Monthly: SAR 75 → 30-day unlimited.
- Payment: Paylink (mada/Visa, SAR). Verify checks amount ≥ plan price and binds
  auto-sign-in to the purchasing browser.

## Non-goals (for now)
Job tracker, browser extension, auto-apply, native apps.

## Success metrics
Visits → scans (activation), scans → unlocks (conversion), shared links created
(viral coefficient). Tracked via Vercel Analytics.

## Constraints
- LLM: NVIDIA free API, model `meta/llama-4-maverick-17b-128e-instruct`
  (benchmarked 2026-07: ~6s full scan; old nemotron timed out at 60s).
  `AI_MODEL` env in Vercel overrides code default — keep both in sync.
- Vercel Hobby: 60s function cap effectively; keep generations well under.
- Repo is PUBLIC — never commit secrets; all keys live in Vercel env only.
