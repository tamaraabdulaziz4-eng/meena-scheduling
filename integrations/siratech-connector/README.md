# Siratech HIS connector

A small HTTP service Meena calls to read a patient's **radiology orders** and
**demographics** from the hospital system (Siratech HIS).

## Why it exists (and where it must run)

`his.meena-health.com` is behind Cloudflare and **only answers from a Saudi IP** —
datacenter IPs elsewhere get `403`. So this service must run on a KSA-reachable
host (the same VPS as `whatsapp-bridge`). Meena (deployed elsewhere) calls it over
HTTP with a bearer token.

Siratech's `SignIn` body is **encrypted** (`X-App-Mode: ENCV0`), so credentials
can't be POSTed directly. The connector logs in **once through headless Chromium**
to capture a normal Bearer JWT (+ the `hospitalid` header), caches it (~55 min),
and then makes plain REST calls.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + token age |
| GET | `/patient/:file` | radiology orders + patient for a file (MRN) number |
| GET | `/search?q=` | partial name/MRN search → patient rows |
| GET | `/results/match/:file` | match pending radiology order(s) → the VERIFIED DePACS study holding the report (read-only, no-guess gate) |
| POST | `/results/match` | `{file, billNo}` — match one specific order |

### Radiology result linking (`/results/match`)

The reverse of the handoff: once the radiologist VERIFIES a report in DePACS, we
find which Siratech radiology order it belongs to — **without ever landing a
report on the wrong patient/exam**. The matcher is deliberately strict:

- **Primary key — accession number.** If the order has a generated accession and a
  DePACS study carries the same `accession_number` (or its `study_iuid` ends with
  it), that is a deterministic 1:1 link. (Today accession is rarely populated, so
  the fallback usually runs.)
- **Fallback — MRN + modality (DX/CR→XR) + body-part + tight time window.** The
  DePACS `study_desc` body-part tokens must overlap the Siratech `serviceName`, and
  the study must fall in a window around the order date. **Exactly one** candidate
  must survive; zero or several ⇒ `decision:"none"|"ambiguous"` and the caller must
  route it to manual review. Never guesses.

Response `decision` is `"unique" | "none" | "ambiguous"`; on `unique` it includes
the matched `study` and a `report` preview (+ whether the PDF is fetchable). It
does **not** write anything — filing the report into Result Entry is a separate,
guarded step.

Requires `DEPACS_USER` / `DEPACS_PASS` (Butterfly) and `RESULT_SITE` (the
logged-in user's site — the Result-Entry worklist is site-scoped; default `1`).

All but `/health` require `Authorization: Bearer $CONNECTOR_TOKEN`.

`/patient/:file` returns:

```json
{
  "ok": true,
  "file": "25052903",
  "patient": { "mrno", "name", "nameArabic", "phone", "gender", "age", "dob", "nationalId", "nationality", "isBilled" },
  "orders": [{
    "service": "US Obstetric", "modality": "US",
    "siteId": 3, "branch": "N3 - Al Rawdah",
    "priority": 0, "priorityText": "Routine",
    "billNo": "CR03000245126", "accessionNumber": null,
    "orderedDate": "07/01/2026 12:11:51",
    "status": "Pending", "imaged": false, "pacsId": "P1", "hasReport": false
  }],
  "count": 1
}
```

**Note on `accessionNumber` / `imaged`:** HIS assigns the accession number only
**after the study is performed / lands in PACS** — NOT at payment (a paid-but-not-
yet-imaged order still has `accessionNumber: null`). So `imaged` reflects
performed/in-PACS, not payment. The true payment flag isn't in this response;
`status` is the order's own HIS status. The clinical indication
(`GetEmrOrderDetails`) needs the order id, which HIS only populates later too.

## Deploy (on the VPS)

```bash
cd /opt/meena-scheduling && git pull
cd integrations/siratech-connector
cp .env.example .env && $EDITOR .env      # set CONNECTOR_TOKEN, HIS_USER, HIS_PASS
npm install                                # or reuse ../../whatsapp-bridge/node_modules
sudo cp meena-siratech.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now meena-siratech
curl -s localhost:3005/health
```

Then in Meena → Settings, set the connector URL (`http://<vps-ip>:3005`) and token.
