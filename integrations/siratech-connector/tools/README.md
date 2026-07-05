# MWL probe — read-only Modality Worklist check

A standalone diagnostic that queries the DICOM **Modality Worklist (MWL)** — the feed
Siratech pushes to the machines so they show the patient's order. That feed carries the
**accession number** we need to file every report to the exact order, which Siratech's
REST API does not expose. This probe confirms whether we can read it. It **writes
nothing** and is isolated from the live connector service (its own `package.json`).

## Where to run it

**On the VPS** (`156.244.12.174`), not the dev box — only the VPS can reach the
hospital-facing DICOM services. A Modality Worklist query is DICOM (raw TCP), so it
can't go through the cloud HTTPS proxy.

```bash
cd /root/meena-scheduling/integrations/siratech-connector/tools
npm install          # pulls dcmjs-dimse (pure JS, no build tools needed)
```

## What to collect first

From whoever configured the CT/MRI/US machines' worklist (Siratech, or your PACS/biomed
team) — this is the "worklist / MWL" entry in a modality's DICOM settings:

| You need | DICOM name | Typical value |
|---|---|---|
| Worklist server IP/host | — | e.g. `10.0.0.9` |
| Its DICOM port | — | often `104`, `11112`, or `2762` |
| **The AE title** | Called AE Title | e.g. `SIRATECH_MWL` |
| (maybe) our AE title | Calling AE Title | a name the server trusts — often set to a modality's own AE |

## Run

```bash
MWL_HOST=10.0.0.9 MWL_PORT=104 MWL_CALLED_AE=SIRATECH_MWL \
  node mwl-probe.js
```

Optional filters: `MWL_CALLING_AE=CT_SCANNER` (if the server allow-lists callers),
`MWL_DATE=TODAY`, `MWL_MODALITY=CT`, `MWL_LIMIT=50`.

## Reading the result

- **C-ECHO ✓** then a list of worklist items, each showing `accession / patient /
  procedure / modality` → success. If **every item has an AccessionNumber**, that number
  is the deterministic key: MWL accession === DePACS study accession → the exact order.
- **C-ECHO ✗** → we couldn't associate. Usually a wrong AE title/port, or our Calling AE
  isn't allow-listed (retry with `MWL_CALLING_AE` set to an existing modality's AE title).
  The probe prints the likely causes.

Paste the output back and we'll decide the wiring. If accessions come back clean, this
replaces both the vendor request and the handoff-stamp dependency with one deterministic
source.

## Windows / hospital-PC variant (no installs)

Hospital PCs often block installers (MSI error 1625). The probe also ships as ONE
self-contained file that only needs the Node.js **ZIP** (portable, no installer):

1. Build it (anywhere with npm): `npx esbuild mwl-probe-win-entry.js --bundle
   --platform=node --outfile=mwl-probe-win.js`
2. On the hospital PC: download https://nodejs.org/dist/latest-v22.x/ (the
   `win-x64.zip`), Extract All, rename the folder to `node`, put it next to
   `mwl-probe-win.js` + `RUN-MWL-PROBE.bat`, double-click the .bat.

`mwl-probe-win-entry.js` bakes in the discovered defaults (10.0.73.56:104,
AE `DMWL_AE`, today's date) — pass a calling AE as the first argument (e.g.
`RUN-MWL-PROBE.bat CTN3`) if the broker only answers machines it knows.
Verified end-to-end against a local MWL SCP (dcmjs-dimse), including the
association-rejected fallback path.
