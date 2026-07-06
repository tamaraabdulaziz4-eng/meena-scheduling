#!/usr/bin/env node
/*
 * accession-map.js — ask the RUNNING connector for one patient's match (Siratech
 * orders + DePACS studies together) and compare the DePACS accession (e.g. SIRA2245)
 * against the Siratech order numbers (Bill No / order id / genPatBillingId) to find
 * the deterministic link — so nobody has to open Siratech by hand.
 *
 * READ-ONLY: it only calls the connector's own read endpoint on localhost.
 *
 *   cd /root/meena-scheduling/integrations/siratech-connector
 *   env $(...) node tools/accession-map.js <MRN>     # PORT + CONNECTOR_TOKEN from the service env
 */
const http = require('http');
const PORT = Number(process.env.PORT || 3005);
const TOKEN = process.env.CONNECTOR_TOKEN || '';
const MRN = String(process.argv[2] || '').trim();
if (!MRN) { console.error('usage: node tools/accession-map.js <MRN>'); process.exit(1); }

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET',
      headers: { Authorization: 'Bearer ' + TOKEN } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
        catch (e) { resolve({ status: res.statusCode, text: b.slice(0, 300) }); } });
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

(async () => {
  if (!TOKEN) console.error('(note: CONNECTOR_TOKEN not set in this shell — pass the service env; see the command)\n');
  // /results/match gives the DePACS studies (allStudies) — but its Siratech side is
  // PENDING orders only. A completed/verified exam has left the pending list, so we
  // ALSO pull /patient, which returns EVERY radiology order (incl. finished ones)
  // with its Bill No / order id — that's where the number to compare lives.
  const r = await get('/results/match/' + encodeURIComponent(MRN));
  if (r.status !== 200 || !r.json) { console.error('connector returned HTTP', r.status, r.text || ''); process.exit(2); }
  const d = r.json;
  const pendingOrders = d.orders || [];
  const studies = d.allStudies || [];
  const pr = await get('/patient/' + encodeURIComponent(MRN));
  const patOrders = (pr.json && pr.json.orders) || [];

  const orderNums = [];
  const pushNum = (label, v) => { if (v != null && String(v).trim() !== '') orderNums.push({ label, v: String(v).trim() }); };

  console.log('═══ Siratech ORDERS for ' + MRN + '  (pending + all) ═══');
  for (const o of pendingOrders) {
    const ord = o.order || {};
    console.log(`• [pending] Bill No: ${ord.billNo}   genPatBillingId: ${ord.genPatBillingId}   date: ${ord.orderDate}`);
    pushNum('billNo', ord.billNo); pushNum('genPatBillingId', ord.genPatBillingId);
    for (const t of (o.tests || [])) {
      const tt = t.test || {};
      pushNum('orderId', tt.orderId);
      const raw = t.rawAcc || {};
      for (const side of ['order', 'detail']) for (const [k, v] of Object.entries(raw[side] || {})) pushNum(side + '.' + k, v);
    }
  }
  if (!patOrders.length) console.log('  (/patient returned no orders)');
  for (const o of patOrders) {
    console.log(`• [${o.imaged ? 'imaged' : 'ordered'}${o.hasReport ? '/reported' : ''}] ${o.service || '?'}  (${o.modality || '?'})  Bill No: ${o.billNo}   orderId: ${o.orderId}   acc: ${o.accessionNumber || '(none)'}   date: ${o.orderedDate}`);
    pushNum('billNo', o.billNo); pushNum('orderId', o.orderId); pushNum('accessionNumber', o.accessionNumber);
    pushNum('pacsId', o.pacsId);
  }

  console.log('\n═══ DePACS STUDIES for ' + MRN + ' ═══');
  const accs = [];
  if (!studies.length) console.log('  (no studies returned)');
  for (const s of studies) {
    console.log(`• accession: ${s.accession || '(none)'}   ${s.modality}   ${s.studyDate}   status:${s.status}   studyId:${s.studyId}`);
    if (s.accession) accs.push(String(s.accession));
  }

  console.log('\n═══ LINK CHECK — does the DePACS accession match an order number? ═══');
  let found = false;
  const seen = new Set();
  for (const acc of accs) {
    const digits = (String(acc).match(/\d+/) || [])[0];
    if (!digits) continue;
    for (const on of orderNums) {
      const ov = on.v; const od = (ov.match(/\d+/) || [])[0];
      if (ov === acc || ov === digits || od === digits || (od && digits && (od.endsWith(digits) || digits.endsWith(od)))) {
        const key = acc + '|' + on.label + '|' + ov;
        if (seen.has(key)) continue; seen.add(key);
        console.log(`  ✅ MATCH: DePACS "${acc}"  ↔  Siratech ${on.label} = "${ov}"`);
        found = true;
      }
    }
  }
  if (found) {
    console.log('\n  🎉 The DePACS accession IS derived from a Siratech order number.');
    console.log('     → I can link image↔order deterministically from DePACS alone (no cPACS). Send me this output.');
  } else {
    console.log('  ✗ no obvious numeric match.');
    console.log('  DePACS accessions :', accs.join(', ') || '(none)');
    console.log('  Siratech numbers  :', [...new Set(orderNums.map((o) => `${o.label}=${o.v}`))].join('  ') || '(none)');
    console.log('  → paste me these two lines and I\'ll work out the relationship.');
  }
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
