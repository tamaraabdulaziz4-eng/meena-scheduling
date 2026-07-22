export const meta = {
  name: 'resumeai-daily-shift',
  description: 'One autonomous shift for ResumeAI: scout -> plan -> build -> verify -> ship',
  phases: [
    { title: 'Plan', detail: '3 scouts survey in parallel; manager picks one change' },
    { title: 'Build', detail: 'engineer implements the approved change' },
    { title: 'Verify', detail: 'QA runs the build and checks acceptance' },
    { title: 'Report', detail: 'manager writes the shift report' },
  ],
}

// ── App location + house rules every agent must respect ──
const CTX = `The product is a Next.js 16 app in the "resume-ai/" directory of this repo.
IRON RULES: (1) build must pass: run "npm run build" from resume-ai/ before trusting any change;
(2) never invent user stats, testimonials, ratings, or user counts anywhere in the UI;
(3) no secrets in code — this repo is PUBLIC;
(4) match the surrounding code style; keep diffs tight;
(5) AGENTS.md warns this is a modified Next.js — read node_modules/next/dist/docs/ before using unfamiliar APIs.`

const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          area: { type: 'string' },
          rationale: { type: 'string' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          risk: { type: 'string', enum: ['high', 'medium', 'low'] },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'rationale', 'impact', 'risk'],
      },
    },
  },
  required: ['findings'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    ship: { type: 'boolean', description: 'false if nothing is worth shipping this shift' },
    title: { type: 'string' },
    spec: { type: 'string', description: 'concrete implementation spec for the engineer' },
    files: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'string', description: 'how QA will confirm it works' },
    rationale: { type: 'string' },
    deferred: { type: 'array', items: { type: 'string' } },
  },
  required: ['ship', 'rationale'],
}

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['done', 'summary'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    buildPassed: { type: 'boolean' },
    acceptanceMet: { type: 'boolean' },
    verdict: { type: 'string', enum: ['ship', 'block'] },
    issues: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['buildPassed', 'verdict', 'reason'],
}

// ── Phase 1: Plan ──
phase('Plan')
const lenses = [
  { key: 'bugs-ux', brief: 'bugs, broken flows, mobile issues, accessibility, and rough UX in the live product' },
  { key: 'seo-content', brief: 'SEO gaps, thin/missing content, metadata, and organic-growth opportunities' },
  { key: 'conversion-copy', brief: 'conversion leaks, weak or unclear copy, and paywall/pricing clarity (no fabricated claims)' },
]

const scouted = await parallel(
  lenses.map((l) => () =>
    agent(
      `${CTX}\n\nYou are a SCOUT for the "${l.key}" lens. Survey the codebase for real, concrete opportunities in: ${l.brief}. ` +
        `Read actual files. Return 3-6 findings, each specific enough to implement, with honest impact/risk. Prefer low-risk, high-impact.`,
      { label: `scout:${l.key}`, phase: 'Plan', schema: SCOUT_SCHEMA },
    ),
  ),
)

const allFindings = scouted.filter(Boolean).flatMap((s) => s.findings || [])
log(`Scouts returned ${allFindings.length} findings`)

const plan = await agent(
  `${CTX}\n\nYou are the MANAGER. Here are this shift's scout findings as JSON:\n${JSON.stringify(allFindings, null, 2)}\n\n` +
    `Pick the SINGLE highest-value, lowest-risk change to ship this shift (one coherent change, not a bundle). ` +
    `Write a concrete implementation spec and acceptance criteria the engineer and QA can follow exactly. ` +
    `If genuinely nothing is worth the risk on a live payment product, set ship=false and explain.`,
  { label: 'manager:plan', phase: 'Plan', schema: PLAN_SCHEMA },
)

if (!plan || !plan.ship) {
  log(`Manager decided to ship nothing this shift: ${plan?.rationale || 'no plan returned'}`)
  return { shipped: false, reason: plan?.rationale || 'no plan', deferred: plan?.deferred || [] }
}
log(`Approved: ${plan.title}`)

// ── Phase 2: Build ──
phase('Build')
const built = await agent(
  `${CTX}\n\nYou are the ENGINEER. Implement EXACTLY this approved change and nothing more:\n\n` +
    `TITLE: ${plan.title}\nSPEC: ${plan.spec}\nLIKELY FILES: ${(plan.files || []).join(', ')}\n` +
    `ACCEPTANCE: ${plan.acceptance}\n\n` +
    `Edit the files directly in resume-ai/. Keep the diff tight and in-house style. Do NOT commit — just make the edits. ` +
    `When done, run "npm run build" from resume-ai/ yourself to catch obvious breakage, then report what you changed.`,
  { label: 'engineer', phase: 'Build', schema: BUILD_SCHEMA, effort: 'high' },
)

if (!built || !built.done) {
  return { shipped: false, reason: `Engineer could not complete: ${built?.summary || 'no result'}`, plan }
}

// ── Phase 3: Verify (with one repair attempt) ──
phase('Verify')
let verdict = await agent(
  `${CTX}\n\nYou are QA. A change was just made:\n${built.summary}\nFiles: ${(built.filesChanged || []).join(', ')}\n\n` +
    `ACCEPTANCE CRITERIA: ${plan.acceptance}\n\n` +
    `Run "npm run build" from resume-ai/. Then adversarially check the change for regressions and confirm the acceptance criteria are actually met. ` +
    `Return buildPassed, acceptanceMet, and a ship/block verdict. Block if the build fails OR acceptance is not clearly met.`,
  { label: 'qa', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
)

if (verdict && verdict.verdict === 'block') {
  log(`QA blocked: ${verdict.reason}. Attempting one repair.`)
  const repaired = await agent(
    `${CTX}\n\nYou are the ENGINEER. QA blocked your change:\nISSUES: ${(verdict.issues || []).join('; ')}\nREASON: ${verdict.reason}\n\n` +
      `Fix the issues for: ${plan.title} (spec: ${plan.spec}). Re-run "npm run build" from resume-ai/. Report what you fixed.`,
    { label: 'engineer:repair', phase: 'Verify', schema: BUILD_SCHEMA, effort: 'high' },
  )
  if (repaired && repaired.done) {
    verdict = await agent(
      `${CTX}\n\nYou are QA. The engineer applied a repair: ${repaired.summary}. ` +
        `Run "npm run build" from resume-ai/ again, re-check acceptance (${plan.acceptance}), and return a final ship/block verdict.`,
      { label: 'qa:recheck', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
    )
  }
}

// ── Phase 4: Report ──
phase('Report')
const shipped = !!verdict && verdict.verdict === 'ship' && verdict.buildPassed
const report = await agent(
  `${CTX}\n\nYou are the MANAGER writing the end-of-shift report. Facts:\n` +
    `CHANGE: ${plan.title}\nENGINEER SUMMARY: ${built.summary}\n` +
    `QA VERDICT: ${verdict?.verdict} (build ${verdict?.buildPassed ? 'passed' : 'FAILED'}); ${verdict?.reason}\n` +
    `SHIPPED: ${shipped}\nDEFERRED: ${(plan.deferred || []).join(', ')}\n\n` +
    `Write a concise, honest shift report (Arabic + English, ~8 lines total): what shipped, build status, what's deferred, and the single most valuable thing to do next shift. Do not exaggerate.`,
  { label: 'manager:report', phase: 'Report' },
)

return {
  shipped,
  change: plan.title,
  buildPassed: verdict?.buildPassed || false,
  qaVerdict: verdict?.verdict,
  filesChanged: built.filesChanged || [],
  deferred: plan.deferred || [],
  report,
}
