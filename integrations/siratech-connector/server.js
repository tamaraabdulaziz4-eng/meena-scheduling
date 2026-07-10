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
const zlib = require('zlib');
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
// Branches the connector's Siratech account can READ but that are missing from its
// own Sites/ByUser list (e.g. N3 - Al Rawdah / siteId 3 was un-assigned from the
// account by mistake). The data endpoints (RadiologySearch by hospitalId) still
// return these sites' orders, so we force-include them in the site enumeration so
// their patients appear on the board and get auto-stamped — no Siratech access
// change needed. Default '3' (N3). Set FORCE_SITES='' to disable.
const FORCE_SITES = (process.env.FORCE_SITES || '3')
  .split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n) && n > 0);
// Display names for force-included sites (Sites/ByUser can't supply them since the
// site isn't assigned). Override/extend via FORCE_SITE_NAMES="3=N3 - Al Rawdah,...".
const FORCE_SITE_NAMES = (() => {
  const m = { 3: 'N3 - Al Rawdah' };
  for (const pair of String(process.env.FORCE_SITE_NAMES || '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) { const id = Number(pair.slice(0, i).trim()); const nm = pair.slice(i + 1).trim();
      if (Number.isFinite(id) && nm) m[id] = nm; }
  }
  return m;
})();
// A verified radiology report is filed as a PDF ATTACHMENT on the result row (the
// exams here are template-less, so there is no free-text/template result to type —
// the proven path is: attach the DePACS PDF under the EMR "Report" file-attachment
// category, mark the row's range, save, authorize). 151472 = the "Report" category
// id captured live at Alworood (site 2); override per-site with env if it differs.
const FILE_ATTACHMENT_CATEGORY_ID = Number(process.env.FILE_ATTACHMENT_CATEGORY_ID || 151472);
// HIS spells the service/exam name field several ways across builds — probe them all
// (mirrors buildWorklist's risServiceOf) so per-service matching never silently misses.
const _SVC_KEYS = ['serviceName', 'service', 'invMastServiceName', 'serviceDescription',
  'invMastServiceDesc', 'serviceDesc', 'testName', 'procedureName',
  'invServiceName', 'invmastServiceName', 'ServiceName'];
// The result "range" classification the row is saved under. The Siratech dropdown
// is Normal / Abnormal / Critical / Not Applicable → 0 / 1 / 2 / 3. For RADIOLOGY
// the normal-vs-abnormal "range" is a lab concept that does not apply — the
// radiologist's report itself carries the interpretation — so we file every
// radiology result as "Not Applicable" (3) unless the caller pins a range
// explicitly. (Default overridable via RESULT_STRING_RANGE for other setups.)
const RANGE_NAME_TO_CODE = { normal: 0, abnormal: 1, critical: 2, 'not applicable': 3, notapplicable: 3, na: 3 };
const RANGE_NOT_APPLICABLE = 3;
const DEFAULT_STRING_RANGE = Number(process.env.RESULT_STRING_RANGE || RANGE_NOT_APPLICABLE);

// Hard safety: this service reads patient PHI and FILES/AUTHORISES results into
// the hospital EMR. Never run it unauthenticated on a public interface. Either
// set CONNECTOR_TOKEN, or bind to loopback (HOST=127.0.0.1) behind a proxy.
const _isLoopback = (h) => !h || h === '127.0.0.1' || h === 'localhost' || h === '::1';
// A weak/placeholder token is as good as none — reject the known placeholders and
// anything too short so a deploy left at the example value can't expose PHI + EMR
// writes behind a guessable bearer.
const _WEAK_TOKENS = new Set(['change-me', '__set_a_strong_random_token__', 'changeme', 'secret', 'token', 'test']);
if (!_isLoopback(HOST) && (!API_TOKEN || _WEAK_TOKENS.has(API_TOKEN) || API_TOKEN.length < 16)) {
  console.error('✗ Refusing to start: bound to ' + HOST + ' with a missing/weak CONNECTOR_TOKEN. ' +
                'This connector exposes patient PHI and EMR writes — it must not be open. ' +
                'Set a strong random CONNECTOR_TOKEN (openssl rand -base64 36), or HOST=127.0.0.1 behind a proxy.');
  process.exit(1);
}
if (!API_TOKEN) {
  console.warn('⚠  CONNECTOR_TOKEN is not set — endpoints are UNAUTHENTICATED (localhost only).');
}
if (!HIS_USER || !HIS_PASS) {
  console.error('✗ HIS_USER / HIS_PASS are required. Refusing to start.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '8mb' }));   // room for a base64 consent PDF on /results/file

// ── token cache + single-flight login ────────────────────────────────────────
let cache = { auth: '', hospitalid: '', ts: 0 };
let loginInFlight = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bump on every deploy-relevant change so the running version can be read straight from the
// clinical response — no VPS shell needed to confirm which code is actually live.
const CONNECTOR_BUILD = 'frontend-find-2026-07-10v';

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
// Hard timeout on every HIS call. Without it a stalled socket hangs the request
// forever — and a hang while holding the single-flight login wedges the whole
// connector. AbortSignal.timeout rejects the fetch, which the callers surface.
const HIS_TIMEOUT_MS = Number(process.env.HIS_TIMEOUT_MS || 30000);
async function hisFetch(path, { method = 'POST', body, headers: extra } = {}) {
  const doCall = async (tok) => {
    const res = await fetch(HIS_BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Authorization: tok.auth,
        hospitalid: tok.hospitalid,
        ...(extra || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(HIS_TIMEOUT_MS),
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

// One-time diagnostics: log the real HIS field names once per process so the
// order-id + indication spellings can be confirmed from a live response.
let _enrichKeysLogged = false, _enrichDetailKeysLogged = false, _lookupOrderKeysLogged = false, _clinKeysLogged = false;

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
    // Only enrich from the RIS row that matches THIS order's bill. The old
    // `|| rows[0]` fallback borrowed another same-day order's billingStatus / ER
    // flag / payer / indication when the billNo didn't match — a wrong-data risk.
    // billNo is numeric in one HIS subsystem and a string in another — compare as
    // String() so a type mismatch never silently drops the whole enrichment (the
    // same bug the match path already fixed; the indication was empty for everyone).
    // Match the RIS row for THIS order. A single bill often covers SEVERAL exams, so
    // billNo alone matches the first row and every exam would inherit its indication +
    // doctor + ER flag (the owner's "طالع كله SOB" — same indication on every exam).
    // Disambiguate a multi-service bill by service name; never fall back to another
    // exam's row (no wrong indication — empty is correct-or-nothing).
    const billRows = rows.filter((r) => String(r.billNo) === String(o.billNo));
    let row;
    if (billRows.length <= 1) {
      row = billRows[0];
    } else {
      // Multi-service bill: match THIS order's service. HIS spells the service field
      // several ways across builds, so probe every known spelling on BOTH sides (same
      // list buildWorklist uses); no match → null → {} (never another exam's indication).
      const svc = String(firstOf(o, _SVC_KEYS) || '').trim().toLowerCase();
      row = svc ? (billRows.find((r) => String(firstOf(r, _SVC_KEYS) || '').trim().toLowerCase() === svc) || null) : null;
    }
    if (!row) return {};
    // One-time: dump the RIS-panel row's key names so the real HIS field spellings
    // (order-id, indication) can be pinned from a live response without guessing.
    if (!_enrichKeysLogged) { _enrichKeysLogged = true; console.log('[enrichOrder] RIS row keys:', Object.keys(row).join(',')); }
    let indication = null, reason = null, remarks = null;
    // The ordering doctor's ID (number) — Siratech spells it differently across builds,
    // so probe the RIS row first, then the order-detail row. Used by the auto-stamp so
    // the DePACS clinical history carries "Dr <name> (#<id>)".
    let providerId = row.providerId || row.orderProviderId || row.providerCode || row.doctorId || null;
    // The order-detail id field is spelled differently across Siratech builds — probe
    // every known spelling. If it's wrong, GetEmrOrderDetails never runs and the
    // indication is null for EVERY order (the owner's "I don't see the indication").
    const orderDetailId = row.emrPatDtlsInvOrderId || row.invPatOrderId || row.emrPatInvOrderId
      || row.emrPatDtlsInvId || row.invPatDtlsOrderId || row.patInvOrderId || row.orderId || row.emrOrderId || null;
    if (orderDetailId) {
      const det = await hisFetch('/billing-api/api/v1/ServicePanel/GetEmrOrderDetails?EmrPatDtlsInvOrderId=' + encodeURIComponent(orderDetailId), { method: 'GET' });
      const dd = (det.json && det.json.data) || {};
      if (!_enrichDetailKeysLogged) { _enrichDetailKeysLogged = true; console.log('[enrichOrder] GetEmrOrderDetails keys:', Object.keys(dd).join(',')); }
      // Indication/reason/remarks — probe several spellings each.
      indication = dd.clinicalIndication || dd.clinicalindication || dd.indication || dd.clinicalNotes || dd.clinicalHistory || null;
      reason = dd.reasonForOrder || dd.reason || dd.orderReason || dd.reasonForExam || null;
      remarks = dd.remarks || dd.remark || dd.notes || dd.comments || null;
      providerId = providerId || dd.providerId || dd.orderProviderId || dd.referringDoctorId || dd.doctorId || null;
    }
    return {
      clinicalIndication: indication, reasonForOrder: reason, remarks,
      billingStatus: row.billingStatus || null,
      encounter: row.encounter || null,                       // "ER" | "OP" | "IP"
      isER: (row.encounter || '').toUpperCase() === 'ER',
      provider: (row.providerName || '').trim() || null,
      providerId: providerId != null && String(providerId).trim() !== '' ? String(providerId).trim() : null,
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
    cpacsUrl: o.cpacsUrl || null,               // direct PACS-viewer link (when cPACS is on)
    reportPath: o.reportPath || null,
    hasReport: !!o.hasRadiologyRepot,
    reportDate: o.reportDate || null,
    reportStatus: o.radioReportStatus || o.cpoeStatusDescription || null,
    imageStatus: o.radioImageStatus || (imaged ? 'In PACS' : null),
    // ── enriched from RIS panel + GetEmrOrderDetails ──
    clinicalIndication: ext.clinicalIndication || null,
    reasonForOrder: ext.reasonForOrder || null,
    remarks: ext.remarks || null,
    billingStatus: ext.billingStatus || null,   // e.g. "Billed"
    encounter: ext.encounter || null,           // "ER" | "OP" | "IP"
    isER: !!ext.isER,
    provider: ext.provider || null,
    providerId: ext.providerId || null,
    payer: ext.payer || null,
    orderId: ext.orderId || null,
    // The native per-exam result key — lets the patient card load THIS exam's report
    // straight from Siratech (FetchRadiologyReport) instead of the slow DePACS match.
    invPatTestResultId: o.invPatTestResultId != null ? o.invPatTestResultId : null,
  };
}

// First non-empty value across a list of candidate field names (HIS field naming
// is inconsistent, so we probe several spellings for each attribute).
function firstOf(o, keys) {
  for (const k of keys) {
    const v = o[k];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}
function normalizePatient(p) {
  if (!p) return null;
  const height = firstOf(p, ['height', 'patientHeight', 'heightCm', 'height_cm', 'vitalHeight']);
  const weight = firstOf(p, ['weight', 'patientWeight', 'weightKg', 'weight_kg', 'vitalWeight']);
  let bmi = firstOf(p, ['bmi', 'BMI', 'bodyMassIndex']);
  const hN = Number(height), wN = Number(weight);
  if (bmi == null && Number.isFinite(hN) && hN > 0 && Number.isFinite(wN) && wN > 0) {
    const m = hN > 3 ? hN / 100 : hN;                 // height given in cm vs m
    bmi = Math.round((wN / (m * m)) * 10) / 10;
  }
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
    // ELM / Nafath (Absher/Yakeen) national-identity verification status.
    elmVerified: !!(p.iselmVerified || p.iselmverified || p.isElmVerified),
    // ── clinically-relevant extras (best-effort; present only if the HIS row has them) ──
    height: height != null ? String(height) : null,
    weight: weight != null ? String(weight) : null,
    bmi: bmi != null ? String(bmi) : null,
    bloodGroup: firstOf(p, ['bloodGroup', 'bloodGroupName', 'blood_group', 'bloodgroup']),
    allergy: firstOf(p, ['allergy', 'allergies', 'allergyName', 'knownAllergies', 'drugAllergy']),
    maritalStatus: firstOf(p, ['maritalStatus', 'maritalStatusName']),
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

// The EMR patient-search payload needs the logged-in provider id — that's the JWT
// `sub`/UserName claim (e.g. "00101454"), NOT nameid (which is the internal user id).
function currentProviderId() {
  try {
    const jwt = String(cache.auth || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    return payload.sub || payload.UserName || payload.nameid || '';
  } catch (_e) { return ''; }
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

// ── Autonomy helper — guarded READ-ONLY generic Siratech call ──────────────────
// Lets Meena (superadmin, through the bridge) make read-only HIS calls to build &
// verify integrations without shipping a new connector route per endpoint. Hard
// guards: WRITES are refused (Save/Update/Delete/Authorize/Cancel/Create/…), and
// the BILLED government calls (ELMData / NPHIESPatientRegistry / Eligibility-Check /
// Discovery-Check) are refused here too — those only ever run through the dedicated
// consent-gated path. Everything reachable here is an internal HIS read.
// Write verbs are matched at a WORD BOUNDARY so a verb that is merely the tail of a
// read noun doesn't falsely refuse a read: "\bSign" catches "/Sign"/"SignOff" but NOT
// "VitalSign", and "\bFile" catches "/File" but NOT "Profile". Path-segment verbs
// (after "/") and camelCase-initial verbs still match.
const _CONN_WRITE = /(\bSave|Authoriz|\bDelete|\bUpdate|\bCancel|\bCreate|\bRegister|\bInsert|\bRemove|\bSend|\bSubmit|\bPay|\bRefund|\bApprove|\bSign|\bFile|\bEdit)/i;
const _CONN_BILLED = /(ELMData|NPHIESPatientRegistry|Eligibility\/Check|EligibilityCheck|Discovery\/Check)/i;
const _CONN_READ = /(Fetch|Search|\/Get|Details|\/List|\/View|Report|Image|Pdf|Log|Panel|Preview|Print|Scheme|Demographics|IdentifyingDocs|Slots|Notification\/GetNotification|Diagnosis|Allerg|VitalSign|Template|Result|Encounter|Problem)/i;
app.post('/admin/his', requireAuth, async (req, res) => {
  const { path, body, method } = req.body || {};
  if (!path || typeof path !== 'string' || !path.startsWith('/')) return res.status(400).json({ ok: false, error: 'path (starting with /) is required' });
  if (_CONN_WRITE.test(path) || _CONN_BILLED.test(path) || !_CONN_READ.test(path)) {
    return res.status(403).json({ ok: false, error: 'refused: only internal read-only HIS paths are allowed here' });
  }
  try {
    // GET endpoints (many result/print views) reject a request body — send none on GET.
    const M = String(method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
    const r = await hisFetch(path, { method: M, body: M === 'GET' ? undefined : (body || {}) });
    return res.json({ ok: true, status: r.status, data: r.json, text: r.json == null ? String(r.text || '').slice(0, 4000) : undefined });
  } catch (e) { return res.status(502).json({ ok: false, error: String((e && e.message) || e) }); }
});

// ── Native Siratech report + image + status for ONE exam ───────────────────────
// Everything from Siratech (no DePACS): status = cpoeStatusDescription; report text
// = FetchRadiologyReport(invPatTestResultId); image = FetchRadiologyImage → a cloud
// (ZFP) viewer URL. Keyed by mrno + accession (or invPatTestResultId). Read-only.
app.get('/radiology/study', requireAuth, async (req, res) => {
  const mrno = String(req.query.mrno || '').trim();
  const accession = String(req.query.accession || '').trim();
  const invId = String(req.query.invPatTestResultId || '').trim();
  if (!mrno) return res.status(400).json({ ok: false, error: 'mrno is required' });
  try {
    const dr = await hisFetch('/emr-api/api/v1/EMR/FetchRadiologyDetails', { body: { mrno } });
    const rows = (dr.json && dr.json.data) || [];
    let row = null;
    if (invId) row = rows.find((x) => String(x.invPatTestResultId) === invId);
    if (!row && accession) row = rows.find((x) => String(x.accessionNumber || '') === accession);
    if (!row) return res.json({ ok: true, found: false });
    const out = {
      ok: true, found: true,
      status: row.cpoeStatusDescription || null,
      hasReport: !!row.hasRadiologyRepot,
      reportDate: row.reportDate || null,
      serviceName: row.serviceName || null,
      accession: row.accessionNumber || null,
      invPatTestResultId: row.invPatTestResultId || null,
      modality: row.modality || null,
    };
    // report text (native — FetchRadiologyReport)
    if (row.hasRadiologyRepot && row.invPatTestResultId) {
      try {
        const rep = await hisFetch('/emr-api/api/v1/EMR/FetchRadiologyReport', { body: { invPatTestResultId: row.invPatTestResultId } });
        const rd = rep.json && rep.json.data;
        out.verifiedBy = (rd && rd.verifiedBy) || null;
        out.reportText = (rd && Array.isArray(rd.radiologyDtlsDTO)
          && rd.radiologyDtlsDTO.map((x) => x && x.message).filter(Boolean).join('\n\n')) || null;
      } catch (_e) { /* report best-effort */ }
    }
    // image viewer url (native — FetchRadiologyImage → cloud ZFP viewer)
    if (row.accessionNumber) {
      try {
        const im = await hisFetch('/emr-api/api/v1/EMR/FetchRadiologyImage', { body: { mrno, accessionNo: row.accessionNumber, hospitalId: row.siteId, pacsId: row.pacsId || undefined } });
        out.imageUrl = (im.json && im.json.data && im.json.data.urlPath) || null;
      } catch (_e) { /* image best-effort */ }
    }
    return res.json(out);
  } catch (e) { return res.status(502).json({ ok: false, error: String((e && e.message) || e) }); }
});

// ── Endpoint discovery (READ-ONLY) — "does Siratech expose a Nphies/eligibility
// API?" ───────────────────────────────────────────────────────────────────────
// Siratech is an Angular SPA: every API path it can call is baked into its JS
// bundles. This route headless-loads the app (own throwaway browser, does NOT
// touch the token cache), records the JS bundles + live API calls, downloads each
// bundle and greps out every `<mod>-api/api/vN/…` path, then highlights any that
// look insurance / eligibility / Nphies related. It only READS static JS + observes
// traffic — it never CALLS an eligibility/claim endpoint (that can fire a real,
// billable Nphies transaction). Lets us drive discovery from Meena (via the bridge)
// instead of shelling into the VPS. Single-flight so a double-click can't launch
// two browsers on the small VPS.
const INS_RE = /nphies|eligib|insur|coverage|\bpolicy\b|policyno|member(ship)?|beneficiar|sponsor|payer|\btpa\b|scheme|approval|preauth|pre-auth|deductib|copay|co-pay|benefit|claim|cchi/i;
let _discoverInFlight = null;
async function discoverEndpoints(opts = {}) {
  const collectRaw = !!opts.collectRaw;
  const rawParts = [];
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--no-zygote', '--disable-extensions',
           '--disable-background-networking', '--disable-software-rasterizer',
           '--js-flags=--max-old-space-size=256'],
  });
  const liveApi = new Set(), jsUrls = new Set();
  const clean = (u) => u.replace(HIS_BASE, '').split('?')[0].replace(/\/+$/, '');
  try {
    const page = await browser.newPage();
    page.on('request', (r) => {
      const u = r.url();
      if (/-api\/api\/v\d+\//i.test(u)) liveApi.add(clean(u));
      if (/\.js(\?|$)/i.test(u) && u.startsWith(HIS_BASE)) jsUrls.add(u.split('?')[0]);
    });
    await page.goto(HIS_BASE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    // Log in so lazy feature chunks (where a billing/insurance module would live)
    // actually load — same flow as doHeadlessLogin, but on a throwaway browser.
    try {
      await page.waitForSelector('#mat-input-0', { timeout: 25000 });
      await page.click('#mat-input-0'); await page.type('#mat-input-0', HIS_USER, { delay: 40 });
      await page.keyboard.press('Tab'); await sleep(3500);
      const site = (await page.$('#focusablesite')) || (await page.$('mat-select'));
      if (site) { await site.click(); await sleep(1500); const opts = await page.$$('mat-option'); let picked = false;
        if (HIS_SITE) for (const o of opts) { const t = (await o.evaluate((e) => e.innerText)).trim();
          if (t.toLowerCase().includes(HIS_SITE.toLowerCase())) { await o.click(); picked = true; break; } }
        if (!picked && opts[0]) await opts[0].click(); await sleep(1000); }
      await page.click('#passFocus'); await page.type('#passFocus', HIS_PASS, { delay: 40 }); await sleep(400);
      const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((e) => /login/i.test(e.innerText)));
      if (btn) await btn.click().catch(() => {});
      await sleep(12000);   // dashboard + lazy chunks
    } catch (_e) { /* still harvest whatever JS loaded */ }
    try {
      const more = await page.evaluate(() => {
        const s = new Set();
        document.querySelectorAll('script[src]').forEach((e) => s.add(e.src));
        (performance.getEntriesByType('resource') || []).forEach((r) => { if (/\.js(\?|$)/.test(r.name)) s.add(r.name); });
        return [...s];
      });
      for (const u of more) if (u.startsWith(HIS_BASE) && /\.js/i.test(u)) jsUrls.add(u.split('?')[0]);
    } catch (_e) { /* ignore */ }
  } finally { await browser.close().catch(() => {}); }

  // BFS the bundles AND their lazy chunks: Angular feature modules (radiology/EMR/
  // investigation, and any insurance/eligibility module) load as separate .js chunks
  // only when their screen opens, so a dashboard-only load misses them. From each
  // file harvest API paths AND referenced *.js chunk names, fetch those too, repeat.
  const API_RE = /([A-Za-z][\w-]*-api\/api\/v\d+\/[A-Za-z0-9_./-]+)/g;
  const CHUNK_RE = /["'`]([A-Za-z0-9_\-./]+\.js)["'`]/g;
  // Angular/webpack build lazy-chunk filenames at RUNTIME as `id + "." + hash + ".js"`,
  // so they never appear as a literal "*.js" string — that's why a plain scan misses the
  // radiology/EMR/billing feature chunks. The chunk HASH MAP is a dense object literal
  // `{179:"a1b2c3d4e5f6...",234:"..."}`; extract every id→hash pair and synthesise the
  // chunk URLs so we actually pull EVERY chunk, not just the eager bundles.
  const CHUNKMAP_RE = /(\d{1,5}):"([0-9a-f]{16,32})"/g;
  const toUrl = (f) => { if (/^https?:\/\//.test(f)) return f.startsWith(HIS_BASE) ? f : null;
    return HIS_BASE + '/' + f.replace(/^\.?\//, ''); };
  const fromCode = new Set(); const seen = new Set(); const CAP = 2500;
  let frontier = [...new Set(jsUrls)];
  // Fetch each wave of chunks in PARALLEL (serial over 2500 chunks would take many
  // minutes); each fetched file reveals the next wave (more chunk refs / hash-map ids).
  while (frontier.length && seen.size < CAP) {
    const batch = frontier.filter((u) => u && !seen.has(u)).slice(0, CAP - seen.size);
    if (!batch.length) break;
    batch.forEach((u) => seen.add(u));
    const next = new Set();
    await pool(batch, 16, async (u) => {
      try {
        const res = await fetch(u, { headers: { Accept: '*/*' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) return;
        const txt = await res.text(); let m;
        if (collectRaw) rawParts.push(`\n/* ===================== ${u} ===================== */\n${txt}`);
        while ((m = API_RE.exec(txt)) !== null) { const p = m[1].replace(/['"`,);]+$/, ''); if (p.length >= 8 && p.length <= 160) fromCode.add(p); }
        let c; while ((c = CHUNK_RE.exec(txt)) !== null) { const url = toUrl(c[1]); if (url && /\.js$/i.test(url) && !seen.has(url)) next.add(url); }
        let k; while ((k = CHUNKMAP_RE.exec(txt)) !== null) { const url = `${HIS_BASE}/${k[1]}.${k[2]}.js`; if (!seen.has(url)) next.add(url); }
      } catch (_e) { /* skip a bundle that won't fetch */ }
    });
    frontier = [...next];
  }
  const fetched = seen.size;
  const all = [...new Set([...liveApi, ...fromCode])].sort();
  const byModule = {};
  for (const p of all) { const mod = (p.match(/([\w-]*-api)\/api\/v\d+/) || [, '(other)'])[1]; (byModule[mod] = byModule[mod] || []).push(p); }
  const insuranceEndpoints = all.filter((p) => INS_RE.test(p));
  return {
    base: HIS_BASE, jsBundles: jsUrls.size, jsFetched: fetched, liveCalls: [...liveApi].sort(),
    totalEndpoints: all.length, modules: Object.keys(byModule).sort(),
    insuranceEndpoints,                       // ← the answer: empty = no Nphies module exposed to the SPA
    byModuleCounts: Object.fromEntries(Object.entries(byModule).map(([m, a]) => [m, a.length])),
    allEndpoints: all,
    raw: collectRaw ? rawParts.join('\n') : undefined,   // full concatenated frontend JS (all payloads live here)
  };
}

// Download the ENTIRE Siratech frontend JS (all bundles + lazy chunks) as one file —
// this is the raw source that contains every endpoint AND its request payload. Token in
// the URL so it opens from a phone browser. Heavy (headless login + BFS of up to 500
// chunks); give it a minute.
app.get('/download/frontend', async (req, res) => {
  try {
    const tok = String(req.query.token || '');
    if (API_TOKEN) {
      const a = Buffer.from(tok), b = Buffer.from(API_TOKEN);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send('Unauthorized — bad or missing ?token=');
    }
    const out = await discoverEndpoints({ collectRaw: true });
    const header = `/* Siratech frontend — ${out.jsFetched} JS bundles from ${out.base}\n   ${out.totalEndpoints} endpoints across modules: ${(out.modules || []).join(', ')}\n   Every API call + payload is in the code below. */\n`;
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="siratech-frontend-all.js"');
    return res.send(header + (out.raw || ''));
  } catch (e) { return res.status(502).send('Error: ' + String(e.message || e)); }
});

// Search the harvested frontend for terms and return the surrounding code (the request
// PAYLOAD lives right next to each route name). Lets us mine the 45 MB app for exactly the
// calls we care about WITHOUT shipping the whole file — the connector greps it server-side
// and returns only small snippets. Raw harvest cached ~10 min so repeat queries are instant.
let _frontendRaw = null;
async function getFrontendRaw() {
  if (_frontendRaw && Date.now() - _frontendRaw.ts < 600000) return _frontendRaw.raw;
  const out = await discoverEndpoints({ collectRaw: true });
  _frontendRaw = { raw: out.raw || '', ts: Date.now() };
  return _frontendRaw.raw;
}
app.get('/diag/frontend-find', requireAuth, async (req, res) => {
  try {
    const terms = String(req.query.q || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25);
    const ctx = Math.max(60, Math.min(600, Number(req.query.ctx) || 220));
    const raw = await getFrontendRaw();
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = {};
    for (const t of terms) {
      const re = new RegExp(esc(t), 'gi');
      let m, count = 0; const samples = [];
      while ((m = re.exec(raw)) !== null) {
        count += 1;
        if (samples.length < 5) samples.push(raw.slice(Math.max(0, m.index - 45), Math.min(raw.length, m.index + ctx)).replace(/\s+/g, ' '));
        re.lastIndex = m.index + t.length;
        if (count > 5000) break;
      }
      found[t] = { count, samples };
    }
    return res.json({ ok: true, rawSizeMB: Math.round(raw.length / 1e6 * 10) / 10, found });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

app.get('/discover/endpoints', requireAuth, async (_req, res) => {
  try {
    if (!_discoverInFlight) _discoverInFlight = discoverEndpoints().finally(() => { _discoverInFlight = null; });
    const out = await _discoverInFlight;
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

// Look up a patient's radiology orders by file (MRN) number.
app.get('/patient/:file', requireAuth, async (req, res) => {
  let file = String(req.params.file || '').trim();
  if (!file) return res.status(400).json({ ok: false, error: 'file (MRN) is required' });
  try {
    // Accept ANY identifier, not just the MRN: if the input is a mobile / national ID
    // / iqama, resolve it to the real MRN first (the same unified search the lookup
    // page uses), so every search box finds the patient the same way.
    const _d = file.replace(/\D/g, '');
    const _looksNonMrn = /^(?:00)?(?:966)?0?5\d{8}$/.test(_d) || /^[12]\d{9}$/.test(_d);
    if (_looksNonMrn) {
      try {
        const s = await _patientSearch(file);
        if (s && s.patients && s.patients.length && s.patients[0].mrno) file = String(s.patients[0].mrno);
      } catch (e) { /* fall through and try the raw value as an MRN */ }
    }
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
    // One-time diagnostic (key NAMES + non-PHI site values only): reveal which fields
    // FetchRadiologyDetails carries for the order's OWN branch, so branch is read from
    // the order's real ordering site (e.g. NEST 3) and not the logged-in/session site.
    if (!_lookupOrderKeysLogged && rawOrders.length) {
      _lookupOrderKeysLogged = true;
      const o0 = rawOrders[0];
      console.log('[lookup] FetchRadiologyDetails order keys:', Object.keys(o0).join(','));
      const siteFields = Object.fromEntries(Object.entries(o0)
        .filter(([k]) => /site|hospital|branch|facility|location|center|clinic/i.test(k)));
      console.log('[lookup] order site/branch fields:', JSON.stringify(siteFields));
    }
    // Correct each order's branch to where it was ACTUALLY ordered (FetchRadiologyDetails
    // gives the patient's registration site, not the ordering branch). Doing this BEFORE
    // enrichOrder also fixes the clinical indication: enrichOrder queries the RIS panel at
    // o.siteId, so once the site is right it finds the order's row and its indication.
    try {
      // Only probe the branches this patient's orders actually touch (+ the result
      // site) instead of all 14 — the orders already carry their site, so this keeps
      // the branch correction while cutting the fan-out that made the card slow.
      const candidateSites = [...new Set(rawOrders.map((o) => Number(o.siteId)).filter((n) => Number.isFinite(n) && n > 0).concat(RESULT_SITE))];
      const billToSite = await discoverOrderSites(file, candidateSites);
      for (const o of rawOrders) {
        const t = billToSite.get(String(o.billNo));
        if (t && t.siteId && Number(t.siteId) !== Number(o.siteId)) {
          console.log(`[lookup] bill ${o.billNo}: site ${o.siteId} (${o.site}) -> ${t.siteId} (${t.site})`);
          o.siteId = t.siteId;
          o.site = t.site;
        }
      }
    } catch (e) { /* keep the original registration site on any failure */ }
    // Enrich each order with its clinical indication + billing/ER status.
    const ext = await Promise.all(rawOrders.map((o) => enrichOrder(file, o)));
    const orders = rawOrders.map((o, i) => normalizeOrder(o, ext[i]));
    const rawPatient = ((pat && pat.json && pat.json.data) || [])[0] || null;
    const patient = normalizePatient(rawPatient);
    // TEMP DEBUG (read-only, key NAMES only — no PHI values): reveal which fields the
    // HIS patient row actually carries, so we can wire any missing clinical attribute
    // (height/weight/blood group/allergy) to its real field name. Drop once mapped.
    const patientRawKeys = rawPatient ? Object.keys(rawPatient) : [];
    return res.json({ ok: true, file, patient, patientRawKeys, orders, count: orders.length, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Patient clinical history (READ-ONLY) ──────────────────────────────────────
// The radiologist's context for a study: the patient's PROBLEM LIST (ICD-coded
// diagnoses), known ALLERGIES / clinical warnings (contrast safety), and any
// recorded VITAL SIGNS (height/weight/BP — often absent in an imaging-only clinic,
// so shown only when present). All from Siratech EMR, in one parallel call; loaded
// after the card paints so it never slows the first render. Never writes.
function _clinAllergyList(a) {
  const pick = (o) => o && (o.allergyName || o.allergen || o.drugName || o.itemName || o.name
    || o.description || o.warningName || o.problemName || o.reactionName);
  const sev = (o) => o && (o.severity || o.severityName || o.reactionSeverity || null);
  const rxn = (o) => o && (o.reaction || o.reactionName || o.reactionType || null);
  return (Array.isArray(a) ? a : []).map((o) => ({
    name: (pick(o) || '').toString().trim() || null,
    severity: sev(o) ? String(sev(o)).trim() : null,
    reaction: rxn(o) ? String(rxn(o)).trim() : null,
  })).filter((x) => x.name);
}
const _VITAL_MAP = [
  ['height', ['height', 'heightCm', 'heightValue', 'vitalHeight']],
  ['weight', ['weight', 'weightKg', 'weightValue', 'vitalWeight']],
  ['bmi', ['bmi', 'bodyMassIndex', 'bmiValue']],
  ['systolic', ['systolic', 'bpSystolic', 'systolicValue', 'sbp']],
  ['diastolic', ['diastolic', 'bpDiastolic', 'diastolicValue', 'dbp']],
  ['pulse', ['pulse', 'heartRate', 'pulseValue', 'hr']],
  ['temperature', ['temperature', 'temp', 'temperatureValue']],
  ['spo2', ['spo2', 'spO2', 'oxygenSaturation', 'saturation']],
  ['respiratoryRate', ['respiratoryRate', 'respRate', 'rr']],
];
// The vitals endpoints return in different shapes (a bare array, or an object wrapping the
// rows, or a single object of values) — normalise any of them to an array of rows.
function _asVitalRows(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === 'object') {
    for (const k of ['rows', 'vitals', 'list', 'items', 'data', 'result', 'vitalSigns']) {
      if (Array.isArray(x[k])) return x[k];
    }
    return [x];
  }
  return [];
}
// Pattern fallback: scan EVERY key of the vital rows so an unexpected HIS field name is
// still caught without knowing it in advance (label keys like *Unit/*Date are skipped).
const _VITAL_PAT = [
  ['height', /height|(^|[^a-z])ht([^a-z]|$)/i],
  ['weight', /weight|bodyweight|(^|[^a-z])wt([^a-z]|$)/i],
  ['bmi', /bmi|bodymass/i],
  ['systolic', /systolic|sbp|bpsys/i],
  ['diastolic', /diastolic|dbp|bpdia/i],
  ['pulse', /pulse|heartrate|(^|[^a-z])hr([^a-z]|$)/i],
  ['temperature', /temperature|(^|[^a-z])temp/i],
  ['spo2', /spo2|oxygensat|saturation|o2sat/i],
  ['respiratoryRate', /respiratory|resprate|(^|[^a-z])rr([^a-z]|$)/i],
];
function _vitalsByPattern(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const out = {};
  for (const [key, re] of _VITAL_PAT) {
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      for (const [k, v] of Object.entries(r)) {
        if (v == null || String(v).trim() === '' || String(v).trim() === '0') continue;
        if (re.test(k) && !/date|time|id$|name|unit|note|type|method|remark/i.test(k)) { out[key] = String(v).trim(); break; }
      }
      if (out[key] != null) break;
    }
  }
  return Object.keys(out).length ? out : null;
}
// Name/value vital rows (Clinicalreport/Vitals): each row is ONE vital — the type is in a
// *Name field (vsPhysName) and the value in a *Value field (vsPhysValue). Map by name.
const _VNV_NAME = ['vsPhysName', 'vitalName', 'physName', 'parameterName', 'vsName', 'name'];
const _VNV_VAL = ['vsPhysValue', 'vitalValue', 'physValue', 'parameterValue', 'vsValue', 'result', 'value'];
const _VNV_MAP = [
  ['height', /height|طول|\bht\b/i],
  ['weight', /weight|وزن|\bwt\b/i],
  ['bmi', /bmi|body\s*mass/i],
  ['systolic', /systolic|\bsbp\b/i],
  ['diastolic', /diastolic|\bdbp\b/i],
  ['bp', /blood\s*pressure|\bbp\b|ضغط/i],
  ['pulse', /pulse|heart\s*rate|نبض|\bhr\b/i],
  ['temperature', /temp|حرار/i],
  ['spo2', /spo2|oxygen|saturation|تشبع/i],
  ['respiratoryRate', /respirat|resp\s*rate|تنفس|\brr\b/i],
];
function _vnvNames(rows) {
  const pick = (r, keys) => { for (const k of keys) if (r && r[k] != null && String(r[k]).trim() !== '') return String(r[k]).trim(); return null; };
  return (Array.isArray(rows) ? rows : []).map((r) => pick(r, _VNV_NAME)).filter(Boolean);
}
function _vitalsFromNameValue(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const pick = (r, keys) => { for (const k of keys) if (r && r[k] != null && String(r[k]).trim() !== '') return String(r[k]).trim(); return null; };
  const out = {};
  for (const r of rows) {
    const nm = pick(r, _VNV_NAME), vl = pick(r, _VNV_VAL);
    if (!nm || vl == null) continue;
    for (const [key, re] of _VNV_MAP) { if (re.test(nm) && out[key] == null) { out[key] = vl; break; } }
  }
  if (out.bp && !out.systolic) { const m = String(out.bp).match(/(\d+)\s*\/\s*(\d+)/); if (m) { out.systolic = m[1]; out.diastolic = m[2]; } }
  delete out.bp;
  return Object.keys(out).length ? out : null;
}
function _clinVitals(list) {
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return null;
  // Newest first, then collapse to the most recent non-empty value per vital.
  rows.sort((a, b) => (parseHisDate(b.vitalDate || b.recordedDate || b.emrDate || '') || 0)
    - (parseHisDate(a.vitalDate || a.recordedDate || a.emrDate || '') || 0));
  const out = {};
  for (const [key, names] of _VITAL_MAP) {
    for (const r of rows) { const v = firstOf(r, names); if (v != null && String(v).trim() !== '') { out[key] = String(v).trim(); break; } }
  }
  const when = rows[0] && (rows[0].vitalDate || rows[0].recordedDate || rows[0].emrDate);
  return Object.keys(out).length ? { ...out, recordedAt: when || null } : null;
}
app.get('/patient/:file/clinical', requireAuth, async (req, res) => {
  const file = String(req.params.file || '').trim();
  if (!file) return res.status(400).json({ ok: false, error: 'file (MRN) is required' });
  try {
    await getToken();
    const H = (path, body) => hisFetch(path, { body }).then((r) => (r.json && r.json.data)).catch(() => null);
    const G = (path) => hisFetch(path, { method: 'GET' }).then((r) => (r.json && r.json.data)).catch(() => null);
    // Vitals come from these EMR endpoints (mrno + fromDate/toDate). VitalSign/List was the
    // old (empty) source; Clinicalreport/Vitals and VitalSign/Summary are the ones the HIS
    // actually populates — query all and use whichever returns rows.
    const vFrom = new Date(Date.now() - 730 * 864e5).toISOString();   // ~2 years back
    const vTo = new Date(Date.now() + 864e5).toISOString();
    const vBody = { mrno: file, fromDate: vFrom, toDate: vTo };
    // Cap the vitals calls so a slow/invalid endpoint can never hang the card (the whole HIS
    // timeout is 30s; the card must not wait that long for a non-critical section).
    const cap = (p) => Promise.race([p, sleep(8000).then(() => null)]);
    const [dx, allergyD, vitalList, vitalReport, vitalSummary, patData, birthMother] = await Promise.all([
      H('/emr-api/api/v1/Diagnosis/PatientProblemlist', { mrno: file }),
      H('/emr-api/api/v1/EMR/Allergies/ClinicalWarnings', { mrno: file }),
      cap(H('/emr-api/api/v1/VitalSign/List', { mrno: file })),
      cap(H('/emr-api/api/v1/Clinicalreport/Vitals', vBody)),
      cap(H('/emr-api/api/v1/VitalSign/Summary', vBody)),
      // PatientData lives under patient-api (NOT emr-api — that path 404s, which left every flag
      // blank). It carries blood group, infection status, VIP, clinical warning and pregnancy.
      cap(G('/patient-api/api/v1/Patient/PatientData?mrNo=' + encodeURIComponent(file) + '&hospitalId=0&mode=0')),
      // Gestational age (fetal) for a pregnant patient — relevant to radiation safety.
      cap(G('/emr-api/api/v1/EMR/FetchBirthNoteMotherDetails?Mrno=' + encodeURIComponent(file))),
    ]);
    // Radiology-relevant patient flags: infection status (isolation / contrast &
    // scanner precautions), blood group, VIP, pregnancy, and any clinical warning text.
    const pd = (Array.isArray(patData) ? patData[0] : patData) || {};
    const infections = [];
    if (Number(pd.isHepatitisB) > 0) infections.push('Hep B');
    if (Number(pd.isHepatitisC) > 0) infections.push('Hep C');
    if (Number(pd.isHiv) > 0) infections.push('HIV');
    // Gestational age from FetchBirthNoteMotherDetails ({gWeek,gDays}); shown only when present.
    const bm = (Array.isArray(birthMother) ? birthMother[0] : birthMother) || {};
    const gW = Number(bm.gWeek), gD = Number(bm.gDays);
    const fetal = ((Number.isFinite(gW) && gW > 0) || (Number.isFinite(gD) && gD > 0))
      ? { gestationWeeks: Number.isFinite(gW) && gW > 0 ? gW : null, gestationDays: Number.isFinite(gD) && gD > 0 ? gD : null }
      : null;
    const flags = {
      bloodGroup: (pd.bloodGroup || '').toString().trim() || null,
      infections,
      vip: Number(pd.isVip) > 0,
      pregnant: Number(pd.pregnanyStatus) > 0 || !!fetal,
      clinicalWarning: (pd.clinicalWarning || '').toString().trim() || null,
    };
    const seen = new Set();
    const diagnoses = (Array.isArray(dx) ? dx : [])
      .map((d) => ({ icdCode: d.icdCode || null, name: (d.icdName || '').trim(),
        chronic: !!d.isChronic, history: !!d.isHistory, date: d.emrDate ? String(d.emrDate).slice(0, 10) : null }))
      .filter((d) => d.name && !seen.has(d.icdCode + d.name) && seen.add(d.icdCode + d.name));
    const A = allergyD || {};
    const allergies = {
      drug: _clinAllergyList(A.drugAllergy),
      other: _clinAllergyList(A.otherAllergy),
      warnings: _clinAllergyList(A.clinicalWarning),
    };
    allergies.any = allergies.drug.length + allergies.other.length + allergies.warnings.length;
    // Height/weight/BMI often live on the patient RECORD (PatientData), not the per-visit
    // VitalSign list — merge those in as a fallback so the card can show them even when the
    // clinic didn't file a vitals row. Same broad aliases as normalizePatient.
    // Clinicalreport/Vitals is a NAME/VALUE list — each row is one vital (type in vsPhysName,
    // value in vsPhysValue), not columns. Extract by matching the name; fall back to the old
    // column-based extractors for any source that IS column-shaped.
    const allVitalRows = [].concat(_asVitalRows(vitalReport), _asVitalRows(vitalSummary), _asVitalRows(vitalList));
    let vitals = _vitalsFromNameValue(allVitalRows);
    if (!vitals) {
      for (const src of [vitalReport, vitalSummary, vitalList]) {
        const v = _clinVitals(_asVitalRows(src));
        if (v) { vitals = v; break; }
      }
      const patVit = _vitalsByPattern(allVitalRows);
      if (patVit) vitals = Object.assign({}, patVit, vitals || {});
    }
    const pdH = firstOf(pd, ['height', 'patientHeight', 'heightCm', 'height_cm', 'vitalHeight']);
    const pdW = firstOf(pd, ['weight', 'patientWeight', 'weightKg', 'weight_kg', 'vitalWeight']);
    let pdB = firstOf(pd, ['bmi', 'BMI', 'bodyMassIndex']);
    const hN = Number(pdH), wN = Number(pdW);
    if (pdB == null && Number.isFinite(hN) && hN > 0 && Number.isFinite(wN) && wN > 0) {
      const m = hN > 3 ? hN / 100 : hN;
      pdB = Math.round((wN / (m * m)) * 10) / 10;
    }
    const pdVit = { height: pdH, weight: pdW, bmi: pdB };
    if (Object.values(pdVit).some((v) => v != null && String(v).trim() !== '')) {
      vitals = vitals || {};
      for (const k of ['height', 'weight', 'bmi']) {
        if ((vitals[k] == null || String(vitals[k]).trim() === '') && pdVit[k] != null && String(pdVit[k]).trim() !== '') {
          vitals[k] = String(pdVit[k]).trim();
        }
      }
    }
    return res.json({ ok: true, build: CONNECTOR_BUILD, file, diagnoses, allergies, vitals, fetal, flags,
      fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Patient recent VISITS (READ-ONLY) ─────────────────────────────────────────
// The patient's clinic visits from Visits/ByFilter (captured live): each carries the
// date, OP/ER type, in-charge provider + department, branch, and the CHIEF COMPLAINT
// — a real "browse the patient's history" view for the radiologist, in one call
// (hospitalId null = all branches). Never writes.
app.get('/patient/:file/visits', requireAuth, async (req, res) => {
  const file = String(req.params.file || '').trim();
  if (!file) return res.status(400).json({ ok: false, error: 'file (MRN) is required' });
  try {
    await getToken();
    const daysBack = Math.max(1, Math.min(3650, Number(req.query.days) || 365));
    const from = new Date(Date.now() - daysBack * 864e5).toISOString();
    const to = new Date(Date.now() + 864e5).toISOString();
    const r = await hisFetch('/emr-api/api/v1/Visits/ByFilter', { body: {
      mrno: file, fromDate: from, toDate: to, hospitalId: null, group: 0,
      empcat: '1,2,3', searchText: '', searchType: 0 } });
    const rows = (r.json && r.json.data) || [];
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const visits = rows.map((v) => ({
      encounterId: v.patFinEncounterID || null,
      date: v.startDate || v.admitDate || null,
      visitType: clean(v.episodeStatusText) || null,          // OP | ER | IP
      provider: clean(v.inchargeProviderName) || null,
      department: clean(v.inchargeProviderDept || v.deptName) || null,
      site: clean(v.siteName) || null,
      chiefComplaint: clean((v.chiefComplaints || '').replace(/;/g, ' · ')) || null,
      problems: clean(v.problems) || null,
    })).sort((a, b) => (parseHisDate(b.date || '') || 0) - (parseHisDate(a.date || '') || 0));
    return res.json({ ok: true, file, visits, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Patient LAB RESULTS (READ-ONLY) ───────────────────────────────────────────
// Siratech serves the clinical lab report through Clinicalreport/ClinicalServiceData
// (captured live): a gzip+base64 payload whose clinicalReportDTOList is a tree of
// tests / profiles, each carrying its value, reference range, and normal/abnormal/
// critical flag per result date. We decode it and flatten to a clean list — real lab
// numbers for the radiologist. Never writes.
function _labRound(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return '';
  const n = Number(s);
  if (!Number.isFinite(n) || !/^-?\d*\.?\d+$/.test(s)) return s;   // non-numeric → as-is
  return (Math.round(n * 100) / 100).toString();                  // 7.1462 → 7.15, 18 → 18
}
// The newest non-empty value on a leaf test → a clean result object (or null).
function _labLeafVal(it) {
  const di = it.dataItems || {};
  for (const dt of Object.keys(di)) {
    for (const v of (di[dt] || [])) {
      const val = _labRound(v && v.value);
      if (val === '') continue;
      return {
        name: (it.test || '').trim() || 'Test', value: val,
        range: (it.normalRange || '').trim() || null,
        abnormal: /abnormal/i.test((v && v.severityRange) || ''),
        critical: !!(v && v.isCritical),
        date: (v && v.entryDate) || dt || null,
        by: ((v && v.employeeName) || '').trim() || null,
        id: (v && v.invPatTestResultID) || null,
      };
    }
  }
  return null;
}
// A profile's display name: "Lipid Profile [Total Cholesterol, …]" → "Lipid Profile".
function _panelName(s) {
  const n = String(s || '').split('[')[0].replace(/\s+/g, ' ').trim();
  return n || 'Panel';
}
// Group the report tree into PANELS (Lipid Profile, Liver Function, Renal profile, …);
// stand-alone tests fall under "Other tests". Each panel keeps its tests with value/range/
// flag. Also returns a flat list for callers that want it.
function _groupLabs(list) {
  const panels = [];
  const flat = [];
  const other = { name: 'Other tests', tests: [] };
  for (const it of (list || [])) {
    if (it.children && it.children.length) {
      const tests = [];
      for (const c of it.children) { const t = _labLeafVal(c); if (t) { tests.push(t); flat.push(t); } }
      if (tests.length) panels.push({ name: _panelName(it.test), tests });
    } else {
      const t = _labLeafVal(it);
      if (t) { other.tests.push(t); flat.push(t); }
    }
  }
  if (other.tests.length) panels.push(other);
  // Panels with an abnormal value first, then by size (richer panels first).
  panels.sort((a, b) => (b.tests.some((t) => t.abnormal || t.critical) - a.tests.some((t) => t.abnormal || t.critical))
    || (b.tests.length - a.tests.length));
  return { panels, flat };
}
app.get('/patient/:file/labs', requireAuth, async (req, res) => {
  const file = String(req.params.file || '').trim();
  if (!file) return res.status(400).json({ ok: false, error: 'file (MRN) is required' });
  try {
    await getToken();
    const uid = currentProviderId() || String(HIS_USER).padStart(8, '0');
    const daysBack = Math.max(1, Math.min(3650, Number(req.query.days) || 365));
    const from = new Date(Date.now() - daysBack * 864e5).toISOString();
    const to = new Date(Date.now() + 864e5).toISOString();
    const r = await hisFetch('/emr-api/api/v1/Clinicalreport/ClinicalServiceData', { body: {
      mrno: file, fromDate: from, toDate: to, invcategoryid: 0, hospitalId: 0,
      providerId: '', LoggedInUserId: String(uid) } });
    let payload = {};
    const blob = r.json && r.json.data;
    if (typeof blob === 'string' && blob) {
      try { payload = JSON.parse(zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8')); }
      catch (_e) { payload = {}; }
    } else if (blob && typeof blob === 'object') {
      payload = blob;
    }
    const { panels, flat } = _groupLabs(payload.clinicalReportDTOList || []);
    const counts = { normal: payload.normalCnt || 0, abnormal: payload.abNormalCnt || 0, critical: payload.criticalCnt || 0 };
    // Most recent result date across the report (for the header).
    const latest = flat.map((t) => t.date).filter(Boolean)
      .sort((a, b) => (parseHisDate(b) || 0) - (parseHisDate(a) || 0))[0] || null;
    return res.json({ ok: true, file, panels, results: flat, counts, latest,
      dates: payload.distinctDates || [], fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Patient APPOINTMENTS (READ-ONLY) ──────────────────────────────────────────
// The patient's appointment history (date · speciality · resource/doctor · status),
// from Appointments/History/ByPatient. Read-only.
app.get('/patient/:file/appointments', requireAuth, async (req, res) => {
  const file = String(req.params.file || '').trim();
  if (!file) return res.status(400).json({ ok: false, error: 'file (MRN) is required' });
  try {
    await getToken();
    const uid = currentProviderId() || String(HIS_USER).padStart(8, '0');
    const r = await hisFetch('/emr-api/api/v1/Appointments/History/ByPatient', { body: {
      mrno: file, apptDate: '1900-01-01', providerName: '', genSpecialityId: 0,
      hospitalId: 0, userId: String(uid), isOutsider: false } });
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const rows = ((r.json && r.json.data) || []).map((a) => ({
      date: a.allocationDate || a.confirmationDate || a.enteredDate || null,
      speciality: clean(a.specialityName) || null,
      resource: clean(a.apptResourceName) || null,
      status: clean(a.apptstatus) || null,
      site: clean(a.hospitalShortName || a.hospitalName) || null,
      remarks: clean(a.apptRemarks) || null,
    })).sort((x, y) => (parseHisDate(y.date || '') || 0) - (parseHisDate(x.date || '') || 0));
    return res.json({ ok: true, file, appointments: rows, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Visit clinical NOTE (READ-ONLY) ───────────────────────────────────────────
// The doctor's note(s) for ONE encounter: Visits/DetailsByGroup lists the note
// templates on the visit, then EMRCore/EmrHtmlPreview renders each — we strip its
// emrPrintFormats down to label/text sections (chief complaint, findings, plan,
// diagnosis). On-demand (drill-in from a visit row). Read-only.
function _stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}
app.get('/patient/:file/visit-note', requireAuth, async (req, res) => {
  const file = String(req.params.file || '').trim();
  const encounterId = String(req.query.encounterId || '').trim();
  if (!file || !encounterId) return res.status(400).json({ ok: false, error: 'file and encounterId are required' });
  try {
    await getToken();
    const providerId = currentProviderId() || String(HIS_USER).padStart(8, '0');
    const pd = await hisFetch('/emr-api/api/v1/Patient/PatientData?mrNo=' + encodeURIComponent(file) + '&hospitalId=0&mode=0', { method: 'GET' })
      .then((r) => (r.json && r.json.data)).catch(() => null);
    const p = (Array.isArray(pd) ? pd[0] : pd) || {};
    const gender = p.gender || '', age = p.ageInDays || 0;
    const from = new Date(Date.now() - 3650 * 864e5).toISOString();
    const to = new Date(Date.now() + 864e5).toISOString();
    const dg = await hisFetch('/emr-api/api/v1/Visits/DetailsByGroup', { body: {
      mrno: file, fromDate: from, toDate: to, hospitalId: null, groupByValue: String(encounterId),
      searchText: '', searchType: 0, groupBy: 0, limit: 20, offset: 0, empcat: '1,2,3' } });
    const noteRows = (dg.json && dg.json.data) || [];
    // The note render lives under a DIFFERENT base than the rest of the EMR API: it is
    // /emr-core-api/api/v1/EMRCore/EmrHtmlPreview (NOT /emr-api/...) — the wrong base was the 404.
    // Its data carries emrPrintFormats[]: each is a SECTION (mainHeading) whose printRowDataList[]
    // rows hold the text in `data` (with `isHeading` marking sub-headings). Render each note with a
    // SINGLE sequential call (hard-capped at 6s) — light on the 2GB box, no browser, no fan-out.
    const cap6 = (p) => Promise.race([p, sleep(6000).then(() => ({ status: 'timeout', json: null, text: '' }))]);
    const notes = [];
    for (const row of noteRows) {
      const body = {
        emrPatMastChecklistId: 0, emrProviderVisitId: Number(row.emrProviderVisitId) || 0,
        templateId: Number(row.emrTemplateId) || 0, emrTemplateId: Number(row.emrTemplateId) || 0,
        mrno: file, providerId: String(providerId), gender, age,
        patFinEncounterId: Number(encounterId) || 0, patFinEncounterID: Number(encounterId) || 0,
        emrPatTemplateId: Number(row.emrPatTemplateId) || 0, emrNoteType: row.emrNoteType,
        isValid: 1, editStatus: 0,
      };
      try {
        const prev = await cap6(hisFetch('/emr-core-api/api/v1/EMRCore/EmrHtmlPreview', { body }));
        const pr = (prev.json && prev.json.data);
        const pdata = Array.isArray(pr) ? pr[0] : pr;
        const sections = [];
        for (const fmt of ((pdata && pdata.emrPrintFormats) || [])) {
          const lines = [];
          for (const rr of (fmt.printRowDataList || [])) {
            const text = _stripHtml(rr.data);
            if (text) lines.push(text);
          }
          const label = _stripHtml(fmt.mainHeading) || null;
          if (lines.length) sections.push({ label, text: lines.join('\n') });
        }
        if (sections.length) notes.push({
          templateName: (row.templateName || '').trim() || 'Note',
          by: ((pdata && pdata.enteredBy) || row.employeeName || '').toString().trim() || null,
          date: (pdata && pdata.visitDate) || row.emrDate || null,
          sections,
        });
      } catch (_e) { /* skip a note that fails to render; the others still show */ }
    }
    return res.json({ ok: true, build: CONNECTOR_BUILD, file, encounterId, notes, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ── HIS user privileges (READ-ONLY) ───────────────────────────────────────────
// Siratech's Security Suite exposes a user's privileges/modules only for READING (there is
// no assign/write API). This surfaces the count + shape so we can size the privilege catalog
// and decide what a superadmin "view privileges" screen can show. Never writes.
app.get('/user/:id/privileges', requireAuth, async (req, res) => {
  const raw = String(req.params.id || '').trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'user id required' });
  const uid = /^\d+$/.test(raw) ? raw.padStart(8, '0') : raw;   // HIS user ids are 8-digit
  const hospitalId = String(req.query.hospitalId || '0');
  try {
    await getToken();
    const G = (p) => hisFetch(p, { method: 'GET' })
      .then((r) => ({ status: r.status, data: (r.json && (r.json.data !== undefined ? r.json.data : r.json)) }))
      .catch((e) => ({ error: String(e && e.message) }));
    const enc = encodeURIComponent(uid);
    const [priv, modPriv, modules, menu] = await Promise.all([
      G('/security-api/api/v1/Authentication/Privileges/ByUser/' + enc + '?HospitalId=' + encodeURIComponent(hospitalId)),
      G('/security-api/api/v1/Authentication/GetModulePrivilege?UserId=' + enc),
      G('/security-api/api/v1/Authentication/Modules/ByUser/' + enc),
      G('/security-api/api/v1/Menu/List/' + enc + '/' + encodeURIComponent(hospitalId)),
    ]);
    // Recursively count leaf privilege nodes in a tree (module → children → privileges).
    const countTree = (n) => {
      if (Array.isArray(n)) return n.reduce((s, x) => s + countTree(x), 0);
      if (n && typeof n === 'object') {
        const kids = n.children || n.privileges || n.subMenus || n.menus || n.items || n.privilegeList;
        if (Array.isArray(kids) && kids.length) return countTree(kids);
        return 1;   // a leaf
      }
      return 0;
    };
    const sz = (x) => (x && Array.isArray(x.data)) ? x.data.length : (x && x.data && typeof x.data === 'object' ? Object.keys(x.data).length : 0);
    const sampleKeys = (x) => (x && Array.isArray(x.data) && x.data[0] && typeof x.data[0] === 'object') ? Object.keys(x.data[0])
      : (x && x.data && typeof x.data === 'object' && !Array.isArray(x.data) ? Object.keys(x.data).slice(0, 40) : []);
    // All HIS sites (id → name) so the UI can show real branch names, and the set of sites the
    // user actually has (parsed from each privilege's `hospitals` string like "[1],[3],[14]").
    const siteList = await getSites().catch(() => []);
    const granted = new Set();
    if (Array.isArray(priv.data)) {
      for (const p of priv.data) {
        const h = p && (p.hospitals || p.hospitalIds || '');
        for (const m of String(h).matchAll(/\[(\d+)\]/g)) granted.add(Number(m[1]));
      }
    }
    const names = Array.isArray(priv.data) ? priv.data.map((p) => p && (p.privilages || p.privileges || p.privilegeName || p.name)).filter(Boolean) : [];
    // Groups are the real unit of access in Siratech (a save assigns groups, not loose
    // privileges), so surface the user's groups + the full group catalogue for naming.
    // READ-ONLY: GetGenUserGroups (this user) and GetAllGenGroups (catalogue). Never writes.
    const umgrHeaders = { 'X-App-Client': 'his.meena-health.com', 'X-App-Mode': 'ENCV0',
      'GENERAL-API-ACCESS': 'GENERAL-API-ACCESS', 'API-LICENSE-ACCESS': 'API-FREE-LICENSE' };
    const Gum = (p) => hisFetch(p, { method: 'GET', headers: umgrHeaders })
      .then((r) => ({ status: r.status, data: (r.json && (r.json.data !== undefined ? r.json.data : r.json)) }))
      .catch((e) => ({ error: String(e && e.message) }));
    const [userGroups, allGroups] = await Promise.all([
      Gum('/user-management-api/api/v1/Group/GetGenUserGroups?UserId=' + enc),
      Gum('/user-management-api/api/v1/Group/GetAllGenGroups?ParentGroupId=0'),
    ]);
    // Normalise a group row (field names vary across endpoints) to {id, name}.
    const gId = (g) => g && (g.genGroupID ?? g.genGroupId ?? g.groupId ?? g.groupid ?? g.id);
    const gName = (g) => g && (g.groupName ?? g.groupname ?? g.name ?? g.groupDescription ?? '');
    const catalogArr = Array.isArray(allGroups.data) ? allGroups.data
      : (allGroups.data && Array.isArray(allGroups.data.genGroups) ? allGroups.data.genGroups : []);
    const nameById = {};
    for (const g of catalogArr) { const id = gId(g); if (id != null) nameById[id] = gName(g) || ('Group ' + id); }
    const userGroupArr = Array.isArray(userGroups.data) ? userGroups.data
      : (userGroups.data && Array.isArray(userGroups.data.genGroups) ? userGroups.data.genGroups : []);
    const groups = userGroupArr.map((g) => { const id = gId(g); return { id, name: gName(g) || nameById[id] || ('Group ' + id) }; })
      .filter((g) => g.id != null);
    return res.json({ ok: true, build: CONNECTOR_BUILD, userId: uid, hospitalId,
      sites: siteList.map((s) => ({ id: s.siteId, name: s.shortName || s.name || ('Site ' + s.siteId) })),
      grantedSites: [...granted].sort((a, b) => a - b),
      groups, groupCount: groups.length,
      groupCatalog: { status: allGroups.status, count: catalogArr.length,
        items: catalogArr.map((g) => ({ id: gId(g), name: gName(g) })).filter((g) => g.id != null) },
      privilegesByUser: { status: priv.status, error: priv.error || null, count: sz(priv), keys: sampleKeys(priv),
        names, sample: Array.isArray(priv.data) ? priv.data.slice(0, 3) : priv.data },
      modulePrivilege: { status: modPriv.status, error: modPriv.error || null, topLevel: sz(modPriv), leafCount: countTree(modPriv.data), keys: sampleKeys(modPriv) },
      modules: { status: modules.status, error: modules.error || null, count: sz(modules), keys: sampleKeys(modules) },
      menu: { status: menu.status, error: menu.error || null, topLevel: sz(menu), leafCount: countTree(menu.data), keys: sampleKeys(menu) },
      // ?raw=1 → the full modules + menu trees so we can find the name→id mapping (genPrivilegeId).
      raw: req.query.raw ? { modules: modules.data, modulePrivilege: modPriv.data, menu: menu.data,
        privSample: Array.isArray(priv.data) ? priv.data.slice(0, 2) : priv.data } : undefined,
      fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ── User-management API reachability probe (READ-ONLY) ─────────────────────────
// Privilege WRITES live on user-management-api (Group/GetAllSelectedGroupsAndPrivilegesV1 +
// User/GenUserCreation), a service the connector has never called. Before any restore we must
// know if the connector's token can even reach it. This ONLY reads (catalog size + a user's
// current privileges); it writes NOTHING.
app.get('/user/:id/umgr-probe', requireAuth, async (req, res) => {
  const raw = String(req.params.id || '').trim();
  const uid = /^\d+$/.test(raw) ? raw.padStart(8, '0') : raw;
  try {
    await getToken();
    const extra = { 'X-App-Client': 'his.meena-health.com', 'X-App-Mode': 'ENCV0',
      'GENERAL-API-ACCESS': 'GENERAL-API-ACCESS', 'API-LICENSE-ACCESS': 'API-FREE-LICENSE' };
    const G = (p) => hisFetch(p, { method: 'GET', headers: extra })
      .then((r) => { let d = null; try { d = r.json && r.json.data && r.json.data.selectedGroupsAndPrivilegesV1ResponseDTOList; } catch (e) {}
        return { status: r.status, rows: Array.isArray(d) ? d.length : null, sampleKeys: Array.isArray(d) && d[0] ? Object.keys(d[0]) : [], hint: (r.text || '').slice(0, 120).replace(/\s+/g, ' ') }; })
      .catch((e) => ({ error: String(e && e.message) }));
    const catalog = await G('/user-management-api/api/v1/Group/GetAllSelectedGroupsAndPrivilegesV1?GroupId=1262&UserId=1');
    const userPrv = await G('/user-management-api/api/v1/Group/GetAllSelectedGroupsAndPrivilegesV1?GroupId=0&UserId=' + encodeURIComponent(uid));
    return res.json({ ok: true, build: CONNECTOR_BUILD, userId: uid,
      reachable: catalog.status === 200, catalog, userPrivileges: userPrv, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Radiology result linking ─────────────────────────────────────────────────
// Match a patient's Siratech radiology order(s) to the VERIFIED DePACS study that
// holds the report — the strict, no-guess gate. READ-ONLY: it never writes.
// GET /results/match/:file            → match every pending order for the file
// POST /results/match {file, billNo}  → match one specific order (by bill no)
// The DICOM accession (e.g. "SIRA1661") is Siratech-generated when the order is
// imaged and is the SAME value DePACS stores in accession_number — the perfect
// 1:1 key. But the HIS exposes it under different names per endpoint (the patient
// lookup uses `accessionNumber`, the result-entry row historically `accessionNo`),
// so try them all; without it the matcher falls back to fuzzy body-part matching
// and goes ambiguous when a patient has several same-region studies in a day.
// TEMP DEBUG: surface every accession/id-like field so we can find where the
// linking DICOM accession (e.g. "SIRA1661") actually lives on the order side.
function _accDbg(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (!/acc|barcode|bill|uid|sira|sample|order|study|pacs/i.test(k)) continue;
    const v = obj[k];
    if (v != null && v !== '' && typeof v !== 'object') out[k] = String(v).slice(0, 48);
  }
  return out;
}

function pickAccession(...objs) {
  // ONLY real DICOM-accession field names. `sampleNo` is a comma-separated list of
  // lab/specimen BARCODES (e.g. "1312030726,1310030726,…"), NOT the DICOM accession
  // ("SIRA1661") — using it as the accession key risks a wrong-study bind, so it is
  // deliberately excluded. When no true accession is present the matcher correctly
  // falls back to modality + body-part + time.
  // ONLY real DICOM-accession fields. barCode/barcode were included here but the
  // function's own docstring says barcodes are lab/specimen ids, NOT the accession —
  // matching on them risks binding a report to the wrong study. Removed.
  const keys = ['accessionNumber', 'accessionNo', 'accession_no', 'accession', 'accNo'];
  for (const o of objs) {
    if (!o) continue;
    for (const k of keys) {
      const v = o[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return null;
}

// The result-entry worklist is per-site, but the UI/caller rarely knows which
// branch a patient's order lives at. FetchRadiologyDetails is site-agnostic and
// returns each order with its own siteId, so use it to auto-discover the site when
// none was pinned — matching the wanted bill when given, else the first order.
// Returns 0 on any failure so callers fall back to the RESULT_SITE default.
async function discoverOrderSite(file, wantBillNo) {
  try {
    const r = await hisFetch('/emr-api/api/v1/EMR/FetchRadiologyDetails', { body: { mrno: file } });
    if (!r || (r.status && r.status >= 400) || r.json == null) return 0;
    const orders = r.json.data || [];
    const match = wantBillNo ? orders.find((o) => String(o.billNo) === String(wantBillNo)) : orders[0];
    const sid = Number((match || {}).siteId);
    return Number.isFinite(sid) && sid > 0 ? sid : 0;
  } catch (e) { return 0; }
}

// FetchRadiologyDetails stamps each order with the patient's REGISTRATION site (e.g.
// N1 - Almalqa), NOT the branch the order was actually placed at (e.g. NEST 3). The
// result-entry RadiologySearch IS properly per-site — exactly like the live worklist —
// so the site whose search returns an order's bill is where it was truly ordered.
// Query every site for THIS patient (pending + resulted) and map billNo -> true site.
// Best-effort: a site that fails is skipped, and orders we can't place keep their
// original site, so this can never regress below today's behaviour.
async function discoverOrderSites(file, candidateSites) {
  const out = new Map();   // String(billNo) -> { siteId, site }
  try {
    await getToken();
    const empId = currentEmpId();
    if (!empId) return out;
    const siteList = await getSites().catch(() => []);
    const nameOf = new Map(siteList.map((s) => [s.siteId, s.shortName]));
    // Scan ONLY the branches worth checking. The patient's own orders already name
    // their site (FetchRadiologyDetails), so the caller passes those + the result
    // site — turning a ~14-branch fan-out (28 HIS calls) into ~2-4. This is the main
    // reason the patient card was slow; restricting it also cuts the timeouts that
    // left the clinical indication blank.
    const wanted = Array.isArray(candidateSites) && candidateSites.length
      ? [...new Set(candidateSites.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
      : (siteList.length ? siteList.map((s) => s.siteId) : [RESULT_SITE]);
    const sites = wanted;
    await pool(sites, STATS_SITE_CONCURRENCY, async (site) => {
      // filterResult 0 = still pending; the resulted-list shape (2 / selectionType 2 /
      // isFrequent 1) covers already-reported orders — query both so done exams place too.
      const variants = [{ filterResult: '0' }, { filterResult: '2', selectionType: 2, isFrequent: 1 }];
      for (const v of variants) {
        try {
          const sr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', {
            body: results.radiologySearchBody({ mrno: file, hospitalId: site, empId, ...v }),
          });
          for (const r of ((sr.json && sr.json.data) || [])) {
            const b = r.billNo != null ? String(r.billNo) : '';
            if (b && !out.has(b)) out.set(b, { siteId: site, site: nameOf.get(site) || `Branch ${site}` });
          }
        } catch (e) { /* skip this site/variant */ }
      }
    });
  } catch (e) { /* best-effort — callers fall back to the registration site */ }
  return out;
}

// Siratech's EMR forward view of a patient's radiology — the endpoint that actually
// carries the DICOM ACCESSION + pacsId + cpacsUrl + real reportDate (found by live probe).
// These populate once Siratech's cPACS integration is enabled (pacsType); until then the
// accession is empty and the matcher falls back to fuzzy matching — this just makes the
// link EXACT the moment the accession is available, with zero code change. Keyed by
// invPatTestResultId (clean 1:1 with the result-entry test rows) + a billNo|service key.
const _emrCache = new Map();   // mrno -> { ts, map } : short-TTL so the worklist pass reuses it
const EMR_TTL_MS = Number(process.env.EMR_TTL_MS || 60000);
async function emrRadiologyDetails(mrno, site, opts = {}) {
  if (!opts.noCache) { const e = _emrCache.get(String(mrno)); if (e && Date.now() - e.ts < EMR_TTL_MS) return e.map; }
  const map = new Map();
  try {
    // Use the PROVEN minimal body ({mrno}) — the same call discoverOrderSite relies on,
    // which is known to return every radiology order for the patient (with siteId,
    // accessionNumber, pacsId, cpacsUrl). Adding date/site filters here risked
    // over-filtering the rows; the accession lookup wants ALL the patient's orders.
    const r = await hisFetch('/emr-api/api/v1/EMR/FetchRadiologyDetails', { body: { mrno } });
    for (const d of ((r.json && r.json.data) || [])) {
      const nz = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
      const rec = {
        accession: nz(d.accessionNumber), pacsId: nz(d.pacsId), cpacsUrl: nz(d.cpacsUrl),
        reportDate: d.reportDate || null, reportPath: nz(d.reportPath), modality: nz(d.modality),
        reportStatus: nz(d.radioReportStatus) || nz(d.cpoeStatusDescription),
        imageStatus: nz(d.imageStatus) || nz(d.radioImageStatus),
        hasReport: !!d.hasRadiologyRepot, billNo: nz(d.billNo), serviceName: nz(d.serviceName),
      };
      if (d.invPatTestResultId != null) map.set(String(d.invPatTestResultId), rec);
      if (rec.billNo && rec.serviceName) map.set('bs:' + rec.billNo + '|' + rec.serviceName.toLowerCase(), rec);
      if (rec.billNo) { const bk = 'bill:' + rec.billNo; if (!map.has(bk)) map.set(bk, []); map.get(bk).push(rec); }
    }
  } catch (e) { /* best-effort enrichment — never blocks matching */ }
  _emrCache.set(String(mrno), { ts: Date.now(), map });
  if (_emrCache.size > 800) _emrCache.delete(_emrCache.keys().next().value);
  return map;
}
// Best accession for a worklist row (billNo + exam name) from the EMR map.
function emrAccessionForRow(emrMap, billNo, exam) {
  if (!emrMap || billNo == null) return null;
  const onBill = emrMap.get('bill:' + billNo);
  if (!Array.isArray(onBill) || !onBill.length) return null;
  const ex = String(exam || '').toLowerCase();
  const rec = (onBill.length === 1 ? onBill[0]
    : onBill.find((r) => (r.serviceName || '').toLowerCase() === ex)
      || onBill.find((r) => results.normMod(r.modality || r.serviceName || '') === results.normMod(exam || ''))
      || onBill[0]);
  return rec ? { accession: rec.accession || null, pacsId: rec.pacsId || null, cpacsUrl: rec.cpacsUrl || null } : null;
}
function emrLookup(emrMap, t, row) {
  if (!emrMap) return null;
  if (t && t.invPatTestResultId != null && emrMap.has(String(t.invPatTestResultId))) return emrMap.get(String(t.invPatTestResultId));
  const svc = (t && t.serviceName ? String(t.serviceName).toLowerCase() : null);
  if (row && row.billNo != null && svc) return emrMap.get('bs:' + String(row.billNo) + '|' + svc) || null;
  return null;
}

async function buildMatch(file, wantBillNo, site) {
  await getToken();                                    // ensure logged in (empId)
  const empId = currentEmpId();
  if (!empId) throw new Error('no empId (not logged in?)');
  // A patient's orders live at THEIR branch, not a fixed one — the result-entry
  // worklist is per-site. Use the site when pinned, else auto-discover it from the
  // site-agnostic order list so a caller that doesn't know the branch still matches.
  const useSite = Number(site) > 0 ? Number(site) : (await discoverOrderSite(file, wantBillNo)) || RESULT_SITE;

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
  // Compare bill numbers as STRINGS — the search row's billNo may be numeric while the
  // caller passes a string (or vice-versa); a strict === would then silently drop the
  // order and report "no matching order" for a patient who has one.
  const orderRows = wantBillNo ? rows.filter((r) => String(r.billNo) === String(wantBillNo)) : rows;

  // 2) the patient's VERIFIED DePACS studies (once)
  const studies = await results.depacsStudies(file);
  // 2b) the EMR forward view once — for the accession + pacs link per test (when enabled)
  const emrMap = await emrRadiologyDetails(file, useSite);

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
      const emr = emrLookup(emrMap, t, row);
      const test = {
        serviceName: t.serviceName || null, categoryName: t.categoryName || null,
        invPatTestResultId: t.invPatTestResultId,
        // EMR accession (Siratech's own DICOM key) wins when present; else the fuzzy fallback.
        accession: (emr && emr.accession) || pickAccession(t, row), orderDate,
        invMastServiceId: t.inv_mast_service_id, orderId: t.emR_PAT_DTLS_INV_ORDER_ID || null,
        pacsId: emr && emr.pacsId || null, cpacsUrl: emr && emr.cpacsUrl || null,
        emrReportDate: emr && emr.reportDate || null,
      };
      const m = results.matchStudy({ mrno: row.mrno, serviceName: test.serviceName, categoryName: test.categoryName, orderDate, accession: test.accession }, studies);
      let report = null;
      if (m.decision === 'unique') {
        const rep = await results.depacsReport(m.study.studyId);
        report = { studyId: m.study.studyId, desc: m.study.desc, studyDate: m.study.studyDate,
          reviewer: rep.reviewer, reportDate: rep.reportDate, pdfOk: rep.pdfOk, pdfBytes: rep.pdfBytes,
          preview: rep.reportText.slice(0, 600) };
      }
      tests.push({ test, decision: m.decision, matchKey: m.key, reason: m.reason, orderAccession: test.accession || null,
        accessionSource: (test.accession && emr && emr.accession === test.accession) ? 'siratech' : (test.accession ? 'row' : null),
        pacsId: test.pacsId, cpacsUrl: test.cpacsUrl, emrReportDate: test.emrReportDate,
        rawAcc: { detail: _accDbg(t), order: _accDbg(row) },
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

  // ── Sibling-study de-dup ─────────────────────────────────────────────────────
  // Two tests on the same bill must NEVER both resolve to the SAME DePACS study —
  // the body-part gate is a subset match, so a single terse study ("XR SHOULDER")
  // can legitimately match two overlapping tests ("XR SHOULDER" + "XR SHOULDER 3
  // VIEWS"). Filing both would attach ONE report PDF to two result rows — the exact
  // wrong-outcome this module exists to prevent. If a study is claimed by more than
  // one unique-matched test (across the whole file), demote ALL claimants to manual
  // review so neither auto-files; a human then decides which test the report belongs to.
  const studyClaims = new Map();
  for (const o of out) for (const t of o.tests) {
    if (t.decision === 'unique' && t.study && t.study.studyId != null) {
      const k = String(t.study.studyId);
      studyClaims.set(k, (studyClaims.get(k) || 0) + 1);
    }
  }
  for (const o of out) {
    for (const t of o.tests) {
      if (t.decision === 'unique' && t.study && studyClaims.get(String(t.study.studyId)) > 1) {
        t.decision = 'ambiguous';
        t.matchKey = 'sibling-conflict';
        t.reason = `study #${t.study.studyId} also matched another exam on this file — refusing to file the same report to two results; review manually`;
        t.report = null;
      }
    }
    o.allUnique = o.tests.length > 0 && o.tests.every((t) => t.decision === 'unique');
  }
  // TEMP DEBUG: the FULL set of DePACS studies pulled for this MRN, pre-filter, so
  // the UI can show WHY a study was excluded from candidates (wrong status / MRN /
  // simply absent). This is what distinguishes "matcher too strict" from "study not
  // there / registered under a different pat_id". Read-only; drop once the reverse
  // flow is proven in the field.
  const allStudies = studies.map((s) => ({
    studyId: s.studyId, desc: s.desc, modality: s.modality, status: s.status,
    accession: s.accession, studyDate: s.studyDate, patId: s.patId,
  }));
  return { file, empId, site: useSite, studiesFound: studies.length, orders: out, count: out.length, allStudies };
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

// ── RIS worklist ──────────────────────────────────────────────────────────────
// The live radiology worklist: every order AWAITING a result (RadiologySearch,
// filterResult=0) across the requested branches, sorted emergency-first then
// oldest-first, with a turnaround (TAT) age in hours. Optionally (?ready=1) the top
// N distinct patients are matched against DePACS so the board flags which orders
// already have a VERIFIED report ready to file. READ-ONLY.
const WORKLIST_CACHE_TTL = Number(process.env.WORKLIST_CACHE_TTL_MS || 60000);
// The FAST pass (no ready/modality) is light — one RadiologySearch + one FetchRISPanel
// per site — so it can refresh far more often to make the board feel live, without
// touching the heavy per-patient DePACS pass (which keeps the 60s TTL above). HIS load
// from the fast pass is bounded by this TTL, NOT by the number of open boards, because
// every viewer shares the one cached fetch per window.
const WORKLIST_FAST_CACHE_TTL = Number(process.env.WORKLIST_FAST_CACHE_TTL_MS || 12000);
const worklistCache = new Map();

// Cap on how many worklist rows we enrich with real modality per request. The
// modality isn't on the RadiologySearch row (departmentName is the ordering clinic,
// not the imaging modality), so each needs a RadiologyDetails call — bounded and
// concurrent so the board stays fast. Emergency-first sort means the ones that
// matter most are enriched first.
const WORKLIST_MODALITY_CAP = Number(process.env.WORKLIST_MODALITY_CAP || 80);
// Opt-in payment enrichment reads one bill per order (GetDueBillDetailsByID) to see
// the patient's outstanding portion. Bounded so a wide board can't stall; today's
// per-branch pending count is well under this.
const WORKLIST_PAY_CAP = Number(process.env.WORKLIST_PAY_CAP || 400);
// Default look-back window for the live board. A radiology worklist is an operational
// "what's pending now" view, not an archive — 14 days across 14 branches returns
// hundreds of stale orders and is slow. 3 days is the right operational default;
// widen per-request with ?from=/?to= or globally via WORKLIST_DAYS_BACK.
const WORKLIST_DAYS_BACK = Number(process.env.WORKLIST_DAYS_BACK || 3);
// Per-mrno native radiology status cache (cpoeStatusDescription etc.) — keeps the
// board's per-exam status fresh without re-hitting FetchRadiologyDetails every load.
const RAD_STATUS_TTL = Number(process.env.RAD_STATUS_TTL_MS || 90000);
// Cap on new per-mrno status lookups per load. It MUST exceed the distinct-patient
// count of the whole board, or the rows past the cap get no hisStatus and fall into
// "Waiting" until a later refresh covers them — the "everyone starts in Waiting then
// jumps to their lane" glitch. Adding N3 pushed the board over the old 220, so it
// resurfaced; 400 gives headroom (lookups are 90s-cached + concurrency-bounded, so a
// full cold sweep is paid once per window, then instant).
const RAD_STATUS_MAX_FETCH = Number(process.env.RAD_STATUS_MAX_FETCH || 400);   // cap new lookups per load
const radStatusCache = new Map();   // mrno -> { ts, byKey: Map(key -> {status,cpoe,reported,imaged,invId,acc}) }
// MRNs whose per-mrno status lookup is currently in flight. On a cold open the fast pass
// kicks this sweep in the BACKGROUND (see buildWorklist), so two overlapping fast builds
// must not both fire FetchRadiologyDetails for the same patient — this de-dupes them.
const _radStatusInflight = new Set();

// HIS timestamps come as NAIVE local KSA strings ("2026-07-05T09:06:00", no offset).
// Date.parse would read that as UTC (the VPS's zone), skewing every age by 3h and
// misplacing rows across midnight — so parse with an explicit +03:00 unless the
// string already carries an offset.
function parseHisDate(s) {
  if (!s) return NaN;
  const str = String(s).trim().replace(' ', 'T');
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(str) ? str : str + '+03:00');
}

async function buildWorklist({ sites, from, to, ready = false, readyLimit = 25, modality = false, pay = false, noCache = false }) {
  const key = JSON.stringify({ sites: (sites || []).slice().sort((a, b) => a - b), from, to, ready, readyLimit, modality, pay });
  // Fast board pass refreshes on the short TTL; the heavy ready/modality pass keeps the
  // long TTL so DePACS/per-order load is unchanged.
  const ttl = (ready || modality) ? WORKLIST_CACHE_TTL : WORKLIST_FAST_CACHE_TTL;
  if (!noCache) { const e = worklistCache.get(key); if (e && Date.now() - e.ts < ttl) return e.data; }
  await getToken();
  const empId = currentEmpId() || '0';
  const now = Date.now();
  const today = new Date();
  const def = (d, end) => `${d.toISOString().slice(0, 10)}T${end ? '23:59:59' : '00:00:00'}.000Z`;
  // An explicit from/to is a KSA CALENDAR day (the operator's day picker). The HIS
  // window is UTC, so convert the KSA day to the correct UTC instant (KSA = +03:00)
  // — otherwise orders placed 00:00–02:59 KSA fall on the previous UTC day and vanish
  // from the board (and their emergency chime never fires).
  const ksaDayToUtc = (dateStr, end) => new Date(`${dateStr}T${end ? '23:59:59' : '00:00:00'}.000+03:00`).toISOString();
  const fromISO = from ? ksaDayToUtc(from, false) : def(new Date(today.getTime() - WORKLIST_DAYS_BACK * 864e5), false);
  const toISO = to ? ksaDayToUtc(to, true) : def(new Date(today.getTime() + 864e5), true);   // +1d covers KSA/UTC skew
  const siteList = await getSites().catch(() => []);
  const nameOf = new Map(siteList.map((s) => [s.siteId, s.shortName]));
  const wantSites = (sites && sites.length) ? sites : (siteList.length ? siteList.map((s) => s.siteId) : STATS_SITES);
  const branchLabel = (site) => nameOf.get(site) || `Branch ${site}`;

  const perSite = await pool(wantSites, STATS_SITE_CONCURRENCY, async (site) => {
    try {
      const sr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', {
        body: results.radiologySearchBody({ mrno: '', hospitalId: site, empId, filterResult: '0', fromDate: fromISO, toDate: toISO }),
      });
      if (!sr || (sr.status && sr.status >= 400) || sr.json == null) return { site, ok: false, rows: [] };
      return { site, ok: true, rows: (sr.json.data || []) };
    } catch (e) { return { site, ok: false, rows: [] }; }
  });

  const items = [], failed = [];
  for (const s of perSite) {
    if (!s) continue;
    if (!s.ok) { failed.push(s.site); continue; }
    for (const r of s.rows) {
      const t = parseHisDate(r.billDate || r.visitDate || '');
      const ageHours = Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 36e5)) : null;
      const emergency = Number(r.isEmergency) === 1 || Number(r.priorityStat) > 0;
      items.push({
        site: s.site, branch: branchLabel(s.site),
        mrno: String(r.mrno || ''), patientName: (r.patientName || '').trim(),
        age: r.age, gender: r.gender,
        doctorName: (r.doctorName || '').trim(), department: (r.departmentName || '').trim(),
        emergency, priority: emergency ? 'Emergency' : 'Routine',
        billNo: r.billNo || null, genPatBillingId: r.genPatBillingId,
        orderedDate: r.billDate || r.visitDate || null, ageHours, tatStatus: r.tatStatus,
        modality: null,      // filled below only when modality=1
        exam: null,          // the requested procedure(s) — body part, filled with modality=1
        readyToFile: null,   // filled below only when ready=1
        stage: null,         // ordered | imaged | reported — pipeline stage, filled when ready=1
        __row: r, __site: s.site,   // kept for enrichment; stripped before return
      });
    }
  }
  items.sort((a, b) => (Number(b.emergency) - Number(a.emergency)) || ((b.ageHours || 0) - (a.ageHours || 0)));

  // ── Exam + modality the RIS-panel way (fast, ALL rows, one call per site) ──────
  // Siratech's own RIS panel (FetchRISPanel) returns the Service (exam) for EVERY
  // order in a SINGLE call per site — which is why it's instant. We do the same:
  // one FetchRISPanel per site, map billNo → service, and derive modality from the
  // service name. This fills exam+modality for the WHOLE board up front, replacing
  // the slow, capped per-order RadiologyDetails fan-out. Runs on every load (incl.
  // the fast one) so the exam column is populated immediately, like the RIS panel.
  const risFromDay = (from || fromISO.slice(0, 10));
  const risToDay = (to || toISO.slice(0, 10));
  const risServiceOf = (row) => {
    for (const k of ['serviceName', 'service', 'invMastServiceName', 'serviceDescription',
                     'invMastServiceDesc', 'serviceDesc', 'testName', 'procedureName',
                     'invServiceName', 'invmastServiceName', 'ServiceName']) {
      const v = row && row[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };
  const risStatusOf = (row) => {
    for (const k of ['cpoeStatusDescription', 'cpoeStatus', 'risOrderStatus', 'resultStatus',
                     'risStatus', 'radiologyStatus', 'orderStatus', 'statusDescription', 'status']) {
      const v = row && row[k];
      if (v != null && String(v).trim() !== '' && !/^\d+$/.test(String(v).trim())) return String(v).trim();
    }
    return '';
  };
  // Map the HIS's RIS status text → our 3 pipeline stages, for a FAST preliminary
  // stage (the accurate, PACS-grounded stage still refines the top rows below when
  // ready=1). Conservative: only a clearly-final status counts as "report ready".
  const risStageOf = (status) => {
    const s = String(status || '').toLowerCase();
    if (!s) return null;
    // Negation/pending FIRST — "not verified", "to be signed", "pending approval",
    // "un-verified" all carry a positive token but are NOT a signed report. Without
    // this they wrongly read as 'reported' (same lesson as isReported in results.js).
    if (/\bnot\b|\bnon[\s-]?|to\s+be|\bawait|\bun[\s-]?(verif|sign|approv)/.test(s)) {
      // a negated report state that still implies a report exists → draft, else ordered
      return /(verif|sign|approv|report|dictat|transcrib)/.test(s) ? 'draft' : 'ordered';
    }
    // a report exists but isn't signed → draft (dictated / transcribed / preliminary / pending approval)
    if (/dictat|transcrib|prelim|\bdraft\b|partial|interim|\bpend/.test(s)) return 'draft';
    if (/\b(verif|report|sign|approv|final|released|authenticat)/.test(s)) return 'reported';
    if (/(complet|perform|imag|acquir|scan|exam)/.test(s)) return 'imaged';
    return 'ordered';   // ordered / scheduled / registered / arrived / booked
  };
  let _risKeysLogged = false;   // one-time: reveal real field names if a guess misses
  const risByBill = new Map();
  const _risStatuses = new Set();
  await pool(wantSites, STATS_SITE_CONCURRENCY, async (site) => {
    try {
      const rp = await hisFetch('/emr-api/api/v1/EMR/FetchRISPanel', { body: {
        mrno: '', fromDate: risFromDay + 'T00:00:00', toDate: risToDay + 'T23:59:59',
        invMastServiceId: 0, apptResourceCategoryId: 0, apptResourceId: 0, providerId: '',
        serviceCategoryId: 0, emrPatRisPanelId: 0,
        userId: String(HIS_USER).padStart(8, '0'), hospitalId: site,
      } });
      const rows = (rp.json && rp.json.data) || [];
      if (!_risKeysLogged && rows.length) { _risKeysLogged = true; console.log('[worklist] FetchRISPanel row keys:', Object.keys(rows[0]).join(',')); }
      for (const row of rows) {
        if (row.billNo == null) continue;
        const st = risStatusOf(row);
        if (st) _risStatuses.add(st);
        // ONE ENTRY PER SERVICE — a bill can bundle several exams (US Pelvis + US
        // Abdomen on one bill) and Siratech's RIS panel shows a row per exam; a
        // last-wins map was collapsing them into a single mislabelled row.
        const list = risByBill.get(String(row.billNo)) || [];
        list.push({
          svc: risServiceOf(row), status: st,
          svcId: row.invMastServiceId != null ? row.invMastServiceId : null,
          billDate: row.billDate || row.appoinmentDate || null,
          encounterER: String(row.encounter || '').trim().toUpperCase() === 'ER',
          // Siratech's OWN patient-tracking timestamps (discovered in FetchRISPanel):
          // arrival → exam start → exam end. examStart/examEnd are a HARD "the scan
          // physically happened" signal — instant imaged status straight from the HIS,
          // no DePACS/MPPS needed. Empty when the workflow isn't recorded (harmless).
          examStart: row.examStartDate || null,
          examEnd: row.examEndDate || null,
          arrival: row.arrivalDate || null,
          // Native report-ready signal straight from Siratech's RIS panel (no DePACS):
          // a report/verified status text, or an explicit report flag on the row.
          reported: /(verif|report|sign|approv|final|released|authenticat)/i.test(st)
            || Number(row.radioReportStatus) > 0 || !!row.hasRadiologyRepot || Number(row.reportStatus) > 0,
        });
        risByBill.set(String(row.billNo), list);
      }
    } catch (e) { /* fall back to the per-order RadiologyDetails pass below */ }
  });
  if (_risStatuses.size) console.log('[worklist] distinct risOrderStatus:', [..._risStatuses].join(' | '));
  // Expand each bill-level row into ONE ROW PER EXAM (RIS-panel parity), stamping the
  // per-exam service, modality, preliminary stage, the bill's real order time (the
  // HIS's search rows sometimes carry the VISIT time instead — that's why a fresh
  // order could show "5h ago"), and the ER-encounter emergency flag.
  let risFilled = 0;
  const expanded = [];
  for (const it of items) {
    const list = risByBill.get(String(it.billNo));
    if (!list || !list.length) { expanded.push(it); continue; }
    const er = list.some((e) => e.encounterER);
    list.forEach((e, idx) => {
      const row = idx === 0 ? it : { ...it };
      if (e.svc) { row.exam = e.svc; row.modality = results.normMod(e.svc) || null; risFilled++; }
      row.svcId = e.svcId; row.svcSeq = idx;
      const st = risStageOf(e.status);
      if (st) row.stage = st;   // fast preliminary stage; refined by the DePACS check below
      // Hard scan signal from Siratech's own exam timestamps (authoritative, unlike the
      // status TEXT): once the tech records exam start/end, the study exists — mark the
      // row imaged instantly (the client trusts `scanned` even before the DePACS pass).
      row.scanned = !!(e.examEnd || e.examStart);
      row.examStartAt = e.examStart || null;
      row.examEndAt = e.examEnd || null;
      row.arrivedAt = e.arrival || null;
      // Native Siratech workflow status text (Pending / Scan In Progress / Scan Done…)
      // + native report-ready flag — these drive the board's stage lanes directly.
      row.hisStatus = e.status || null;
      row.hisReported = !!e.reported;
      if (e.billDate) {
        row.orderedDate = e.billDate;
        const bt = parseHisDate(e.billDate);
        if (Number.isFinite(bt)) row.ageHours = Math.max(0, Math.round((now - bt) / 36e5));
      }
      if (er) { row.emergency = true; row.priority = 'Emergency'; }
      expanded.push(row);
    });
  }
  items.length = 0; items.push(...expanded);
  // Honour the requested KSA day range strictly (RIS-panel parity): the HIS's
  // pending-orders search returns EVERY still-pending order regardless of the date
  // window we pass it, so "Today" was still showing yesterday's leftovers. A row
  // whose bill day can't be parsed is KEPT — never hide work on a parse failure.
  const fromDay = from || new Date(Date.parse(fromISO) + 3 * 36e5).toISOString().slice(0, 10);
  const toDay = to || new Date(Date.parse(toISO) + 3 * 36e5).toISOString().slice(0, 10);
  const inRange = (it) => {
    const t = parseHisDate(it.orderedDate);
    if (!Number.isFinite(t)) return true;
    const day = new Date(t + 3 * 36e5).toISOString().slice(0, 10);   // KSA calendar day
    return day >= fromDay && day <= toDay;
  };
  const kept = items.filter(inRange);
  items.length = 0; items.push(...kept);
  // Re-sort AFTER expansion: the ER-encounter flag and the per-bill order time were
  // applied during expansion, so the emergency-first / oldest-first order computed
  // before expansion is now stale (a fresh ER row could otherwise sit mid-list).
  // Must match the documented invariant (oldest-first = highest TAT first) that the
  // board and the auto-file candidate sweep both rely on: descending ageHours.
  items.sort((a, b) => (Number(b.emergency) - Number(a.emergency)) || ((b.ageHours || 0) - (a.ageHours || 0)));

  // ── Native per-exam status (cpoeStatusDescription: Pending / Scan In Progress /
  // Scan Done + the report flag) — the ONLY source of Siratech's real status text.
  // Fetched per DISTINCT mrno (cached ~90s, concurrency-bounded), stamped onto every
  // row so the board's stage lanes are correct with NO DePACS wait. Best-effort: an
  // unresolved row keeps its coarse lane and fills on the next refresh.
  //
  // FIRST-OPEN COST: on a cold open radStatusCache is empty, so this sweep is up to
  // RAD_STATUS_MAX_FETCH FetchRadiologyDetails calls. Awaiting it BLOCKED the very first
  // paint for ~10-20s — the "heavy on first open" symptom. So on the FAST pass we do NOT
  // block on the fetch: rows already carry a preliminary status from the RIS panel
  // (hisStatus, set during expansion above), so lanes are placed immediately, and this
  // sweep runs in the BACKGROUND to warm radStatusCache — the exact cpoe refinement then
  // lands on the next refresh (~12s) instead of holding up the first board. The heavy
  // ready/modality passes (already throttled + 60s-cached, never on the first-paint path)
  // still AWAIT it so their response carries the refined status.
  try {
    const keyOf = (bill, svc) => `${bill || ''}|${String(svc || '').trim().toLowerCase()}`;
    const mrnos = [...new Set(items.map((it) => String(it.mrno)).filter(Boolean))];
    const nowTs = Date.now();
    const fresh = (m) => { const c = radStatusCache.get(m); return c && (nowTs - c.ts) <= RAD_STATUS_TTL; };
    // "LIKE SIRATECH": FetchRISPanel already returns a PER-EXAM status for every order in
    // ONE bulk call per site (that's why Siratech's own panel is instant), and the
    // expansion above stamps it on each row as hisStatus. So on the FAST board we only fall
    // back to the per-patient FetchRadiologyDetails for rows the panel left WITHOUT a status
    // — usually none — instead of fanning out across every patient. The heavy ready/modality
    // passes still refine EVERY row (exact per-exam accession/invId matching). This is the
    // change that removes the "loading a lot / hanging" on the fast board: no per-patient
    // HIS fan-out when the panel already covered the board.
    const heavyPass = ready || modality;
    const uncovered = new Set(items.filter((it) => !it.hisStatus).map((it) => String(it.mrno)).filter(Boolean));
    const candidates = heavyPass ? mrnos : mrnos.filter((m) => uncovered.has(m));
    const need = candidates.filter((m) => !fresh(m)).slice(0, RAD_STATUS_MAX_FETCH);
    const fetchOne = async (m) => {
      // Re-check freshness/in-flight at call time: a concurrent (possibly background)
      // sweep may have already filled this MRN, so we never double-hit the HIS for it.
      if (fresh(m) || _radStatusInflight.has(m)) return;
      _radStatusInflight.add(m);
      try {
        const r = await hisFetch('/emr-api/api/v1/EMR/FetchRadiologyDetails', { body: { mrno: m } });
        const rows = (r.json && r.json.data) || [];
        const byKey = new Map();
        for (const d of rows) {
          const rec = {
            status: d.cpoeStatusDescription || null, cpoe: d.cpoeStatus,
            reported: !!(Number(d.radioReportStatus) > 0 || d.hasRadiologyRepot),
            imaged: Number(d.radioImageStatus) > 0,
            invId: d.invPatTestResultId || null, acc: d.accessionNumber || null,
          };
          if (!byKey.has(keyOf(d.billNo, d.serviceName))) byKey.set(keyOf(d.billNo, d.serviceName), rec);
          if (d.accessionNumber) byKey.set('acc:' + d.accessionNumber, rec);
          // bill-level fallback for rows whose exam name didn't enrich (so they still
          // land in the right lane). Prefer the most-advanced status on the bill so a
          // mixed bill doesn't get pinned to its least-done exam.
          const bk = 'bill:' + (d.billNo || '');
          const rank = (x) => (x && x.reported ? 3 : /scan done/i.test(x && x.status || '') ? 2 : /in progress/i.test(x && x.status || '') ? 1 : 0);
          if (!byKey.has(bk) || rank(rec) > rank(byKey.get(bk))) byKey.set(bk, rec);
        }
        radStatusCache.set(m, { ts: Date.now(), byKey });
      } catch (_e) { /* leave uncached — row keeps its coarse lane */ }
      finally { _radStatusInflight.delete(m); }
    };
    const sweep = pool(need, STATS_SITE_CONCURRENCY, fetchOne);
    // Heavy pass → block so the response carries refined status; fast pass → warm the
    // cache in the background so the first paint isn't held up by the per-mrno fan-out.
    if (ready || modality) await sweep;
    else sweep.catch(() => {});
    for (const it of items) {
      const c = radStatusCache.get(String(it.mrno));
      if (!c) continue;
      // EXACT per-exam match (accession or bill+exam-name) vs the bill-level fallback.
      const exact = (it.accession && c.byKey.get('acc:' + it.accession)) || c.byKey.get(keyOf(it.billNo, it.exam));
      const rec = exact || c.byKey.get('bill:' + (it.billNo || ''));
      if (!rec) continue;
      if (rec.status) it.hisStatus = rec.status;   // display status: exact or bill-level is fine
      it.hisCpoe = rec.cpoe != null ? rec.cpoe : it.hisCpoe;
      // The report flag + per-exam identity come ONLY from an exact match — never the
      // bill-level fallback, which on a multi-exam bill could inherit a sibling exam's
      // report and mislabel this row's lane (works-verifier finding #1/#2).
      if (exact) {
        it.hisReported = it.hisReported || exact.reported;
        if (exact.imaged && !it.scanned) it.scanned = true;
        if (exact.invId && !it.invPatTestResultId) it.invPatTestResultId = exact.invId;
        if (exact.acc && !it.accession) it.accession = exact.acc;
      }
    }
  } catch (_e) { /* status enrichment is best-effort */ }

  // Fallback: any rows the RIS panel didn't cover (or if the service field guess
  // missed) get the old per-order RadiologyDetails lookup — bounded and concurrent —
  // only requested when modality=1, and only for rows still missing an exam.
  if (modality && items.length) {
    // Fetch RadiologyDetails ONCE per bill (not per expanded row), then give EACH
    // expanded sibling ITS OWN exam by service id — the old code joined every exam on
    // the bill onto each sibling, producing duplicate identical rows with a corrupted
    // "A · B" modality string.
    const need = items.filter((it) => !it.exam);
    const byBill = new Map();
    for (const it of need) if (it.__row && !byBill.has(String(it.billNo))) byBill.set(String(it.billNo), it);
    const svcId = (t) => (t && (t.inv_mast_service_id != null ? t.inv_mast_service_id : t.invMastserviceId));
    const detByBill = new Map();
    await pool([...byBill.values()].slice(0, WORKLIST_MODALITY_CAP), 6, async (it) => {
      try {
        const dr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologyDetails', {
          body: results.radiologyDetailsBody(it.__row, { hospitalId: it.__site, empId }),
        });
        detByBill.set(String(it.billNo), (dr.json && dr.json.data) || []);
      } catch (e) { /* leave this bill's rows as-is */ }
    });
    for (const it of need) {
      const det = detByBill.get(String(it.billNo));
      if (!det || !det.length) continue;
      // pick THIS row's test by service id when we have one; else the bill's single test.
      const t = (it.svcId != null && det.find((x) => String(svcId(x)) === String(it.svcId)))
        || (det.length === 1 ? det[0] : null);
      if (!t) continue;
      const ex = (t.serviceName || '').trim();
      const m = results.normMod(t.categoryName || t.serviceName || '');
      if (ex) it.exam = ex;
      if (m) it.modality = m;
    }
  }

  if (ready && items.length) {
    // Pipeline stage PER ROW for the WHOLE board, grounded in DePACS reality:
    //   ordered  — no study of this exam's modality in PACS (whatever the HIS claims)
    //   imaged   — images exist, nothing written yet
    //   draft    — a report EXISTS but is not verified (dictated / to-be-verified)
    //   reported — a verified report exists
    // One LIGHT DePACS lookup per patient (status+modality+date only — no per-study
    // report-info round-trips), so covering every row costs a fraction of the old
    // capped 25-patient pass. G7 guard: only studies from this order's own time
    // window count — an old same-modality study must not flip a fresh order.
    const mrns = [...new Set(items.map((it) => it.mrno).filter(Boolean))];
    const studiesBy = new Map();
    // light + short-TTL cached (see depacsStudies): the board re-checks every patient
    // on each refresh, so caching the recent-window lookup is what kills the lag. A
    // manual force-refresh (noCache) bypasses the cache for truly-fresh status. ONE
    // lookup per patient — no extra EMR round-trip (the matched study already carries
    // the accession we display, so a second per-patient HIS call would just re-add lag).
    await pool(mrns, 8, async (m) => {
      try { studiesBy.set(m, await results.depacsStudies(m, { light: true, noCache })); } catch (e) { /* leave unknown */ }
    });
    const KNOWN_MOD = new Set(['CT', 'MR', 'US', 'XR', 'MG']);
    for (const it of items) {
      if (!studiesBy.has(it.mrno)) continue;         // DePACS lookup failed → keep preliminary stage
      // MRN GATE: DePACS matches patient_id as a SUBSTRING, so the raw result can include
      // OTHER patients' studies. Filter to THIS file only, or another patient's reported
      // study could flip this row's stage (cross-patient contamination of the board).
      const all = (studiesBy.get(it.mrno) || []).filter((s) => results.sameMrn(s.patId, it.mrno));
      const mod = results.normMod(it.modality || it.exam || '');
      // normMod returns the RAW string when it can't classify — that would never equal a
      // study's normalized modality and would force EVERY unmapped exam to 'ordered' even
      // when imaged. Only trust a match on a KNOWN modality; otherwise leave the stage.
      if (!KNOWN_MOD.has(mod)) continue;
      const ot = parseHisDate(it.orderedDate);
      const matched = all.filter((s) => {
        if (results.normMod(s.modality || '') !== mod) return false;
        if (!Number.isFinite(ot)) return true;
        const st = parseHisDate(s.studyDate);
        // within the order's window: from 24h before the order to 96h after (the same
        // bound the matcher uses) — an OLD or a much-later same-modality study can't
        // drive this order's stage.
        return Number.isFinite(st) ? (st >= ot - 24 * 36e5 && st <= ot + 96 * 36e5) : true;
      });
      if (!matched.length) { it.stage = 'ordered'; it.readyToFile = false; continue; }
      const reportedHit = matched.find((s) => results.isReported(s.status));
      const chosen = reportedHit || matched.find((s) => s.accession) || matched[0];
      // Surface the real DICOM accession from the matched study (cleaned in depacsStudies,
      // so body-part text is never shown as an accession).
      if (chosen && chosen.accession) { it.accession = chosen.accession; it.accessionSource = 'depacs'; }
      if (reportedHit) { it.stage = 'reported'; it.readyToFile = true; }
      else if (matched.some((s) => results.isDraftReport(s.status))) { it.stage = 'draft'; it.readyToFile = false; }
      else { it.stage = 'imaged'; it.readyToFile = false; }
    }
  }

  // ── Payment status (opt-in, pay=1) ────────────────────────────────────────────
  // Read each order's bill (GetDueBillDetailsByID, the DueSettlement report) and sum
  // the PATIENT portion across its radiology line items. patient > 0 means the patient
  // still owes for the imaging → the row is flagged so reception can collect. Bill-level
  // (stamped on every row of the bill), bounded + retrying, radiology-only (labs/drugs on
  // the same visit don't count). billItemKeys is echoed once as a diagnostic so the exact
  // outstanding-vs-responsibility field can be confirmed against the live payload.
  let billItemKeys = null, payDiagSample = null;
  if (pay && items.length) {
    const catalog = await getRadCatalog().catch(() => new Map());
    const byBill = new Map();
    for (const it of items) {
      const id = it.genPatBillingId;
      if (id != null && id !== '' && !byBill.has(String(id))) byBill.set(String(id), true);
    }
    const uniq = [...byBill.keys()].slice(0, WORKLIST_PAY_CAP);
    const dueByBill = new Map();
    await pool(uniq, STATS_MODALITY_CONCURRENCY, async (gpb) => {
      const res = await readBillItems(gpb);
      if (!billItemKeys && Array.isArray(res.items) && res.items.length) billItemKeys = Object.keys(res.items[0]);
      let due = 0, spo = 0, net = 0, radItems = 0, paidAny = false, dueSrc = null;
      for (const it of res.items) {
        if (!catalog.get(normName(it.itemName))) continue;   // radiology line items ONLY (labs on the same bill are ignored)
        radItems += 1;
        const od = linePatientDue(it);   // what the PATIENT still owes on THIS radiology line
        if (od.src && !dueSrc) dueSrc = od.src;
        if (od.paidSeen) paidAny = true;
        due += od.due;
        spo += Number(it.sponsor) || 0;
        net += Number(it.netAmount) || 0;
        // One redacted numeric sample of a radiology line — confirms which field is the
        // real "outstanding" vs "responsibility" against the live payload (no PHI: item
        // name + amounts only).
        if (!payDiagSample) { payDiagSample = {}; for (const [k, v] of Object.entries(it)) { if (typeof v === 'number' || (typeof v === 'string' && /amount|paid|due|balance|patient|sponsor|net|discount|receipt|settle|pending/i.test(k))) payDiagSample[k] = v; } payDiagSample.itemName = it.itemName; }
      }
      dueByBill.set(gpb, { due, spo, net, radItems, ok: res.ok, dueSrc, paidAny });
    });
    const r2 = (n) => Math.round(n * 100) / 100;
    for (const it of items) {
      const d = it.genPatBillingId != null ? dueByBill.get(String(it.genPatBillingId)) : null;
      // paymentKnown=false → the bill couldn't be read or carried no radiology line item;
      // the UI shows nothing (never a false "unpaid") in that case.
      if (!d || !d.ok || d.radItems === 0) { it.paymentKnown = false; continue; }
      it.paymentKnown = true;
      it.patientDue = r2(d.due);
      it.sponsorAmt = r2(d.spo);
      it.billed = r2(d.net);
      it.unpaid = d.due > 0;                        // patient still owes a portion ON THE RADIOLOGY
      it.dueSource = d.dueSrc || 'patientShare';    // which field the "owes" figure came from
      if (!it.payer) it.payer = d.spo > 0 ? (d.due > 0 ? 'Insurance + copay' : 'Insurance') : (d.due > 0 ? 'Cash / self-pay' : null);
    }
  }

  for (const it of items) { delete it.__row; delete it.__site; }   // strip enrichment scratch
  const data = {
    range: { from: fromISO.slice(0, 10), to: toISO.slice(0, 10) },
    sites: { requested: wantSites, failed },
    total: items.length, emergency: items.filter((i) => i.emergency).length,
    readyChecked: ready ? Math.min(readyLimit, new Set(items.map((i) => i.mrno)).size) : 0,
    modalityChecked: modality ? Math.min(WORKLIST_MODALITY_CAP, items.length) : 0,
    paymentChecked: pay ? Math.min(WORKLIST_PAY_CAP, new Set(items.map((i) => i.genPatBillingId).filter((x) => x != null)).size) : 0,
    billItemKeys,   // diagnostic: raw bill line-item field names (confirm the true "outstanding" field)
    payDiagSample,  // diagnostic: one radiology line's amount fields (redacted) to lock the unpaid rule
    items, generatedAt: new Date().toISOString(),
  };
  worklistCache.set(key, { data, ts: Date.now() });
  if (worklistCache.size > 40) worklistCache.delete(worklistCache.keys().next().value);
  return data;
}

app.get('/worklist', requireAuth, async (req, res) => {
  try {
    const sites = String(req.query.sites || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const from = String(req.query.from || '').trim() || null;
    const to = String(req.query.to || '').trim() || null;
    const ready = String(req.query.ready || '') === '1';
    const readyLimit = Math.max(1, Math.min(60, Number(req.query.readyLimit) || 25));
    const modality = String(req.query.modality || '') === '1';
    const pay = String(req.query.pay || '') === '1';
    const noCache = String(req.query.nocache || '') === '1';
    return res.json({ ok: true, ...(await buildWorklist({ sites, from, to, ready, readyLimit, modality, pay, noCache })) });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ── Awaiting-payment board: the doctor's PLACED radiology orders ───────────────
// Orders a doctor placed that HAVEN'T been performed yet never reach RadiologySearch
// (proved by /diag/order-trace), so the worklist can't show them. This board pulls them
// from the EMR order layer: get the branch's active patients (roster), fan out
// FetchEmrOrders per patient, and keep the radiology orders still pending (not performed).
// Bounded + cached (heavy — one HIS call per patient), so it's a SEPARATE on-demand board,
// never on the fast worklist path.
const AWP_TTL = Number(process.env.AWP_CACHE_TTL_MS || 300000);   // 5 min
const AWP_ROSTER_CAP = Number(process.env.AWP_ROSTER_CAP || 400);
const AWP_CONCURRENCY = Number(process.env.AWP_CONCURRENCY || 10);
const awpCache = new Map();
// Pull the branch's active-patient roster (mrno + name) from open encounters. Field names
// vary, so probe broadly; returns [] if the source is empty/unavailable (board just shows
// nothing rather than erroring).
async function awpRoster(site, empId, uid, fromISO, toISO) {
  const bodies = [
    { hospitalId: site, userId: uid, empId, fromDate: fromISO, toDate: toISO, mrno: '' },
    { hospitalId: site, userId: uid, empId, mrno: '' },
  ];
  for (const body of bodies) {
    const r = await hisFetch('/billing-api/api/v1/Encounter/PatientOpenEncounters', { method: 'POST', body }).catch(() => null);
    const rows = (r && r.json && (r.json.data || r.json.Data)) || (r && Array.isArray(r.json) ? r.json : null);
    if (Array.isArray(rows) && rows.length) {
      const out = [];
      for (const x of rows) {
        const mrno = x.mrno ?? x.mrNo ?? x.MRNO ?? x.mrNumber;
        if (mrno != null && String(mrno).trim()) out.push({ mrno: String(mrno).trim(), name: (x.patientName || x.patName || '').trim() });
      }
      if (out.length) return out;
    }
  }
  return [];
}
const awpIsRadPending = (o) => o && o.invMastServiceName && /radiolog/i.test(String(o.invCategoryName || ''))
  && String(o.adminStatus || '').toLowerCase() !== 'completed'
  && String(o.adminStatus || '').toLowerCase() !== 'performed';
async function radiologyAwaitingPayment({ sites, noCache = false }) {
  await getToken();
  const empId = currentEmpId() || '0';
  const uid = String(HIS_USER).padStart(8, '0');
  const siteList = await getSites().catch(() => []);
  const nameOf = new Map(siteList.map((s) => [s.siteId, s.shortName]));
  const wantSites = (sites && sites.length) ? sites : siteList.map((s) => s.siteId);
  const cacheKey = JSON.stringify(wantSites.slice().sort((a, b) => a - b));
  if (!noCache) { const c = awpCache.get(cacheKey); if (c && Date.now() - c.ts < AWP_TTL) return c.data; }
  const today = new Date();
  const toISO = `${today.toISOString().slice(0, 10)}T23:59:59.000Z`;
  const fromISO = `${new Date(today.getTime() - 30 * 864e5).toISOString().slice(0, 10)}T00:00:00.000Z`;
  const rosterDiag = [];
  const roster = new Map();   // mrno -> { site, name }
  for (const site of wantSites) {
    const r = await awpRoster(site, empId, uid, fromISO, toISO);
    rosterDiag.push({ site, count: r.length });
    for (const p of r) if (!roster.has(p.mrno)) roster.set(p.mrno, { site, name: p.name });
  }
  const rosterList = [...roster.entries()].slice(0, AWP_ROSTER_CAP);
  const items = [];
  await pool(rosterList, AWP_CONCURRENCY, async ([mrno, info]) => {
    const eo = await hisFetch('/emr-api/api/v1/EMR/FetchEmrOrders', { body: { mrno, hospitalId: info.site, userId: uid, empId, fromDate: fromISO, toDate: toISO, baseCategoryId: 2, baseInvCategoryId: 2 } }).catch(() => null);
    const found = [];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (awpIsRadPending(o)) found.push(o);
      for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
    };
    walk(eo && eo.json);
    for (const o of found) {
      items.push({
        mrno, patientName: info.name || (o.patientName || '').trim(),
        exam: o.invMastServiceName, modality: results.normMod(o.invMastServiceName || o.subCategoryName || '') || null,
        clinicalIndication: (o.clinicalIndication || '').trim() || null,
        doctorName: (o.providerName || '').trim() || null,
        orderedDate: o.proposedDate || null,
        billedStatus: o.billedStatus || null, isBilled: Number(o.isbilled) === 1,
        adminStatus: o.adminStatus || null,
        serviceOrderId: o.serviceOrderId != null ? o.serviceOrderId : null,
        site: info.site, branch: nameOf.get(info.site) || `Branch ${info.site}`,
        awaitingPayment: true,
      });
    }
  });
  items.sort((a, b) => Date.parse(b.orderedDate || 0) - Date.parse(a.orderedDate || 0));
  const data = { ok: true, build: CONNECTOR_BUILD, total: items.length, rosterSize: roster.size, rosterDiag, items, generatedAt: new Date().toISOString() };
  awpCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

app.get('/radiology/awaiting-payment', requireAuth, async (req, res) => {
  try {
    const sites = String(req.query.sites || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => n > 0);
    const noCache = String(req.query.nocache || '') === '1';
    return res.json(await radiologyAwaitingPayment({ sites, noCache }));
  } catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ── Unpaid-orders PROBE (read-only diagnostic) ────────────────────────────────
// Unpaid radiology orders never reach ResultEntryRadiology/RadiologySearch (that's the
// post-payment result queue), so to surface them we must read the BILLING layer. The
// exact request bodies for those endpoints aren't documented (the HIS builds them at
// runtime), so this probe tries several candidate search endpoints + payload shapes
// per branch and reports, for each, the HTTP status and the RAW RESPONSE SHAPE (row
// count + field names + a PHI-redacted sample row). Nothing is written — only *search*
// endpoints are called (never Save*). Use it to discover which endpoint lists unpaid
// radiology orders and what its rows look like, then wire the real merge precisely.
app.get('/diag/unpaid-probe', requireAuth, async (req, res) => {
  try {
    await getToken();
    const uid = String(HIS_USER).padStart(8, '0');
    const empId = currentEmpId() || '0';
    const mrno = String(req.query.mrno || '').trim();     // optional: probe one patient
    const days = Math.max(1, Math.min(31, Number(req.query.days) || 7));
    const siteList = await getSites().catch(() => []);
    const sites = String(req.query.sites || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => n > 0);
    const wantSites = sites.length ? sites : (siteList.length ? siteList.map((s) => s.siteId) : STATS_SITES);
    const today = new Date();
    const toISO = `${today.toISOString().slice(0, 10)}T23:59:59.000Z`;
    const fromISO = `${new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10)}T00:00:00.000Z`;
    // PHI guard: never echo identifying fields — keep only ids, amounts, dates, flags.
    const redact = (row) => {
      if (!row || typeof row !== 'object') return row;
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        if (/name|mobile|phone|iqama|nationalid|national_id|passport|dob|birth|address|email/i.test(k)) out[k] = '‹redacted›';
        else out[k] = v;
      }
      return out;
    };
    const shapeOf = (j) => {
      const rows = (j && (j.data || j.Data)) || (Array.isArray(j) ? j : null);
      if (Array.isArray(rows)) return { rowCount: rows.length, firstRowKeys: rows.length ? Object.keys(rows[0]) : [], sample: rows.length ? redact(rows[0]) : null };
      if (j && typeof j === 'object') {
        // Response is an OBJECT (e.g. FetchServiceDueList wraps its lists). Walk up to 2
        // levels deep and report every ARRAY-valued field with its length + row schema +
        // a redacted sample — that's where the actual due/unpaid orders live.
        const arrays = [];
        const scan = (obj, prefix, depth) => {
          if (!obj || typeof obj !== 'object' || depth > 2) return;
          for (const [k, v] of Object.entries(obj)) {
            if (Array.isArray(v)) arrays.push({ field: (prefix + k) || '(root)', count: v.length, firstRowKeys: v.length ? Object.keys(v[0] || {}) : [], sample: v.length ? redact(v[0]) : null });
            else if (v && typeof v === 'object') scan(v, prefix + k + '.', depth + 1);
          }
        };
        scan(j, '', 0);
        return { objectKeys: Object.keys(j).slice(0, 40), arrays };
      }
      return { raw: typeof j };
    };
    // RadiologySearch IS branch-wide (no mrno needed). The default board uses
    // filterResult:'0' + isbilled:0, which only returns paid+performed orders awaiting a
    // result. Unpaid orders may surface under a DIFFERENT flag combination — so probe the
    // branch-wide search across filterResult / isbilled / mode / cpoeStatus variants and
    // compare row counts. All are read-only searches. (The patient-scoped billing endpoints
    // returned empty on a blank mrno, so they're dropped from the branch-wide probe.)
    const RS = '/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch';
    const base = (extra) => results.radiologySearchBody({ mrno: '', hospitalId: 0, empId, filterResult: '0', fromDate: fromISO, toDate: toISO, ...extra });
    const withRaw = (extra, raw) => { const b = base(extra); Object.assign(b, raw); return b; };
    const EMR = '/emr-api/api/v1';
    // EMR order-layer bodies (pre-billing) — guessed from the RadiologySearch shape.
    const emrBody = (site, extra) => ({ mrno, hospitalId: site, userId: uid, empId, fromDate: fromISO, toDate: toISO, baseInvCategoryId: 2, baseCategoryId: 2, ...extra });
    const BILL = '/billing-api/api/v1';
    const candidates = (site) => ([
      { name: 'RS current (baseline)', path: RS, body: base({ hospitalId: site }) },
      // The winner from v3 — returns an OBJECT (its lists are now unpacked by shapeOf).
      { name: 'EMR/FetchServiceDueList', path: EMR + '/EMR/FetchServiceDueList', body: emrBody(site) },
      { name: 'EMR/FetchEmrOrders', path: EMR + '/EMR/FetchEmrOrders', body: emrBody(site) },
      { name: 'EMR/FetchBundleDueList', path: EMR + '/EMR/FetchBundleDueList', body: emrBody(site) },
      // Patient-scoped billing sources — only useful with an mrno (payment/settlement layer).
      ...(mrno ? [
        { name: 'Billing/DueSettlementBills', path: BILL + '/DueSettlement/GetDueSettlementBills', body: emrBody(site, { patientType: 0, visitMode: 0 }) },
        { name: 'Billing/ServicePanelData', path: BILL + '/ServicePanel/GetServicePanelData', body: emrBody(site, { serviceType: 0 }) },
        { name: 'Billing/GetAvailedServices', path: BILL + '/AvailedServiceInfo/GetAvailedServices', body: emrBody(site) },
      ] : []),
    ]);
    // With an mrno, the patient can be at ANY branch — try hospitalId 0 (any) first, then a
    // couple of real sites. Without an mrno, sweep the first 2 branches (branch-wide reads).
    const probeSites = mrno ? [0, ...wantSites.slice(0, 3)] : wantSites.slice(0, 2);
    const out = [];
    for (const site of probeSites) {
      for (const c of candidates(site)) {
        try {
          const r = await hisFetch(c.path, { method: 'POST', body: c.body });
          out.push({ site, endpoint: c.name, status: r.status, ok: !(r.status >= 400) && r.json != null,
            shape: r.json != null ? shapeOf(r.json) : { nonJson: String(r.text || '').slice(0, 160) } });
        } catch (e) {
          out.push({ site, endpoint: c.name, error: String(e.message || e) });
        }
      }
    }
    // Compact one-line-per-candidate summary so the counts are readable without truncation.
    const bestArray = (sh) => (sh && Array.isArray(sh.arrays) && sh.arrays.length) ? sh.arrays.reduce((a, b) => b.count > a.count ? b : a) : null;
    const summary = out.map((r) => {
      const sh = r.shape || {};
      let rows;
      if (sh.rowCount != null) rows = String(sh.rowCount);
      else if (r.error) rows = 'error';
      else { const ba = bestArray(sh); rows = ba ? `obj→${ba.field}[${ba.count}]` : (sh.objectKeys ? 'obj(no-array)' : '0'); }
      return `site ${r.site} · ${r.endpoint} · HTTP ${r.status != null ? r.status : 'ERR'} · rows=${rows}`;
    });
    return res.json({ ok: true, build: CONNECTOR_BUILD, note: 'read-only probe; compare rows= across endpoints', mrno: mrno || null, range: { from: fromISO.slice(0, 10), to: toISO.slice(0, 10) }, sitesTried: probeSites, summary, results: out });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ── Siratech SCHEMA reference (read-only) ─────────────────────────────────────
// One-shot reference: hits the key READ endpoints across the services whose base
// path we know, and returns — for each — the RESPONSE SCHEMA (field names + types)
// plus one PHI-redacted sample. This is the "what can we pull from Siratech" map, so
// features aren't rebuilt for data that already exists. It reads STRUCTURE, not bulk
// data (one sample row per endpoint, identifiers masked). Pass ?mrno= for the patient-
// scoped endpoints (a real MRN makes those sections populate). Only Get*/Search reads.
app.get('/diag/schema-dump', requireAuth, async (req, res) => {
  try {
    await getToken();
    const uid = String(HIS_USER).padStart(8, '0');
    const empId = currentEmpId() || '0';
    const mrno = String(req.query.mrno || '').trim();
    const siteList = await getSites().catch(() => []);
    const site = (siteList[0] && siteList[0].siteId) || 1;
    const today = new Date();
    const toISO = `${today.toISOString().slice(0, 10)}T23:59:59.000Z`;
    const fromISO = `${new Date(today.getTime() - 90 * 864e5).toISOString().slice(0, 10)}T00:00:00.000Z`;
    const redact = (row) => {
      if (!row || typeof row !== 'object') return row;
      const out = {};
      for (const [k, v] of Object.entries(row)) out[k] = /name|mobile|phone|iqama|nationalid|national_id|passport|dob|birth|address|email|contact/i.test(k) ? '‹redacted›' : v;
      return out;
    };
    // Reduce any response to { fields, sample, arrays } — the schema, not the data.
    const schemaOf = (j) => {
      const arr = (j && (j.data || j.Data)) || (Array.isArray(j) ? j : null);
      if (Array.isArray(arr)) return { kind: 'array', count: arr.length, fields: arr.length ? Object.keys(arr[0]) : [], sample: arr.length ? redact(arr[0]) : null };
      if (j && typeof j === 'object') {
        const arrays = [];
        const scan = (o, pre, d) => { if (!o || typeof o !== 'object' || d > 2) return; for (const [k, v] of Object.entries(o)) { if (Array.isArray(v)) arrays.push({ field: pre + k, count: v.length, fields: v.length ? Object.keys(v[0] || {}) : [], sample: v.length ? redact(v[0]) : null }); else if (v && typeof v === 'object') scan(v, pre + k + '.', d + 1); } };
        scan(j, '', 0);
        return { kind: 'object', objectKeys: Object.keys(j).slice(0, 40), arrays };
      }
      return { kind: typeof j };
    };
    const hit = async (name, method, path, body) => {
      try {
        const r = await hisFetch(path, { method, body });
        return { name, method, path: path.split('?')[0], status: r.status, schema: r.json != null ? schemaOf(r.json) : { nonJson: String(r.text || '').slice(0, 120) } };
      } catch (e) { return { name, method, path: path.split('?')[0], error: String(e.message || e) }; }
    };
    // Seed a real bill id + encounter id from the patient's radiology, so the bill /
    // encounter endpoints populate instead of returning empty.
    let gpb = '', enc = '';
    if (mrno) {
      const rs = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', { body: results.radiologySearchBody({ mrno, hospitalId: 0, empId, filterResult: '0', fromDate: fromISO, toDate: toISO }) }).catch(() => null);
      const row = ((rs && rs.json && rs.json.data) || [])[0] || {};
      gpb = row.genPatBillingId != null ? String(row.genPatBillingId) : '';
      enc = row.patfinencounterid != null ? String(row.patfinencounterid) : '';
    }
    const P = '/patient-api/api/v1', I = '/investigation-api/api/v1', E = '/emr-api/api/v1', B = '/billing-api/api/v1';
    const pbody = (extra) => ({ mrno, hospitalId: site, userId: uid, empId, fromDate: fromISO, toDate: toISO, ...extra });
    const dump = [];
    // Branch-wide (no mrno needed)
    dump.push(await hit('Radiology worklist (branch)', 'POST', I + '/ResultEntryRadiology/RadiologySearch', results.radiologySearchBody({ mrno: '', hospitalId: site, empId, filterResult: '0', fromDate: fromISO, toDate: toISO })));
    dump.push(await hit('Branches (by user)', 'GET', '/security-api/api/v1/Authentication/Sites/ByUser?userId=' + encodeURIComponent(uid)));
    // Patient-scoped (need mrno)
    if (mrno) {
      dump.push(await hit('Patient search', 'POST', P + '/Patient/Search', { mrNo: mrno }));
      dump.push(await hit('Patient data', 'GET', P + '/Patient/PatientData?mrNo=' + encodeURIComponent(mrno) + '&hospitalId=0&mode=0'));
      dump.push(await hit('Patient insurance scheme', 'GET', P + '/Patient/GetPatientScheme?mrNo=' + encodeURIComponent(mrno) + '&hospitalId=' + site));
      dump.push(await hit('RIS panel (per patient)', 'POST', E + '/EMR/FetchRISPanel', { mrno, fromDate: fromISO.slice(0, 10) + 'T00:00:00', toDate: toISO.slice(0, 10) + 'T23:59:59', invMastServiceId: 0, apptResourceCategoryId: 0, apptResourceId: 0, providerId: '', serviceCategoryId: 0, emrPatRisPanelId: 0, userId: uid, hospitalId: site }));
      dump.push(await hit('Radiology details (per patient)', 'POST', E + '/EMR/FetchRadiologyDetails', { mrno }));
      dump.push(await hit('Service due list', 'POST', E + '/EMR/FetchServiceDueList', pbody({ baseInvCategoryId: 2 })));
      dump.push(await hit('EMR orders', 'POST', E + '/EMR/FetchEmrOrders', pbody({ baseCategoryId: 2 })));
      dump.push(await hit('Visits list', 'POST', E + '/Visits/List', pbody({})));
      dump.push(await hit('Problem list', 'POST', E + '/Diagnosis/PatientProblemlist', pbody({})));
      dump.push(await hit('Due settlement bills', 'POST', B + '/DueSettlement/GetDueSettlementBills', pbody({ patientType: 0, visitMode: 0 })));
      dump.push(await hit('Availed services', 'POST', B + '/AvailedServiceInfo/GetAvailedServices', pbody({})));
      dump.push(await hit('Service panel', 'POST', B + '/ServicePanel/GetServicePanelData', pbody({ serviceType: 0 })));
      if (gpb) dump.push(await hit('Bill line items', 'GET', B + '/DueSettlement/GetDueBillDetailsByID?GenPatBillingId=' + encodeURIComponent(gpb)));
      if (enc) dump.push(await hit('Billed services (encounter)', 'GET', B + '/Billing/BilledServices?PatFinEncounterId=' + encodeURIComponent(enc) + '&ServiceType=2'));
    }
    const summary = dump.map((d) => `${d.status != null ? 'HTTP ' + d.status : 'ERR'} · ${d.name} · ${d.schema ? (d.schema.kind === 'array' ? d.schema.count + ' rows' : d.schema.kind === 'object' ? 'obj{' + (d.schema.arrays || []).map((a) => a.field + '[' + a.count + ']').join(',') + '}' : d.schema.kind) : 'error'}`);
    return res.json({ ok: true, build: CONNECTOR_BUILD, note: 'Siratech data schema reference — field names + one redacted sample per endpoint', mrno: mrno || null, seededBillId: gpb || null, seededEncounterId: enc || null, summary, dump });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ── Downloadable reference (token in the URL, browser/phone friendly) ──────────
// Serves the schema-dump as a DOWNLOAD (Content-Disposition attachment) so it can be
// opened straight from a phone browser — the token goes in the query string instead of
// an Authorization header. Same read-only, PHI-redacted content as /diag/schema-dump.
// Auth is checked here explicitly (timing-safe) since it bypasses requireAuth's header.
app.get('/download/schema', async (req, res) => {
  try {
    const tok = String(req.query.token || '');
    if (API_TOKEN) {
      const a = Buffer.from(tok), b = Buffer.from(API_TOKEN);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send('Unauthorized — bad or missing ?token=');
    }
    const mrno = String(req.query.mrno || '');
    // Self-call the schema-dump with the proper Bearer header, then hand it back as a file.
    const r = await fetch(`http://127.0.0.1:${PORT}/diag/schema-dump?mrno=${encodeURIComponent(mrno)}`, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="siratech-everything.json"');
    return res.send(text);
  } catch (e) { return res.status(502).send('Error: ' + String(e.message || e)); }
});

// ── Order trace (read-only) — does a doctor's order reach the worklist? ────────
// THE decisive test: for one patient, list every radiology order the doctor placed
// (FetchEmrOrders — with billed/admin status), then check which of them actually appear
// in the worklist's source (RadiologySearch, pending + resulted). If a billed-but-pending
// order is MISSING from RadiologySearch, that proves the worklist can't show it and we
// must pull placed orders from the EMR layer. If it's PRESENT, we just mark it unpaid.
app.get('/diag/order-trace', requireAuth, async (req, res) => {
  try {
    const mrno = String(req.query.mrno || '').trim();
    if (!mrno) return res.status(400).json({ ok: false, error: 'mrno required' });
    await getToken();
    const uid = String(HIS_USER).padStart(8, '0');
    const empId = currentEmpId() || '0';
    const today = new Date();
    const toISO = `${today.toISOString().slice(0, 10)}T23:59:59.000Z`;
    const fromISO = `${new Date(today.getTime() - 120 * 864e5).toISOString().slice(0, 10)}T00:00:00.000Z`;
    // Placed orders (doctor CPOE layer). FetchEmrOrders needs a REAL hospitalId (0 returns
    // nothing), so try each branch until the patient's orders come back.
    const placed = [];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o.invMastServiceName && /radiolog/i.test(String(o.invCategoryName || ''))) {
        placed.push({ invMastServiceId: o.invMastServiceId, name: o.invMastServiceName, billedStatus: o.billedStatus, isbilled: o.isbilled, adminStatus: o.adminStatus, status: o.status, serviceOrderId: o.serviceOrderId, proposedDate: o.proposedDate, hospitalId: o.hospitalId });
      }
      for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
    };
    const sitesToTry = (await getSites().catch(() => [])).map((s) => s.siteId);
    let placedFoundAtSite = null;
    for (const s of sitesToTry) {
      const eo = await hisFetch('/emr-api/api/v1/EMR/FetchEmrOrders', { body: { mrno, hospitalId: s, userId: uid, empId, fromDate: fromISO, toDate: toISO, baseCategoryId: 2, baseInvCategoryId: 2 } }).catch(() => null);
      const before = placed.length;
      walk(eo && eo.json);
      if (placed.length > before && placedFoundAtSite == null) placedFoundAtSite = s;
    }
    // What the worklist source shows for this patient (pending + resulted).
    const rsRows = async (extra) => {
      const r = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', { body: results.radiologySearchBody({ mrno, hospitalId: 0, empId, fromDate: fromISO, toDate: toISO, ...extra }) }).catch(() => null);
      return ((r && r.json && r.json.data) || []).map((x) => ({ invMastserviceId: x.invMastserviceId, serviceName: x.serviceName, genPatBillingId: x.genPatBillingId, billNo: x.billNo, resultEntry: x.resultEntry }));
    };
    const pending = await rsRows({ filterResult: '0' });
    const resulted = await rsRows({ filterResult: '2', selectionType: 2, isFrequent: 1 });
    const idsIn = (arr) => new Set(arr.map((x) => String(x.invMastserviceId)));
    const inPend = idsIn(pending), inRes = idsIn(resulted);
    // Cross-reference each placed order against the worklist source.
    const trace = placed.map((p) => ({
      ...p,
      inWorklistPending: inPend.has(String(p.invMastServiceId)),
      inWorklistResulted: inRes.has(String(p.invMastServiceId)),
    }));
    const missing = trace.filter((t) => !t.inWorklistPending && !t.inWorklistResulted);
    return res.json({
      ok: true, build: CONNECTOR_BUILD, mrno, placedFoundAtSite,
      verdict: placed.length === 0 ? 'no radiology orders found for this patient'
        : missing.length ? `${missing.length}/${placed.length} placed radiology orders are MISSING from the worklist source — must pull from EMR orders`
        : 'all placed radiology orders appear in the worklist source — just mark unpaid',
      placedCount: placed.length, pendingCount: pending.length, resultedCount: resulted.length,
      trace, missingFromWorklist: missing,
    });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ── RIS auto-file candidates ────────────────────────────────────────────────
// Scan the live worklist and return every test that is SAFE to file with NO
// human in the loop: the order's report is VERIFIED in DePACS (real PDF) AND the
// test resolves to EXACTLY one study (buildMatch's allUnique + sibling guard).
// READ-ONLY — it never writes; Meena's audited auto-file loop does the write,
// re-checking the match on the way in. Anything ambiguous is simply omitted so a
// human still files it from the worklist.
app.get('/autofile/candidates', requireAuth, async (req, res) => {
  try {
    const sites = String(req.query.sites || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const limit = Math.max(1, Math.min(80, Number(req.query.limit) || 40));
    const wl = await buildWorklist({ sites, from: null, to: null, ready: false, noCache: true });
    // Distinct patients, keeping the worklist's emergency-first / oldest-first order.
    const seen = new Set(), targets = [];
    for (const it of wl.items) {
      if (it.mrno && !seen.has(it.mrno)) { seen.add(it.mrno); targets.push(it); if (targets.length >= limit) break; }
    }
    const out = [];
    await pool(targets, 5, async (it) => {
      try {
        const m = await buildMatch(it.mrno, null, it.site);
        for (const o of (m.orders || [])) {
          if (!o.allUnique) continue;   // whole order must be unambiguous
          for (const t of o.tests) {
            if (t.decision !== 'unique' || !t.study || t.study.studyId == null) continue;
            if (!t.report || !t.report.pdfOk) continue;   // must have a real report PDF
            out.push({
              file: it.mrno, mrno: it.mrno, site: it.site, billNo: o.order.billNo,
              genPatBillingId: o.order.genPatBillingId,
              serviceId: t.test.invMastServiceId, invPatTestResultId: t.test.invPatTestResultId,
              serviceName: t.test.serviceName, studyId: t.study.studyId,
              patientName: it.patientName || '', emergency: !!it.emergency,
            });
          }
        }
      } catch (e) { /* skip this patient — a bad match never blocks the sweep */ }
    });
    return res.json({ ok: true, count: out.length, scanned: targets.length, candidates: out });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ── Resulted / awaiting-authorization queue (READ-ONLY) ───────────────────────
// Siratech's own "auth search" (filterResult=2, selectionType=2, isFrequent=1 —
// captured live from the UI): every order that already HAS a result saved. Two uses:
//   • rescue "saved but never authorized" results (they vanish from the pending
//     list, so before this we could not even SEE them)
//   • confirm an order that left the pending worklist truly got a result (honest
//     reconcile: 'filed' vs merely 'gone')
app.get('/results/resulted', requireAuth, async (req, res) => {
  try {
    await getToken();
    const empId = currentEmpId();
    if (!empId) throw new Error('no empId (not logged in?)');
    const site = Number(req.query.site) > 0 ? Number(req.query.site) : RESULT_SITE;
    const mrno = String(req.query.mrno || '').trim();
    const day = (s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
    const from = day(String(req.query.from || '')) || new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    const to = day(String(req.query.to || '')) || new Date().toISOString().slice(0, 10);
    const sr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', {
      body: results.radiologySearchBody({
        mrno, hospitalId: site, empId, filterResult: '2', selectionType: 2, isFrequent: 1,
        fromDate: `${from}T00:00:00.000Z`, toDate: `${to}T23:59:59.000Z`,
      }),
    });
    if (!sr || (sr.status && sr.status >= 400) || sr.json == null) {
      throw new Error(`HIS resulted search failed (${sr ? 'HTTP ' + sr.status : 'unreachable'})`);
    }
    const rows = (sr.json.data || []).map((r) => ({
      mrno: String(r.mrno || ''), patientName: (r.patientName || '').trim(),
      billNo: r.billNo || null, genPatBillingId: r.genPatBillingId,
      billDate: r.billDate || null, doctorName: (r.doctorName || '').trim(),
      authorizationStatus: r.authorizationstatus != null ? r.authorizationstatus : (r.authorizationStatus != null ? r.authorizationStatus : null),
      raw: _accDbg(r),
    }));
    return res.json({ ok: true, site, from, to, count: rows.length, rows });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ── Pregnancy / β-hCG lab check (decision support before irradiating) ──────────
// Radiation safety: before a CT / X-ray on a female patient of child-bearing age,
// staff should know whether a recent pregnancy test exists and what it said. The
// labs live in the SAME investigation-api as radiology, just baseInvCategoryId=1.
// This is SUPPORT, never a hard block — it surfaces what Siratech already knows so
// the tech/radiologist can make the call. Best-effort: any HIS hiccup returns
// {found:false} rather than an error, so it can never wedge the worklist.
const _PREG_RE = /\b(pregnan|الحمل|حمل|b[\s-]?hcg|beta[\s-]?hcg|β[\s-]?hcg|\bhcg\b|chorionic\s+gonadotropin|serum\s+hcg|urine\s+hcg|hcg\s+(qual|quant|titer|titre))/i;
// Read a lab test's result verdict from whatever field the row carries (Siratech
// spells the value/flag several ways across builds); classify positive/negative.
function _pregVerdict(row) {
  const raw = String(row.result != null ? row.result
    : (row.resultValue != null ? row.resultValue
      : (row.finalResult != null ? row.finalResult : (row.testResult != null ? row.testResult : '')))).trim();
  const t = raw.toLowerCase();
  let verdict = null;
  if (t) {
    if (/(^|\b)(pos|positive|reactive|detected|موجب|present)\b/.test(t) && !/non[\s-]?reactive|not\s+detected/.test(t)) verdict = 'positive';
    else if (/(^|\b)(neg|negative|non[\s-]?reactive|not\s+detected|سالب|absent)\b/.test(t)) verdict = 'negative';
    else {
      const n = parseFloat(t.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n)) verdict = n >= 5 ? 'positive' : 'negative';   // serum β-hCG ≥5 mIU/mL
    }
  }
  return { verdict, resultText: raw || null };
}
async function labPregnancyCheck(mrno, site) {
  const out = { found: false, hasPregnancyTest: false, resulted: false, verdict: null,
    resultText: null, testName: null, orderDate: null, resultDate: null, tests: [] };
  const empId = currentEmpId();
  if (!empId || !mrno) return out;
  const useSite = Number(site) > 0 ? Number(site) : ((await discoverOrderSite(mrno).catch(() => 0)) || RESULT_SITE);
  const from = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  // Look at both RESULTED (filterResult 2) and PENDING (0) labs, so we can say
  // "tested — negative", "tested — result pending", or "no recent pregnancy test".
  const searches = [
    { resulted: true, body: results.radiologySearchBody({ mrno, hospitalId: useSite, empId, baseInvCategoryId: 1, filterResult: '2', selectionType: 2, isFrequent: 1, fromDate: `${from}T00:00:00.000Z`, toDate: `${to}T23:59:59.000Z` }) },
    { resulted: false, body: results.radiologySearchBody({ mrno, hospitalId: useSite, empId, baseInvCategoryId: 1, filterResult: '0', fromDate: `${from}T00:00:00.000Z`, toDate: `${to}T23:59:59.000Z` }) },
  ];
  const seen = new Set();
  for (const s of searches) {
    let sr;
    try { sr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', { body: s.body }); }
    catch (e) { continue; }
    if (!sr || (sr.status && sr.status >= 400) || sr.json == null) continue;
    for (const r of (sr.json.data || [])) {
      const name = String(r.serviceName || r.testName || r.profileName || '').trim();
      // A search row is an ORDER (may bundle several tests) — match the order name OR
      // pull the test rows and match those. Cheap first pass on the order name.
      const rowMatches = _PREG_RE.test(name);
      const key = String(r.genPatBillingId || r.billNo || name) + '|' + name.toLowerCase();
      if (!rowMatches || seen.has(key)) continue;
      seen.add(key);
      const v = _pregVerdict(r);
      out.tests.push({ testName: name, billNo: r.billNo || null, orderDate: r.billDate || r.visitDate || null,
        resulted: !!s.resulted, verdict: v.verdict, resultText: v.resultText });
    }
  }
  if (out.tests.length) {
    // Newest first; the most recent test is the one that matters clinically.
    out.tests.sort((a, b) => (parseHisDate(b.orderDate || '') || 0) - (parseHisDate(a.orderDate || '') || 0));
    const top = out.tests[0];
    out.found = true; out.hasPregnancyTest = true;
    out.testName = top.testName; out.orderDate = top.orderDate;
    out.resulted = out.tests.some((t) => t.resulted);
    const resultedTop = out.tests.find((t) => t.resulted && t.verdict) || out.tests.find((t) => t.resulted) || top;
    out.verdict = resultedTop.verdict; out.resultText = resultedTop.resultText;
    out.resultDate = resultedTop.orderDate;
  }
  return out;
}
app.get('/labs/pregnancy', requireAuth, async (req, res) => {
  try {
    await getToken();
    if (!currentEmpId()) throw new Error('no empId (not logged in?)');
    const mrno = String(req.query.mrno || '').trim();
    if (!mrno) return res.status(400).json({ ok: false, error: 'mrno is required' });
    const site = Number(req.query.site) > 0 ? Number(req.query.site) : 0;
    const r = await labPregnancyCheck(mrno, site);
    return res.json({ ok: true, mrno, ...r });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ── Guarded result FILE + AUTHORIZE (write) — dry-run by default ───────────────
// Files a VERIFIED DePACS report back into Siratech's Radiology Result Entry and
// authorises it. NOTHING is written unless {confirm:true} is sent AND the target
// test resolves to exactly ONE study (file-number + modality + body-part + time).
// Dry-run returns the raw result-entry template + report + the exact payloads that
// WOULD be posted, so a human can verify before anything is committed.
async function buildFilePlan({ file, site, billNo, serviceId, accession, consentOnly, consentAlreadyFiled, consentFiledCount }) {
  await getToken();
  const empId = currentEmpId();
  if (!empId) throw new Error('no empId (not logged in?)');
  // Same per-site worklist rule as buildMatch: honour a pinned site, else discover
  // the order's real branch (by bill when given) so filing targets the right site.
  const useSite = Number(site) > 0 ? Number(site) : (await discoverOrderSite(file, billNo)) || RESULT_SITE;

  const sr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', {
    body: results.radiologySearchBody({ mrno: file, hospitalId: useSite, empId }),
  });
  if (!sr || (sr.status && sr.status >= 400) || sr.json == null) throw new Error(`HIS result search failed (${sr ? 'HTTP ' + sr.status : 'unreachable'})`);
  const rows = sr.json.data || [];
  // Never pick an arbitrary order: require billNo to disambiguate a multi-order file.
  if (!billNo && rows.length > 1) throw new Error('This file has multiple orders — a bill number is required to pick the right one');
  const row = billNo ? rows.find((r) => String(r.billNo) === String(billNo)) : rows[0];
  if (!row) throw new Error(`no pending radiology order found for file ${file} at site ${useSite}${billNo ? ' bill ' + billNo : ''}`);

  const dr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologyDetails', {
    body: results.radiologyDetailsBody(row, { hospitalId: useSite, empId }),
  });
  const details = (dr.json && dr.json.data) || [];
  if (!details.length) throw new Error('RadiologyDetails returned no test rows');

  const studies = await results.depacsStudies(file);
  // EMR forward view — carries Siratech's own DICOM accession per test (when cPACS is on).
  const emrMap = await emrRadiologyDetails(file, useSite);
  const orderDate = row.billDate || row.visitDate || null;

  // Canonical service id — HIS spells it inv_mast_service_id OR invMastserviceId
  // depending on the build/site. Using a single spelling elsewhere would break the
  // sibling guard (undefined===undefined) and the attachment payload.
  const svcId = (t) => (t && (t.inv_mast_service_id != null ? t.inv_mast_service_id : t.invMastserviceId));

  // pick the target test row (by service id when given, else the only one)
  let target = null;
  if (serviceId != null) {
    target = details.find((t) => svcId(t) != null && String(svcId(t)) === String(serviceId));
  } else if (details.length === 1) {
    target = details[0];
  } else if (consentOnly) {
    // A patient's non-pregnancy consent is visit-level, not test-specific — attaching
    // it to any one test row of the bill surfaces it on the patient's file. Pick the
    // first row deterministically (report filing still requires an explicit serviceId).
    target = details[0];
  }
  if (!target) {
    return { needsPick: true, file, site: useSite, billNo: row.billNo,
      tests: details.map((t) => ({ serviceName: t.serviceName, categoryName: t.categoryName, invMastServiceId: svcId(t), invPatTestResultId: t.invPatTestResultId })) };
  }

  // A consent attaches as its OWN document and must not be gated by the report's
  // idempotency guard (a consent may legitimately sit next to a report). Return the
  // row now — the /consent/file handler builds a consent-only attachment payload.
  if (consentOnly) {
    return { file, site: useSite, empId, billNo: row.billNo, orderDate,
      searchRow: row, details, target, consentOnly: true };
  }

  // Idempotency: if a REPORT (or any non-consent document) is already attached, don't
  // file again — a retry after a lost response would otherwise append a duplicate PDF.
  // BUT the patient's non-pregnancy CONSENT, filed on its own before imaging, must NOT
  // block the later report; the report appends alongside it. Tell the two apart by the
  // attachment's fileName; when the HIS returns only the flag (no names), fall back to
  // Meena's ledger (consentAlreadyFiled) plus the row's authorization state.
  const _atts = Array.isArray(target.genFileAttachments) ? target.genFileAttachments : [];
  const _nm = (a) => String((a && (a.fileName || a.file_name || a.name)) || '').toLowerCase();
  const _isConsentName = (a) => /consent|non.?pregnan/.test(_nm(a));
  const _hasReportDoc = _atts.some((a) => _nm(a) && !_isConsentName(a));   // a real report/other doc
  const _authorized = String(target.authorizationstatus || '') === '1'
    || Number(target.tempAuthStatus) === 1 || String(target.resultEnteredAndAccepted || '') === '1';
  const _flagSet = Number(target.isfileAttachmentExists) === 1 || _atts.length > 0;
  // "Only the consent" requires attachments that POSITIVELY look like consents — an
  // unnamed attachment is NOT assumed to be a consent (that would let a report retry
  // append a duplicate). Unnamed/ambiguous falls through to the ledger check below.
  const _onlyConsent = _atts.length > 0 && _atts.every((a) => _isConsentName(a));
  let _alreadyFiled = false;
  if (_hasReportDoc || _authorized) _alreadyFiled = true;         // a real report is present → block
  else if (_onlyConsent) _alreadyFiled = false;                   // named, only the consent → append the report
  else if (_atts.length > 0)                                      // enumerated but unnamed → go by COUNT:
    // allow only if every attachment is accounted for by a pre-filed consent; a report
    // would push the count past consentFiledCount and re-block (prevents a duplicate
    // report when the HIS echoes attachments without fileNames).
    _alreadyFiled = !(consentAlreadyFiled && _atts.length <= (consentFiledCount || 0));
  else if (_flagSet) _alreadyFiled = !consentAlreadyFiled;        // flag only, unenumerated → trust ledger
  if (_alreadyFiled) {
    return { file, site: useSite, billNo: row.billNo, target: { serviceName: target.serviceName },
      decision: 'already_filed', reason: 'a report is already attached to this test in Siratech', writable: false };
  }

  // Accession priority for the deterministic key:
  //   1) explicit accession from the caller (Meena's MWL-agent capture),
  //   2) Siratech's own EMR/cPACS accession for this test (exact, once cPACS is on),
  //   3) whatever the HIS result row happens to carry (fuzzy fallback).
  const targetEmr = emrLookup(emrMap, target, row);
  const effectiveAccession = (accession && String(accession).trim())
    || (targetEmr && targetEmr.accession)
    || pickAccession(target, row);
  const m = results.matchStudy({ mrno: row.mrno, serviceName: target.serviceName, categoryName: target.categoryName, orderDate, accession: effectiveAccession }, studies);
  if (m.decision !== 'unique') {
    return { file, site: useSite, billNo: row.billNo, target: { serviceName: target.serviceName }, decision: m.decision, reason: m.reason, candidates: m.candidates, writable: false };
  }
  // Sibling-study guard on the WRITE path (mirrors buildMatch): if ANOTHER test on
  // this bill also resolves uniquely to the SAME DePACS study, filing would attach
  // one report to two result rows. Refuse — a human must decide which test owns it.
  for (const t of details) {
    if (t === target) continue;
    if (svcId(t) != null && String(svcId(t)) === String(svcId(target))) continue;
    const tEmr = emrLookup(emrMap, t, row);
    const sm = results.matchStudy({ mrno: row.mrno, serviceName: t.serviceName, categoryName: t.categoryName, orderDate, accession: (tEmr && tEmr.accession) || pickAccession(t, row) }, studies);
    if (sm.decision === 'unique' && sm.study && String(sm.study.studyId) === String(m.study.studyId)) {
      return { file, site: useSite, billNo: row.billNo, target: { serviceName: target.serviceName },
        decision: 'ambiguous', reason: `study #${m.study.studyId} also matches "${t.serviceName}" on this bill — file manually to the correct test`,
        candidates: m.candidates, writable: false };
    }
  }
  const report = await results.depacsReport(m.study.studyId);

  // The radiology result is template-based: fetch the test's template so we can
  // populate invPatTemplResults (read-only).
  let template = null;
  try {
    const tr = await hisFetch('/investigation-api/api/v1/ResultEntry/GetTestTemplate?InvMastServiceId=' + encodeURIComponent(target.inv_mast_service_id), { method: 'GET' });
    template = (tr.json && (tr.json.data != null ? tr.json.data : tr.json)) || null;
  } catch (e) { template = { error: String(e.message || e) }; }

  return {
    file, site: useSite, empId, billNo: row.billNo, orderDate,
    searchRow: row, details, target, study: m.study, report, template,
    accession: effectiveAccession || null,
    accessionSource: (accession && String(accession).trim()) ? 'caller'
      : (targetEmr && targetEmr.accession) ? 'siratech'
      : (pickAccession(target, row) ? 'row' : null),
    pacsId: (targetEmr && targetEmr.pacsId) || null,
    cpacsUrl: (targetEmr && targetEmr.cpacsUrl) || null,
    match: { decision: m.decision, key: m.key, reason: m.reason },
  };
}

app.post('/results/file', requireAuth, async (req, res) => {
  const { file, site, billNo, serviceId, confirm, range, authorize, accession } = req.body || {};
  if (!file) return res.status(400).json({ ok: false, error: 'file is required' });
  // Did the caller pin the range explicitly? If so it always wins; otherwise we
  // auto-classify from the report's IMPRESSION further down (once we have it).
  const explicitRange = (() => {
    if (req.body && req.body.stringRange != null && Number.isFinite(Number(req.body.stringRange))) return Number(req.body.stringRange);
    if (typeof range === 'string' && RANGE_NAME_TO_CODE[range.toLowerCase()] != null) return RANGE_NAME_TO_CODE[range.toLowerCase()];
    return null;
  })();
  const doAuthorize = authorize !== false;   // default: also authorize after a good save
  try {
    const plan = await buildFilePlan({ file: String(file).trim(), site, billNo: billNo || null, serviceId, accession,
      consentAlreadyFiled: req.body.consentAlreadyFiled === true,
      consentFiledCount: Number(req.body.consentFiledCount) || 0 });
    if (plan.needsPick || plan.writable === false) return res.json({ ok: true, wrote: false, ...plan });

    // On CONFIRM, the study MUST be the same one the human reviewed in the dry-run.
    // buildFilePlan re-matches fresh, so if a new verified study / corrected accession
    // changed the result since the dry-run, refuse rather than write to an unreviewed
    // study. (expectStudyId is the studyId the dry-run returned.)
    if (confirm && req.body.expectStudyId != null &&
        plan.study && String(plan.study.studyId) !== String(req.body.expectStudyId)) {
      return res.json({ ok: true, wrote: false, step: 'changed',
        plan: { study: { studyId: plan.study.studyId } },
        note: 'The matched study changed since you reviewed it — re-check the report before filing.' });
    }

    // Trim the heavy report body for the dry-run response (keep a text preview and
    // the PDF size, not the whole base64 blob).
    const rep = plan.report;
    // RADIOLOGY results are always filed as "Not Applicable" (the report carries the
    // interpretation; normal/abnormal is a lab range, not a radiology one) — unless
    // the caller pins a range explicitly, which always wins. We still classify the
    // impression for INFORMATIONAL display only (never to drive the written range).
    const autoClass = results.classifyRange(rep.reportText);
    const stringRange = explicitRange != null ? explicitRange : DEFAULT_STRING_RANGE;
    const rangeSource = explicitRange != null ? 'explicit'
      : (DEFAULT_STRING_RANGE === RANGE_NOT_APPLICABLE ? 'not applicable (radiology default)' : 'default');
    const planOut = {
      file: plan.file, site: plan.site, billNo: plan.billNo,
      // RIS Phase 2 — the durable order key so Meena can bind order ↔ study on file.
      genPatBillingId: plan.target.genPatBillingId != null ? plan.target.genPatBillingId : (plan.searchRow && plan.searchRow.genPatBillingId),
      target: { serviceName: plan.target.serviceName, invPatTestResultId: plan.target.invPatTestResultId, invMastServiceId: plan.target.inv_mast_service_id },
      // Deterministic image↔order link — the accession the matcher actually used + PACS pointers.
      accession: plan.accession || null, accessionSource: plan.accessionSource || null,
      pacsId: plan.pacsId || null, cpacsUrl: plan.cpacsUrl || null,
      study: { studyId: plan.study.studyId, desc: plan.study.desc, modality: plan.study.modality, studyDate: plan.study.studyDate, accession: plan.study.accession || null },
      match: plan.match,
      report: { reviewer: rep.reviewer, reportDate: rep.reportDate, pdfOk: rep.pdfOk, pdfBytes: rep.pdfBytes, textPreview: (rep.reportText || '').slice(0, 400) },
      range: { code: stringRange, source: rangeSource, classified: autoClass.range, impression: autoClass.impression, reason: autoClass.reason },
      detailsShape: plan.details.map((d) => Object.keys(d)),   // reveal the template fields to build td
      template: plan.template,                                  // the test's result template (structure)
    };

    // The DePACS report MUST be a real PDF — that is the artifact we file. Refuse to
    // write anything if the PDF didn't come back (never file an empty attachment).
    if (!rep.pdfOk || !rep.pdfBase64) {
      return res.json({ ok: true, wrote: false, step: 'report', plan: planOut,
        note: 'DePACS did not return a valid report PDF — refusing to file.' });
    }

    // ── Build the EXACT SaveRadiologyResultEntry payload (matches the live capture) ─
    // The result row carries no template/free-text result; the report rides along as
    // a base64 PDF in the selected row's genFileAttachments[0]. Everything else is
    // the RadiologyDetails rows echoed back, with only the target row's range,
    // attachment and selection flags set.
    // RadiologyDetails returns a FLATTER row than the save DTO expects — the SPA
    // enriches each row with empty child collections before posting. Replicate that
    // so the server-side model binds cleanly (a missing array can bind to null and
    // trip validation). Captured live: all of these are [] on a fresh result row.
    const CHILD_ARRAYS = ['invPatMastCultureResult', 'invPatDtlsCultResults', 'scanDtlsFiles',
      'scanMastFiles', 'genFileAttachments', 'invPatTemplResults', 'invPatTemplResultHeads', 'invPatTemplResultTests'];
    const details = plan.details.map((d) => {
      const row = results.normalizeResultRow(d);   // null→'' string fields + missing keys the DTO needs
      for (const k of CHILD_ARRAYS) if (!Array.isArray(row[k])) row[k] = [];
      return row;
    });
    // Re-find the target row in the normalised set by its unique id pair. NEVER fall
    // back to details[0] — on a multi-test bill that would silently file the report
    // into the WRONG (first) test. If the target can't be re-found (shouldn't happen,
    // it came from plan.details), abort rather than write to the wrong row.
    const tgt = details.find((d) => d.invPatTestResultId === plan.target.invPatTestResultId
      && String(d.inv_mast_service_id) === String(plan.target.inv_mast_service_id));
    if (!tgt) throw new Error('target test row not found in details after normalisation — refusing to file to avoid the wrong test');
    details.forEach((d) => { d.isSelected = d === tgt; });

    // auditUser is the padded 8-digit employee code the SPA sends (e.g. "00101454").
    const auditUser = String(HIS_USER).padStart(8, '0');
    // The attachment's `site` label is the branch short name (display only).
    const branchName = await getSites().then((s) => (s.find((x) => x.siteId === plan.site) || {}).shortName || plan.searchRow.site || '').catch(() => plan.searchRow.site || '');
    const nowIso = new Date().toISOString();
    // Name the attached PDF descriptively — patient · exam · date — instead of a bare
    // "report.pdf", so it's identifiable in the patient's Siratech file.
    const _fnClean = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const _rptDate = String(rep.reportDate || plan.orderDate || nowIso).slice(0, 10);
    const reportFileName = [
      _fnClean(plan.searchRow && (plan.searchRow.patientName || plan.searchRow.patName)),
      _fnClean(tgt.serviceName),
      _rptDate,
    ].filter(Boolean).join(' - ').slice(0, 120).concat('.pdf') || 'report.pdf';
    const attachment = {
      fileName: reportFileName, site: branchName, filePath: '', file: '',
      fileAttachmentCategoryId: FILE_ATTACHMENT_CATEGORY_ID, fileAttachmentSubCategoryId: null,
      isLoading: true, resultType: 'pdf', objectState: 1,
      attachedfile: rep.pdfBase64, auditDate: null, attachedFile: rep.pdfBase64,
      genFileAttachmentsId: -1, mrno: String(tgt.mrno),
      serviceId: String(tgt.inv_mast_service_id != null ? tgt.inv_mast_service_id : tgt.invMastserviceId),
      invPatTestResultId: tgt.invPatTestResultId,
      hospitalId: plan.site, genPatBillingId: tgt.genPatBillingId, entryDate: nowIso,
    };
    tgt.result = null;
    tgt.isTemplateResultEntered = 0;
    tgt.stringRange = stringRange;
    tgt.isfileAttachmentExists = 1;
    // Attach the report AND — when Meena passes one — the patient's signed
    // non-pregnancy consent, so BOTH land on the patient's Siratech file in a single
    // filing (same genFileAttachments mechanism). The consent keeps its own name.
    const attachments = [attachment];
    if (typeof req.body.consentPdf === 'string' && req.body.consentPdf.length > 100) {
      attachments.push({
        ...attachment,
        fileName: (req.body.consentName || 'Consent Non Pregnancy.pdf'),
        attachedfile: req.body.consentPdf, attachedFile: req.body.consentPdf,
        genFileAttachmentsId: -2,
      });
    }
    tgt.genFileAttachments = attachments;

    const td = {
      resultEntryDetailsResponse: details,
      resultEntrySearchResponses: [plan.searchRow],
      auditUser, auditDate: nowIso, hospitalId: plan.site,
      isResultCancellation: false, sampleCollResultEntrySelection: 1,
      searchTypeResultAuthorizationValue: 0, blnBloodType: false,
    };

    if (!confirm) {
      // DRY-RUN — show the caller the exact write we WOULD post (PDF elided), so a
      // human can verify the target row, range and attachment before committing.
      const previewTd = { ...td, resultEntryDetailsResponse: details.map((d) => ({
        serviceName: d.serviceName, inv_mast_service_id: d.inv_mast_service_id,
        invPatTestResultId: d.invPatTestResultId, isSelected: d.isSelected, stringRange: d.stringRange,
        genFileAttachments: (d.genFileAttachments || []).map((a) => ({ ...a, attachedfile: `<pdf ${rep.pdfBytes}b>`, attachedFile: `<pdf ${rep.pdfBytes}b>` })),
      })) };
      return res.json({ ok: true, wrote: false, dryRun: true, plan: planOut,
        stringRange, willAuthorize: doAuthorize, payloadPreview: previewTd,
        note: 'DRY-RUN — nothing was written. Re-send with confirm:true to file' + (doAuthorize ? ' + authorize.' : ' (authorize:false → save only).') });
    }

    // ── confirm:true → attempt the real write (server-side validated) ──────────
    // SAVE first; only AUTHORIZE if the save clearly succeeded. A rejected save is
    // harmless (HIS validates the payload) and we surface its message.
    const saveRes = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/SaveRadiologyResultEntry', { body: td });
    const sData = saveRes.json && saveRes.json.data;
    const sRow = Array.isArray(sData) ? sData[0] : sData;
    const saveMsg = sRow && (sRow.meassge || sRow.message);
    // A HIS reject can arrive as HTTP 200 with isSuccess omitted and a message that
    // isn't in the old narrow list — treat any recognized error wording as failure so
    // a rejection is never reported as a successful medical-record write.
    const REJECT_MSG = /enter template|select .*range|attach|duplicate|already|locked|invalid|object reference|not set|no record|denied|unauthor|error|cannot|failed|fail\b/i;
    const saveOk = saveRes.status === 200 && sRow && sRow.isSuccess !== false && !(saveMsg && REJECT_MSG.test(saveMsg));
    if (!saveOk) {
      return res.json({ ok: true, wrote: false, step: 'save', saveStatus: saveRes.status,
        saveResponse: saveRes.json || String(saveRes.text || '').slice(0, 600), plan: planOut,
        note: 'SAVE did not succeed — nothing was authorized.' });
    }
    if (!doAuthorize) {
      return res.json({ ok: true, wrote: true, authorized: false, plan: planOut, stringRange,
        save: { status: saveRes.status, isSuccess: sRow.isSuccess, message: saveMsg || null },
        note: 'Result FILED (PDF attached). authorize:false — left pending authorization.' });
    }

    // ── AUTHORIZE (1st level) ──────────────────────────────────────────────────
    // Re-use the SAME normalised rows that the save just accepted (the raw save
    // response echoes rows with null child collections, which trips a LINQ null —
    // "Value cannot be null (Parameter 'source')"). Patch in the server-assigned
    // invPatTestResultId (a fresh order comes back with a real id we must authorize
    // against), flip the target to authorized, and drop the already-saved PDF from
    // the payload so authorization doesn't file a duplicate attachment.
    const _svc = (x) => (x && (x.inv_mast_service_id != null ? x.inv_mast_service_id : x.invMastserviceId));
    const savedIdRow = Array.isArray(sData)
      ? sData.find((x) => _svc(x) != null && String(_svc(x)) === String(_svc(tgt)))
      : (sData && typeof sData === 'object' ? sData : null);
    if (savedIdRow && savedIdRow.invPatTestResultId != null) tgt.invPatTestResultId = savedIdRow.invPatTestResultId;
    tgt.genFileAttachments = [];      // attachment already persisted by the save
    tgt.isfileAttachmentExists = 1;
    tgt.authorizationstatus = '1';
    tgt.tempAuthStatus = 1;
    const Ka = {
      resultEntryDetailsResponse: details,
      resultEntrySearchResponses: [plan.searchRow],
      auditUser, auditDate: new Date().toISOString(), hospitalId: plan.site,
      isResultCancellation: false, sampleCollResultEntrySelection: 2,
      searchTypeResultAuthorizationValue: 0, blnBloodType: false,
    };
    const authRes = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/SaveRadiologyResultAuthorization', { body: Ka });
    const aData = authRes.json && authRes.json.data;
    const aRow = aData && (Array.isArray(aData) ? aData[0] : aData);
    const authMsg = aRow ? (aRow.meassge || aRow.message) : null;
    const authOk = authRes.status === 200 && aRow && aRow.isSuccess !== false && !(authMsg && REJECT_MSG.test(authMsg));
    return res.json({ ok: true, wrote: true, authorized: !!authOk, plan: planOut, stringRange,
      save: { status: saveRes.status, isSuccess: sRow.isSuccess, message: saveMsg || null },
      authorize: { status: authRes.status, isSuccess: aRow ? aRow.isSuccess : null, message: authMsg,
        raw: authOk ? undefined : (authRes.json || String(authRes.text || '').slice(0, 400)) },
      note: authOk ? 'Result FILED + AUTHORIZED.' : 'Result FILED, but authorization was not confirmed by HIS — verify/authorize in the UI.' });
  } catch (e) {
    return res.status(502).json({ ok: false, wrote: false, error: String(e.message || e) });
  }
});

// ── Attach a SIGNED CONSENT to the patient's file, on its own (write) ─────────
// Files the patient's non-pregnancy consent PDF into Siratech as a genFileAttachments
// document on one of her radiology result rows — the SAME mechanism the report uses,
// but consent-only: no result, no template, NEVER authorized. Independent of any
// report, so the consent lands on the file at signing (before imaging), not only when
// a report is later filed. Dry-run by default; {confirm:true} performs the write.
// Guards: the row is found by the consent's OWN file number, and the consent's printed
// patient name must match the HIS row's name (fail-closed against a mistyped file no).
function _looseNameMatch(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z؀-ۿ]+/g, ' ').trim();
  const na = norm(a); const nb = norm(b);
  if (!na || !nb) return true;               // a name is missing → don't block on it
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = na.split(' ').filter(Boolean); const tb = nb.split(' ').filter(Boolean);
  return ta.length && tb.length && ta[0] === tb[0];   // share the first (given) name
}
app.post('/consent/file', requireAuth, async (req, res) => {
  const { file, site, billNo, serviceId, consentPdf, consentName, expectName, confirm } = req.body || {};
  if (!file) return res.status(400).json({ ok: false, error: 'file is required' });
  if (typeof consentPdf !== 'string' || consentPdf.length < 100)
    return res.status(400).json({ ok: false, error: 'consentPdf (base64) is required' });
  try {
    const plan = await buildFilePlan({ file: String(file).trim(), site, billNo: billNo || null, serviceId, consentOnly: true });
    if (plan.needsPick || plan.writable === false) return res.json({ ok: true, wrote: false, ...plan });

    // Patient-identity guard: the row came back from a search BY this file number, but
    // if the consent carried a mistyped file number its printed name won't match — refuse.
    const rowName = plan.searchRow && (plan.searchRow.patientName || plan.searchRow.patName);
    if (!_looseNameMatch(expectName, rowName)) {
      return res.json({ ok: true, wrote: false, decision: 'name_mismatch', writable: false,
        reason: `consent name "${expectName || ''}" does not match the file's patient "${rowName || ''}" — refusing to attach` });
    }

    const CHILD_ARRAYS = ['invPatMastCultureResult', 'invPatDtlsCultResults', 'scanDtlsFiles',
      'scanMastFiles', 'genFileAttachments', 'invPatTemplResults', 'invPatTemplResultHeads', 'invPatTemplResultTests'];
    const details = plan.details.map((d) => {
      const row = results.normalizeResultRow(d);
      for (const k of CHILD_ARRAYS) if (!Array.isArray(row[k])) row[k] = [];
      return row;
    });
    const tgt = details.find((d) => d.invPatTestResultId === plan.target.invPatTestResultId
      && String(d.inv_mast_service_id) === String(plan.target.inv_mast_service_id));
    if (!tgt) throw new Error('target test row not found after normalisation — refusing to attach the consent');
    details.forEach((d) => { d.isSelected = d === tgt; });

    const auditUser = String(HIS_USER).padStart(8, '0');
    const branchName = await getSites().then((s) => (s.find((x) => x.siteId === plan.site) || {}).shortName || plan.searchRow.site || '').catch(() => plan.searchRow.site || '');
    const nowIso = new Date().toISOString();
    const attachment = {
      fileName: (consentName || 'Consent Non Pregnancy.pdf'), site: branchName, filePath: '', file: '',
      fileAttachmentCategoryId: FILE_ATTACHMENT_CATEGORY_ID, fileAttachmentSubCategoryId: null,
      isLoading: true, resultType: 'pdf', objectState: 1,
      attachedfile: consentPdf, auditDate: null, attachedFile: consentPdf,
      genFileAttachmentsId: -1, mrno: String(tgt.mrno),
      serviceId: String(tgt.inv_mast_service_id != null ? tgt.inv_mast_service_id : tgt.invMastserviceId),
      invPatTestResultId: tgt.invPatTestResultId,
      hospitalId: plan.site, genPatBillingId: tgt.genPatBillingId, entryDate: nowIso,
    };
    // Consent-only: leave the result itself untouched/pending — attach the PDF, nothing else.
    tgt.result = null;
    tgt.isTemplateResultEntered = 0;
    tgt.stringRange = DEFAULT_STRING_RANGE;
    tgt.isfileAttachmentExists = 1;
    tgt.genFileAttachments = [attachment];
    const td = {
      resultEntryDetailsResponse: details,
      resultEntrySearchResponses: [plan.searchRow],
      auditUser, auditDate: nowIso, hospitalId: plan.site,
      isResultCancellation: false, sampleCollResultEntrySelection: 1,
      searchTypeResultAuthorizationValue: 0, blnBloodType: false,
    };

    if (!confirm) {
      return res.json({ ok: true, wrote: false, dryRun: true,
        target: { serviceName: plan.target.serviceName, invPatTestResultId: plan.target.invPatTestResultId },
        note: 'DRY-RUN — consent NOT attached. Re-send with confirm:true to file it to the patient record.' });
    }

    // confirm:true → attach only. NEVER authorize (a consent is not a result).
    const saveRes = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/SaveRadiologyResultEntry', { body: td });
    const sData = saveRes.json && saveRes.json.data;
    const sRow = Array.isArray(sData) ? sData[0] : sData;
    const saveMsg = sRow && (sRow.meassge || sRow.message);
    const REJECT_MSG = /enter template|select .*range|duplicate|already|locked|invalid|object reference|not set|no record|denied|unauthor|error|cannot|failed|fail\b/i;
    const saveOk = saveRes.status === 200 && sRow && sRow.isSuccess !== false && !(saveMsg && REJECT_MSG.test(saveMsg));
    if (!saveOk) {
      return res.json({ ok: true, wrote: false, step: 'save', saveStatus: saveRes.status,
        saveResponse: saveRes.json || String(saveRes.text || '').slice(0, 600),
        target: { serviceName: plan.target.serviceName },
        note: 'Consent SAVE did not succeed — nothing was attached.' });
    }
    return res.json({ ok: true, wrote: true, authorized: false,
      target: { serviceName: plan.target.serviceName, invPatTestResultId: plan.target.invPatTestResultId },
      save: { status: saveRes.status, isSuccess: sRow.isSuccess, message: saveMsg || null },
      note: 'Consent FILED — attached to the patient record (pending, not authorized).' });
  } catch (e) {
    return res.status(502).json({ ok: false, wrote: false, error: String(e.message || e) });
  }
});

// Patient search. Two HIS endpoints, chosen by what the term looks like:
//   • MRN / name / file number → Patient/Search {mrNo}  (proven, also used elsewhere)
//   • national ID / Iqama / mobile → the EMR patient-list search the HIS UI itself
//     uses: POST Patient/EMRSearchPanel/List with a typed payload. The dropdown maps
//     to {idType, category}: MRNO/Name=1, Saudi ID=2, Iqama ID=3, Citizen ID=4,
//     Passport=5, Phone Number=6. The value goes in `idNumber`. This endpoint filters
//     server-side by type, so its rows are the real match (no gu-essing / narrowing).
const _EMR_SEARCH_PATH = '/patient-api/api/v1/Patient/EMRSearchPanel/List';
function _emrSearchBody(idType, category, value) {
  return {
    deptId: 0, providerId: '', duration: 0,
    hospitalId: Number(cache.hospitalid) || undefined,
    nursingStationId: -1, idType, category,
    dischPatientsAccess: false, genLevelId: 0,
    idNumber: value, loginProviderId: currentProviderId() || '',
    patlistType: 'EMR', roomTypeName: '',
    searchCondition: 'Search', searchConditionValue: 'All',
    updateGenUserSettings: [],
  };
}
async function _emrSearch(idType, category, value) {
  const headers = { clienttimezoneoffsetinminutes: '-180', localtimezoneoffsetinminutes: '-180', machinename: 'YARWEB_UI' };
  try { return await hisFetch(_EMR_SEARCH_PATH, { body: _emrSearchBody(idType, category, value), headers }); }
  catch (_e) { return null; }
}

async function _patientSearch(q, debug) {
  const rowsOf = (r) => ((r && r.json && (r.json.data || r.json.Data)) || []);
  const patientsFrom = (r) => rowsOf(r).slice(0, 25).map(normalizePatient);
  const rawCount = (r) => { const d = r && r.json && (r.json.data || r.json.Data); return Array.isArray(d) ? d.length : -1; };
  const tried = [];
  const dbg = (label, r, extra) => { if (debug) tried.push({ field: label, status: r && r.status, rawCount: rawCount(r), keys: (rowsOf(r)[0] ? Object.keys(rowsOf(r)[0]).slice(0, 40) : undefined), ...(extra || {}) }); };

  const digits = q.replace(/\D/g, '');
  // Saudi mobile → normalise to local 05XXXXXXXX whatever the user typed:
  // +9665…, 009665…, 9665…, 05…, or bare 5…  (core is always 5 + 8 digits).
  const mob = digits.match(/^(?:00)?(?:966)?0?(5\d{8})$/);
  const mobileLocal = mob ? '0' + mob[1] : null;        // 05XXXXXXXX
  const isSaudiId = /^1\d{9}$/.test(digits);             // Saudi national ID starts 1
  const isIqama = /^2\d{9}$/.test(digits);               // Iqama starts 2

  // ── Proven path (verified live against this HIS) ────────────────────────────
  // Patient/Search filters SERVER-SIDE by `contactNumber` (mobile) and `idNumber`
  // (Saudi ID / Iqama / passport — one ID field for all) as long as the `mrNo` key
  // is present but empty. This is the reliable route: the older EMRSearchPanel/List
  // path returns 0 rows on this build (its list is scoped to the caller's own EMR
  // panel), so it stays only as a last-ditch fallback below.
  const psSearch = async (body) => { try { return await hisFetch('/patient-api/api/v1/Patient/Search', { body }); } catch (_e) { return null; } };
  // Keep only rows that really carry the searched number — the server match can be
  // loose, so compare on the 9-digit core (5XXXXXXXX).
  const phoneCore = mobileLocal ? mobileLocal.slice(-9) : null;
  const phoneOK = (p) => { const d = String((p && p.phone) || '').replace(/\D/g, ''); return !phoneCore || d.endsWith(phoneCore); };

  const psPlans = [];   // [label, body, postFilter]
  if (mobileLocal) {
    // Try local 05…, bare 5…, and country-code 966… shapes (reception stores it
    // inconsistently); the post-filter drops any loose matches.
    psPlans.push(['contactNumber', { mrNo: '', contactNumber: mobileLocal }, phoneOK]);
    psPlans.push(['contactNumber:5', { mrNo: '', contactNumber: mobileLocal.slice(1) }, phoneOK]);
    psPlans.push(['contactNumber:966', { mrNo: '', contactNumber: '966' + mobileLocal.slice(1) }, phoneOK]);
  } else if (isSaudiId || isIqama) {
    // idNumber matches a Saudi national ID (starts 1) and an Iqama (starts 2) alike.
    psPlans.push(['idNumber', { mrNo: '', idNumber: digits }, null]);
  }
  for (const [label, body, post] of psPlans) {
    const r = await psSearch(body);
    dbg(label, r);
    let rows = patientsFrom(r);
    if (post) rows = rows.filter(post);
    if (rows.length) return { patients: rows, matchedBy: label, tried };
  }

  // Fallback: the EMR patient-list search (self-healing across HIS builds — kept in
  // case a future build scopes/exposes it differently). Bounded fan-out.
  const emrPlans = [];
  if (mobileLocal) {
    for (const cat of [6, 7, 8]) emrPlans.push(['PHONE NUMBER', cat, mobileLocal]);
    for (const cat of [6, 7, 8]) emrPlans.push(['PHONE NUMBER', cat, mobileLocal.slice(1)]);
  } else if (isSaudiId) {
    emrPlans.push(['SAUDI ID', 2, digits], ['IQAMA ID', 3, digits]);
  } else if (isIqama) {
    for (const cat of [3, 2]) emrPlans.push(['IQAMA ID', cat, digits]);
  }
  for (const [idType, category, value] of emrPlans) {
    const r = await _emrSearch(idType, category, value);
    dbg(`EMR:${idType}:${value}`, r);
    let rows = patientsFrom(r);
    if (mobileLocal) rows = rows.filter(phoneOK);
    if (rows.length) return { patients: rows, matchedBy: idType, tried };
  }

  // MRN / file number / name → the classic Patient/Search (also the fallback when a
  // typed lookup found nothing, so a plain file number always resolves).
  let r;
  try { r = await hisFetch('/patient-api/api/v1/Patient/Search', { body: { mrNo: q } }); } catch (_e) { r = null; }
  dbg('mrNo', r);
  const rows = patientsFrom(r);
  if (rows.length) return { patients: rows, matchedBy: 'mrNo', tried };

  return { patients: [], matchedBy: null, tried };
}

app.get('/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'q is required' });
  const debug = String(req.query.debug || '') === '1';
  try {
    const { patients, matchedBy, tried } = await _patientSearch(q, debug);
    const out = { ok: true, q, count: patients.length, patients, matchedBy };
    if (debug) out.tried = tried;   // per-field attempts (which body shape hit)
    return res.json(out);
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
// Read EVERY bill in a normal range so revenue/modality are exact, not a sample.
// The all-branch 30-day window is ~2.4k unique bills; 5000 covers that with headroom
// (and a full quarter for a single branch) while still bounding a pathological
// multi-year pull. Beyond the cap the financial totals are extrapolated to the full
// population (flagged `estimated`) so the headline is never silently undercounted.
const STATS_MODALITY_CAP = Number(process.env.STATS_MODALITY_CAP || 5000);
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
    .filter((s) => Number.isFinite(s.siteId));
  // Union in force-included branches the account can read but that its Sites/ByUser
  // omits (e.g. N3 after being un-assigned). Only added when not already present.
  const present = new Set(list.map((s) => s.siteId));
  for (const sid of FORCE_SITES) {
    if (!present.has(sid)) {
      const nm = FORCE_SITE_NAMES[sid] || `Branch ${sid}`;
      list.push({ siteId: sid, name: nm, shortName: nm, forced: true });
    }
  }
  list.sort((a, b) => a.siteId - b.siteId);
  if (list.length) sitesCache = { list, ts: Date.now() };
  return list;
}

const dayOf = (s) => { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
function tallyPush(map, key, name) { const k = key == null || key === '' ? 'Unknown' : String(key); const e = map.get(k) || { key: k, name: name || k, count: 0 }; e.count += 1; map.set(k, e); }
function tallyList(map, top) { const a = [...map.values()].sort((x, y) => y.count - x.count); return top ? a.slice(0, top) : a; }

// Read one bill's line items (GetDueBillDetailsByID) with a single retry. On the
// 2GB VPS a bill read can time out or come back non-2xx; without a retry that read
// contributes 0 revenue and the total silently undercounts (the "600k→300k"
// symptom). Returns { ok, items }: ok=false ONLY when both attempts failed (so the
// caller can count it as a missed read), distinct from a genuinely empty bill.
async function readBillItems(gpbId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const d = await hisFetch('/billing-api/api/v1/DueSettlement/GetDueBillDetailsByID?GenPatBillingId=' + encodeURIComponent(gpbId), { method: 'GET' });
      if (d && d.json != null && !(d.status && d.status >= 400)) {
        return { ok: true, items: (d.json.data || d.json.Data) || [] };
      }
    } catch (_e) { /* fall through to retry / failure */ }
  }
  return { ok: false, items: [] };
}

// What the PATIENT still owes on ONE bill line item. Siratech spells this differently
// across builds, so probe in priority order: (1) an explicit patient-outstanding/due
// field; (2) the patient share minus any recorded patient-paid amount; (3) the raw
// patient share as a last resort. Returns { due, src, paidSeen } — src records which
// path produced the number so the UI/diagnostics can show how "unpaid" was derived.
const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function linePatientDue(it) {
  for (const k of ['patientDueAmount', 'patientDue', 'dueFromPatient', 'patientBalance',
                   'patientBalanceAmount', 'patientOutstanding', 'patientPendingAmount', 'patientPending']) {
    if (it[k] != null && it[k] !== '') return { due: Math.max(0, _num(it[k])), src: k, paidSeen: false };
  }
  const share = _num(it.patient);
  for (const k of ['patientPaidAmount', 'patientPaid', 'patientReceived', 'patientReceiptAmount', 'patientSettledAmount']) {
    if (it[k] != null && it[k] !== '') return { due: Math.max(0, share - _num(it[k])), src: 'patient−' + k, paidSeen: true };
  }
  return { due: share, src: 'patientShare', paidSeen: false };
}

const STATS_LIST_CAP = Number(process.env.STATS_LIST_CAP || 1500);
// How many unique bills we read to fill in exam names for the drill-down list.
// Bounds latency on a wide date range; today's per-branch volume is well under this.
const STATS_LIST_ENRICH_CAP = Number(process.env.STATS_LIST_ENRICH_CAP || 120);
async function radiologyStats({ from, to, sites, withModality = false, withFinance = false, withList = false, topDoctors = 15, noCache = false }) {
  const cacheKey = JSON.stringify({ from, to, sites: (sites || []).slice().sort((a, b) => a - b), withModality, withFinance, withList });
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
    try {
      const sr = await hisFetch('/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', {
        body: results.radiologySearchBody({ mrno: '', hospitalId: site, empId, filterResult: '0', fromDate: fromISO, toDate: toISO }),
      });
      if (!sr || (sr.status && sr.status >= 400) || sr.json == null) return { site, ok: false, rows: [] };
      return { site, ok: true, rows: (sr.json.data || []) };
    } catch (e) {
      // A thrown fetch (network/TLS/DNS blip) must be reported as a FAILED branch,
      // not swallowed into pool's null → skipped silently, which would undercount
      // the total and present it as complete.
      return { site, ok: false, rows: [] };
    }
  });

  const returned = [], failed = [], flat = [];
  const byBranch = new Map(), byDept = new Map(), byDoctor = new Map();
  const patientSet = new Set();
  const daily = new Map();
  const hourly = new Array(24).fill(0);   // peak-hours: orders per hour-of-day (0..23)
  let nonMidnight = 0;                     // >0 means the timestamps actually carry a time (not date-only)
  const aging = { '<1d': 0, '1-3d': 0, '3-7d': 0, '>7d': 0 };
  let total = 0, emergency = 0, routine = 0;
  const byGender = new Map();             // demographics (only emitted if the rows carry gender)
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
      const g = r.gender ?? r.sex ?? r.patientGender ?? r.genderName;
      if (g != null && String(g).trim() !== '') { const gv = String(g).trim(); tallyPush(byGender, gv, gv); }
      const d = dayOf(r.billDate || r.visitDate);
      if (d) daily.set(d, (daily.get(d) || 0) + 1);
      // Peak-hours: read the hour straight from the timestamp string (no timezone shift).
      // If the order timestamps are date-only, `nonMidnight` stays 0 and the UI hides the chart.
      const hm = String(r.billDate || r.visitDate || '').match(/[T ](\d{2}):(\d{2})/);
      if (hm) { const hh = Number(hm[1]); if (hh >= 0 && hh < 24) { hourly[hh] += 1; if (!(hm[1] === '00' && hm[2] === '00')) nonMidnight += 1; } }
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
    // Dedup by bill (GenPatBillingId) BEFORE the fan-out: several worklist rows can
    // share one visit bill, and each bill read returns ALL its radiology line items.
    // Reading the same bill once per row would count its exams/revenue/payer split
    // multiple times. Rows without a bill id are kept as-is (their fetch returns
    // nothing, so they can't inflate anything).
    const _seenBill = new Set();
    const deduped = flat
      .slice()
      .sort((a, b) => Date.parse(b.r.billDate || b.r.visitDate || 0) - Date.parse(a.r.billDate || a.r.visitDate || 0))
      .filter(({ r }) => {
        const id = String(r.genPatBillingId == null ? '' : r.genPatBillingId);
        if (!id) return true;
        if (_seenBill.has(id)) return false;
        _seenBill.add(id);
        return true;
      });
    const sample = deduped.slice(0, STATS_MODALITY_CAP);
    // ONE bill read per order (GetDueBillDetailsByID). Each line item is checked
    // against the radiology catalog — a match is a real imaging exam, and the
    // catalog also tells us its modality. This gives exam count, modality mix,
    // revenue and payer split accurately from a single call.
    const catalog = await getRadCatalog().catch(() => new Map());
    let billsFailed = 0;
    const bills = await pool(sample, STATS_MODALITY_CONCURRENCY, async ({ r, site }) => {
      const res = await readBillItems(r.genPatBillingId);
      if (!res.ok) billsFailed += 1;   // both attempts failed → this bill's revenue is missing
      return { site, items: res.items };
    });
    const byModCount = new Map(), revByBranch = new Map(), revByMod = new Map();
    let exams = 0, revenue = 0, patient = 0, sponsor = 0, items = 0;
    let reqInsurance = 0, reqCash = 0, reqCopay = 0, reqFree = 0, reqWithRad = 0;
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
      if (hasRad) {
        reqWithRad += 1;
        // Mirror the exam-level split: a zero-charge order (no patient AND no
        // sponsor amount) is its own bucket, not silently counted as Insurance.
        if (bPat > 0 && bSpo > 0) reqCopay += 1;
        else if (bPat > 0) reqCash += 1;
        else if (bSpo > 0) reqInsurance += 1;
        else reqFree += 1;
      }
    }
    const r2 = (n) => Math.round(n * 100) / 100;
    // ofTotal/truncated must reflect the DEDUPED bill population the exam/revenue
    // counts are drawn from — using the raw worklist length would flip exact days
    // to "≈ estimate" and re-inflate the KPI extrapolation (bills→bills stays
    // consistent this way).
    // catalogLoaded lets the dashboard tell "genuinely 0 radiology exams" apart
    // from "the radiology catalog failed to load, so every line item was skipped
    // and everything reads 0" — otherwise a transient catalog outage looks like a
    // real zero day.
    // billsFailed = bills whose read failed BOTH attempts → their revenue is missing
    // from the totals. billsRead = bills that came back (empty or not). The dashboard
    // uses these to warn "estimate — N bills couldn't be read" instead of presenting a
    // silently-halved figure as final.
    const meta = { sampled: sample.length, ofTotal: deduped.length, truncated: deduped.length > sample.length, catalogLoaded: catalog.size > 0, billsFailed, billsRead: sample.length - billsFailed };
    // Extrapolation — only when the bill population EXCEEDS the cap (a pathologically
    // wide range). With the cap at 5000 the normal all-branch 30-day window (~2.4k
    // bills) is read in FULL, so scale=1 and revenue is exact. Beyond the cap we
    // project the sampled sum across the whole population (flagged `estimated`) rather
    // than showing a silently-undercounted total. billsFailed is handled separately by
    // the "N bills couldn't be read" banner, so it isn't folded into the scale here.
    const scale = deduped.length > sample.length ? deduped.length / sample.length : 1;
    const rScaled = (n) => r2(n * scale);
    if (withModality) modality = { ...meta, exams, mix: [...byModCount.values()].sort((a, b) => b.count - a.count) };
    if (withFinance) financial = {
      ...meta, items, requests: reqWithRad, exams, estimated: scale > 1,
      byPayer: [
        { type: 'Insurance', count: reqInsurance },
        { type: 'Cash / self-pay', count: reqCash },
        { type: 'Insurance + copay', count: reqCopay },
      ].concat(reqFree ? [{ type: 'Zero-charge', count: reqFree }] : []),
      // exam-level split (each X-ray / US counted separately)
      examsByPayer: [
        { type: 'Insurance', count: exInsurance },
        { type: 'Cash / self-pay', count: exCash },
        { type: 'Insurance + copay', count: exCopay },
      ].concat(exFree ? [{ type: 'Zero-charge', count: exFree }] : []),
      revenue: rScaled(revenue), patient: rScaled(patient), sponsor: rScaled(sponsor),
      byBranch: [...revByBranch.values()].map((e) => ({ site: e.site, name: e.name, revenue: rScaled(e.revenue) })).sort((a, b) => b.revenue - a.revenue),
      byModality: [...revByMod.values()].map((e) => ({ modality: e.modality, revenue: rScaled(e.revenue) })).sort((a, b) => b.revenue - a.revenue),
    };
  }

  // Drill-down list: the individual requests behind the KPI tiles (patient name +
  // exam), built from rows we already have — no extra HIS calls. Opt-in (withList)
  // and capped so a wide date range can't return a huge payload. Field names are
  // probed across spellings; requestKeys exposes the raw row keys (no values) so any
  // unmapped column can be wired precisely.
  let requests = null, requestsTruncated = 0, requestKeys = [];
  if (withList) {
    if (flat.length) requestKeys = Object.keys(flat[0].r || {});
    const ordered = flat
      .slice()
      .sort((a, b) => Date.parse(b.r.billDate || b.r.visitDate || 0) - Date.parse(a.r.billDate || a.r.visitDate || 0));
    requestsTruncated = ordered.length > STATS_LIST_CAP ? ordered.length : 0;
    requests = ordered.slice(0, STATS_LIST_CAP).map(({ r, site }) => ({
      mrno: r.mrno != null ? String(r.mrno) : '',
      name: clean(firstOf(r, ['patientName', 'patName', 'pat_name', 'fullName', 'patientFullName', 'name']) || ''),
      // The worklist row is bill-level and leaves serviceName blank; the exam names
      // live in the bill line items, filled in by the enrichment pass below.
      exam: clean(firstOf(r, ['serviceName', 'invMastServiceName', 'testName', 'mastServiceName']) || ''),
      category: (r.categoryName || '').trim() || null,
      department: (r.departmentName || '').trim() || null,
      doctor: (r.doctorName || '').trim() || null,
      branch: branchLabel(site), site,
      priority: (Number(r.isEmergency) === 1 || Number(r.priorityStat) > 0) ? 'emergency' : 'routine',
      date: dayOf(r.billDate || r.visitDate),
      hour: (() => { const hm = String(r.billDate || r.visitDate || '').match(/[T ](\d{2}):/); return hm ? Number(hm[1]) : null; })(),
      billNo: r.billNo || null,
      gpbId: r.genPatBillingId != null ? String(r.genPatBillingId) : '',
    }));
    // Exam-name enrichment: the actual exam(s) live in the bill's line items, not on
    // the worklist row. Read each unique bill once (bounded) and attach the radiology
    // item names (matched against the catalog, so labs/drugs on the bill are skipped).
    const needExam = requests.filter((x) => !x.exam && x.gpbId);
    const uniqueBills = [...new Set(needExam.map((x) => x.gpbId))].slice(0, STATS_LIST_ENRICH_CAP);
    if (uniqueBills.length) {
      const catalog = await getRadCatalog().catch(() => new Map());
      const bills = await pool(uniqueBills, STATS_MODALITY_CONCURRENCY, async (gpbId) => {
        const res = await readBillItems(gpbId);
        return { gpbId, items: res.items };
      });
      const examByBill = new Map();
      for (const b of bills) {
        if (!b || !Array.isArray(b.items)) continue;
        const names = [];
        for (const it of b.items) {
          if (!catalog.get(normName(it.itemName))) continue;   // radiology line items only
          const nm = clean(it.itemName || '');
          if (nm && !names.includes(nm)) names.push(nm);
        }
        if (names.length) examByBill.set(b.gpbId, names.join(' · '));
      }
      for (const x of requests) {
        if (!x.exam && examByBill.has(x.gpbId)) x.exam = examByBill.get(x.gpbId);
        if (!x.exam && x.category) x.exam = x.category;   // fallback to the exam category
        delete x.gpbId;                                   // internal-only
      }
    } else {
      for (const x of requests) { if (!x.exam && x.category) x.exam = x.category; delete x.gpbId; }
    }
  }

  const result = {
    range: { from: fromISO.slice(0, 10), to: toISO.slice(0, 10) },
    sites: { requested: wantSites, returned, failed },
    branches: siteList,
    total,
    patients: patientSet.size,
    requests, requestsTruncated, requestKeys,
    byBranch: tallyList(byBranch).map((e) => ({ site: Number(e.key), name: e.name, count: e.count })),
    byDepartment: tallyList(byDept).map((e) => ({ name: e.name, count: e.count })),
    byDoctor: tallyList(byDoctor, topDoctors).map((e) => ({ providerId: e.key, name: e.name, count: e.count })),
    modality,
    financial,
    priority: { emergency, routine },
    aging,
    daily: [...daily.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, count]) => ({ date, count })),
    byHour: hourly,                 // 24 buckets — orders per hour-of-day (peak-hours chart)
    hourHasTime: nonMidnight > 0,   // false → order timestamps are date-only, hide the chart
    // Funnel — only meaningful if the rows carry a stage/accession field; else null → UI hides it.
    byGender: byGender.size ? tallyList(byGender).map((e) => ({ name: e.name, count: e.count })) : null,
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
    const withList = String(req.query.list || '') === '1';     // drill-down request rows
    const noCache = String(req.query.nocache || '') === '1';   // Refresh button → truly live
    const data = await radiologyStats({ from, to, sites, withModality, withFinance, withList, noCache });
    return res.json({ ok: true, ...data });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message));

// Keep the DEFAULT dashboard view (all branches, last 30 days, full enrichment)
// pre-computed in the cache, so a manager opening the page gets it instantly
// instead of waiting for ~1500 per-order bill reads. The cache key is
// {from,to,sites,withModality,withFinance}, so the warm run must use the EXACT
// same from/to the dashboard sends — which is the KSA 30-day preset (see the
// dashboard's rsPresetRange). Using UTC dates here produced a different key, so
// the warm result was never actually served and managers paid the full cost.
function _ksaToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) { return new Date().toISOString().slice(0, 10); }
}
function _defaultRange() {                       // mirrors dashboard rsPresetRange('30d')
  const to = _ksaToday();
  const [y, mo, da] = to.split('-').map(Number);
  const base = new Date(Date.UTC(y, mo - 1, da, 12));
  const from = new Date(base.getTime() - 29 * 864e5).toISOString().slice(0, 10);
  return { from, to };
}
async function warmDefaultStats() {
  try {
    const { from, to } = _defaultRange();
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
  // Self-scheduling (NOT setInterval): re-warm 4 min AFTER each run finishes, so a
  // slow run (>4 min of bill reads) can never overlap itself and double the load.
  const reWarm = () => setTimeout(async () => { await warmDefaultStats(); reWarm(); }, 240000);
  reWarm();
});
