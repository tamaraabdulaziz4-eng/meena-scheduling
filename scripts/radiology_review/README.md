# Radiology order review (DONE / NOT DONE)

Tools for the monthly "confirm whether each manually registered radiology
order was performed" request. Patient data (the `N3_*.xlsx` exports and the
PACS dumps) must never be committed; only these scripts live in git.

## 1. Export the PACS worklist (GE Universal Viewer)

The worklist has no export button, but the browser can ask the same backend
the grid uses. Open the worklist inside the hospital network, press F12,
open **Console**, and paste the snippet below (adjust the dates). It pages
through `worklists/28` (the "All Exams" list) 200 rows at a time and downloads
`pacs_<range>.json`.

```js
(async () => {
  const BASE = location.origin + '/dataController/proxy';
  const FILTER = 'fromDate:2026-07-01;toDate:2026-08-31';
  const EP = 'https://localhost:9096/service/desktop/';
  const hdr = ep => ({ 'Content-Type': 'application/json', 'Service-End-Point': ep, 'Cache-Control': 'no-cache', 'Pragma': 'no-cache', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' });
  const get = async ep => { const r = await fetch(BASE, { headers: hdr(ep), credentials: 'include' }); return { status: r.status, text: await r.text() }; };
  const pages = [], STEP = 200; let total = 0, empty = 0;
  for (let s = 1; s <= 60000; s += STEP) {
    const r = await get(`${EP}worklists/28?attributes=03,04,17,27,08,09,10&filter=${FILTER}&startR=${s}&endR=${s + STEP - 1}`);
    const n = (r.text.match(/"requestedProcedureId"/g) || []).length;
    console.log(`rows ${s}-${s + STEP - 1}: status ${r.status}, items ${n}`);
    if (r.status !== 200) break;
    if (n === 0) { if (++empty >= 2) break; else continue; }
    empty = 0; total += n; pages.push(JSON.parse(r.text));
  }
  window._pacsOut = { pages };
  console.log('TOTAL items:', total);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(window._pacsOut)], { type: 'application/json' }));
  a.download = 'pacs_export.json'; document.body.appendChild(a); a.click(); a.remove();
})();
```

Notes:
* Do not add `imageCount:Hide 0 Img Exams` to the filter: exams registered with
  0 images are exactly the ones that prove an order was **not** performed.
* Every request goes to `/dataController/proxy`; the real endpoint is in the
  `Service-End-Point` header. The response has one `workItem` per requested
  procedure with `procedureAccessionNo`, `procedureCode`, `procedureText`,
  `procedureStatus`, `procedureStartTime`, `imageCount` and the MRN in
  `patientIdentifier[0].value`.
* If the download is blocked, run `copy(JSON.stringify(window._pacsOut))` and
  paste into Notepad.

## 2. Fill DONE / NOT DONE automatically

```bash
pip install openpyxl
python3 pacs_match.py N3_JUL.xlsx N3_AUG.xlsx \
    --pacs pacs_jul_aug.json pacs_jul_aug_part2.json --out review_out
```

For every export it writes `<name>_REVIEWED.xlsx`:

| Sheet | Content |
|---|---|
| Radiology Orders | the original rows, `DONE OR NOT DONE` filled, plus Verified In / Match Type / Confidence / PACS evidence / Notes |
| Needs Check | yellow rows (system and PACS disagree) and medium/low-confidence rows |
| Summary | totals per branch and per decision rule |
| Instructions | AR/EN guidance for reviewers |

and `PACS_unmatched_studies.xlsx` with PACS studies that have images but
matched no order in the exports.

Decision rules (see the module docstring for details): each PACS study is
assigned to at most one order, first by exact service code, then by modality
family when PACS registered the exam under a generic name. Images > 0 means
DONE; a cancelled order or a 0-image registration or nothing in PACS means
NOT DONE; "result released" in the system without PACS evidence is DONE but
flagged for a manual check.

## 3. Optional: manual review workbooks

`build_review_workbooks.py` builds per-branch review workbooks (dropdowns,
one lookup per patient) for the cases that still need a manual check in
Cerner/DE when no PACS dump is available.
