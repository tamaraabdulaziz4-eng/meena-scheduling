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

process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message));

app.listen(PORT, HOST, () => console.log(`Siratech connector listening on ${HOST}:${PORT}`));
