#!/usr/bin/env node
/**
 * grep-bundle.js — find how Siratech CALLS an endpoint (the exact request payload).
 * Run on the KSA VPS. READ-ONLY, no login, no billed calls — just downloads the
 * app's static JS bundles and prints the code around a keyword.
 *
 *   node grep-bundle.js ELMData
 *   node grep-bundle.js ELMData NPHIESPatientRegistry Eligibility/Check
 *
 * Use it to read the payload object Siratech builds (field names survive
 * minification because they are JSON keys), so we stop guessing.
 */
'use strict';
const path = require('path');
const fs = require('fs');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYWORDS = process.argv.slice(2);
if (!KEYWORDS.length) { console.error('usage: node grep-bundle.js <keyword> [keyword...]'); process.exit(1); }
const CTX = Number(process.env.CTX || 320);   // chars of context on each side

(async () => {
  console.log(`── grep Siratech bundles for: ${KEYWORDS.join(', ')} ──`);
  // 1) collect bundle URLs by loading the app (no login needed — bundles load first)
  const jsUrls = new Set();
  const browser = await puppeteer.launch({ headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'] });
  try {
    const page = await browser.newPage();
    page.on('request', (r) => { const u = r.url(); if (/\.js(\?|$)/i.test(u) && u.startsWith(HIS_BASE)) jsUrls.add(u.split('?')[0]); });
    await page.goto(HIS_BASE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(8000);
    try { const more = await page.evaluate(() => { const s = new Set();
        document.querySelectorAll('script[src]').forEach((e) => s.add(e.src));
        (performance.getEntriesByType('resource') || []).forEach((r) => { if (/\.js(\?|$)/.test(r.name)) s.add(r.name); });
        return [...s]; });
      for (const u of more) if (u.startsWith(HIS_BASE) && /\.js/i.test(u)) jsUrls.add(u.split('?')[0]); } catch (e) {}
  } finally { await browser.close().catch(() => {}); }

  // 2) BFS bundles + lazy chunks; grep each for the keywords
  const CHUNK_RE = /["'`]([A-Za-z0-9_\-./]+\.js)["'`]/g;
  const toUrl = (f) => { if (/^https?:\/\//.test(f)) return f.startsWith(HIS_BASE) ? f : null; return HIS_BASE + '/' + f.replace(/^\.?\//, ''); };
  const seen = new Set(), queue = [...jsUrls]; const CAP = 600; let scanned = 0, hits = 0;
  while (queue.length && seen.size < CAP) {
    const u = queue.shift(); if (!u || seen.has(u)) continue; seen.add(u);
    let txt; try { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) continue; txt = await r.text(); scanned++; }
    catch (e) { continue; }
    let c; while ((c = CHUNK_RE.exec(txt)) !== null) { const url = toUrl(c[1]); if (url && /\.js$/i.test(url) && !seen.has(url) && queue.length + seen.size < CAP) queue.push(url); }
    for (const kw of KEYWORDS) {
      let idx = 0;
      while ((idx = txt.indexOf(kw, idx)) !== -1) {
        hits++;
        const snippet = txt.slice(Math.max(0, idx - CTX), idx + kw.length + CTX).replace(/\s+/g, ' ');
        console.log(`\n▶ ${kw}  @ ${u.replace(HIS_BASE, '')}`);
        console.log('   …' + snippet + '…');
        idx += kw.length;
        if (hits % 40 === 0) break;   // guard against a runaway match count in one file
      }
    }
  }
  console.log(`\n── scanned ${scanned} JS file(s); ${hits} match(es) ──`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ ' + (e && e.message || e)); process.exit(2); });
