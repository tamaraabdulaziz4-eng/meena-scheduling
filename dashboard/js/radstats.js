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
  from: '', to: '', preset: 'today',
  branches: [], sel: null,           // sel = Set of selected siteIds (null = all)
  data: null, loading: false,
  modData: null, modLoading: false, modError: '',
  finData: null, finLoading: false, finError: '',
  auto: true, timer: null, clockTimer: null, lastError: '', lastLoaded: 0,
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
  rsRestore();                           // stale-first: hydrate from sessionStorage on a hard reload
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
  if (radstats.auto) rsStartAuto();    // live board on by default — poll every 30s
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
function rsAgoText() {
  if (!radstats.lastLoaded) return '';
  const s = Math.max(0, Math.round((Date.now() - radstats.lastLoaded) / 1000));
  if (s < 60) return `updated ${s}s ago`;
  const m = Math.floor(s / 60);
  return `updated ${m}m ago`;
}
function rsStartClock() {
  if (radstats.clockTimer) clearInterval(radstats.clockTimer);
  radstats.clockTimer = setInterval(() => {
    const el = document.getElementById('rs-clock-t');
    if (!el) { clearInterval(radstats.clockTimer); radstats.clockTimer = null; return; }
    el.textContent = rsClockNow();
    const up = document.getElementById('rs-updated');
    if (up) up.textContent = rsAgoText();
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
    <div style="color:var(--muted)">${icon('lock').replace('class="mi-ico"', 'class="mi-ico" style="width:38px;height:38px"')}</div>
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
          <span id="rs-updated" style="font-size:11.5px;color:var(--muted);white-space:nowrap">${rsAgoText()}</span>
          <label class="rs-auto" title="Auto-refresh every 30s"><input type="checkbox" id="rs-auto" ${radstats.auto ? 'checked' : ''} onchange="rsToggleAuto()"> ${radstats.auto ? '🟢 Live' : 'Live'}</label>
          <button class="ghost" onclick="rsOpenReport()" title="Monthly presentation report with comparison to last month">${icon('bar-chart')} Monthly report</button>
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
  radstats.dayFocus = null;              // picking a range exits single-day focus
  radstats.preset = id;
  const r = rsPresetRange(id);
  radstats.from = r.from; radstats.to = r.to;
  rsRenderControls();
  rsLoad();
}
function rsSetCustom() {
  radstats.dayFocus = null;              // picking a range exits single-day focus
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
    if (document.hidden) return;               // don't poll a backgrounded tab
    rsLoad(true);
  }, 30000);   // live board — refresh every 30s
}
function rsStopAuto() { if (radstats.timer) { clearInterval(radstats.timer); radstats.timer = null; } }

// ── Stale-first across a HARD reload (sessionStorage) ─────────────────────────
// In-memory radstats.data only survives navigation; a full page reload drops it, so
// first paint fell back to the branded overlay while awaiting the slow HIS stats call.
// Persist the last payload keyed by scope+range and render it stale-first on mount —
// instant first paint on reload/return, exactly like the worklist's wl:board: restore.
function rsScopeKey() {
  const branches = radstats.sel ? [...radstats.sel].sort().join(',') : 'all';
  return `rs:stats:${radstats.preset || 'custom'}|${radstats.from}|${radstats.to}|${branches}`;
}
function rsPersist() {
  const payload = JSON.stringify({
    t: Date.now(), data: radstats.data, modData: radstats.modData, finData: radstats.finData,
  });
  const key = rsScopeKey();
  // sessionStorage: freshest, per-tab snapshot for instant paint on soft nav / reload.
  try { sessionStorage.setItem(key, payload); } catch (e) { /* quota / private mode — ignore */ }
  // localStorage: survives closing the tab/browser, so a leader who opens the dashboard
  // the next morning gets an INSTANT first paint of the last snapshot (then it refreshes
  // underneath). The base stats payload is aggregate-only (counts by branch / modality /
  // department / doctor + daily trend + demographics) — no per-patient drill-down rows —
  // so nothing patient-identifying lands in the workstation's disk store.
  try { localStorage.setItem(key, payload); } catch (e) { /* quota / private mode — ignore */ }
}
function rsRestore() {
  if (radstats.data) return false;             // already have live data in hand
  const key = rsScopeKey();
  const paint = (o) => {
    if (!o || !o.data) return false;
    radstats.data = o.data;
    if (o.modData) radstats.modData = o.modData;
    if (o.finData) radstats.finData = o.finData;
    return true;
  };
  // 1) Prefer the per-tab sessionStorage snapshot when it's fresh (≤10 min) — treated as
  //    live enough to skip even the "refreshing" feel.
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) { const o = JSON.parse(raw); if (o && o.data && Date.now() - (o.t || 0) <= 600000) return paint(o); }
  } catch (e) { /* ignore */ }
  // 2) Fall back to the cross-session localStorage snapshot for an instant first paint of
  //    the day (≤12 h). It may be stale, but rsLoad() always refreshes right after, and the
  //    footer's "updated Xs ago" + the rs-refreshing state make the live update visible —
  //    far better than staring at a 2s skeleton.
  try {
    const raw = localStorage.getItem(key);
    if (raw) { const o = JSON.parse(raw); if (o && o.data && Date.now() - (o.t || 0) <= 43200000) return paint(o); }
  } catch (e) { /* ignore */ }
  return false;
}

async function rsLoad(silent, force) {
  // Every control (preset, branch toggle, "All", custom dates, auto-refresh) fires
  // rsLoad. A slow selection could resolve AFTER a newer, faster one and overwrite
  // it — body showing branch A while the controls say "All". Stamp each request and
  // ignore any response that isn't the most recent.
  const myReq = (radstats._reqSeq = (radstats._reqSeq || 0) + 1);
  radstats.loading = true;
  radstats.lastError = '';
  radstats.reconnecting = false;
  if (!silent) rsRenderControls();
  const bodyEl = document.getElementById('rs-body');
  if (bodyEl && radstats.data) bodyEl.classList.add('rs-refreshing');   // keep data visible, show it's updating
  // A non-silent load = the selection changed (branch / preset / dates / first open).
  // The old modality+revenue belong to the PREVIOUS selection, so drop them — they'll
  // reload in the background for the new selection below.
  if (!silent) { radstats.modData = null; radstats.finData = null; radstats.modError = ''; radstats.finError = ''; radstats._bodySig = ''; }
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const _s = rsSitesParam(); if (_s) q.set('sites', _s);
  // NO full=1 — that forced the ~2,400-bill revenue read BEFORE anything could paint.
  // The base call (requests / priority / branch / dept / daily / hourly / demographics)
  // is cheap (RadiologySearch only), so the headline KPIs appear instantly; the heavy
  // modality + revenue passes then fill in behind them (rsLoadModality/rsLoadFinancial).
  if (force) q.set('nocache', '1');    // Refresh button → skip cache, pull truly live now
  try {
    const d = await API.get('/radiology/stats?' + q.toString());
    if (myReq !== radstats._reqSeq) return;   // superseded by a newer selection — drop this stale result
    radstats.data = d;
    rsPersist();                              // snapshot for an instant stale-first paint on the next hard reload
  } catch (e) {
    if (myReq !== radstats._reqSeq) return;
    // A SILENT auto-refresh blip must NOT blow away a good board — keep the last-good data
    // (like the worklist does) and just flag a soft "reconnecting" state. Only show the hard
    // error card when there's nothing already on screen (first load / selection change).
    if (silent && radstats.data) radstats.reconnecting = true;
    else radstats.lastError = (e && e.message) || 'Could not load statistics';
  } finally {
    if (myReq === radstats._reqSeq) {   // only the latest request owns the UI state
      radstats.loading = false;
      if (!radstats.lastError && !radstats.reconnecting) radstats.lastLoaded = Date.now();   // for the "updated Xs ago" ticker
      rsHideOverlay();                  // base data in → dismiss the full-screen loader, paint KPIs NOW
      rsRenderControls();
      rsRenderBody();
      // Instant paint done. Fill the heavy enrichment in the BACKGROUND — only when it's
      // missing (first open / selection change) or the user forced a live refresh; a
      // silent auto-refresh keeps the existing numbers (they're within the cache window).
      if (!radstats.lastError && (force || !radstats.modData || !radstats.finData)) {
        rsLoadEnrichment({ seq: myReq, force });
      }
    }
  }
}

// Modality mix AND revenue come from the SAME per-bill read, so fetch them in ONE call
// (modality=1&financial=1) instead of firing two heavy passes that would hit the small
// box concurrently, double the bill reads, and make each other look "stuck". The
// standalone rsLoadModality/rsLoadFinancial stay for the retry buttons + the Financial tab.
async function rsLoadEnrichment(opts) {
  opts = opts || {};
  const myReq = (opts.seq != null) ? opts.seq : radstats._reqSeq;
  radstats.modLoading = true; radstats.finLoading = true;
  radstats.modError = ''; radstats.finError = '';
  if (!radstats.modData || !radstats.finData) rsRenderBody();   // panels show their own progress
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const _s = rsSitesParam(); if (_s) q.set('sites', _s);
  q.set('modality', '1'); q.set('financial', '1');
  if (opts.force) q.set('nocache', '1');
  try {
    const d = await API.get('/radiology/stats?' + q.toString());
    if (myReq !== radstats._reqSeq) return;   // superseded — don't overwrite the newer view
    radstats.modData = d.modality || { mix: [], sampled: 0, ofTotal: 0 };
    radstats.finData = d.financial || { revenue: 0, patient: 0, sponsor: 0, sampled: 0, ofTotal: 0 };
    // Department + gender come ONLY from the RadiologySearch pass, which runs in THIS enrichment
    // call (the base call is panel-only, for speed). Merge them onto the base data so the Ops
    // "by department" and Overview "gender split" panels fill in behind the instant KPIs.
    if (radstats.data) {
      if (d.byDepartment) radstats.data.byDepartment = d.byDepartment;
      if (d.byGender !== undefined) radstats.data.byGender = d.byGender;
    }
  } catch (e) {
    if (myReq !== radstats._reqSeq) return;
    const msg = (e && e.message) || 'Could not load';
    if (!radstats.modData) radstats.modError = msg;
    if (!radstats.finData) radstats.finError = msg;
  } finally {
    // Clear the loading flags UNCONDITIONALLY — if a silent auto-refresh superseded this
    // enrichment, its early-return would otherwise leave modLoading/finLoading stuck true
    // and the panels frozen on their spinner despite having data. Only the latest request
    // owns the repaint.
    radstats.modLoading = false; radstats.finLoading = false;
    if (myReq === radstats._reqSeq) { rsPersist(); rsRenderBody(); }
  }
}

// Exact modality mix is slower (per-order detail calls), so it loads in the background
// after the KPIs paint. seq gates the write so a stale response can't clobber a newer
// selection; force propagates the live-refresh nocache.
async function rsLoadModality(opts) {
  opts = opts || {};
  const myReq = (opts.seq != null) ? opts.seq : radstats._reqSeq;
  radstats.modLoading = true; radstats.modError = '';
  if (!radstats.modData) rsRenderBody();   // show the panel's own spinner only when empty
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const _s = rsSitesParam(); if (_s) q.set('sites', _s);
  q.set('modality', '1');
  if (opts.force) q.set('nocache', '1');
  try {
    const d = await API.get('/radiology/stats?' + q.toString());
    if (myReq !== radstats._reqSeq) return;   // superseded — don't overwrite the newer view
    radstats.modData = d.modality || { mix: [], sampled: 0, ofTotal: 0 };
  } catch (e) {
    if (myReq !== radstats._reqSeq) return;
    radstats.modError = (e && e.message) || 'Could not load modality mix';
  } finally {
    radstats.modLoading = false;   // unconditional — a superseded call must not leave the spinner stuck
    if (myReq === radstats._reqSeq) { rsPersist(); rsRenderBody(); }
  }
}

// Revenue & payer split is the slowest pass (per-order bill reads), so it loads in the
// background after the KPIs paint. Same seq/force handling as rsLoadModality.
async function rsLoadFinancial(opts) {
  opts = opts || {};
  const myReq = (opts.seq != null) ? opts.seq : radstats._reqSeq;
  radstats.finLoading = true; radstats.finError = '';
  if (!radstats.finData) rsRenderBody();   // show the panel's own spinner only when empty
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const _s = rsSitesParam(); if (_s) q.set('sites', _s);
  q.set('financial', '1');
  if (opts.force) q.set('nocache', '1');
  try {
    const d = await API.get('/radiology/stats?' + q.toString());
    if (myReq !== radstats._reqSeq) return;   // superseded — don't overwrite the newer view
    radstats.finData = d.financial || { revenue: 0, patient: 0, sponsor: 0, sampled: 0, ofTotal: 0 };
  } catch (e) {
    if (myReq !== radstats._reqSeq) return;
    radstats.finError = (e && e.message) || 'Could not load revenue';
  } finally {
    radstats.finLoading = false;   // unconditional — a superseded call must not leave the spinner stuck
    if (myReq === radstats._reqSeq) { rsPersist(); rsRenderBody(); }
  }
}

// ── rendering ─────────────────────────────────────────────────────────────────
const rsNum = (n) => Number(n || 0).toLocaleString();
const rsPct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

function rsBarRows(items, color, max0, opts) {
  if (!items || !items.length) return `<div class="rs-empty">No data</div>`;
  const drill = opts && opts.drill;
  const total = items.reduce((a, i) => a + i.count, 0);
  const max = max0 || Math.max(1, ...items.map((i) => i.count));
  return `<div class="rs-bars">` + items.map((i, idx) => {
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
      <div class="rs-bar-track"><div class="rs-bar-fill rs-hbar" style="width:${pct}%;background:${col};animation-delay:${idx * 40}ms"></div></div>
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
  const arcs = segs.map((s, i) => {
    const len = (s.count / total) * C;
    const tip = `<b>${escapeHtml(s.label)}</b><br>${rsNum(s.count)} · ${rsPct(s.count, total)}%`;
    // Staggered animation-delay makes the brightness pulse travel around the ring, so the
    // colours visibly "chase" instead of sitting static (see .rs-arc in radstats.css).
    const el = `<circle class="rs-arc" cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${sw}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cy})"
      style="animation-delay:${(i * 0.45).toFixed(2)}s" data-tip="${escapeHtml(tip)}"></circle>`;
    off += len; return el;
  }).join('');
  const legend = segs.map((s) => `<div class="rs-leg" data-tip="${escapeHtml(`<b>${escapeHtml(s.label)}</b><br>${rsNum(s.count)} · ${rsPct(s.count, total)}%`)}">
      <span class="rs-leg-dot" style="background:${s.color}"></span>
      <span class="rs-leg-l" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>
      <span class="rs-leg-v">${rsNum(s.count)} · ${rsPct(s.count, total)}%</span></div>`).join('');
  const cVal = opts && opts.centerVal != null ? opts.centerVal : total;
  // Key the count-up per donut (by its center label) — a shared key made two donuts on the
  // same pane (e.g. Priority + Modality) each animate from the OTHER donut's last value.
  const cKey = 'rs-donut-' + String((opts && opts.centerLabel) || 'total').replace(/\s+/g, '-');
  return `<div class="rs-donut-wrap">
    <svg viewBox="0 0 140 140" class="rs-donut">${arcs}
      <text x="70" y="67" text-anchor="middle" class="rs-donut-n rs-count" data-count="${Number(cVal) || 0}" data-key="${escapeHtml(cKey)}">0</text>
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
  const dots = daily.map((x, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(x.count).toFixed(1)}" r="9" class="rs-dot-hit" data-tip="${escapeHtml(`<b>${escapeHtml(x.date)}</b><br>${rsNum(x.count)} requests`)}"/><circle cx="${X(i).toFixed(1)}" cy="${Y(x.count).toFixed(1)}" r="3" class="rs-dot${i === n - 1 ? ' rs-dot-live' : ''}"/>`).join('');
  const idxs = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  const xl = idxs.map((i) => `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="rs-axis">${escapeHtml(daily[i].date.slice(5))}</text>`).join('');
  // rs-line-flow = a bright pulse that travels the exact trend path (pathLength=1 normalises
  // the dash math to any range length). Hidden under reduced-motion. rs-area-fill breathes.
  return `<svg viewBox="0 0 ${W} ${H}" class="rs-area">
    <defs><linearGradient id="rsg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#rsg)" class="rs-area-fill"/><path d="${line}" class="rs-line"/><path d="${line}" class="rs-line-flow" pathLength="1" fill="none"/>${dots}${xl}
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
  // Emit an animatable number when the value is a clean (optionally ≈-prefixed) integer, so
  // rsAnimateCounts() can count it up from its previous value — the "alive" headline effect.
  const raw = String(val == null ? '' : val);
  const m = raw.replace(/,/g, '').match(/^(≈?)(\d+)$/);
  const kv = m
    ? `<div class="kv rs-count" data-count="${m[2]}" data-prefix="${m[1]}" data-key="${escapeHtml(String(label))}">${m[1]}0</div>`
    : `<div class="kv">${raw}</div>`;
  return `<div class="kpi ${accent}">
    <div class="kl"><span class="kd" style="background:${dot}"></span>${label}</div>
    ${kv}
    ${sub ? `<div class="kt">${sub}</div>` : ''}
  </div>`;
}

// Count every .rs-count element from its LAST shown value up to its new target (0 → n on the
// first paint, old → new on a live refresh, and nothing when unchanged). Cubic ease-out, ~0.65s.
// Honours reduced-motion by snapping straight to the value.
const _rsCountLast = {};
function rsAnimateCounts(root) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  (root || document).querySelectorAll('.rs-count[data-count]').forEach((el) => {
    const target = Number(el.getAttribute('data-count')) || 0;
    const prefix = el.getAttribute('data-prefix') || '';
    const key = el.getAttribute('data-key') || '';
    const from = (key && _rsCountLast[key] != null) ? _rsCountLast[key] : 0;
    if (key) _rsCountLast[key] = target;
    if (reduce || from === target) { el.textContent = prefix + target.toLocaleString(); return; }
    const dur = 650, t0 = performance.now();
    const ease = (p) => 1 - Math.pow(1 - p, 3);
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = prefix + Math.round(from + (target - from) * ease(p)).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// Peak hours — orders by hour of day. Hidden gracefully if the HIS timestamps are date-only.
function rsHourly(byHour, hasTime) {
  const arr = Array.isArray(byHour) ? byHour : [];
  if (!hasTime || !arr.some((v) => v > 0)) {
    return `<div class="rs-empty">Order timestamps don't carry a time-of-day in this data, so peak-hours can't be shown. It fills in automatically if order times become available.</div>`;
  }
  const max = Math.max(1, ...arr);
  const peak = arr.indexOf(Math.max(...arr));
  const total = arr.reduce((a, b) => a + b, 0) || 1;
  const fmtH = (h) => { const ap = h < 12 ? 'AM' : 'PM'; const hh = h % 12 === 0 ? 12 : h % 12; return hh + ap; };
  const bars = arr.map((v, h) => {
    const pct = Math.max(2, Math.round((v / max) * 100));
    const isPeak = h === peak;
    return `<div class="rs-cbar-wrap" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;padding:2px 0"
                 title="${fmtH(h)} · ${v} order${v === 1 ? '' : 's'} · ${Math.round((v / total) * 100)}% of the day"
                 onclick="rsDrillHour(${h},${v})">
      <div style="font-size:9px;line-height:1;height:10px;color:var(--danger,#E25555);font-weight:800">${isPeak ? v : ''}</div>
      <div style="width:100%;display:flex;align-items:flex-end;height:112px">
        <div class="rs-cbar${isPeak ? ' peak' : ''}" style="width:72%;margin:0 auto;height:${pct}%;border-radius:5px 5px 0 0;animation-delay:${h * 18}ms;background:${isPeak ? 'var(--danger,#E25555)' : 'linear-gradient(180deg,var(--accent2,#8358fd),var(--accent,#6B4EFF))'}"></div>
      </div>
      <div style="font-size:9.5px;color:var(--muted);height:12px">${h % 4 === 0 ? fmtH(h).replace(':00', '') : ''}</div>
    </div>`;
  }).join('');
  return `<div style="display:flex;gap:2px;align-items:flex-end;padding-top:4px">${bars}</div>
    <div style="font-size:12.5px;color:var(--muted);margin-top:12px;display:flex;gap:14px;flex-wrap:wrap">
      <span>🔴 Busiest: <b style="color:var(--ink)">${fmtH(peak)}</b> (${max} orders)</span>
      <span style="opacity:.8">Evening peak — staff to it · tap a bar for detail</span>
    </div>`;
}

// Tap an hour bar → open the actual orders placed in that hour.
function rsDrillHour(h, v) {
  const fmtH = (x) => { const ap = x < 12 ? 'AM' : 'PM'; const hh = x % 12 === 0 ? 12 : x % 12; return hh + ap; };
  rsShowOrders(`Orders at ${fmtH(h)}–${fmtH((h + 1) % 24)}`, (o) => o.hour === h);
}

// Busiest weekdays — average orders per weekday across the range (KSA week: Sun–Thu).
// Uses the per-day average so a range with more Mondays doesn't skew "busiest".
function rsWeekday(daily) {
  const arr = Array.isArray(daily) ? daily : [];
  if (arr.length < 3) return `<div class="rs-empty">Pick a wider date range (a week+) to see the weekday pattern.</div>`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const tot = new Array(7).fill(0), occ = new Array(7).fill(0);
  // Orders per weekday (only days with orders appear in `daily`).
  for (const row of arr) {
    const m = String(row.date || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue;
    tot[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] += (row.count || 0);
  }
  // Denominator = how many times each weekday actually OCCURS in the selected range,
  // including zero-order days (which never appear in `daily`). Counting only days-with-orders
  // inflated the average for low-volume weekdays. Falls back to present-days if range unknown.
  const parseD = (s) => { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
  let a = parseD(radstats.from), b = parseD(radstats.to);
  if (a == null || b == null) {
    for (const row of arr) { const m = String(row.date || '').match(/(\d{4})-(\d{2})-(\d{2})/); if (m) occ[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] += 1; }
  } else {
    if (a > b) { const t = a; a = b; b = t; }
    for (let day = a; day <= b; day += 864e5) occ[new Date(day).getUTCDay()] += 1;
  }
  const avg = tot.map((t, i) => occ[i] ? t / occ[i] : 0);
  const max = Math.max(1, ...avg);
  const peak = avg.indexOf(Math.max(...avg));
  const bars = names.map((nm, i) => {
    const pct = Math.max(3, Math.round((avg[i] / max) * 100));
    const isPeak = i === peak;
    return `<div class="rs-cbar-wrap" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:2px 0" title="${nm} — avg ${avg[i].toFixed(1)}/day · tap for orders" onclick="rsShowOrders('${nm} — all orders', (o) => rsWeekdayName(o.date) === ${i})">
      <div style="font-size:10px;line-height:1;height:11px;color:var(--danger,#E25555);font-weight:800">${isPeak ? Math.round(avg[i]) : ''}</div>
      <div style="width:100%;display:flex;align-items:flex-end;height:84px"><div class="rs-cbar${isPeak ? ' peak' : ''}" style="width:60%;margin:0 auto;height:${pct}%;border-radius:5px 5px 0 0;animation-delay:${i * 45}ms;background:${isPeak ? 'var(--danger,#E25555)' : 'linear-gradient(180deg,var(--accent,#6B4EFF),var(--accent2,#8358fd))'}"></div></div>
      <div style="font-size:11px;color:var(--muted)">${nm}</div>
    </div>`;
  }).join('');
  return `<div style="display:flex;gap:5px;align-items:flex-end;padding-top:6px">${bars}</div>
    <div style="font-size:12px;color:var(--muted);margin-top:8px">Busiest weekday: <b>${names[peak]}</b> (avg ${avg[peak].toFixed(0)}/day) — roster more staff.</div>`;
}

// Busiest specific dates in the range — the top days by order volume.
function rsBusyDates(daily) {
  const arr = (Array.isArray(daily) ? daily : []).filter((r) => r && r.date);
  if (arr.length < 2) return `<div class="rs-empty">Not enough days in range.</div>`;
  const max = Math.max(1, ...arr.map((r) => r.count || 0));
  const top = arr.slice().sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 8);
  const fmt = (d) => { const m = String(d).match(/(\d{4})-(\d{2})-(\d{2})/); if (!m) return d; return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };
  return top.map((r, idx) => {
    const pct = Math.max(4, Math.round(((r.count || 0) / max) * 100));
    return `<div class="rs-cbar-wrap" style="display:flex;align-items:center;gap:8px;padding:5px 6px" title="Open ${escapeHtml(r.date)} — its full stats" onclick="rsDrillDate('${jsAttr(r.date)}')">
      <div style="width:140px;font-size:12px;flex-shrink:0">${escapeHtml(fmt(r.date))}</div>
      <div style="flex:1;background:var(--border);border-radius:5px;height:16px;overflow:hidden"><div class="rs-hbar" style="width:${pct}%;height:100%;border-radius:5px;background:linear-gradient(90deg,var(--accent2,#8358fd),var(--accent,#6B4EFF));animation-delay:${idx * 50}ms"></div></div>
      <div style="width:36px;text-align:right;font-size:12px;font-weight:700">${r.count || 0}</div>
    </div>`;
  }).join('');
}

// Select a day (from busiest-dates / daily trend) → focus the whole dashboard on that day.
// Toggle off to restore the previous range. Any preset/custom pick also clears the focus.
function rsDrillDate(dateStr) {
  const m = String(dateStr || '').match(/\d{4}-\d{2}-\d{2}/);
  if (!m) return;
  const day = m[0];
  if (radstats.dayFocus && radstats.dayFocus.date === day) { rsClearDayFocus(); return; }
  if (!radstats.dayFocus) radstats.dayFocus = { prevFrom: radstats.from, prevTo: radstats.to, prevPreset: radstats.preset };
  radstats.dayFocus.date = day;
  radstats.from = day; radstats.to = day; radstats.preset = 'custom';
  rsRenderControls(); rsLoad();
  const b = document.getElementById('rs-body'); if (b) b.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function rsClearDayFocus() {
  const f = radstats.dayFocus; if (!f) return;
  radstats.dayFocus = null;
  radstats.from = f.prevFrom; radstats.to = f.prevTo; radstats.preset = f.prevPreset || 'custom';
  rsRenderControls(); rsLoad();
}

// ── Click-to-detail: open the actual order list behind any chart slice ──────────
// Fetches the underlying order rows once (list=1) for the current range/scope, caches
// them, and filters client-side to whatever slice was clicked (hour, weekday, doctor…).
async function rsFetchList() {
  const key = `${radstats.from}|${radstats.to}|${rsSitesParam() || ''}`;
  if (radstats.listData && radstats.listKey === key) return radstats.listData;
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const s = rsSitesParam(); if (s) q.set('sites', s);
  q.set('list', '1');
  const d = await API.get('/radiology/stats?' + q.toString());
  radstats.listData = (d && d.requests) || [];
  radstats.listKey = key;
  radstats.listTruncated = (d && d.requestsTruncated) || 0;
  return radstats.listData;
}

function rsOrderRow(o) {
  const fmtH = (h) => h == null ? '' : ((h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'AM' : 'PM'));
  return `<div style="display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;font-size:13px">${escapeHtml(o.name || o.mrno || '—')} ${o.priority === 'emergency' ? '🚨' : ''}</div>
      <div style="font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(o.exam || o.category || '—')} · ${escapeHtml(o.doctor || '—')} · ${escapeHtml(o.branch || '')}</div>
    </div>
    <div style="text-align:right;font-size:11px;color:var(--muted);white-space:nowrap">${escapeHtml(o.date || '')}${o.hour != null ? ' · ' + fmtH(o.hour) : ''}<br>MRN ${escapeHtml(o.mrno || '')}</div>
  </div>`;
}

async function rsShowOrders(title, pred) {
  showModal('rs-orders-modal', `<div style="font-weight:800;font-size:16px;margin-bottom:8px">${escapeHtml(title)}</div><div class="mini-spin"></div><div style="color:var(--muted);margin-top:8px">Loading orders…</div>`);
  let rows;
  try { rows = await rsFetchList(); }
  catch (e) { showModal('rs-orders-modal', `<div style="color:var(--danger-ink)">${escapeHtml((e && e.message) || 'Could not load')}</div><div style="margin-top:12px"><button class="btn btn-ghost" style="width:auto" onclick="closeModal('rs-orders-modal')">Close</button></div>`); return; }
  const list = rows.filter(pred);
  const shown = list.slice(0, 400);
  const body = shown.length ? shown.map(rsOrderRow).join('') : '<div style="color:var(--muted);padding:18px 0;text-align:center">No orders in this slice</div>';
  showModal('rs-orders-modal', `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div style="font-weight:800;font-size:16px">${escapeHtml(title)}</div>
      <button onclick="closeModal('rs-orders-modal')" style="border:none;background:none;font-size:20px;cursor:pointer;color:var(--muted)">✕</button>
    </div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">${list.length} order${list.length === 1 ? '' : 's'}${list.length > shown.length ? ` · showing ${shown.length}` : ''}${radstats.listTruncated ? ' · (from a sample of the range)' : ''}</div>
    <div style="max-height:62vh;overflow:auto">${body}</div>`);
}

function rsWeekdayName(dateStr) { const m = String(dateStr || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() : -1; }

// Gender split.
function rsGender(g) {
  if (!Array.isArray(g) || !g.length) return '';
  const tot = g.reduce((s, x) => s + (x.count || 0), 0) || 1;
  const col = (n) => /female|^f|أنثى|انثى/i.test(n) ? '#ec4899' : (/male|^m|ذكر/i.test(n) ? '#3BA0FF' : 'var(--muted)');
  return g.map((x) => {
    const pct = Math.round((x.count / tot) * 100);
    return `<div style="display:flex;align-items:center;gap:10px;padding:4px 0">
      <div style="width:90px;font-size:12.5px">${escapeHtml(x.name)}</div>
      <div style="flex:1;background:var(--border);border-radius:5px;height:16px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${col(x.name)}"></div></div>
      <div style="width:72px;text-align:right;font-size:12px"><b>${rsNum(x.count)}</b> <span style="color:var(--muted)">${pct}%</span></div>
    </div>`;
  }).join('');
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
      <div class="empty-icon" style="color:var(--muted)">${icon('alert').replace('class="mi-ico"', 'class="mi-ico" style="width:38px;height:38px"')}</div>
      <div class="empty-title">Couldn't load statistics</div>
      <div class="empty-sub">${escapeHtml(radstats.lastError)}</div>
      <button class="ghost" style="margin-top:12px" onclick="rsLoad()">Retry</button></div></div>`;
    return;
  }
  const d = radstats.data;
  if (!d || !d.ok) { body.innerHTML = rsSkeleton(); return; }

  // Self-heal: if the active tab needs data that isn't there and nothing is loading it (a
  // superseded request, a date-change race, a blip), kick the load off now — so switching
  // dates or tabs never leaves an empty/stale panel. The loading guards prevent any loop.
  if (radstats.tab === 'financial' && !radstats.finData && !radstats.finLoading && !radstats.finError) rsLoadFinancial();
  else if (radstats.tab === 'done' && !radstats.doneData && !radstats.doneLoading && !radstats.doneError) rsLoadDone();

  const total = d.total || 0;
  const patients = d.patients != null ? d.patients : null;
  const emg = (d.priority && d.priority.emergency) || 0;
  const rtn = (d.priority && d.priority.routine) || 0;
  const aged = (d.aging && d.aging['>7d']) || 0;
  const sitesFail = (d.sites && d.sites.failed && d.sites.failed.length) || 0;

  // Exams = individual procedures. Prefer the EXACT panel-based count (one FetchRISPanel row
  // per exam — the same source as the worklist + "Ordered vs Done", so the numbers agree).
  // Only if that's unavailable, fall back to the sampled/estimated bill-read count (modData).
  const m = radstats.modData, f = radstats.finData;
  let examsVal;
  if (d.panelExams != null) {
    examsVal = rsNum(d.panelExams);                 // exact — matches Ordered vs Done, shows instantly
  } else if (m) {
    examsVal = m.catalogLoaded === false ? '—'
      : (m.truncated ? '≈' + rsNum(Math.round((m.exams / Math.max(1, m.sampled)) * m.ofTotal)) : rsNum(m.exams || 0));
  } else {
    examsVal = '<span class="rs-pending">…</span>';
  }
  // Insurance-covered: exact when everything was priced, else scaled to the total
  // (a sample of 800 vs 1,118 must NOT read as "the rest are unpaid").
  let coveredVal = '<span class="rs-pending">…</span>', coveredSub = '';
  if (f) {
    if (f.catalogLoaded === false) { coveredVal = '—'; coveredSub = 'catalog unavailable'; }
    else {
      const priced = f.requests || 0;
      // "Insurance-covered" = insurance paid AT LEAST part, so include the copay bucket
      // (insurance + patient copay), not just the pure-insurance one — else copay requests
      // are wrongly dropped from the covered count and %.
      const cov = (f.byPayer || []).reduce((a, p) => a + ((p.type === 'Insurance' || p.type === 'Insurance + copay') ? (p.count || 0) : 0), 0);
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
  // Single-day focus (selected a date from busiest-dates / daily trend).
  if (radstats.dayFocus && radstats.dayFocus.date) {
    const dd = radstats.dayFocus.date;
    const label = (() => { const m = dd.match(/(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : dd; })();
    focusNote += `<div class="rs-focus"><span class="rs-focus-dot"></span>Showing <b>${escapeHtml(label)}</b>
      <button class="rs-focus-clear" onclick="rsClearDayFocus()">✕ Back to range</button></div>`;
  }

  // Layout — everything below is straight from Siratech HIS. Best practice for a
  // busy dashboard is to group, not stack: a manager sees 5–10 headline numbers,
  // then drills into a themed tab. Tabs: Overview (headline + what kind of work) ·
  // Operations (where the work is + timing/peaks) · Financial (revenue + payer).
  const dayCount = (d.daily || []).length;

  const tabOverview = `
    ${rsSection('Overview')}
    ${kpis}
    ${rsSection('Composition')}
    <div class="rs-grid2">
      ${rsPanel('Priority', prioDonut, total ? `${rsPct(emg, total)}% emergency` : 'routine vs emergency')}
      ${rsPanel('Modality mix (exams)', rsModalityInner(), rsModalitySub())}
    </div>
    ${d.byGender ? rsPanel('Gender split', rsGender(d.byGender), 'by order — a patient can have several', 'rs-wide') : ''}`;

  const tabOps = `
    ${rsSection('Where the work is')}
    <div class="rs-grid2">
      ${rsPanel('By branch', rsBarRows(branchItems, 'var(--accent)', 0, { drill: canDrill }), canDrill ? `${branchItems.length} branches · click to focus` : `${branchItems.length} branches`)}
      ${rsPanel('By ordering department', rsBarRows(deptItems, 'var(--accent2,#8358fd)'), `${deptItems.length} departments`)}
    </div>
    ${rsPanel('Top ordering doctors', rsBarRows(docItems, '#0ea5e9'), 'top 15', 'rs-wide')}
    ${rsSection('Timing')}
    <div class="rs-grid2">
      ${rsPanel('Daily trend', rsArea(d.daily || []), `${dayCount} day${dayCount === 1 ? '' : 's'} in range`)}
      ${rsPanel('Pending age', rsBarRows(agingItems, agingColor), 'time since order')}
    </div>
    ${rsPanel('⏰ Peak hours — when orders come in', rsHourly(d.byHour, d.hourHasTime), 'orders by hour of day · staff to the peak', 'rs-wide')}
    ${dayCount >= 3 ? rsPanel('📅 Busiest weekdays', rsWeekday(d.daily || []), 'avg orders per weekday · roster to demand', 'rs-wide') : ''}
    ${dayCount >= 5 ? rsPanel('🗓️ Busiest dates', rsBusyDates(d.daily || []), 'top days by volume in the range', 'rs-wide') : ''}`;

  const tabFinancial = `
    ${rsSection('Financial — revenue &amp; payer')}
    ${rsPanel('Revenue & payer', rsFinancialInner(), rsFinancialSub(), 'rs-wide')}`;

  const tabDone = `
    ${rsSection('Ordered vs Done — daily &amp; monthly')}
    ${rsPanel('Exams ordered vs actually done', rsDoneInner(), rsDoneSub(), 'rs-wide')}`;

  // "Ordered vs Done" is an org-wide (all-branch) management view, so it's hidden for a
  // branch-locked team lead (whose rest-of-page is scoped to their own branch).
  const _orgView = !rsIsLead() && !radstats.leadLocked;
  const TABS = [
    ['overview', 'Overview', tabOverview],
    ['operations', 'Operations', tabOps],
    ...(_orgView ? [['done', 'Ordered vs Done', tabDone]] : []),
    ['financial', 'Financial', tabFinancial],
  ];
  if (!radstats.tab || !TABS.some((t) => t[0] === radstats.tab)) radstats.tab = 'overview';
  const active = TABS.find((t) => t[0] === radstats.tab) || TABS[0];
  const tabBar = `<div class="rs-tabs">${TABS.map(([k, label]) =>
    `<button class="rs-tab ${radstats.tab === k ? 'on' : ''}" onclick="rsSetTab('${k}')">${label}</button>`).join('')}</div>`;

  const foot = `<div class="rs-foot">Range ${escapeHtml((d.range && d.range.from) || '')} → ${escapeHtml((d.range && d.range.to) || '')}
    · straight from Siratech HIS · updated ${escapeHtml(timeAgo(d.generatedAt))}${sitesFail ? ` · branches unavailable: ${escapeHtml((d.sites.failed || []).join(', '))}` : ''}</div>`;

  const nextHtml = focusNote + tabBar + `<div class="rs-tabpane">${active[2]}</div>` + foot;
  // Skip the expensive innerHTML swap (donuts + area chart + hourly/weekday bars all
  // re-parse) when nothing changed — the 30s Auto poll otherwise repaints twice a minute
  // for zero new information. Signature = the actual data + view state, minus the "updated
  // Xs ago" ticker (which always moves), so a cache-hit poll is a true no-op.
  const sig = `${(d.generatedAt) || ''}|${radstats.tab}|${radstats.modData ? radstats.modData.exams : ''}|${radstats.finData ? radstats.finData.revenue : ''}|${(radstats.sel ? [...radstats.sel].join(',') : '')}|${radstats.dayFocus && radstats.dayFocus.date || ''}|${radstats.modLoading}|${radstats.finLoading}|${radstats.doneLoading}|${radstats.doneData ? (radstats.doneData.daily || []).length : ''}`;
  if (sig === radstats._bodySig && body.firstChild) {
    // just refresh the "updated Xs ago" footer text, skip the full rebuild
    const f = body.querySelector('.rs-foot'); if (f) f.innerHTML = foot.replace(/^<div class="rs-foot">/, '').replace(/<\/div>$/, '');
    return;
  }
  radstats._bodySig = sig;
  body.innerHTML = nextHtml;
  // Bring the numbers to life — count each KPI / donut / total up to its value.
  try { rsAnimateCounts(body); } catch (e) {}
}

// Switch dashboard tab. Reset the paint pin so the new pane animates in (feels
// alive), then repaint. Financial data loads lazily the first time that tab opens.
function rsSetTab(name) {
  radstats.tab = name;
  radstats._paintedOnce = false;
  if (name === 'financial' && !radstats.finData && !radstats.finLoading) rsLoadFinancial();
  // Ordered vs Done: refresh on EVERY open so TODAY is live — keeps showing the cached numbers
  // while the fresh ones load underneath (no blank flash).
  if (name === 'done' && !radstats.doneLoading) rsLoadDone();
  rsRenderBody();
}

// ── Ordered vs Done — daily & monthly, self-correcting for late exams ──────────
// The counts are attributed to the ORDER date and re-checked nightly by the server, so a
// patient who does the exam days later makes that original day's "done" rise. Org-wide.
async function rsLoadDone(force) {
  radstats.doneLoading = true; radstats.doneError = '';
  if (!radstats.doneData) rsRenderBody();
  try {
    radstats.doneData = await API.get('/radiology/stats/done-history?days=45&months=6');
  } catch (e) {
    radstats.doneError = (e && e.message) || 'Could not load ordered-vs-done';
  } finally {
    radstats.doneLoading = false; rsRenderBody();
  }
}
function rsDoneSub() {
  const d = radstats.doneData;
  if (!d) return 'daily & monthly — click to load';
  return 'exams (procedures) · today is live · earlier days self-correct as late exams complete';
}
const _rsPct = (done, ord) => (ord ? Math.round((done / ord) * 100) : 0);
function _rsDoneTable(rows, keyLabel, keyField, opts) {
  const clickable = opts && opts.dayClick;
  const bar = (done, ord) => `<div class="rs-donebar"><span style="width:${_rsPct(done, ord)}%"></span></div>`;
  const body = rows.map((r) => {
    const ord = r.ordered || 0, done = r.done || 0;
    const unv = r.unverifiable ? `<span class="rs-done-unv">+${rsNum(r.unverifiable)} DEXA</span>` : '';
    const attrs = clickable ? ` class="rs-done-row rs-bar-click" onclick="rsDoneDay('${escapeHtml(String(r[keyField]))}')"` : ' class="rs-done-row"';
    return `<tr${attrs}>
      <td>${escapeHtml(String(r[keyField]))}${clickable ? ' <span class="rs-bar-go">›</span>' : ''}</td>
      <td class="rs-done-n">${rsNum(ord)}</td>
      <td class="rs-done-n" style="font-weight:800;color:var(--green-ink,#15803d)">${rsNum(done)}</td>
      <td class="rs-done-n">${_rsPct(done, ord)}%</td>
      <td>${bar(done, ord)}${unv}</td>
    </tr>`;
  }).join('');
  return `<table class="rs-done-tbl"><thead><tr><th>${escapeHtml(keyLabel)}</th><th class="rs-done-n">Ordered</th><th class="rs-done-n">Done</th><th class="rs-done-n">%</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
}
function rsDoneInner() {
  if (radstats.doneLoading && !radstats.doneData) return rsLoadingBlock('Loading ordered vs done…', 'Daily & monthly, self-corrected for late exams.');
  if (radstats.doneError && !radstats.doneData) return `<div class="rs-empty">${escapeHtml(radstats.doneError)} <button class="ghost" onclick="rsLoadDone(true)">Retry</button></div>`;
  const d = radstats.doneData;
  if (!d) {
    return `<div class="rs-modcta">
      <p>How many radiology orders were placed, and how many actually got done — by day and by month.<br>
      <span style="opacity:.75">Confirmed from PACS, attributed to the order date, self-correcting for exams done a few days later.</span></p>
      <button class="open pri" style="width:auto" onclick="rsLoadDone(true)">Load</button></div>`;
  }
  const monthly = d.monthly || [], daily = d.daily || [], mods = d.byModality || [];
  if (!monthly.length && !daily.length) {
    return `<div class="rs-empty">No data yet — the nightly job builds this up. Ask an admin to run a reconciliation, or check back tomorrow.</div>`;
  }
  // Glanceable headline cards: this month + last month done/ordered.
  const card = (m, lbl) => m ? `<div class="rs-done-card">
      <div class="rs-done-card-l">${lbl} · ${escapeHtml(m.month)}</div>
      <div class="rs-done-card-v">${rsNum(m.done)}<span class="rs-done-card-of"> / ${rsNum(m.ordered)}</span></div>
      <div class="rs-done-card-b"><span style="width:${_rsPct(m.done, m.ordered)}%"></span></div>
      <div class="rs-done-card-p">${_rsPct(m.done, m.ordered)}% done${m.unverifiable ? ` · +${rsNum(m.unverifiable)} DEXA` : ''}</div>
    </div>` : '';
  const cards = (monthly[0] || monthly[1]) ? `<div class="rs-done-cards">${card(monthly[0], 'This month')}${card(monthly[1], 'Last month')}</div>` : '';
  const monthTbl = monthly.length ? `<div class="rs-subhead">By month</div>${_rsDoneTable(monthly, 'Month', 'month')}` : '';
  const dayTbl = daily.length ? `<div class="rs-subhead" style="margin-top:18px">By day${d.currentMonth ? ' · ' + escapeHtml(d.currentMonth) : ''} <span style="font-weight:600;color:var(--muted)">(tap a day for the patient list)</span></div>${_rsDoneTable(daily, 'Day', 'date', { dayClick: true })}` : '';
  const modTbl = mods.length ? `<div class="rs-subhead" style="margin-top:18px">By exam type (this month)</div>${_rsDoneTable(mods.map((m) => ({ month: m.modality, ordered: m.ordered, done: m.done })), 'Exam', 'month')}` : '';
  return `<div id="rs-done-drill"></div>${cards}${monthTbl}${dayTbl}${modTbl}`;
}

// Drill one day → the patient-level list (MRN + exam + done). Management-only endpoint.
async function rsDoneDay(date) {
  const box = document.getElementById('rs-done-drill');
  if (!box) return;
  box.innerHTML = `<div class="rs-done-drillcard"><div class="rs-done-drillhead"><b>${escapeHtml(date)}</b><span class="mini-spin"></span> loading patients…</div></div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  let d;
  try { d = await API.get('/radiology/stats/done-day?date=' + encodeURIComponent(date)); }
  catch (e) { box.innerHTML = `<div class="rs-done-drillcard rs-empty">${escapeHtml((e && e.message) || 'Could not load')}</div>`; return; }
  const orders = (d && d.orders) || [];
  const rows = orders.map((o) => `<div class="rs-done-prow ${o.done ? 'is-done' : 'not-done'}">
      <span class="rs-done-dot"></span>
      <div style="flex:1;min-width:0">
        <div class="rs-done-pname">${escapeHtml(o.name || o.mrno || '—')}</div>
        <div class="rs-done-pmeta">${escapeHtml(o.exam || o.modality || '')}${o.branch ? ' · ' + escapeHtml(o.branch) : ''} · MRN ${escapeHtml(o.mrno || '')}</div>
      </div>
      <span class="rs-done-tag">${o.done ? (o.reported ? 'Reported' : 'Done') : 'Not done'}</span>
    </div>`).join('') || `<div class="rs-empty">No orders that day.</div>`;
  box.innerHTML = `<div class="rs-done-drillcard">
    <div class="rs-done-drillhead"><b>${escapeHtml(date)}</b> — ${rsNum(d.done)}/${rsNum(d.ordered)} done
      <button class="ghost" style="margin-inline-start:auto" onclick="document.getElementById('rs-done-drill').innerHTML=''">✕ close</button></div>
    <div class="rs-done-plist">${rows}</div></div>`;
}

function rsSection(title) { return `<div class="rs-section">${title}</div>`; }

function rsModalitySub() {
  const pm = radstats.data && radstats.data.panelModality;
  if (pm && pm.mix && pm.mix.length) return `${rsNum(pm.exams || 0)} exams · exact`;
  const m = radstats.modData;
  if (!m) return 'exact — click to load';
  return m.truncated
    ? `${rsNum(m.exams || 0)} exams · sample of ${rsNum(m.sampled)}/${rsNum(m.ofTotal)}`
    : `${rsNum(m.exams || 0)} exams`;
}

// A lively indeterminate-progress block, so a genuinely slow pass (the all-branch bill read
// can take up to a minute on the small box) reads as WORKING, not a frozen dead spinner.
function rsLoadingBlock(title, sub) {
  return `<div class="rs-loading">
    <div class="rs-loading-t"><span class="mini-spin"></span> ${escapeHtml(title)}</div>
    ${sub ? `<div class="rs-loading-s">${escapeHtml(sub)}</div>` : ''}
    <div class="rs-loadbar"></div>
  </div>`;
}

function rsModalityInner() {
  // EXACT, INSTANT modality mix straight from the base payload (FetchRISPanel — one row per
  // exam), so the donut total matches the "Exams" tile and "Ordered vs Done" and paints with
  // no wait. Falls back to the old sampled bill-read path only if the panel data is absent.
  const pm = radstats.data && radstats.data.panelModality;
  if (pm && pm.mix && pm.mix.length) {
    const segs = pm.mix.map((x) => ({ label: x.modality, count: x.count, color: MOD_COLOR[x.modality] || '#94a3b8' }));
    return rsDonut(segs, { centerVal: pm.exams, centerLabel: 'exams' });
  }
  if (radstats.modLoading) return rsLoadingBlock('Reading exam details…', 'Pricing each order across all branches — a wide range can take up to a minute.');
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
  // When the bill population exceeded the cap (truncated), the Exams KPI shows an
  // extrapolated total — so scale the donut center + segments by the SAME factor, or the
  // two "exams" figures on screen disagree. Exact ranges keep scale = 1.
  const scale = (m.truncated && m.sampled) ? (m.ofTotal / m.sampled) : 1;
  const segs = m.mix.map((x) => ({ label: x.modality, count: Math.round((x.count || 0) * scale), color: MOD_COLOR[x.modality] || '#94a3b8' }));
  const centerVal = Math.round((m.exams || 0) * scale);
  return rsDonut(segs, { centerVal, centerLabel: 'exams' });
}

const rsSAR = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' SAR';
function rsFinancialSub() {
  const f = radstats.finData;
  if (!f) return 'net revenue — click to load';
  return f.truncated ? `≈ estimate · read ${rsNum(f.sampled)} of ${rsNum(f.ofTotal)} bills` : `all ${rsNum(f.ofTotal || 0)} bills read · exact`;
}
function rsFinancialInner() {
  if (radstats.finLoading) return rsLoadingBlock('Reading bills…', 'Totting up net revenue from each bill.');
  if (radstats.finError) return `<div class="rs-empty">${escapeHtml(radstats.finError)} <button class="ghost" onclick="rsLoadFinancial()">Retry</button></div>`;
  const f = radstats.finData;
  if (!f) {
    return `<div class="rs-modcta">
      <span class="rs-modcta-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></span>
      <p>Radiology net revenue — read per order, so it loads on demand.<br>
      <span style="opacity:.75">Billed (net of discount) — not collected/settled.</span></p>
      <button class="open pri" style="width:auto" onclick="rsLoadFinancial()">Load revenue</button>
    </div>`;
  }
  if (f.catalogLoaded === false) return `<div class="rs-empty">Exam catalog temporarily unavailable — net revenue can't be computed right now. <button class="ghost" onclick="rsLoad(false, true)">Refresh</button></div>`;
  const canDrill = !rsIsLead() && !radstats.leadLocked;
  const branchRev = (f.byBranch || []).filter((b) => (b.revenue || 0) > 0)
    .map((b) => ({ label: b.name || ('Branch ' + b.site), count: Math.round(b.revenue), site: b.site }));
  // If some bill reads failed (VPS timeouts), the revenue is an UNDERCOUNT — say so
  // loudly with a one-tap retry, instead of showing a silently-halved figure as final.
  const missWarn = (f.billsFailed > 0)
    ? `<div class="rs-fin-warn">⚠ Estimate — ${rsNum(f.billsFailed)} of ${rsNum((f.billsRead || 0) + f.billsFailed)} bills couldn't be read, so revenue below is undercounted. <button class="ghost" onclick="rsLoad(false, true)">Retry read</button></div>`
    : '';
  return `<div class="rs-fin">
    ${missWarn}
    <div class="rs-fin-head">
      <div class="rs-fin-total"><div class="rs-fin-n rs-count" data-count="${Number(f.requests) || 0}" data-key="rs-fin-req">0</div><div class="rs-fin-l">radiology requests priced</div></div>
      <div class="rs-fin-total">
        <div class="rs-fin-n">${f.estimated ? '≈ ' : ''}${rsSAR(f.revenue)}</div>
        <div class="rs-fin-l">billed net revenue${f.estimated ? ' · estimated' : ''}</div>
        <div class="rs-fin-note">net of discount · billed, not collected</div>
      </div>
    </div>
    ${branchRev.length ? `<div class="rs-subhead">Net revenue by branch (SAR)</div>${rsBarRows(branchRev, 'var(--accent)', 0, { drill: canDrill })}` : ''}
  </div>`;
}
