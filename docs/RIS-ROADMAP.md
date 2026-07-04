# Meena RIS — Roadmap & Self-Audit

Living plan for the Siratech + DePACS integration ("RIS"). The goal: **staff never
open Siratech — our platform is the full RIS front-end.** Every feature below is
checked against three questions: **Does it work? What could break it? How do we make
it better?**

Flow covered end-to-end:
`Reception (register) → Order → Imaging → Report (DePACS) → Auto-file into Siratech → Deliver`

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
