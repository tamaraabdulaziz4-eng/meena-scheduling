# Integration Handoff — Meena ↔ Butterfly (DePACS reports) + Siratech (HIS)

> Resume note: a new session can continue this work by reading this file. Ask the
> user for the live credentials (below) before running any probe.

## The daily workflow we're automating
After a radiology exam, staff currently do this by hand:
1. Do the exam → wait for images to land in DePACS ("Butterfly").
2. Open the hospital system (Siratech HIS) → copy the patient's clinical history.
3. Paste it into Butterfly (so the radiologist sees it).
4. WhatsApp a **single group** with: file number + exam + priority (emergency/routine).
Goal: one screen in Meena does all of it, then pulls the finished report back.

## Multi-branch facts
- **One** WhatsApp group for all branches. **One** Butterfly (DE) account for all.
- Branch is just a field (a patient may come from another branch / Digital to be imaged).
- Meena already knows branches; the handoff screen just has a branch selector.

## DONE & merged to `main`
- **Employee-file documents**: staff self-fill their document dates (`/api/my-credentials`), printable A4 file. Tab in Reports + portal "My documents".
- **Patient-report lookup (Butterfly)**: Reports → **"Patient report"** tab. Enter file number → list studies → view report (sandboxed iframe) → open/download PDF.
  - Backend `/api/reports/*` in `server/main.py` (search `_elite_`). Config in `app_settings`
    (`elite_username`, `elite_password`, `elite_api_base`). Superadmin sets the account once.

## Butterfly (DePACS) API — FULLY MAPPED ✅
Base: `https://test-api.diagnosticselite.net:10443/api/v1` (self-signed cert → skip TLS verify).
Auth header: `Authorization: Token <accessToken>`
- `POST /auth/signin` body `{identifier, password, device_id:"<user>_meena", platform:"web"}` → `body.access_token` (JWT ~6 months).
- `GET /study/get_studies?start_date=&end_date=&page_size=50&current_page=1&patient_id=<file>` → `body.data[]` (study_id, pat_id, pat_name `L^F^M`, modality, study_date, study_status `VERIFIED|UNREAD|...`, clinical_history, imaging_center).
- `GET /report/get_study_report_info/<study_id>` → `body.report_content` (HTML), report_id, history_symptoms, pat_name…
- `GET /report/open_report_pdf/<study_id>?style=<1|2>` → `application/pdf` (style 2 = with letterhead).
- **STILL NEEDED:** endpoint to **WRITE** clinical history into a study. Grep the Butterfly JS
  bundle for `v1/study/...` edit/update and `v1/report/...` (seen: `add_report`, `edit_report`).
  A `grepbtf.js` probe exists on the VPS.

## Siratech HIS — findings
Base: `https://his.meena-health.com` (Angular SPA, "Siratech").
- Login is **multi-step + ENCRYPTED** payload (`X-App-Mode: ENCV0`) → can't POST creds directly.
  Must log in via **headless browser**: type user `#mat-input-0` → Tab (loads sites) → pick site in
  `mat-select #focusablesite` → password `#passFocus` → click **LOGIN**.
- After login: standard **Bearer JWT** (`SignIn` response `tokenData.accessToken`, ~1h; refreshToken present).
  JWT shows `GENERAL-API-ACCESS` + `API-LICENSE-ACCESS` → an **official API exists** (user says they can't get it).
- Microservices seen: `security-api`, `master-settings-api`, `appointment-api`, `billing-api`, `common-api`, `admin-api`.
- **Radiology worklist is reached via the "Services" page (module 52)** — NOT a "Radiology" menu item.
- Account `101454` = Radiology Technologist. Default landing = `/home/no-privilege` because radiology
  isn't at the "Meena Clinic-Digital" site (11). **Need the correct site** (ask user which branch does imaging).
- **STILL NEEDED:** the radiology-orders endpoint returning **clinical indication + branch** by file number.
  Path: login → **Services** → radiology list → search file → capture the API. `siraradio2.js` drafted on VPS.
- **Plan:** a small VPS connector (like `whatsapp-bridge`) that logs in via headless browser, caches the JWT,
  exposes `/patient/:file` → {clinical_indication, branch}. Meena calls it. **Fragile** (vendor changes break it);
  official API strongly recommended.

## Phase 2 — Handoff screen to BUILD
Meena page: **file# + exam + priority(emergency/routine) + branch(select) + clinical history(paste)** → one button:
- Write clinical history into the Butterfly study (needs the write endpoint above).
- Send the **WhatsApp group**: `file + exam + priority + branch`.
Later: auto-pull clinical history + branch from Siratech (replaces the manual paste).

## Open items / still need from the user
1. **WhatsApp group**: a real example message (exact format) + the group. Add a `/groups` endpoint to
   `whatsapp-bridge` to fetch the group id, or the user gives the group name.
2. **Butterfly write-clinical-history endpoint** (grep Butterfly JS).
3. **Siratech radiology-orders endpoint** (run `siraradio2.js`, navigate via Services).
4. **Credentials** (user provides at resume): Butterfly `Meenahealth3` / (pwd); HIS `101454` / (pwd).
   ⚠️ These were shared in chat — advise the user to rotate them.

## Environment
- **VPS** `156.244.12.174` (root), runs `whatsapp-bridge` (systemd `meena-whatsapp`), Node v22, puppeteer
  installed, open internet. All probe scripts live in `/opt/meena-scheduling/whatsapp-bridge/*.js`.
- This Claude Code env's **network egress is now "All domains"** → a NEW session can browse the vendor sites
  directly (this session was still on the old policy, so it couldn't).
- Branch: `claude/withdraw-generation-bug-jw81dz` (ongoing feature work); `main` has the merged features.

---
## Siratech — LIVE findings (verified via a GPT agent, 2026-07-01)
**Working lookup endpoint (PROVEN with a real request):**
```
POST https://his.meena-health.com/emr-api/api/v1/EMR/FetchRadiologyDetails
body: {"mrno":"<file>"}   headers: Authorization: Bearer <JWT>, hospitalid: <siteId>
```
Returns the patient's radiology order(s). Fields seen live (file 25052903 = US Obstetric, Al Rawdah):
`serviceName`, `modality`, `siteId`, `site`, `billNo`, `orderedDate`, `accessionNumber`,
`invPatTestResultId`, `radioReportStatus`, `hasRadiologyRepot`, `radioImageStatus`, `imageStatus`,
`pacsId`, `pacsType`, `cpacsUrl`, `cpacsDocpath`, `cpoeStatusDescription`.
- **NO fan-out needed** — the branch (siteId/site) is inside the response; the same call returns the
  order regardless of the hospitalid header.
- `POST /emr-api/api/v1/EMR/FetchRadiologyReport {mrno}` and `FetchRadiologyImage {mrno}` also work.
- Auth: SignIn body is ENCRYPTED (text/plain) → must log in via headless browser to get the JWT,
  then plain REST with `Authorization: Bearer` + `hospitalid` header.

**Clinical indication (STILL the one gap):** NOT in FetchRadiologyDetails. Source (found in bundle, not yet live):
`GET /billing-api/api/v1/ServicePanel/GetEmrOrderDetails?EmrPatDtlsInvOrderId=<id>` → `clinicalIndication`,
`reasonForOrder`, `remarks`. Need the order id from the FetchRadiologyDetails row (field name to confirm:
`emrPatDtlsInvOrderId` / `invPatOrderId` / `emrPatInvOrderId`). Alt path `POST /investigation-api/api/v1/
ResultEntryRadiology/RadiologyDetails` returns it but its `RadiologySearch` prerequisite fails live (needs
UI context; `visiType` must be Int32; then 500).

**Lifecycle:** order → billed (`billNo`) → `accessionNumber` → worklist/PACS → report (`invPatTestResultId`).
**Test file with an order:** 25052903.
**Build:** VPS connector (like whatsapp-bridge) — headless browser login → cache JWT → `FetchRadiologyDetails`
→ parse; add clinical indication via GetEmrOrderDetails once the order-id field is confirmed live.
