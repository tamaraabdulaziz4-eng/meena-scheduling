#!/usr/bin/env node
/**
 * mwl-agent.js — the on-site Modality Worklist watcher.
 *
 * Runs on a hospital-LAN PC (the only place that can speak DICOM to the worklist
 * broker). Every cycle it queries the broker for today's + yesterday's scheduled
 * procedures — the same feed the CT/XR/US machines read, which carries the
 * Siratech-generated ACCESSION NUMBER that the HIS REST API withholds — and pushes
 * the entries to Meena (/api/radiology/mwl/push). Meena then uses the accession as
 * the deterministic key to file each verified report to the exact order.
 *
 * READ-ONLY toward the broker (C-FIND only). Pushes to Meena over HTTPS with a
 * normal Meena login (use a dedicated least-privilege account).
 *
 * Broker quirks discovered by live probing (2026-07-05):
 *   - single-day date queries only (ranges or empty dates reset the connection)
 *   - the Calling AE must be allow-listed; the CT's own AE ("CTN3") is accepted
 *
 * Config (env, or edit RUN-MWL-AGENT.bat):
 *   MEENA_URL   e.g. https://meena.example.app     (required)
 *   MEENA_USER / MEENA_PASS                        (required — dedicated account)
 *   MWL_HOST=10.0.73.56  MWL_PORT=104  MWL_CALLED_AE=DMWL_AE  MWL_CALLING_AE=CTN3
 *   POLL_SEC=60          seconds between cycles
 *   MWL_DEBUG=1          keep the DICOM wire log
 */
'use strict';

const dcmjsDimse = require('dcmjs-dimse');
const { Client, requests, constants } = dcmjsDimse;
const { CFindRequest } = requests;
const { Status } = constants;
if (process.env.MWL_DEBUG !== '1') { try { dcmjsDimse.log.disableAll(); } catch (e) { /* best-effort */ } }

const MEENA_URL = String(process.env.MEENA_URL || '').replace(/\/+$/, '');
const MEENA_USER = process.env.MEENA_USER || '';
const MEENA_PASS = process.env.MEENA_PASS || '';
const HOST = process.env.MWL_HOST || '10.0.73.56';
const PORT = Number(process.env.MWL_PORT) || 104;
const CALLED_AE = process.env.MWL_CALLED_AE || 'DMWL_AE';
// One or more Calling AEs, comma-separated (e.g. "CTN3,XR1,US1"). If the broker
// scopes each caller to its own machine's orders, listing every machine's AE makes
// one agent cover all modalities; extra/wrong AEs are skipped with a log line.
const CALLING_AES = String(process.env.MWL_CALLING_AE || 'CTN3')
  .split(',').map((s) => s.trim()).filter(Boolean);
const POLL_SEC = Math.max(15, Number(process.env.POLL_SEC) || 60);
const TIMEOUT_MS = Number(process.env.MWL_TIMEOUT_MS) || 20000;

function ts() { return new Date().toISOString().slice(11, 19); }
function say(msg) { console.log(`[${ts()}] ${msg}`); }

if (!MEENA_URL || !MEENA_USER || !MEENA_PASS) {
  console.error('✗ Missing config: MEENA_URL, MEENA_USER and MEENA_PASS are required.');
  console.error('  Edit RUN-MWL-AGENT.bat (or set the environment variables) and run again.');
  process.exit(1);
}

// ── DICOM: one single-day MWL C-FIND (this broker rejects ranges/empty dates) ──
function dcmDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function mwlFindDay(dateStr, callingAe) {
  return new Promise((resolve) => {
    const client = new Client();
    const query = {
      PatientName: '', PatientID: '', AccessionNumber: '',
      RequestedProcedureID: '', RequestedProcedureDescription: '', StudyInstanceUID: '',
      ScheduledProcedureStepSequence: [{
        Modality: '', ScheduledStationAETitle: '',
        ScheduledProcedureStepStartDate: dateStr, ScheduledProcedureStepStartTime: '',
        ScheduledProcedureStepDescription: '', ScheduledPerformingPhysicianName: '',
      }],
    };
    const req = CFindRequest.createWorklistFindRequest(query);
    const rows = [];
    const g = (ds, name) => { try { const v = ds.getElement(name); return v == null ? '' : v; } catch (e) { return ''; } };
    req.on('response', (response) => {
      if (response.getStatus() !== Status.Pending) return;
      const ds = response.getDataset();
      if (!ds) return;
      const sps = (g(ds, 'ScheduledProcedureStepSequence') || [{}])[0] || {};
      rows.push({
        accession: String(g(ds, 'AccessionNumber') || '').trim(),
        patientId: String(g(ds, 'PatientID') || '').trim(),
        patientName: String(g(ds, 'PatientName') || ''),
        procId: String(g(ds, 'RequestedProcedureID') || ''),
        procDesc: String(g(ds, 'RequestedProcedureDescription') || sps.ScheduledProcedureStepDescription || ''),
        modality: String(sps.Modality || ''),
        station: String(sps.ScheduledStationAETitle || ''),
        date: String(sps.ScheduledProcedureStepStartDate || dateStr),
        time: String(sps.ScheduledProcedureStepStartTime || ''),
        studyUid: String(g(ds, 'StudyInstanceUID') || ''),
      });
    });
    client.addRequest(req);
    client.on('networkError', (e) => resolve({ ok: false, rows, err: String((e && e.message) || e) }));
    client.on('associationRejected', () => resolve({ ok: false, rows, err: 'association rejected (calling AE not allow-listed?)' }));
    client.on('closed', () => resolve({ ok: true, rows, err: null }));
    try {
      client.send(HOST, PORT, callingAe, CALLED_AE, {
        associationLifetimeTimeout: TIMEOUT_MS, pduTimeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS,
      });
    } catch (e) { resolve({ ok: false, rows, err: String((e && e.message) || e) }); }
  });
}

// ── Meena: login (cookie token → Bearer) + push ────────────────────────────────
let meenaToken = null;

async function meenaLogin() {
  const r = await fetch(MEENA_URL + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MEENA_USER, password: MEENA_PASS }),
  });
  if (!r.ok) throw new Error(`Meena login failed (HTTP ${r.status}) — check MEENA_USER/MEENA_PASS`);
  const cookies = (typeof r.headers.getSetCookie === 'function') ? r.headers.getSetCookie()
    : [r.headers.get('set-cookie') || ''];
  for (const c of cookies) {
    const m = /(?:^|;\s*)token=([^;]+)/.exec(c || '');
    if (m) { meenaToken = m[1]; return; }
  }
  throw new Error('Meena login succeeded but no token cookie was returned');
}

async function meenaPush(items) {
  if (!meenaToken) await meenaLogin();
  const send = () => fetch(MEENA_URL + '/api/radiology/mwl/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + meenaToken },
    body: JSON.stringify({ items }),
  });
  let r = await send();
  if (r.status === 401) { meenaToken = null; await meenaLogin(); r = await send(); }  // token expired → one re-login
  if (!r.ok) throw new Error(`push failed (HTTP ${r.status})`);
  return r.json();
}

// ── main loop ──────────────────────────────────────────────────────────────────
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
let cycle = 0;
let consecFail = 0;         // consecutive fully-failed cycles → back off (don't hammer a sick broker)
const badAes = new Set();   // AEs the broker rejected — logged once, retried hourly
async function tick() {
  cycle++;
  try {
    // For each calling AE (sequentially — gentle on the broker): today + yesterday as
    // two single-day queries (broker limitation), so midnight-spanning orders are
    // never missed. Dedupe by accession across AEs — brokers that return the full
    // list to every caller would otherwise duplicate every row.
    const byAcc = new Map();
    let blanks = 0, okQueries = 0, lastErr = null, firstQuery = true;
    // Yesterday matters far less than today (most pending orders are same-day) and each
    // query is a fresh DICOM association — halve the load on the broker by only sweeping
    // yesterday occasionally.
    const days = (cycle % 5 === 1) ? [dcmDate(0), dcmDate(-1)] : [dcmDate(0)];
    for (const ae of CALLING_AES) {
      if (badAes.has(ae) && cycle % 60 !== 1) continue;   // rejected AE → retry ~hourly
      for (const day of days) {
        if (!firstQuery) await sleepMs(400);              // space associations — some brokers reset on back-to-back
        firstQuery = false;
        const r = await mwlFindDay(day, ae);
        if (!r.ok) {
          lastErr = r.err;
          if (/rejected/i.test(String(r.err)) && !badAes.has(ae)) {
            badAes.add(ae);
            say(`broker rejected calling AE "${ae}" — skipping it (kept: ${CALLING_AES.filter((a) => !badAes.has(a)).join(', ') || 'none'})`);
          }
          break;                                          // same AE won't work for day 2
        }
        badAes.delete(ae);
        okQueries++;
        for (const x of r.rows) {
          if (!x.accession) { blanks++; continue; }       // accession is the whole point
          if (!byAcc.has(x.accession)) byAcc.set(x.accession, x);
        }
      }
    }
    if (!okQueries) {
      consecFail++;
      // Back off up to ~10 min so a sick/restarting broker isn't hammered every 60s;
      // recovers automatically on the next successful query. Only log occasionally.
      const backoff = Math.min(10 * 60, POLL_SEC * Math.min(consecFail, 10));
      if (consecFail === 1 || consecFail % 10 === 0) {
        say(`worklist unreachable (${lastErr}) — ${consecFail} tr${consecFail === 1 ? 'y' : 'ies'}, backing off ${backoff}s. Auto-resumes when the broker answers.`);
      }
      await sleepMs(backoff * 1000);
      return;
    }
    if (consecFail) { say(`worklist reachable again after ${consecFail} failed tr${consecFail === 1 ? 'y' : 'ies'}.`); consecFail = 0; }
    const items = [...byAcc.values()];
    if (!items.length) {
      if (cycle === 1 || cycle % 10 === 0) say(`worklist empty (${blanks} row(s) without accession) — watching…`);
      return;
    }
    const res = await meenaPush(items);
    say(`pushed ${items.length} entr${items.length === 1 ? 'y' : 'ies'} (${res && res.saved} saved)` +
        (blanks ? ` — ${blanks} row(s) had no accession` : '') +
        ` · e.g. ${items[0].accession} ${items[0].patientId} ${items[0].procDesc || items[0].modality}`);
  } catch (e) {
    say(`cycle error: ${String((e && e.message) || e)}`);
  }
}

(async () => {
  say(`MWL agent starting — broker ${HOST}:${PORT} AE ${CALLED_AE} (calling as ${CALLING_AES.join(', ')}), Meena ${MEENA_URL}, every ${POLL_SEC}s`);
  try { await meenaLogin(); say('Meena login OK'); } catch (e) { console.error('✗ ' + e.message); process.exit(1); }
  // Self-scheduling loop (NOT setInterval): tick() is async and may await a long
  // backoff sleep when the broker is down. setInterval would keep launching fresh,
  // overlapping tick()s every POLL_SEC — defeating the backoff (the sick broker is
  // still hit every 60s) and corrupting the shared cycle/consecFail/badAes state via
  // concurrent runs. Scheduling the next tick only after the current one settles
  // guarantees a single in-flight cycle and makes the backoff actually space queries.
  const loop = async () => {
    await tick();
    setTimeout(loop, POLL_SEC * 1000);
  };
  loop();
})();
