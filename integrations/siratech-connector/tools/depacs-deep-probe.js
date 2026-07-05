#!/usr/bin/env node
/*
 * depacs-deep-probe.js — DEEP, READ-ONLY inspection of DePACS (Butterfly) for one
 * patient, to find EXACTLY which field carries the real DICOM accession and whether
 * it links to a Siratech order number.
 *
 * WHY: on this DePACS instance the `accession_number` field is often filled with the
 * body-part text ("T SPINE") instead of a clean accession ("SIRA1661"). The real
 * accession / requested-procedure / order key may live in another field or a richer
 * per-study endpoint the list view doesn't return. This tool dumps EVERYTHING DePACS
 * exposes for a patient's studies so we can pinpoint the deterministic key.
 *
 * It reuses the connector's OWN working DePACS client (results.js) — same creds/env,
 * no browser, no proxy. READ-ONLY: only GETs; never writes.
 *
 *   cd /root/meena-scheduling/integrations/siratech-connector
 *   node tools/depacs-deep-probe.js <MRN> [fromYYYY-MM-DD] [toYYYY-MM-DD]
 *
 * Output is for YOUR eyes on the VPS — it contains patient data. Do NOT paste patient
 * names anywhere public; when sharing with me, the ACCESSION / ID lines are enough.
 */
const results = require('../results.js');

const MRN = String(process.argv[2] || '').trim();
const FROM = process.argv[3] || '2015-01-01';
const TO = process.argv[4] || '2035-12-31';
if (!MRN) { console.error('usage: node tools/depacs-deep-probe.js <MRN> [from] [to]'); process.exit(1); }

// Field-name / value heuristics for "this looks like a real accession or an order key".
const KEYish = /acc|order|sira|barcode|requested|procedure|schedul|mwl|study_id\b|studyid|referring|visit|bill|encounter|req_/i;
const CLEAN_ACC = /^(sira[\s\-_]?\d+|[A-Z]{2,6}\d{3,}|\d{4,})$/i;   // a clean accession, not "T SPINE"
const looksBodyPart = (v) => /\b(spine|chest|abdomen|pelvis|head|neck|knee|ankle|wrist|hand|foot|shoulder|hip|brain|sinus|l\.?spne|c\.?spne|t\.?spne|kub|us|ct|mri|x[\s-]?ray)\b/i.test(String(v));

function flat(obj, prefix, out) {
  out = out || {};
  if (obj == null || typeof obj !== 'object') { out[prefix || 'value'] = obj; return out; }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else if (Array.isArray(v)) out[key] = '[' + v.length + ' items]';
    else out[key] = v;
  }
  return out;
}

async function tryGet(token, path) {
  try { const r = await results.dpFetch(path, { token }); return { ok: r.status < 400, status: r.status, json: r.json }; }
  catch (e) { return { ok: false, status: 0, err: String(e.message || e) }; }
}

(async () => {
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' DePACS DEEP PROBE — MRN', MRN, '| window', FROM, '→', TO);
  console.log('══════════════════════════════════════════════════════════════');
  let token;
  try { token = await results.dpToken(); console.log('✓ DePACS login OK\n'); }
  catch (e) {
    console.error('✗ DePACS login FAILED:', e.message);
    console.error('\n── signin diagnosis (password never shown) ──');
    try {
      const dbg = await results.depacsSigninDebug();
      console.error(JSON.stringify(dbg, null, 2));
      console.error('\nRead it like this:');
      console.error('  • userSet/passSet false      → the DEPACS_USER/DEPACS_PASS env vars aren\'t set on the connector.');
      console.error('  • message says invalid/wrong  → the DePACS credentials changed — update them.');
      console.error('  • tokenFound false but a token-looking key IS in responseShape → tell me the key name and I\'ll parse it.');
    } catch (e2) { console.error('  (could not run signin diagnosis:', e2.message, ')'); }
    process.exit(2);
  }

  // 1) The study SCHEMA — reveals every column/field DePACS knows (incl. a real
  //    "Accession Number" field distinct from the list row, if one exists).
  console.log('── 1) study/get_parameters (the full field/column schema) ──');
  const params = await tryGet(token, '/study/get_parameters');
  if (params.ok && params.json) {
    const body = params.json.body || params.json;
    const dump = JSON.stringify(body);
    console.log(dump.length > 2500 ? dump.slice(0, 2500) + ' …(truncated)' : dump);
    // Surface any parameter/column that mentions accession/order.
    const hits = (dump.match(/"[^"]*(accession|order|procedure|requested|barcode|sira)[^"]*"/gi) || []);
    if (hits.length) console.log('\n  ⭑ schema fields mentioning acc/order/procedure:', [...new Set(hits)].join(', '));
  } else console.log('  (get_parameters not available — HTTP', params.status, ')');

  // 2) The patient's studies — FULL raw rows, every field.
  console.log('\n── 2) study/get_studies (full raw rows) ──');
  const forms = results._fileCandidates(MRN);
  const seen = new Set(); const studies = [];
  for (const pid of forms) {
    for (let page = 1; page <= 10; page++) {
      const q = `/study/get_studies?start_date=${FROM}&end_date=${TO}&page_size=100&current_page=${page}&patient_id=${encodeURIComponent(pid)}`;
      const r = await tryGet(token, q);
      const rows = (r.json && r.json.body && r.json.body.data) || [];
      if (!rows.length) break;
      for (const s of rows) { if (!seen.has(s.study_id)) { seen.add(s.study_id); studies.push(s); } }
      if (rows.length < 100) break;
    }
  }
  console.log(`  file forms tried: ${forms.join(', ')}  →  ${studies.length} distinct studies\n`);
  if (!studies.length) { console.log('  No studies for this MRN in the window. Try a patient scanned recently, or widen the dates.'); process.exit(0); }

  // 3) For EACH study: dump every list-row field + the report-info body + probe a few
  //    likely per-study detail endpoints, and hunt for the real accession/order key.
  const detailPaths = (id) => [
    '/report/get_study_report_info/' + id,
    '/study/get_study/' + id,
    '/study/get_study_details/' + id,
    '/study/get_study_info/' + id,
    '/study/' + id,
  ];
  for (const s of studies.slice(0, 12)) {
    console.log('──────────────────────────────────────────────────────────────');
    console.log('STUDY', s.study_id, '|', s.modality, '|', s.study_date, '|', (s.study_status || ''));
    const rowFlat = flat(s);
    // list-row accession-ish fields
    for (const [k, v] of Object.entries(rowFlat)) {
      if (KEYish.test(k) || (typeof v === 'string' && CLEAN_ACC.test(v.trim()))) {
        const clean = typeof v === 'string' && CLEAN_ACC.test(v.trim()) && !looksBodyPart(v);
        console.log(`   [row] ${k} = ${JSON.stringify(v)}${clean ? '   ⭐ CLEAN ACCESSION-SHAPED' : (looksBodyPart(v) ? '   (body-part text)' : '')}`);
      }
    }
    // richer detail endpoints
    for (const path of detailPaths(s.study_id)) {
      const r = await tryGet(token, path);
      if (!r.ok || !r.json) continue;
      const body = r.json.body || r.json;
      const f = flat(body);
      const interesting = Object.entries(f).filter(([k, v]) =>
        KEYish.test(k) || (typeof v === 'string' && CLEAN_ACC.test(String(v).trim()) && !looksBodyPart(v)));
      if (interesting.length) {
        console.log(`   ↳ ${path}  (HTTP ${r.status}) — accession/order-ish fields:`);
        for (const [k, v] of interesting) {
          const clean = typeof v === 'string' && CLEAN_ACC.test(String(v).trim()) && !looksBodyPart(v);
          console.log(`        ${k} = ${JSON.stringify(v)}${clean ? '   ⭐ CLEAN' : ''}`);
        }
      }
    }
  }
  if (studies.length > 12) console.log(`\n(showing first 12 of ${studies.length} studies)`);

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' WHAT TO LOOK FOR:');
  console.log('  • A field marked ⭐ CLEAN ACCESSION-SHAPED (e.g. SIRA1661 / a 4+ digit id).');
  console.log('  • Then compare that value to the SAME exam\'s Bill No / order id in Siratech.');
  console.log('  • If they match → we can link deterministically from DePACS alone (no cPACS).');
  console.log('  Send me the ⭐ lines (+ the Siratech Bill No) and I\'ll wire the exact match.');
  console.log('══════════════════════════════════════════════════════════════');
})().catch((e) => { console.error('probe error:', e); process.exit(1); });
