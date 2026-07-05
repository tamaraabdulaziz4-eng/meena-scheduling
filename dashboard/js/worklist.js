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
                seenEmerg: null, from: wlTodayLocal(), to: wlTodayLocal(), filter: null, searchView: false,
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
  const base = it.genPatBillingId != null ? 'g' + it.genPatBillingId
    : it.billNo ? 'b' + it.billNo : null;
  if (base == null) return null;
  // A bill can bundle several exams (one board row per exam) — key each exam's row
  // separately or the caches would smear one exam's modality/stage onto its sibling.
  const svc = it.svcId != null ? it.svcId : (it.svcSeq != null ? 's' + it.svcSeq : null);
  return svc != null ? base + ':' + svc : base;
}

// Local (KSA) date as YYYY-MM-DD — the operator is in KSA so the browser's local
// date IS the hospital's operational day.
function wlTodayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// The board shows a date RANGE [from, to], defaulting to today only. Widen it with
// the From/To pickers, or step the whole window a day at a time.
// Leaving a search: changing range/branch must drop any active on-board filter or
// cross-branch match view, else the new board is fetched but never painted (the
// searchView guard blocks it) or the old MRN filter re-applies to the new data.
function wlExitSearch() {
  wlState.filter = null; wlState.searchView = false;
  const s = document.getElementById('wl-search'); if (s) s.value = '';
}
function _wlAddDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function wlShiftDay(delta) {   // step the whole [from,to] window by a day
  wlState.from = _wlAddDays(wlState.from, delta);
  wlState.to = _wlAddDays(wlState.to, delta);
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlLoad(true);
}
function wlSetFrom(v) {
  if (!v) return;
  wlState.from = v;
  if (wlState.to < v) wlState.to = v;                       // keep from <= to
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlLoad(true);
}
function wlSetTo(v) {
  if (!v) return;
  wlState.to = v;
  if (v < wlState.from) wlState.from = v;
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlLoad(true);
}
function wlTodayRange() {
  wlState.from = wlTodayLocal(); wlState.to = wlTodayLocal();
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlLoad(true);
}
function wlSyncDayControls() {
  const f = document.getElementById('wl-from'); if (f) f.value = wlState.from;
  const t = document.getElementById('wl-to'); if (t) t.value = wlState.to;
  const btn = document.getElementById('wl-today-btn');
  const isToday = wlState.from === wlTodayLocal() && wlState.to === wlTodayLocal();
  if (btn) btn.className = 'btn btn-sm ' + (isToday ? 'btn-primary' : 'btn-ghost');
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
  setTopbar('Radiology worklist', 'Orders awaiting a result — emergency first, newest first');
  wlState.filter = null; wlState.searchView = false;   // never reopen stuck in a search view
  wlState.from = wlTodayLocal(); wlState.to = wlTodayLocal();   // default: today only
  // A "Open in Worklist" jump from the Orders page pre-seeds this — land straight on
  // that patient (search finds them even if they're not on today's board).
  const jumpMrn = window._wlPendingFilter; window._wlPendingFilter = null;
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Worklist', 'Radiology worklist', 'Every order awaiting a result')}
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(-1)" title="Previous day">◀</button>
          <span style="font-size:12px;color:var(--muted)">From</span>
          <input type="date" id="wl-from" class="input" value="${wlState.from}" onchange="wlSetFrom(this.value)" style="width:145px" title="From date">
          <span style="font-size:12px;color:var(--muted)">To</span>
          <input type="date" id="wl-to" class="input" value="${wlState.to}" onchange="wlSetTo(this.value)" style="width:145px" title="To date">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(1)" title="Next day">▶</button>
          <button id="wl-today-btn" class="btn btn-sm btn-primary" onclick="wlTodayRange()" title="Today only">Today</button>
        </div>
        <select id="wl-branch" class="input" style="min-width:160px" onchange="wlOnBranch()">
          <option value="">All branches</option>
        </select>
        <input id="wl-search" class="input" placeholder="🔍 Type file # to filter — or full ID / iqama / mobile"
               style="min-width:230px;flex:1" inputmode="numeric" autocomplete="off"
               oninput="wlLiveFilter(this.value)" onkeydown="if(event.key==='Enter')wlSearch(this.value)">
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
  await wlLoad();
  if (jumpMrn) {
    const inp = document.getElementById('wl-search');
    if (inp) inp.value = jumpMrn;
    wlSearch(jumpMrn);   // filters the board, or finds the patient cross-branch if not on it
  }
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
  qs.set('from', wlState.from); qs.set('to', wlState.to);   // explicit range (defaults to today only)
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
  const anyMissing = items.some((it) => !it.stage || !it.exam);
  if (silent && !anyMissing && (Date.now() - (wlState.lastEnrich || 0) < 120000)) return;
  _wlEnrichBusy = true;
  // Show the loading shimmer on the not-yet-filled cells while this pass runs.
  if (anyMissing) { wlState.enriching = true; if (document.getElementById('wl-body')) wlRender(); }
  const mkQs = (flags) => {
    const qs = new URLSearchParams();
    if (wlState.site) qs.set('sites', wlState.site);
    qs.set('from', wlState.from); qs.set('to', wlState.to);
    for (const k of Object.keys(flags)) qs.set(k, flags[k]);
    return qs.toString();
  };
  // Two INDEPENDENT passes in parallel — this is what makes the board feel like the
  // native RIS panel. exam+modality is pure HIS work and returns quickly; the
  // pipeline stage does per-patient DePACS matching and is the slow one. The old
  // single combined request made the Exam/Type columns shimmer until the SLOWEST
  // work finished; now each pass merges + repaints the moment it lands.
  try {
    await Promise.all([
      API.get('/radiology/worklist?' + mkQs({ modality: '1' })).then((d) => wlMergeEnrich(d)).catch(() => {}),
      API.get('/radiology/worklist?' + mkQs({ ready: '1' })).then((d) => wlMergeEnrich(d)).catch(() => {}),
    ]);
    wlState.lastEnrich = Date.now();
  } finally {
    _wlEnrichBusy = false;
    // Settle: turn the shimmer off and repaint with whatever filled in (rows still
    // empty after this pass fall back to "—" — that's the connector's per-order cap).
    wlState.enriching = false;
    if (document.getElementById('wl-body')) wlRender();
  }
}

// Merge one enrichment pass onto the visible rows and repaint IMMEDIATELY — the
// sibling pass may still be running, but whatever this one filled shows now.
function wlMergeEnrich(d) {
  if (wlState.modCache.size > 3000) { wlState.modCache.clear(); wlState.stageCache.clear(); }
  const enr = new Map();
  for (const it of ((d && d.items) || [])) {
    const k = wlRowKey(it);
    if (!k) continue;                            // keyless → don't cache/merge (collision-safe)
    enr.set(k, { modality: it.modality, exam: it.exam, stage: it.stage });
    if (it.modality || it.exam) wlState.modCache.set(k, { modality: it.modality, exam: it.exam });
    if (it.stage) wlState.stageCache.set(k, it.stage);
  }
  if (enr.size && wlState.data && Array.isArray(wlState.data.items)) {
    for (const it of wlState.data.items) {
      const k = wlRowKey(it); if (!k) continue;
      const e = enr.get(k);
      if (!e) continue;
      if (e.modality && it.modality !== e.modality) it.modality = e.modality;
      if (e.exam && it.exam !== e.exam) it.exam = e.exam;
      if (e.stage && it.stage !== e.stage) it.stage = e.stage;
    }
  }
  if (document.getElementById('wl-body')) wlRender();
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
  // The main board is ONLY the pre-scan queue (who still needs consent + imaging).
  // The moment images land in DePACS the row moves to the "Imaged" strip; the moment
  // the report is signed it moves to the "Reported" strip (auto-file takes it from
  // there). Both strips open with one click, so nothing is ever silently lost.
  const active = items.filter((it) => it.stage !== 'reported' && it.stage !== 'imaged');
  const imaged = items.filter((it) => it.stage === 'imaged');
  const reported = items.filter((it) => it.stage === 'reported');
  const sum = document.getElementById('wl-summary');
  const activeEmerg = active.filter((it) => it.emergency).length;   // emergencies still in the queue, not board-wide
  if (sum) sum.textContent = `${active.length} waiting to scan${activeEmerg ? ` (${activeEmerg} emergency)` : ''}`
    + (imaged.length ? ` · ${imaged.length} imaged` : '')
    + (reported.length ? ` · ${reported.length} reported` : '')
    + (d.sites && d.sites.failed && d.sites.failed.length ? ` · ${d.sites.failed.length} branch(es) unreachable` : '');
  const body = document.getElementById('wl-body');
  if (!body) return;
  // A cross-branch search result view is showing — don't let a live refresh clobber it.
  if (wlState.searchView) return;
  // Live typeahead: as the operator types digits, filter the board to the MRNs that
  // START WITH what's typed (prefix), so the patient narrows down live — no need to
  // type the whole number or press Enter. Consent + Check stay on the row. A search
  // shows EVERYTHING for that patient, including reported rows (status lookup).
  if (wlState.filter) {
    const f = wlState.filter;
    const match = items.filter((it) => String(it.mrno || '').replace(/\D/g, '').startsWith(f));
    const banner = `<div style="display:flex;align-items:center;gap:8px;margin:2px 2px 12px">
      <span style="font-weight:700">${match.length} on this board starting with "${escapeHtml(f)}"</span>
      <button class="btn btn-sm btn-ghost" onclick="wlClearFilter()">← Back to full board</button></div>`;
    body.innerHTML = banner + (match.length
      ? wlTable(match)
      : `<div class="empty" style="padding:20px"><p>No patient on this board starts with "${escapeHtml(f)}".${f.length >= 6 ? ' Press Enter to search all branches.' : ''}</p></div>`);
    return;
  }
  if (!items.length) { body.innerHTML = `<div class="empty" style="padding:26px"><p>No orders awaiting a result.</p></div>`; return; }
  const strip = (id, list, badge, label, prefix) => !list.length ? '' : `
    <div class="card" style="margin-top:10px;padding:8px 12px">
      <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="wlToggleStrip('${id}')">
        ${badge}
        <span style="font-weight:600">${label}</span>
        <span id="wl-${id}-arrow" style="margin-left:auto;color:var(--muted)">▸</span>
      </div>
      <div id="wl-${id}-list" style="display:none;margin-top:8px">${wlTable(list, prefix)}</div>
    </div>`;
  body.innerHTML = (active.length
    ? wlTable(active, 'a')
    : `<div class="empty" style="padding:22px"><p>All caught up — no one is waiting to be scanned.</p></div>`)
    + strip('img', imaged, `<span class="badge badge-orange">📷 ${imaged.length}</span>`, 'Imaged — awaiting the report', 'i')
    + strip('rep', reported, `<span class="badge badge-green">✅ ${reported.length}</span>`, 'Reported — filing to the patient file', 'r');
}

function wlToggleStrip(id) {
  const list = document.getElementById(`wl-${id}-list`), arrow = document.getElementById(`wl-${id}-arrow`);
  if (!list) return;
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : '';
  if (arrow) arrow.textContent = open ? '▸' : '▾';
}

// Compact RIS-panel table — a flat list, NEWEST first (lowest age on top), with
// emergencies pinned above routine so a STAT order is never buried. SIX columns so
// the board fits without sideways scrolling: priority folds into the patient cell,
// modality into the exam cell, age under the stage badge.
function wlTable(items, prefix) {
  const p = prefix || 'a';   // namespace row ids — several tables coexist (board + strips)
  const rows = items.slice().sort((a, b) =>
    (Number(b.emergency) - Number(a.emergency)) || ((a.ageHours || 0) - (b.ageHours || 0)));
  return `<div class="table-wrap"><table class="wl-table" style="width:100%">
    <thead><tr>
      <th style="width:30px">#</th><th>Patient</th><th>Exam</th>
      <th>Stage</th><th>Consent</th><th style="width:64px"></th>
    </tr></thead>
    <tbody>${rows.map((it, i) => wlRow(it, p + i)).join('')}</tbody>
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

function wlRow(it, key) {
  // A patient who already has images in DePACS is tinted "almost done": amber once
  // imaged (awaiting report), green once the report is verified (auto-file will file
  // it and it drops off the board). Emergency rows get a red left edge.
  const tint = it.stage === 'reported' ? 'background:rgba(46,158,107,0.10);'
    : it.stage === 'imaged' ? 'background:rgba(224,168,0,0.10);' : '';
  const edge = it.emergency ? 'box-shadow:inset 3px 0 0 var(--danger,#E25555);' : '';
  const age = wlAge(it.ageHours);
  const n = parseInt(String(key).slice(1), 10) + 1;   // display # within its table
  // While the background HIS enrichment is still running, show a loading shimmer for
  // exam/stage instead of a bare "—" so the board reads as "loading", not broken.
  const p = wlState.enriching;
  const sh = (w) => `<span class="wl-shimmer" style="width:${w}px"></span>`;
  const dash = '<span style="color:var(--muted)">—</span>';
  return `<tr style="${tint}${edge}">
    <td style="color:var(--muted)">${n}</td>
    <td><div style="font-weight:700">${escapeHtml(it.patientName || '—')}
        ${it.emergency ? ' <span class="badge badge-red">Emergency</span>' : ''}</div>
      <div style="font-size:11px;color:var(--muted)">${escapeHtml(it.mrno || '')}${it.branch ? ' · ' + escapeHtml(it.branch) : ''}${it.doctorName ? ' · ' + escapeHtml(it.doctorName) : ''}</div></td>
    <td>${(() => { const mod = wlModBadges(it.modality);
      if (it.exam) return mod + ' <span>' + escapeHtml(it.exam) + '</span>';
      if (p) return mod + ' ' + sh(90);
      return mod || dash; })()}</td>
    <td>${it.stage ? wlStageBadge(it.stage) : (p ? sh(64) : wlStageBadge(null))}
      ${age ? `<div style="font-size:10px;color:var(--muted);margin-top:2px" title="time since ordered">${age} ago</div>` : ''}</td>
    <td>${wlConsentEl(it)}</td>
    <td style="white-space:nowrap"><button class="btn btn-sm btn-ghost" onclick="wlToggle('${key}', '${jsAttr(it.mrno)}', ${Number(it.site) || 0}, this)">Check</button></td>
  </tr>
  <tr id="wl-dr-${key}" style="display:none"><td colspan="6" style="background:var(--card-alt,#f7f7fa);padding:10px"><div id="wl-d-${key}"></div></td></tr>`;
}

// Read-only drill: expand a detail row that matches the finished DePACS report(s) to
// this patient's order(s).
async function wlToggle(key, mrno, site, btn) {
  const row = document.getElementById('wl-dr-' + key), box = document.getElementById('wl-d-' + key);
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

// Live typeahead as the operator types: filter the board to MRNs that START WITH the
// typed digits. Empty box → back to the full board. Purely local (no network), so it
// updates on every keystroke.
function wlLiveFilter(v) {
  const digits = String(v || '').replace(/\D/g, '');
  wlState.searchView = false;
  wlState.filter = digits || null;
  wlRender();
}

// Enter: the live prefix filter already narrows the board. If the typed number
// matches nobody on THIS board, do a TARGETED cross-branch find (real identifier,
// ≥6 digits) — the patient's exam was ordered at another branch.
async function wlSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  const digits = q.replace(/\D/g, '');
  if (!digits) return;
  // On THIS board (prefix)? The live filter is already showing them — keep it.
  const items = (wlState.data && wlState.data.items) || [];
  if (items.some((it) => String(it.mrno || '').replace(/\D/g, '').startsWith(digits))) {
    wlState.searchView = false; wlState.filter = digits; wlRender(); return;
  }
  // Not on this board → cross-branch find needs a full identifier.
  if (digits.length < 6) {
    if (typeof toast === 'function') toast('Nobody on this board. Type the full file # / ID / iqama / mobile to search other branches', 'err');
    return;
  }
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
