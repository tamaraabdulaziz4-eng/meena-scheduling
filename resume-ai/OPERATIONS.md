# ResumeAI — Autonomous Operations Charter

This product is run as a small autonomous company of AI agents working in
scheduled **shifts**. A manager plans and reviews; specialists do the work;
nothing ships unless the build passes and a verifier signs off.

## Roster

| Role | Responsibility |
| --- | --- |
| **Manager** | Plans each shift, picks the single highest-value / lowest-risk change, reviews the result, writes the shift report, and makes the final go/no-go. |
| **Scouts** (×3) | Independently survey the product for opportunities — one for bugs/UX, one for SEO/content, one for conversion/copy. Blind to each other. |
| **Engineer** | Implements the one change the manager approved. Edits files directly, keeps the diff tight and in-house style. |
| **QA / Verifier** | Runs `npm run build`, adversarially checks the change for regressions, and returns a ship/block verdict. |

## Iron rules (never overridden)

1. **Build gate.** `npm run build` (in `resume-ai/`) MUST pass before anything is committed. A failing build blocks the shift.
2. **One coherent change per shift.** No sprawling multi-feature diffs. Parallelism is for *finding* and *verifying*, never for concurrent writing.
3. **No fabrication.** The product's core promise — never invent a user's numbers, employers, or achievements — extends to marketing copy and stats on the site. No made-up testimonials, user counts, or ratings.
4. **No secrets in the repo.** This repository is public. Credentials live only in the environment/Vercel env vars.
5. **Low-risk first.** Prefer reversible, well-scoped improvements over risky refactors on a live product that takes real payments.
6. **Honesty in reports.** If a shift shipped nothing, the report says so plainly.

## Shift lifecycle

1. **Plan** — 3 scouts survey in parallel → manager synthesizes one approved change with a concrete spec + acceptance criteria.
2. **Build** — engineer implements the spec.
3. **Verify** — QA runs the build, checks acceptance, returns ship/block.
4. **Ship** — on `ship`: commit to `claude/crawl4ai-install-o0j8wf`, push, and (if `VERCEL_TOKEN` is set in the environment) deploy to production from `resume-ai/`.
5. **Report** — manager writes a short shift report: what shipped, what was deferred, what's next.

## Deploy

Production deploys run from `resume-ai/` via the Vercel CLI and require
`VERCEL_TOKEN` to be present as an environment variable in the shift's
environment. It is intentionally **not** stored in this public repo. Until it
is set, shifts complete every step up to (and including) `git push`, and the
report flags the deploy as pending a token.

The Vercel project link lives at `resume-ai/.vercel/project.json`
(project "resume-ai"). Always run Vercel commands from `resume-ai/`, never the
repo root.
