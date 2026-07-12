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
 *   HALF 2 — MILLENSYS (off until you configure it). If MILLENSYS_BASE is set, it
 *            calls MILLENSYS with the national ID and prints what came back so you can
 *            compare. The exact search/report endpoints are NOT yet known (they were
 *            not in the ClinicWorklist dump), so they are env-configurable — see below.
 *
 * It reuses the connector's OWN local HTTP API (localhost, Bearer CONNECTOR_TOKEN), so
 * it obeys the "log in once, read specific endpoints" rule. It WRITES NOTHING.
 *
 *   cd /root/meena-scheduling/integrations/siratech-connector
 *   node tools/mri-match-test.js <nationalId | iqama | MRN | name>
 *
 * Output contains patient data — run it on the VPS, for your eyes only. When sharing
 * with me, the NATIONAL ID / EXAM / DATE lines are enough; redact the name.
 */
const http = require('http');
const https = require('https');

// ── config ────────────────────────────────────────────────────────────────────
// The connector's own local API (already running on the VPS).
const CONNECTOR_BASE = (process.env.CONNECTOR_BASE || 'http://127.0.0.1:3005').replace(/\/+$/, '');
const CONNECTOR_TOKEN = process.env.CONNECTOR_TOKEN || '';

// MILLENSYS MiClinic (the OTHER company). All OPTIONAL — half 2 is skipped if unset.
//   MILLENSYS_BASE       e.g. https://miclinic.<their-host>/MILLENSYS/MiClinic
//   MILLENSYS_COOKIE     a logged-in session cookie, OR
//   MILLENSYS_BEARER     a bearer token — whichever their SPA uses.
//   MILLENSYS_SEARCH     path that accepts a patient search (national ID). UNKNOWN yet —
//                        the ClinicWorklist dump only had status endpoints. Once you find
//                        their patient/worklist search, set it here, e.g.
//                        /ClinicWorklist/GetPatientWorklist  (GET/POST — see METHOD)
//   MILLENSYS_SEARCH_METHOD  GET | POST      (default POST)
//   MILLENSYS_SEARCH_PARAM   the field name their search expects the ID in (default nationalId)
const MS_BASE = (process.env.MILLENSYS_BASE || '').replace(/\/+$/, '');
const MS_COOKIE = process.env.MILLENSYS_COOKIE || '';
const MS_BEARER = process.env.MILLENSYS_BEARER || '';
const MS_SEARCH = process.env.MILLENSYS_SEARCH || '';
const MS_METHOD = (process.env.MILLENSYS_SEARCH_METHOD || 'POST').toUpperCase();
const MS_PARAM = process.env.MILLENSYS_SEARCH_PARAM || 'nationalId';

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
  const nationalId = p.nationalId || null;
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

// ── HALF 2 — MILLENSYS: search by national ID, show the candidate report(s) ─────
async function millensysSide(nationalId, orders) {
  if (!MS_BASE || !MS_SEARCH) {
    console.log('\n── MILLENSYS ── SKIPPED (set MILLENSYS_BASE + MILLENSYS_SEARCH to enable).');
    console.log('   To finish the accuracy test, search MILLENSYS MANUALLY with the national ID above');
    console.log('   and confirm the exam/date matches one of the MRI/CT orders listed. Send me their');
    console.log('   patient-search + report endpoints and I will wire the auto-compare here.');
    return;
  }
  if (!nationalId) { console.log('\n── MILLENSYS ── skipped: no national ID on the Siratech record to search with.'); return; }
  console.log(`\n── MILLENSYS ── searching ${MS_BASE}${MS_SEARCH} by ${MS_PARAM}=${nationalId}`);
  const headers = {};
  if (MS_COOKIE) headers.Cookie = MS_COOKIE;
  if (MS_BEARER) headers.Authorization = `Bearer ${MS_BEARER}`;
  const url = `${MS_BASE}${MS_SEARCH}`;
  let r;
  try {
    r = MS_METHOD === 'GET'
      ? await req('GET', `${url}?${encodeURIComponent(MS_PARAM)}=${encodeURIComponent(nationalId)}`, { headers })
      : await req('POST', url, { headers, body: { [MS_PARAM]: nationalId } });
  } catch (e) {
    console.log(`  MILLENSYS request errored: ${e.message}`);
    return;
  }
  console.log(`  HTTP ${r.status}`);
  if (!r.json) { console.log('  non-JSON response (first 400 chars):\n  ' + String(r.text).slice(0, 400)); return; }
  // Their worklist rows usually live under Data/data/rows — print the shape so we can
  // pin the report/exam/date fields on the next pass.
  const rows = r.json.Data || r.json.data || r.json.rows || (Array.isArray(r.json) ? r.json : null);
  if (Array.isArray(rows)) {
    console.log(`  ${rows.length} row(s) returned. First row fields: ${rows[0] ? Object.keys(rows[0]).slice(0, 40).join(', ') : '—'}`);
    // Earliest Siratech MRI/CT order date — the report must land on/after this.
    const orderDates = orders.map((x) => x.orderedDate).filter(Boolean);
    const earliestOrder = orderDates.length ? orderDates.reduce((a, b) => (Date.parse(a) < Date.parse(b) ? a : b)) : null;
    rows.slice(0, 10).forEach((row, i) => {
      const svc = row.ServiceName || row.serviceName || row.StudyDescription || '';
      // A report/verification date — NOT the order date — is what we compare against.
      const reportDate = row.ReportDate || row.VerifiedDate || row.ResultDate || row.StudyDate || row.CreationDate || '';
      const pid = row.PatientCode || row.PatientId || row.MRN || '';
      const after = earliestOrder ? reportIsAfterOrder(earliestOrder, reportDate) : null;
      const tag = after === true ? '✓ after order' : after === false ? '✗ BEFORE order (reject)' : '? date unknown';
      console.log(`    [${i + 1}] pid=${pid}  "${svc}"  report=${reportDate || '—'}   [${tag}]`);
    });
    console.log(`\n  → COMPARE: a genuine match is same patient + same exam, with the MILLENSYS`);
    console.log(`     report dated ON OR AFTER the Siratech order (${earliestOrder || 'order date unknown'}),`);
    console.log(`     within ${FWD_WINDOW_DAYS} days. Rows flagged "BEFORE order" are not this order's report.`);
  } else {
    console.log('  response was JSON but not a row array — dumping keys: ' + Object.keys(r.json).slice(0, 40).join(', '));
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
    const nid = pat && pat.nationalId;
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
