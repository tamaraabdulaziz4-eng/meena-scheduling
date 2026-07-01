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
const normMod = (m) => MOD_MAP[String(m || '').toUpperCase().trim()] || String(m || '').toUpperCase().trim();

// Words that describe the *body part* — strip modality/laterality/generic filler so
// only anatomy is compared (SHOULDER vs HUMERUS must NOT collide).
const STOP = new Set(['XR', 'CT', 'MR', 'MRI', 'US', 'THE', 'AND', 'VIEW', 'VIEWS', 'VIEWS.', 'AP',
  'PA', 'LAT', 'LATERAL', 'OBLIQUE', 'LT', 'RT', 'LEFT', 'RIGHT', 'BILATERAL', 'WITH', 'WITHOUT',
  'CONTRAST', 'SERIES', 'STUDY', 'SCAN', 'PLAIN', 'ROUTINE', 'PORTABLE', 'MIN', 'STANDING']);
function bodyTokens(s) {
  return [...new Set(String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)))];
}

function parseAccessionFromIuid(iuid) {
  // e.g. "1.2.840.4892943.343.20260624212234.60176" → "60176"
  const m = String(iuid || '').match(/\.(\d{3,})$/);
  return m ? m[1] : null;
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
      accession: s.accession_number || parseAccessionFromIuid(s.study_iuid),
      accessionRaw: s.accession_number || null,
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
  const orderTokens = bodyTokens(order.serviceName);
  const orderTime = order.orderDate ? new Date(order.orderDate).getTime() : null;
  const orderAcc = order.accession ? String(order.accession).trim() : null;

  const verified = studies.filter((s) => String(s.status).toUpperCase() === 'VERIFIED');

  // PRIMARY: accession (deterministic) — only when the order actually has one.
  if (orderAcc) {
    const hits = verified.filter((s) => s.accession && String(s.accession).trim() === orderAcc);
    if (hits.length === 1) return { decision: 'unique', key: 'accession', study: hits[0], candidates: hits, reason: `accession ${orderAcc}` };
    if (hits.length > 1) return { decision: 'ambiguous', key: 'accession', candidates: hits, reason: `${hits.length} studies share accession ${orderAcc}` };
    // no accession hit → fall through to body-part+time (do not fail outright)
  }

  // FALLBACK: modality + body-part + time window.
  const scored = verified.map((s) => {
    const stTokens = bodyTokens(s.desc);
    const overlap = orderTokens.filter((t) => stTokens.includes(t));
    const modOk = normMod(s.modality) === orderMod;
    let inWindow = true;
    if (orderTime != null && s.studyDate) {
      const gap = new Date(s.studyDate).getTime() - orderTime;
      inWindow = gap >= -windowBeforeH * 3600e3 && gap <= windowAfterH * 3600e3;
    }
    return { study: s, modOk, bodyOverlap: overlap, inWindow };
  });

  const survivors = scored.filter((c) => c.modOk && c.bodyOverlap.length > 0 && c.inWindow);
  const candidates = scored
    .filter((c) => c.modOk)
    .map((c) => ({ studyId: c.study.studyId, desc: c.study.desc, studyDate: c.study.studyDate, modality: c.study.modality, bodyMatch: c.bodyOverlap, inWindow: c.inWindow }));

  if (survivors.length === 1) return { decision: 'unique', key: 'bodypart+time', study: survivors[0].study, candidates, reason: `body-part [${survivors[0].bodyOverlap.join(',')}] within time window` };
  if (survivors.length === 0) return { decision: 'none', key: 'bodypart+time', candidates, reason: 'no VERIFIED study matched modality + body-part + time window' };
  return { decision: 'ambiguous', key: 'bodypart+time', candidates, reason: `${survivors.length} studies matched — refusing to guess` };
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
  dpAgent, normMod, bodyTokens, parseAccessionFromIuid,
  depacsStudies, depacsReport, matchStudy,
  radiologySearchBody, radiologyDetailsBody,
};
