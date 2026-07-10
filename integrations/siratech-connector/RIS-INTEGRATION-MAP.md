# Siratech → Meena RIS — Integration Map

**Purpose:** the single reference for *what data lives where in Siratech and how Meena reads it*,
so any new RIS feature can be wired to the right endpoint without guesswork. Built from the
complete Siratech API index (1,446 endpoints across ~60 services) plus the connector code.

> **How Meena integrates — the rule.** The connector logs in **once** with its own authorized
> account and reads **specific** endpoints on demand (localhost, Bearer `CONNECTOR_TOKEN`). We do
> **not** dump the whole HIS or scrape PHI in bulk — every field Meena shows maps to a named
> endpoint below. Base-path prefixes are in `SIRATECH-API-INDEX.md`.

---

## 1. The radiology order lifecycle (why "unpaid" is invisible)

A radiology order moves through **four systems**, and each stage is a *different* data source:

```
 (1) ORDER placed        (2) BILLED              (3) PAID / arrived        (4) RESULT entered
 clinician CPOE    →     billing service panel → reception token/arrival → radiology result queue
 EMR_API                 Billing_API             Billing_API               Investigation_API
 EmrOrdersBaseCat        ServicePanel/…          AvailedServiceInfo/…      ResultEntryRadiology/
 PendingOrder            GetServicePanelData     GetRadiologyToken         RadiologySearch  ← Meena
```

**Meena's worklist reads stage 4 only** (`RadiologySearch`, `filterResult:0` = pending result).
An order only enters stage 4 **after it is paid and performed** — so an **unpaid** radiology order
(e.g. patient paid labs but not imaging) is still at stage 2/3 and never appears. To surface unpaid
orders we must read the **billing layer** (stage 2/3), then merge them in flagged as unpaid.

---

## 2. RIS-relevant endpoints by function

Legend:  ✅ Meena uses it · 🟡 available, high value to wire · ⚪ available, situational

### Patient (demographics, insurance, history) — `Patient_API`
| | Endpoint | Use |
|---|---|---|
| ✅ | `/Patient/Search`, `/Patient/PatientData?mrNo=` | patient lookup, demographics, flags |
| 🟡 | `/Patient/GetPatientScheme?mrNo=` · `/GetInsuranceByPolicy` | patient's insurance scheme/payer (for payer split, approvals) |
| 🟡 | `/Patient/TimeLine/Data` · `/TimeLine/Details?PatFinEncounterID=` | full visit timeline — richer patient history in the card |
| ⚪ | `/Patient/NPHIESPatientRegistry?idNumber=` | national eligibility registry lookup |

### Orders — clinician CPOE (stage 1) — `EMR_API`
| | Endpoint | Use |
|---|---|---|
| 🟡 | `/EMR/EmrOrdersBaseCat` · `/EMR/EmrServicebyBaseCategoryID` | every EMR order by base category (radiology = one category) — the **pre-billing** order list |
| 🟡 | `/CPOEAdmin/ServiceOrder` · `/CPOEAdmin/AdminStatusLog?EmrPatDtlsInvOrderId=` | order administration status / audit trail |
| ✅ | `/EMR/FetchRISPanel` | per-exam service + status + arrival/exam timestamps (drives the board's stage lanes) |
| ✅ | `/EMR/FetchRadiologyDetails` · `GetEmrOrderDetails` | per-order status refinement + clinical indication |

### Billing & payment (stages 2–3) — `Billing_API`
| | Endpoint | Use |
|---|---|---|
| ✅ | `/DueSettlement/GetDueBillDetailsByID?GenPatBillingId=` | one bill's line items → revenue, payer split, **patient-outstanding** (the UNPAID chip) |
| 🟡 | `/DueSettlement/GetDueSettlementBills` (POST) | **list of unsettled/unpaid bills** — the branch-wide source of unpaid orders *(payload probing via `/diag/unpaid-probe`)* |
| 🟡 | `/DueSettlement/PayStatus` | explicit paid/unpaid status of a bill |
| 🟡 | `/ServicePanel/GetServicePanelData` (POST) | billing service panel — **pending (unbilled) orders** |
| 🟡 | `/Billing/BilledServices?PatFinEncounterId=&ServiceType=` | billed services on an encounter, by service type (radiology) |
| 🟡 | `/AvailedServiceInfo/GetRadiologyToken` · `/UpdateRadiologyArrivalStatus` · `/GetRadiologyLog?DtlsPatBillingId=` | **radiology reception / arrival / token** queue — patients present for imaging (paid or not) |
| ⚪ | `/Receipt/PaymentHistory` · `/BillCancel/PaymentDetails?genPatBillingId=` | receipts / payment history / refunds |

### Result entry — the RIS worklist (stage 4) — `Investigation_API`
| | Endpoint | Use |
|---|---|---|
| ✅ | `/ResultEntryRadiology/RadiologySearch` | the pending-result worklist (paid + performed) — **Meena's board** |
| ✅ | `/ResultEntryRadiology/RadiologyDetails` | per-order exam detail / modality |
| ✅ | `/ResultEntryRadiology/SaveRadiologyResultEntry` · `SaveRadiologyResultAuthorization` | file/authorize a report (with the range code — see normal/abnormal below) |
| ⚪ | `/InvestigationCommon/UserPrivilegedCategory` | which investigation categories a user may see |

### Revenue cycle — insurance approvals & denials — `Ins_Approval_API` / `Econnect_API`
| | Endpoint | Use |
|---|---|---|
| 🟡 | `/InsuranceApproval/RequestCount` · `/RejectionLog` · `/RequestDetailsForReject?` | **denials / rejections** — the revenue-cycle metric (task #8) |
| 🟡 | `/InsuranceApprovalCommon/Status` · `/Services?hospitalId=` | approval status list, approvable services |
| 🟡 | `/Nphies/…` · `/Econnect_API/Nphies/EligibilityCheck` | NPHIES eligibility / claim status (Saudi payer rail) |

### Reports & messaging
| | Endpoint | Use |
|---|---|---|
| ✅ | `DischargSummary_API/RadiologyReport` | the radiology report document |
| ✅ | `Econnect_API/SMS/GetOtp` · `/VerifyOtp` | OTP (sign-up / consent) — Meena's SMS path |
| 🟡 | `Appointment_API/PatientAppointments/PendingOrder` | pending orders across the schedule |

---

## 3. What the pending RIS features need (exact wiring)

| Feature | Blocking data | Endpoint(s) to wire | Status |
|---|---|---|---|
| **Unpaid orders on the board** | branch-wide unpaid/unbilled radiology orders | `DueSettlement/GetDueSettlementBills` and/or `AvailedServiceInfo/GetRadiologyToken` / `ServicePanel/GetServicePanelData` | probing payload via `/diag/unpaid-probe` |
| **Clinic → radiology conversion** | total visits vs. visits with a radiology order | `Billing/BilledServices` + `Encounter/PatientEncounters` (or `EmrOrdersBaseCat`) | needs endpoint confirmation |
| **Denials / revenue cycle** | rejected approval requests for radiology | `InsuranceApproval/RejectionLog` + `RequestDetailsForReject` | needs endpoint confirmation |
| **Radiology % of total revenue** | hospital-wide revenue (all departments) | a billing revenue summary (not per-bill) — candidate: `Finance_API` reports | needs endpoint confirmation |
| **Normal vs abnormal rate** | report range code at file time | already supported by `SaveRadiologyResultEntry` (range 0/1/2) — needs the tag captured in Meena's file flow | Meena-side |

> The endpoints marked *needs confirmation* have **runtime-built request bodies** (the API index lists
> them as `dynamic/unresolved`), so their exact payload is confirmed with the read-only
> `/diag/unpaid-probe`-style discovery **or** a single HTTP capture of the matching HIS screen — then
> wired precisely. We never guess a write; only `*Search` / `Get*` reads are probed.

---

## 4. Discovery tooling

`GET /diag/unpaid-probe?days=7[&sites=][&mrno=]` — read-only. Calls candidate billing **search**
endpoints per branch and returns each one's HTTP status + response shape (row count, field names,
one PHI-redacted sample row). Use it to confirm which endpoint yields the data a new feature needs
before writing the merge. Extend `candidates()` in `server.js` with a new endpoint to probe it.
