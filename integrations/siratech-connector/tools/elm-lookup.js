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
  try {
    const page = await browser.newPage();
    page.on('request', (r) => { const h = r.headers();
      if (/-api\/api\/v\d+\//i.test(r.url())) { if (h.authorization && !auth) auth = h.authorization; if (h.hospitalid && !hospitalid) hospitalid = h.hospitalid; } });
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
    await sleep(9000);
    if (!auth) throw new Error('login yielded no token');
    return { auth, hospitalid: hospitalid || '' };
  } finally { await browser.close().catch(() => {}); }
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
const looksLikePerson = (r) => { const s = JSON.stringify(r.json || r.text || '').toLowerCase();
  return r.status === 200 && /name|firstname|dob|dateofbirth|arabic|englishname|fullname/.test(s) && !/^null$/.test(String(r.text).trim()); };

(async () => {
  console.log(`── national-registry lookup — ID ${ID}${DOB ? ' · DOB ' + DOB : ''} (LIVE/billed) ──`);
  const tok = await login();
  console.log('  login OK.\n');
  const P = '/patient-api/api/v1';

  // 1) علم / Yakeen — Patient/ELMData. The earlier run proved the endpoint responds
  //    and the {idNumber,hospitalId} shape reaches it (all field-name variants gave
  //    the SAME error), so the missing piece is the date of birth. Try each DOB
  //    candidate (Hijri first, then Gregorian) with that shape; print the FULL
  //    errorMessage; STOP on the first person returned (avoid extra billed calls).
  const elmMsg = (r) => (r.json && (r.json.errorMessage || (r.json.data && r.json.data.errorMessage))) || '';
  let elmHit = null;
  const elmCandidates = DOBS.length ? DOBS.map((d) => ({ idNumber: ID, dateOfBirth: d, hospitalId: HOSPITAL_ID }))
    : [ { idNumber: ID, hospitalId: HOSPITAL_ID } ];
  for (const b of elmCandidates) {
    let r; try { r = await call(tok, 'POST', `${P}/Patient/ELMData`, b); }
    catch (e) { console.log(`  ELMData dob=${b.dateOfBirth || '(none)'} → ERROR ${String(e.message || e).slice(0,80)}`); continue; }
    const msg = elmMsg(r);
    console.log(`  ELMData dob=${b.dateOfBirth || '(none)'} → HTTP ${r.status}` + (msg ? `  msg="${msg}"` : `  body=${String(r.text).slice(0,160).replace(/\s+/g,' ')}`));
    if (looksLikePerson(r)) { elmHit = r; break; }
  }
  if (elmHit) { console.log('\n  ✅ ELMData returned a person:\n' + JSON.stringify(elmHit.json, null, 2).slice(0, 2000)); }
  else console.log('\n  ELMData: no person returned (wrong body shape, no consent on file, or not found).');

  // 2) Nphies patient registry — deterministic GET with known params. Try each DOB
  //    candidate; stop on the first that returns a person.
  if (DOBS.length && !elmHit) {
    let regHit = false;
    for (const dob of DOBS) {
      const ep = `${P}/Patient/NPHIESPatientRegistry?idNumber=${encodeURIComponent(ID)}&dateOfBirth=${encodeURIComponent(dob)}&hospitalId=${HOSPITAL_ID}&mrno=`;
      let r; try { r = await call(tok, 'GET', ep); }
      catch (e) { console.log(`  NPHIESPatientRegistry dob=${dob} → ERROR ${String(e.message || e).slice(0,80)}`); continue; }
      const msg = elmMsg(r);
      console.log(`  NPHIESPatientRegistry dob=${dob} → HTTP ${r.status}` + (msg ? `  msg="${msg}"` : ''));
      if (looksLikePerson(r)) { console.log('\n  ✅ Nphies registry returned a person:\n' + JSON.stringify(r.json, null, 2).slice(0, 2000)); regHit = true; break; }
    }
    if (!regHit) console.log('  NPHIESPatientRegistry: no person for any DOB candidate.');
  } else if (!DOBS.length) {
    console.log('\n  (skip Nphies registry — pass a DOB as the 2nd arg to try it: node elm-lookup.js ' + ID + ' 1368-07-01,1949-04-29 --yes)');
  }
  console.log('\n── done ──');
  process.exit(0);
})().catch((e) => { console.error('\n✗ ' + (e && e.message || e)); process.exit(3); });
