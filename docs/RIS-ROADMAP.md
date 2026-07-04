# Meena RIS — Roadmap & Self-Audit

Living plan for the Siratech + DePACS integration ("RIS"). Every feature is checked
against three questions: **Does it work? What could break it? How do we make it better?**

**Honest scope (reframed after the 4-agent audit).** The platform owns the
**report/result loop** — it is a *"DePACS↔Siratech result-loop autopilot + patient
delivery"*, not a full Siratech replacement. Today:

| Journey step | Where it happens | Platform covers it? |
|---|---|---|
| Reception / register patient | **Siratech** | ❌ (read-only lookup) |
| Doctor orders imaging | **Siratech** | ❌ (read-only mirror) |
| Patient imaged → DePACS | modality → DePACS | ⚠️ writes the indication (Handoff) |
| Radiologist reads/verifies | **DePACS** | ❌ (radiologist lives in DePACS) |
| Report filed back into Siratech | **Platform** | ✅ the crown jewel (auto-file + Handoff) |
| Deliver to patient | Platform | ⚠️ public link + manual WhatsApp |

"Staff never open Siratech" is the *direction*, not today's reality — reception,
ordering, and reading still require Siratech/DePACS. Building registration/order
write-back is a large, high-risk effort (writes that can corrupt a live medical
record) and is a deliberate future decision, not an implied promise.

---

## Architecture (so we don't forget where things run)

| Piece | Runs on | Deploy |
|-------|---------|--------|
| Backend (`server/main.py`) + dashboard | **Railway** (`meena-scheduling-production.up.railway.app`) | auto on merge to `main` |
| Connector (`integrations/siratech-connector`) | **VPS 156.244.12.174** (Saudi IP), `systemd: meena-siratech` | manual `git pull` + `systemctl restart` |
| WhatsApp bridge (`whatsapp-bridge`) | same VPS, `systemd: meena-whatsapp` | manual |

- The connector MUST run from a Saudi IP — `his.meena-health.com` is Cloudflare/geo-locked to KSA.
- Backend reaches the connector via the bridge proxy: `<bridge>/his/<path>`.
- **Connector service path is set by a systemd drop-in** (`/etc/systemd/system/meena-siratech.service.d/repo-path.conf`). If the running code is stale, the service's `ExecStart`/`WorkingDirectory` points somewhere other than the freshly-pulled checkout — see Ops runbook.

---

## Ops runbook

**Deploy the connector after a merge:**
```
cd /opt/meena-scheduling && git fetch origin && git checkout main && git reset --hard origin/main
systemctl restart meena-siratech
```
**Verify the running code is current (diagnose a "Cannot GET /worklist" 404):**
```
systemctl cat meena-siratech | grep -Ei 'ExecStart|WorkingDirectory'   # what path does it run?
cat /etc/systemd/system/meena-siratech.service.d/*.conf                 # the drop-ins
grep -c "/worklist" <that-path>/server.js                              # 0 = stale code
```
If the service runs from a different dir than the repo checkout, point the drop-in at
`/opt/meena-scheduling/integrations/siratech-connector/server.js` (or copy the files), then
`systemctl daemon-reload && systemctl restart meena-siratech`.

---

## Shipped features + self-audit

### 1. Guarded result file + authorize (`/results/file`)
- **Works?** Yes — files verified DePACS PDF into Siratech Result Entry + authorizes; live-verified 200/200.
- **Breaks if:** the test resolves to more than one study → refuses (good). Already-filed → idempotent skip.
- **Improve:** none pending; this is the trusted write path.

### 2. RIS Phase 2 — order lifecycle store + study binding (#129)
- **Works?** Yes — `scheduling.radiology_orders`, `ordered→reported→filed`, study_id binding.
- **Breaks if:** worklist payload field names drift → upsert skips the row (best-effort, never fatal).
- **Improve:** capture a real DICOM accession if this HIS ever exposes one (today study_id is the binding).

### 3. Auto-file loop (#130)
- **Works?** Yes — every 180s files only exactly-one-verified-study matches; single sweep across workers (atomic claim); audited.
- **Breaks if:** connector `/autofile/candidates` missing (stale VPS code) → sweep no-ops.
- **Fixed:** claim rows (`rad_autofile_run:<bucket>`) now reaped so `app_settings` can't grow unbounded.
- **Fixed:** config endpoint used wrong audit column (`at` → `created_at`).
- **Improve:** expose a per-day "auto-filed N" counter on the dashboard; alert if the sweep errors repeatedly.

### 4. Live worklist (#130) + modality (#133)
- **Works?** Yes — 45s silent refresh; modality (CT/US/XR/MR/MG) via bounded RadiologyDetails pass.
- **Breaks if:** very large worklist → modality capped at 80 rows (documented; the rest show no badge).
- **Improve:** stream/websocket instead of poll; widen modality cap with a smarter cache.

### 5. Orders page (#131) + needs-attention flags (#132)
- **Works?** Yes — lifecycle board, TAT pipeline, stuck-order flags, modality.
- **Breaks if:** clock skew on `reportedAt` → TAT slightly off (cosmetic).
- **Improve:** CSV export; date-range filter; per-branch TAT leaderboard.

### 6. Emergency alert (#134)
- **Works?** Yes — chime + desktop notification + toast on a genuinely new emergency order.
- **Fixed:** re-seed baseline on branch/filter change so switching scope never false-alarms.
- **Breaks if:** browser blocks audio before first interaction (visual toast still fires).
- **Improve:** repeat-until-acknowledged for unattended screens.

### 7. Solid patient search (#127)
- **Works?** Yes — routes mobile / Saudi ID / Iqama / MRN correctly (unit-tested all formats).
- **Breaks if:** HIS stores a mobile in an unexpected shape → bare-number fallback covers most.
- **Improve:** search by patient name (Arabic) via EMR list.

### 8. Security — untrack `seed_prod.sql` (#132) + DePACS TLS pin
- **Works?** Untracked + gitignored. TLS pinning implemented (opt-in `ELITE_CERT_SHA256`, off by default).
- **Open (needs owner action):** rotate the 8 account passwords + connector/bridge tokens; purge `seed_prod.sql` from git history (force-push); set `ELITE_CERT_SHA256` on Railway to enable pinning.

---

## 4-agent audit (findings + status)

**Fixed in this pass:**
- 🔴 `isReported` was negation-blind — "NOT VERIFIED"/"UN-SIGNED"/"PENDING FINAL" could pass and auto-file a *draft*. Now rejects negation/draft markers first (connector `results.js`).
- 🟠 Day-picker sent a raw-UTC window; KSA 00:00–02:59 orders dropped off the board (and their emergency chime never fired). Now converts the KSA calendar day to the correct UTC instant (connector `buildWorklist`).
- 🟠 `_rad_ts` dropped the timezone → `ordered_at` stored 3h off → TAT wrong / sometimes negative. Now treats HIS billDate as KSA→UTC.
- 🟠 Worklist DB upsert was N per-row commits inline on every load; now one batched `execute_values`.
- 🟠 Emergency chime keyed only on `genPatBillingId`; an emergency without one never chimed. Now falls back to bill/MRN key.
- 🟠 `worklist`/`patientsearch` missing from `VALID_PAGES` → refresh/Back bounced to Home. Added.

**Open — safety/trust (highest value next):**
- **No un-file / cancel / correction path.** A mis-filed report forces the operator back to Siratech — the inverse of the goal. Build a guarded un-file (Siratech has `isResultCancellation`).
- **Amended reports never re-file.** `filed` is terminal; a later ADDENDUM/FINAL never reaches Siratech. Track report version; re-open on a newer verified report.
- **No monitoring/alerting on the auto-writer.** Failures only `print()`. Add success/fail counters, alert on consecutive failures or "0 filed while candidates>0", a per-day tile.
- **Auto-classify normal/abnormal writes with no human review** in the auto path. Consider filing without asserting the flag when confidence is low; keep a reviewable classification log.
- **WhatsApp delivery targets no specific group** (client-side `wa.me`) → PHI mis-send risk. Route through the VPS bridge to a configured group JID.
- `reported_at` is "detection time", not the DePACS verification time → TAT inflated. Derive from `depacsReport.reportDate`.
- Auto-file target picked by `serviceId` only (ignores `invPatTestResultId`) → a repeated same-service exam leaves the sibling unfiled. Pass/honor `invPatTestResultId`.

**Open — operator experience:**
- Search can't find by **patient name** or **accession**. Orders search is exact-MRN only.
- No **bulk "file all green"** on the worklist.
- No **cancelled / no-show** state → the board rots and TAT skews.
- Modality badge cap (80 rows) silently drops badges on the busiest days.

**Open — performance (connector, needs a VPS pull):**
- Cache DePACS studies + report PDF (fetched 3× on one file). Collapse the check→file→confirm re-matches. Share the per-site RadiologySearch cache across the modality/ready passes. Lazy-enrich old orders in patient lookup. Run typed patient-search variants concurrently.

## Backlog (owner action)
1. **Update the VPS connector** (runbook above) — unblocks auto-file, modality, search.
2. **Rotate** the 8 passwords + connector/bridge tokens (exposed in git history/chat).
3. **Purge** `seed_prod.sql` from history: `git filter-repo --path seed_prod.sql --invert-paths --force` then force-push.
4. **Enable TLS pin:** add Railway env `ELITE_CERT_SHA256` = `F9:D1:0B:5E:BD:47:14:67:A7:DA:F6:D0:08:31:01:09:CA:E5:4B:86:C0:6A:A1:62:88:7A:B7:DC:BE:85:B4:3A` (colons OK — the code strips them). Verify DePACS reports still load, then keep. If they stop loading, remove the var.
5. Run connector as a non-root user on the VPS.

## Backlog (buildable — needs a go / needs testing)
- Emergency alert: repeat-until-ack.
- Orders: CSV export + date range.
- Modality: raise cap / smarter cache.

## Backlog (bigger, non-RIS — one careful PR each, no test suite exists yet)
- Unify KSA timezone handling across the app.
- Inventory movement ledger.
- Scheduler robustness (infeasibility handling, edge cases).
- **First: add a test harness** so these can be changed safely.
