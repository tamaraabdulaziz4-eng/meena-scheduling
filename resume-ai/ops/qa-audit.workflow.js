export const meta = {
  name: 'resumeai-qa-audit',
  description: '10 agents test 100 user-flow scenarios, then fix the safe high-value issues and verify',
  phases: [
    { title: 'Audit', detail: '10 agents, ~10 real scenarios each across the whole product' },
    { title: 'Triage', detail: 'manager dedupes and selects the safe high-value fixes' },
    { title: 'Fix', detail: 'one senior engineer implements the batch (no write races)' },
    { title: 'Verify', detail: 'QA runs the build and adversarially checks' },
    { title: 'Report', detail: 'full audit + fix report' },
  ],
}

const CTX = `The product is a Next.js 16 app in the "resume-ai/" directory of this repo, live at https://cv.rabit.sa (Arabic: /ar).
It is an AI resume optimizer: free ATS scan + analysis, paid unlock (SAR 35 one-time / 75 monthly) for the rewritten resume, plus an Arabic conversational CV builder, cover-letter/LinkedIn/interview tools, magic-link auth, and Paylink payments.
HOUSE RULES: build must pass ("npm run build" from resume-ai/); never invent user stats/testimonials/ratings; no secrets in this PUBLIC repo; match existing code style.
You have Bash — you may curl the live site (e.g. curl -s https://cv.rabit.sa/ar) and read any file in resume-ai/. You cannot run a real browser, so reason about flows from the code + live HTML + API responses.`

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    scenariosTested: { type: 'number' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scenario: { type: 'string', description: 'the concrete user scenario tested' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          area: { type: 'string' },
          file: { type: 'string' },
          problem: { type: 'string' },
          suggestedFix: { type: 'string' },
          confidence: { type: 'string', enum: ['confirmed', 'likely', 'suspected'] },
        },
        required: ['scenario', 'severity', 'problem', 'suggestedFix'],
      },
    },
  },
  required: ['scenariosTested', 'findings'],
}

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    totalFindings: { type: 'number' },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          spec: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
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

// ── Phase 1: Audit — 10 slices, ~10 scenarios each = ~100 scenarios ──
phase('Audit')
const slices = [
  { key: 'landing-en', brief: 'the English landing page (app/page.tsx): hero, CTAs, pricing section, all header/footer links, FAQ, mobile menu. Verify every link resolves (curl the live paths) and pricing matches SAR 35/75.' },
  { key: 'landing-ar', brief: 'the Arabic landing page (app/ar/page.tsx): RTL correctness, links, pricing, builder links, language switch. Curl https://cv.rabit.sa/ar.' },
  { key: 'optimize-en', brief: 'the English optimize flow (app/optimize/page.tsx + app/api/optimize/route.ts): paste/upload resume, general vs target mode, free scan, freemium lock, before/after proof, error states, empty/oversized input, draft autosave.' },
  { key: 'optimize-ar', brief: 'the Arabic optimize flow (app/ar/optimize/page.tsx): Arabic input -> English resume out, uiLang analysis, freemium lock, before/after, RTL.' },
  { key: 'builder-ar', brief: 'the Arabic conversational CV builder (app/ar/builder/page.tsx + app/api/refine + app/api/build-cv): step order, per-field refine/approve/edit, session persistence, final CV generation, failure/retry.' },
  { key: 'payment', brief: 'the MONEY path (app/pay, app/api/pay, app/pay/callback, app/lib/access, entitlements, paybind): checkout, amount validation, pay cookie, callback verify, unlock after payment, expired-pass 402, the "paid but locked" rescan case. This is the most important slice.' },
  { key: 'auth-account', brief: 'auth + account (app/login, app/api/auth/*, app/account/page.tsx): magic link request/verify, session cookie, "check your inbox" dead-end, account dashboard, public resume links.' },
  { key: 'tools', brief: 'the extra tools (app/api/tools, app/api/cover-letter, app/linkedin, app/interview if present): cover letter gating, LinkedIn optimizer, interview prep — malformed model output handling, empty results, paywall.' },
  { key: 'export-mobile', brief: 'PDF export + copy/download (app/components/PdfExport.tsx) incl. Arabic mojibake guard, .txt download, clipboard; and mobile responsiveness/nav across pages.' },
  { key: 'seo-meta', brief: 'SEO + metadata + trust: sitemap.ts, robots, per-page metadata layouts, resume-examples/resume-skills/cover-letter pages, JSON-LD (must have NO fabricated ratings/reviews), canonical/hreflang, any remaining fabricated testimonials in app/page.tsx.' },
]

const audits = await parallel(
  slices.map((s) => () =>
    agent(
      `${CTX}\n\nYou are QA agent for the "${s.key}" slice. Enumerate ~10 concrete real-user scenarios for: ${s.brief}\n` +
        `For each scenario, actually check it (read the code; curl the live site/API where it helps) and report any bug, dead link, confusing UX, broken state, or integrity issue. ` +
        `Be concrete: file, exact problem, and a specific low-risk fix. Mark severity and your confidence. Report ONLY real issues — an empty findings list is a valid, honest result for a solid slice.`,
      { label: `qa:${s.key}`, phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' },
    ),
  ),
)

const allFindings = audits.filter(Boolean).flatMap((a) => (a.findings || []).map((f) => ({ ...f })))
const totalScenarios = audits.filter(Boolean).reduce((n, a) => n + (a.scenariosTested || 0), 0)
log(`Audited ~${totalScenarios} scenarios; ${allFindings.length} findings`)

// ── Phase 2: Triage ──
phase('Triage')
const triage = await agent(
  `${CTX}\n\nYou are the QA MANAGER. Here are all findings from the 10-agent audit (~${totalScenarios} scenarios):\n${JSON.stringify(allFindings, null, 2)}\n\n` +
    `Dedupe them. Then select the batch of fixes to apply RIGHT NOW: prioritize critical/high issues on the money path and core flows, and only clearly SAFE, well-scoped fixes (no risky refactors on a live payment product). ` +
    `For each selected fix give a precise spec + the files. Defer anything risky or low-value with a one-line reason. Aim for a coherent batch a single engineer can implement in one careful pass.`,
  { label: 'manager:triage', phase: 'Triage', schema: TRIAGE_SCHEMA, effort: 'high' },
)

if (!triage || !triage.fixes || triage.fixes.length === 0) {
  log('Triage selected no fixes — product is solid or only deferrable items remain.')
  return { shippedFixes: false, scenarios: totalScenarios, findings: allFindings.length, triage, note: 'No safe fixes selected this run.' }
}
log(`Triage selected ${triage.fixes.length} fixes to apply now`)

// ── Phase 3: Fix (single engineer = no parallel write races) ──
phase('Fix')
const fixList = triage.fixes
  .map((f, i) => `${i + 1}. [${f.severity}] ${f.title}\n   spec: ${f.spec}\n   files: ${(f.files || []).join(', ')}`)
  .join('\n')
const built = await agent(
  `${CTX}\n\nYou are the SENIOR ENGINEER. Implement this vetted batch of fixes, in order, editing files directly in resume-ai/. Keep each diff tight and in-house style. Do NOT commit.\n\n${fixList}\n\n` +
    `If any single fix turns out to be risky or wrong on closer inspection, SKIP it (list it in fixesSkipped) rather than forcing it — a safe partial batch beats a broken one. ` +
    `When done, run "npm run build" from resume-ai/ yourself and fix any compile errors you introduced. Report exactly what you changed.`,
  { label: 'engineer', phase: 'Fix', schema: BUILD_SCHEMA, effort: 'high' },
)

if (!built || !built.done) {
  return { shippedFixes: false, scenarios: totalScenarios, findings: allFindings.length, error: `Engineer failed: ${built?.summary}`, triage }
}

// ── Phase 4: Verify (one repair attempt) ──
phase('Verify')
let verdict = await agent(
  `${CTX}\n\nYou are QA VERIFICATION. The engineer applied these fixes:\n${(built.fixesApplied || []).join('; ')}\nFiles: ${(built.filesChanged || []).join(', ')}\n\n` +
    `Run "npm run build" from resume-ai/. Then adversarially check the diff (git diff) for regressions on the money path and core flows. Return buildPassed and a ship/block verdict. Block if the build fails or a regression is plausible.`,
  { label: 'qa:verify', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
)

if (verdict && verdict.verdict === 'block') {
  log(`Verify blocked: ${verdict.reason}. One repair attempt.`)
  const repaired = await agent(
    `${CTX}\n\nYou are the SENIOR ENGINEER. QA blocked the batch:\nISSUES: ${(verdict.issues || []).join('; ')}\nREASON: ${verdict.reason}\n\nFix these issues (or revert the specific offending fix), re-run "npm run build" from resume-ai/, and report.`,
    { label: 'engineer:repair', phase: 'Verify', schema: BUILD_SCHEMA, effort: 'high' },
  )
  if (repaired && repaired.done) {
    verdict = await agent(
      `${CTX}\n\nYou are QA. Repair applied: ${repaired.summary}. Run "npm run build" from resume-ai/ once more and give a final ship/block verdict.`,
      { label: 'qa:recheck', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
    )
  }
}

// ── Phase 5: Report ──
phase('Report')
const shipReady = !!verdict && verdict.verdict === 'ship' && verdict.buildPassed
const bySeverity = (sev) => allFindings.filter((f) => f.severity === sev).length
const report = await agent(
  `${CTX}\n\nYou are the QA MANAGER writing the overnight audit report for the founder (who is asleep and wants to wake up to a clear picture). Facts:\n` +
    `Scenarios audited: ~${totalScenarios}\nTotal findings: ${allFindings.length} (critical ${bySeverity('critical')}, high ${bySeverity('high')}, medium ${bySeverity('medium')}, low ${bySeverity('low')})\n` +
    `Fixes applied this run: ${(built.fixesApplied || []).join('; ') || 'none'}\nSkipped: ${(built.fixesSkipped || []).join('; ') || 'none'}\n` +
    `Deferred: ${(triage.deferred || []).join('; ') || 'none'}\nBuild passed: ${verdict?.buildPassed}; verdict: ${verdict?.verdict}\n\n` +
    `Write a clear, honest report in Arabic + English (~15 lines): headline health verdict (is the product ready for paid traffic yet?), what was fixed tonight, the most serious remaining issues, and the single most important next step. No exaggeration.`,
  { label: 'manager:report', phase: 'Report' },
)

return {
  shipReady,
  scenarios: totalScenarios,
  totalFindings: allFindings.length,
  severity: { critical: bySeverity('critical'), high: bySeverity('high'), medium: bySeverity('medium'), low: bySeverity('low') },
  fixesApplied: built.fixesApplied || [],
  fixesSkipped: built.fixesSkipped || [],
  deferred: triage.deferred || [],
  buildPassed: verdict?.buildPassed || false,
  report,
}
