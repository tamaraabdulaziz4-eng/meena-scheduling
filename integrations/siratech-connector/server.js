// ── Siratech HIS connector ────────────────────────────────────────────────────
// A tiny HTTP service that Meena calls to read a patient's radiology orders from
// the hospital system (Siratech HIS). It runs on a host with a Saudi IP (the same
// VPS as whatsapp-bridge) because his.meena-health.com is geo/Cloudflare-locked to
// KSA and refuses datacenter IPs elsewhere.
//
// Siratech's SignIn payload is ENCRYPTED (X-App-Mode: ENCV0), so creds can't be
// POSTed directly — we log in ONCE through a headless browser to obtain a normal
// Bearer JWT (+ the `hospitalid` header the app sends), cache it (~1h), and from
// then on make plain REST calls. Endpoints proven live against file 25052903:
//   POST  /emr-api/api/v1/EMR/FetchRadiologyDetails {mrno}  -> radiology orders
//   POST  /patient-api/api/v1/Patient/Search {mrNo}         -> patient demographics
//   POST  /emr-api/api/v1/EMR/FetchRadiologyReport {mrno}   -> finished report (if any)
//
// Clinical indication (GetEmrOrderDetails) needs the order id `emrPatDtlsInvOrderId`
// which HIS only populates AFTER the order is paid/billed — so it is exposed
// best-effort and is null for pending (unpaid) orders.

const express = require('express');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const results = require('./results');

const PORT = Number(process.env.PORT || 3005);
const HOST = process.env.HOST || '0.0.0.0';
const API_TOKEN = process.env.CONNECTOR_TOKEN || '';           // callers must send Bearer <this>
const HIS_BASE = (process.env.HIS_BASE || 'https://his.meena-health.com').replace(/\/+$/, '');
const HIS_USER = process.env.HIS_USER || '';
const HIS_PASS = process.env.HIS_PASS || '';
// Which site to select on the login screen. The order lookups work regardless of
// the picked site (HIS returns the order with its own siteId), so the first site
// is fine; override with HIS_SITE (matched case-insensitively against the option).
const HIS_SITE = (process.env.HIS_SITE || '').trim();
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 55 * 60 * 1000);
// The Result-Entry worklist is scoped to the logged-in user's site (not the
// order's original siteId), so result lookups use this site. Default 1 (proven).
const RESULT_SITE = Number(process.env.RESULT_SITE || 1);

if (!API_TOKEN) {
  console.warn('⚠  CONNECTOR_TOKEN is not set — /patient is UNAUTHENTICATED. Set it in production.');
}
if (!HIS_USER || !HIS_PASS) {
  console.error('✗ HIS_USER / HIS_PASS are required. Refusing to start.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '256kb' }));

// ── token cache + single-flight login ────────────────────────────────────────
let cache = { auth: '', hospitalid: '', ts: 0 };
let loginInFlight = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doHeadlessLogin() {
  const browser = await puppeteer.launch({
    headless: true,
    // Lean flags — this runs on a small (2 GB) VPS, so trim Chromium's footprint.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--no-zygote', '--disable-extensions',
           '--disable-background-networking', '--disable-software-rasterizer',
           '--js-flags=--max-old-space-size=256'],
  });
  try {
    const page = await browser.newPage();
    let auth = '', hospitalid = '';
    page.on('request', (r) => {
      const h = r.headers();
      if (/-api\/api\/v1\//i.test(r.url())) {
        if (h.authorization && !auth) auth = h.authorization;
        if (h.hospitalid && !hospitalid) hospitalid = h.hospitalid;
      }
    });
    await page.goto(HIS_BASE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('#mat-input-0', { timeout: 25000 });
    await page.click('#mat-input-0');
    await page.type('#mat-input-0', HIS_USER, { delay: 50 });
    await page.keyboard.press('Tab');           // triggers the encrypted site lookup
    await sleep(3500);
    const site = (await page.$('#focusablesite')) || (await page.$('mat-select'));
    if (site) {
      await site.click();
      await sleep(1500);
      const opts = await page.$$('mat-option');
      let picked = false;
      if (HIS_SITE) {
        for (const o of opts) {
          const t = (await o.evaluate((e) => e.innerText)).trim();
          if (t.toLowerCase().includes(HIS_SITE.toLowerCase())) { await o.click(); picked = true; break; }
        }
      }
      if (!picked && opts[0]) await opts[0].click();
      await sleep(1000);
    }
    await page.click('#passFocus');
    await page.type('#passFocus', HIS_PASS, { delay: 50 });
    await sleep(400);
    const btn = await page.evaluateHandle(() =>
      [...document.querySelectorAll('button')].find((e) => /login/i.test(e.innerText)));
    if (btn) await btn.click().catch(() => {});
    await sleep(9000);
    if (!auth) throw new Error('login did not yield an auth token (selectors/creds/site?)');
    cache = { auth, hospitalid: hospitalid || '', ts: Date.now() };
    console.log(`[his] logged in — token len ${auth.length}, hospitalid ${hospitalid || '(none)'}`);
    return cache;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function getToken(force = false) {
  if (!force && cache.auth && Date.now() - cache.ts < TOKEN_TTL_MS) return cache;
  if (!loginInFlight) {
    loginInFlight = doHeadlessLogin().finally(() => { loginInFlight = null; });
  }
  return loginInFlight;
}

// ── REST helper (retries once on 401/403 with a fresh login) ──────────────────
async function hisFetch(path, { method = 'POST', body } = {}) {
  const doCall = async (tok) => {
    const res = await fetch(HIS_BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Authorization: tok.auth,
        hospitalid: tok.hospitalid,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res;
  };
  let tok = await getToken();
  let res = await doCall(tok);
  if (res.status === 401 || res.status === 403) {
    tok = await getToken(true);
    res = await doCall(tok);
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_e) { json = null; }
  return { status: res.status, json, text };
}

// ── normalisation ─────────────────────────────────────────────────────────────
const clean = (s) => (s == null ? '' : String(s)).replace(/\^+/g, ' ').replace(/\s+/g, ' ').trim();

// MM/DD/YYYY [time] -> YYYY-MM-DD
function orderedDateToISO(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

// Enrich an order from the RIS panel (which carries the internal order id,
// billing status and encounter/ER) and then GetEmrOrderDetails (the clinical
// indication). FetchRISPanel is site-scoped, so it MUST use the order's siteId.
async function enrichOrder(mrno, o) {
  try {
    const d = orderedDateToISO(o.orderedDate);
    if (!d || o.siteId == null) return {};
    const ris = await hisFetch('/emr-api/api/v1/EMR/FetchRISPanel', { body: {
      mrno, fromDate: d + 'T00:00:00', toDate: d + 'T23:59:59',
      invMastServiceId: 0, apptResourceCategoryId: 0, apptResourceId: 0, providerId: '',
      serviceCategoryId: 0, emrPatRisPanelId: 0,
      userId: String(HIS_USER).padStart(8, '0'), hospitalId: o.siteId,
    } });
    const rows = (ris.json && ris.json.data) || [];
    const row = rows.find((r) => r.billNo === o.billNo) || rows[0];
    if (!row) return {};
    let indication = null, reason = null, remarks = null;
    if (row.emrPatDtlsInvOrderId) {
      const det = await hisFetch('/billing-api/api/v1/ServicePanel/GetEmrOrderDetails?EmrPatDtlsInvOrderId=' + row.emrPatDtlsInvOrderId, { method: 'GET' });
      const dd = (det.json && det.json.data) || {};
      indication = dd.clinicalIndication || null; reason = dd.reasonForOrder || null; remarks = dd.remarks || null;
    }
    return {
      clinicalIndication: indication, reasonForOrder: reason, remarks,
      billingStatus: row.billingStatus || null,
      encounter: row.encounter || null,                       // "ER" | "OP" | "IP"
      isER: (row.encounter || '').toUpperCase() === 'ER',
      provider: (row.providerName || '').trim() || null,
      payer: row.payerName || null,
      orderId: row.emrPatDtlsInvOrderId || null,
      risOrderStatus: row.risOrderStatus || null,
    };
  } catch (e) { return {}; }
}

function normalizeOrder(o, ext) {
  ext = ext || {};
  // `imaged` = accession present (performed / in PACS), NOT payment.
  const imaged = o.accessionNumber != null && String(o.accessionNumber).trim() !== '';
  return {
    service: o.serviceName || '',
    modality: o.modality || '',
    siteId: o.siteId,
    branch: o.site || '',                       // e.g. "N3 - Al Rawdah"
    priority: o.priority,                       // 0 = routine (HIS raw)
    priorityText: ext.isER ? 'Emergency' : (o.priority ? 'Emergency' : 'Routine'),
    billNo: o.billNo || null,
    accessionNumber: o.accessionNumber || null,
    orderedDate: o.orderedDate || null,
    status: o.cpoeStatusDescription || null,    // order's HIS status, e.g. "Pending"
    imaged,
    pacsId: o.pacsId || null,
    hasReport: !!o.hasRadiologyRepot,
    reportDate: o.reportDate || null,
    // ── enriched from RIS panel + GetEmrOrderDetails ──
    clinicalIndication: ext.clinicalIndication || null,
    reasonForOrder: ext.reasonForOrder || null,
    remarks: ext.remarks || null,
    billingStatus: ext.billingStatus || null,   // e.g. "Billed"
    encounter: ext.encounter || null,           // "ER" | "OP" | "IP"
    isER: !!ext.isER,
    provider: ext.provider || null,
    payer: ext.payer || null,
    orderId: ext.orderId || null,
  };
}

function normalizePatient(p) {
  if (!p) return null;
  return {
    mrno: p.mrno || '',
    name: clean(p.fullName || `${p.firstName || ''} ${p.lastName || ''}`),
    nameArabic: clean(p.fullNameArabic),
    phone: p.contactNumber || p.mobilePhone || '',
    gender: p.gender || '',
    age: p.age || '',
    dob: p.dob ? String(p.dob).slice(0, 10) : '',
    nationalId: p.saudiid || p.iqamaId || p.passportId || null,
    nationality: p.countryName || '',
    isBilled: !!p.isBilled,
  };
}

// The result-entry payloads need the logged-in employee id (empId). It lives in
// the JWT `nameid` claim captured at login — decode it from the cached token.
function currentEmpId() {
  try {
    const jwt = String(cache.auth || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    return payload.nameid || payload.sub || payload.UserId || null;
  } catch (_e) { return null; }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!API_TOKEN) return next();
  const expected = `Bearer ${API_TOKEN}`;
  const a = Buffer.from(req.headers.authorization || '');
  const b = Buffer.from(expected);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, loggedIn: !!cache.auth, tokenAgeMs: cache.auth ? Date.now() - cache.ts : null });
});

// Look up a patient's radiology orders by file (MRN) number.
app.get('/patient/:file', requireAuth, async (req, res) => {
  const file = String(req.params.file || '').trim();
  if (!file) return res.status(400).json({ ok: false, error: 'file (MRN) is required' });
  try {
    // Independent calls — a hiccup in patient-search must not lose the orders
    // (and vice-versa), so settle both and use whatever came back.
    const [radR, patR] = await Promise.allSettled([
      hisFetch('/emr-api/api/v1/EMR/FetchRadiologyDetails', { body: { mrno: file } }),
      hisFetch('/patient-api/api/v1/Patient/Search', { body: { mrNo: file } }),
    ]);
    const rad = radR.status === 'fulfilled' ? radR.value : null;
    const pat = patR.status === 'fulfilled' ? patR.value : null;
    // The radiology call MUST cleanly succeed, otherwise surface an error — never
    // report "no orders" for a transient failure (that misleads staff into
    // thinking the patient has no order when HIS was just unreachable/logging in).
    if (!rad || (rad.status && rad.status >= 400) || rad.json == null) {
      throw new Error(`HIS radiology lookup failed (${rad ? 'HTTP ' + rad.status : (radR.reason && radR.reason.message) || 'unreachable'})`);
    }
    const rawOrders = rad.json.data || [];
    // Enrich each order with its clinical indication + billing/ER status.
    const ext = await Promise.all(rawOrders.map((o) => enrichOrder(file, o)));
    const orders = rawOrders.map((o, i) => normalizeOrder(o, ext[i]));
    const patient = normalizePatient(((pat && pat.json && pat.json.data) || [])[0]);
    return res.json({ ok: true, file, patient, orders, count: orders.length, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Radiology result linking ─────────────────────────────────────────────────
// Match a patient's Siratech radiology order(s) to the VERIFIED DePACS study that
// holds the report — the strict, no-guess gate. READ-ONLY: it never writes.
// GET /results/match/:file            → match every pending order for the file
// POST /results/match {file, billNo}  → match one specific order (by bill no)
async function buildMatch(file, wantBillNo, site) {
  await getToken();                                    // ensure logged in (empId)
  const empId = currentEmpId();
  if (!empId) throw new Error('no empId (not logged in?)');
  // A patient's orders live at THEIR branch, not a fixed one — the result-entry
  // worklist is per-site, so search the order's actual hospitalId when given.
  const useSite = Number(site) > 0 ? Number(site) : RESULT_SITE;

  // 1) the patient's radiology orders that are awaiting a result (filterResult 0)
  const sr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', {
    body: results.radiologySearchBody({ mrno: file, hospitalId: useSite, empId }),
  });
  // A transient HIS failure (or a mid-login 401) must surface as an error — never as
  // "no orders", which would wrongly tell staff a patient with orders has none.
  if (!sr || (sr.status && sr.status >= 400) || sr.json == null) {
    throw new Error(`HIS result search failed (${sr ? 'HTTP ' + sr.status : 'unreachable'})`);
  }
  const rows = sr.json.data || [];
  const orderRows = wantBillNo ? rows.filter((r) => r.billNo === wantBillNo) : rows;

  // 2) the patient's VERIFIED DePACS studies (once)
  const studies = await results.depacsStudies(file);

  const out = [];
  for (const row of orderRows) {
    // A single order (bill) can bundle several exams — e.g. an "XR SHOULDER +
    // XR HUMERUS" order returns two test rows, each of which must match its OWN
    // DePACS study (the shoulder report must never land on the humerus test).
    // So we match per test row, not per order.
    const dr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologyDetails', {
      body: results.radiologyDetailsBody(row, { hospitalId: useSite, empId }),
    });
    const det = (dr.json && dr.json.data) || [];
    const orderDate = row.billDate || row.visitDate || null;
    const tests = [];
    for (const t of det) {
      const test = {
        serviceName: t.serviceName || null, categoryName: t.categoryName || null,
        invPatTestResultId: t.invPatTestResultId,
        accession: t.accessionNo || null, orderDate,
        invMastServiceId: t.inv_mast_service_id, orderId: t.emR_PAT_DTLS_INV_ORDER_ID || null,
      };
      const m = results.matchStudy({ mrno: row.mrno, serviceName: test.serviceName, categoryName: test.categoryName, orderDate, accession: test.accession }, studies);
      let report = null;
      if (m.decision === 'unique') {
        const rep = await results.depacsReport(m.study.studyId);
        report = { studyId: m.study.studyId, desc: m.study.desc, studyDate: m.study.studyDate,
          reviewer: rep.reviewer, reportDate: rep.reportDate, pdfOk: rep.pdfOk, pdfBytes: rep.pdfBytes,
          preview: rep.reportText.slice(0, 600) };
      }
      tests.push({ test, decision: m.decision, matchKey: m.key, reason: m.reason,
        study: m.study ? { studyId: m.study.studyId, desc: m.study.desc, modality: m.study.modality, studyDate: m.study.studyDate, accession: m.study.accession } : null,
        candidates: m.candidates, report });
    }
    out.push({
      order: { mrno: row.mrno, billNo: row.billNo, orderDate, genPatBillingId: row.genPatBillingId },
      tests,
      // an order is auto-fileable only when EVERY test resolved to exactly one study
      allUnique: tests.length > 0 && tests.every((t) => t.decision === 'unique'),
    });
  }
  return { file, empId, site: useSite, studiesFound: studies.length, orders: out, count: out.length };
}

app.get('/results/match/:file', requireAuth, async (req, res) => {
  try { return res.json({ ok: true, ...(await buildMatch(String(req.params.file || '').trim(), null, req.query.site)) }); }
  catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});
app.post('/results/match', requireAuth, async (req, res) => {
  const { file, billNo } = req.body || {};
  if (!file) return res.status(400).json({ ok: false, error: 'file is required' });
  try { return res.json({ ok: true, ...(await buildMatch(String(file).trim(), billNo || null)) }); }
  catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ── Guarded result FILE + AUTHORIZE (write) — dry-run by default ───────────────
// Files a VERIFIED DePACS report back into Siratech's Radiology Result Entry and
// authorises it. NOTHING is written unless {confirm:true} is sent AND the target
// test resolves to exactly ONE study (file-number + modality + body-part + time).
// Dry-run returns the raw result-entry template + report + the exact payloads that
// WOULD be posted, so a human can verify before anything is committed.
async function buildFilePlan({ file, site, billNo, serviceId }) {
  await getToken();
  const empId = currentEmpId();
  if (!empId) throw new Error('no empId (not logged in?)');
  const useSite = Number(site) > 0 ? Number(site) : RESULT_SITE;

  const sr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', {
    body: results.radiologySearchBody({ mrno: file, hospitalId: useSite, empId }),
  });
  if (!sr || (sr.status && sr.status >= 400) || sr.json == null) throw new Error(`HIS result search failed (${sr ? 'HTTP ' + sr.status : 'unreachable'})`);
  const rows = sr.json.data || [];
  const row = billNo ? rows.find((r) => r.billNo === billNo) : rows[0];
  if (!row) throw new Error(`no pending radiology order found for file ${file} at site ${useSite}${billNo ? ' bill ' + billNo : ''}`);

  const dr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologyDetails', {
    body: results.radiologyDetailsBody(row, { hospitalId: useSite, empId }),
  });
  const details = (dr.json && dr.json.data) || [];
  if (!details.length) throw new Error('RadiologyDetails returned no test rows');

  const studies = await results.depacsStudies(file);
  const orderDate = row.billDate || row.visitDate || null;

  // pick the target test row (by invMastServiceId when given, else the only one)
  let target = null;
  if (serviceId != null) {
    target = details.find((t) => String(t.inv_mast_service_id) === String(serviceId) || String(t.invMastserviceId) === String(serviceId));
  } else if (details.length === 1) {
    target = details[0];
  }
  if (!target) {
    return { needsPick: true, file, site: useSite, billNo: row.billNo,
      tests: details.map((t) => ({ serviceName: t.serviceName, categoryName: t.categoryName, invMastServiceId: t.inv_mast_service_id, invPatTestResultId: t.invPatTestResultId })) };
  }

  const m = results.matchStudy({ mrno: row.mrno, serviceName: target.serviceName, categoryName: target.categoryName, orderDate, accession: target.accessionNo || null }, studies);
  if (m.decision !== 'unique') {
    return { file, site: useSite, billNo: row.billNo, target: { serviceName: target.serviceName }, decision: m.decision, reason: m.reason, candidates: m.candidates, writable: false };
  }
  const report = await results.depacsReport(m.study.studyId);

  return {
    file, site: useSite, empId, billNo: row.billNo, orderDate,
    searchRow: row, details, target, study: m.study, report,
    match: { decision: m.decision, key: m.key, reason: m.reason },
  };
}

app.post('/results/file', requireAuth, async (req, res) => {
  const { file, site, billNo, serviceId, confirm } = req.body || {};
  if (!file) return res.status(400).json({ ok: false, error: 'file is required' });
  try {
    const plan = await buildFilePlan({ file: String(file).trim(), site, billNo: billNo || null, serviceId });
    if (plan.needsPick || plan.writable === false) return res.json({ ok: true, wrote: false, ...plan });

    // Trim the heavy report body for the dry-run response (keep a text preview and
    // the PDF size, not the whole base64 blob).
    const rep = plan.report;
    const planOut = {
      file: plan.file, site: plan.site, billNo: plan.billNo,
      target: { serviceName: plan.target.serviceName, invPatTestResultId: plan.target.invPatTestResultId, invMastServiceId: plan.target.inv_mast_service_id },
      study: { studyId: plan.study.studyId, desc: plan.study.desc, modality: plan.study.modality, studyDate: plan.study.studyDate },
      match: plan.match,
      report: { reviewer: rep.reviewer, reportDate: rep.reportDate, pdfOk: rep.pdfOk, pdfBytes: rep.pdfBytes, textPreview: (rep.reportText || '').slice(0, 400) },
      detailsShape: plan.details.map((d) => Object.keys(d)),   // reveal the template fields to build td
    };

    if (!confirm) {
      return res.json({ ok: true, wrote: false, dryRun: true, plan: planOut,
        note: 'DRY-RUN — nothing was written. Re-send with confirm:true to file + authorize.' });
    }

    // ── confirm:true → attempt the real write (server-side validated) ──────────
    // SAVE first; only AUTHORIZE if the save clearly succeeded. A rejected save is
    // harmless (HIS validates the payload) and we surface its message.
    const details = plan.details.map((d) => ({ ...d }));
    const tgt = details.find((d) => d.invPatTestResultId === plan.target.invPatTestResultId) || details[0];
    details.forEach((d) => { d.isSelected = d === tgt; });
    tgt.result = rep.reportText || '';
    tgt.isTemplateResultEntered = 0;
    const nowIso = new Date().toISOString();
    const td = {
      resultEntryDetailsResponse: details,
      resultEntrySearchResponses: [plan.searchRow],
      auditUser: plan.empId, auditDate: nowIso, hospitalId: plan.site,
      isResultCancellation: false, sampleCollResultEntrySelection: 1,
      searchTypeResultAuthorizationValue: 0, blnBloodType: false,
    };
    const saveRes = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/SaveRadiologyResultEntry', { body: td });
    const sData = saveRes.json && saveRes.json.data;
    const sRow = Array.isArray(sData) ? sData[0] : sData;
    const saveOk = saveRes.status === 200 && sRow && sRow.isSuccess !== false && !(sRow.meassge && /enter template|attach/i.test(sRow.meassge));
    if (!saveOk) {
      return res.json({ ok: true, wrote: false, step: 'save', saveStatus: saveRes.status,
        saveResponse: saveRes.json || String(saveRes.text || '').slice(0, 600), plan: planOut,
        note: 'SAVE did not succeed — nothing was authorized.' });
    }
    const Ka = {
      resultEntryDetailsResponse: (saveRes.json && saveRes.json.data) || details,
      resultEntrySearchResponses: [plan.searchRow],
      auditUser: plan.empId, auditDate: new Date().toISOString(), hospitalId: plan.site,
      isResultCancellation: false, sampleCollResultEntrySelection: 2,
      searchTypeResultAuthorizationValue: (plan.searchRow.baseCategory === 1 ? 0 : 1), blnBloodType: false,
    };
    const authRes = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/SaveRadiologyResultAuthorization', { body: Ka });
    const aRow = authRes.json && authRes.json.data && (Array.isArray(authRes.json.data) ? authRes.json.data[0] : authRes.json.data);
    return res.json({ ok: true, wrote: true, plan: planOut,
      save: { status: saveRes.status, isSuccess: sRow.isSuccess, message: sRow.meassge || sRow.message || null },
      authorize: { status: authRes.status, isSuccess: aRow ? aRow.isSuccess : null, message: aRow ? (aRow.meassge || aRow.message) : null, raw: authRes.json || String(authRes.text || '').slice(0, 400) } });
  } catch (e) {
    return res.status(502).json({ ok: false, wrote: false, error: String(e.message || e) });
  }
});

// Name search (partial) — returns light patient rows for a picker.
app.get('/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'q is required' });
  try {
    const r = await hisFetch('/patient-api/api/v1/Patient/Search', { body: { mrNo: q } });
    const rows = ((r.json && r.json.data) || []).slice(0, 25).map(normalizePatient);
    return res.json({ ok: true, q, count: rows.length, patients: rows });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Radiology management statistics ──────────────────────────────────────────
// Hospital-wide, live radiology-request stats for managers, aggregated from the
// RIS worklist (RadiologySearch). READ-ONLY. The worklist is site-scoped, so we
// query each branch with its own hospitalId (the billNo prefix "CR<NN>" confirms
// the branch) and fold the rows into manager-facing breakdowns:
//   • by branch · by ordering department · by ordering doctor
//   • priority (emergency vs routine) · pending-age buckets · daily trend
// The paid/unpaid *collection* split is layered on later from the billing report;
// this covers the operational picture that RadiologySearch reliably exposes.

const STATS_SITES = (process.env.STATS_SITES || '1,2,3,4,5,6,7,8,9,10,11,12,13,14')
  .split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n));
const STATS_SITE_CONCURRENCY = Number(process.env.STATS_SITE_CONCURRENCY || 12);
// Short result cache so re-opens / auto-refresh / the daily job don't re-run the
// full 14-branch fan-out every time (the data is live but doesn't change second
// to second). Keyed by the query; ~45s TTL.
const STATS_CACHE_TTL = Number(process.env.STATS_CACHE_TTL_MS || 300000);
const statsCache = new Map();
function statsCacheGet(key) {
  const e = statsCache.get(key);
  if (e && Date.now() - e.ts < STATS_CACHE_TTL) return e.data;
  if (e) statsCache.delete(key);
  return null;
}
function statsCacheSet(key, data) {
  statsCache.set(key, { data, ts: Date.now() });
  if (statsCache.size > 60) statsCache.delete(statsCache.keys().next().value);  // simple bound
}
// Modality isn't on the worklist row (departmentName is the *ordering* clinic,
// not the imaging modality), so an exact mix needs a per-order RadiologyDetails
// call. That's opt-in (?modality=1) and bounded — we sample the most recent N
// orders so the manager gets a real, labelled mix without hammering the HIS.
const STATS_MODALITY_CAP = Number(process.env.STATS_MODALITY_CAP || 2000);
const STATS_MODALITY_CONCURRENCY = Number(process.env.STATS_MODALITY_CONCURRENCY || 28);
const MOD_LABEL = { XR: 'X-Ray', US: 'Ultrasound', CT: 'CT', MR: 'MRI', MG: 'Mammography' };
// Friendly modality label for an exam category/service. Reuse results.normMod
// (the matcher's modality normaliser) first, then catch codes it leaves raw
// (e.g. "MAMM" mammography, "BMD"/"DEXA" bone density).
function friendlyModality(txt) {
  const code = results.normMod(txt);
  if (MOD_LABEL[code]) return MOD_LABEL[code];
  const s = String(txt || '').toUpperCase();
  if (/MAMM|\bMG\b/.test(s)) return 'Mammography';
  if (/\bBMD\b|DEXA|BONE\s?MIN|DENSITOM/.test(s)) return 'DEXA / Bone Density';
  if (/ULTRA|SONO|DOPP|ECHO|\bUS\b/.test(s)) return 'Ultrasound';
  if (/\bCT\b|TOMOG/.test(s)) return 'CT';
  if (/\bMRI?\b|MAGNET/.test(s)) return 'MRI';
  if (/X-?RAY|RADIOGRAPH|\bXR\b|\bCR\b|\bDR\b/.test(s)) return 'X-Ray';
  if (/FLUORO|BARIUM|\bIVU\b|\bHSG\b/.test(s)) return 'Fluoroscopy';
  return (code && code.length <= 5) ? code : 'Other';
}

// A bill (GetDueBillDetailsByID) bundles every service on the visit — radiology
// AND labs/consult. Match only the radiology line items so revenue isn't inflated
// by non-radiology charges. (Validated: isolates the imaging items cleanly.)
function isRadiologyItem(name) {
  // Precise: word-bounded tokens only. Earlier `us `/`\bcr\b` matched lab names
  // (venoUS, virUS, lupUS, Creatinine CR) and inflated the totals. Verified
  // against real bill line items: matches only imaging, rejects labs.
  return /\bultra\s?sound\b|\bsonogra|\bdoppler\b|\bus\b\s+[a-z]|\bx[- ]?ray\b|\bxr\b|\bradiograph|\bct\b[\s-]|computed tomog|tomograph|\bmri\b|magnetic resonance|mammogr|\bdexa\b|bone mineral densit|densitometry|fluoroscop|\bbarium\b|angiograph|myelogram/i.test(String(name || ''));
}

// The AUTHORITATIVE radiology catalog (Master service list, baseCategory =
// "Radiology"): the exact set of services that count as imaging, plus each one's
// modality (serviceCategory: XR / CT / MRI / MAMM / BMD / Ultrasound /
// Fluoroscopy). Matching bill line items against this by name is exact — keyword
// guessing wrongly counted drug names like "Diafor XR", "Diamicron-MR", "Dexa
// cream", "Barium paste" as imaging, and missed contrast studies (arthrography,
// IVP, "US -Doppler"). Cached for a few hours.
const CAT_MOD = { XR: 'X-Ray', CT: 'CT', MRI: 'MRI', MAMM: 'Mammography', BMD: 'DEXA / Bone Density', Ultrasound: 'Ultrasound', FLUROSCOPY: 'Fluoroscopy', FLUOROSCOPY: 'Fluoroscopy' };
const normName = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
let radCatalog = { map: null, ts: 0 };
async function getRadCatalog() {
  if (radCatalog.map && Date.now() - radCatalog.ts < 6 * 3600 * 1000) return radCatalog.map;
  await getToken();
  const r = await hisFetch('/master-settings-api/api/v1/ServiceGroup/GetServices', { body: { hospitalId: Number(cache.hospitalid) || 11 } });
  const rows = (r.json && r.json.data) || [];
  const map = new Map();
  for (const x of rows) {
    if (!/radiolog/i.test(x.baseCategory || '')) continue;
    map.set(normName(x.serviceName), CAT_MOD[x.serviceCategory] || x.serviceCategory || 'Other');
  }
  if (map.size) radCatalog = { map, ts: Date.now() };
  return map;
}

// Small concurrency pool — keep the 2 GB VPS from opening 14 sockets at once.
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) { const idx = i; i += 1; try { out[idx] = await fn(items[idx], idx); } catch (_e) { out[idx] = null; } }
  };
  await Promise.all(new Array(Math.max(1, Math.min(size, items.length))).fill(0).map(worker));
  return out;
}

// The real branch list (id + name), from the site the logged-in user can see.
// Branches change rarely, so cache for a few hours. Used both to label branches
// and as the default "all branches" set (future-proof if a branch is added).
let sitesCache = { list: null, ts: 0 };
async function getSites() {
  if (sitesCache.list && Date.now() - sitesCache.ts < 6 * 3600 * 1000) return sitesCache.list;
  await getToken();
  const uid = String(HIS_USER).padStart(8, '0');
  const r = await hisFetch('/security-api/api/v1/Authentication/Sites/ByUser?userId=' + encodeURIComponent(uid), { method: 'GET' });
  const rows = (r.json && r.json.data) || [];
  const list = rows
    .map((s) => ({ siteId: Number(s.siteId), name: s.siteName || `Branch ${s.siteId}`, shortName: (s.siteShortName || '').trim() || s.siteName || `Branch ${s.siteId}` }))
    .filter((s) => Number.isFinite(s.siteId))
    .sort((a, b) => a.siteId - b.siteId);
  if (list.length) sitesCache = { list, ts: Date.now() };
  return list;
}

const dayOf = (s) => { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
function tallyPush(map, key, name) { const k = key == null || key === '' ? 'Unknown' : String(key); const e = map.get(k) || { key: k, name: name || k, count: 0 }; e.count += 1; map.set(k, e); }
function tallyList(map, top) { const a = [...map.values()].sort((x, y) => y.count - x.count); return top ? a.slice(0, top) : a; }

async function radiologyStats({ from, to, sites, withModality = false, withFinance = false, topDoctors = 15, noCache = false }) {
  const cacheKey = JSON.stringify({ from, to, sites: (sites || []).slice().sort((a, b) => a - b), withModality, withFinance });
  if (!noCache) { const cached = statsCacheGet(cacheKey); if (cached) return cached; }
  await getToken();
  const empId = currentEmpId() || '0';
  const today = new Date();
  const def = (d, end) => `${d.toISOString().slice(0, 10)}T${end ? '23:59:59' : '00:00:00'}.000Z`;
  const fromISO = from ? `${from}T00:00:00.000Z` : def(new Date(today.getTime() - 30 * 864e5), false);
  const toISO = to ? `${to}T23:59:59.000Z` : def(today, true);
  const siteList = await getSites().catch(() => []);
  const nameOf = new Map(siteList.map((s) => [s.siteId, s.shortName]));
  const wantSites = (sites && sites.length) ? sites : (siteList.length ? siteList.map((s) => s.siteId) : STATS_SITES);
  const branchLabel = (site) => nameOf.get(site) || `Branch ${site}`;

  const perSite = await pool(wantSites, STATS_SITE_CONCURRENCY, async (site) => {
    const sr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', {
      body: results.radiologySearchBody({ mrno: '', hospitalId: site, empId, filterResult: '0', fromDate: fromISO, toDate: toISO }),
    });
    if (!sr || (sr.status && sr.status >= 400) || sr.json == null) return { site, ok: false, rows: [] };
    return { site, ok: true, rows: (sr.json.data || []) };
  });

  const returned = [], failed = [], flat = [];
  const byBranch = new Map(), byDept = new Map(), byDoctor = new Map();
  const patientSet = new Set();
  const daily = new Map();
  const aging = { '<1d': 0, '1-3d': 0, '3-7d': 0, '>7d': 0 };
  let total = 0, emergency = 0, routine = 0;
  const now = Date.now();

  // Seed every queried branch at zero so the panel shows ALL branches (a branch
  // with no radiology that period still appears, instead of silently missing).
  for (const site of wantSites) byBranch.set(String(site), { key: String(site), name: branchLabel(site), count: 0 });

  for (const s of perSite) {
    if (!s) continue;
    if (!s.ok) { failed.push(s.site); continue; }
    returned.push({ site: s.site, count: s.rows.length });
    for (const r of s.rows) {
      total += 1;
      if (r.mrno) patientSet.add(String(r.mrno));
      flat.push({ r, site: s.site });
      tallyPush(byBranch, s.site, branchLabel(s.site));
      tallyPush(byDept, r.departmentName, r.departmentName);
      tallyPush(byDoctor, r.providerId || r.doctorName, (r.doctorName || '').trim() || (r.providerId || 'Unknown'));
      if (Number(r.isEmergency) === 1 || Number(r.priorityStat) > 0) emergency += 1; else routine += 1;
      const d = dayOf(r.billDate || r.visitDate);
      if (d) daily.set(d, (daily.get(d) || 0) + 1);
      const t = Date.parse(r.billDate || r.visitDate || '');
      if (Number.isFinite(t)) {
        const days = (now - t) / 864e5;
        if (days < 1) aging['<1d'] += 1; else if (days < 3) aging['1-3d'] += 1; else if (days < 7) aging['3-7d'] += 1; else aging['>7d'] += 1;
      }
    }
  }

  // Unified enrichment — ONE bill read per order (GetDueBillDetailsByID) gives us
  // BOTH the modality mix (from the line-item names) AND revenue + payer split.
  // This halves the per-order calls vs. reading RadiologyDetails separately, so
  // modality and revenue come back together and faster. Bounded to the most
  // recent N orders. Only radiology line items are counted (labs on the same
  // bill are skipped).
  let modality = null, financial = null;
  if ((withModality || withFinance) && flat.length) {
    const sample = flat
      .slice()
      .sort((a, b) => Date.parse(b.r.billDate || b.r.visitDate || 0) - Date.parse(a.r.billDate || a.r.visitDate || 0))
      .slice(0, STATS_MODALITY_CAP);
    // ONE bill read per order (GetDueBillDetailsByID). Each line item is checked
    // against the radiology catalog — a match is a real imaging exam, and the
    // catalog also tells us its modality. This gives exam count, modality mix,
    // revenue and payer split accurately from a single call.
    const catalog = await getRadCatalog().catch(() => new Map());
    const bills = await pool(sample, STATS_MODALITY_CONCURRENCY, async ({ r, site }) => {
      const d = await hisFetch('/billing-api/api/v1/DueSettlement/GetDueBillDetailsByID?GenPatBillingId=' + encodeURIComponent(r.genPatBillingId), { method: 'GET' });
      return { site, items: (d && d.json && (d.json.data || d.json.Data)) || [] };
    });
    const byModCount = new Map(), revByBranch = new Map(), revByMod = new Map();
    let exams = 0, revenue = 0, patient = 0, sponsor = 0, items = 0;
    let reqInsurance = 0, reqCash = 0, reqCopay = 0, reqWithRad = 0;
    // EXAM-level payer split (X-ray + US on one order = two exams counted apart).
    let exInsurance = 0, exCash = 0, exCopay = 0, exFree = 0;
    for (const b of bills) {
      if (!b || !Array.isArray(b.items)) continue;
      let bPat = 0, bSpo = 0, hasRad = false;
      for (const it of b.items) {
        const mod = catalog.get(normName(it.itemName));   // in the radiology catalog?
        if (!mod) continue;                                // not imaging (lab / drug / consult)
        hasRad = true;
        exams += 1;
        const net = Number(it.netAmount) || 0, pat = Number(it.patient) || 0, spo = Number(it.sponsor) || 0;
        revenue += net; patient += pat; sponsor += spo; items += 1; bPat += pat; bSpo += spo;
        // this exam: who pays?
        if (pat > 0 && spo > 0) exCopay += 1; else if (pat > 0) exCash += 1; else if (spo > 0) exInsurance += 1; else exFree += 1;
        const mc = byModCount.get(mod) || { modality: mod, count: 0 }; mc.count += 1; byModCount.set(mod, mc);
        const be = revByBranch.get(b.site) || { site: b.site, name: branchLabel(b.site), revenue: 0 }; be.revenue += net; revByBranch.set(b.site, be);
        const me = revByMod.get(mod) || { modality: mod, revenue: 0 }; me.revenue += net; revByMod.set(mod, me);
      }
      if (hasRad) { reqWithRad += 1; if (bPat > 0 && bSpo > 0) reqCopay += 1; else if (bPat > 0) reqCash += 1; else reqInsurance += 1; }
    }
    const r2 = (n) => Math.round(n * 100) / 100;
    const meta = { sampled: sample.length, ofTotal: flat.length, truncated: flat.length > sample.length };
    if (withModality) modality = { ...meta, exams, mix: [...byModCount.values()].sort((a, b) => b.count - a.count) };
    if (withFinance) financial = {
      ...meta, items, requests: reqWithRad, exams,
      byPayer: [
        { type: 'Insurance', count: reqInsurance },
        { type: 'Cash / self-pay', count: reqCash },
        { type: 'Insurance + copay', count: reqCopay },
      ],
      // exam-level split (each X-ray / US counted separately)
      examsByPayer: [
        { type: 'Insurance', count: exInsurance },
        { type: 'Cash / self-pay', count: exCash },
        { type: 'Insurance + copay', count: exCopay },
      ].concat(exFree ? [{ type: 'Zero-charge', count: exFree }] : []),
      revenue: r2(revenue), patient: r2(patient), sponsor: r2(sponsor),
      byBranch: [...revByBranch.values()].map((e) => ({ site: e.site, name: e.name, revenue: r2(e.revenue) })).sort((a, b) => b.revenue - a.revenue),
      byModality: [...revByMod.values()].map((e) => ({ modality: e.modality, revenue: r2(e.revenue) })).sort((a, b) => b.revenue - a.revenue),
    };
  }

  const result = {
    range: { from: fromISO.slice(0, 10), to: toISO.slice(0, 10) },
    sites: { requested: wantSites, returned, failed },
    branches: siteList,
    total,
    patients: patientSet.size,
    byBranch: tallyList(byBranch).map((e) => ({ site: Number(e.key), name: e.name, count: e.count })),
    byDepartment: tallyList(byDept).map((e) => ({ name: e.name, count: e.count })),
    byDoctor: tallyList(byDoctor, topDoctors).map((e) => ({ providerId: e.key, name: e.name, count: e.count })),
    modality,
    financial,
    priority: { emergency, routine },
    aging,
    daily: [...daily.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, count]) => ({ date, count })),
    generatedAt: new Date().toISOString(),
    note: 'Requests = billed radiology orders in the RIS worklist (awaiting result). Paid/unpaid collection split is added from the billing report.',
  };
  statsCacheSet(cacheKey, result);
  return result;
}

app.get('/stats/branches', requireAuth, async (_req, res) => {
  try { return res.json({ ok: true, branches: await getSites() }); }
  catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

app.get('/stats/radiology', requireAuth, async (req, res) => {
  try {
    const from = String(req.query.from || '').trim() || null;   // YYYY-MM-DD
    const to = String(req.query.to || '').trim() || null;
    // Empty/blank means "all branches" — must not become [0] (''.split→['']→Number 0).
    const sites = String(req.query.sites || '').split(',').map((s) => s.trim()).filter(Boolean)
      .map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const full = String(req.query.full || '') === '1';
    const withModality = full || String(req.query.modality || '') === '1';
    const withFinance = full || String(req.query.financial || '') === '1';
    const noCache = String(req.query.nocache || '') === '1';   // Refresh button → truly live
    const data = await radiologyStats({ from, to, sites, withModality, withFinance, noCache });
    return res.json({ ok: true, ...data });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message));

// Keep the DEFAULT dashboard view (all branches, last 30 days, full enrichment)
// pre-computed in the cache, so a manager opening the page gets it instantly
// instead of waiting for ~1500 per-order bill reads. Runs a bit under the cache
// TTL so the cache never goes cold. The key matches what the dashboard sends
// (30-day preset, no sites filter, full=1).
async function warmDefaultStats() {
  try {
    const today = new Date();
    const to = today.toISOString().slice(0, 10);
    const from = new Date(today.getTime() - 29 * 864e5).toISOString().slice(0, 10);
    const t0 = Date.now();
    const d = await radiologyStats({ from, to, sites: [], withModality: true, withFinance: true });
    console.log(`[warm] default stats: ${d.total} requests in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (e) { console.error('[warm] default stats failed:', e && e.message); }
}

app.listen(PORT, HOST, () => {
  console.log(`Siratech connector listening on ${HOST}:${PORT}`);
  // Warm branch list + radiology catalog, then keep the default view warm.
  setTimeout(() => {
    getSites().then((s) => console.log(`[warm] sites: ${s.length}`)).catch(() => {});
    getRadCatalog().then((m) => console.log(`[warm] radiology catalog: ${m.size}`)).then(warmDefaultStats).catch(() => {});
  }, 4000);
  setInterval(warmDefaultStats, 240000);   // refresh default cache every 4 min (< 5-min TTL)
});
