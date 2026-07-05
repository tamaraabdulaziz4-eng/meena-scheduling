#!/usr/bin/env node
/**
 * mwl-probe.js — READ-ONLY DICOM Modality Worklist (MWL) probe.
 *
 * Why this exists:
 *   Siratech assigns each radiology order an accession number (e.g. "SIRA1661") and
 *   pushes it to the DICOM Modality Worklist so the machine shows the patient's order.
 *   That same accession is stamped onto the images and lands on the DePACS study — but
 *   Siratech's REST API does NOT return it on the order, so filing a finished report to
 *   the right order falls back to fuzzy matching. The MWL is where the accession ↔ order
 *   ↔ patient mapping already lives. This probe queries it (C-FIND) so we can confirm
 *   the mapping comes back cleanly, WITHOUT any change from Siratech.
 *
 * It writes NOTHING. It performs a DICOM C-ECHO (connectivity test) then a Modality
 * Worklist C-FIND and prints what comes back. Safe to run against a live MWL SCP.
 *
 * Run it ON THE VPS (156.244.12.174) — that host can reach the hospital-facing DICOM
 * services; the cloud dev box cannot. First:  cd tools && npm install
 *
 * Required env (get these from whoever configured the CT/MRI/US machines' worklist):
 *   MWL_HOST        IP / hostname of the MWL SCP (the worklist server)
 *   MWL_PORT        its DICOM port (often 104, 11112, or 2762)
 *   MWL_CALLED_AE   the MWL server's AE Title (the "AE title" you're looking for)
 * Optional:
 *   MWL_CALLING_AE  our AE Title to present (default "MEENA"); some SCPs allow-list
 *                   callers, so this may need to be one the server already trusts
 *                   (e.g. an existing modality's AE title).
 *   MWL_DATE        scheduled date filter, DICOM YYYYMMDD or "TODAY" (default: no filter
 *                   → returns the whole current worklist). Use a filter if the list is huge.
 *   MWL_MODALITY    filter by modality (CT/MR/US/...); default: all.
 *   MWL_LIMIT       stop after N items are printed (default 25).
 *   MWL_TIMEOUT_MS  association/PDU timeout (default 15000).
 *
 * Example:
 *   MWL_HOST=10.0.0.9 MWL_PORT=104 MWL_CALLED_AE=SIRATECH_MWL \
 *   MWL_CALLING_AE=CT_SCANNER node mwl-probe.js
 */
'use strict';

const { Client, requests, constants, Dataset } = require('dcmjs-dimse');
const { CFindRequest, CEchoRequest } = requests;
const { Status, TransferSyntax, Uid } = constants;

const HOST = process.env.MWL_HOST;
const PORT = Number(process.env.MWL_PORT);
const CALLED_AE = process.env.MWL_CALLED_AE;
const CALLING_AE = process.env.MWL_CALLING_AE || 'MEENA';
const LIMIT = Math.max(1, Number(process.env.MWL_LIMIT) || 25);
const TIMEOUT_MS = Number(process.env.MWL_TIMEOUT_MS) || 15000;

let DATE = (process.env.MWL_DATE || '').trim();
if (DATE.toUpperCase() === 'TODAY') {
  const d = new Date();
  DATE = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
const MODALITY = (process.env.MWL_MODALITY || '').trim().toUpperCase();

function die(msg) { console.error('\n✗ ' + msg); process.exit(1); }
if (!HOST || !PORT || !CALLED_AE) {
  die('Missing config. Set at least MWL_HOST, MWL_PORT, MWL_CALLED_AE. See the header of this file.');
}

console.log('── MWL probe (read-only) ──────────────────────────────');
console.log(`  target   : ${HOST}:${PORT}  AE "${CALLED_AE}"`);
console.log(`  calling  : AE "${CALLING_AE}"`);
console.log(`  filter   : date=${DATE || '(any)'}  modality=${MODALITY || '(any)'}`);
console.log('────────────────────────────────────────────────────────\n');

// ── Step 1: C-ECHO — prove we can associate at all ────────────────────────────
function cEcho() {
  return new Promise((resolve) => {
    const client = new Client();
    const req = new CEchoRequest();
    let got = false;
    req.on('response', (r) => { got = r.getStatus() === Status.Success; });
    client.addRequest(req);
    client.on('networkError', (e) => resolve({ ok: false, err: 'network: ' + (e && e.message || e) }));
    client.on('associationRejected', (r) =>
      resolve({ ok: false, err: 'association REJECTED: ' + JSON.stringify(r && (r.getReason ? r.getReason() : r)) }));
    client.on('closed', () => resolve({ ok: got, err: got ? null : 'closed before a success echo' }));
    try {
      client.send(HOST, PORT, CALLING_AE, CALLED_AE, {
        associationLifetimeTimeout: TIMEOUT_MS, pduTimeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS,
      });
    } catch (e) { resolve({ ok: false, err: String(e && e.message || e) }); }
  });
}

// ── Step 2: Modality Worklist C-FIND ──────────────────────────────────────────
function get(ds, name) {
  try { const v = ds.getElement(name); return v == null ? '' : v; } catch (e) { return ''; }
}

function mwlFind() {
  return new Promise((resolve) => {
    const client = new Client();
    // Return-key template: empty string = "return this field". The Scheduled Procedure
    // Step Sequence is where modality / station / date / description live per DICOM MWL.
    const query = {
      PatientName: '', PatientID: '', AccessionNumber: '',
      RequestedProcedureID: '', RequestedProcedureDescription: '', StudyInstanceUID: '',
      ScheduledProcedureStepSequence: [{
        Modality: MODALITY || '',
        ScheduledStationAETitle: '',
        ScheduledProcedureStepStartDate: DATE || '',
        ScheduledProcedureStepStartTime: '',
        ScheduledProcedureStepDescription: '',
        ScheduledPerformingPhysicianName: '',
      }],
    };
    const req = CFindRequest.createWorklistFindRequest(query);
    const rows = [];
    req.on('response', (response) => {
      const st = response.getStatus();
      if (st === Status.Pending) {
        const ds = response.getDataset();
        if (ds) {
          const sps = (get(ds, 'ScheduledProcedureStepSequence') || [{}])[0] || {};
          rows.push({
            accession: get(ds, 'AccessionNumber'),
            patientId: get(ds, 'PatientID'),
            patientName: String(get(ds, 'PatientName') || ''),
            procId: get(ds, 'RequestedProcedureID'),
            procDesc: get(ds, 'RequestedProcedureDescription') || sps.ScheduledProcedureStepDescription || '',
            modality: sps.Modality || '',
            station: sps.ScheduledStationAETitle || '',
            date: sps.ScheduledProcedureStepStartDate || '',
            studyUid: get(ds, 'StudyInstanceUID'),
          });
        }
      }
    });
    client.addRequest(req);
    client.on('networkError', (e) => resolve({ ok: false, rows, err: 'network: ' + (e && e.message || e) }));
    client.on('associationRejected', (r) =>
      resolve({ ok: false, rows, err: 'association REJECTED: ' + JSON.stringify(r && (r.getReason ? r.getReason() : r)) }));
    client.on('closed', () => resolve({ ok: true, rows, err: null }));
    try {
      client.send(HOST, PORT, CALLING_AE, CALLED_AE, {
        associationLifetimeTimeout: TIMEOUT_MS, pduTimeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS,
      });
    } catch (e) { resolve({ ok: false, rows, err: String(e && e.message || e) }); }
  });
}

(async () => {
  const echo = await cEcho();
  if (!echo.ok) {
    console.log('C-ECHO : ✗ ' + echo.err);
    console.log('\nCould not establish a DICOM association. Common causes:');
    console.log('  • wrong host/port (worklist SCP not listening there)');
    console.log('  • wrong Called AE Title (server refuses unknown AE)');
    console.log('  • our Calling AE not allow-listed — try MWL_CALLING_AE set to an');
    console.log('    existing modality\'s AE title that the server already trusts');
    console.log('  • a firewall between the VPS and the worklist server');
    process.exit(2);
  }
  console.log('C-ECHO : ✓ association OK — the worklist server is reachable and accepted us\n');

  const r = await mwlFind();
  if (r.err && !r.rows.length) {
    console.log('C-FIND : ✗ ' + r.err);
    process.exit(3);
  }
  console.log(`C-FIND : ✓ ${r.rows.length} worklist item(s) returned` + (r.err ? ` (note: ${r.err})` : '') + '\n');
  if (!r.rows.length) {
    console.log('The worklist is empty for this filter. Try MWL_DATE=TODAY or clear the filters,');
    console.log('or run it while an order is scheduled/awaiting scan.');
    process.exit(0);
  }

  const show = r.rows.slice(0, LIMIT);
  for (const [i, x] of show.entries()) {
    console.log(`#${i + 1}`);
    console.log(`   accession : ${x.accession || '(BLANK — this is the problem if empty)'}`);
    console.log(`   patient   : ${x.patientName}  (ID ${x.patientId})`);
    console.log(`   procedure : ${x.procDesc}  [id ${x.procId}]`);
    console.log(`   modality  : ${x.modality}   station: ${x.station}   date: ${x.date}`);
    if (x.studyUid) console.log(`   studyUID  : ${x.studyUid}`);
    console.log('');
  }
  if (r.rows.length > show.length) console.log(`… ${r.rows.length - show.length} more (raise MWL_LIMIT to see them)\n`);

  const withAcc = r.rows.filter((x) => String(x.accession || '').trim() !== '').length;
  console.log('── verdict ──────────────────────────────────────────────');
  console.log(`  ${withAcc}/${r.rows.length} items carry an AccessionNumber.`);
  if (withAcc === r.rows.length) {
    console.log('  ✓ Every item has an accession — this feed can be the deterministic');
    console.log('    key: MWL accession === DePACS study accession → the exact order.');
  } else if (withAcc > 0) {
    console.log('  ~ Some items have accessions. Usable, but we\'ll need to understand');
    console.log('    which orders lack one (maybe not yet accessioned/billed).');
  } else {
    console.log('  ✗ No accessions on the worklist — the key would have to come from');
    console.log('    RequestedProcedureID or the study UID instead. Share this output.');
  }
  console.log('  Next: confirm one of these AccessionNumbers matches the accession_number');
  console.log('  on the same patient\'s DePACS study, and we can wire deterministic filing.');
  process.exit(0);
})();
