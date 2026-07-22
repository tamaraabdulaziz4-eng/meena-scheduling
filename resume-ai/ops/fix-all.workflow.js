export const meta = {
  name: 'resumeai-fix-all',
  description: 'Fix all remaining audit findings in themed sequential batches, build-gated',
  phases: [
    { title: 'Fix', detail: 'four senior engineers, one theme each, sequential (no write races)' },
    { title: 'Verify', detail: 'QA runs the full build and adversarially checks the diff' },
    { title: 'Report', detail: 'what was fixed / skipped' },
  ],
}

const CTX = `ResumeAI is a Next.js 16 app in resume-ai/, live at https://cv.rabit.sa (Arabic /ar). AI resume optimizer: free ATS scan + analysis, paid unlock (SAR 35 once / 75 monthly), Arabic conversational CV builder, cover-letter/LinkedIn/interview tools, magic-link auth, Paylink payments.
IRON RULES: build MUST pass ("npm run build" from resume-ai/); never invent stats/testimonials/reviews; no secrets (PUBLIC repo); match house style; AGENTS.md warns this is a MODIFIED Next.js 16 — read node_modules/next/dist/docs/ before using any unfamiliar API (middleware, next/og, etc.). You have Bash; run the build yourself.
NOTE: email sending WORKS in production (EMAIL_FROM is set; /api/auth/request returns {"ok":true} live). Do not "fix" email by changing providers — only clean misleading fallback code so it fails loudly if EMAIL_FROM is ever unset.`

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string' } },
    buildOk: { type: 'boolean' },
  },
  required: ['done', 'summary'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    buildPassed: { type: 'boolean' },
    verdict: { type: 'string', enum: ['ship', 'block'] },
    issues: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['buildPassed', 'verdict', 'reason'],
}

// Themes have MOSTLY-DISJOINT file sets and run SEQUENTIALLY so there is never a
// concurrent write to the same file. Payment theme first, with the most care.
const THEMES = [
  {
    key: 'payment',
    prompt:
      `Fix these MONEY-PATH findings. Absolute rule: never DENY a legitimate paid buyer, and never GRANT access to someone who did not pay. Read app/api/pay/verify/route.ts, app/pay/callback/page.tsx, app/lib/access.ts, app/lib/entitlements.ts, app/lib/paybind.ts first. Preserve every existing anti-replay / amount-validation guard.\n` +
      `#23 Entitlements not persisted for UNSIGNED buyers (pay but stay locked): add a robust signed httpOnly cookie entitlement as a fallback so a paid buyer keeps access even if the server store misses — mirror the existing paid-pass cookie pattern in lib/access.ts.\n` +
      `#22 pay/verify grants a device pass WITHOUT a paybind check (revenue leak): require the paybind, BUT if the bind cookie has merely expired, fall back to re-verifying the Paylink transaction (status paid + amount matches a known plan + order) before granting — so real buyers on the same browser are never denied.\n` +
      `#24 pay/verify plan defaults to 'single', silently downgrading MONTHLY: derive the plan from the verified PAID AMOUNT (75 SAR -> monthly, 35 SAR -> single) cross-checked with the order, instead of defaulting to single.\n` +
      `#25 Callback shows PENDING payments as "failed" with only "Back to pricing" (nudges a double charge): treat pending distinctly — show a "Refresh status / تحديث الحالة" button that re-polls /api/pay/verify, and never label a pending/processing payment as failed.`,
  },
  {
    key: 'optimize-builder-ux',
    prompt:
      `Fix these UX findings in the optimize + Arabic builder flows. Files: app/optimize/page.tsx, app/ar/optimize/page.tsx, app/ar/builder/page.tsx, app/api/optimize/route.ts.\n` +
      `#10 General mode (no job) shows "MATCH"/verdict language that implies a job match: use neutral quality-review wording when there is no JD.\n` +
      `#11 Draft rehydrate forces target mode from leftover JD text: only switch to target mode when the SAVED mode was target AND a JD is present.\n` +
      `#12 Autosave never clears when BOTH fields are emptied: when resume and jobDescription are both empty, remove the saved draft key.\n` +
      `#16 uiLang='ar' analysis sometimes returns English: strengthen the Arabic-output directive in the prompt (make Arabic mandatory for matchSummary/improvements/ANALYSIS when uiLang='ar').\n` +
      `#20 Builder-ar pending suggestion not persisted (orphan bubble after reload): persist the pending suggestion in the session state so a reload restores it.`,
  },
  {
    key: 'i18n-seo-nav',
    prompt:
      `Fix these i18n/SEO/nav findings. READ node_modules/next docs before adding middleware or next/og.\n` +
      `#3 Root <html lang="en"> is served on /ar (a11y/SEO): set lang="ar" dir="rtl" for Arabic routes. Prefer the smallest correct approach for THIS Next.js 16 (e.g. middleware setting an x-pathname header the root layout reads, or a route-group layout). If it cannot be done safely without deep changes, SKIP and say why.\n` +
      `#6/#36 AR nav links to /ar/build while marketing + MobileMenu link to /ar/builder: unify on /ar/builder (the conversational builder that marketing promotes) as canonical everywhere in the Arabic UI.\n` +
      `#15 The AR "share my score" link opens the fully-English /score page: pass a lang param and render Arabic strings + RTL + an Arabic CTA on /score when lang=ar.\n` +
      `#5 Missing OG/twitter image: add a branded 1200x630 image. Use next/og ImageResponse via an opengraph-image route IF this Next build supports it; otherwise SKIP (do not ship a broken asset).`,
  },
  {
    key: 'cleanup-hardening',
    prompt:
      `Fix these lower-severity cleanup + hardening findings.\n` +
      `#27 Misleading sandbox email fallback (onboarding@resend.dev) in the auth send code: since prod works via EMAIL_FROM, remove the misleading sandbox default so a missing EMAIL_FROM fails loudly instead of silently sending from a sandbox address.\n` +
      `#21 Unused skippable/ORDER symbols in app/ar/builder/page.tsx: remove dead code.\n` +
      `#26 Unused FREE_COOKIE/FREE_LIMIT in app/lib/access.ts: remove dead code/comments.\n` +
      `#29 Welcome banner flashes and vanishes (router.replace flips the reactive param): capture the welcome state into useState so it persists after the URL is cleaned.\n` +
      `#30 Magic-link "one-time" wording overstates the stateless-HMAC guarantee: soften the wording to match reality.\n` +
      `#31 Rate limit not charged on FAILED email sends (unbounded outbound on bounce): charge the rate-limit bucket before attempting the send.\n` +
      `#37 PdfExport doesn't break very long contact-line tokens: enable word-breaking so long emails/URLs don't overflow the PDF.`,
  },
]

// ── Phase 1: Fix (sequential — no concurrent writes) ──
phase('Fix')
const results = []
for (const theme of THEMES) {
  const r = await agent(
    `${CTX}\n\nYou are a SENIOR ENGINEER owning the "${theme.key}" fixes. Implement ONLY these, editing files directly in resume-ai/. Keep diffs tight and in-house style. Do NOT commit.\n\n${theme.prompt}\n\n` +
      `If any single item proves genuinely unsafe or needs an asset/infra you can't create, SKIP just that item (list it in skipped with a reason) — never force a broken change. When done, run "npm run build" from resume-ai/ and fix any compile error you introduced. Set buildOk to whether the build passed. Report fixed[] and skipped[].`,
    { label: `fix:${theme.key}`, phase: 'Fix', schema: BUILD_SCHEMA, effort: 'high' },
  )
  results.push({ theme: theme.key, ...(r || { done: false, summary: 'no result' }) })
  log(`${theme.key}: ${r?.buildOk ? 'build ok' : 'build NOT confirmed'} — fixed ${(r?.fixed || []).length}, skipped ${(r?.skipped || []).length}`)
}

// ── Phase 2: Verify (full build + adversarial diff review; one repair) ──
phase('Verify')
const allFixed = results.flatMap((r) => r.fixed || [])
const allSkipped = results.flatMap((r) => r.skipped || [])
let verdict = await agent(
  `${CTX}\n\nYou are QA VERIFICATION for a multi-theme fix batch. Fixed: ${allFixed.join('; ')}\nFiles touched across themes: ${results.flatMap((r) => r.filesChanged || []).join(', ')}\n\n` +
    `Run "npm run build" from resume-ai/. Then read "git diff" and adversarially check for regressions — ESPECIALLY the payment path (no legitimate buyer denied, no unpaid access granted, anti-replay intact). Return buildPassed + ship/block. Block if the build fails or any payment regression is plausible.`,
  { label: 'qa:verify', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
)

if (verdict && verdict.verdict === 'block') {
  log(`QA blocked: ${verdict.reason}. One repair attempt.`)
  const repaired = await agent(
    `${CTX}\n\nYou are the SENIOR ENGINEER. QA blocked the batch:\nISSUES: ${(verdict.issues || []).join('; ')}\nREASON: ${verdict.reason}\n\nFix these (or revert the specific offending change), re-run "npm run build" from resume-ai/, and report.`,
    { label: 'engineer:repair', phase: 'Verify', schema: BUILD_SCHEMA, effort: 'high' },
  )
  if (repaired && repaired.done) {
    verdict = await agent(
      `${CTX}\n\nYou are QA. Repair applied: ${repaired.summary}. Run "npm run build" from resume-ai/ once more and give a final ship/block verdict (watch the payment path).`,
      { label: 'qa:recheck', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
    )
  }
}

// ── Phase 3: Report ──
phase('Report')
const shipReady = !!verdict && verdict.verdict === 'ship' && verdict.buildPassed
const report = await agent(
  `${CTX}\n\nYou are the lead writing the fix report (founder asleep). Facts:\n` +
    `Themes: ${THEMES.map((t) => t.key).join(', ')}\nFixed: ${allFixed.join('; ') || 'none'}\nSkipped: ${allSkipped.join('; ') || 'none'}\nBuild passed: ${verdict?.buildPassed}; verdict: ${verdict?.verdict}\n\n` +
    `Write a concise honest report (Arabic + English, ~14 lines): which of the 42 findings are now fixed, which were skipped and why (esp. any payment-path items that still need a human decision), whether the product is now ready for paid traffic, and the single most important remaining step.`,
  { label: 'lead:report', phase: 'Report' },
)

return {
  shipReady,
  themes: results.map((r) => ({ theme: r.theme, buildOk: r.buildOk, fixed: r.fixed || [], skipped: r.skipped || [] })),
  totalFixed: allFixed.length,
  totalSkipped: allSkipped.length,
  buildPassed: verdict?.buildPassed || false,
  report,
}
