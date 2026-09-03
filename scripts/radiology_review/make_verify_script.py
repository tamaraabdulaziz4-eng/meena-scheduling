#!/usr/bin/env python3
"""Generate a browser-console script to eyeball-verify DONE / NOT DONE inside PACS.

The generated .js file embeds the cases (visible rows of the export files,
i.e. the rows left after the file's Excel filter) together with the verdict
computed by pacs_match.py. Pasted into the PACS web viewer's DevTools Console
it searches PACS per patient MRN (no full worklist download) and opens a side
panel that walks through the cases one by one, showing every PACS study of that patient
(accession, exam, date, images) with the matched study highlighted, so the
reviewer can agree/disagree and copy the list of disagreements at the end.

Usage:
    python3 make_verify_script.py N3_JUL.xlsx N3_AUG.xlsx \
        --pacs pacs_jul_aug.json pacs_jul_aug_part2.json \
        --from 2026-07-01 --to 2026-08-31 --out pacs_verify.js

The .js output contains patient identifiers: keep it inside the hospital.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pacs_match import VERDICT_COL, load_export, load_pacs, match, verdict, visible_rows  # noqa: E402
from sameday_fill import decide  # noqa: E402

TEMPLATE = r"""
(async () => {
  const CASES = __CASES__;
  const FROM = '__FROM__', TO = '__TO__';
  const BASE = location.origin + '/dataController/proxy';
  const EP = 'https://localhost:9096/service/desktop/';
  const hdr = ep => ({ 'Content-Type': 'application/json', 'Service-End-Point': ep, 'Cache-Control': 'no-cache', 'Pragma': 'no-cache', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' });
  const get = async ep => { const r = await fetch(BASE, { headers: hdr(ep), credentials: 'include' }); return { status: r.status, text: await r.text() }; };

  // ---------- panel
  const old = document.getElementById('pacsVerifyPanel'); if (old) old.remove();
  const P = document.createElement('div'); P.id = 'pacsVerifyPanel';
  P.style.cssText = 'position:fixed;top:0;right:0;width:560px;height:100vh;overflow:auto;background:#fff;color:#111;z-index:2147483647;font:13px Arial,sans-serif;border-left:3px solid #1f4e79;padding:10px;box-sizing:border-box;direction:ltr;text-align:left';
  document.body.appendChild(P);
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const setMsg = m => { P.innerHTML = '<h3 style="margin:4px 0">PACS verify</h3><div>' + esc(m) + '</div>'; };

  // ---------- per-patient search (no full worklist download)
  const ATTR = 'attributes=03,04,17,27,08,09,10';
  const parseItems = t => { let items = []; try { JSON.parse(t).data.forEach(b => { if (Array.isArray(b)) items = items.concat(b); }); } catch (e) {} return items; };
  const toStudy = w => ({ rp: w.requestedProcedureId, acc: w.procedureAccessionNo || '(no accession)', code: w.procedureCode, text: w.procedureText, status: w.procedureStatus, date: (w.procedureStartTime || '').slice(0, 16), mod: w.procedureModality, img: w.imageCount || 0, mrn: (w.patientIdentifier && w.patientIdentifier[0] && w.patientIdentifier[0].value) || '' });
  let TEMPLATE = null; // endpoint with {MRN} placeholder
  const cache = {};

  async function tryKeys(mrn) {
    for (const key of ['patientId', 'patientID', 'patientIdentifier', 'mrn', 'MRN', 'pid', 'patientNumber']) {
      const ep = `${EP}worklists/28?${ATTR}&filter=fromDate:${FROM};toDate:${TO};${key}:{MRN}&startR=1&endR=200`;
      try {
        const r = await get(ep.replace('{MRN}', mrn));
        if (r.status !== 200) continue;
        const items = parseItems(r.text).map(it => toStudy(it.workItem));
        if (items.length && items.every(x => x.mrn === mrn)) { console.log('PACS search key found:', key); return ep; }
      } catch (e) {}
    }
    return null;
  }

  function learnFromUI() {
    // watch the page's own requests until one carries an 8-digit MRN in Service-End-Point
    return new Promise(resolve => {
      const XH = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        if (/service-end-point/i.test(k) && /worklist|search|patient/i.test(v)) {
          const m = String(v).match(/(?<![0-9])(\d{8})(?![0-9])/);
          if (m) {
            XMLHttpRequest.prototype.setRequestHeader = XH;
            let ep = String(v).split(m[1]).join('{MRN}');
            ep = ep.replace(/timeRange:[^;&]*/, `fromDate:${FROM};toDate:${TO}`).replace(/;?imageCount:[^;&]*/, '');
            if (!/fromDate/.test(ep)) ep = ep.replace('filter=', `filter=fromDate:${FROM};toDate:${TO};`);
            ep = ep.replace(/endR=\d+/, 'endR=200');
            console.log('learned PACS search endpoint:', ep);
            resolve(ep);
          }
        }
        return XH.apply(this, arguments);
      };
    });
  }

  async function getStudies(mrn) {
    if (cache[mrn]) return cache[mrn];
    const r = await get(TEMPLATE.replace('{MRN}', mrn));
    const items = r.status === 200 ? parseItems(r.text).map(it => toStudy(it.workItem)) : [];
    const list = items.filter(x => x.mrn === mrn && x.date.slice(0, 10) >= FROM && x.date.slice(0, 10) <= TO).sort((x, y) => x.date < y.date ? -1 : 1);
    cache[mrn] = list;
    return list;
  }

  setMsg('Finding how PACS searches by MRN ...');
  TEMPLATE = await tryKeys(CASES[0].mrn);
  if (!TEMPLATE) {
    setMsg('Could not guess the MRN search field. Please search ONE patient by MRN in the PACS page now (type any 8-digit MRN in the search box and press Enter). The panel will continue automatically.');
    TEMPLATE = await learnFromUI();
  }

  // ---------- state
  let i = 0, fVerdict = 'ALL', fMonth = 'ALL';
  const marks = {};
  const list = () => CASES.filter(c => (fVerdict === 'ALL' || c.v === fVerdict) && (fMonth === 'ALL' || c.date.slice(0, 7) === fMonth));
  const months = [...new Set(CASES.map(c => c.date.slice(0, 7)))].sort();

  const btn = (label, on, active) => `<button data-act="${on}" style="margin:2px;padding:4px 8px;cursor:pointer;border:1px solid #888;border-radius:4px;background:${active ? '#1f4e79' : '#f3f3f3'};color:${active ? '#fff' : '#111'}">${label}</button>`;

  function render() {
    const L = list();
    if (!L.length) { P.innerHTML = '<h3>PACS verify</h3><div>No cases for this filter.</div>' + btn('ALL', 'fv:ALL', true); bind(); return; }
    if (i >= L.length) i = L.length - 1; if (i < 0) i = 0;
    const c = L[i];
    const studies = cache[c.mrn];
    if (!studies) { P.innerHTML = `<h3 style="margin:4px 0">PACS verify: case ${i + 1} / ${L.length}</h3><div>Searching PACS for MRN ${esc(c.mrn)} ...</div>`; getStudies(c.mrn).then(() => { if (list()[i] === c) render(); }); return; }
    const done = c.v === 'DONE';
    const agreeN = Object.values(marks).filter(m => m === 'agree').length, disN = Object.values(marks).filter(m => m === 'disagree').length;
    let h = `<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:4px 0">PACS verify: case ${i + 1} / ${L.length}</h3><span>${btn('▶ Run all automatically', 'runall', true)}${btn('✕ close', 'close')}</span></div>`;
    h += `<div style="margin:4px 0">${btn('ALL', 'fv:ALL', fVerdict === 'ALL')}${btn('DONE only', 'fv:DONE', fVerdict === 'DONE')}${btn('NOT DONE only', 'fv:NOT DONE', fVerdict === 'NOT DONE')} | ${btn('all months', 'fm:ALL', fMonth === 'ALL')}${months.map(m => btn(m, 'fm:' + m, fMonth === m)).join('')}</div>`;
    h += `<div style="border:1px solid #ccc;border-radius:6px;padding:8px;margin:6px 0;background:#fafafa">
      <div><b>Order</b> ${esc(c.id)} &nbsp; <b>Order date</b> ${esc(c.date)} &nbsp; <b>Status in system</b> ${esc(c.st)}</div>
      <div><b>MRN</b> <span style="font-size:16px">${esc(c.mrn)}</span> &nbsp; <b>Patient</b> ${esc(c.name)}</div>
      <div><b>Ordered exam</b> ${esc(c.exam)} <span style="color:#666">(${esc(c.code)})</span></div>
      <div style="margin-top:6px"><span style="display:inline-block;padding:4px 10px;border-radius:4px;font-weight:bold;background:${done ? '#c6efce' : '#ffc7ce'};color:${done ? '#006100' : '#9c0006'}">${esc(c.v)}</span>
      ${c.rp ? ` &nbsp; matched to <b>${esc(c.acc || '(no accession)')}</b>` : ' &nbsp; no matching study'}
      ${/^CONFIRMED/.test(c.note || '') ? `<div style="margin-top:6px;padding:5px 8px;border-radius:4px;font-weight:bold;background:${done ? '#006100' : '#9c0006'};color:#fff">✔ ${esc(c.note)}</div>` : (c.note ? `<div style="color:#666;margin-top:4px">${esc(c.note)}</div>` : '')}</div>
    </div>`;
    h += `<div><b>PACS studies for this patient (${FROM} .. ${TO}): ${studies.length}</b></div>`;
    if (!studies.length) h += `<div style="padding:8px;color:#9c0006">Nothing in PACS for MRN ${esc(c.mrn)} in this period.</div>`;
    else {
      h += '<table style="border-collapse:collapse;width:100%;margin:4px 0"><tr style="background:#ddebf7"><th style="border:1px solid #bbb;padding:3px">Accession</th><th style="border:1px solid #bbb;padding:3px">Date</th><th style="border:1px solid #bbb;padding:3px">Exam</th><th style="border:1px solid #bbb;padding:3px">Mod</th><th style="border:1px solid #bbb;padding:3px">Images</th><th style="border:1px solid #bbb;padding:3px">Status</th></tr>';
      for (const s of studies) {
        const hit = c.rp && s.rp === c.rp;
        const bg = hit ? (s.img > 0 ? '#c6efce' : '#ffc7ce') : (s.date.slice(0, 10) === c.date.slice(0, 10) ? '#fff2cc' : '#fff');
        const stTag = s.status === 'Ordered' ? ' <span style="color:#9c0006;font-weight:bold">(0 img)</span>' : '';
        h += `<tr style="background:${bg};${hit ? 'font-weight:bold' : ''}"><td style="border:1px solid #bbb;padding:3px">${esc(s.acc)}</td><td style="border:1px solid #bbb;padding:3px;white-space:nowrap">${esc(s.date)}</td><td style="border:1px solid #bbb;padding:3px">${esc(s.text)} <span style="color:#666">${esc(s.code)}</span></td><td style="border:1px solid #bbb;padding:3px">${esc(s.mod)}</td><td style="border:1px solid #bbb;padding:3px;text-align:center;font-size:15px">${esc(s.img)}</td><td style="border:1px solid #bbb;padding:3px">${esc(s.status)}${stTag}</td></tr>`;
      }
      h += '</table><div style="color:#666">green/red row = the study used for the verdict; yellow = same day as the order.</div>';
    }
    const m = marks[c.id] || '';
    h += `<div style="margin:10px 0">${btn('◀ Prev', 'prev')}${btn('Next ▶', 'next')} &nbsp; ${btn('✔ Agree', 'agree', m === 'agree')}${btn('✘ Disagree', 'disagree', m === 'disagree')} &nbsp; ${btn('Go to first unmarked', 'unmarked')}</div>`;
    h += `<div style="color:#666">Marked: ${agreeN} agree, ${disN} disagree. ${btn('Copy disagreements', 'copy')} (paste into Excel / notepad)</div>`;
    h += '<div style="color:#999;margin-top:6px">Keys: → next, ← prev, A agree, D disagree</div>';
    P.innerHTML = h; bind();
  }
  function act(a) {
    const L = list();
    if (a === 'close') { P.remove(); document.removeEventListener('keydown', onKey); return; }
    if (a === 'runall') { runAll(); return; }
    if (a === 'back') { render(); return; }
    if (a === 'copyres') { navigator.clipboard.writeText(JSON.stringify(window._pacsResult || [])).then(() => alert('Copied')).catch(() => alert('Clipboard blocked: run copy(JSON.stringify(window._pacsResult)) in the Console')); return; }
    if (a.startsWith('fv:')) { fVerdict = a.slice(3); i = 0; }
    else if (a.startsWith('fm:')) { fMonth = a.slice(3); i = 0; }
    else if (a === 'prev') i = Math.max(0, i - 1);
    else if (a === 'next') i = Math.min(L.length - 1, i + 1);
    else if (a === 'agree' || a === 'disagree') { marks[L[i].id] = a; i = Math.min(L.length - 1, i + 1); }
    else if (a === 'unmarked') { const k = L.findIndex(c => !marks[c.id]); if (k >= 0) i = k; }
    else if (a === 'copy') {
      const rows = ['Order ID\tOrder Date\tMRN\tPatient\tExam\tAuto verdict\tYour mark'];
      CASES.forEach(c => { if (marks[c.id]) rows.push([c.id, c.date, c.mrn, c.name, c.exam, c.v, marks[c.id]].join('\t')); });
      navigator.clipboard.writeText(rows.join('\n')).then(() => alert('Copied ' + (rows.length - 1) + ' marked cases')).catch(() => { console.log(rows.join('\n')); alert('Clipboard blocked: the list was printed in the Console'); });
      return;
    }
    render();
  }
  // ---------- automatic run of the same-visit rule against live PACS
  const FAMILY = { XR: ['DX', 'CR', 'DR', 'RF', 'XA', 'OT'], ULTRASOUND: ['US'], CT: ['CT'], MRI: ['MR'], MAMM: ['MG'], BMD: ['BM', 'OT'], FLUROSCOPY: ['RF', 'XA', 'DX'], FLUOROSCOPY: ['RF', 'XA', 'DX'], RADIOLOGY: null };
  const toMs = t => { const m = String(t || '').match(/(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})?:?(\d{2})?/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime() : NaN; };
  function liveVerdict(c, studies) {
    const od = toMs(c.date); if (isNaN(od)) return { v: 'NOT DONE', why: 'order has no date', sure: false };
    const fam = FAMILY[String(c.cat || '').toUpperCase()];
    const win = studies.filter(s => { const t = toMs(s.date); return !isNaN(t) && t >= od - 2 * 3600e3 && t <= od + 24 * 3600e3 && (fam === null || fam === undefined || fam.includes(s.mod)); }).sort((a, b) => toMs(a.date) - toMs(b.date));
    const img = win.filter(s => s.img > 0);
    const own = img.find(s => s.code === c.code);
    if (own) return { v: 'DONE', why: `CONFIRMED DONE: own exam ${own.status} with ${own.img} images`, sure: true, s: own };
    if (img.length) { const s = img.reduce((a, b) => b.img > a.img ? b : a); return { v: 'DONE', why: `images in same visit under ${s.text} (${s.status}, ${s.img} images)`, sure: false, s }; }
    const same = win.find(s => s.code === c.code);
    if (same) return { v: 'NOT DONE', why: `${same.status === 'Ordered' ? 'CONFIRMED NOT DONE' : 'NOT DONE'}: same exam registered same day as ${same.status} with 0 images`, sure: same.status === 'Ordered', s: same };
    if (win.length) return { v: 'NOT DONE', why: `only 0-image entries in this visit (${win[0].status})`, sure: false, s: win[0] };
    return { v: 'NOT DONE', why: 'nothing in PACS for this visit', sure: true };
  }
  async function runAll() {
    const out = []; let n = 0;
    for (const c of CASES) {
      n++;
      if (n % 5 === 0 || n === CASES.length) setMsg(`Auto-run: ${n} / ${CASES.length} (MRN ${c.mrn}) ...`);
      let st = [];
      try { st = await getStudies(c.mrn); } catch (e) { out.push({ ...c, live: 'ERROR', why: String(e), sure: false }); continue; }
      const r = liveVerdict(c, st);
      out.push({ id: c.id, date: c.date, mrn: c.mrn, name: c.name, exam: c.exam, code: c.code, cat: c.cat, st: c.st, offline: c.v, live: r.v, why: r.why, sure: r.sure, agree: r.v === c.v,
        evidence: r.s ? `${r.s.acc} | ${r.s.text} | ${r.s.date} | ${r.s.img} images | ${r.s.status}` : '',
        studies: st.map(s => `${s.acc} | ${s.text} | ${s.code} | ${s.date} | ${s.img} img | ${s.status}`) });
    }
    window._pacsResult = out;
    const sure = out.filter(x => x.sure).length, dis = out.filter(x => !x.agree).length;
    const json = JSON.stringify(out);
    try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = 'pacs_verify_result.json'; document.body.appendChild(a); a.click(); a.remove(); } catch (e) {}
    P.innerHTML = `<h3 style="margin:4px 0">Auto-run finished</h3><div>${out.length} cases checked live in PACS.<br>Sure: <b>${sure}</b> &nbsp; Need your review: <b>${out.length - sure}</b> &nbsp; Differ from the file: <b>${dis}</b></div>
      <div style="margin:8px 0">The file <b>pacs_verify_result.json</b> should have downloaded. If not: ${btn('Copy result', 'copyres')} then paste into Notepad and save as pacs_verify_result.json.</div>
      <div>${btn('Back to cases', 'back')}</div>`; bind();
  }
  function bind() { P.querySelectorAll('button[data-act]').forEach(b => b.onclick = () => act(b.dataset.act)); }
  function onKey(e) {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') act('next'); else if (e.key === 'ArrowLeft') act('prev');
    else if (e.key === 'a' || e.key === 'A') act('agree'); else if (e.key === 'd' || e.key === 'D') act('disagree');
  }
  document.addEventListener('keydown', onKey);
  render();
  console.log('PACS verify panel ready:', CASES.length, 'cases; searching PACS per MRN');
})();
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("exports", nargs="+")
    ap.add_argument("--pacs", nargs="+", required=True)
    ap.add_argument("--from", dest="date_from", required=True)
    ap.add_argument("--to", dest="date_to", required=True)
    ap.add_argument("--out", default="pacs_verify.js")
    ap.add_argument("--all-rows", action="store_true", help="include rows hidden by the Excel filter too")
    ap.add_argument("--rule", choices=["match", "sameday"], default="match", help="sameday = strict same-visit rule of sameday_fill.py")
    ap.add_argument("--branch", default="", help="only rows whose Branch contains this text")
    ap.add_argument("--drop-cancelled", action="store_true")
    args = ap.parse_args(argv)

    studies = load_pacs(args.pacs)
    per_file, all_orders, seq = [], [], 0
    for path in args.exports:
        _header, rows = load_export(path)
        for o in rows:
            o["_key"] = (path, o.get("Order ID"), seq)
            o["_seq"] = seq
            seq += 1
        all_orders.extend(rows)
        per_file.append((path, rows))
    match(all_orders, studies)
    by_mrn = {}
    for st in studies:
        st["start_full"] = st["start"]
        by_mrn.setdefault(st["mrn"], []).append(st)

    cases = []
    for path, rows in per_file:
        keep = None if args.all_rows else visible_rows(path)
        for idx, o in enumerate(rows):
            if keep is not None and idx not in keep:
                continue
            if args.branch and args.branch.lower() not in str(o.get("Branch") or "").lower():
                continue
            if args.drop_cancelled and str(o.get("Order Status") or "").lower().startswith("cancel"):
                continue
            if args.rule == "sameday":
                v, st, why = decide(o, by_mrn.get(str(o.get("MRNO") or "").strip(), []))
                r = {VERDICT_COL: v, "PACS Accession": st["acc"] if st else "", "Notes": why}
                o["_study"] = st
            else:
                r = verdict(o)
            cases.append({
                "id": o.get("Order ID"),
                "date": str(o.get("Order Date") or "")[:16],
                "mrn": str(o.get("MRNO") or "").strip(),
                "name": o.get("Patient Name") or "",
                "exam": o.get("Exam / Service") or "",
                "code": o.get("Service Code") or "",
                "cat": o.get("Modality (Category)") or "",
                "st": o.get("Order Status") or "",
                "v": r[VERDICT_COL],
                "acc": r["PACS Accession"],
                "rp": o["_study"]["rpid"] if o.get("_study") else None,
                "note": r["Notes"],
            })
    js = (TEMPLATE.replace("__CASES__", json.dumps(cases, ensure_ascii=False))
          .replace("__FROM__", args.date_from).replace("__TO__", args.date_to))
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(js.strip() + "\n")
    print(f"{args.out}: {len(cases)} cases embedded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
