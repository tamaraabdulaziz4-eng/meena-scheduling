#!/usr/bin/env node
/**
 * discover-all.js — ONE read-only pass that tells us everything reachable in Siratech.
 * Run on the KSA VPS. Writes NOTHING to Siratech. One command → one report file.
 *
 *   cd integrations/siratech-connector/tools
 *   node discover-all.js 25148940      # a real MRN (labs + radiology ideally)
 *
 * It does, in one run:
 *   1) Enumerate EVERY API endpoint (downloads the app's JS, greps <mod>-api/api/vN/…).
 *   2) Headless-login, then probe a battery of endpoints for the given patient:
 *      radiology orders (pending + resulted), order detail, RIS panel, labs/pregnancy,
 *      patient details.
 *   3) Scan every response for: ACCESSION-shaped values, and PACS/DICOM/DePACS/GE/
 *      Butterfly/study keywords — i.e. any built-in imaging integration.
 *   4) Write discover-all-report.json + print a summary.
 */
'use strict';
const fs = require('fs');
const path = require('path');

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
const RESULT_SITE = Number(process.env.RESULT_SITE || 3);
// Accept EITHER an MRN or a national ID / Iqama / mobile (the "enter the هوية →
// what comes back" path). A 10-digit 1… = Saudi national ID, 2… = Iqama; a
// 05…/5…/+966… value = mobile; anything else = treat as an MRN. For an ID/mobile
// we first resolve the patient through the HIS's own EMRSearchPanel path (same as
// the connector), then reuse that MRN for the downstream probes.
const IDENT = (process.argv[2] || '').trim();
const _IDDIGITS = IDENT.replace(/\D/g, '');
const IDENT_KIND = /^1\d{9}$/.test(_IDDIGITS) ? 'saudiId'
                 : /^2\d{9}$/.test(_IDDIGITS) ? 'iqama'
                 : /^(?:00)?(?:966)?0?5\d{8}$/.test(_IDDIGITS) ? 'mobile'
                 : 'mrn';
let MRN = IDENT_KIND === 'mrn' ? IDENT : '';   // resolved after login for id/mobile
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!HIS_USER || !HIS_PASS) { console.error('✗ HIS_USER/HIS_PASS not set (connector .env).'); process.exit(1); }

const ACC_RE = (v) => { const s = String(v==null?'':v).trim(); return /^SIRA\d{3,}$/i.test(s) || /^[A-Z]{1,4}\d{5,}$/.test(s); };
const KW_RE = /pacs|dicom|depacs|butterfly|accession|studyinstance|study_?uid|\bge\b|modalityworklist|imaging|wado|orthanc/i;
const PREG_RE = /hcg|pregnan|beta[\s-]?hcg|β/i;
// Insurance / national health-record (Nphies, CCHI) signal. Matches BOTH the
// field names the HIS stores against a patient (policy, member, coverage,
// sponsor, TPA, class, benefit) AND the endpoint paths of an eligibility module
// if one exists. READ-ONLY: we only flag what already comes back on a patient
// lookup — we never CALL an eligibility/claim endpoint (that can fire a real,
// billable Nphies transaction). Discover names here; decide what's safe to call later.
const INS_RE = /nphies|eligib|insur|coverage|\bpolicy\b|policyno|member(ship)?|beneficiar|sponsor|payer|\btpa\b|scheme|approval|preauth|pre-auth|deductib|copay|co-pay|benefit|claim|cchi/i;
const keysOf = (r) => (r && typeof r === 'object' ? Object.keys(r) : []);
function scanValues(obj, out, kp='') {   // collect accession-like + keyword-bearing fields
  if (obj == null) return out;
  if (Array.isArray(obj)) { obj.slice(0,3).forEach((v,i)=>scanValues(v,out,`${kp}[${i}]`)); return out; }
  if (typeof obj === 'object') { for (const k of Object.keys(obj)) { const v=obj[k];
    if (v!=null && typeof v!=='object' && String(v).trim()!=='') {
      const sv = String(v).slice(0,50);
      if (/acc/i.test(k) || ACC_RE(v)) out.acc.push(`${kp}.${k}=${sv}`.replace(/^\./,''));
      if (KW_RE.test(k) || KW_RE.test(sv)) out.kw.push(`${kp}.${k}=${sv}`.replace(/^\./,''));
      if (PREG_RE.test(k) || PREG_RE.test(sv)) out.preg.push(`${kp}.${k}=${sv}`.replace(/^\./,''));
      // Insurance flags on the FIELD NAME only (a value like "approved" on an
      // unrelated field is a false positive; a key like `policyNo` is real signal).
      if (out.ins && INS_RE.test(k)) out.ins.push(`${kp}.${k}=${sv}`.replace(/^\./,''));
    }
    if (typeof v==='object') scanValues(v,out,`${kp}.${k}`.replace(/^\./,'')); } }
  return out;
}

const report = { base: HIS_BASE, ident: IDENT, identKind: IDENT_KIND, mrno: MRN, endpoints: { all: [], byModule: {}, liveCalls: [] }, probes: [], flags: {} };

async function loginAndBundles() {
  const browser = await puppeteer.launch({ headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'] });
  const jsUrls = new Set(); let auth='', hospitalid='';
  try {
    const page = await browser.newPage();
    page.on('request', (r) => { const u=r.url();
      if (/-api\/api\/v\d+\//i.test(u)) { const ep=u.replace(HIS_BASE,'').split('?')[0]; if(!report.endpoints.liveCalls.includes(ep))report.endpoints.liveCalls.push(ep);
        const h=r.headers(); if(h.authorization&&!auth)auth=h.authorization; if(h.hospitalid&&!hospitalid)hospitalid=h.hospitalid; }
      if (/\.js(\?|$)/i.test(u) && u.startsWith(HIS_BASE)) jsUrls.add(u.split('?')[0]); });
    await page.goto(HIS_BASE, { waitUntil:'networkidle2', timeout:60000 }).catch(()=>{});
    await page.waitForSelector('#mat-input-0', { timeout:25000 });
    await page.click('#mat-input-0'); await page.type('#mat-input-0', HIS_USER, {delay:40});
    await page.keyboard.press('Tab'); await sleep(3500);
    const site=(await page.$('#focusablesite'))||(await page.$('mat-select'));
    if (site){ await site.click(); await sleep(1500); const opts=await page.$$('mat-option'); let picked=false;
      if(HIS_SITE) for(const o of opts){ const t=(await o.evaluate(e=>e.innerText)).trim(); if(t.toLowerCase().includes(HIS_SITE.toLowerCase())){await o.click();picked=true;break;} }
      if(!picked&&opts[0])await opts[0].click(); await sleep(1000); }
    await page.click('#passFocus'); await page.type('#passFocus', HIS_PASS, {delay:40}); await sleep(400);
    const btn=await page.evaluateHandle(()=>[...document.querySelectorAll('button')].find(e=>/login/i.test(e.innerText)));
    if(btn) await btn.click().catch(()=>{});
    await sleep(12000);
    try { const more=await page.evaluate(()=>{const s=new Set();document.querySelectorAll('script[src]').forEach(e=>s.add(e.src));(performance.getEntriesByType('resource')||[]).forEach(r=>{if(/\.js(\?|$)/.test(r.name))s.add(r.name);});return[...s];});
      for(const u of more) if(u.startsWith(HIS_BASE)&&/\.js/i.test(u)) jsUrls.add(u.split('?')[0]); } catch(e){}
    if(!auth) throw new Error('login yielded no token');
    return { tok:{auth,hospitalid:hospitalid||''}, jsUrls:[...jsUrls] };
  } finally { await browser.close().catch(()=>{}); }
}

async function post(tok, ep, body){ const res=await fetch(HIS_BASE+ep,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/plain, */*',Authorization:tok.auth,hospitalid:tok.hospitalid},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)}); const t=await res.text(); let j; try{j=JSON.parse(t);}catch(e){j=null;} return {status:res.status,json:j}; }
async function get(tok, ep){ const res=await fetch(HIS_BASE+ep,{headers:{Accept:'application/json, text/plain, */*',Authorization:tok.auth,hospitalid:tok.hospitalid},signal:AbortSignal.timeout(30000)}); const t=await res.text(); let j; try{j=JSON.parse(t);}catch(e){j=null;} return {status:res.status,json:j}; }
// The HIS UI's own national-ID / Iqama / phone lookup (server-side filtered by
// {idType,category}). Same shape the connector's _emrSearch uses. READ-ONLY.
async function emrSearch(tok, idType, category, value){
  const body={ deptId:0, providerId:'', duration:0, hospitalId:Number(tok.hospitalid)||undefined,
    nursingStationId:-1, idType, category, dischPatientsAccess:false, genLevelId:0,
    idNumber:value, loginProviderId:'', patlistType:'EMR', roomTypeName:'',
    searchCondition:'Search', searchConditionValue:'All', updateGenUserSettings:[] };
  const headers={ 'Content-Type':'application/json', Accept:'application/json, text/plain, */*',
    Authorization:tok.auth, hospitalid:tok.hospitalid,
    clienttimezoneoffsetinminutes:'-180', localtimezoneoffsetinminutes:'-180', machinename:'YARWEB_UI' };
  const res=await fetch(HIS_BASE+'/patient-api/api/v1/Patient/EMRSearchPanel/List',{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const t=await res.text(); let j; try{j=JSON.parse(t);}catch(e){j=null;} return {status:res.status,json:j};
}
function invBody(cat, filterResult, extra){ const today=new Date().toISOString().slice(0,10), y=new Date(Date.now()-120*864e5).toISOString().slice(0,10);
  return Object.assign({ mrno:MRN, billno:'', fromDate:`${y}T00:00:00.000Z`, toDate:`${today}T23:59:59.000Z`, baseCatgeory:0, hospitalId:RESULT_SITE, mode:6, cpoeStatus:0, isbilled:0, empId:String(HIS_USER).padStart(8,'0'), visitno:'', selectionType:2, filterResult, profileId:'', invCategoryId:null, baseInvCategoryId:cat, visitMode:'', invMastServiceId:0, sampleNo:'', isCreditWithoutBilling:0, cpoeSearchGroupMode:0, searchType:'B', visiType:'0', isFrequent:1 }, extra||{}); }

function record(name, ep, resp){ const rows=(resp.json&&(resp.json.data||resp.json))||[]; const arr=Array.isArray(rows)?rows:[rows].filter(Boolean);
  const scan={acc:[],kw:[],preg:[],ins:[]}; scanValues(resp.json,scan);
  const rec={name, ep, status:resp.status, rowCount:arr.length, firstRowKeys:keysOf(arr[0]), accession:[...new Set(scan.acc)].slice(0,10), imaging:[...new Set(scan.kw)].slice(0,10), pregnancy:[...new Set(scan.preg)].slice(0,10), insurance:[...new Set(scan.ins)].slice(0,20)};
  report.probes.push(rec);
  console.log(`  ${name}: HTTP ${resp.status}, ${arr.length} row(s)` + (rec.accession.length?`  ACC:${rec.accession.slice(0,2).join(',')}`:'') + (rec.pregnancy.length?`  PREG:${rec.pregnancy.slice(0,1).join(',')}`:'') + (rec.imaging.length?`  IMG:${rec.imaging.slice(0,2).join(',')}`:'') + (rec.insurance.length?`  INS:${rec.insurance.slice(0,3).join(',')}`:''));
  return arr; }

(async () => {
  console.log(`── Siratech FULL discovery (read-only) — ${IDENT?`${IDENT_KIND}:${IDENT}`:'(no patient)'} ──`);
  const { tok, jsUrls } = await loginAndBundles();
  // Follow lazy chunks: Angular loads feature modules (radiology/EMR/investigation
  // AND any insurance/eligibility module) as separate .js chunks that only download
  // when you open that screen. Waiting on the dashboard misses them. So BFS: from
  // each bundle, harvest API paths AND any referenced *.js chunk filename, fetch
  // those too, repeat — until no new chunk appears. READ-ONLY (GETs static JS).
  const eps=new Set(report.endpoints.liveCalls);
  const apiRe=/([A-Za-z][\w-]*-api\/api\/v\d+\/[A-Za-z0-9_./-]+)/g;
  const chunkRe=/["'`]([A-Za-z0-9_\-./]+\.js)["'`]/g;      // any quoted *.js reference
  const seen=new Set(), queue=[...jsUrls]; const CAP=500;
  const toUrl=(f)=>{ if(/^https?:\/\//.test(f)) return f.startsWith(HIS_BASE)?f:null;
    return HIS_BASE + '/' + f.replace(/^\.?\//,''); };
  while(queue.length && seen.size<CAP){
    const u=queue.shift(); if(!u||seen.has(u))continue; seen.add(u);
    try{ const r=await fetch(u,{signal:AbortSignal.timeout(30000)}); if(!r.ok)continue; const txt=await r.text();
      let m; while((m=apiRe.exec(txt))!==null){ const p=m[1].replace(/['"`,);]+$/,''); if(p.length>=8&&p.length<=160)eps.add(p); }
      let c; while((c=chunkRe.exec(txt))!==null){ const url=toUrl(c[1]); if(url && /\.js$/i.test(url) && !seen.has(url) && queue.length+seen.size<CAP) queue.push(url); }
    }catch(e){}
  }
  report.endpoints.jsScanned=seen.size;
  console.log(`  login OK. Scanned ${seen.size} JS file(s) (bundles + lazy chunks).`);
  report.endpoints.all=[...eps].sort();
  for(const p of report.endpoints.all){ const mod=(p.match(/([\w-]*-api)\/api\/v\d+/)||[,'other'])[1]; (report.endpoints.byModule[mod]=report.endpoints.byModule[mod]||[]).push(p); }
  console.log(`  ${report.endpoints.all.length} endpoints across ${Object.keys(report.endpoints.byModule).length} module(s).`);

  // Resolve a national ID / Iqama / mobile → MRN via the HIS's own typed search.
  // This IS the "enter the هوية → what comes back" test: the EMRSearchPanel row is
  // scanned for insurance/policy fields by record() before we drill into orders.
  if (IDENT && IDENT_KIND !== 'mrn') {
    console.log(`\n  Resolving ${IDENT_KIND} ${IDENT} via EMRSearchPanel (the HIS UI's own national-ID path)…`);
    const plans = IDENT_KIND==='saudiId' ? [['SAUDI ID',2],['IQAMA ID',3]]
                : IDENT_KIND==='iqama'   ? [['IQAMA ID',3],['IQAMA ID',4],['SAUDI ID',2]]
                : [['PHONE NUMBER',6],['PHONE NUMBER',7],['PHONE NUMBER',8]];
    for (const [idType,category] of plans) {
      const arr = record(`EMRSearch ${idType} ${IDENT}`, '/patient-api/api/v1/Patient/EMRSearchPanel/List', await emrSearch(tok, idType, category, _IDDIGITS));
      if (arr.length) { MRN = arr[0].mrno || arr[0].mrNo || arr[0].MRNO || MRN; report.mrno = MRN; console.log(`   → resolved to MRN ${MRN}`); break; }
    }
    if (!MRN) console.log('   ✗ national-ID lookup returned no patient (check the ID, or the category id differs on this build).');
  }

  if (MRN) {
    console.log(`\n  Probing patient ${MRN}…`);
    const pend = record('Radiology pending (cat2,f0)', '/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', await post(tok,'/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', invBody(2,'0')));
    const res2 = record('Radiology resulted (cat2,f2)', '/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', await post(tok,'/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', invBody(2,'2')));
    record('Labs (cat1,f2)', '/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', await post(tok,'/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', invBody(1,'2')));
    record('All investigations (cat0,f2)', '/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', await post(tok,'/investigation-api/api/v1/ResultEntryRadiology/RadiologySearch', invBody(0,'2')));
    const today=new Date().toISOString().slice(0,10);
    record('FetchRISPanel', '/emr-api/api/v1/EMR/FetchRISPanel', await post(tok,'/emr-api/api/v1/EMR/FetchRISPanel',{mrno:MRN,fromDate:today+'T00:00:00',toDate:today+'T23:59:59',invMastServiceId:0,apptResourceCategoryId:0,apptResourceId:0,providerId:'',serviceCategoryId:0,emrPatRisPanelId:0,userId:String(HIS_USER).padStart(8,'0'),hospitalId:RESULT_SITE}));
    record('FetchRadiologyDetails', '/emr-api/api/v1/EMR/FetchRadiologyDetails', await post(tok,'/emr-api/api/v1/EMR/FetchRadiologyDetails',{mrno:MRN,hospitalId:RESULT_SITE,fromDate:today+'T00:00:00',toDate:today+'T23:59:59',userId:String(HIS_USER).padStart(8,'0')}));
    // Patient master lookup — the "enter the ID → what comes back" path. This is
    // where the HIS keeps the stored insurance/policy/sponsor on file (from
    // registration), so the INS scan on this response tells us exactly what
    // insurance data we can READ per patient today, without any Nphies call.
    record('Patient/Search (master + stored insurance)', '/patient-api/api/v1/Patient/Search', await post(tok,'/patient-api/api/v1/Patient/Search',{mrNo:MRN}));
    const sample=(pend[0]||res2[0]);
    if (sample && sample.billNo){ record('RadiologyDetails (drill)', '/investigation-api/api/v1/ResultEntryRadiology/RadiologyDetails', await post(tok,'/investigation-api/api/v1/ResultEntryRadiology/RadiologyDetails', Object.assign(invBody(2,'2'),{billNo:sample.billNo, genPatBillingId:sample.genPatBillingId}))); }
  }

  // flags
  const anyAcc = report.probes.some(p=>p.accession.length), anyPreg=report.probes.some(p=>p.pregnancy.length), anyImg=report.probes.some(p=>p.imaging.length);
  const anyIns = report.probes.some(p=>p.insurance.length);
  const insFields = [...new Set(report.probes.flatMap(p=>p.insurance))];
  const imagingEps = report.endpoints.all.filter(p=>KW_RE.test(p));
  const labEps = report.endpoints.all.filter(p=>/lab|hcg|pregn/i.test(p));
  // Endpoints whose PATH looks insurance/Nphies/eligibility related. These are
  // candidates ONLY — do not blind-call them; an eligibility/claim path may fire
  // a real Nphies transaction. Read the names, then decide together what's safe.
  const insEps = report.endpoints.all.filter(p=>INS_RE.test(p));
  report.flags={accessionOnOrderSide:anyAcc, pregnancyReachable:anyPreg, imagingKeywordsInData:anyImg, imagingEndpoints:imagingEps, labEndpoints:labEps, storedInsuranceReadable:anyIns, insuranceFields:insFields, insuranceEndpoints:insEps};

  const out=path.join(__dirname,'discover-all-report.json'); fs.writeFileSync(out, JSON.stringify(report,null,2));
  console.log('\n════════ SUMMARY ════════');
  console.log(`  Endpoints: ${report.endpoints.all.length}. Modules: ${Object.keys(report.endpoints.byModule).join(', ')}`);
  console.log(`  Accession on the ORDER side? ${anyAcc?'✓ YES — '+report.probes.filter(p=>p.accession.length).map(p=>p.accession[0]).slice(0,3).join(', '):'✗ no'}`);
  console.log(`  Pregnancy/hCG reachable? ${anyPreg?'✓ YES':'✗ not for this patient'}`);
  console.log(`  Imaging/PACS/DePACS/GE endpoints in the app: ${imagingEps.length?('\n     '+imagingEps.slice(0,20).join('\n     ')):'none obvious'}`);
  console.log(`  Lab endpoints: ${labEps.length?labEps.join(', '):'none named (labs likely share the investigation search)'}`);
  console.log(`  Stored insurance/policy readable on this patient? ${anyIns?('✓ YES — '+insFields.slice(0,8).join(', ')):'✗ no insurance-named field in the probed responses'}`);
  console.log(`  Insurance/Nphies/eligibility ENDPOINTS in the app: ${insEps.length?('\n     '+insEps.slice(0,30).join('\n     ')+'\n     ⚠ candidates only — do NOT blind-call; an eligibility/claim call may hit Nphies for real.'):'none found — this HIS build likely has no eligibility module exposed to the SPA.'}`);
  console.log(`\n  Full report: ${out}  — send me this one file.`);
  process.exit(0);
})().catch((e)=>{ console.error('\n✗ '+(e&&e.message||e)); process.exit(2); });
