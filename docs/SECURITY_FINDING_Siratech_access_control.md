# Security Finding — Siratech HIS: Broken Access Control on Radiology/EMR Endpoints

**Status:** Draft for responsible disclosure to the vendor (Siratech)
**Reporter context:** Discovered by the customer (Meena Health) on **their own authorized systems**
during an internal integration effort. No third-party systems were accessed.
**Date:** 2026-07-01
**Severity (reporter estimate):** **High** — a low-privilege account can read protected health
information (PHI) for patients across **all branches**, with enumerable identifiers.

---

## 1. Summary
The radiology/EMR data endpoints return a patient's radiology order and clinical data based on the
**patient file number (MRN)** alone, and do **not appear to enforce site/branch (tenant) scoping or
object-level authorization** server-side. A user authenticated with a **low-privilege "Radiology
Technologist" role** at one site was able to retrieve radiology data for patients belonging to **other
sites**, and the site-scoping header (`hospitalid`) had **no effect** on the result.

Because MRNs are sequential patient file numbers, this enables **enumeration of patient records across
the whole organization** from a single low-privilege account.

## 2. Affected endpoints (observed)
- `POST https://his.meena-health.com/emr-api/api/v1/EMR/FetchRadiologyDetails`
- `POST https://his.meena-health.com/emr-api/api/v1/EMR/FetchRadiologyReport`
- `POST https://his.meena-health.com/emr-api/api/v1/EMR/FetchRadiologyImage`

(The same class of issue likely affects other `emr-api` / `investigation-api` endpoints that accept an
MRN and return patient data.)

## 3. Observed behavior
Authenticated as a **Radiology Technologist** account (role intended for a single department/site):

1. `POST .../EMR/FetchRadiologyDetails` with body `{ "mrno": "<patient file number>" }` returns the
   patient's radiology order(s), including: patient/exam identity, `serviceName`, `modality`,
   `site`/`siteId` (branch), `billNo`, `orderedDate`, `accessionNumber`, `invPatTestResultId`,
   report/image status, and PACS references (`pacsId`, `cpacsUrl`, `cpacsDocpath`).
2. The request returns the **same record regardless of the `hospitalid` header value** — i.e. the
   apparent tenant-scoping header is **not enforced**; the response itself carries the patient's real
   `siteId`, so the caller is not restricted to their own site.
3. MRNs are **sequential/guessable** patient file numbers → records can be enumerated by incrementing
   the value.

> Net effect: a single low-privilege account can read cross-branch PHI and enumerate patient records
> without any additional privilege.

## 4. Impact
- **Confidentiality / PHI exposure:** patient identity, exam, clinical/order data, branch, and
  PACS/report links exposed across **all 14 branches** to an account scoped to one department.
- **Tenant isolation failure:** the multi-site model is not enforced at the authorization layer.
- **Enumeration:** sequential MRNs allow bulk harvesting of patient records.
- **Regulatory:** likely non-compliant with patient-data-protection obligations (e.g. Saudi **PDPL**,
  least-privilege/need-to-know requirements).

## 5. Root cause (assessed)
- **Missing object-level authorization (BOLA/IDOR):** the server does not verify that the
  authenticated user is entitled to view the requested MRN/order.
- **Client-trusted scoping:** site scoping appears to rely on a client-supplied `hospitalid` header
  rather than the server deriving the user's authorized sites from their identity — and even that
  header is not enforced.
- **Obfuscation ≠ security:** the login payload is client-side "encrypted" (`X-App-Mode: ENCV0`), which
  can give a false sense of protection while the underlying data-access authorization is weak.

## 6. Recommended remediation (for the vendor)
1. **Enforce server-side authorization on every EMR/radiology data endpoint.** Derive the caller's
   role and authorized site(s) from the authenticated identity (JWT/session) — **never** from a
   client-supplied `hospitalid` header — and reject requests for patients/orders outside that scope.
2. **Object-level access checks:** confirm the user is permitted to view the specific MRN/order before
   returning data.
3. **Least privilege:** re-scope the "Radiology Technologist" role to only the sites and data it needs.
4. **Anti-enumeration:** rate-limit and alert on bulk/sequential MRN queries; log access to patient
   records for audit.
5. **Treat MRN as a non-secret identifier** — authorization must not depend on its unpredictability.
6. Re-review the whole `emr-api` / `investigation-api` surface for the same pattern.

## 7. Responsible disclosure note
This finding concerns the customer's **own** Siratech deployment and was observed while building an
authorized internal integration. It is shared with the vendor so it can be fixed. The reporter did not
access any data outside their own organization and recommends the vendor validate and remediate across
all customers if the pattern is shared.

## 8. Suggested next steps for Meena Health (customer)
- Send this report to Siratech vendor security/support and request a fix + timeline.
- In the meantime, **rotate the shared account credentials** used during testing.
- Consider requesting the vendor's **official API** with a properly-scoped service account (the account
  token already advertises `GENERAL-API-ACCESS` / `API-LICENSE-ACCESS`).
