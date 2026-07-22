# DESIGN.md — Execution blueprint (not just colors)

## Visual system
- Dark-only "SaaS Noir": bg `#08090a`, surface `#101316`, accent `#4ade80`,
  danger `#f87171`, warn `#fbbf24`. Inter body, mono for data/chips.
- Living hero: 3 blurred orbs (26–34s independent drift), grid-lines mask, dual
  glow drift, film-grain overlay (3–5% opacity), looping ScanDemo (scan → 92% →
  hold 5.2s → rewind). LiveTicker rotates curated events every 3.8s. ATS marquee
  32s loop, pause on hover. ALL animation is pure CSS/requestAnimationFrame and
  MUST be gated behind `prefers-reduced-motion: no-preference`.

## UX flows

### Scan flow (optimize, EN/AR)
paste/upload → submit → streaming NDJSON: `think` (live analysis panel, shows
placeholder immediately — never a frozen spinner) → `result` → score card + tabs.
- **Freemium gate (server-side only):** free callers get `locked:true` + first 6
  lines of the resume. The full text NEVER leaves the server for free users.
- **Locked card states:** no access → pricing CTA; `hasAccess` (from
  /api/auth/me) → "Payment confirmed — rescan to unlock" one-click `runScan()`.
  This exists because results persist client-side and may predate payment.

### State persistence (localStorage keys)
- `ra_optimize_draft` / `ra_ar_optimize_draft` — {resume, jobDescription}
- `ra_optimize_result` / `ra_ar_optimize_result` — last result (cleared on
  payment success in /pay/callback so stale locked previews die)
- `ra_build_draft` / `ra_ar_build_draft` — full wizard state incl. `step`
Rules: rehydrate on mount; clear draft on successful generate / explicit reset;
`beforeunload` warning while `loading`.

### Payment flow
CheckoutButton modal (name/email/mobile) → /api/pay → Paylink hosted page →
/pay/callback?transactionNo → /api/pay/verify: confirms `paid`, validates
amount ≥ plan price, sets device pass cookie; auto-sign-in + account entitlement
ONLY if the `ra_pay` binding cookie matches (anti-replay). Callback copy states
the real plan (24h vs 30-day) — never say "unlimited" for single.

### Auth flow
/login → magic link (15-min token) → /api/auth/verify → redirect
/account?welcome=1 (visible success banner). AuthNav/NavAccountLink poll
/api/auth/me and reflect signed-in email + access state — the nav must never
show "Sign in" to a signed-in user.

## Error handling
- Model call: server retries once (silent, time-guarded); missing RESUME
  section = parse failure (triggers retry — a score without a resume is a bug).
- NO client-side auto-retry on /api/optimize (it double-charges nothing now,
  but keep single-shot: server owns retries).
- Every AI endpoint returns friendly messages; 429 on rate limits
  (magic-link 4/h/email, optimize 15/10min/IP); 402 + `paywall:true` for gated
  features.
- Custom app/not-found.tsx + app/error.tsx (branded, with recovery actions).

## Accessibility & responsive
- All motion behind reduced-motion media queries; counters/ticker render final
  state statically when reduced.
- Fluid layouts only (max-w + grid collapse); textareas resize-y with
  maxLength + amber counter past 90%; wizard step labels visible on mobile.
- RTL: /ar pages set `dir="rtl"`; English resume output blocks force
  `dir="ltr"` + left-align; keep numerals LTR inside RTL copy.

## Component behavior contracts
- ScanDemo: loops only when in viewport and motion allowed; never blocks LCP.
- Counter: IntersectionObserver once, easeOutCubic, instant when reduced.
- PublishLink: publish returns unpublishToken → keep in state; "Unpublish"
  must call DELETE with slug+token. Slugs: name + 10 random chars.
- PdfExport: client-only, plain-text → styled PDF.

## Design constraints
- No new runtime deps for visuals (pure CSS first). Bundle discipline: the only
  allowed additions are framer-motion (`motion/react`) IF orchestration becomes
  necessary — not before.
- Copy tone: confident, concrete numbers, no clichés; Arabic copy is Saudi
  colloquial-leaning ("وش الناقص") not MSA-stiff.
- Prices always SAR (٣٥/٧٥ ﷼ in Arabic, SAR 35/75 in English) — grep for `$9`
  or `$19` before any release; they must not exist.
