#!/usr/bin/env node
/**
 * harvest-payloads.js — READ-ONLY Siratech endpoint & payload harvester.
 *
 * Runs ON THE VPS (reuses the connector's own headless login + env), so it captures
 * the REAL requests/responses Siratech makes — far more accurate than hand-copying
 * from a browser's DevTools. Writes nothing to the HIS; only logins + reads/searches.
 *
 * It answers, with evidence:
 *   1. Does ANY endpoint return the accession per order? (retire the MWL agent)
 *   2. Is there a WebSocket / live-update channel? (instant board, no polling)
 *   3. What do the resulted-queue + order-detail responses actually contain?
 *
 * Usage (in this folder, on the VPS):
 *   node harvest-payloads.js            # auto-discovers a real order for today
 *   node harvest-payloads.js 25148940   # focus on a specific MRN
 *
 * Reads the connector's env (HIS_BASE/HIS_USER/HIS_PASS/HIS_SITE, RESULT_SITE).
 * Requires the connector's node_modules (puppeteer) — run from this directory.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Load the connector's .env if present (same dir up one level).
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (e) { /* env is optional if already exported */ }

let puppeteer;
try { puppeteer = require(path.join(__dirname, '..', 'node_modules', 'puppeteer')); }
catch (e) { try { puppeteer = require('puppeteer'); } catch (e2) {
  console.error('✗ puppeteer not found. Run this from the connector folder on the VPS (where node_modules exists).');
  process.exit(1);
} }

const HIS_BASE = (process.env.HIS_BASE || 'https://his.meena-health.com').replace(/\/+$/, '');
const HIS_USER = process.env.HIS_USER || '';
const HIS_PASS = process.env.HIS_PASS || '';
const HIS_SITE = process.env.HIS_SITE || '';
const RESULT_SITE = Number(process.env.RESULT_SITE || 3);
const FOCUS_MRN = (process.argv[2] || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!HIS_USER || !HIS_PASS) { console.error('✗ HIS_USER / HIS_PASS not set (connector .env).'); process.exit(1); }

// ── accession-shaped value detector ───────────────────────────────────────────
const looksAccession = (v) => {
  const s = String(v == null ? '' : v).trim();
  return /^SIRA\d{3,}$/i.test(s) || /^[A-Z]{1,4}\d{5,}$/.test(s);   // SIRA1661 or N3####/CR03000444526
};
// Walk any JSON, collect where accession-like values or accession-named keys live.
function scanAccession(obj, hits = [], keyPath = '') {
  if (obj == null) return hits;
  if (Array.isArray(obj)) { obj.slice(0, 3).forEach((v, i) => scanAccession(v, hits, `${keyPath}[${i}]`)); return hits; }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const named = /acc(ession)?/i.test(k);
      if ((named || looksAccession(v)) && v != null && typeof v !== 'object' && String(v).trim() !== '') {
        hits.push({ key: `${keyPath}.${k}`.replace(/^\./, ''), value: String(v).slice(0, 40), byName: named });
      }
      if (typeof v === 'object') scanAccession(v, hits, `${keyPath}.${k}`.replace(/^\./, ''));
    }
  }
  return hits;
}
const keysOf = (row) => (row && typeof row === 'object' ? Object.keys(row) : []);

const report = { base: HIS_BASE, when: new Date().toISOString(), endpointsSeen: [], websockets: [], probes: {}, accessionFindings: [] };

// ── headless login (mirrors the connector's doHeadlessLogin) + capture ────────
async function loginAndCapture() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--no-zygote', '--disable-extensions'],
  });
  try {
    const page = await browser.newPage();
    let auth = '', hospitalid = '';
    const seen = new Set();
    page.on('request', (r) => {
      const u = r.url();
      if (/-api\/api\/v1\//i.test(u)) {
        const h = r.headers();
        if (h.authorization && !auth) auth = h.authorization;
        if (h.hospitalid && !hospitalid) hospitalid = h.hospitalid;
        const ep = u.replace(HIS_BASE, '').split('?')[0];
        if (!seen.has(ep)) { seen.add(ep); report.endpointsSeen.push(ep); }
      }
    });
    // WebSocket / live-update capture via CDP.
    try {
      const cdp = await page.target().createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.webSocketCreated', ({ url }) => { if (!report.websockets.includes(url)) report.websockets.push(url); });
    } catch (e) { /* CDP optional */ }

    await page.goto(HIS_BASE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('#mat-input-0', { timeout: 25000 });
    await page.click('#mat-input-0');
    await page.type('#mat-input-0', HIS_USER, { delay: 50 });
    await page.keyboard.press('Tab');
    await sleep(3500);
    const site = (await page.$('#focusablesite')) || (await page.$('mat-select'));
    if (site) {
      await site.click(); await sleep(1500);
      const opts = await page.$$('mat-option');
      let picked = false;
      if (HIS_SITE) for (const o of opts) {
        const t = (await o.evaluate((e) => e.innerText)).trim();
        if (t.toLowerCase().includes(HIS_SITE.toLowerCase())) { await o.click(); picked = true; break; }
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
    console.log('  logging in + capturing for ~40s (websockets, endpoints the app loads)…');
    await sleep(40000);   // let the SPA load its dashboard so we catch its auto-calls + any WS
    if (!auth) throw new Error('login did not yield an auth token (selectors/creds/site?)');
    return { auth, hospitalid: hospitalid || '' };
  } finally { await browser.close().catch(() => {}); }
}

// ── direct probes with the captured token (reads only) ────────────────────────
async function hisPost(tok, epPath, body) {
  const res = await fetch(HIS_BASE + epPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*',
               Authorization: tok.auth, hospitalid: tok.hospitalid },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json };
}
async function hisGet(tok, epPath) {
  const res = await fetch(HIS_BASE + epPath, {
    method: 'GET', headers: { Accept: 'application/json, text/plain, */*',
      Authorization: tok.auth, hospitalid: tok.hospitalid }, signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json };
}

function searchBody(mrno, filterResult, extra) {
  const today = new Date().toISOString().slice(0, 10);
  return Object.assign({
    mrno: mrno || '', billno: '', fromDate: `${today}T00:00:00.000Z`, toDate: `${today}T23:59:59.000Z`,
    baseCatgeory: 0, hospitalId: RESULT_SITE, mode: 6, cpoeStatus: 0, isbilled: 0,
    empId: String(HIS_USER).padStart(8, '0'), visitno: '', selectionType: 1, filterResult,
    profileId: '', invCategoryId: null, baseInvCategoryId: 2, visitMode: '', invMastServiceId: 0,
    sampleNo: '', isCreditWithoutBilling: 0, cpoeSearchGroupMode: 0, searchType: 'B', visiType: '0',
  }, extra || {});
}

function record(name, resp) {
  const rows = (resp.json && resp.json.data) || [];
  const first = Array.isArray(rows) ? rows[0] : rows;
  const acc = scanAccession(resp.json);
  report.probes[name] = { status: resp.status, rowCount: Array.isArray(rows) ? rows.length : (first ? 1 : 0),
    firstRowKeys: keysOf(first), accessionFieldsHere: acc.slice(0, 8) };
  for (const a of acc) report.accessionFindings.push({ endpoint: name, ...a });
  console.log(`  ${name}: HTTP ${resp.status}, ${report.probes[name].rowCount} row(s)` +
    (acc.length ? `  ← ACCESSION-LIKE: ${acc.slice(0, 3).map((x) => `${x.key}=${x.value}`).join(', ')}` : ''));
}

(async () => {
  console.log(`── Siratech payload harvest (read-only) — ${HIS_BASE} ──`);
  const tok = await loginAndCapture();
  console.log(`  login OK (token len ${tok.auth.length}). Probing endpoints…`);

  // 1) pending order for today → get a real MRN/bill to drill into
  const pending = await hisPost(tok, '/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch',
    searchBody(FOCUS_MRN, '0'));
  record('RadiologySearch(pending,filter0)', pending);
  // 2) the RESULTED / auth queue (the payload you captured: filter2/selType2/isFrequent1)
  const resulted = await hisPost(tok, '/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch',
    searchBody(FOCUS_MRN, '2', { selectionType: 2, isFrequent: 1 }));
  record('RadiologySearch(resulted,filter2)', resulted);

  const sample = ((pending.json && pending.json.data) || [])[0] || ((resulted.json && resulted.json.data) || [])[0];
  if (sample) {
    const mrno = sample.mrno, bill = sample.billNo;
    console.log(`  drilling into MRN ${mrno} bill ${bill}…`);
    // 3) per-order detail (where the connector reads accessionNumber from)
    const details = await hisPost(tok, '/investigation-api/api/v1/ResultEntryRadiology/RadiologyDetails',
      Object.assign(searchBody(mrno, '0'), { billNo: bill, genPatBillingId: sample.genPatBillingId }));
    record('RadiologyDetails', details);
    // 4) RIS panel (has serviceName + risOrderStatus + emrPatDtlsInvOrderId)
    const today = new Date().toISOString().slice(0, 10);
    const ris = await hisPost(tok, '/emr-api/api/v1/EMR/FetchRISPanel', {
      mrno, fromDate: today + 'T00:00:00', toDate: today + 'T23:59:59', invMastServiceId: 0,
      apptResourceCategoryId: 0, apptResourceId: 0, providerId: '', serviceCategoryId: 0,
      emrPatRisPanelId: 0, userId: String(HIS_USER).padStart(8, '0'), hospitalId: RESULT_SITE });
    record('FetchRISPanel', ris);
    // 5) EMR forward radiology details (the patient-lookup path that reads accessionNumber)
    const emr = await hisPost(tok, '/emr-api/api/v1/EMR/FetchRadiologyDetails', {
      mrno, hospitalId: RESULT_SITE, fromDate: today + 'T00:00:00', toDate: today + 'T23:59:59',
      userId: String(HIS_USER).padStart(8, '0') });
    record('FetchRadiologyDetails', emr);
  } else {
    console.log('  no order found today to drill into — pass an MRN with orders: node harvest-payloads.js <MRN>');
  }

  const out = path.join(__dirname, 'harvest-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\n── summary ──────────────────────────────────────────────');
  console.log(`  endpoints the app called: ${report.endpointsSeen.length}`);
  console.log(`  websockets / live channels: ${report.websockets.length ? report.websockets.join(', ') : 'NONE (board must poll)'}`);
  if (report.accessionFindings.length) {
    console.log('  ✓ ACCESSION FOUND on the order side:');
    const uniq = {};
    for (const a of report.accessionFindings) uniq[`${a.endpoint} → ${a.key}`] = a.value;
    for (const k of Object.keys(uniq)) console.log(`      ${k} = ${uniq[k]}`);
    console.log('    → if these are real SIRA accessions on the ORDER, we can retire the MWL agent.');
  } else {
    console.log('  ✗ no accession on any order-side response — MWL agent stays the source.');
  }
  console.log(`\n  Full report written to: ${out}`);
  console.log('  Send me that harvest-report.json (or paste the summary above).');
  process.exit(0);
})().catch((e) => { console.error('\n✗ ' + (e && e.message || e)); process.exit(2); });
