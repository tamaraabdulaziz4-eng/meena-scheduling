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
const DEPACS_USER = process.env.DEPACS_USER || '';   // set via env — no hardcoded service account
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
// Canonicalise common radiology short-hand so a terse DePACS desc lines up with
// the verbose Siratech order. Applied to BOTH sides, so it only unifies wording —
// the unique/subset/modality/time gate still decides the match, nothing is loosened.
// Crucial for this DePACS instance, where the study description is a stub like
// "X L.SPNE" / "T SPINE" / "ABD" (and the single-letter region L/T/C would
// otherwise be dropped by the >2-char filter and lose the lumbar-vs-thoracic key).
function expandAnat(s) {
  let t = ' ' + String(s || '').toUpperCase().replace(/[^A-Z]/g, ' ').replace(/\s+/g, ' ') + ' ';
  t = t
    .replace(/\bLUMBO\s?SACRAL\b/g, ' LUMBAR SPINE ')
    .replace(/\bLUMBOSACRAL\b/g, ' LUMBAR SPINE ')
    .replace(/\bLUMBO\b/g, ' LUMBAR ')
    .replace(/\bL\s?S\s?SP?I?NE?\b/g, ' LUMBAR SPINE ')   // LS SPINE / LSSPINE
    .replace(/\bL\s?SP?I?NE?\b/g, ' LUMBAR SPINE ')       // L SPNE / L SPINE / LSPINE
    .replace(/\bT\s?SP?I?NE?\b/g, ' THORACIC SPINE ')     // T SPINE / TSPINE
    .replace(/\bD\s?SP?I?NE?\b/g, ' THORACIC SPINE ')     // D SPINE (dorsal)
    .replace(/\bDORSAL\b/g, ' THORACIC ')
    .replace(/\bC\s?SP?I?NE?\b/g, ' CERVICAL SPINE ')     // C SPINE / CSPINE
    .replace(/\bSPNE\b/g, ' SPINE ')
    .replace(/\bABDO?\b/g, ' ABDOMEN ')                   // ABD / ABDO
    .replace(/\bCXR\b/g, ' CHEST ');
  return t;
}
function bodyTokens(s) {
  return [...new Set(expandAnat(s).split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)))];
}

// Laterality of an exam name → 'L' | 'R' | 'B' | null. Only whole-word matches
// (so "RIB" is never read as right, "SILVER" never as left).
function sideOf(s) {
  const raw = String(s || '').toUpperCase();
  const words = raw.replace(/[^A-Z ]/g, ' ').split(/\s+/);
  let l = false, r = false, b = false;
  for (const w of words) {
    if (w === 'LEFT' || w === 'LT') l = true;
    else if (w === 'RIGHT' || w === 'RT') r = true;
    else if (w === 'BILATERAL' || w === 'BILAT' || w === 'BOTH') b = true;
  }
  // This DePACS instance also uses a compact "R."/"L." laterality prefix for
  // EXTREMITIES ("X R.KNEE", "L.SHOULDER"). Read it so a right-knee study can't
  // pass the side gate against a left-knee order. `L.` is overloaded — it also
  // means LUMBAR for the spine ("X L.SPNE") — so treat `L.` as "left" ONLY when it
  // is NOT immediately a spine token (SP…). `R.` is unambiguous (no spine region R).
  if (/\bR\.\s*[A-Z]/.test(raw)) r = true;
  if (/\bL\.\s*(?!SP)[A-Z]/.test(raw)) l = true;
  if (b || (l && r)) return 'B';
  if (l) return 'L';
  if (r) return 'R';
  return null;
}

// A study carries a FINAL, fileable report when its status is any of these. This
// mirrors server/main.py `_study_is_reported` so the forward flow's notion of
// "report ready" and the reverse flow's matcher agree on the SAME set of studies.
// Butterfly emits several terminal labels for a signed report (VERIFIED on this
// instance today, but APPROVED / SIGNED / COMPLETED / FINAL elsewhere and after
// addenda); keying the matcher strictly on the single word "VERIFIED" silently
// drops a freshly-signed study, and the matcher then reports "no candidate" for a
// report that is plainly ready — the exact review-needed symptom seen in the field.
const REPORTED_STATUS = /\b(VERIFIED|APPROVED|SIGNED|COMPLETED|REVIEWED|ADDENDUM|FINAL)\b/;
// A whitelist word alone isn't enough: "NOT VERIFIED" / "UN-SIGNED" / "PENDING FINAL"
// all contain a positive token but describe a DRAFT that must NEVER be filed. Reject
// any status carrying a negation/draft marker FIRST (purely additive — a plain
// "VERIFIED" still passes), so the auto-filer can't push an unsigned report.
// Also reject the "not-quite-final" pre-states that carry a positive token but are
// NOT a signed report: NON-VERIFIED, "TO BE VERIFIED", PARTIALLY VERIFIED.
const NOT_REPORTED = /\bNOT\b|\bNON[\s-]?(VERIFIED|SIGNED|APPROVED|REPORTED|REVIEWED|COMPLETE)|\bTO\s+BE\b|\bPARTIAL|\bPENDING\b|\bPRELIM|\bDRAFT\b|\bAWAIT|\bINCOMPLETE\b|IN[\s-]?PROGRESS|UN-?(VERIFIED|SIGNED|APPROVED|REVIEWED|COMPLETED)/;
function isReported(status) {
  const s = String(status || '').toUpperCase();
  if (NOT_REPORTED.test(s)) return false;
  return REPORTED_STATUS.test(s);
}

// A report EXISTS but is not yet signed — dictated/draft/awaiting verification. The
// board shows these distinctly ("Report not verified") so the operator can tell
// "images done, radiologist mid-report" apart from "images done, nothing written
// yet" and from a signed report. NEVER used for filing decisions (isReported guards
// that); display only.
function isDraftReport(status) {
  const s = String(status || '').toUpperCase();
  if (!s || isReported(s)) return false;
  if (/(DRAFT|PRELIM|DICTAT|TRANSCRIB|INTERIM|\bPARTIAL)/.test(s)) return true;
  // a verification word in a negated/pending form: "NOT VERIFIED", "TO BE SIGNED",
  // "PENDING APPROVAL", "UN-VERIFIED" — a report is in flight, not absent.
  return /(VERIF|SIGN|APPROV|REPORT)/.test(s)
      && /(\bNOT\b|\bNON\b|TO\s+BE|\bPEND|\bAWAIT|\bUN[\s-]?)/.test(s);
}

// The file-number (MRN) equality test used as the first match gate. DePACS is
// inconsistent about pat_id and stores it three ways:
//   • the bare MRN                     — "26336282"
//   • the MRN with the name glued on   — "26336282ELAZIM, WAEL"
//   • the MRN behind a source prefix   — "SIRA26336282" (the SIRA imaging/accession
//                                         workflow prepends its own tag)
// So match the MRN wherever it appears as a WHOLE number — with \d boundaries so a
// longer or different file number ("263362820", "126336282") can never masquerade
// as this one, and a name/prefix around it never blocks a legitimate match.
function sameMrn(patId, mrno) {
  const pid = String(patId == null ? '' : patId).trim();
  const m = String(mrno == null ? '' : mrno).trim();
  if (!pid || !m) return false;
  if (pid === m) return true;
  const esc = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?<!\\d)' + esc + '(?!\\d)').test(pid);
}

// ── DePACS (Butterfly) client ─────────────────────────────────────────────────
// DePACS serves a self-signed cert, so we must talk to it with an https.Agent
// that has rejectUnauthorized:false. Node 22's global fetch() is undici, which
// SILENTLY IGNORES the `agent` option (it wants `dispatcher`), so the TLS bypass
// never applied and every call failed cert verification. Go through the https
// module directly, which honours `agent` — and get a request timeout for free.
function dpRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body !== undefined && body !== null ? Buffer.from(body) : null;
    const opts = {
      method, agent: dpAgent,
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (payload) opts.headers['Content-Length'] = payload.length;
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('DePACS request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function dpFetch(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Token ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await dpRequest(DEPACS_BASE + path, { method, headers, body: payload });
  const text = res.buffer.toString('utf8');
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

// DePACS stores pat_id three ways (bare MRN, MRN+name, or a "SIRA"+MRN prefix).
// get_studies substring-matches, so a bare search usually finds all forms — but we
// search every candidate form and merge (deduped) so the reverse flow is exactly as
// robust as the forward reports lookup. The file-number GATE in matchStudy still
// filters out any study that isn't truly this patient's, so extra forms are safe.
function _fileCandidates(mrno) {
  const s = String(mrno == null ? '' : mrno).trim();
  const out = [];
  const add = (x) => { x = String(x || '').trim(); if (x && !out.includes(x)) out.push(x); };
  add(s);
  const m = s.match(/^\s*sira[\s\-_:]*(.+)$/i);      // strip a leading SIRA (+ separators)
  const bare = m ? m[1].trim() : s;
  add(bare);
  if (/^\d+$/.test(bare)) add('SIRA' + bare);        // a plain file number → also the SIRA-prefixed form
  return out;
}

// All studies for an MRN (across pat_id forms), enriched with the report description
// (which the list endpoint leaves blank — it lives in the per-study report info).
async function depacsStudies(mrno, opts = {}) {
  let token = await dpToken();
  const qs = (page, pid) => `/study/get_studies?start_date=2015-01-01&end_date=2035-12-31&page_size=100&current_page=${page}&patient_id=${encodeURIComponent(pid)}`;
  const fetchPage = async (page, pid) => {
    let r = await dpFetch(qs(page, pid), { token });
    if (r.status === 401) { token = await dpToken(true); r = await dpFetch(qs(page, pid), { token }); }  // token lapsed → refresh once
    if (!r || (r.status && r.status >= 400) || r.json == null) {
      throw new Error(`DePACS study lookup failed (HTTP ${r ? r.status : 'unreachable'})`);
    }
    return (r.json && r.json.body && r.json.body.data) || [];
  };
  // Page through ALL studies per candidate form, merged and deduped by study_id.
  const seen = new Set(), rows = [];
  let lastErr = null, anyOk = false;
  for (const pid of _fileCandidates(mrno)) {
    try {
      for (let page = 1; page <= 20; page++) {       // hard cap 2000 studies per form
        const batch = await fetchPage(page, pid);
        anyOk = true;
        for (const s of batch) { if (!seen.has(s.study_id)) { seen.add(s.study_id); rows.push(s); } }
        if (batch.length < 100) break;               // last page
      }
    } catch (e) { lastErr = e; }                      // one form's blip must not abort the others
  }
  // Surface a real outage (never an empty list) only if EVERY form failed.
  if (!anyOk && lastErr) throw lastErr;
  // The per-study report-info lookup (only needed when study_desc is blank) used to
  // run ONE AT A TIME — and on this instance study_desc is blank on MOST studies, so
  // a patient with 20 studies cost 20 sequential DePACS round-trips; the worklist
  // stage pass (many patients) multiplied that into minutes of shimmer. Run it with
  // bounded concurrency instead; order is preserved by index.
  const out = new Array(rows.length);
  let nextIdx = 0;
  const worker = async () => {
    for (;;) {
      const i = nextIdx++;
      if (i >= rows.length) return;
      const s = rows[i];
      let desc = s.study_desc || '';
      // light mode (stage checks): status/modality/date are enough — skip the
      // per-study report-info round-trip that only recovers a blank description.
      if (!desc && !opts.light) {
        const info = await dpFetch('/report/get_study_report_info/' + s.study_id, { token });
        desc = (info.json && info.json.body && info.json.body.study_desc) || '';
      }
      // This DePACS instance often leaves study_desc blank and puts the description
      // in the accession_number field ("X L.SPNE", "T SPINE"). Use it as the body-part
      // source when desc is empty — it only feeds the (still strict) body-part match.
      if (!desc && s.accession_number) desc = String(s.accession_number);
      out[i] = {
        studyId: s.study_id, iuid: s.study_iuid, modality: s.modality, desc,
        studyDate: s.study_date, status: s.study_status, patName: s.pat_name, patId: s.pat_id,
        // Only the REAL DICOM accession is a deterministic key. The study-UID's last
        // arc is NOT the accession (it just happens to coincide sometimes), so it must
        // never drive the primary match — that would risk a wrong-study bind.
        accession: s.accession_number || null,
      };
    }
  };
  await Promise.all(new Array(Math.max(1, Math.min(6, rows.length))).fill(0).map(worker));
  return out;
}

async function depacsReport(studyId) {
  const token = await dpToken();
  const info = await dpFetch('/report/get_study_report_info/' + studyId, { token });
  const b = (info.json && info.json.body) || {};
  const text = String(b.report_content || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const pdfRes = await dpRequest(DEPACS_BASE + '/report/open_report_pdf/' + studyId + '?style=2', { headers: { Authorization: 'Token ' + token } });
  const pdfBuf = pdfRes.buffer;
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

  // GATE 0 — the file number (MRN) is the FIRST, non-negotiable key: a study may
  // only ever bind to an order for the SAME patient file. DePACS is inconsistent
  // here (pat_id is sometimes the bare MRN "25097956", sometimes the MRN with the
  // name glued on: "25097956ELAZIM, WAEL"), so we require the MRN as a clean
  // prefix rather than exact equality — but a different patient can never match.
  const fileStudies = studies.filter((s) => sameMrn(s.patId, order.mrno));
  if (order.mrno && !fileStudies.length) {
    return { decision: 'none', key: 'file', candidates: [], reason: `no VERIFIED study found for file ${order.mrno}` };
  }

  const verified = fileStudies.filter((s) => isReported(s.status));

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
  return { studyId: s.studyId, desc: s.desc, studyDate: s.studyDate, modality: s.modality, accession: s.accession, iuid: s.iuid };
}

// ── Siratech Result Entry (needs the shared hisFetch from server.js) ──────────
// The RadiologySearch body schema (field types matter: empId is a STRING,
// invCategoryId is nullable-decimal, visiType is int).
function radiologySearchBody({ mrno = '', billno = '', hospitalId = 1, empId, filterResult = '0',
  fromDate = '1900-01-01T00:00:00.000Z', toDate = '2035-12-31T23:59:59.000Z' }) {
  return {
    mrno, billno, fromDate, toDate,
    baseCatgeory: 0, hospitalId, mode: 6, cpoeStatus: 0, isbilled: 0, empId: String(empId),
    visitno: '', selectionType: 1, filterResult, profileId: '', invCategoryId: null,
    baseInvCategoryId: 2, visitMode: '', invMastServiceId: 0, sampleNo: '',
    isCreditWithoutBilling: 0, cpoeSearchGroupMode: 0, searchType: 'B', visiType: '0',
  };
}

// ── Normal vs. abnormal classification ────────────────────────────────────────
// DePACS stores NO structured normal/abnormal flag — `category` is a study group
// ("Others"), and critical_result.critical_classification only marks CRITICAL
// findings. The verdict lives only in the free-text report's IMPRESSION section.
// So we read that section and classify, biasing to ABNORMAL when unclear (labelling
// a normal study abnormal only triggers a harmless review; the reverse could hide
// real pathology). The caller can always override the result explicitly.
const _NORMAL_IMPRESSION = /(normal study|unremarkable (study|examination|abdomen|chest|appearance|scan)|within normal limits|no (significant |radiographic |acute )?abnormalit|no abnormal finding|negative (study|examination)|study is normal|essentially normal|no evidence of (acute |significant )?(disease|abnormalit|patholog)|normal (chest|abdominal|radiographic|us|ultrasound|ct|mri) (study|examination|appearance|scan))/;
const _ABNORMAL_TERMS = /(calcul|stone|mass\b|lesion|fracture|scolio|spondyl|osteophy|retrolisthes|hernia|effusion|consolidat|nodul|cyst|dilat|stenos|opacit|collection|hydronephros|o?edema|h(a)?emorrhage|infiltrat|deformity|degener|tear\b|rupture|thromb|aneurysm|metasta|tumou?r|enlarged|thicken|narrow|gravel|distension|inflamm|abscess|fibroid|polyp|obstruct|occlus|ischem|infarct|fatty (liver|infiltration)|steatos)/;

function classifyRange(reportText) {
  const text = String(reportText || '');
  // Isolate the radiologist's verdict; fall back to the whole report if unlabelled.
  const m = text.match(/\b(IMPRESSION|CONCLUSION|OPINION)\s*:?\s*([\s\S]*)$/i);
  const impression = (m ? m[2] : text).replace(/\s+/g, ' ').trim();
  const imp = impression.toLowerCase();
  // Strip NEGATED clauses before hunting for pathology, so "no fracture", "without
  // effusion", "free of lesions" don't read as positive findings. We cut from the
  // negation cue up to the next clause boundary. The normal-statement test runs on
  // the ORIGINAL text (so "no abnormality" still counts as a normal verdict).
  const impPos = imp.replace(/\b(no|without|free of|negative for|absence of|rule out|r\/o|resolved|unremarkable)\b[^.,;:]*/g, ' ');
  const hasFinding = _ABNORMAL_TERMS.test(impPos);
  const saysNormal = _NORMAL_IMPRESSION.test(imp);
  let range = 'abnormal', reason;
  if (!imp) { reason = 'empty report — defaulting to abnormal (needs review)'; }
  else if (hasFinding) { reason = 'impression names positive finding(s)'; }
  else if (saysNormal) { range = 'normal'; reason = 'impression states a normal / unremarkable study'; }
  else { reason = 'no explicit normal statement in impression — defaulting to abnormal (safer)'; }
  return { range, impression: impression.slice(0, 300), reason, hadImpressionHeader: !!m };
}

// RadiologyDetails returns a row that the SaveRadiologyResultEntry DTO cannot bind
// as-is: ~20 string fields come back `null`, but the SPA coerces them to '' before
// posting and the server dereferences them (a null trips a server-side
// null-reference → HTTP 500 "Object reference not set", Error_Code 1005). It also
// adds a handful of fields RadiologyDetails omits. This normaliser replays exactly
// what the SPA sends, derived field-for-field from a live payload capture.
const ROW_STRING_EMPTY = ['addendum', 'criticalRange', 'dtlsdisplayorder', 'invPatOrderID',
  'invProfileserviceId', 'mastServiceName', 'methodid', 'methodname', 'noramlRange', 'oldAddendum',
  'parentID', 'previousresult', 'remarks', 'reportLink', 'resultComparisonOperator', 'resultCopyEmpId',
  'resultMachine', 'resultUnit', 'samplename', 'unauthorizeRemarks', 'doctorcontactstatusold'];
const ROW_NUM_ZERO = ['invVariantsRangeId', 'panicRangeId'];
const ROW_MISSING_DEFAULTS = { isNotNormal: 0, isPanic: 0, resultComparisonValue: null,
  resultEnteredAndAccepted: '0', unauthorizeRemarksId: null };

function normalizeResultRow(row) {
  const r = { ...row };
  for (const k of ROW_STRING_EMPTY) if (r[k] == null) r[k] = '';
  for (const k of ROW_NUM_ZERO) if (r[k] == null) r[k] = 0;
  for (const k of Object.keys(ROW_MISSING_DEFAULTS)) if (!(k in r)) r[k] = ROW_MISSING_DEFAULTS[k];
  return r;
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
  dpAgent, normMod, bodyTokens, sideOf, isReported, isDraftReport,
  depacsStudies, depacsReport, matchStudy,
  radiologySearchBody, radiologyDetailsBody, normalizeResultRow, classifyRange,
};
