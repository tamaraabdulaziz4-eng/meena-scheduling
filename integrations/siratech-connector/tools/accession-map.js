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
  const r = await get('/results/match/' + encodeURIComponent(MRN));
  if (r.status !== 200 || !r.json) { console.error('connector returned HTTP', r.status, r.text || ''); process.exit(2); }
  const d = r.json;
  const orders = d.orders || [];
  const studies = d.allStudies || [];

  const orderNums = [];
  console.log('═══ Siratech ORDERS for ' + MRN + ' ═══');
  if (!orders.length) console.log('  (no pending orders returned)');
  for (const o of orders) {
    const ord = o.order || {};
    console.log(`• Bill No: ${ord.billNo}   genPatBillingId: ${ord.genPatBillingId}   date: ${ord.orderDate}`);
    if (ord.billNo != null) orderNums.push({ label: 'billNo', v: String(ord.billNo) });
    if (ord.genPatBillingId != null) orderNums.push({ label: 'genPatBillingId', v: String(ord.genPatBillingId) });
    for (const t of (o.tests || [])) {
      const tt = t.test || {};
      console.log(`    - ${tt.serviceName || '?'}   orderId: ${tt.orderId}   order-side accession: ${t.orderAccession || '(none)'}`);
      if (tt.orderId != null) orderNums.push({ label: 'orderId', v: String(tt.orderId) });
      // rawAcc surfaces every accession/id-ish field on the Siratech order+detail rows
      const raw = t.rawAcc || {};
      for (const side of ['order', 'detail']) {
        for (const [k, v] of Object.entries(raw[side] || {})) {
          if (v != null && String(v).trim() !== '') orderNums.push({ label: side + '.' + k, v: String(v) });
        }
      }
    }
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
