#!/usr/bin/env node
/**
 * endpoints-map.js — READ-ONLY enumeration of EVERY Siratech API endpoint.
 *
 * The Siratech app is an Angular SPA: every API path it can call is baked into its
 * JavaScript bundles. This tool (run on the KSA VPS, which can reach Siratech) does
 * two things and merges them:
 *   1. Loads the app headless and records every live API request it fires.
 *   2. Downloads every loaded JS bundle and greps out every `…-api/api/vN/…` path.
 * Result: a full map of endpoints grouped by API module + controller. Writes nothing
 * to Siratech; only GETs the app's own static files + observes traffic.
 *
 *   cd integrations/siratech-connector/tools
 *   node endpoints-map.js            # writes endpoints-map.json + prints a summary
 *
 * Reads HIS_BASE/HIS_USER/HIS_PASS/HIS_SITE from the connector .env.
 */
'use strict';
const fs = require('fs');
const path = require('path');

try {
  const p = path.join(__dirname, '..', '.env');
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* env optional */ }

// Resolve puppeteer EXACTLY the way the running connector does (from server.js's
// perspective) — works regardless of where node_modules got hoisted.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Match API paths inside JS/text: "investigation-api/api/v1/ResultEntryRadiology/RadiologySearch"
const API_RE = /([A-Za-z][\w-]*-api\/api\/v\d+\/[A-Za-z0-9_./-]+|\/api\/v\d+\/[A-Za-z0-9_./-]+)/g;
const clean = (u) => u.replace(HIS_BASE, '').split('?')[0].replace(/\/+$/, '');
function harvestPaths(text, set) {
  let m; while ((m = API_RE.exec(text)) !== null) {
    let p = m[1].replace(/['"`,);]+$/, '');
    if (p.length < 8 || p.length > 160) continue;
    set.add(p);
  }
}

(async () => {
  console.log(`── Siratech endpoint map (read-only) — ${HIS_BASE} ──`);
  const liveApi = new Set();     // endpoints actually called
  const jsUrls = new Set();      // loaded JS bundle URLs
  const fromCode = new Set();    // endpoints found inside the JS

  const browser = await puppeteer.launch({ headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  let auth = '', hospitalid = '';
  try {
    const page = await browser.newPage();
    page.on('request', (r) => {
      const u = r.url();
      if (/-api\/api\/v\d+\//i.test(u)) { liveApi.add(clean(u)); const h = r.headers();
        if (h.authorization && !auth) auth = h.authorization; if (h.hospitalid && !hospitalid) hospitalid = h.hospitalid; }
      if (/\.js(\?|$)/i.test(u) && u.startsWith(HIS_BASE)) jsUrls.add(u.split('?')[0]);
    });
    console.log('  loading the app + logging in (captures live calls + JS bundles)…');
    await page.goto(HIS_BASE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    // login (same flow as the connector)
    try {
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
      await sleep(12000);   // let the dashboard + lazy chunks load
    } catch (e) { console.log('  (login step incomplete — still harvesting JS: ' + String(e.message || e).slice(0, 80) + ')'); }
    // also pull every <script src> and resource-timing JS the app loaded
    try {
      const more = await page.evaluate(() => {
        const s = new Set();
        document.querySelectorAll('script[src]').forEach((e) => s.add(e.src));
        (performance.getEntriesByType('resource') || []).forEach((r) => { if (/\.js(\?|$)/.test(r.name)) s.add(r.name); });
        return [...s];
      });
      for (const u of more) if (u.startsWith(HIS_BASE) && /\.js/i.test(u)) jsUrls.add(u.split('?')[0]);
    } catch (e) { /* ignore */ }
  } finally { await browser.close().catch(() => {}); }

  // download each JS bundle and grep out API paths
  console.log(`  downloading ${jsUrls.size} JS bundle(s) to extract every API path…`);
  let fetched = 0;
  for (const u of jsUrls) {
    try {
      const res = await fetch(u, { headers: { Accept: '*/*' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      harvestPaths(await res.text(), fromCode); fetched++;
    } catch (e) { /* skip a bundle that won't fetch */ }
  }

  const all = new Set([...liveApi, ...fromCode]);
  // group by api module + controller
  const groups = {};
  for (const p of all) {
    const mod = (p.match(/([\w-]*-api)\/api\/v\d+/) || [,'(other)'])[1];
    const controller = (p.match(/api\/v\d+\/([A-Za-z0-9_]+)/) || [,'?'])[1];
    groups[mod] = groups[mod] || {};
    (groups[mod][controller] = groups[mod][controller] || []).push(p);
  }
  const report = {
    base: HIS_BASE, jsBundles: jsUrls.size, jsFetched: fetched,
    liveCalls: [...liveApi].sort(), totalEndpoints: all.size,
    byModule: Object.fromEntries(Object.entries(groups).map(([m, ctrls]) => [m,
      Object.fromEntries(Object.entries(ctrls).map(([c, arr]) => [c, [...new Set(arr)].sort()]))])),
    allEndpoints: [...all].sort(),
  };
  const out = path.join(__dirname, 'endpoints-map.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  console.log('\n── summary ──');
  console.log(`  ${all.size} distinct endpoints across ${Object.keys(groups).length} API module(s); ${liveApi.size} seen live.`);
  for (const [mod, ctrls] of Object.entries(groups).sort()) {
    const n = Object.values(ctrls).reduce((a, arr) => a + arr.length, 0);
    console.log(`   ${mod}: ${n} endpoint(s) in ${Object.keys(ctrls).length} controller(s) — e.g. ${Object.keys(ctrls).slice(0, 8).join(', ')}`);
  }
  // highlight anything lab / pregnancy / result related
  const interesting = [...all].filter((p) => /lab|hcg|pregn|result|investig|report|patient|order/i.test(p));
  if (interesting.length) {
    console.log(`\n  Endpoints likely useful for radiology + labs (${interesting.length}):`);
    for (const p of interesting.slice(0, 40)) console.log(`     ${p}`);
    if (interesting.length > 40) console.log(`     … +${interesting.length - 40} more (see the JSON)`);
  }
  console.log(`\n  Full map written to: ${out}  — send it to me.`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ ' + (e && e.message || e)); process.exit(2); });
