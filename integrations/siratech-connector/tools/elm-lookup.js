#!/usr/bin/env node
/**
 * elm-lookup.js — "enter a national ID → who is this person?" via Siratech's own
 * national-registry endpoints. Run on the KSA VPS.
 *
 *   node elm-lookup.js <nationalId> [dateOfBirth YYYY-MM-DD]
 *   e.g.  node elm-lookup.js 1123724823 1970-05-01
 *
 * It logs into Siratech (headless, same as the connector) and calls, on the
 * SAME patient-api we already reach:
 *   • POST Patient/ELMData                 — علم / Yakeen national identity by ID
 *   • GET  Patient/NPHIESPatientRegistry   — Nphies patient registry (needs ID + DOB)
 * then prints the raw response so we can see exactly what comes back.
 *
 * ⚠ THESE ARE LIVE, BILLED, REGULATED GOVERNMENT QUERIES. Each call to علم/Yakeen
 * or Nphies costs money and is logged (Siratech itself keeps CreateElmNphiesLog /
 * SaveDiscoveryEligLog). Only run for a person you have a legitimate basis/consent
 * to look up. The tool refuses to run without an explicit --yes to prevent an
 * accidental fire. It stops ELMData attempts on the first success to avoid extra
 * billed calls.
 */
'use strict';
const path = require('path');
const fs = require('fs');

// optional .env (creds normally come from the running service's env — see README)
try { const p = path.join(__dirname, '..', '.env');
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
} catch (e) {}

let puppeteer;
{ const { createRequire } = require('module');
  const tries = [ () => createRequire(path.join(__dirname, '..', 'server.js'))('puppeteer'),
    () => require(path.join(__dirname, '..', 'node_modules', 'puppeteer')),
    () => require('puppeteer'), () => require('puppeteer-core') ];
  let le; for (const t of tries) { try { puppeteer = t(); break; } catch (e) { le = e; } }
  if (!puppeteer) { console.error('✗ puppeteer not loadable: ' + String(le && le.message || le).slice(0,120)); process.exit(1); } }

const HIS_BASE = (process.env.HIS_BASE || 'https://his.meena-health.com').replace(/\/+$/, '');
const HIS_USER = process.env.HIS_USER || '', HIS_PASS = process.env.HIS_PASS || '', HIS_SITE = process.env.HIS_SITE || '';
const HOSPITAL_ID = Number(process.env.RESULT_SITE || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2).filter((a) => a !== '--yes');
const CONFIRMED = process.argv.includes('--yes');
const ID = (args[0] || '').replace(/\D/g, '');
// DOB may be a comma-separated list of candidates (Hijri and/or Gregorian, any
// format) — Saudi records are Hijri, so we try each until one matches.
const DOBS = (args[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
const DOB = DOBS[0] || '';

if (!HIS_USER || !HIS_PASS) { console.error('✗ HIS_USER/HIS_PASS not set (load the service env — see README).'); process.exit(1); }
if (!/^\d{10}$/.test(ID)) { console.error('✗ pass a 10-digit national ID.  node elm-lookup.js <id> [dob]'); process.exit(1); }
if (!CONFIRMED) {
  console.error('⚠ This fires LIVE, BILLED government identity queries (علم/Yakeen + Nphies) for ' + ID + '.');
  console.error('  Only for a person you have a legitimate basis/consent to look up.');
  console.error('  Re-run with --yes to confirm:   node elm-lookup.js ' + ID + (DOB ? ' ' + DOB : '') + ' --yes');
  process.exit(2);
}

async function login() {
  const browser = await puppeteer.launch({ headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'] });
  let auth = '', hospitalid = '';
  const apiBases = {};   // module (e.g. "ins-approval-api") → full base "https://…/ins-approval-api/api/v1"
  try {
    const page = await browser.newPage();
    page.on('request', (r) => { const u = r.url(); const h = r.headers();
      const m = u.match(/^(https?:\/\/[^/]+\/([\w-]+-api)\/api\/v\d+)\//i);
      if (m) { apiBases[m[2].toLowerCase()] = m[1]; if (h.authorization && !auth) auth = h.authorization; if (h.hospitalid && !hospitalid) hospitalid = h.hospitalid; } });
    await page.goto(HIS_BASE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
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
    await sleep(12000);
    if (!auth) throw new Error('login yielded no token');
    return { auth, hospitalid: hospitalid || '', apiBases };
  } finally { await browser.close().catch(() => {}); }
}
// call by ABSOLUTE url (base URLs differ per module)
async function callAbs(tok, method, url, body) {
  const res = await fetch(url, { method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*',
      Authorization: tok.auth, hospitalid: tok.hospitalid,
      clienttimezoneoffsetinminutes: '-180', localtimezoneoffsetinminutes: '-180', machinename: 'YARWEB_UI' },
    body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch (e) { j = null; }
  return { status: res.status, json: j, text: t };
}
async function call(tok, method, ep, body) {
  const res = await fetch(HIS_BASE + ep, { method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*',
      Authorization: tok.auth, hospitalid: tok.hospitalid,
      clienttimezoneoffsetinminutes: '-180', localtimezoneoffsetinminutes: '-180', machinename: 'YARWEB_UI' },
    body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch (e) { j = null; }
  return { status: res.status, json: j, text: t };
}
// A real hit = a NAME field with a non-empty string value (not just the schema
// keys present with null values, as an error/empty response returns).
function hasPersonName(o) {
  if (o == null || typeof o !== 'object') return false;
  for (const k of Object.keys(o)) { const v = o[k];
    if (typeof v === 'string' && v.trim() && /name/i.test(k) && !/username|hospitalname|filename|providername|nationalityname/i.test(k)) return true;
    if (v && typeof v === 'object' && hasPersonName(v)) return true;
  }
  return false;
}
const looksLikePerson = (r) => r.status === 200 && hasPersonName(r.json);

const elmMsg = (r) => (r && r.json && (r.json.errorMessage || (r.json.data && r.json.data.errorMessage))) || '';
// pick the Gregorian DOB candidates (year >= 1900) and render the exact ISO shape
// the app builds: new Date(Date.UTC(y,m,d)).toISOString()
function gregIso(list) {
  const out = [];
  for (const s of list) { const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s); if (!m) continue;
    const y = +m[1], mo = +m[2], d = +m[3]; if (y < 1900) continue;
    out.push(new Date(Date.UTC(y, mo - 1, d)).toISOString()); }
  return out;
}

(async () => {
  console.log(`── national-registry lookup — ID ${ID}${DOB ? ' · DOB ' + DOB : ''} (LIVE/billed) ──`);
  const tok = await login();
  console.log('  login OK. api bases seen: ' + Object.keys(tok.apiBases).join(', '));
  const P = HIS_BASE + '/patient-api/api/v1';

  // ── resolve the insurance-approval base + the SAUDIID / IQAMA idType (genLookUpId).
  // idType in the ELMData payload is a site-specific genLookUpId read from
  // Ins_Approval_API/InsuranceApprovalCommon/IdentifyingDocs (each item: {lookUpValue, genLookUpId}).
  let insBase = tok.apiBases['ins-approval-api'] || tok.apiBases['insurance-approval-api'] || tok.apiBases['insuranceapproval-api'] || '';
  const insCandidates = insBase ? [insBase]
    : ['insurance-approval-api','ins-approval-api','insuranceapproval-api','insurance-api','claims-api'].map((m) => `${HIS_BASE}/${m}/api/v1`);
  let saudiGenId = '', iqamaGenId = '', docsFrom = '';
  for (const base of insCandidates) {
    let r; try { r = await callAbs(tok, 'GET', `${base}/InsuranceApprovalCommon/IdentifyingDocs`); } catch (e) { continue; }
    const rows = (r.json && (r.json.data || r.json.Data || r.json)) || [];
    const arr = Array.isArray(rows) ? rows : [];
    if (r.status === 200 && arr.length) {
      const saudi = arr.find((x) => /saudi/i.test(x.lookUpValue || x.lookupValue || x.description || ''));
      const iqama = arr.find((x) => /iqama/i.test(x.lookUpValue || x.lookupValue || x.description || ''));
      saudiGenId = saudi && (saudi.genLookUpId || saudi.genLookupId || saudi.id) || '';
      iqamaGenId = iqama && (iqama.genLookUpId || iqama.genLookupId || iqama.id) || '';
      docsFrom = base;
      console.log(`  IdentifyingDocs from ${base.replace(HIS_BASE,'')} → SAUDIID genLookUpId=${saudiGenId} · IQAMA=${iqamaGenId}`);
      break;
    }
  }
  if (!saudiGenId) console.log('  ⚠ could not resolve SAUDIID genLookUpId (ins-approval base not found or shape differs).');

  // ── علم / Yakeen — Patient/ELMData with the EXACT payload the app builds:
  //    {idType, dob(ISO), idNumber, ninOrIqamaNumber, requestType, hasDuplicateId, hospitalId}
  const idType = /^2\d{9}$/.test(ID) ? iqamaGenId : saudiGenId;   // Iqama starts 2, else Saudi
  const isoDobs = gregIso(DOBS);
  let elmHit = null;
  if (idType && isoDobs.length) {
    for (const dob of isoDobs) {
      const body = { idType, dob, idNumber: ID, ninOrIqamaNumber: ID, requestType: idType, hasDuplicateId: false, hospitalId: HOSPITAL_ID };
      let r; try { r = await callAbs(tok, 'POST', `${P}/Patient/ELMData`, body); }
      catch (e) { console.log(`  ELMData dob=${dob} → ERROR ${String(e.message||e).slice(0,80)}`); continue; }
      const msg = elmMsg(r);
      console.log(`  ELMData dob=${dob} → HTTP ${r.status}` + (msg ? `  msg="${msg}"` : `  body=${String(r.text).slice(0,160).replace(/\s+/g,' ')}`));
      if (looksLikePerson(r)) { elmHit = r; break; }
    }
  } else {
    console.log(`  (skip ELMData — need ${!idType ? 'the SAUDIID idType' : ''}${!idType && !isoDobs.length ? ' and ' : ''}${!isoDobs.length ? 'a Gregorian DOB' : ''})`);
  }
  if (elmHit) console.log('\n  ✅ ELMData returned a person:\n' + JSON.stringify(elmHit.json, null, 2).slice(0, 2500));
  else console.log('\n  ELMData: no person yet.');

  // ── Nphies patient registry — GET (needs ID + DOB). Currently gated by Siratech's
  //    Nphies access token; included so we confirm the moment that token is refreshed.
  if (DOBS.length && !elmHit) {
    for (const dob of DOBS) {
      const ep = `${P}/Patient/NPHIESPatientRegistry?idNumber=${encodeURIComponent(ID)}&dateOfBirth=${encodeURIComponent(dob)}&hospitalId=${HOSPITAL_ID}&mrno=`;
      let r; try { r = await callAbs(tok, 'GET', ep); } catch (e) { continue; }
      const msg = elmMsg(r);
      console.log(`  NPHIESPatientRegistry dob=${dob} → HTTP ${r.status}` + (msg ? `  msg="${String(msg).slice(0,80).replace(/\s+/g,' ')}"` : ''));
      if (looksLikePerson(r)) { console.log('\n  ✅ Nphies registry returned a person:\n' + JSON.stringify(r.json, null, 2).slice(0, 2500)); break; }
    }
  }
  console.log('\n── done ──');
  process.exit(0);
})().catch((e) => { console.error('\n✗ ' + (e && e.message || e)); process.exit(3); });
