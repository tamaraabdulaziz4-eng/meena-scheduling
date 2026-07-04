// ── RIS Worklist — pure RIS panel + consent ───────────────────────────────────
// A clean radiology worklist mirroring the Siratech RIS panel: every order still
// AWAITING a result, one row each — patient, exam + modality, ordering doctor,
// priority, live pipeline stage, and turnaround age. Emergency first, oldest first.
//
// It runs itself:
//  · the day is TODAY automatically (you can step to another day);
//  · the branch is YOUR branch automatically (org-wide roles can switch);
//  · it refreshes live, so a new order appears on its own;
//  · auto-file runs silently in the background — the moment a report is verified
//    it's filed into Siratech and the patient DROPS OFF this board by itself;
//  · a female patient shows a one-tap non-pregnancy consent right on her row.
// No knobs, no banners — just the board.

let wlState = { branches: [], site: '', data: null, loading: false, timer: null,
                seenEmerg: null, day: null, filter: null, searchView: false,
                // Persistent per-order caches so a live refresh paints INSTANTLY and the
                // heavy per-order HIS work (modality/exam + pipeline stage) runs in the
                // background, only for rows we don't already know — never blocking paint.
                modCache: new Map(), stageCache: new Map() };

// Live board: refresh on a timer so a newly-arrived order (or a just-filed one
// dropping off) shows without the operator touching anything.
const WL_REFRESH_MS = 45000;

// Org-wide roles (superadmin/manager) can point the board at any branch; a branch
// team lead is server-scoped to their own branch, so the picker is locked for them.
function wlCanSwitchBranch() {
  return typeof currentUser !== 'undefined' && currentUser && ['manager', 'superadmin'].includes(currentUser.role);
}

// One canonical per-order key for the modality/stage caches and the enrichment
// merge. Only a genuinely unique id counts — billing id or bill no. If BOTH are
// absent we return null and the caller skips caching/merging that row, rather than
// fall back to mrno+date (two same-day orders for one patient would collide and swap
// each other's modality/stage). Keyless rows just re-enrich each pass — no swap.
function wlRowKey(it) {
  return it.genPatBillingId != null ? 'g' + it.genPatBillingId
    : it.billNo ? 'b' + it.billNo : null;
}

// Local (KSA) date as YYYY-MM-DD — the operator is in KSA so the browser's local
// date IS the hospital's operational day.
function wlTodayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// day === null → "live": today + every still-pending prior-day order (nothing
// pending vanishes at midnight). Picking a date drills to exactly that day.
// Leaving a search: changing day/branch must drop any active on-board filter or
// cross-branch match view, else the new board is fetched but never painted (the
// searchView guard blocks it) or the old MRN filter re-applies to the new day.
function wlExitSearch() {
  wlState.filter = null; wlState.searchView = false;
  const s = document.getElementById('wl-search'); if (s) s.value = '';
}
function wlShiftDay(delta) {
  const base = wlState.day || wlTodayLocal();
  const [y, m, d] = base.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  // Stepping forward onto today returns to the live rolling view.
  wlState.day = (iso >= wlTodayLocal()) ? null : iso;
  wlState.seenEmerg = null; wlExitSearch();
  wlSyncDayControls();
  wlLoad(true);
}
function wlSetDay(v) {
  wlState.day = (!v || v >= wlTodayLocal()) ? null : v;   // today (or blank) = live
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlLoad(true);
}
function wlToday() { wlState.day = null; wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlLoad(true); }
function wlSyncDayControls() {
  const i = document.getElementById('wl-day'); if (i) i.value = wlState.day || wlTodayLocal();
  const t = document.getElementById('wl-today-btn');
  if (t) t.style.visibility = wlState.day ? 'visible' : 'hidden';   // only offer "Today" when browsing the past
}

// A new EMERGENCY order arriving is the one event a radiology operator must not
// miss — chime + desktop notification the moment one appears (never for a backlog
// already on screen at first load). Always on; there's nothing to configure.
function wlBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const beep = (t, freq) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.001, ac.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.28);
      o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.3);
    };
    beep(0, 880); beep(0.32, 1175);
    setTimeout(() => { try { ac.close(); } catch (e) {} }, 1200);
  } catch (e) { /* audio blocked — the visual badge still fires */ }
}
function wlNotify(newOnes) {
  const n = newOnes.length, first = newOnes[0] || {};
  const msg = n === 1
    ? `${first.patientName || first.mrno || 'A patient'} · ${first.branch || ''}`.trim()
    : `${n} new emergency orders`;
  try {
    if ('Notification' in window && Notification.permission === 'granted')
      new Notification('🚨 New emergency radiology order', { body: msg, tag: 'wl-emergency' });
  } catch (e) { /* ignore */ }
  if (typeof toast === 'function') toast(`🚨 New emergency: ${msg}`, 'err');
}
function wlKey(i) {
  return i.genPatBillingId != null ? 'g' + i.genPatBillingId
    : i.billNo ? 'b' + i.billNo
      : (i.mrno ? 'm' + i.mrno + '|' + (i.orderedDate || '') : null);
}
function wlCheckNewEmergencies(items) {
  const emerg = (items || []).filter((i) => i.emergency && wlKey(i));
  const keys = emerg.map(wlKey);
  if (wlState.seenEmerg === null) { wlState.seenEmerg = new Set(keys); return; }   // seed, no alarm
  const fresh = emerg.filter((i) => !wlState.seenEmerg.has(wlKey(i)));
  keys.forEach((k) => wlState.seenEmerg.add(k));
  if (fresh.length) { wlBeep(); wlNotify(fresh); }
}

async function renderWorklistPage() {
  setTopbar('Radiology worklist', 'Orders awaiting a result — emergency first, oldest first');
  wlState.filter = null; wlState.searchView = false;   // never reopen stuck in a search view
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Worklist', 'Radiology worklist', 'Every order awaiting a result')}
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(-1)" title="Previous day">◀</button>
          <input type="date" id="wl-day" class="input" value="${wlState.day || wlTodayLocal()}" onchange="wlSetDay(this.value)" style="width:150px" title="The day is today automatically — pick another to look back">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(1)" title="Next day">▶</button>
          <button id="wl-today-btn" class="btn btn-sm btn-primary" onclick="wlToday()" style="visibility:hidden" title="Back to today (live)">Today</button>
        </div>
        <select id="wl-branch" class="input" style="min-width:160px" onchange="wlOnBranch()">
          <option value="">All branches</option>
        </select>
        <input id="wl-search" class="input" placeholder="🔍 Find patient — file # / ID / iqama / mobile"
               style="min-width:230px;flex:1" onkeydown="if(event.key==='Enter')wlSearch(this.value)">
        <button class="btn btn-sm btn-ghost" onclick="wlLoad(true)" title="Refresh now">↻</button>
        <span id="wl-summary" style="font-size:12px;color:var(--muted);margin-left:auto"></span>
      </div>
    </div>
    <div id="wl-body"></div>`;

  // Only org-wide roles can switch branches; a team lead is scoped server-side to
  // their own branch, so we lock the picker for them and point them at the search
  // box (which finds a patient across every branch).
  const sel = document.getElementById('wl-branch');
  if (sel && !wlCanSwitchBranch()) {
    sel.disabled = true;
    sel.title = 'You see your own branch. To find a patient from another branch, use the search box.';
    if (sel.options[0]) sel.options[0].textContent = 'Your branch';
  } else {
    try {
      const b = await API.get('/radiology/branches');
      wlState.branches = (b && b.branches) || [];
      if (sel) for (const br of wlState.branches) {
        const o = document.createElement('option');
        o.value = br.siteId; o.textContent = br.shortName || br.name || ('Branch ' + br.siteId);
        sel.appendChild(o);
      }
    } catch (e) { /* picker optional; org-wide roles can still see all */ }
  }
  wlLoad();
  wlStartTimer();
}

function wlStartTimer() {
  if (wlState.timer) clearInterval(wlState.timer);
  wlState.timer = setInterval(() => {
    if (!document.getElementById('wl-body')) { clearInterval(wlState.timer); wlState.timer = null; return; }
    if (document.hidden) return;               // don't poll a backgrounded tab
    wlLoad(false, true);                        // silent refresh — never blanks the board
  }, WL_REFRESH_MS);
}

// Changing the branch shows a different set — re-seed the emergency baseline so
// switching scope never fires a false "new emergency" alarm.
function wlOnBranch() { wlState.site = document.getElementById('wl-branch').value; wlState.seenEmerg = null; wlExitSearch(); wlLoad(); }

async function wlLoad(force, silent) {
  const body = document.getElementById('wl-body');
  if (!body || wlState.loading) return;
  wlState.loading = true;
  if (!silent && !wlState.filter) body.innerHTML = LOADING_HTML;
  // FAST load: no ready/modality — just the pending list, so the board paints in one
  // round-trip. The pipeline stage + exam/modality (per-order HIS work) come in a
  // background pass right after, and never block the first paint.
  const qs = new URLSearchParams();
  if (wlState.site) qs.set('sites', wlState.site);
  if (wlState.day) { qs.set('from', wlState.day); qs.set('to', wlState.day); }
  if (force) qs.set('nocache', '1');
  try {
    wlState.data = await API.get('/radiology/worklist?' + qs.toString());
    wlHydrate();                                  // paint known modality/exam/stage instantly from cache
    wlRender();
    wlEnrich(silent);                             // background: fill stage + modality for unknown rows
  } catch (e) {
    if (!silent) {
      // In a search view, replacing the body with a retry card would wipe the results —
      // surface the failure as a toast instead so the operator still sees the error.
      if (wlState.filter || wlState.searchView) {
        if (typeof toast === 'function') toast(e.message || 'Refresh failed', 'err');
      } else {
        body.innerHTML = `<div class="empty" style="padding:24px"><div class="empty-icon">⚠️</div>
          <p>${escapeHtml(e.message || 'Failed to load the worklist')}</p>
          <button class="btn btn-sm" onclick="wlLoad(true)">Retry</button></div>`;
      }
    }
  } finally { wlState.loading = false; }
}

// Paint modality/exam AND pipeline stage onto the freshly-loaded board from the
// persistent caches, so a live refresh shows everything INSTANTLY without waiting on
// the slow enrichment pass for rows we already resolved.
function wlHydrate() {
  const items = (wlState.data && wlState.data.items) || [];
  for (const it of items) {
    const k = wlRowKey(it);
    if (!k) continue;                              // keyless row → never restore from cache (collision-safe)
    if (!it.modality && !it.exam) { const c = wlState.modCache.get(k); if (c) { it.modality = c.modality; it.exam = c.exam; } }
    if (!it.stage) { const s = wlState.stageCache.get(k); if (s) it.stage = s; }
  }
}

// Background pass: fetch the board WITH ready=1 (pipeline stage) + modality=1 (exam +
// modality) — the heavy per-order HIS work — and merge it onto the visible rows.
// Always runs on a manual/explicit load; on a silent live refresh it runs when a new
// row still lacks a stage OR it's been >2 min since the last enrich — so pipeline
// progress (ordered→imaged→report-ready) actually keeps updating on the live board,
// while a steady board stays light. Never blocks paint; caches results so paints are
// instant. Cache-restored stages are refreshed by the periodic re-check.
let _wlEnrichBusy = false;
async function wlEnrich(silent) {
  if (_wlEnrichBusy) return;
  const items = (wlState.data && wlState.data.items) || [];
  if (!items.length) return;
  const anyMissing = items.some((it) => !it.stage);
  if (silent && !anyMissing && (Date.now() - (wlState.lastEnrich || 0) < 120000)) return;
  _wlEnrichBusy = true;
  const qs = new URLSearchParams();
  if (wlState.site) qs.set('sites', wlState.site);
  if (wlState.day) { qs.set('from', wlState.day); qs.set('to', wlState.day); }
  qs.set('ready', '1'); qs.set('modality', '1');
  try {
    const d = await API.get('/radiology/worklist?' + qs.toString());
    wlState.lastEnrich = Date.now();
    if (wlState.modCache.size > 3000) { wlState.modCache.clear(); wlState.stageCache.clear(); }
    const enr = new Map();
    for (const it of (d.items || [])) {
      const k = wlRowKey(it);
      if (!k) continue;                            // keyless → don't cache/merge (collision-safe)
      enr.set(k, { modality: it.modality, exam: it.exam, stage: it.stage });
      if (it.modality || it.exam) wlState.modCache.set(k, { modality: it.modality, exam: it.exam });
      if (it.stage) wlState.stageCache.set(k, it.stage);
    }
    if (enr.size && wlState.data && Array.isArray(wlState.data.items)) {
      let changed = false;
      for (const it of wlState.data.items) {
        const k = wlRowKey(it); if (!k) continue;
        const e = enr.get(k);
        if (!e) continue;
        if (e.modality && it.modality !== e.modality) { it.modality = e.modality; changed = true; }
        if (e.exam && it.exam !== e.exam) { it.exam = e.exam; changed = true; }
        if (e.stage && it.stage !== e.stage) { it.stage = e.stage; changed = true; }
      }
      if (changed && document.getElementById('wl-body')) wlRender();
    }
  } catch (e) { /* best-effort */ }
  finally { _wlEnrichBusy = false; }
}

// Pipeline stage → badge. Each stage is detected from a specific signal:
//   ordered  — order line present in Siratech, no images yet
//   imaged   — a study exists in DePACS/PACS (scan done), not yet reported
//   reported — the DePACS study is VERIFIED (signed) → auto-file files it and it
//              then drops off this board on its own.
function wlStageBadge(stage) {
  if (stage === 'reported') return '<span class="badge badge-green" title="Report signed — auto-file will file it, then it leaves the board">✅ Report ready</span>';
  if (stage === 'imaged')   return '<span class="badge badge-orange" title="Scan done — awaiting the report">📷 Imaged</span>';
  if (stage === 'ordered')  return '<span class="badge" title="Ordered — awaiting imaging">📋 Ordered</span>';
  return '<span class="badge" style="opacity:.55">…</span>';
}

function wlRender() {
  const d = wlState.data || {}, items = d.items || [];
  wlCheckNewEmergencies(items);
  const sum = document.getElementById('wl-summary');
  if (sum) sum.textContent = `${d.total || 0} awaiting · ${d.emergency || 0} emergency`
    + (d.sites && d.sites.failed && d.sites.failed.length ? ` · ${d.sites.failed.length} branch(es) unreachable` : '');
  const body = document.getElementById('wl-body');
  if (!body) return;
  // A cross-branch search result view is showing — don't let a live refresh clobber it.
  if (wlState.searchView) return;
  // On-board search filter: show only the matching patient(s) from THIS board, with a
  // banner to clear back. Consent + Check are on the row — no jump to another page.
  if (wlState.filter) {
    const f = wlState.filter;
    const match = items.filter((it) => String(it.mrno || '').replace(/\D/g, '') === f);
    const banner = `<div style="display:flex;align-items:center;gap:8px;margin:2px 2px 12px">
      <span style="font-weight:700">Showing ${match.length} result${match.length !== 1 ? 's' : ''} for "${escapeHtml(f)}"</span>
      <button class="btn btn-sm btn-ghost" onclick="wlClearFilter()">← Back to full board</button></div>`;
    body.innerHTML = banner + (match.length
      ? wlTable(match)
      : `<div class="empty" style="padding:20px"><p>This patient is no longer on the board (report may have been filed).</p></div>`);
    return;
  }
  if (!items.length) { body.innerHTML = `<div class="empty" style="padding:26px"><p>No orders awaiting a result.</p></div>`; return; }
  body.innerHTML = wlTable(items);
}

// Compact RIS-panel table — mirrors Siratech's own RIS panel: one flat, sorted list
// (emergency first, then oldest first), a row per order.
function wlTable(items) {
  return `<div class="table-wrap"><table class="wl-table" style="width:100%">
    <thead><tr>
      <th style="width:34px">#</th><th>Patient</th><th>Exam</th><th>Type</th>
      <th>Priority</th><th>Stage</th><th>Age</th><th>Consent</th><th></th>
    </tr></thead>
    <tbody>${items.map((it, i) => wlRow(it, i)).join('')}</tbody>
  </table></div>`;
}

function wlAge(h) { return h == null ? '' : (h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`); }

// Friendly labels + colour per imaging modality so the board reads at a glance.
const WL_MOD = {
  CT: { label: 'CT', bg: '#3b7ddd' }, MR: { label: 'MRI', bg: '#7c5cff' },
  US: { label: 'US', bg: '#2e9e6b' }, XR: { label: 'X-Ray', bg: '#6b7280' },
  MG: { label: 'Mammo', bg: '#d6568c' },
};
function wlModBadges(modality) {
  if (!modality) return '';
  return String(modality).split(',').map((m) => {
    const k = m.trim().toUpperCase(), info = WL_MOD[k];
    const label = info ? info.label : k, bg = info ? info.bg : '#8a8f98';
    return `<span class="badge" style="background:${bg};color:#fff">${escapeHtml(label)}</span>`;
  }).join(' ');
}

// A female patient needs a signed non-pregnancy consent BEFORE imaging. Detect
// female from the HIS gender and surface the consent state right on the row.
function wlIsFemale(g) {
  const s = String(g || '').trim().toLowerCase();
  return s.startsWith('f') || /أنث|انث/.test(s);
}
function wlConsentEl(it) {
  if (!wlIsFemale(it.gender)) return '';
  if (it.consentOnFile) return '<span class="badge badge-green" title="Non-pregnancy consent signed">✓ Consent</span>';
  return `<button class="btn btn-sm" style="background:#e0a800;color:#fff;border:none" title="Sign the non-pregnancy consent before imaging" onclick="wlConsent('${jsAttr(it.mrno)}','${jsAttr(it.patientName || '')}','${jsAttr(it.exam || '')}','${jsAttr(it.doctorName || '')}','${jsAttr(it.branch || '')}')">⚠ Consent needed</button>`;
}
function wlConsent(mrno, name, exam, doctor, branch) {
  // QR flow: her data is pre-printed on the official form, she scans the QR, signs
  // on HER OWN phone, and it reflects straight back (the board refreshes to ✓ Consent).
  const prefill = { file_no: mrno, mrno: mrno, mrn: mrno, name: name, procedure: exam,
                    referring_doctor: doctor || '', branch: branch || '' };
  if (typeof openConsentQR === 'function') { openConsentQR(prefill, () => wlLoad(true)); return; }
  if (typeof openConsent === 'function') { openConsent(prefill, () => wlLoad(true)); return; }
  if (typeof toast === 'function') toast('Consent module unavailable', 'err');
}

function wlRow(it, i) {
  // A patient who already has images in DePACS is tinted "almost done": amber once
  // imaged (awaiting report), green once the report is verified (auto-file will file
  // it and it drops off the board). Emergency rows get a red left edge.
  const tint = it.stage === 'reported' ? 'background:rgba(46,158,107,0.10);'
    : it.stage === 'imaged' ? 'background:rgba(224,168,0,0.10);' : '';
  const edge = it.emergency ? 'box-shadow:inset 3px 0 0 var(--danger,#E25555);' : '';
  const age = wlAge(it.ageHours);
  return `<tr style="${tint}${edge}">
    <td style="color:var(--muted)">${i + 1}</td>
    <td><div style="font-weight:700">${escapeHtml(it.patientName || '—')}</div>
      <div style="font-size:11px;color:var(--muted)">${escapeHtml(it.mrno || '')}${it.branch ? ' · ' + escapeHtml(it.branch) : ''}${it.doctorName ? ' · ' + escapeHtml(it.doctorName) : ''}</div></td>
    <td>${it.exam ? escapeHtml(it.exam) : '<span style="color:var(--muted)">—</span>'}</td>
    <td>${wlModBadges(it.modality) || '<span style="color:var(--muted)">—</span>'}</td>
    <td>${it.emergency ? '<span class="badge badge-red">Emergency</span>' : '<span class="badge">Routine</span>'}</td>
    <td>${wlStageBadge(it.stage)}</td>
    <td>${age ? `<span class="badge badge-purple" title="time since ordered">${age}</span>` : ''}</td>
    <td>${wlConsentEl(it)}</td>
    <td style="white-space:nowrap"><button class="btn btn-sm btn-ghost" onclick="wlToggle(${i}, '${jsAttr(it.mrno)}', ${Number(it.site) || 0}, this)">Check</button></td>
  </tr>
  <tr id="wl-dr-${i}" style="display:none"><td colspan="9" style="background:var(--card-alt,#f7f7fa);padding:10px"><div id="wl-d-${i}"></div></td></tr>`;
}

// Read-only drill: expand a detail row that matches the finished DePACS report(s) to
// this patient's order(s).
async function wlToggle(i, mrno, site, btn) {
  const row = document.getElementById('wl-dr-' + i), box = document.getElementById('wl-d-' + i);
  if (!row || !box) return;
  if (row.style.display !== 'none') { row.style.display = 'none'; btn.textContent = 'Check'; return; }
  row.style.display = ''; btn.textContent = 'Hide'; box.innerHTML = LOADING_HTML;
  try {
    const d = await API.get(`/radiology/results/match/${encodeURIComponent(mrno)}${site ? `?site=${site}` : ''}`);
    box.innerHTML = wlMatch(d);
  } catch (e) {
    box.innerHTML = `<div class="ho-note">${escapeHtml(e.message || 'Result match failed')}</div>`;
  }
}

function wlMatch(d) {
  const orders = (d && d.orders) || [];
  if (!orders.length) return `<div class="ho-note">No order awaiting a result for this file.</div>`;
  const card = (t) => {
    const s = t.study || {}, rep = t.report || {};
    if (t.decision === 'unique') {
      return `<div class="ho-de-box ok" style="display:block;margin-bottom:6px">
        <div><b>✅ ${escapeHtml(t.test.serviceName || '')}</b> — report ready
          · ${escapeHtml(s.modality || '')} ${escapeHtml(s.desc || '')}${rep.pdfOk ? ' · 📄 PDF' : ''}</div>
        ${rep.preview ? `<div style="font-size:12px;color:var(--muted);margin-top:3px">${escapeHtml(rep.preview.slice(0, 200))}…</div>` : ''}
      </div>`;
    }
    return `<div class="ho-de-box" style="display:block;margin-bottom:6px;border-color:var(--warn,#b7791f)">
      <div><b>⚠️ ${escapeHtml(t.test.serviceName || '')}</b> — ${escapeHtml(t.reason || t.decision)}. Manual review.</div></div>`;
  };
  return orders.map(o => (o.tests || []).map(card).join('')).join('')
    + `<div style="font-size:12px;color:var(--muted);margin-top:2px">A verified report is filed automatically — it will drop off the board on its own.</div>`;
}

// Deep-link into the trusted Handoff wizard, pre-loaded with this patient's file.
function wlOpenHandoff(mrno) {
  window._handoffPreload = mrno;
  showPage('handoff');
}

// Search behaves like the RIS panel's search: it FILTERS the current board first, so
// the patient (with their consent + Check right there) stays on the worklist instead
// of jumping to another page. Only if the file isn't on this board does it do a
// TARGETED cross-branch find — and only for a real identifier (file / national ID /
// iqama / mobile, numeric ≥6 digits), never a browse of the whole hospital.
async function wlSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  const digits = q.replace(/\D/g, '');
  if (digits.length < 6) {
    if (typeof toast === 'function') toast('Enter a full file # / ID / iqama / mobile — search never lists everyone', 'err');
    return;
  }
  // 1) On THIS board? Filter in place — consent + everything is right here.
  const items = (wlState.data && wlState.data.items) || [];
  if (items.some((it) => String(it.mrno || '').replace(/\D/g, '') === digits)) {
    wlState.searchView = false; wlState.filter = digits; wlRender(); return;
  }
  // 2) Not on the board → targeted cross-branch find, shown with consent (no jump).
  try {
    const d = await API.get('/radiology/find?q=' + encodeURIComponent(q));
    const pts = (d && d.patients) || [];
    if (!pts.length) { if (typeof toast === 'function') toast('No patient with this number on any branch', 'err'); return; }
    wlShowMatches(pts);
  } catch (e) { if (typeof toast === 'function') toast(e.message || 'Search failed', 'err'); }
}
function wlClearFilter() {
  wlState.filter = null; wlState.searchView = false;
  const s = document.getElementById('wl-search'); if (s) s.value = '';
  wlRender();
}
// Cross-branch matches (patient not on this board): show each with a consent button
// (female) + Open, right here — no auto-jump. A live refresh won't clobber this view
// (searchView guard); "Back" returns to the board.
function wlShowMatches(pts) {
  wlState.searchView = true; wlState.filter = null;
  const body = document.getElementById('wl-body');
  if (!body) return;
  const rows = pts.slice(0, 25).map((p) => {
    const mrn = String(p.mrno || p.file_no || '');
    const nm = p.patientName || p.name || '—';
    const sub = [p.gender, p.birthDate || p.dob, p.branch].filter(Boolean).map(escapeHtml).join(' · ');
    const consent = wlIsFemale(p.gender)
      ? `<button class="btn btn-sm" style="background:#e0a800;color:#fff;border:none" onclick="wlConsent('${jsAttr(mrn)}','${jsAttr(nm)}','','','${jsAttr(p.branch || '')}')">⚠ Consent</button>` : '';
    return `<div class="card" style="margin-bottom:6px;padding:10px;display:flex;justify-content:space-between;align-items:center;gap:10px">
      <div><div style="font-weight:700">${escapeHtml(nm)} <span style="color:var(--muted);font-weight:500">· ${escapeHtml(mrn)}</span></div>
        ${sub ? `<div style="font-size:12px;color:var(--muted)">${sub}</div>` : ''}</div>
      <div style="display:flex;gap:6px;align-items:center">${consent}
        <button class="btn btn-sm btn-primary" onclick="wlOpenHandoff('${jsAttr(mrn)}')">Open →</button></div></div>`;
  }).join('');
  body.innerHTML = `<div style="margin:6px 2px 10px;font-weight:700">${pts.length} found on other branches — pick the patient</div>${rows}
    <button class="btn btn-sm btn-ghost" style="margin-top:6px" onclick="wlClearFilter()">← Back to worklist</button>`;
}
