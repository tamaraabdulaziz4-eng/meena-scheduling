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
    "status": "Pending", "paid": false, "pacsId": "P1", "hasReport": false
  }],
  "count": 1
}
```

**Note on `accessionNumber` / paid:** HIS assigns the accession number (and the
internal order id) only **after the order is billed/paid**. Until then
`accessionNumber` is `null`, `status` is `"Pending"`, and the clinical indication
(`GetEmrOrderDetails`) is not retrievable for that order.

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
