// ── MILLENSYS MiClinic (RadCare Health) client — READ-ONLY ────────────────────
//
// Cross-system MRI/CT match: given a Siratech patient's NATIONAL ID and the ORDER
// DATE, find the matching report in RadCare's MILLENSYS MiClinic (which Meena's own
// Siratech/DePACS stack does not carry). Every endpoint here was confirmed live
// against the MiClinic SPA — see MILLENSYS-INTEGRATION-MAP.md. All calls are reads
// (patient search + grid reads); nothing is written.
//
// The confirmed chain (national ID → report):
//   POST CommonPages/GetPatients        SsnNumber=<nid> & PSearchCriteria=4   → PatientId
//   POST CommonPages/EncouterDataGetById  patid=<PatientId> & branchid=0       → EncounterId
//   GET  CommonPages/EncouterServicesId?EncounterId=<id>                       → services (AccountServiceId, ClinicName, ServiceDate, ClinicReportsCount, VisitId)
//   GET  PatientSummaryPrintSetting/GetResaultsGridData?PatientId=&VisitId=&EncounterId=  → ClinicalReportId, ReportName, FilePath, ReportStatusDate
//
// Auth: the SPA is session-based (no bearer). Supply a logged-in cookie via
// MILLENSYS_COOKIE (copy from an authenticated MiClinic tab). Base via MILLENSYS_BASE
// (default the RadCare host). Without a cookie every call throws a clear error.

const path = require('path');
const { createRequire } = require('module');

const BASE = (process.env.MILLENSYS_BASE || 'https://mill.radcarehealth.com/MILLENSYS/MiClinic').replace(/\/+$/, '');
// Auth: EITHER a ready session cookie (MILLENSYS_COOKIE) OR credentials the connector
// uses to log in via a headless browser (MILLENSYS_USER / MILLENSYS_PASS — kept in the
// untracked .env, never committed). The login cookie is HttpOnly, so a browser login is
// the only way to obtain it; puppeteer can read it, a plain fetch cannot.
const LOGIN_URL = (process.env.MILLENSYS_LOGIN_URL || BASE).replace(/\/+$/, '');
const USER = process.env.MILLENSYS_USER || '';
const PASS = process.env.MILLENSYS_PASS || '';
// Match window: a report belongs to an order only if it is dated ON/AFTER the order,
// within this many days after it (a report is produced after the exam, never before).
const FORWARD_DAYS = Number(process.env.MILLENSYS_FORWARD_DAYS || 120);

let _cookie = process.env.MILLENSYS_COOKIE || null;   // current session cookie header
let _loginInFlight = null;

function configured() { return !!(_cookie || (USER && PASS)); }
function setCookie(c) { _cookie = c || null; }

function loadPuppeteer() {
  const tries = [
    () => createRequire(path.join(__dirname, 'server.js'))('puppeteer'),
    () => require(path.join(__dirname, 'node_modules', 'puppeteer')),
    () => require('puppeteer'),
    () => require('puppeteer-core'),
  ];
  let le;
  for (const t of tries) { try { return t(); } catch (e) { le = e; } }
  throw new Error('puppeteer not loadable: ' + String((le && le.message) || le).slice(0, 120));
}

// Log in with a headless browser and capture the (HttpOnly) session cookie. Fills the
// login form generically: the password input + the first visible text/username input.
// Returns the Cookie header string. Verbose when MILLENSYS_DEBUG=1.
async function loginWithBrowser() {
  if (!(USER && PASS)) throw new Error('MILLENSYS_USER / MILLENSYS_PASS not set — cannot log in.');
  const dbg = String(process.env.MILLENSYS_DEBUG || '') === '1';
  const pp = loadPuppeteer();
  const browser = await pp.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('input[type=password]', { timeout: 30000 });
    if (dbg) {
      const form = await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => ({ id: i.id, name: i.name, type: i.type })));
      console.log('[millensys] login form inputs:', JSON.stringify(form));
      console.log('[millensys] login url:', page.url());
    }
    // Username = first visible text/email/untyped input; Password = the password input.
    const userSel = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')];
      const u = inputs.find((i) => /^(text|email|tel|)$/i.test(i.type || '') && i.offsetParent !== null);
      if (!u) return null; if (!u.id) u.id = '__msuser'; return '#' + u.id;
    });
    const pwSel = await page.evaluate(() => { const p = document.querySelector('input[type=password]'); if (!p.id) p.id = '__mspass'; return '#' + p.id; });
    if (userSel) { await page.click(userSel); await page.type(userSel, USER, { delay: 30 }); }
    await page.click(pwSel); await page.type(pwSel, PASS, { delay: 30 });
    await Promise.all([
      page.keyboard.press('Enter'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
    ]);
    // Submit button fallback if Enter didn't navigate.
    if (/login|signin|account/i.test(page.url())) {
      const btn = await page.$('button[type=submit], input[type=submit], button');
      if (btn) { await Promise.all([btn.click().catch(() => {}), page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})]); }
    }
    const cookies = await page.cookies();
    const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (dbg) console.log('[millensys] post-login url:', page.url(), '| cookie names:', cookies.map((c) => c.name).join(','));
    // Sanity: a real session cookie (not just the WAF cookies) must be present.
    const hasSession = cookies.some((c) => /session|auth|aspx|millensys|\.mi|token/i.test(c.name) && !/HWWAF/i.test(c.name));
    if (!hasSession) throw new Error('login did not yield a session cookie (only ' + cookies.map((c) => c.name).join(',') + ') — check credentials / login URL, or run with MILLENSYS_DEBUG=1.');
    return header;
  } finally { await browser.close().catch(() => {}); }
}

async function ensureCookie() {
  if (_cookie) return _cookie;
  if (USER && PASS) {
    if (!_loginInFlight) _loginInFlight = loginWithBrowser().then((c) => { _cookie = c; return c; }).finally(() => { _loginInFlight = null; });
    return _loginInFlight;
  }
  throw new Error('MILLENSYS auth: set MILLENSYS_COOKIE, or MILLENSYS_USER + MILLENSYS_PASS for browser login.');
}

// MILLENSYS serialises dates as "/Date(1783788632950)/" (ms since epoch, sometimes
// with a +offset). Parse to epoch ms, or null.
function parseMsDate(v) {
  if (v == null) return null;
  const m = String(v).match(/\/Date\((-?\d+)([+-]\d+)?\)\//);
  if (m) return Number(m[1]);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const MOD_RE = /\b(MRI|MR|CT|CAT\s*SCAN)\b/i;
function isMrOrCt(...vals) { return vals.some((v) => MOD_RE.test(String(v || ''))); }

// A response that is a login redirect / 401 / an HTML login page means the session
// expired — worth one re-login when we hold credentials.
function looksUnauth(res) {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 300 && res.status < 400) return true;
  if (res.json == null && /type=['"]?password|Account\/Log|txtPassword|loginForm/i.test(res.text || '')) return true;
  return false;
}

async function call(method, pathName, { query, form } = {}, _retried = false) {
  const cookie = await ensureCookie();
  let url = `${BASE}${pathName}`;
  if (query) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(query).toString();
  const headers = { 'X-Requested-With': 'XMLHttpRequest', Cookie: cookie, Accept: 'application/json, text/plain, */*' };
  const opts = { method, headers, redirect: 'manual' };
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  const r = await fetch(url, opts);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_e) { /* HTML/plain */ }
  const res = { status: r.status, json, text };
  if (looksUnauth(res) && !_retried && USER && PASS) { _cookie = null; return call(method, pathName, { query, form }, true); }
  return res;
}

const KENDO = { sort: '', page: '1', pageSize: '50', group: '', filter: '' };
const rows = (r) => (r && r.json && (r.json.Data || r.json.data)) || [];

// national ID / Iqama → patient row(s). Exact match (PSearchCriteria=4).
async function searchByNationalId(nid) {
  const ssn = String(nid || '').trim();
  if (!ssn) return [];
  const r = await call('POST', '/CommonPages/GetPatients', { form: {
    ...KENDO, SsnNumber: ssn, PSearchCriteria: '4',
    PatientCode: '', PatientName: '', MRN: '', PatientDateBirth: '', Gender: '',
    PersonalMobileNumber: '', HomePhoneNumber: '', TypeOfPatientName: '', GivenName: '', MiddleName: '', FamilyName: '',
  } });
  return rows(r);
}

async function encountersFor(patientId) {
  const r = await call('POST', '/CommonPages/EncouterDataGetById', { form: { ...KENDO, patid: String(patientId), branchid: '0' } });
  return rows(r);
}

async function servicesFor(encounterId) {
  const r = await call('GET', '/CommonPages/EncouterServicesId', { query: { ...KENDO, EncounterId: String(encounterId) } });
  return rows(r);
}

// Reports filed for a patient/visit/encounter (ClinicalReportId, ReportName, FilePath, ReportStatusDate).
async function reportsFor({ patientId, visitId, encounterId }) {
  const r = await call('GET', '/PatientSummaryPrintSetting/GetResaultsGridData', { query: {
    ...KENDO, PatientId: String(patientId), VisitId: String(visitId || 0), EncounterId: String(encounterId || 0),
  } });
  return rows(r);
}

// The whole match: national ID (+ optional Siratech order date/name) → matched MRI/CT
// report(s) in RadCare. A report qualifies only if dated ON/AFTER the order date
// (within FORWARD_DAYS). Returns a structured, strict result — it never guesses.
async function matchMriReport({ nationalId, orderDate, serviceName } = {}) {
  const orderMs = orderDate ? parseMsDate(orderDate) || Date.parse(orderDate) : null;
  const afterOrder = (ms) => {
    if (!Number.isFinite(orderMs) || !Number.isFinite(ms)) return null; // unknown → can't judge on date
    const days = (ms - orderMs) / 864e5;
    return days >= -0.5 && days <= FORWARD_DAYS;
  };

  const patients = await searchByNationalId(nationalId);
  if (!patients.length) return { decision: 'no_patient', nationalId, reason: 'no RadCare patient with this national ID' };
  const patient = patients[0];
  const patientId = patient.PatientId;

  const encounters = await encountersFor(patientId);
  const candidates = [];
  for (const enc of encounters) {
    const services = await servicesFor(enc.EncounterId);
    const mrct = services.filter((s) => isMrOrCt(s.ClinicName, s.ServiceName));
    if (!mrct.length) continue;
    // Reports for this encounter's visit(s). Services carry the real VisitId.
    const seenVisits = new Set();
    const reps = [];
    for (const s of mrct) {
      const vid = s.VisitId || enc.VisitId || 0;
      if (seenVisits.has(vid)) continue; seenVisits.add(vid);
      reps.push(...await reportsFor({ patientId, visitId: vid, encounterId: enc.EncounterId }));
    }
    for (const s of mrct) {
      const rep = reps.find((x) => String(x.AccountServiceId) === String(s.AccountServiceId));
      const repMs = rep ? parseMsDate(rep.ReportStatusDate) : null;
      const svcMs = parseMsDate(s.ServiceDate);
      const dateMs = repMs != null ? repMs : svcMs;
      candidates.push({
        encounterId: enc.EncounterId,
        accountServiceId: s.AccountServiceId,
        serviceName: s.ServiceName, clinic: s.ClinicName,
        serviceDate: svcMs, reportDate: repMs,
        hasReport: (s.ClinicReportsCount || 0) > 0 || !!rep,
        clinicalReportId: rep ? rep.ClinicalReportId : null,
        reportName: rep ? rep.ReportName : null,
        filePath: rep ? rep.FilePath : null,
        afterOrder: afterOrder(dateMs),
      });
    }
  }

  // Prefer a candidate that HAS a report AND is dated after the order. If order date is
  // unknown, fall back to any MRI/CT with a report.
  const withReport = candidates.filter((c) => c.hasReport);
  const afterOk = withReport.filter((c) => c.afterOrder === true);
  const chosen = (afterOk[0] || (orderMs == null ? withReport[0] : null)) || null;

  return {
    decision: chosen ? 'match' : (withReport.length ? 'report_before_order' : (candidates.length ? 'mrct_no_report' : 'no_mrct')),
    nationalId,
    patient: { patientId, patientCode: patient.PatientCode, mrn: patient.MRN, encounters: encounters.length },
    matched: chosen,
    candidates,
  };
}

module.exports = {
  configured, setCookie, ensureCookie, loginWithBrowser, BASE, FORWARD_DAYS,
  parseMsDate, isMrOrCt,
  searchByNationalId, encountersFor, servicesFor, reportsFor, matchMriReport,
};
