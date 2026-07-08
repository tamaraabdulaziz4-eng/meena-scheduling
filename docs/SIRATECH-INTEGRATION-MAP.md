# Siratech Integration Map — what we can pull, and what it fixes in the RIS

Living reference from a full audit of Siratech's **1691** API endpoints (exported
to `his_api_endpoints.csv`) against Meena's RIS gaps in `RIS-ROADMAP.md`. Produced
by a 5-domain sweep (radiology · identity · scheduling · billing/Nphies · clinical/HL7)
plus the live ELM/Nphies probes.

Base-module → URL: the connector reaches `https://his.meena-health.com/<module>/api/v1/...`.
Known live modules: `patient-api`, `investigation-api`, `billing-api`, `emr-api`,
`master-suite-api`, `insurance-api` (Ins_Approval), `appointment-api`,
`common-shared`(?), `econnect-api` (Nphies gateway), `final-billing-api`,
`printer-suite-api`, `template-api`, `dischargesummary-api`.

---

## 0. Cross-cutting facts (read first)

- **علم / Yakeen identity lookup WORKS today** (proven live). `POST /patient-api/api/v1/Patient/ELMData`
  with `{idType, dob(ISO), idNumber, ninOrIqamaNumber, requestType, hasDuplicateId, hospitalId}`
  returns a citizen's full name (EN+AR) + Hijri DOB from national ID + Gregorian DOB.
  `idType` = the SAUDIID/IQAMA `genLookUpId` (SAUDIID = `152298` at this site) read from
  `GET /insurance-api/api/v1/InsuranceApprovalCommon/IdentifyingDocs`. Tool: `tools/elm-lookup.js`.
  → **علم needs national ID + DOB together** (Yakeen security); it is a **LIVE, billed, logged**
  government call — gate behind consent + `CreateElmNphiesLog`.
- **Nphies is fully integrated but its access token is EXPIRED.** Every *live outbound* Nphies
  call (`Nphies/Eligibility/Check`, `Discovery/Check`, claim submit, pre-auth send) returns
  `Invalid Access Token` — a **Siratech-side ops refresh**, not fixable in Meena. But every
  *stored* Nphies read (`/Search /View /Response /RequestAndResponse`) works now.
- **Rule of thumb:** reads on `patient/investigation/billing/insurance` modules are low-risk and
  unblocked. Writes to the live EMR (`Save*ResultEntry/Authorization`, `Register*`, `Appointments/Create`,
  `UpdateRadiologyArrivalStatus`, payment posts) are high blast-radius — gate like the existing
  guarded file/authorize path.

---

## 1. Priority build queue (synthesized)

### 🟢 P0 — quick wins (read-only or low-risk, high value, ship first)
| # | Capability | Endpoint(s) | Fixes which slow/stuck RIS item |
|---|---|---|---|
| 1 | **ID → identity auto-fill / verify** (PROVEN) | `Patient/ELMData` (+ `IdentifyingDocs` for idType) | "register/lookup by national ID"; reception auto-fill |
| 2 | **Search by patient name (Arabic)** | `Patient/EMRSearchPanel/List` category=1 | oldest open gap: "Orders search is exact-MRN only" / "search by name (#127)" |
| 3 | **Patient clinical card** (allergy/Dx/vitals) | `EMR/Allergies/ClinicalWarnings`, `Diagnosis/Patient/{mrno}`, `VitalSign/Summary` | maps the **dead placeholder** fields `allergy/height/weight/bloodGroup` (`server.js:301-324`) |
| 4 | **True per-bill status + real report time** | `AvailedServiceInfo/GetRadiologyLog?DtlsPatBillingId=` | `reported_at` = detection-time → **TAT inflated**; DePACS-inferred per-bill stage |
| 5 | **Kill the 80-row modality cap** | `HL7Master/SelectChannelModality` (+ `Getenumllistquery`) | "Modality badge cap (80 rows) silently drops badges"; fuzzy CT/US/XR guess |
| 6 | **Finish paid/unpaid collection split** | `DueSettlement/GetDueSettlementBills` (join by `GenPatBillingId`) | roadmap: financial split "pending/null" |
| 7 | **Missed-billing / revenue leak** | `InvoiceGeneration/UnbilledPatients` | imaged-but-never-billed detection (new) |
| 8 | **Pull Siratech notifications into Meena** | `Notification/GetNotification?userID=` | "No monitoring/alerting"; alerts are local-DB only |
| 9 | **Insurance scheme on the worklist** | `Patient/GetPatientScheme?mrNo=` | payer/coverage without touching Nphies (token-free) |
| 10 | **Result report PDF for delivery** | `Printer_Suite_API/Investigation/ResultPrint` | replaces manual export in patient delivery |
| 11 | **Search by accession** | `Pathology/AttachAccessionNoSearch` | Orders search exact-MRN only |

### 🟠 P0/P1 — guarded WRITES (high value, gate like the file path)
| Capability | Endpoint | Fixes |
|---|---|---|
| **Un-file / cancel a filed report** | `ResultEntryRadiology/SaveRadiologyResultEntry` with `isResultCancellation:true` (flag already in payload, hard-false at `server.js:1560`) | **#1 open safety gap**: "No un-file/cancel/correction path" |
| **Radiology check-in / arrival** | `AvailedServiceInfo/UpdateRadiologyArrivalStatus` (+ `GetRadiologyToken`) | missing **real-time check-in**; "no cancelled/no-show → board rots, TAT skews" |
| **Real HIS accession** | `Pathology/GenerateAccessionNumber` / `ValidateAndGenerateAccessionNumber` (+ `AttachAccessionNoSave`) | "**Accession # null** → studyId-only binding" |
| **Amended-report re-file** | `Visits/Addendum/Save\|List` + `dischargesummary-api/RadiologyReport` (version) | "Amended reports never re-file" |

### 🟡 P1 — bigger builds (fill the largest RIS gaps)
- **Patient appointment scheduling (resource-based)** — the biggest missing RIS feature. Flow:
  `PatientAppointments/PendingOrder` → `ServicePanel/GetApptResourceCategory` + `GetInvMastServices`
  → `Resource/Search` → `Provider/Slots/ByDateRange` → `Appointments/Validation/Warning` →
  `Appointments/LockSlot` → `Appointments/Create` (→ `UnlockSlot` on abort); manage via
  `Reschedule`/`Cancel`.
- **Structured report templates** — `ResultEntry/GetTemplateMasterData` + `GetTemplateTestResultDetails`
  + `Template_API/Template/TemplateMaster`; `EMRMenu/EmrTemplates` + smart-notes (dictation-macro target).
- **Register-by-national-ID flow** — idType → search-existing → `RelatedMrno/Search` (de-dup) →
  ELM/Nphies verify → `CreateElmNphiesLog` → (future write) `Registration/Guest`/`Patient/Register/Create`.
- **Denial tracking** — `ClaimSubmission/Nphies/NphiesDetails/ClaimResponseDetails` + `/ClaimErrorDetails` (stored, unblocked).
- **Stream instead of poll** — `RadiologyServiceNotification` push vs 45s worklist refresh.

### ⛔ Blocked on Siratech ops (expired Nphies token)
Build behind a feature flag now; flips on when Siratech refreshes the token:
`Nphies/Eligibility/Check` · `Nphies/Discovery/Check` · `ClaimSubmission/Nphies/SendClaimRequest`+`/StatusCheck` · pre-auth `SendNphiesRequest`.
Interim substitutes (token-free): `Patient/GetPatientScheme`, `Nphies/Eligibility/Search|View`
(stored reads), `ClaimSubmission/Nphies/OfflineEligibility/Save`.

### 🔴 High-risk future (deliberate decision)
Registration/order write-back to the live medical record: `Patient/Register/Create`, `Patient/Edit`.
Pair with `RelatedMrno/Search` de-dup as a hard precondition. (RIS-ROADMAP lines 19–22.)

---

## 2. "Replace what's slow/stuck" — direct mapping
| Current slow/stuck (RIS-ROADMAP) | Endpoint that fixes it |
|---|---|
| `reported_at` detection-time → TAT inflated | `GetRadiologyLog` (real filed/report timestamp) |
| Per-bill stage inferred from DePACS (fuzzy) | `GetRadiologyLog` HIS-native Ordered/Imaged/Reported |
| No un-file / cancel / correction | `SaveRadiologyResultEntry` `isResultCancellation:true` |
| Amended reports never re-file | `Visits/Addendum/*` + `RadiologyReport` versioning |
| Modality cap 80 rows / fuzzy guess | `HL7Master/SelectChannelModality` static map |
| Accession null → studyId-only binding | `Pathology/GenerateAccessionNumber` + `AttachAccessionNoSave` |
| No cancelled/no-show state | `UpdateRadiologyArrivalStatus` |
| Search exact-MRN only | `EMRSearchPanel/List` (name) + `AttachAccessionNoSearch` |
| Financial paid/unpaid split pending | `GetDueSettlementBills` |
| 45s polling worklist | `RadiologyServiceNotification` push |
| No auto-writer monitoring/alerting | `Notification/GetNotification` |
| Dead patient-card placeholders | `EMR/Allergies/ClinicalWarnings`, `VitalSign/Summary`, `Diagnosis/Patient/{mrno}` |

---

## 3. Recommended sequence
1. **ELM identity** (proven) → connector `/elm/verify` read endpoint + Meena "verify/auto-fill by ID" (consent-gated, `CreateElmNphiesLog`).
2. **Read-only quick wins bundle**: patient clinical card (#3), name search (#2), `GetRadiologyLog` TAT fix (#4), modality map (#5), notifications (#8), scheme (#9).
3. **Financial split** (#6) + **missed-billing** (#7).
4. **Guarded writes**: un-file (#safety), radiology check-in.
5. **Big builds**: appointment scheduling; structured templates.
6. **Ping Siratech** to refresh the Nphies token → unblocks live eligibility/discovery/claims.

All endpoints here are read-only unless marked WRITE. Every write stays behind the existing
single-match/idempotency guard used for result filing.
