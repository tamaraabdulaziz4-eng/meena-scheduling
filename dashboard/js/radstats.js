// ── Radiology statistics (manager dashboard) ─────────────────────────────────
// Live, read-only view of radiology requests across all branches, pulled from
// Siratech HIS through the connector (/api/radiology/stats). Clearly divided:
// totals + priority KPIs, then branch · modality · ordering doctor · department ·
// pending-age · daily trend. Date-range presets + branch filter + auto-refresh.
//
// The paid/unpaid *collection* split is added later from the billing report; a
// banner marks it as pending so managers know what this view does and doesn't
// yet cover.

let radstats = {
  from: '', to: '', preset: '30d',
  branches: [], sel: null,           // sel = Set of selected siteIds (null = all)
  data: null, loading: false,
  modData: null, modLoading: false, modError: '',
  finData: null, finLoading: false, finError: '',
  auto: false, timer: null, clockTimer: null, lastError: '',
};

const RS_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
];

function rsFmtDate(d) { return d.toISOString().slice(0, 10); }

// Today's calendar date in KSA (Asia/Riyadh, UTC+3) as YYYY-MM-DD. Using UTC
// made the "Today" preset — and the end of every range — resolve to *yesterday*
// between 00:00 and 03:00 KSA, silently dropping today's orders even though the
// on-screen clock (also KSA) showed today.
function rsKsaToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) { return new Date().toISOString().slice(0, 10); }
}

function rsPresetRange(id) {
  const end = rsKsaToday();                                 // YYYY-MM-DD in KSA
  const [y, mo, da] = end.split('-').map(Number);
  const base = new Date(Date.UTC(y, mo - 1, da, 12));       // noon-UTC anchor for safe whole-day math
  const minus = (n) => rsFmtDate(new Date(base.getTime() - n * 864e5));
  if (id === 'today') return { from: end, to: end };
  if (id === '7d') return { from: minus(6), to: end };
  if (id === 'month') return { from: end.slice(0, 8) + '01', to: end };
  return { from: minus(29), to: end };                      // 30d
}

async function renderRadStatsPage(opts) {
  opts = opts || {};
  const embed = !!opts.container;           // render the full stats INSIDE a host (e.g. Home) instead of the page
  const isLead = rsIsLead();
  // A team lead is pinned to their own branch; resolve it before the first load.
  if (isLead && !radstats.leadLocked) { await rsApplyLeadScope(); }
  const scopeName = radstats.leadLocked ? (radstats.leadBranchName || 'your branch') : '';
  if (!embed) setTopbar('Radiology statistics', scopeName ? `Live requests · ${scopeName}` : 'Live requests across all branches');
  rsStopAuto();
  radstats._paintedOnce = false;         // entrance animation once per visit/mount
  if (radstats.preset && radstats.preset !== 'custom') {
    const r = rsPresetRange(radstats.preset);
    radstats.from = r.from; radstats.to = r.to;
  }
  const c = opts.container || document.getElementById('content');
  const heroSub = scopeName
    ? `Live request volume for ${escapeHtml(scopeName)} — by modality, doctor and department, straight from Siratech HIS`
    : 'Live request volume by branch, modality, doctor and department — straight from Siratech HIS';
  c.innerHTML = `<div class="cc">
    ${embed ? '' : pageHero('Radiology', 'Radiology statistics', heroSub)}
    <div id="rs-controls"></div>
    <div id="rs-billing-banner"></div>
    <div id="rs-body">${radstats.data ? '' : rsSkeleton()}</div>
  </div>`;
  rsRenderControls();
  rsStartClock();
  rsBindTips();                        // live cursor-following tooltips
  if (radstats.leadUnmatched) {        // fail-closed lead → explain, don't fetch org-wide data
    rsHideOverlay();
    rsRenderUnmatched();
    return;
  }
  if (radstats.data) rsRenderBody();   // show the last result instantly on re-open, refresh underneath
  else if (!embed) rsShowOverlay();    // first load → full-screen branded loader (page only, not embedded)
  if (!isLead) rsLoadBranches();       // managers get the branch picker; leads are pinned
  await rsLoad();
}

// ── Full-screen loader (login-style): cycling status + a progress bar ─────────
const RS_OV_MSGS = [
  'Connecting to Siratech HIS…',
  'Loading all branches…',
  'Aggregating radiology requests…',
  'Reading modality & bills…',
  'Building your dashboard…',
  'Almost ready…',
];
function rsShowOverlay() {
  let ov = document.getElementById('rs-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'rs-overlay'; document.body.appendChild(ov); }
  ov.className = 'rs-overlay show';
  ov.innerHTML = `
    <div class="rs-ov-orb a"></div><div class="rs-ov-orb b"></div>
    <div class="rs-ov-logo"><img src="/meena_logo.png" alt="Meena"></div>
    <div class="rs-ov-msg" id="rs-ov-msg">${RS_OV_MSGS[0]}</div>
    <div class="rs-ov-bar"><div class="rs-ov-fill" id="rs-ov-fill"></div></div>
    <div class="rs-ov-pct" id="rs-ov-pct">0%</div>`;
  let mi = 0, p = 0;
  clearInterval(radstats.ovMsgTimer); clearInterval(radstats.ovBarTimer);
  radstats.ovMsgTimer = setInterval(() => {
    mi = (mi + 1) % RS_OV_MSGS.length;
    const m = document.getElementById('rs-ov-msg');
    if (m) { m.style.opacity = '0'; setTimeout(() => { m.textContent = RS_OV_MSGS[mi]; m.style.opacity = '1'; }, 180); }
  }, 1500);
  radstats.ovBarTimer = setInterval(() => {
    p = Math.min(92, p + Math.max(0.6, (92 - p) * 0.06));   // ease toward 92%, finish on load
    const f = document.getElementById('rs-ov-fill'), pc = document.getElementById('rs-ov-pct');
    if (f) f.style.width = p + '%'; if (pc) pc.textContent = Math.round(p) + '%';
  }, 220);
}
function rsHideOverlay() {
  clearInterval(radstats.ovMsgTimer); clearInterval(radstats.ovBarTimer);
  const ov = document.getElementById('rs-overlay');
  if (!ov || !ov.classList.contains('show')) return;
  const f = document.getElementById('rs-ov-fill'), pc = document.getElementById('rs-ov-pct');
  if (f) f.style.width = '100%'; if (pc) pc.textContent = '100%';
  const m = document.getElementById('rs-ov-msg'); if (m) m.textContent = 'Ready';
  setTimeout(() => { ov.classList.add('fade'); setTimeout(() => { ov.className = 'rs-overlay'; }, 450); }, 260);
}

// Live ticking clock (KSA time) so the page reads as real-time.
function rsClockNow() {
  try { return new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Riyadh', hour12: false }); }
  catch (e) { return new Date().toLocaleTimeString(); }
}
function rsStartClock() {
  if (radstats.clockTimer) clearInterval(radstats.clockTimer);
  radstats.clockTimer = setInterval(() => {
    const el = document.getElementById('rs-clock-t');
    if (!el) { clearInterval(radstats.clockTimer); radstats.clockTimer = null; return; }
    el.textContent = rsClockNow();
  }, 1000);
}

// Shimmer placeholder that mirrors the real layout, so a slow first load looks
// alive (not hung) instead of a blank/plain spinner.
function rsSkeleton() {
  const n = radstats.branches.length || 14;
  const card = `<div class="skel" style="height:74px;border-radius:14px"></div>`;
  const block = (h) => `<div class="skel" style="height:${h}px;border-radius:14px"></div>`;
  return `
    <div class="rs-boot">
      <div class="rs-boot-orb o1"></div><div class="rs-boot-orb o2"></div>
      <div class="rs-boot-logo"><img src="/meena_logo.png" alt="Meena"></div>
      <div class="rs-boot-label">Loading live radiology data…</div>
      <div class="rs-boot-sub">${n} branches · Siratech HIS</div>
      <div class="ploader-dots"><i></i><i></i><i></i></div>
    </div>
    <div class="rs-kpis">${Array(5).fill(card).join('')}</div>
    <div class="rs-grid2">${block(210)}${block(210)}</div>
    ${block(120)}
    ${block(190)}
    <div class="rs-grid2">${block(240)}${block(240)}</div>`;
}

// Load the real branch list so the picker shows every branch by name.
async function rsLoadBranches() {
  if (radstats.branches.length) { rsRenderControls(); return; }
  try {
    const d = await API.get('/radiology/branches');
    radstats.branches = (d && d.branches) || [];
  } catch (e) { /* picker just stays hidden; stats still default to all */ }
  rsRenderControls();
}

// null selection (or all selected) means "all branches" → send no sites param.
function rsSitesParam() {
  if (!radstats.sel || !radstats.branches.length) return '';
  if (radstats.sel.size === radstats.branches.length) return '';
  return [...radstats.sel].join(',');
}

// ── Per-branch scoping (team leads see only their own branch) ─────────────────
// A team lead ('admin') is pinned to one branch; managers/superadmin see all.
// We map the Meena branch name to its Siratech siteId at runtime (no stored map
// needed) — handling both the "NEST 1"/"N6" code scheme and plain location names.
function rsIsLead() { return currentUser?.role === 'admin'; }

let _rsBranchListCache = null;
async function rsBranchListCached() {
  if (_rsBranchListCache) return _rsBranchListCache;
  try { const d = await API.get('/radiology/branches'); _rsBranchListCache = (d && d.branches) || []; }
  catch (e) { _rsBranchListCache = []; }
  return _rsBranchListCache;
}

function _rsBranchKey(s) {
  return String(s || '').toLowerCase()
    .replace(/[–—]/g, ' ').replace(/[-_]/g, ' ')
    .replace(/[^a-z0-9؀-ۿ ]+/g, ' ')
    .replace(/\b(meena|center|centre|clinic|medical|home|health|care|hhc|branch|nest|the|of|and|al)\b/g, ' ')
    .replace(/\b[nyd]\d{1,2}\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function _rsHisCode(b) { return String(b.shortName || '').split(/[-–—]/)[0].trim().toLowerCase().replace(/\s+/g, ''); }
function _rsHisLoc(b) { const p = String(b.shortName || '').split(/[-–—]/).slice(1).join(' '); return _rsBranchKey(p || b.name); }

// Map a Meena branch name → the HIS branch object (or null if we can't be sure).
function rsMatchSite(branchName, list) {
  const raw = String(branchName || '').trim();
  if (!raw || !list || !list.length) return null;
  const m = raw.match(/\b(?:nest\s*|n)(\d{1,2})\b/i);
  if (m) { const code = 'n' + m[1]; const hit = list.find((b) => _rsHisCode(b) === code); if (hit) return hit; }
  const want = _rsBranchKey(raw);
  if (want) {
    let hit = list.find((b) => _rsHisLoc(b) === want || _rsBranchKey(b.name) === want);
    if (!hit) hit = list.find((b) => {
      const l = _rsHisLoc(b), n = _rsBranchKey(b.name);
      return (l && (l.includes(want) || want.includes(l))) || (n && (n.includes(want) || want.includes(n)));
    });
    if (hit) return hit;
  }
  return null;
}

// Resolve (and cache) the logged-in team lead's own HIS branch. null = no match.
let _rsMySiteResolved = false, _rsMySite = null;
async function rsMySite() {
  if (_rsMySiteResolved) return _rsMySite;
  _rsMySiteResolved = true;
  const list = await rsBranchListCached();
  _rsMySite = rsMatchSite(currentUser?.branch_name, list);
  return _rsMySite;
}

// For a team lead: pin the picker to their branch before the first load.
async function rsApplyLeadScope() {
  const mine = await rsMySite();
  if (mine) {
    radstats.branches = await rsBranchListCached();      // so the label resolves
    radstats.sel = new Set([mine.siteId]);
    radstats.leadLocked = true;
    radstats.leadUnmatched = false;
    radstats.leadBranchName = currentUser?.branch_name || mine.shortName || mine.name;
  } else {
    // FAIL CLOSED. A team lead whose Meena branch name we can't resolve to a HIS
    // site must NOT fall through to org-wide data for all 14 branches. Pin to an
    // impossible site so every query (stats, refresh, monthly report) returns
    // nothing, and flag it so the UI explains why instead of leaking or blanking.
    radstats.branches = await rsBranchListCached();
    radstats.sel = new Set([-1]);
    radstats.leadLocked = true;
    radstats.leadUnmatched = true;
    radstats.leadBranchName = currentUser?.branch_name || 'your branch';
  }
}

function rsRenderUnmatched() {
  const b = document.getElementById('rs-body');
  if (!b) return;
  b.innerHTML = `<div class="card" style="text-align:center;padding:34px 20px">
    <div style="font-size:34px">🔒</div>
    <div style="font-weight:800;margin-top:8px">Your branch isn't linked yet</div>
    <div style="color:var(--muted);font-size:13px;margin-top:6px;max-width:440px;margin-inline:auto;line-height:1.6">
      We couldn't match <b>${escapeHtml(radstats.leadBranchName || 'your branch')}</b> to a branch in the hospital
      system, so its statistics can't be shown here. Please ask an administrator to link your branch.</div>
  </div>`;
}

function rsRenderControls() {
  const box = document.getElementById('rs-controls');
  if (!box) return;
  const presets = RS_PRESETS.map((p) =>
    `<button class="rs-chip${radstats.preset === p.id ? ' on' : ''}" onclick="rsSetPreset('${p.id}')">${p.label}</button>`).join('');
  box.innerHTML = `
    <div class="card rs-controls">
      <div class="rs-ctl-row">
        <div class="rs-presets">${presets}</div>
        <div class="rs-dates">
          <label>From <input type="date" id="rs-from" value="${escapeHtml(radstats.from)}" onchange="rsSetCustom()"></label>
          <label>To <input type="date" id="rs-to" value="${escapeHtml(radstats.to)}" onchange="rsSetCustom()"></label>
        </div>
        <div class="rs-ctl-actions">
          <span class="rs-clock" id="rs-clock"><span class="rs-clock-dot"></span><span id="rs-clock-t">${rsClockNow()}</span></span>
          <label class="rs-auto"><input type="checkbox" id="rs-auto" ${radstats.auto ? 'checked' : ''} onchange="rsToggleAuto()"> Auto</label>
          <button class="ghost" onclick="rsOpenReport()" title="Monthly presentation report with comparison to last month">📊 Monthly report</button>
          <button class="open pri" style="width:auto" onclick="rsLoad(false, true)" ${radstats.loading ? 'disabled' : ''} title="Pull fresh data from the hospital system now">${radstats.loading ? 'Loading…' : '↻ Refresh (live)'}</button>
        </div>
      </div>
      ${rsBranchPicker()}
    </div>`;
}

function rsBranchPicker() {
  // Team lead: pinned to their own branch — show it as a single read-only chip.
  if (radstats.leadLocked) {
    return `<div class="rs-branches">
        <span class="rs-branches-lbl">Branch</span>
        <button class="rs-bchip on" disabled title="You see your own branch only">${escapeHtml(radstats.leadBranchName || 'Your branch')}</button>
      </div>`;
  }
  if (!radstats.branches.length) return '';
  // Single-select dropdown: "All branches" or one branch (no multi-select chips).
  const cur = (radstats.sel && radstats.sel.size === 1) ? String([...radstats.sel][0]) : '';
  const opts = `<option value="">All branches (${radstats.branches.length})</option>` +
    radstats.branches.map((b) =>
      `<option value="${b.siteId}"${String(b.siteId) === cur ? ' selected' : ''}>${escapeHtml(b.shortName || b.name)}</option>`).join('');
  return `<div class="rs-branches">
      <span class="rs-branches-lbl">Branch</span>
      <select class="rep-select" style="max-width:260px" onchange="rsSelectBranch(this.value)">${opts}</select>
    </div>`;
}

function rsSelectBranch(v) {
  radstats.sel = v ? new Set([Number(v)]) : null;   // '' → all branches
  rsRenderControls();
  rsLoad();
}
function rsAllBranches() { radstats.sel = null; rsRenderControls(); rsLoad(); }

function rsSetPreset(id) {
  radstats.preset = id;
  const r = rsPresetRange(id);
  radstats.from = r.from; radstats.to = r.to;
  rsRenderControls();
  rsLoad();
}
function rsSetCustom() {
  const f = document.getElementById('rs-from'), t = document.getElementById('rs-to');
  radstats.from = (f && f.value) || radstats.from;
  radstats.to = (t && t.value) || radstats.to;
  radstats.preset = 'custom';
  rsRenderControls();
  rsLoad();
}
function rsToggleAuto() {
  radstats.auto = !radstats.auto;
  if (radstats.auto) rsStartAuto(); else rsStopAuto();
}
function rsStartAuto() {
  rsStopAuto();
  radstats.timer = setInterval(() => {
    if (typeof currentPage !== 'undefined' && currentPage !== 'radstats') { rsStopAuto(); return; }
    if (!document.getElementById('rs-body')) { rsStopAuto(); return; }
    rsLoad(true);
  }, 60000);
}
function rsStopAuto() { if (radstats.timer) { clearInterval(radstats.timer); radstats.timer = null; } }

async function rsLoad(silent, force) {
  // Every control (preset, branch toggle, "All", custom dates, auto-refresh) fires
  // rsLoad. A slow selection could resolve AFTER a newer, faster one and overwrite
  // it — body showing branch A while the controls say "All". Stamp each request and
  // ignore any response that isn't the most recent.
  const myReq = (radstats._reqSeq = (radstats._reqSeq || 0) + 1);
  radstats.loading = true;
  radstats.lastError = '';
  if (!silent) rsRenderControls();
  const bodyEl = document.getElementById('rs-body');
  if (bodyEl && radstats.data) bodyEl.classList.add('rs-refreshing');   // keep data visible, show it's updating
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const _s = rsSitesParam(); if (_s) q.set('sites', _s);
  q.set('full', '1');                  // ONE call returns everything (requests + modality + revenue)
  if (force) q.set('nocache', '1');    // Refresh button → skip cache, pull truly live now
  try {
    const d = await API.get('/radiology/stats?' + q.toString());
    if (myReq !== radstats._reqSeq) return;   // superseded by a newer selection — drop this stale result
    radstats.data = d;
    radstats.modData = d.modality || null;   // arrives together — no separate/late panels
    radstats.finData = d.financial || null;
    radstats.modError = ''; radstats.finError = '';
  } catch (e) {
    if (myReq !== radstats._reqSeq) return;
    radstats.lastError = (e && e.message) || 'Could not load statistics';
  } finally {
    if (myReq === radstats._reqSeq) {   // only the latest request owns the UI state
      radstats.loading = false;
      rsHideOverlay();                  // everything in → dismiss the full-screen loader
      rsRenderControls();
      rsRenderBody();
    }
  }
}

// Exact modality mix is slower (per-order detail calls), so it loads on demand.
async function rsLoadModality() {
  if (radstats.modLoading) return;
  radstats.modLoading = true; radstats.modError = '';
  rsRenderBody();
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const _s = rsSitesParam(); if (_s) q.set('sites', _s);
  q.set('modality', '1');
  try {
    const d = await API.get('/radiology/stats?' + q.toString());
    radstats.modData = d.modality || { mix: [], sampled: 0, ofTotal: 0 };
  } catch (e) {
    radstats.modError = (e && e.message) || 'Could not load modality mix';
  } finally {
    radstats.modLoading = false;
    rsRenderBody();
  }
}

// Revenue & payer split is slower (per-order bill reads), so it loads on demand.
async function rsLoadFinancial() {
  if (radstats.finLoading) return;
  radstats.finLoading = true; radstats.finError = '';
  rsRenderBody();
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const _s = rsSitesParam(); if (_s) q.set('sites', _s);
  q.set('financial', '1');
  try {
    const d = await API.get('/radiology/stats?' + q.toString());
    radstats.finData = d.financial || { revenue: 0, patient: 0, sponsor: 0, sampled: 0, ofTotal: 0 };
  } catch (e) {
    radstats.finError = (e && e.message) || 'Could not load revenue';
  } finally {
    radstats.finLoading = false;
    rsRenderBody();
  }
}

// ── rendering ─────────────────────────────────────────────────────────────────
const RS_MOD_COLOR = { CT: '#6B4EFF', MRI: '#0ea5e9', 'X-Ray': '#22c55e', Ultrasound: '#f59e0b', Mammography: '#ec4899', 'DEXA / Bone Density': '#14b8a6', Fluoroscopy: '#8b5cf6', Other: '#94a3b8' };
const rsNum = (n) => Number(n || 0).toLocaleString();
const rsPct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

function rsBarRows(items, color, max0, opts) {
  if (!items || !items.length) return `<div class="rs-empty">No data</div>`;
  const drill = opts && opts.drill;
  const total = items.reduce((a, i) => a + i.count, 0);
  const max = max0 || Math.max(1, ...items.map((i) => i.count));
  return `<div class="rs-bars">` + items.map((i) => {
    const label = escapeHtml(String(i.label == null || i.label === '' ? 'Unknown' : i.label));
    const pct = Math.round((i.count / max) * 100);
    const col = typeof color === 'function' ? color(i) : (color || 'var(--accent)');
    const tip = `<b>${label}</b><br>${rsNum(i.count)} · ${rsPct(i.count, total)}% of shown`;
    const clickable = drill && i.site != null;
    const attrs = clickable
      ? ` class="rs-bar rs-bar-click" role="button" tabindex="0" onclick="rsDrillBranch(${i.site})" onkeydown="if(event.key==='Enter')rsDrillBranch(${i.site})"`
      : ` class="rs-bar"`;
    return `<div${attrs} data-tip="${escapeHtml(tip)}">
      <div class="rs-bar-label" title="${label}">${label}${clickable ? '<span class="rs-bar-go">›</span>' : ''}</div>
      <div class="rs-bar-track"><div class="rs-bar-fill" style="width:${pct}%;background:${col}"></div></div>
      <div class="rs-bar-val">${rsNum(i.count)}<span class="rs-bar-share">${rsPct(i.count, total)}%</span></div>
    </div>`;
  }).join('') + `</div>`;
}

// Drill the whole dashboard into one branch by clicking its bar (managers only —
// a team lead is already pinned). Selecting just that branch re-scopes every
// panel + KPI; the "All" chip in the picker brings everything back.
function rsDrillBranch(site) {
  if (rsIsLead() || radstats.leadLocked) return;
  const id = Number(site);
  if (!Number.isFinite(id)) return;
  // Toggle off if it's already the sole focus → back to all.
  if (radstats.sel && radstats.sel.size === 1 && radstats.sel.has(id)) { radstats.sel = null; }
  else { radstats.sel = new Set([id]); }
  rsRenderControls();
  rsLoad();
  const b = document.getElementById('rs-body'); if (b) b.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Live cursor-following tooltip (works for any element with [data-tip]) ──────
function rsBindTips() {
  if (radstats._tipsBound) return;
  radstats._tipsBound = true;
  const move = (e) => {
    const src = e.target;
    const el = src && src.closest ? src.closest('[data-tip]') : null;
    let tip = document.getElementById('rs-tip');
    if (!el) { if (tip) tip.classList.remove('show'); return; }
    if (!tip) { tip = document.createElement('div'); tip.id = 'rs-tip'; tip.className = 'rs-tip'; document.body.appendChild(tip); }
    tip.innerHTML = el.getAttribute('data-tip') || '';
    tip.classList.add('show');
    const pad = 16, r = tip.getBoundingClientRect();
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  };
  document.addEventListener('mousemove', move, { passive: true });
  document.addEventListener('mouseleave', () => { const t = document.getElementById('rs-tip'); if (t) t.classList.remove('show'); }, true);
}

// Lightweight SVG donut with a legend — no chart library.
function rsDonut(segs, opts) {
  segs = (segs || []).filter((s) => s.count > 0);
  const total = segs.reduce((a, s) => a + s.count, 0);
  if (!total) return `<div class="rs-empty">No data</div>`;
  const R = 54, C = 2 * Math.PI * R, cx = 70, cy = 70, sw = 20;
  let off = 0;
  const arcs = segs.map((s) => {
    const len = (s.count / total) * C;
    const tip = `<b>${escapeHtml(s.label)}</b><br>${rsNum(s.count)} · ${rsPct(s.count, total)}%`;
    const el = `<circle class="rs-arc" cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${sw}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cy})"
      data-tip="${escapeHtml(tip)}"></circle>`;
    off += len; return el;
  }).join('');
  const legend = segs.map((s) => `<div class="rs-leg" data-tip="${escapeHtml(`<b>${escapeHtml(s.label)}</b><br>${rsNum(s.count)} · ${rsPct(s.count, total)}%`)}">
      <span class="rs-leg-dot" style="background:${s.color}"></span>
      <span class="rs-leg-l" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>
      <span class="rs-leg-v">${rsNum(s.count)} · ${rsPct(s.count, total)}%</span></div>`).join('');
  const cVal = opts && opts.centerVal != null ? opts.centerVal : total;
  return `<div class="rs-donut-wrap">
    <svg viewBox="0 0 140 140" class="rs-donut">${arcs}
      <text x="70" y="67" text-anchor="middle" class="rs-donut-n">${rsNum(cVal)}</text>
      <text x="70" y="85" text-anchor="middle" class="rs-donut-l">${escapeHtml((opts && opts.centerLabel) || 'total')}</text>
    </svg>
    <div class="rs-legend">${legend}</div>
  </div>`;
}

// Smooth-ish area + line trend with gridlines and hover dots.
function rsArea(daily) {
  if (!daily || !daily.length) return `<div class="rs-empty">No data</div>`;
  const W = 720, H = 180, pad = 30, n = daily.length;
  const max = Math.max(1, ...daily.map((x) => x.count));
  const X = (i) => pad + (n <= 1 ? (W - 2 * pad) / 2 : (i / (n - 1)) * (W - 2 * pad));
  const Y = (v) => H - pad - (v / max) * (H - 2 * pad);
  const pts = daily.map((x, i) => `${X(i).toFixed(1)},${Y(x.count).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `M${X(0).toFixed(1)},${H - pad} L${pts.join(' L')} L${X(n - 1).toFixed(1)},${H - pad} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = H - pad - f * (H - 2 * pad);
    return `<line x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}" class="rs-grid"/><text x="${pad - 6}" y="${y + 3}" text-anchor="end" class="rs-axis">${Math.round(max * f)}</text>`;
  }).join('');
  const dots = daily.map((x, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(x.count).toFixed(1)}" r="9" class="rs-dot-hit" data-tip="${escapeHtml(`<b>${escapeHtml(x.date)}</b><br>${rsNum(x.count)} requests`)}"/><circle cx="${X(i).toFixed(1)}" cy="${Y(x.count).toFixed(1)}" r="3" class="rs-dot"/>`).join('');
  const idxs = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  const xl = idxs.map((i) => `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="rs-axis">${escapeHtml(daily[i].date.slice(5))}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="rs-area">
    <defs><linearGradient id="rsg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#rsg)"/><path d="${line}" class="rs-line"/>${dots}${xl}
  </svg>`;
}

function rsPanel(title, inner, sub, cls) {
  return `<div class="card rs-panel${cls ? ' ' + cls : ''}">
    <div class="rs-panel-head"><h3>${escapeHtml(title)}</h3>${sub ? `<span class="rs-panel-sub">${escapeHtml(sub)}</span>` : ''}</div>
    ${inner}
  </div>`;
}

// One Clinical Calm KPI card (accent bar: a=amber b=blue c=green d=violet).
function rsKpi(accent, dot, val, label, sub) {
  return `<div class="kpi ${accent}">
    <div class="kl"><span class="kd" style="background:${dot}"></span>${label}</div>
    <div class="kv">${val}</div>
    ${sub ? `<div class="kt">${sub}</div>` : ''}
  </div>`;
}

function rsRenderBody() {
  const body = document.getElementById('rs-body');
  const banner = document.getElementById('rs-billing-banner');
  if (!body) return;
  body.classList.remove('rs-refreshing');
  // Entrance animation fires ONCE per visit — the 60s Auto refresh (and every
  // silent repaint) recreates the KPI/list nodes, which would replay the rise
  // stagger as a visible flicker. Same .cc-still pin as the worklist; closest()
  // finds the right root whether we're the page or embedded in Home.
  const ccRoot = body.closest('.cc');
  if (ccRoot) { ccRoot.classList.toggle('cc-still', !!radstats._paintedOnce); radstats._paintedOnce = true; }

  if (banner) {
    banner.innerHTML = `<div class="rs-note">
      <b>Live.</b> <b>Patients</b> = distinct people · <b>Requests</b> = orders (a patient can have several) ·
      <b>Exams</b> = individual studies (an order can bundle several). Revenue is <b>billed</b>; since radiology here is
      almost all insurance, a cash “paid/unpaid” split doesn’t apply — we show insurance-covered vs cash counts instead.
    </div>`;
  }

  if (radstats.lastError) {
    body.innerHTML = `<div class="card"><div class="empty" style="padding:26px 16px">
      <div class="empty-icon">⚠️</div>
      <div class="empty-title">Couldn't load statistics</div>
      <div class="empty-sub">${escapeHtml(radstats.lastError)}</div>
      <button class="ghost" style="margin-top:12px" onclick="rsLoad()">Retry</button></div></div>`;
    return;
  }
  const d = radstats.data;
  if (!d || !d.ok) { body.innerHTML = rsSkeleton(); return; }

  const total = d.total || 0;
  const patients = d.patients != null ? d.patients : null;
  const emg = (d.priority && d.priority.emergency) || 0;
  const rtn = (d.priority && d.priority.routine) || 0;
  const aged = (d.aging && d.aging['>7d']) || 0;
  const sitesFail = (d.sites && d.sites.failed && d.sites.failed.length) || 0;

  // Exams (needs modality) and Insurance-covered (needs finance) fill in when
  // their enrichment lands; show a subtle "…" until then.
  const m = radstats.modData, f = radstats.finData;
  // Exams is per-exam; when only a sample was priced we scale it to the total so
  // it isn't misleadingly smaller than the request count.
  let examsVal = '<span class="rs-pending">…</span>';
  // catalogLoaded===false → the exam catalog failed to load, so exams/revenue are a
  // false 0. Show "—" rather than a misleading zero.
  if (m) examsVal = m.catalogLoaded === false ? '—'
    : (m.truncated ? '≈' + rsNum(Math.round((m.exams / Math.max(1, m.sampled)) * m.ofTotal)) : rsNum(m.exams || 0));
  // Insurance-covered: exact when everything was priced, else scaled to the total
  // (a sample of 800 vs 1,118 must NOT read as "the rest are unpaid").
  let coveredVal = '<span class="rs-pending">…</span>', coveredSub = '';
  if (f) {
    if (f.catalogLoaded === false) { coveredVal = '—'; coveredSub = 'catalog unavailable'; }
    else {
      const priced = f.requests || 0;
      const cov = ((f.byPayer || []).find((p) => p.type === 'Insurance') || {}).count || 0;
      const share = priced ? cov / priced : 0;
      if (f.truncated) { coveredVal = '≈' + rsNum(Math.round(total * share)); coveredSub = Math.round(share * 100) + '% · est'; }
      else { coveredVal = rsNum(cov); coveredSub = rsPct(cov, priced) + '%'; }
    }
  }

  const kpis = `
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
      ${rsKpi('d', 'var(--accent,#6B4EFF)', patients != null ? rsNum(patients) : '—', 'Patients')}
      ${rsKpi('b', 'var(--blue,#3BA0FF)', rsNum(total), 'Requests')}
      ${rsKpi('c', 'var(--green,#00C896)', examsVal, 'Exams')}
      ${rsKpi('b', 'var(--blue,#3BA0FF)', coveredVal, 'Insurance-covered', coveredSub)}
      ${rsKpi('a', 'var(--danger,#E25555)', rsNum(emg), 'Emergency', total ? rsPct(emg, total) + '% of requests' : '')}
      ${rsKpi('a', 'var(--yellow,#FFBA49)', rsNum(aged), 'Pending &gt; 7 days')}
    </div>`;

  const branchItems = (d.byBranch || []).map((b) => ({ label: b.name || ('Branch ' + b.site), count: b.count, site: b.site }));
  const canDrill = !rsIsLead() && !radstats.leadLocked;
  const docItems = (d.byDoctor || []).map((x) => ({ label: x.name, count: x.count }));
  const deptItems = (d.byDepartment || []).map((x) => ({ label: x.name, count: x.count }));
  const agingItems = ['<1d', '1-3d', '3-7d', '>7d'].map((k) => ({ label: k, count: (d.aging && d.aging[k]) || 0 }));
  const agingColor = (i) => i.label === '>7d' ? '#ef4444' : (i.label === '3-7d' ? '#f59e0b' : (i.label === '1-3d' ? '#eab308' : '#22c55e'));
  const prioDonut = rsDonut([
    { label: 'Routine', count: rtn, color: '#22c55e' },
    { label: 'Emergency', count: emg, color: '#ef4444' },
  ], { centerVal: total, centerLabel: 'requests' });

  // When a manager has drilled into a single branch, show a clear focus pill
  // with a one-click way back to all branches.
  let focusNote = '';
  if (canDrill && radstats.sel && radstats.sel.size === 1) {
    const only = [...radstats.sel][0];
    const nm = (radstats.branches.find((b) => b.siteId === only) || {}).name
      || ((d.byBranch || []).find((b) => b.site === only) || {}).name || ('Branch ' + only);
    focusNote = `<div class="rs-focus">
      <span class="rs-focus-dot"></span>Focused on <b>${escapeHtml(nm)}</b>
      <button class="rs-focus-clear" onclick="rsAllBranches()">✕ Show all branches</button>
    </div>`;
  }

  const layout = `
    ${focusNote}
    ${rsSection('Overview')}
    ${kpis}
    <div id="rs-throughput"></div>
    <div class="rs-grid2">
      ${rsPanel('Priority split', prioDonut)}
      ${rsPanel('Daily trend', rsArea(d.daily || []), `${(d.daily || []).length} days`)}
    </div>

    ${rsSection('Financial — revenue &amp; payer')}
    ${rsPanel('Revenue &amp; payer', rsFinancialInner(), rsFinancialSub(), 'rs-wide')}

    ${rsSection('Breakdown')}
    <div class="rs-grid2">
      ${rsPanel('Modality mix (exams)', rsModalityInner(), rsModalitySub())}
      ${rsPanel('By branch', rsBarRows(branchItems, 'var(--accent)', 0, { drill: canDrill }), canDrill ? `${branchItems.length} branches · click to focus` : `${branchItems.length} branches`)}
    </div>
    <div class="rs-grid2">
      ${rsPanel('Top ordering doctors', rsBarRows(docItems, '#0ea5e9'), 'top 15')}
      ${rsPanel('By ordering department', rsBarRows(deptItems, '#8358FD'))}
    </div>
    ${rsPanel('Pending age', rsBarRows(agingItems, agingColor), 'time since order', 'rs-wide')}`;

  const foot = `<div class="rs-foot">Range ${escapeHtml((d.range && d.range.from) || '')} → ${escapeHtml((d.range && d.range.to) || '')}
    · updated ${escapeHtml(rsAgo(d.generatedAt))}${sitesFail ? ` · branches unavailable: ${escapeHtml((d.sites.failed || []).join(', '))}` : ''}</div>`;

  body.innerHTML = layout + foot;
  rsTpRender();                       // re-attach the daily-throughput section
  const tp = rsTpState();
  // Follow the page's branch focus: a re-scope invalidates the cached month.
  const scopeNow = rsSitesParam();
  if (tp.scope !== undefined && tp.scope !== scopeNow) { tp.data = null; tp.error = ''; tp.open = null; }
  if (!tp.data && !tp.loading && !tp.error) rsTpLoad();
}

function rsSection(title) { return `<div class="rs-section">${title}</div>`; }

function rsModalitySub() {
  const m = radstats.modData;
  if (!m) return 'exact — click to load';
  // A request can bundle several exams, so exams > requests is expected.
  return m.truncated
    ? `${rsNum(m.exams || 0)} exams · sample of ${rsNum(m.sampled)}/${rsNum(m.ofTotal)}`
    : `${rsNum(m.exams || 0)} exams from ${rsNum(m.ofTotal)} requests`;
}

function rsModalityInner() {
  if (radstats.modLoading) return `<div class="rs-empty"><span class="mini-spin"></span> Reading exam details…</div>`;
  if (radstats.modError) return `<div class="rs-empty">${escapeHtml(radstats.modError)} <button class="ghost" onclick="rsLoadModality()">Retry</button></div>`;
  const m = radstats.modData;
  if (!m) {
    return `<div class="rs-modcta">
      <span class="rs-modcta-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg></span>
      <p>Modality is read per order, so it loads on demand.</p>
      <button class="open pri" style="width:auto" onclick="rsLoadModality()">Load modality mix</button>
    </div>`;
  }
  if (m.catalogLoaded === false) return `<div class="rs-empty">Exam catalog temporarily unavailable — the modality mix can't be computed right now. <button class="ghost" onclick="rsLoad(false, true)">Refresh</button></div>`;
  if (!m.mix || !m.mix.length) return `<div class="rs-empty">No exam details returned</div>`;
  const segs = m.mix.map((x) => ({ label: x.modality, count: x.count, color: RS_MOD_COLOR[x.modality] || '#94a3b8' }));
  return rsDonut(segs, { centerVal: m.exams, centerLabel: 'exams' });
}

const rsSAR = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' SAR';
function rsFinancialSub() {
  const f = radstats.finData;
  if (!f) return 'insurance vs cash — click to load';
  return f.truncated ? `sample of ${rsNum(f.sampled)}/${rsNum(f.ofTotal)} orders` : `${rsNum(f.items || 0)} items`;
}
function rsFinancialInner() {
  if (radstats.finLoading) return `<div class="rs-empty"><span class="mini-spin"></span> Reading bills…</div>`;
  if (radstats.finError) return `<div class="rs-empty">${escapeHtml(radstats.finError)} <button class="ghost" onclick="rsLoadFinancial()">Retry</button></div>`;
  const f = radstats.finData;
  if (!f) {
    return `<div class="rs-modcta">
      <span class="rs-modcta-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></span>
      <p>Radiology revenue &amp; insurance-vs-cash split — read per order, so it loads on demand.<br>
      <span style="opacity:.75">Note: your radiology is almost all insurance; this is billed revenue, not collected/settled.</span></p>
      <button class="open pri" style="width:auto" onclick="rsLoadFinancial()">Load revenue</button>
    </div>`;
  }
  if (f.catalogLoaded === false) return `<div class="rs-empty">Exam catalog temporarily unavailable — revenue &amp; payer split can't be computed right now. <button class="ghost" onclick="rsLoad(false, true)">Refresh</button></div>`;
  const PAYER_COLOR = { 'Insurance': '#6B4EFF', 'Cash / self-pay': '#22c55e', 'Insurance + copay': '#f59e0b' };
  const payerSegs = (f.byPayer || []).map((p) => ({ label: p.type, count: p.count, color: PAYER_COLOR[p.type] || '#94a3b8' }));
  const payerDonut = rsDonut(payerSegs, { centerVal: f.requests || 0, centerLabel: 'requests' });
  const revDonut = rsDonut([
    { label: 'Insurance', count: Math.round(f.sponsor || 0), color: '#6B4EFF' },
    { label: 'Cash / copay', count: Math.round(f.patient || 0), color: '#22c55e' },
  ], { centerVal: Math.round(f.revenue || 0), centerLabel: 'SAR' });
  return `<div class="rs-fin">
    <div class="rs-fin-head">
      <div class="rs-fin-total"><div class="rs-fin-n">${rsNum(f.requests)}</div><div class="rs-fin-l">radiology requests priced</div></div>
      <div class="rs-fin-total"><div class="rs-fin-n">${rsSAR(f.revenue)}</div><div class="rs-fin-l">total revenue (billed)</div></div>
    </div>
    <div class="rs-grid2" style="margin:0">
      <div><div class="rs-subhead">Requests by payer (count)</div>${payerDonut}</div>
      <div><div class="rs-subhead">Revenue: insurance vs cash</div>${revDonut}</div>
    </div>
  </div>`;
}

function rsAgo(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 'just now';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

// ── Daily throughput · الإنجاز اليومي ─────────────────────────────────────────
// منجز (imaged) vs ما جا (ordered but never imaged), bucketed by the IMAGING date
// (KSA day) — not the order date. Backed by GET /api/radiology/throughput, which
// aggregates the local order ledger (scheduling.radiology_orders). Month-scoped
// with a per-day drill-down listing every imaged patient (order date → imaging date).
function rsTpState() {
  if (!radstats.tp) radstats.tp = { month: rsKsaToday().slice(0, 7), data: null, loading: false, error: '', open: null, seq: 0 };
  return radstats.tp;
}
function rsTpMonthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();   // day 0 of next month = last day
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
function rsTpSetMonth(v) {
  const tp = rsTpState();
  if (!/^\d{4}-\d{2}$/.test(v || '') || v === tp.month) return;
  tp.month = v; tp.data = null; tp.error = ''; tp.open = null;
  rsTpLoad();
}
async function rsTpLoad() {
  const tp = rsTpState();
  const seq = ++tp.seq;                       // stale-response guard (fast month flips)
  tp.loading = true; tp.error = '';
  tp.scope = rsSitesParam();                  // remember the branch scope this data belongs to
  rsTpRender();
  const r = rsTpMonthRange(tp.month);
  try {
    const d = await API.get(`/radiology/throughput?from=${r.from}&to=${r.to}${tp.scope ? `&sites=${tp.scope}` : ''}`);
    if (seq !== tp.seq) return;
    tp.data = d;
  } catch (e) {
    if (seq !== tp.seq) return;
    tp.error = (e && e.message) || 'Could not load the daily throughput';
  } finally {
    if (seq === tp.seq) { tp.loading = false; rsTpRender(); }
  }
}
function rsTpToggleDay(date) {
  const tp = rsTpState();
  tp.open = tp.open === date ? null : date;
  rsTpRender();
}
// Ledger modality token → Clinical Calm .mod class.
const RS_TP_MOD = { CT: 'ct', MR: 'mri', MRI: 'mri', US: 'us', XR: 'xr', DX: 'xr', CR: 'xr', DR: 'xr', MG: 'mm' };
function rsTpModChips(byMod) {
  const entries = Object.entries(byMod || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  return entries.map(([m, n]) =>
    `<span class="mod ${RS_TP_MOD[String(m).toUpperCase()] || 'xr'}">${escapeHtml(m === '?' ? '؟' : m)} · ${n}</span>`).join(' ');
}
function rsTpModChip(m) {
  const k = String(m || '').split(',')[0].trim().toUpperCase();
  if (!k) return '';
  return `<span class="mod ${RS_TP_MOD[k] || 'xr'}">${escapeHtml(k)}</span>`;
}
function rsTpDay(iso) { return iso ? String(iso).slice(0, 10) : '—'; }
function rsTpWeekday(date) {
  try { return new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short' }); }
  catch (e) { return ''; }
}
// One imaged patient inside a day's drill-down: name/MRN · modality · exam · order date → imaging date.
function rsTpItemRow(it) {
  const exam = it.exam || it.department || '';
  return `<div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px dashed var(--border);flex-wrap:wrap">
    <div class="pt" style="flex:1;min-width:180px">
      <div class="pname" style="font-size:13px">${escapeHtml(it.patientName || '—')}
        <span style="color:var(--muted);font-weight:500;font-size:12px">· ${escapeHtml(it.mrno || '')}</span></div>
      <div class="pmeta">${exam ? `<span>${escapeHtml(exam)}</span><i></i>` : ''}<span>طلب ${rsTpDay(it.orderedAt)} ← تصوير ${rsTpDay(it.imagedAt)}</span></div>
    </div>
    ${rsTpModChip(it.modality)}
  </div>`;
}
function rsTpRender() {
  const host = document.getElementById('rs-throughput');
  if (!host) return;
  const tp = rsTpState();
  const monthPick = `<input type="month" class="input" style="width:auto;font-size:13px" value="${escapeHtml(tp.month)}"
      max="${rsKsaToday().slice(0, 7)}" onchange="rsTpSetMonth(this.value)" aria-label="Month">`;
  const head = `
    ${rsSection('الإنجاز اليومي · Daily throughput')}
    <div class="card rs-panel rs-wide" style="margin-bottom:14px">
      <div class="rs-panel-head" style="flex-wrap:wrap;gap:8px">
        <h3>منجز مقابل ما جا — by imaging date</h3>
        <span style="display:inline-flex;align-items:center;gap:8px">
          <span class="rs-panel-sub">counted on the day the patient was actually imaged</span>${monthPick}
        </span>
      </div>`;
  if (tp.loading) {
    const sh = (w) => `<div class="lrow"><span class="wl-shimmer" style="width:${w}%"></span></div>`;
    host.innerHTML = head + `<div class="listcard" style="border:none;box-shadow:none">${sh(45)}${sh(65)}${sh(55)}${sh(40)}</div></div>`;
    return;
  }
  if (tp.error) {
    host.innerHTML = head + `<div class="empty" style="padding:20px 14px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(tp.error)}</p>
      <button class="ghost" style="margin-top:8px" onclick="rsTpLoad()">↻ Retry · إعادة المحاولة</button></div></div>`;
    return;
  }
  const d = tp.data;
  if (!d || !d.ok) { host.innerHTML = head + `<div class="rs-empty">No data yet</div></div>`; return; }

  const totals = d.totals || {};
  const imaged = totals.imaged || 0, noShow = totals.noShow || 0;
  const summary = `
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:4px 0 14px">
      ${rsKpi('c', 'var(--green,#00C896)', rsNum(imaged), 'منجز · Imaged')}
      ${rsKpi('a', 'var(--yellow,#FFBA49)', rsNum(noShow), 'ما جا · No-show')}
      ${rsKpi('d', 'var(--accent,#6B4EFF)', rsNum(imaged + noShow), 'الإجمالي · Total')}
    </div>
    ${Object.keys(totals.byModality || {}).length ? `<div class="exline" style="flex-wrap:wrap;margin:0 0 12px">${rsTpModChips(totals.byModality)}</div>` : ''}`;

  // Merge imaged days with no-show-only days so a day where nobody showed still appears.
  const dayMap = new Map((d.days || []).map((x) => [x.date, x]));
  const nsMap = new Map((d.noShow || []).map((x) => [x.date, x]));
  const allDates = [...new Set([...dayMap.keys(), ...nsMap.keys()])].sort().reverse();   // newest first
  const items = d.items || [];
  let rows;
  if (!allDates.length) {
    rows = `<div class="rs-empty">لا يوجد بيانات لهذا الشهر — no imaging recorded this month yet.<br>
      <span style="font-size:12px;opacity:.8">The ledger fills as the worklist is viewed and orders are imaged.</span></div>`;
  } else {
    rows = `<div class="listcard">` + allDates.map((date) => {
      const day = dayMap.get(date), ns = nsMap.get(date);
      const n = (day && day.imaged) || 0;
      const open = tp.open === date;
      const drillItems = open ? items.filter((it) => it.date === date) : [];
      const drill = open ? `
        <div style="padding:8px 18px 12px;background:var(--card-alt);border-bottom:1px solid var(--border)">
          ${drillItems.length ? drillItems.map(rsTpItemRow).join('')
            : `<div style="font-size:12.5px;color:var(--muted);padding:6px 0">${n ? 'Patient rows for this day are beyond the item cap — narrow the range.' : 'ما جا أحد هذا اليوم — ordered patients did not reach imaging.'}</div>`}
        </div>` : '';
      return `<div class="lrow" role="button" tabindex="0" aria-expanded="${open}"
          onclick="rsTpToggleDay('${date}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();rsTpToggleDay('${date}')}"
          style="cursor:pointer;flex-wrap:wrap${open ? ';background:var(--violet-wash,#F0EDFF)' : ''}">
        <div style="min-width:112px">
          <div style="font-weight:700;font-variant-numeric:tabular-nums">${escapeHtml(date)}</div>
          <div style="font-size:11px;color:var(--muted)">${rsTpWeekday(date)}</div>
        </div>
        <div class="exline" style="flex:1;flex-wrap:wrap;min-width:120px">${day ? rsTpModChips(day.byModality) : ''}</div>
        ${ns && ns.count ? `<span class="sc warn" title="ordered this day, never imaged">ما جا ${ns.count}</span>` : ''}
        ${n ? `<span class="ris completed"><span class="rd"></span>${rsNum(n)} منجز</span>`
            : `<span class="ris scheduled"><span class="rd"></span>0 منجز</span>`}
        <span style="color:var(--muted);font-size:12px">${open ? '▾' : '▸'}</span>
      </div>${drill}`;
    }).join('') + `</div>`;
  }
  const basisNote = d.fallbackReported
    ? `<div class="rs-foot" style="margin-top:8px">ℹ️ ${escapeHtml(String(d.basis || ''))}</div>`
    : '';
  host.innerHTML = head + summary + rows + basisNote + `</div>`;
}
