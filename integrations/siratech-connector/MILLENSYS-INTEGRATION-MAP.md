# MILLENSYS MiClinic (RadCare Health) → Meena — Integration Map

**Purpose:** wire the cross-system MRI/CT match — take a Siratech MRI/CT order (patient
national ID + order date) and find the matching **report** in RadCare's MILLENSYS MiClinic,
which Meena's own Siratech/DePACS stack does not carry. Built from a read-only scan of the
live MiClinic SPA (routes + Kendo/SignalR datasource config), not from vendor docs — MILLENSYS
publishes no REST API (integration is officially HL7/DICOM/WADO/URL).

> **Status:** endpoint NAMES + PARAM names discovered; exact request shape (method, full body,
> auth) still needs ONE authenticated capture against the live app. Nothing here is wired yet.

## System

| | |
|---|---|
| Tenant | **RadCare Health** |
| Base | `https://mill.radcarehealth.com/MILLENSYS/MiClinic/` |
| Branches | King Fahd, East Riyadh, North Riyadh, Home Visit |
| Auth | web session (cookie) — no bearer/API key surface found |
| Worklist transport | **SignalR** Kendo datasource (`type: signalr`, `server.read: "read"`, `serverFiltering: true`) — NOT clean REST |

## The join key — national ID is **SSN**

In MILLENSYS the patient national ID / Iqama is the **`SSN`** field (Kendo filter field);
the model also exposes **`Ssnumber`**. This is the field we match the Siratech national ID
(`PatientBannerInfo.nationalId`, e.g. `1129532634`) against.

## Patient search (national ID → their patient) — CONFIRMED WORKING

`CommonPages/PatientSearch` returns the search *page*; the data comes from the
**`CommonPages/GetPatients`** Kendo grid read. It does NOT use Kendo `filter[]` — it sends
FLAT params built by the page's `getpatientfilterdata()` function:

```
POST /MILLENSYS/MiClinic/CommonPages/GetPatients
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest        (must be an AJAX request)

sort=&page=1&pageSize=30&group=&filter=
&SsnNumber=<NATIONAL_ID>        ← national ID / Iqama goes here
&PSearchCriteria=4             ← match operator: 0 Quick · 1 StartsWith · 2 Contains · 3 EndsWith · 4 Exact
&PatientCode=&PatientName=&MRN=&PatientDateBirth=&Gender=
&PersonalMobileNumber=&HomePhoneNumber=&TypeOfPatientName=&GivenName=&MiddleName=&FamilyName=
```

Response: `{"Data":[ <patient> ],"Total":n}`. Key row fields:
`PatientId`, `PatientCode`, `MRN`, `SsnNumber`, `EncounterId`, `AnyEncountersOpened`,
`PatientDateBirth`, `PersonId`.

### ✅ Cross-system join PROVEN
National ID **`1129532634`** resolves to the SAME person in both systems:
- Siratech MRN **`25179690`** (via `PatientBannerInfo.nationalId`)
- RadCare MILLENSYS **`PatientId 21614`** (via `GetPatients` `SsnNumber` exact search, `Total=1`)

So `SsnNumber` (MILLENSYS) === national ID (Siratech) is a reliable 1:1 join key.

> Worklist grid is SignalR (server-filtered by `SSN`) — not needed; `GetPatients` over HTTP is the clean path.

## Report / document (the thing we fetch)

| Route | Likely use |
|---|---|
| `Report/GetReportDetails` | the report content/metadata |
| `Report/ReportPopup` · `Reports/ReportPage` | rendered report view |
| `Report/ExportReportsPdf` · `Report/DownloadReportFilePdf` | **the report as PDF** |
| `Widgets/LoadDocumentView` | document viewer |
| `/StudyToXml/AViewer.Millensys` · `AdvancedViewer/GetSetupFile` · `ScannedDocuments/[action]` | PACS study viewer / scanned docs |

**Report open-url parameters** (substituted at runtime by the SPA):
`@VisitId`, `@EncounterId`, `@PatientId`, `@PatientCode`, `@StudyId`, `@ClinicId`,
`@AccountServiceId`, `@AccountServiceCode`.

## Appointment check (the "or appointment" step)

`ServiceScheduler/SmartSchedulerNew` · `ServiceScheduler/PhysicianScheduler` ·
`ServiceScheduler/GetTimeSearchCriteria` · `Summary/Summary` · `Visit/VisitHistory`.

## The match flow (target)

```
Siratech  → national ID (SSN) + MRI/CT exam + order date        [WORKING]
              │
              ▼  CommonPages/PatientSearch?searchkey=<SSN>
MILLENSYS → their PatientId/PatientCode → AccountServiceId/StudyId for the MRI/CT service
              │  (match: same exam, report dated ON/AFTER the order date)
              ▼  Report/GetReportDetails | DownloadReportFilePdf  (by AccountServiceId/StudyId)
            the MRI report
```

## What's still needed to wire it

1. **One authenticated capture** against `mill.radcarehealth.com` to confirm request shape:
   - `CommonPages/PatientSearch?searchkey=<a national ID>` → does it return the patient + their `AccountServiceId`/`StudyId`? Does `searchkey` accept the SSN?
   - `Report/GetReportDetails` (or `DownloadReportFilePdf`) → which of the `@`-params it requires.
2. **Auth for the connector:** a session cookie (or a same-origin fetch run from the open tab)
   so the connector (Saudi VPS) can call these read-only.

Once (1) is captured, the matcher plugs into `tools/mri-match-test.js` (the MILLENSYS half is
already scaffolded, env-gated) and the same-day/after-order safety gate applies.
