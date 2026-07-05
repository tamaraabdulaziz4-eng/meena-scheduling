#!/usr/bin/env node
/**
 * lab-discovery.js — READ-ONLY probe to find Siratech's LAB results endpoint,
 * specifically the pregnancy / β-hCG test, so we can surface it on the radiology
 * worklist before imaging a female patient.
 *
 * Radiology rides investigation-api with baseInvCategoryId=2. Labs are the SAME
 * system under a different category (usually 1). This script tries the likely lab
 * endpoints / categories for a given patient and reports which returns lab rows +
 * whether a pregnancy/hCG test is present, with the exact field names.
 *
 * Runs ON THE VPS (reuses the connector's headless login + env). Writes NOTHING.
 *
 *   cd integrations/siratech-connector/tools
 *   node lab-discovery.js <MRN>        # a patient who has a pregnancy/hCG lab test
 *
 * Reads HIS_BASE/HIS_USER/HIS_PASS/HIS_SITE + RESULT_SITE from the connector .env.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// load connector .env
try {
  const p = path.join(__dirname, '..', '.env');
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* env optional */ }

// Resolve puppeteer the way the running connector does, regardless of node_modules layout.
let puppeteer;
{
  const { createRequire } = require('module');
  const tries = [
    () => createRequire(path.join(__dirname, '..', 'server.js'))('puppeteer'),
    () => require(path.join(__dirname, '..', 'node_modules', 'puppeteer')),
    () => require('puppeteer'),
    () => require('puppeteer-core'),
  ];
  let lastErr;
  for (const t of tries) { try { puppeteer = t(); break; } catch (e) { lastErr = e; } }
  if (!puppeteer) {
    console.error('✗ Could not load puppeteer. From the connector dir run:  npm ls puppeteer');
    console.error('  (last error: ' + String(lastErr && lastErr.message || lastErr).slice(0, 140) + ')');
    process.exit(1);
  }
}

const HIS_BASE = (process.env.HIS_BASE || 'https://his.meena-health.com').replace(/\/+$/, '');
const HIS_USER = process.env.HIS_USER || '';
const HIS_PASS = process.env.HIS_PASS || '';
const HIS_SITE = process.env.HIS_SITE || '';
const RESULT_SITE = Number(process.env.RESULT_SITE || 3);
const MRN = (process.argv[2] || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!HIS_USER || !HIS_PASS) { console.error('✗ HIS_USER / HIS_PASS not set.'); process.exit(1); }
if (!MRN) { console.error('✗ Pass a patient MRN who has a pregnancy/hCG lab: node lab-discovery.js 25148940'); process.exit(1); }

const PREG_RE = /hcg|pregnan|b-?\s?hcg|beta[\s-]?hcg|β/i;
const keysOf = (r) => (r && typeof r === 'object' ? Object.keys(r) : []);
function findPregnancy(rows) {
  const hits = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const blob = JSON.stringify(r);
    if (PREG_RE.test(blob)) {
      // pull the likely name + value/result fields
      const name = r.serviceName || r.testName || r.invMastServiceName || r.serviceDescription || r.investigationName || '';
      const val = r.result || r.resultValue || r.value || r.stringResult || r.observedValue || r.finalResult || '';
      hits.push({ name: String(name).slice(0, 60), value: String(val).slice(0, 60), keys: keysOf(r) });
    }
  }
  return hits;
}

async function login() {
  const browser = await puppeteer.launch({ headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  try {
    const page = await browser.newPage();
    let auth = '', hospitalid = '';
    page.on('request', (r) => { if (/-api\/api\/v1\//i.test(r.url())) { const h = r.headers();
      if (h.authorization && !auth) auth = h.authorization; if (h.hospitalid && !hospitalid) hospitalid = h.hospitalid; } });
    await page.goto(HIS_BASE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('#mat-input-0', { timeout: 25000 });
    await page.click('#mat-input-0'); await page.type('#mat-input-0', HIS_USER, { delay: 50 });
    await page.keyboard.press('Tab'); await sleep(3500);
    const site = (await page.$('#focusablesite')) || (await page.$('mat-select'));
    if (site) { await site.click(); await sleep(1500); const opts = await page.$$('mat-option'); let picked = false;
      if (HIS_SITE) for (const o of opts) { const t = (await o.evaluate((e) => e.innerText)).trim();
        if (t.toLowerCase().includes(HIS_SITE.toLowerCase())) { await o.click(); picked = true; break; } }
      if (!picked && opts[0]) await opts[0].click(); await sleep(1000); }
    await page.click('#passFocus'); await page.type('#passFocus', HIS_PASS, { delay: 50 }); await sleep(400);
    const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((e) => /login/i.test(e.innerText)));
    if (btn) await btn.click().catch(() => {});
    await sleep(9000);
    if (!auth) throw new Error('login yielded no token (selectors/creds/site?)');
    return { auth, hospitalid: hospitalid || '' };
  } finally { await browser.close().catch(() => {}); }
}
async function post(tok, ep, body) {
  const res = await fetch(HIS_BASE + ep, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', Authorization: tok.auth, hospitalid: tok.hospitalid },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch (e) { j = null; } return { status: res.status, json: j };
}
function searchBody(cat, filterResult) {
  const today = new Date().toISOString().slice(0, 10);
  const y = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);   // 120-day look-back for labs
  return { mrno: MRN, billno: '', fromDate: `${y}T00:00:00.000Z`, toDate: `${today}T23:59:59.000Z`,
    baseCatgeory: 0, hospitalId: RESULT_SITE, mode: 6, cpoeStatus: 0, isbilled: 0,
    empId: String(HIS_USER).padStart(8, '0'), visitno: '', selectionType: 2, filterResult,
    profileId: '', invCategoryId: null, baseInvCategoryId: cat, visitMode: '', invMastServiceId: 0,
    sampleNo: '', isCreditWithoutBilling: 0, cpoeSearchGroupMode: 0, searchType: 'B', visiType: '0', isFrequent: 1 };
}

(async () => {
  console.log(`── Siratech LAB discovery (read-only) — MRN ${MRN} ──`);
  const tok = await login();
  console.log(`  login OK. Probing lab endpoints…\n`);
  const probes = [
    // (label, endpoint, body) — the general investigation search under different categories,
    // plus guessed lab-specific controllers. filterResult 2 = has a result.
    ['investigation-api ResultEntryLaboratory/LaboratorySearch (cat1)', '/investigation-api/api/v1/ResultEntryLaboratory/LaboratorySearch', searchBody(1, '2')],
    ['investigation-api ResultEntry/Search (cat1)', '/investigation-api/api/v1/ResultEntry/Search', searchBody(1, '2')],
    ['investigation-api RadiologySearch body but cat1 (labs?)', '/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', searchBody(1, '2')],
    ['investigation-api RadiologySearch cat0 (all investigations?)', '/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', searchBody(0, '2')],
    ['emr-api EMR/FetchLabPanel', '/emr-api/api/v1/EMR/FetchLabPanel', { mrno: MRN, fromDate: new Date(Date.now()-120*864e5).toISOString().slice(0,10)+'T00:00:00', toDate: new Date().toISOString().slice(0,10)+'T23:59:59', invMastServiceId: 0, userId: String(HIS_USER).padStart(8,'0'), hospitalId: RESULT_SITE }],
    ['emr-api EMR/FetchLabDetails', '/emr-api/api/v1/EMR/FetchLabDetails', { mrno: MRN, hospitalId: RESULT_SITE, userId: String(HIS_USER).padStart(8,'0') }],
    ['emr-api EMR/FetchInvestigationDetails', '/emr-api/api/v1/EMR/FetchInvestigationDetails', { mrno: MRN, hospitalId: RESULT_SITE, userId: String(HIS_USER).padStart(8,'0') }],
  ];
  const report = { mrno: MRN, base: HIS_BASE, probes: [] };
  for (const [label, ep, body] of probes) {
    let r; try { r = await post(tok, ep, body); } catch (e) { console.log(`  ${label}\n     ✗ ${String(e.message||e)}`); report.probes.push({ label, ep, error: String(e.message||e) }); continue; }
    const rows = (r.json && (r.json.data || r.json)) || [];
    const arr = Array.isArray(rows) ? rows : [];
    const preg = findPregnancy(arr);
    console.log(`  ${label}`);
    console.log(`     HTTP ${r.status} · ${arr.length} row(s)` + (arr[0] ? ` · keys: ${keysOf(arr[0]).slice(0,10).join(',')}` : ''));
    if (preg.length) console.log(`     ✓ PREGNANCY/hCG FOUND: ${preg.map(p=>`"${p.name}"=${p.value||'(no value field found)'}`).join(' | ')}`);
    report.probes.push({ label, ep, status: r.status, rowCount: arr.length, firstRowKeys: keysOf(arr[0]), pregnancyHits: preg });
    await sleep(300);
  }
  const out = path.join(__dirname, 'lab-discovery-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const winner = report.probes.find((p) => p.pregnancyHits && p.pregnancyHits.length);
  console.log('\n── verdict ──');
  if (winner) {
    console.log(`  ✓ Pregnancy test reachable via: ${winner.label}`);
    console.log(`    → I'll wire this endpoint to show the β-hCG result on the worklist before imaging.`);
  } else {
    const anyRows = report.probes.find((p) => p.rowCount > 0);
    if (anyRows) console.log(`  ~ Lab rows found via "${anyRows.label}" but no pregnancy test on this patient — try an MRN who has one, or send me the report so I can see the field names.`);
    else console.log(`  ✗ No lab endpoint matched. Send me lab-discovery-report.json — I'll adjust the endpoint guesses.`);
  }
  console.log(`\n  Full report: ${out}  (send it to me)`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ ' + (e && e.message || e)); process.exit(2); });
