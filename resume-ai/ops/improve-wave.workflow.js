export const meta = {
  name: 'resumeai-improve-wave',
  description: 'Market-grounded improvement wave: research competitors -> plan -> build -> verify',
  phases: [
    { title: 'Research', detail: 'agents study competitors, Saudi market, conversion & growth best practices' },
    { title: 'Plan', detail: 'manager turns research into a safe high-value improvement batch' },
    { title: 'Build', detail: 'one senior engineer implements the batch' },
    { title: 'Verify', detail: 'QA runs the build and checks for regressions' },
    { title: 'Report', detail: 'wave report' },
  ],
}

const CTX = `ResumeAI is a Next.js 16 app in resume-ai/, live at https://cv.rabit.sa (Arabic /ar). It's an AI resume optimizer: free ATS scan + analysis, paid unlock (SAR 35 once / 75 monthly) for the rewrite, an Arabic conversational CV builder, cover-letter/LinkedIn/interview tools, magic-link auth, Paylink payments. Target market: Saudi/Gulf job seekers, plus global.
GOAL: move the product toward best-in-class (billion-dollar-caliber) quality in conversion, trust, retention, and organic growth — WITHOUT ever fabricating stats, testimonials, or reviews, and without secrets in this PUBLIC repo. Build must pass. Match house style. You have Bash + WebSearch + WebFetch; you can curl the live site.`

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          insight: { type: 'string' },
          source: { type: 'string', description: 'competitor/site/article the insight came from' },
          appliesTo: { type: 'string', description: 'where in ResumeAI this could apply' },
          proposedImprovement: { type: 'string' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          risk: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['insight', 'proposedImprovement', 'impact', 'risk'],
      },
    },
  },
  required: ['insights'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          spec: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
        required: ['title', 'spec'],
      },
    },
    deferred: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'fixes'],
}

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    fixesSkipped: { type: 'array', items: { type: 'string' } },
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

// ── Phase 1: Research (market-grounded) ──
phase('Research')
const lenses = [
  { key: 'competitors', brief: 'Study leading resume tools (Jobscan, Teal, Rezi, Kickresume, Enhancv, Zety). WebSearch their feature sets, onboarding, and paywall/pricing UX. What do the best do that ResumeAI does not? Focus on the free->paid conversion moment.' },
  { key: 'conversion-trust', brief: 'Research SaaS landing-page conversion and trust best practices (real trust signals, not fake reviews), and how top tools reduce friction from first action to payment. Apply to ResumeAI\'s scan->unlock funnel.' },
  { key: 'saudi-market', brief: 'Research the Saudi/Gulf job-seeker market: Jadarat/Taqat, common resume expectations, Arabic-first UX needs, local payment trust (SAR, Paylink/Mada). What would make a Saudi user trust and pay?' },
  { key: 'growth-seo', brief: 'Research organic growth for resume tools: which content/SEO patterns and free-tool loops drive signups, and what ResumeAI can add to compound organic traffic. Concrete, low-risk, implementable.' },
]

const researched = await parallel(
  lenses.map((l) => () =>
    agent(
      `${CTX}\n\nYou are a MARKET RESEARCHER for the "${l.key}" lens. ${l.brief}\n` +
        `Do real research (WebSearch/WebFetch), then read the relevant ResumeAI code to ground each idea. Return concrete, implementable improvements (not vague advice), each tied to a source and a place in the product, with honest impact/risk. Never propose fabricated stats or fake social proof.`,
      { label: `research:${l.key}`, phase: 'Research', schema: RESEARCH_SCHEMA, effort: 'high' },
    ),
  ),
)

const insights = researched.filter(Boolean).flatMap((r) => r.insights || [])
log(`Research produced ${insights.length} grounded insights`)

// ── Phase 2: Plan ──
phase('Plan')
const plan = await agent(
  `${CTX}\n\nYou are the PRODUCT LEAD. Here are market-grounded insights:\n${JSON.stringify(insights, null, 2)}\n\n` +
    `Select a coherent batch of SAFE, high-value improvements to implement now (prefer conversion + trust + growth wins that are low-risk on a live payment product). Give each a precise spec + files. Defer risky/large items with a one-line reason. One engineer must be able to implement the batch in one careful pass. Never include anything that fabricates data.`,
  { label: 'lead:plan', phase: 'Plan', schema: PLAN_SCHEMA, effort: 'high' },
)

if (!plan || !plan.fixes || plan.fixes.length === 0) {
  return { shipped: false, insights: insights.length, note: 'No safe improvements selected this wave.', plan }
}
log(`Planned ${plan.fixes.length} improvements`)

// ── Phase 3: Build (single engineer) ──
phase('Build')
const fixList = plan.fixes.map((f, i) => `${i + 1}. ${f.title}\n   spec: ${f.spec}\n   files: ${(f.files || []).join(', ')}`).join('\n')
const built = await agent(
  `${CTX}\n\nYou are the SENIOR ENGINEER. Implement this vetted improvement batch in order, editing files directly in resume-ai/. Tight, in-house-style diffs. Do NOT commit. Skip (don't force) any item that proves risky on inspection — list it in fixesSkipped. When done, run "npm run build" from resume-ai/ and fix any compile errors. Report exactly what changed.\n\n${fixList}`,
  { label: 'engineer', phase: 'Build', schema: BUILD_SCHEMA, effort: 'high' },
)

if (!built || !built.done) {
  return { shipped: false, insights: insights.length, error: `Engineer failed: ${built?.summary}`, plan }
}

// ── Phase 4: Verify ──
phase('Verify')
let verdict = await agent(
  `${CTX}\n\nYou are QA. Engineer applied: ${(built.fixesApplied || []).join('; ')}\nFiles: ${(built.filesChanged || []).join(', ')}\n` +
    `Run "npm run build" from resume-ai/. Check git diff for regressions on the money path and core flows. Return buildPassed + ship/block. Block if build fails or a regression is plausible.`,
  { label: 'qa:verify', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
)

if (verdict && verdict.verdict === 'block') {
  log(`Verify blocked: ${verdict.reason}. One repair attempt.`)
  const repaired = await agent(
    `${CTX}\n\nYou are the SENIOR ENGINEER. QA blocked: ${(verdict.issues || []).join('; ')} — ${verdict.reason}. Fix or revert the offending change, re-run "npm run build" from resume-ai/, report.`,
    { label: 'engineer:repair', phase: 'Verify', schema: BUILD_SCHEMA, effort: 'high' },
  )
  if (repaired && repaired.done) {
    verdict = await agent(
      `${CTX}\n\nYou are QA. Repair: ${repaired.summary}. Run "npm run build" from resume-ai/ once more; final ship/block verdict.`,
      { label: 'qa:recheck', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
    )
  }
}

// ── Phase 5: Report ──
phase('Report')
const shipReady = !!verdict && verdict.verdict === 'ship' && verdict.buildPassed
const report = await agent(
  `${CTX}\n\nYou are the PRODUCT LEAD writing the wave report (founder is asleep). Facts:\n` +
    `Grounded insights: ${insights.length}\nShipped: ${(built.fixesApplied || []).join('; ') || 'none'}\nSkipped: ${(built.fixesSkipped || []).join('; ') || 'none'}\nDeferred: ${(plan.deferred || []).join('; ') || 'none'}\nBuild: ${verdict?.buildPassed}; verdict: ${verdict?.verdict}\n\n` +
    `Write a concise honest report (Arabic + English, ~12 lines): what market-grounded improvements shipped, why they matter for revenue, and the single most valuable next move. No exaggeration.`,
  { label: 'lead:report', phase: 'Report' },
)

return {
  shipReady,
  insights: insights.length,
  fixesApplied: built.fixesApplied || [],
  fixesSkipped: built.fixesSkipped || [],
  deferred: plan.deferred || [],
  buildPassed: verdict?.buildPassed || false,
  report,
}
