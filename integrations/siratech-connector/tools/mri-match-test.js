#!/usr/bin/env node
/*
 * mri-match-test.js — READ-ONLY accuracy test for the cross-system MRI/CT match.
 *
 * THE TEST (what you asked for): take a patient who has an MRI/CT request in
 * Siratech, pull their NATIONAL ID + the ORDER DATE, and use those to search the
 * OTHER company's system (MILLENSYS MiClinic) for the matching report — then eyeball
 * whether it lined up on the right patient/exam. We need MILLENSYS because our own
 * Siratech/DePACS stack does not carry those MRI reports.
 *
 * MATCH RULE: the report is produced AFTER the exam, which is after the order — so a
 * genuine match has the MILLENSYS report dated ON OR AFTER the Siratech order date
 * (within a forward window; see MATCH_FORWARD_DAYS). A report dated before the order
 * can't belong to it and is rejected.
 *
 * It runs in two halves:
 *   HALF 1 — Siratech (fully working). Given ANY identifier (national ID / Iqama /
 *            MRN / name), it resolves the patient and lists their MRI/CT orders with
 *            the national ID and order date. This is the KEY you search MILLENSYS with.
 *   HALF 2 — MILLENSYS (runs when MILLENSYS_COOKIE is set). Uses millensys.js — the
 *            CONFIRMED read chain (GetPatients by SsnNumber → EncouterDataGetById →
 *            EncouterServicesId → GetResaultsGridData) — to find the matching MRI/CT
 *            report by national ID, enforcing the report-after-order rule.
 *
 * It reuses the connector's OWN local HTTP API (localhost, Bearer CONNECTOR_TOKEN), so
 * it obeys the "log in once, read specific endpoints" rule. It WRITES NOTHING.
 *
 *   cd /root/meena-scheduling/integrations/siratech-connector
 *   node tools/mri-match-test.js <nationalId | iqama | MRN | name>
 *   # for the MILLENSYS half, export MILLENSYS_COOKIE (a logged-in MiClinic session cookie)
 *
 * Output contains patient data — run it on the VPS, for your eyes only. When sharing
 * with me, the NATIONAL ID / EXAM / DATE lines are enough; redact the name.
 */
const http = require('http');
const https = require('https');
// millensys.js sits one dir up in the connector; fall back if run from elsewhere.
let millensys = null;
try { millensys = require('../millensys.js'); } catch (_e) { try { millensys = require('./millensys.js'); } catch (_e2) { millensys = null; } }

// ── config ────────────────────────────────────────────────────────────────────
// The connector's own local API (already running on the VPS).
const CONNECTOR_BASE = (process.env.CONNECTOR_BASE || 'http://127.0.0.1:3005').replace(/\/+$/, '');
const CONNECTOR_TOKEN = process.env.CONNECTOR_TOKEN || '';

const arg = String(process.argv[2] || '').trim();
if (!arg) {
  console.error('usage: node tools/mri-match-test.js <nationalId | iqama | MRN | name>');
  console.error('       node tools/mri-match-test.js find [howMany]   # find MRI/CT patients WITH a national ID');
  process.exit(1);
}
if (!CONNECTOR_TOKEN) {
  console.error('CONNECTOR_TOKEN is not set — export it (same value the connector uses) and retry.');
  process.exit(1);
}

// ── tiny JSON HTTP helper (honours the local vs remote scheme) ──────────────────
function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { Accept: 'application/json', ...headers },
    };
    if (payload) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = payload.length;
    }
    const r = lib.request(opts, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_e) { /* leave as text */ }
        resolve({ status: resp.statusCode, json, text: data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const auth = { Authorization: `Bearer ${CONNECTOR_TOKEN}` };
const isMrOrCt = (mod) => /^(MR|CT)$/i.test(String(mod || '').trim());

// A report is produced AFTER the exam, which is after the order — so a genuine match
// has the MILLENSYS report dated ON OR AFTER the Siratech order date, within a forward
// window (default 0–120 days after). A report dated BEFORE the order can't be for it.
const FWD_WINDOW_DAYS = Number(process.env.MATCH_FORWARD_DAYS || 120);
function reportIsAfterOrder(orderDate, reportDate) {
  const o = orderDate ? Date.parse(orderDate) : NaN;
  const r = reportDate ? Date.parse(reportDate) : NaN;
  if (!Number.isFinite(o) || !Number.isFinite(r)) return null; // unknown — can't judge on date
  const days = (r - o) / 864e5;
  return days >= -0.5 && days <= FWD_WINDOW_DAYS; // allow same-day; reject anything earlier
}

// ── HALF 1 — Siratech: patient → MRI/CT orders → national ID + order date ───────
async function siratechSide() {
  console.log(`\n── Siratech ── searching for: ${arg}`);
  const s = await req('GET', `${CONNECTOR_BASE}/search?q=${encodeURIComponent(arg)}`, { headers: auth });
  if (s.status !== 200 || !s.json || !s.json.ok) {
    throw new Error(`/search failed (HTTP ${s.status}): ${s.json && s.json.error || s.text.slice(0, 200)}`);
  }
  const patients = s.json.patients || [];
  if (!patients.length) throw new Error(`no patient matched "${arg}" in Siratech.`);
  if (patients.length > 1) {
    console.log(`  ${patients.length} patients matched — using the first. Narrow the search if this is wrong:`);
    patients.slice(0, 5).forEach((p) => console.log(`    · MRN ${p.mrno || p.file}  ${p.name || ''}  nid=${p.nationalId || '—'}`));
  }
  const p = patients[0];
  const mrn = p.mrno || p.file || p.mrNo;
  let nationalId = p.nationalId || null;
  // Patient/Search often leaves the ID null even when it exists — it lives on the demographic
  // record. Backfill from the dedicated endpoint (PatientBannerInfo.nationalId / PatientData.cpr).
  if (!nationalId) {
    const n = await req('GET', `${CONNECTOR_BASE}/patient/${encodeURIComponent(mrn)}/national-id`, { headers: auth }).catch(() => null);
    if (n && n.json && n.json.ok && n.json.nationalId) nationalId = n.json.nationalId;
  }
  console.log(`  patient: MRN ${mrn}  ${p.name || ''}  (matchedBy: ${s.json.matchedBy || '—'})`);
  console.log(`  NATIONAL ID: ${nationalId || '‹none on record›'}`);

  const o = await req('GET', `${CONNECTOR_BASE}/patient/${encodeURIComponent(mrn)}/radiology-orders`, { headers: auth });
  if (o.status !== 200 || !o.json || !o.json.ok) {
    throw new Error(`/radiology-orders failed (HTTP ${o.status}): ${o.json && o.json.error || o.text.slice(0, 200)}`);
  }
  const all = o.json.orders || [];
  const mrct = all.filter((x) => isMrOrCt(x.modality));
  console.log(`  radiology orders: ${all.length} total · ${mrct.length} MRI/CT`);
  if (!mrct.length) {
    console.log('  → this patient has NO MRI/CT order in the last 180 days — pick a patient who does.');
    return { nationalId, mrn, orders: [] };
  }
  mrct.forEach((x, i) => {
    console.log(`    [${i + 1}] ${x.modality}  "${x.exam}"  ordered ${x.orderedDate || '—'}  state=${x.state}`);
  });
  return { nationalId, mrn, name: p.name || '', orders: mrct };
}

// ── HALF 2 — MILLENSYS: confirmed chain (national ID → matched MRI/CT report) ────
// Uses millensys.js: GetPatients(SsnNumber) → EncouterDataGetById(patid) →
// EncouterServicesId(EncounterId) → GetResaultsGridData. Enforces report-after-order.
async function millensysSide(nationalId, orders) {
  if (!millensys || !millensys.configured()) {
    console.log('\n── MILLENSYS ── SKIPPED (set MILLENSYS_COOKIE to enable the auto-compare).');
    console.log('   Export a logged-in MiClinic session cookie:  export MILLENSYS_COOKIE="<cookie>"');
    console.log('   (optional MILLENSYS_BASE, default https://mill.radcarehealth.com/MILLENSYS/MiClinic).');
    console.log(`   Then it searches RadCare by SsnNumber=${nationalId || '<national ID>'} and confirms the report.`);
    return;
  }
  if (!nationalId) { console.log('\n── MILLENSYS ── skipped: no national ID on the Siratech record to search with.'); return; }
  // The report must land on/after the EARLIEST Siratech MRI/CT order date.
  const orderDates = orders.map((x) => x.orderedDate).filter(Boolean);
  const earliestOrder = orderDates.length ? orderDates.reduce((a, b) => (Date.parse(a) < Date.parse(b) ? a : b)) : null;
  console.log(`\n── MILLENSYS ── ${millensys.BASE}  ·  SsnNumber=${nationalId}  ·  order=${earliestOrder || 'unknown'}`);
  let res;
  try { res = await millensys.matchMriReport({ nationalId, orderDate: earliestOrder }); }
  catch (e) { console.log('  MILLENSYS error: ' + e.message); return; }
  if (res.decision === 'no_patient') { console.log('  ✗ no RadCare patient with this national ID.'); return; }
  console.log(`  patient: RadCare PatientId ${res.patient.patientId} (code ${res.patient.patientCode})  ·  ${res.patient.encounters} encounter(s)`);
  const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');
  if (!res.candidates.length) { console.log('  no MRI/CT services found at RadCare for this patient.'); }
  res.candidates.forEach((c, i) => {
    const tag = c.afterOrder === true ? '✓ report after order' : c.afterOrder === false ? '✗ BEFORE order (reject)' : (c.hasReport ? '? date unknown' : '· no report yet');
    console.log(`    [${i + 1}] "${c.serviceName}" (${c.clinic})  svc=${iso(c.serviceDate)} report=${iso(c.reportDate)}  reportId=${c.clinicalReportId || '—'}  [${tag}]`);
  });
  if (res.decision === 'match') {
    console.log(`\n  ✅ MATCH: "${res.matched.serviceName}" report (ClinicalReportId ${res.matched.clinicalReportId}, ${res.matched.reportName})`);
    console.log(`     dated ${iso(res.matched.reportDate || res.matched.serviceDate)} — on/after the order ${earliestOrder}.`);
    if (res.matched.filePath) console.log(`     file: ${res.matched.filePath}`);
  } else if (res.decision === 'mrct_no_report') {
    console.log('\n  ⏳ MRI/CT found at RadCare but no report filed yet.');
  } else if (res.decision === 'report_before_order') {
    console.log('\n  ⚠ MRI/CT reports exist but all predate the order — not this order\'s report.');
  } else {
    console.log('\n  — no MRI/CT match at RadCare for this patient.');
  }
}

// ── FIND mode — scan recent MRI/CT worklist for patients WITH a national ID ──────
// Not every Siratech record has the Saudi ID / Iqama filled in, and you can only test
// the MILLENSYS national-ID join on a patient who has one. This walks the live worklist,
// keeps MR/CT rows, and checks each patient's national ID (cheap /search per MRN) until
// it has `want` patients that carry one. READ-ONLY.
async function findMode(want) {
  console.log(`\n── FIND ── scanning recent MRI/CT worklist for patients WITH a national ID (want ${want})`);
  const w = await req('GET', `${CONNECTOR_BASE}/worklist?modality=1`, { headers: auth });
  if (w.status !== 200 || !w.json || !w.json.ok) {
    throw new Error(`/worklist failed (HTTP ${w.status}): ${w.json && w.json.error || w.text.slice(0, 200)}`);
  }
  const items = (w.json.items || []).filter((it) => isMrOrCt(it.modality));
  const seen = new Set();
  const mrns = [];
  for (const it of items) { const m = String(it.mrno || '').trim(); if (m && !seen.has(m)) { seen.add(m); mrns.push({ mrno: m, exam: it.exam, orderDate: it.orderDate || it.orderedDate }); } }
  console.log(`  ${items.length} MRI/CT rows · ${mrns.length} unique patients · checking IDs…`);
  const hits = [];
  let checked = 0;
  for (const p of mrns) {
    if (hits.length >= want) break;
    if (checked >= 60) { console.log('  (stopped after 60 lookups)'); break; }
    checked++;
    const s = await req('GET', `${CONNECTOR_BASE}/search?q=${encodeURIComponent(p.mrno)}`, { headers: auth }).catch(() => null);
    const pat = s && s.json && s.json.ok && (s.json.patients || [])[0];
    let nid = pat && pat.nationalId;
    if (!nid) {
      const n = await req('GET', `${CONNECTOR_BASE}/patient/${encodeURIComponent(p.mrno)}/national-id`, { headers: auth }).catch(() => null);
      nid = n && n.json && n.json.ok && n.json.nationalId;
    }
    if (nid) {
      hits.push({ ...p, nationalId: nid, name: pat.name || '' });
      console.log(`  ✓ MRN ${p.mrno}  nid=${nid}  "${p.exam}"  ordered ${p.orderDate || '—'}`);
    }
  }
  if (!hits.length) {
    console.log(`\n  Checked ${checked} MRI/CT patients — NONE had a national ID on file in Siratech.`);
    console.log('  That is itself the finding: the national-ID join has poor coverage here.');
  } else {
    console.log(`\n  → Test the match with any of the ✓ patients above, e.g.:`);
    console.log(`     node ${process.argv[1].split('/').pop()} ${hits[0].mrno}`);
  }
  return hits;
}

(async () => {
  try {
    if (/^(find|--find)$/i.test(arg)) {
      const want = Math.max(1, Math.min(10, Number(process.argv[3]) || 3));
      await findMode(want);
      console.log('');
      return;
    }
    const { nationalId, orders } = await siratechSide();
    await millensysSide(nationalId, orders);
    console.log('');
  } catch (e) {
    console.error('\nFAILED: ' + (e.message || e));
    process.exit(1);
  }
})();
