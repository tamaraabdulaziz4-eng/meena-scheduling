// ── Radiology results linking (DePACS report → Siratech Result Entry) ─────────
//
// The reverse flow of the handoff: once the radiologist VERIFIES a report in
// Butterfly DePACS, we file that report back into Siratech's Radiology Result
// Entry and authorise it — WITHOUT ever landing a report on the wrong patient or
// the wrong exam. That safety guarantee is the whole point of this module, so the
// matcher is deliberately strict and refuses to guess.
//
// Endpoints (all reverse-engineered from the live Siratech SPA, proven read-only):
//   POST investigation-api /ResultEntryRadiology/RadiologySearch   -> worklist row(s)
//   POST investigation-api /ResultEntryRadiology/RadiologyDetails  -> result-entry template
//   POST investigation-api /ResultEntryRadiology/SaveRadiologyResultEntry          (WRITE)
//   POST investigation-api /ResultEntryRadiology/SaveRadiologyResultAuthorization  (WRITE)
//
// DePACS (Butterfly) side is read over its self-signed :10443 API.
//
// ── The matching gate (dual key) ──────────────────────────────────────────────
//  PRIMARY  — accession number. When the Siratech order has a generated accession
//             AND a DePACS study carries the same accession_number (or its
//             study_iuid ends with it), that is a deterministic 1:1 link. This is
//             the ideal key; it only works once the hospital populates accession
//             on arrival (today it is almost always null, so we fall back).
//  FALLBACK — same MRN + same modality (DX/CR→XR normalised) + body-part token
//             overlap between the DePACS study_desc and the Siratech serviceName
//             + a tight time window around the order date. Exactly ONE candidate
//             must survive; zero or several ⇒ ABORT and flag for manual review.
//
// Live proof (file 26289620, "XR SHOULDER" order on 2026-07-01): the patient had
// shoulder X-rays on three different dates AND a same-day humerus X-ray. Body-part
// alone left 3 candidates; body-part + time window isolated exactly one
// (study 1620407, "XR LT SHOULDER"). The humerus and the old shoulders were
// correctly rejected.

const https = require('https');

// Butterfly serves a self-signed cert; scope the leniency to its own agent only
// (never disable TLS verification globally).
const dpAgent = new https.Agent({ rejectUnauthorized: false });

const DEPACS_BASE = (process.env.DEPACS_BASE || 'https://test-api.diagnosticselite.net:10443/api/v1').replace(/\/+$/, '');
const DEPACS_USER = process.env.DEPACS_USER || 'Meenahealth3';
const DEPACS_PASS = process.env.DEPACS_PASS || '';

// ── small helpers ─────────────────────────────────────────────────────────────
const MOD_MAP = { DX: 'XR', CR: 'XR', DR: 'XR', XR: 'XR', CT: 'CT', MR: 'MR', MRI: 'MR', US: 'US', MG: 'MG', NM: 'NM', PT: 'PT', XA: 'XA' };
function normMod(m) {
  const s = String(m || '').toUpperCase().trim();
  if (MOD_MAP[s]) return MOD_MAP[s];
  // The Siratech category can be a label ("GENERAL X-RAY", "ULTRASOUND") rather than
  // a DICOM code — map those too, else a legitimate report would never match.
  if (/X-?RAY|RADIOGRAPH|\bDX\b|\bCR\b|\bDR\b/.test(s)) return 'XR';
  if (/ULTRA\s?SOUND|SONOGRAM|\bUS\b/.test(s)) return 'US';
  if (/\bCT\b|COMPUTED\s+TOMOG/.test(s)) return 'CT';
  if (/\bMRI?\b|MAGNETIC\s+RES/.test(s)) return 'MR';
  if (/MAMMOG|\bMG\b/.test(s)) return 'MG';
  return s;
}

// Anatomy tokens describe the *body part*: strip modality / view / generic filler.
// Laterality (left/right) is handled SEPARATELY (see sideOf) — it must never be
// silently discarded, or "XR LT SHOULDER" would match "XR RT SHOULDER".
const STOP = new Set(['XR', 'CT', 'MR', 'MRI', 'US', 'THE', 'AND', 'VIEW', 'VIEWS', 'VIEWS.', 'AP',
  'PA', 'LAT', 'LATERAL', 'OBLIQUE', 'LT', 'RT', 'LEFT', 'RIGHT', 'BILATERAL', 'BILAT', 'BOTH',
  'WITH', 'WITHOUT', 'CONTRAST', 'SERIES', 'STUDY', 'SCAN', 'PLAIN', 'ROUTINE', 'PORTABLE',
  'MIN', 'STANDING', 'ERECT', 'SUPINE', 'ONE', 'TWO', 'THREE']);
function bodyTokens(s) {
  return [...new Set(String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)))];
}

// Laterality of an exam name → 'L' | 'R' | 'B' | null. Only whole-word matches
// (so "RIB" is never read as right, "SILVER" never as left).
function sideOf(s) {
  const words = String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/);
  let l = false, r = false, b = false;
  for (const w of words) {
    if (w === 'LEFT' || w === 'LT') l = true;
    else if (w === 'RIGHT' || w === 'RT') r = true;
    else if (w === 'BILATERAL' || w === 'BILAT' || w === 'BOTH') b = true;
  }
  if (b || (l && r)) return 'B';
  if (l) return 'L';
  if (r) return 'R';
  return null;
}

// ── DePACS (Butterfly) client ─────────────────────────────────────────────────
async function dpFetch(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Token ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(DEPACS_BASE + path, { method, headers, agent: dpAgent, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_e) { json = null; }
  return { status: res.status, json, text };
}

let dpTok = { token: '', ts: 0 };
async function dpToken(force = false) {
  if (!force && dpTok.token && Date.now() - dpTok.ts < 20 * 60 * 1000) return dpTok.token;
  const r = await dpFetch('/auth/signin', { method: 'POST', body: { identifier: DEPACS_USER, password: DEPACS_PASS, device_id: DEPACS_USER + '_meena', platform: 'web' } });
  const token = r.json && r.json.body && r.json.body.access_token;
  if (!token) throw new Error('DePACS signin failed (HTTP ' + r.status + ')');
  dpTok = { token, ts: Date.now() };
  return token;
}

// All VERIFIED studies for an MRN, enriched with the report description (which the
// list endpoint leaves blank — it lives in the per-study report info).
async function depacsStudies(mrno) {
  const token = await dpToken();
  const r = await dpFetch(`/study/get_studies?start_date=2015-01-01&end_date=2035-12-31&page_size=100&current_page=1&patient_id=${encodeURIComponent(mrno)}`, { token });
  const rows = (r.json && r.json.body && r.json.body.data) || [];
  const out = [];
  for (const s of rows) {
    let desc = s.study_desc || '';
    if (!desc) {
      const info = await dpFetch('/report/get_study_report_info/' + s.study_id, { token });
      desc = (info.json && info.json.body && info.json.body.study_desc) || '';
    }
    out.push({
      studyId: s.study_id, iuid: s.study_iuid, modality: s.modality, desc,
      studyDate: s.study_date, status: s.study_status, patName: s.pat_name, patId: s.pat_id,
      // Only the REAL DICOM accession is a deterministic key. The study-UID's last
      // arc is NOT the accession (it just happens to coincide sometimes), so it must
      // never drive the primary match — that would risk a wrong-study bind.
      accession: s.accession_number || null,
    });
  }
  return out;
}

async function depacsReport(studyId) {
  const token = await dpToken();
  const info = await dpFetch('/report/get_study_report_info/' + studyId, { token });
  const b = (info.json && info.json.body) || {};
  const text = String(b.report_content || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const pdfRes = await fetch(DEPACS_BASE + '/report/open_report_pdf/' + studyId + '?style=2', { headers: { Authorization: 'Token ' + token }, agent: dpAgent });
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  const isPdf = pdfBuf.slice(0, 5).toString() === '%PDF-';
  return {
    reportId: b.report_id || null, patName: b.pat_name || '',
    reportText: text, reportDate: b.report_date || b.verification_date || null,
    reviewer: b.reviewer_name || null,
    pdfBase64: isPdf ? pdfBuf.toString('base64') : null, pdfBytes: pdfBuf.length, pdfOk: isPdf,
  };
}

// ── the strict matcher ────────────────────────────────────────────────────────
// order: { mrno, serviceName, categoryName, orderDate(ISO), accession? }
// Returns { decision:'unique'|'none'|'ambiguous', study?, candidates[], reason }
function matchStudy(order, studies, { windowBeforeH = 24, windowAfterH = 96 } = {}) {
  const orderMod = normMod(order.categoryName || order.modality);
  const orderAnat = bodyTokens(order.serviceName);
  const orderSide = sideOf(order.serviceName);
  const orderTime = order.orderDate ? new Date(order.orderDate).getTime() : null;
  const orderAcc = order.accession ? String(order.accession).trim() : null;

  const verified = studies.filter((s) => String(s.status).toUpperCase() === 'VERIFIED');

  // PRIMARY: accession (deterministic) — only on the REAL DICOM accession.
  if (orderAcc) {
    const hits = verified.filter((s) => s.accession && String(s.accession).trim() === orderAcc);
    if (hits.length === 1) return { decision: 'unique', key: 'accession', study: hits[0], candidates: hits.map(candOf), reason: `accession ${orderAcc}` };
    if (hits.length > 1) return { decision: 'ambiguous', key: 'accession', candidates: hits.map(candOf), reason: `${hits.length} studies share accession ${orderAcc}` };
    // no accession hit → fall through to body-part+time (do not fail outright)
  }

  // FALLBACK: modality + body-part (subset, side-aware) + time window.
  // Without a reliable order date we CANNOT confirm the study is the recent one,
  // so we refuse to call it unique — a stale prior study must not auto-match.
  const dateKnown = orderTime != null;
  const scored = verified.map((s) => {
    const stAnat = bodyTokens(s.desc);
    const stSide = sideOf(s.desc);
    const overlap = orderAnat.filter((t) => stAnat.includes(t));
    // The DePACS desc is usually terser than the order ("XR LT SHOULDER" vs
    // "XR SHOULDER / SCAPULA 3 VIEWS"), so we require the STUDY's anatomy to be a
    // subset of the ORDER's: the study must not introduce a DIFFERENT region. This
    // matches the terse study to the verbose order, yet still rejects
    // "CERVICAL SPINE" against a "LUMBAR SPINE" order (CERVICAL ∉ order).
    const anatOk = stAnat.length > 0 && orderAnat.length > 0 && stAnat.every((t) => orderAnat.includes(t));
    // laterality: reject only an EXPLICIT conflict (both sides named and different).
    const sideOk = !(orderSide && stSide && orderSide !== stSide);
    const modOk = normMod(s.modality) === orderMod;
    let inWindow = false;
    if (dateKnown && s.studyDate) {
      const gap = new Date(s.studyDate).getTime() - orderTime;
      inWindow = gap >= -windowBeforeH * 3600e3 && gap <= windowAfterH * 3600e3;
    }
    return { study: s, modOk, anatOk, sideOk, bodyOverlap: overlap, inWindow };
  });

  const survivors = scored.filter((c) => c.modOk && c.anatOk && c.sideOk && c.inWindow);
  const candidates = scored
    .filter((c) => c.modOk && (c.anatOk || c.bodyOverlap.length))
    .map((c) => ({ ...candOf(c.study), bodyMatch: c.bodyOverlap, inWindow: c.inWindow }));

  if (survivors.length === 1) return { decision: 'unique', key: 'bodypart+time', study: survivors[0].study, candidates, reason: `body-part [${orderAnat.join(',')}]${orderSide ? ' ' + orderSide : ''} within time window` };
  if (survivors.length > 1) return { decision: 'ambiguous', key: 'bodypart+time', candidates, reason: `${survivors.length} studies matched — refusing to guess` };
  if (!dateKnown) return { decision: 'none', key: 'bodypart+time', candidates, reason: 'order date unknown — cannot confirm timing; manual review' };
  return { decision: 'none', key: 'bodypart+time', candidates, reason: 'no VERIFIED study matched modality + body-part + time window' };
}

function candOf(s) {
  return { studyId: s.studyId, desc: s.desc, studyDate: s.studyDate, modality: s.modality, accession: s.accession };
}

// ── Siratech Result Entry (needs the shared hisFetch from server.js) ──────────
// The RadiologySearch body schema (field types matter: empId is a STRING,
// invCategoryId is nullable-decimal, visiType is int).
function radiologySearchBody({ mrno = '', billno = '', hospitalId = 1, empId, filterResult = '0' }) {
  return {
    mrno, billno, fromDate: '1900-01-01T00:00:00.000Z', toDate: '2035-12-31T23:59:59.000Z',
    baseCatgeory: 0, hospitalId, mode: 6, cpoeStatus: 0, isbilled: 0, empId: String(empId),
    visitno: '', selectionType: 1, filterResult, profileId: '', invCategoryId: null,
    baseInvCategoryId: 2, visitMode: '', invMastServiceId: 0, sampleNo: '',
    isCreditWithoutBilling: 0, cpoeSearchGroupMode: 0, searchType: 'B', visiType: 0,
  };
}

function radiologyDetailsBody(row, { hospitalId = 1, empId }) {
  return {
    mrno: row.mrno, gender: /^m/i.test(row.gender) ? 0 : 1, age: row.age, hospitalid: hospitalId,
    genpatbillingid: row.genPatBillingId, sampleno: row.sampleNo, invmastserviceid: row.invMastserviceId,
    emrpatinvorderid: 0, invpatbillingid: 0, physiologicalconditions: '', invpatorderid: 0,
    userId: String(empId), mode: 3, fromDate: '1900-01-01T00:00:00.000Z', toDate: '2035-12-31T23:59:59.000Z',
    categoryid: 0, selectionType: 1, searchType: 2,
  };
}

module.exports = {
  dpAgent, normMod, bodyTokens, sideOf,
  depacsStudies, depacsReport, matchStudy,
  radiologySearchBody, radiologyDetailsBody,
};
