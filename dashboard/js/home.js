// ── Home dashboard ────────────────────────────────────────────────────────────
// Clean overview centred on TODAY'S CASES, with a compact action strip.

function _greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ── Live hero clock (Riyadh time) ─────────────────────────────────────────────
// A big, always-ticking clock is the first thing a manager sees on Home — reads
// as a real, live control room rather than a static page.
let _hmClockTimer = null;
function _hmClockParts() {
  let t;
  try { t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Riyadh', hour12: false }); }
  catch (e) { t = new Date().toLocaleTimeString('en-GB', { hour12: false }); }
  const [hh = '00', mm = '00', ss = '00'] = String(t).split(':');
  return { hm: `${hh}:${mm}`, ss };
}
function _hmStartClock() {
  if (_hmClockTimer) clearInterval(_hmClockTimer);
  const tick = () => {
    const hmEl = document.getElementById('hm-clock-hm');
    const sEl = document.getElementById('hm-clock-s');
    if (!hmEl) { clearInterval(_hmClockTimer); _hmClockTimer = null; return; }
    const p = _hmClockParts();
    hmEl.textContent = p.hm;
    if (sEl) sEl.textContent = p.ss;
  };
  tick();
  _hmClockTimer = setInterval(tick, 1000);
}

// Quick-action tiles — built from the sidebar nav the user can actually see, so
// they stay role-safe and route through the existing showPage() with no new
// navigation logic. Especially useful for technologists, whose Home is sparse.
function hmQuickActionsHtml() {
  const MAP = {
    worklist:      { label: 'Worklist',        ic: 'inbox' },
    patientsearch: { label: 'Patient Lookup',  ic: 'search' },
    orders:        { label: 'Orders',          ic: 'file-text' },
    radstats:      { label: 'Radiology Stats', ic: 'bar-chart' },
    schedule:      { label: 'Schedule',        ic: 'calendar' },
    handoff:       { label: 'Handoff',         ic: 'refresh' },
    staff:         { label: 'Staff',           ic: 'users' },
  };
  const order = ['worklist', 'patientsearch', 'orders', 'radstats', 'schedule', 'handoff', 'staff'];
  const tiles = order.filter(p => {
    const el = document.getElementById('nav-' + p);
    return el && el.style.display !== 'none';
  }).slice(0, 6).map(p => {
    const m = MAP[p];
    return `<button class="hm-qa" onclick="showPage('${p}')">
        <span class="hm-qa-ic">${icon(m.ic)}</span>
        <span class="hm-qa-lb">${m.label}</span>
      </button>`;
  }).join('');
  return tiles ? `<div class="hm-quick">${tiles}</div>` : '';
}

async function renderHomePage() {
  setTopbar('Home', 'Your overview at a glance');
  const today = new Date();
  const greg = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const c0 = _hmClockParts();

  document.getElementById('content').innerHTML = `
    <div class="cc">
    <div class="phero phero-lg">
      <div class="phero-orb p1"></div><div class="phero-orb p2"></div>
      <div class="phero-orb p3"></div>
      <div class="phero-inner">
        <div class="phero-logo"><img src="/meena_logo.png" alt="Meena"></div>
        <div class="phero-text">
          <div class="phero-hi">${_greeting()},</div>
          <div class="phero-title">${escapeHtml(currentUser?.username || '')}</div>
          <div class="phero-sub">${greg}</div>
        </div>
        <div class="phero-clock" id="phero-clock" aria-label="Current time in Riyadh">
          <div class="phero-clock-time">
            <span id="hm-clock-hm">${c0.hm}</span><span class="phero-clock-sec" id="hm-clock-s">${c0.ss}</span>
          </div>
          <div class="phero-clock-meta"><span class="phero-clock-dot"></span> Riyadh · live</div>
        </div>
      </div>
    </div>
    ${hmQuickActionsHtml()}
    <div id="hm-radstats"></div>
    <div id="hm-fullstats" style="margin-top:14px"></div>
    <div id="hm-approvals"></div>
    <div class="hm-search">
      <div class="hm-searchbar">
        <span class="hm-search-ic">${icon('search')}</span>
        <input id="hm-staff-q" type="search" placeholder="Search any staff by name or employee ID…" autocomplete="off"
          oninput="homeStaffSearch(this.value)" onkeydown="if(event.key==='Escape'){this.value='';homeStaffSearch('')}">
        <span class="hm-kbd" id="hm-search-kbd">/</span>
      </div>
      <div id="hm-staff-filters" class="hm-filters" style="display:none">
        <button class="hm-fchip on" data-sec="" onclick="homeSetFilter(this,'')">All</button>
        <button class="hm-fchip" data-sec="General" onclick="homeSetFilter(this,'General')">General</button>
        <button class="hm-fchip" data-sec="US" onclick="homeSetFilter(this,'US')">Ultrasound</button>
      </div>
      <div id="hm-recent" class="hm-recent"></div>
      <div id="hm-staff-results" class="hm-results"></div>
    </div>
    </div>
    `;

  _hmStartClock();

  // Home is a lean, live operational snapshot: today's radiology across all
  // branches (auto-refreshing) + the manager's approval queue. On-duty, equipment
  // checks, and Employee-of-the-Month moved to their own pages (Schedule / Maintenance
  // / Staff); expiring-credentials and the duplicate count-chips were removed.
  if (ADMIN_ROLES.includes(currentUser?.role)) {
    renderHomeRadstats();
    // Full radiology statistics embedded right in Home (by branch / modality /
    // department / doctor / payer / trend), reusing the Radiology-stats view.
    const fs = document.getElementById('hm-fullstats');
    if (fs && typeof renderRadStatsPage === 'function') {
      renderRadStatsPage({ container: fs }).catch(() => {});
    }
    renderHomeApprovals();
  }
  renderHomeRecent();
  _bindHomeSearchShortcut();
}

// Shimmer placeholder so a card shows a stable loading state instead of staying
// empty and then popping in.
const HOME_CARD_SKELETON = `<div class="hm-card">
  <div class="skel skel-line" style="width:42%;height:14px;margin-bottom:14px"></div>
  <div class="skel" style="height:52px;border-radius:12px"></div></div>`;

// Press "/" anywhere on Home to jump straight into the search box.
let _hmShortcutBound = false;
function _bindHomeSearchShortcut() {
  if (_hmShortcutBound) return;
  _hmShortcutBound = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.getElementById('hm-staff-q');
    if (!el || el.offsetParent === null) return;               // only when Home search is visible
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault(); el.focus();
  });
}

// ── "Needs your approval": pending leave / time-back / swaps, organized ───────
async function renderHomeApprovals() {
  const box = document.getElementById('hm-approvals');
  if (!box) return;
  box.innerHTML = HOME_CARD_SKELETON;
  const isReviewer = ['manager', 'superadmin'].includes(currentUser?.role);
  let leaves = [], tbs = [], swaps = [];
  try {
    [leaves, tbs, swaps] = await Promise.all([
      API.get('/leaves').catch(() => []),
      API.get('/timeback').catch(() => []),
      API.get('/swaps').catch(() => []),
    ]);
  } catch (e) { box.innerHTML = ''; return; }

  // Leave ranges awaiting THIS user's action.
  const groups = (typeof groupLeaveRanges === 'function' ? groupLeaveRanges(leaves) : leaves)
    .filter(g => (g.status === 'pending') || (g.status === 'lead_approved' && isReviewer));
  const tbPending = (tbs || []).filter(t => t.status === 'pending' || (t.status === 'lead_approved' && isReviewer));
  const swapPending = (swaps || []).filter(s => ['pending', 'pending_lead', 'pending_manager'].includes(s.status));

  if (!groups.length && !tbPending.length && !swapPending.length) {
    box.innerHTML = `<div class="board" style="margin-bottom:14px">
      <div class="bhead"><div class="bhrow"><div class="btitle">Needs your approval</div></div></div>
      <div class="rows"><div class="lrow" style="padding:12px 18px;color:var(--muted);font-size:13px">You're all caught up 🎉</div></div></div>`;
    return;
  }
  const row = (left, right) => `<div class="lrow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 18px">
      <div style="font-size:13px;min-width:0">${left}</div><div style="font-size:12px;flex-shrink:0">${right}</div></div>`;
  const section = (title, count, link, rows) => !count ? '' : `
    <div style="margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 18px 2px">
        <div style="font-weight:700;font-size:13px">${title} <span class="sc warn">${count}</span></div>
        <button class="ghost" onclick="showPage('${link}')">View all →</button>
      </div>
      ${rows}
    </div>`;

  const leaveRows = groups.slice(0, 5).map(g => {
    const span = g.date_to && g.date_to !== g.date_from ? `${fmtDateDisplay(g.date_from)}–${fmtDateDisplay(g.date_to)}` : fmtDateDisplay(g.date_from);
    return row(`<b>${escapeHtml(g.staff_name || '')}</b> · ${escapeHtml(g.leave_type)} · ${span} <span class="hm-muted">(${g.day_count}d)</span>`,
      `<button class="open" onclick='homeApproveLeave(${JSON.stringify(g.ids)})'>✓ Approve</button>`);
  }).join('');
  const tbRows = tbPending.slice(0, 5).map(t => row(
    `<b>${escapeHtml(t.staff_name || '')}</b> · ${t.days}d · ${fmtDateDisplay(t.date)}`,
    `<button class="open" onclick="homeApproveTimeback(${t.id})">✓ Approve</button>`)).join('');
  const swapRows = swapPending.slice(0, 5).map(s => row(
    `<b>${escapeHtml(s.staff_a_name || '')}</b> ↔ ${escapeHtml(s.staff_b_name || '?')} · ${fmtDateDisplay(s.date_a)}`,
    `<span class="ris progress"><span class="rd"></span>${escapeHtml(s.status.replace('pending_', 'awaiting '))}</span>`)).join('');

  box.innerHTML = `<div class="board" style="margin-bottom:14px">
    <div class="bhead"><div class="bhrow"><div class="btitle">Needs your approval <span>${groups.length + tbPending.length + swapPending.length} pending</span></div></div></div>
    <div class="rows">
      ${section('Leave requests', groups.length, 'leaves', leaveRows)}
      ${section('Time-back', tbPending.length, 'leaves', tbRows)}
      ${section('Shift swaps', swapPending.length, 'swaps', swapRows)}
    </div></div>`;
}

// TODAY's radiology across all branches — the live centrepiece of the manager
// Home. Auto-refreshes so it reads as a real-time control room. A team lead is
// scoped to their own branch (fail-closed); managers/superadmin see all branches.
let _hmRadTimer = null;
let _hmRadData = null;      // last stats payload (incl. the drill-down request rows)
let _hmRadDrill = '';       // which tile is currently expanded ('' = none)
let _hmRadSite = null;      // resolved scope for the card, so a drill can refetch on demand
let _hmRadScope = '';
function _hmKsaToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) { return new Date().toISOString().slice(0, 10); }
}
async function renderHomeRadstats() {
  const box = document.getElementById('hm-radstats');
  // Clear any existing auto-refresh up front — two quick re-entries would otherwise
  // both await, then both assign _hmRadTimer, orphaning the first interval.
  if (_hmRadTimer) { clearInterval(_hmRadTimer); _hmRadTimer = null; }
  if (!box) return;
  const isLead = currentUser?.role === 'admin';
  let site = null, scopeName = '';
  if (isLead && typeof rsMySite === 'function') {
    let mine = null;
    try { mine = await rsMySite(); } catch (e) {}
    if (mine) { site = mine.siteId; scopeName = currentUser?.branch_name || mine.shortName || mine.name; }
    else {
      // FAIL CLOSED — a team lead whose branch we can't resolve must NOT get an
      // unscoped (all-branch) query.
      box.innerHTML = `<div class="board" style="margin-bottom:14px">
        <div class="bhead"><div class="bhrow"><div class="btitle">Radiology</div></div></div>
        <div class="rows"><div class="lrow" style="padding:12px 18px;color:var(--muted);font-size:13px">Your branch isn't linked to the hospital system yet — ask an admin to link it.</div></div></div>`;
      return;
    }
  }
  if (!box.dataset.loaded) {
    const t = scopeName ? escapeHtml(scopeName) : 'all branches';
    box.innerHTML = `<div class="board" style="margin-bottom:14px">
      <div class="bhead"><div class="bhrow"><div class="btitle">Radiology today <span>${t}</span></div></div></div>
      <div class="rows"><div class="lrow" style="padding:12px 18px"><span class="mini-spin"></span> Loading live data…</div></div></div>`;
  }
  await _hmRadFetch(site, scopeName);
  // Live auto-refresh; self-stops when the user leaves Home.
  if (_hmRadTimer) clearInterval(_hmRadTimer);
  _hmRadTimer = setInterval(() => {
    if (!document.getElementById('hm-radstats') || (typeof currentPage !== 'undefined' && currentPage !== 'home')) {
      clearInterval(_hmRadTimer); _hmRadTimer = null; return;
    }
    if (document.hidden) return;               // don't poll a backgrounded tab
    _hmRadFetch(site, scopeName);
  }, 90000);
}
async function _hmRadFetch(site, scopeName) {
  const box = document.getElementById('hm-radstats');
  if (!box) return;
  _hmRadSite = site; _hmRadScope = scopeName;   // remembered so a drill-open can refetch the rows
  const today = _hmKsaToday();
  // Only pull the (heavier) per-patient drill rows when a tile is actually expanded; the three
  // headline tiles need aggregates only, so the default poll stays light and paints faster.
  const wantList = !!_hmRadDrill;
  const q = `from=${today}&to=${today}${site ? `&sites=${site}` : ''}${wantList ? '&list=1' : ''}`;
  let d;
  try { d = await API.get(`/radiology/stats?${q}`); } catch (e) { return; }   // keep last-good on a blip
  if (!d || !d.ok) { if (!box.dataset.loaded) box.innerHTML = ''; return; }
  // Entrance animation fires ONCE per visit — the 90s auto-refresh recreates the
  // board/KPI nodes, which would replay the rise stagger as a visible flicker.
  // Mirror the worklist's .cc-still pin; dataset.loaded lives on the DOM node, so
  // a fresh Home render naturally animates again.
  const ccRoot = box.closest('.cc');
  if (ccRoot) ccRoot.classList.toggle('cc-still', !!box.dataset.loaded);
  box.dataset.loaded = '1';
  _hmRadData = d;
  const total = d.total || 0, emg = (d.priority && d.priority.emergency) || 0;
  const rtn = (d.priority && d.priority.routine) || 0;
  const top = (d.byBranch || []).filter(b => b.count > 0)[0];
  const upd = _hmClockParts();
  const scope = scopeName ? escapeHtml(scopeName) : 'all branches';
  // Tiles are buttons — tapping one lists the actual requests behind it (patient +
  // exam), filtered to that tile. The active tile is highlighted.
  const kpi = (n, l, cls, dot, cap, filter) => `<button type="button"
    class="kpi ${cls}${filter && _hmRadDrill === filter ? ' active' : ''}"
    style="text-align:start;font:inherit;cursor:pointer"${filter ? ` onclick="hmRadDrillToggle('${filter}')"` : ''}>
    <div class="kl"><span class="kd" style="background:${dot}"></span>${l}</div>
    <div class="kv">${Number(n).toLocaleString()}</div>
    <div class="kt">${cap}</div></button>`;
  const tiles = [
    kpi(total, 'Requests', 'b', 'var(--blue,#3BA0FF)', 'today · tap for the list', 'all'),
    kpi(emg, 'Emergency', 'a', emg ? 'var(--danger,#E25555)' : 'var(--amber,#F4B740)', emg ? '<span class="dn">needs attention</span>' : 'none so far', 'emergency'),
    kpi(rtn, 'Routine', 'c', 'var(--green,#00C896)', 'scheduled flow', 'routine'),
  ];
  // Poll-skip: the 90s auto-refresh re-runs this even when nothing changed, tearing down
  // and rebuilding the tiles + drill list for zero new info (and collapsing any open drill).
  // Skip the DOM rebuild when the content signature is unchanged — same pattern as the
  // worklist/orders/radstats pollers.
  const _drillCount = (_hmRadDrill && d.list) ? d.list.length : 0;
  const _sig = `${total}|${emg}|${rtn}|${top ? top.site + ':' + top.count : ''}|${scope}|${_hmRadDrill || ''}|${_drillCount}`;
  if (box.dataset.sig === _sig && box.firstChild) return;   // unchanged → keep the DOM (and the open drill)
  box.dataset.sig = _sig;
  if (!site && top) tiles.push(`<button type="button" class="kpi d${_hmRadDrill === 'branch:' + top.site ? ' active' : ''}"
      style="text-align:start;font:inherit;cursor:pointer" onclick="hmRadDrillToggle('branch:${top.site}')">
      <div class="kl"><span class="kd" style="background:var(--violet,#6B4EFF)"></span>Busiest branch</div>
      <div class="kv" style="font-size:17px;line-height:1.3">${escapeHtml(top.name || ('Branch ' + top.site))}</div>
      <div class="kt">${Number(top.count).toLocaleString()} requests</div></button>`);
  else if (!site) tiles.push(`<div class="kpi d"><div class="kl"><span class="kd" style="background:var(--violet,#6B4EFF)"></span>Busiest branch</div>
      <div class="kv">—</div><div class="kt">no activity yet</div></div>`);
  box.innerHTML = `<div class="board" style="margin-bottom:14px">
    <div class="bhead"><div class="bhrow">
      <div class="btitle">Radiology today <span>${scope}</span></div>
      <div class="bh-actions">
        <span class="liveTag"><i></i>Live · updated ${upd.hm}:${upd.ss} Riyadh</span>
        <button class="ghost" onclick="showPage('radstats')">Open →</button>
      </div>
    </div></div>
    <div style="padding:14px 18px 16px">
      <div class="kpis">${tiles.join('')}</div>
      <div id="hm-rad-drill"></div>
    </div>
  </div>`;
  if (_hmRadDrill) hmRadDrillRender();
}

// Toggle the drill-down list for a tile ('all' | 'emergency' | 'routine' | 'branch:<site>').
function hmRadDrillToggle(filter) {
  _hmRadDrill = (_hmRadDrill === filter) ? '' : filter;
  // Re-highlight the tiles + (re)render the list without a full refetch.
  document.querySelectorAll('#hm-radstats .kpi').forEach(el => el.classList.remove('active'));
  // Tiles now load light (no drill rows). The first time a tile is opened, pull the rows
  // once; show an inline spinner meanwhile so the panel isn't blank.
  if (_hmRadDrill && !(_hmRadData && Array.isArray(_hmRadData.requests))) {
    const panel = document.getElementById('hm-rad-drill');
    if (panel) panel.innerHTML = `<div class="hm-rad-drillbox" style="padding:12px;color:var(--muted);font-size:12.5px"><span class="mini-spin"></span> Loading the list…</div>`;
    _hmRadFetch(_hmRadSite, _hmRadScope);
    return;
  }
  hmRadDrillRender();
}
function hmRadDrillRender() {
  const panel = document.getElementById('hm-rad-drill');
  if (!panel) return;
  if (!_hmRadDrill) { panel.innerHTML = ''; return; }
  const d = _hmRadData || {};
  const all = Array.isArray(d.requests) ? d.requests : null;
  if (all === null) {
    panel.innerHTML = `<div class="hm-rad-drillbox" style="color:var(--muted);font-size:12px">The request list isn't available — reopen Home after the next refresh.</div>`;
    return;
  }
  let rows = all, label = 'All requests';
  if (_hmRadDrill === 'emergency') { rows = all.filter(r => r.priority === 'emergency'); label = 'Emergency requests'; }
  else if (_hmRadDrill === 'routine') { rows = all.filter(r => r.priority === 'routine'); label = 'Routine requests'; }
  else if (_hmRadDrill.startsWith('branch:')) {
    const site = Number(_hmRadDrill.slice(7));
    rows = all.filter(r => Number(r.site) === site);
    label = (rows[0] && rows[0].branch) || 'Branch';
  }
  // Mark the active tile.
  document.querySelectorAll('#hm-radstats .kpi').forEach(el => {
    if (el.getAttribute('onclick') && el.getAttribute('onclick').includes(`'${_hmRadDrill}'`)) el.classList.add('active');
  });
  const trunc = d.requestsTruncated ? ` · showing first ${all.length} of ${d.requestsTruncated}` : '';
  const list = rows.length ? rows.map(r => `
    <button type="button" class="lrow" style="display:flex;width:100%;justify-content:space-between;align-items:center;gap:10px;text-align:start;font:inherit;cursor:pointer;background:none;border:none;border-bottom:1px solid var(--border);padding:9px 12px" onclick="openPatientLookup('${escapeHtml(r.mrno || '')}')">
      <div style="min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.name || '(no name)')}</div>
        <div style="font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.exam || '—')}${r.branch ? ' · ' + escapeHtml(r.branch) : ''}${r.doctor ? ' · ' + escapeHtml(r.doctor) : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        ${r.priority === 'emergency' ? '<span class="sc no">ER</span>' : ''}
        <span style="font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums">${escapeHtml(r.mrno || '')}</span>
      </div>
    </button>`).join('') : `<div style="padding:10px;color:var(--muted);font-size:12.5px">No requests in this group.</div>`;
  panel.innerHTML = `<div class="listcard" style="margin-top:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;font-size:12.5px;font-weight:700">
      <span>${escapeHtml(label)} · ${rows.length}${trunc}</span>
      <button class="ghost" onclick="hmRadDrillToggle('${_hmRadDrill}')">✕ close</button></div>
    <div style="max-height:320px;overflow:auto">${list}</div>
  </div>`;
}

async function homeApproveLeave(ids) {
  try {
    await API.put('/leaves/status', { ids, status: 'approved', confirm: true });
    toast('Leave approved'); renderHomeApprovals();
  } catch (e) { toast(e.message, 'err'); }
}
async function homeApproveTimeback(id) {
  try {
    await API.put(`/timeback/${id}/status`, { status: 'approved' });
    toast('Time-back approved'); renderHomeApprovals();
  } catch (e) { toast(e.message, 'err'); }
}

// ── Manager home: live staff lookup by name / employee ID ─────────────────────
let _hmSearchTimer = null;
let _hmSearchSeq = 0;         // request-sequence guard (stale response drops)
let _hmLastResults = [];      // last fetched rows (for client-side section filtering)
let _hmFilter = '';           // '' | 'General' | 'US'
let _hmLastTerm = '';

function homeStaffSearch(term) {
  clearTimeout(_hmSearchTimer);
  const box = document.getElementById('hm-staff-results');
  const filters = document.getElementById('hm-staff-filters');
  const recent = document.getElementById('hm-recent');
  const q = (term || '').trim();
  _hmLastTerm = q;
  if (q.length < 2) {
    _hmLastResults = [];
    if (box) box.innerHTML = '';
    if (filters) filters.style.display = 'none';
    renderHomeRecent();
    return;
  }
  if (recent) recent.innerHTML = '';      // hide recents while actively searching
  if (box) box.innerHTML = `<div class="hm-results-head hm-muted">Searching…</div>`;
  const seq = (_hmSearchSeq = (_hmSearchSeq || 0) + 1);   // ignore a slow response superseded by a newer term
  _hmSearchTimer = setTimeout(async () => {
    try {
      const r = await API.get(`/staff/search?q=${encodeURIComponent(q)}`);
      if (seq !== _hmSearchSeq) return;   // a newer search already ran — drop this stale result
      _hmLastResults = r.results || [];
      if (filters) filters.style.display = _hmLastResults.length ? 'flex' : 'none';
      renderHomeStaffResults();
    } catch (e) { if (box) box.innerHTML = `<div class="hm-muted" style="padding:8px">${escapeHtml(e.message)}</div>`; }
  }, 220);
}

function homeSetFilter(btn, sec) {
  _hmFilter = sec;
  document.querySelectorAll('#hm-staff-filters .hm-fchip').forEach(b => b.classList.toggle('on', b === btn));
  renderHomeStaffResults();
}

function _hmInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '–';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function _hmTodayBadge(code) {
  if (!code || code === 'O') return `<span class="hm-tg off">off today</span>`;
  if (['AL','SL','TB'].includes(code)) return `<span class="hm-tg lv">${code}</span>`;
  return `<span class="hm-tg on">Today: ${escapeHtml(code)}</span>`;
}

function renderHomeStaffResults() {
  const box = document.getElementById('hm-staff-results');
  if (!box) return;
  let rows = _hmLastResults;
  if (_hmFilter) rows = rows.filter(s => (s.section || 'General') === _hmFilter);
  if (!_hmLastResults.length) { box.innerHTML = `<div class="hm-results-head hm-muted">No staff match “${escapeHtml(_hmLastTerm)}”.</div>`; return; }
  if (!rows.length) { box.innerHTML = `<div class="hm-results-head hm-muted">No ${_hmFilter === 'US' ? 'Ultrasound' : _hmFilter} staff in this match.</div>`; return; }

  const head = `<div class="hm-results-head">${rows.length} ${rows.length === 1 ? 'match' : 'matches'} for “${escapeHtml(_hmLastTerm)}”</div>`;
  box.innerHTML = head + rows.map(s => {
    const bal = Number(s.leave_balance ?? 0);
    const pct = Math.max(0, Math.min(100, Math.round((bal / 22) * 100)));
    const secLabel = s.section === 'US' ? 'Ultrasound' : 'General';
    const payload = encodeURIComponent(JSON.stringify({ id: s.id, name: s.name, branch_id: s.branch_id, branch_name: s.branch_name, section: s.section }));
    return `
    <div class="hm-sres">
      <div class="hm-av">${escapeHtml(_hmInitials(s.name))}</div>
      <div class="hm-sinfo">
        <div class="hm-snm">${escapeHtml(s.name)}
          <span class="hm-spill">${escapeHtml(s.branch_name || '—')} · ${escapeHtml(secLabel)}</span>
          ${_hmTodayBadge(s.today_shift)}
          ${s.national_id ? `<span class="hm-tg on" title="Verified with Nafath">✓ Nafath</span>` : ''}
        </div>
        <div class="hm-sct">
          ${s.national_id ? `${icon('id-card')} ${escapeHtml(s.national_id)} · ` : ''}${s.name_ar ? `${escapeHtml(s.name_ar)} · ` : ''}
          ${s.employee_id ? `${icon('badge')} ${escapeHtml(s.employee_id)}` : ''}
          ${s.phone ? ` · ${icon('phone')} ${escapeHtml(s.phone)}` : ''}
          ${s.email ? ` · ${icon('mail')} ${escapeHtml(s.email)}` : ''}
          ${s.join_date ? ` · joined ${escapeHtml(s.join_date)}` : ''}
        </div>
        <div class="hm-chips">
          <span class="hm-chip2"><span class="kd" style="background:var(--blue,#3BA0FF)"></span><b>${s.shifts_month}</b> shifts this month</span>
          <span class="hm-chip2"><span class="kd" style="background:var(--amber,#F4B740)"></span><b>${s.leave_days_month}</b> leave days</span>
          <span class="hm-chip2"><span class="kd" style="background:var(--violet,#6B4EFF)"></span><b>${bal}</b> days balance</span>
        </div>
      </div>
      <div class="hm-ring" style="--p:${pct}" title="${bal} of 22 annual leave days"><i>${bal}</i></div>
      <button class="hm-rota-btn" onclick="openStaffSchedule(${s.branch_id}, '${payload}')">View rota →</button>
    </div>`;
  }).join('');
}

// ── Recently viewed staff (localStorage) ──────────────────────────────────────
function _hmRecent() {
  try { return JSON.parse(localStorage.getItem('hmRecentStaff') || '[]'); } catch { return []; }
}
function _hmPushRecent(s) {
  if (!s || !s.id) return;
  let list = _hmRecent().filter(x => x.id !== s.id);
  list.unshift({ id: s.id, name: s.name, branch_id: s.branch_id, branch_name: s.branch_name, section: s.section });
  list = list.slice(0, 5);
  try { localStorage.setItem('hmRecentStaff', JSON.stringify(list)); } catch {}
}
function renderHomeRecent() {
  const box = document.getElementById('hm-recent');
  if (!box) return;
  if (_hmLastTerm.length >= 2) { box.innerHTML = ''; return; }   // only on idle search
  const list = _hmRecent();
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<span class="hm-recent-lbl">Recent</span>` + list.map(s => `
    <button class="hm-rchip" onclick="openStaffSchedule(${s.branch_id}, '${encodeURIComponent(JSON.stringify(s))}')">
      <span class="hm-rmini">${escapeHtml(_hmInitials(s.name))}</span>${escapeHtml(s.name)}
    </button>`).join('');
}

// Jump to a branch's rota from a search result; remember the staff for "Recent".
function openStaffSchedule(branchId, payload) {
  if (payload) { try { _hmPushRecent(JSON.parse(decodeURIComponent(payload))); } catch {} }
  if (branchId) window._pendingScheduleBranch = branchId;
  showPage('schedule');
}

// ── Employee of the Month ─────────────────────────────────────────────────────
async function renderHomeEotm(containerId = 'hm-eotm') {
  const box = document.getElementById(containerId);
  if (!box) return;
  const isReviewer = ['manager', 'superadmin'].includes(currentUser?.role);
  // Branded shimmer while it loads, so the card holds its place instead of
  // popping in late (this was the "slow" feel on the manager Home).
  box.innerHTML = `<div class="hm-card hm-eotm-card">
    <div class="skel skel-line" style="width:38%;height:12px;margin-bottom:12px"></div>
    <div class="skel skel-line" style="width:60%;height:22px;margin-bottom:8px"></div>
    <div class="skel skel-line" style="width:30%;height:13px"></div></div>`;
  let d = null;
  try { d = await API.get('/employee-of-month'); } catch (e) { box.innerHTML = ''; return; }
  if (!d || !d.staff) {
    box.innerHTML = isReviewer ? `<div class="cc">
      <div class="listcard" style="margin-bottom:14px"><div class="lrow" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px">
        <div><b>Employee of the Month</b>
          <span class="hm-muted" style="margin-left:6px">not set</span></div>
        <button class="open" onclick="openEotmModal()">Choose</button>
      </div></div></div>` : '';
    return;
  }
  const s = d.staff;
  box.innerHTML = `<div class="cc">
    <div class="listcard hm-eotm-card hm-eotm-filled" style="margin-bottom:14px">
      <div class="hm-eotm-shine"></div>
      <div class="hm-eotm-row lrow" style="padding:14px 16px">
        <div class="hm-eotm-medal">🏆</div>
        <div class="hm-eotm-main">
          <div class="hm-eotm-kicker">Employee of the Month${d.period ? ' · ' + escapeHtml(d.period) : ''}</div>
          <div class="hm-eotm-name">${escapeHtml(s.name)}</div>
          <div class="hm-muted" style="font-size:13px">${escapeHtml(s.branch_name || '')}</div>
          ${d.note ? `<div class="hm-eotm-note">“${escapeHtml(d.note)}”</div>` : ''}
        </div>
        ${isReviewer ? `<div class="hm-eotm-actions">
          <button class="ghost" onclick="openEotmModal()">Change</button>
          <button class="ghost" style="color:var(--danger,#E25555)" onclick="clearEotm()">Clear</button>
        </div>` : ''}
      </div>
    </div></div>`;
}

async function clearEotm() {
  const ok = await showConfirm('Clear Employee of the Month', 'Remove the current selection from the home page?', 'Clear', '');
  if (!ok) return;
  try { await API.put('/employee-of-month', { staff_id: null }); toast('Cleared'); renderHomeEotm(); }
  catch (e) { toast(e.message, 'err'); }
}

function openEotmModal() {
  ensureEotmModal();
  if (!allStaff || !allStaff.length) { loadStaff().then(fillEotmStaff).catch(() => {}); }
  else fillEotmStaff();
  const now = new Date();
  document.getElementById('eotm-period').value =
    now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  document.getElementById('eotm-note').value = '';
  document.getElementById('eotm-msg').textContent = '';
  document.getElementById('eotm-modal-overlay').classList.add('open');
}
function fillEotmStaff() {
  const sel = document.getElementById('eotm-staff');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select staff…</option>' +
    (allStaff || []).map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.branch_name || '?')})</option>`).join('');
}
function closeEotmModal() { document.getElementById('eotm-modal-overlay').classList.remove('open'); }

async function saveEotm() {
  const msg = document.getElementById('eotm-msg');
  const sid = document.getElementById('eotm-staff').value;
  if (!sid) { msg.className = 'msg err'; msg.textContent = 'Pick a staff member'; return; }
  try {
    await API.put('/employee-of-month', {
      staff_id: Number(sid),
      note: document.getElementById('eotm-note').value.trim(),
      period: document.getElementById('eotm-period').value.trim(),
    });
    closeEotmModal();
    toast('Employee of the Month set');
    renderHomeEotm();
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
}

function ensureEotmModal() {
  if (document.getElementById('eotm-modal-overlay')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="modal-overlay" id="eotm-modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <h3>Employee of the Month</h3>
          <button class="modal-close" onclick="closeEotmModal()">&times;</button>
        </div>
        <div class="modal-body">
          <div style="display:flex;flex-direction:column;gap:14px">
            <div class="form-field">
              <label>Staff *</label>
              <select id="eotm-staff"></select>
            </div>
            <div class="form-field">
              <label>Period</label>
              <input type="text" id="eotm-period" placeholder="e.g. June 2026">
            </div>
            <div class="form-field">
              <label>Note (optional)</label>
              <input type="text" id="eotm-note" maxlength="300" placeholder="Why they earned it">
            </div>
            <div class="msg" id="eotm-msg"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeEotmModal()">Cancel</button>
          <button class="btn" onclick="saveEotm()">Save</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(div.firstElementChild);
}

// ── Equipment checks status (today) ───────────────────────────────────────────
async function renderHomeShiftChecks(containerId = 'hm-shiftcheck') {
  const box = document.getElementById(containerId);
  if (!box) return;
  const today = fmtDate(new Date());
  let d;
  try { d = await API.get(`/shift-checks/overview?date=${today}`); } catch (e) { box.innerHTML = ''; return; }
  const branches = (d && d.branches) || [];
  if (!branches.length) { box.innerHTML = ''; return; }
  const pill = (c) => {
    const done = c.done;
    const who = done && c.confirmed_by_name ? ` title="By ${escapeHtml(c.confirmed_by_name)}"` : '';
    return `<span class="sc ${done ? 'ok' : 'warn'}"${who} style="margin-left:6px">${done ? '✓' : '○'} ${c.label}</span>`;
  };
  box.innerHTML = `<div class="cc"><div class="board" style="margin-bottom:14px">
    <div class="bhead"><div class="bhrow"><div class="btitle">Equipment checks today</div></div></div>
    <div class="rows">
      ${branches.map(b => `
        <div class="lrow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 18px;flex-wrap:wrap">
          <div style="font-size:13px;font-weight:600">${escapeHtml(b.branch_name)}</div>
          <div>${b.checks.map(pill).join('')}</div>
        </div>`).join('')}
    </div></div></div>`;
}

// ── On duty today: who's on shift right now, per branch, with contact ─────────
async function renderHomeOnDuty(containerId = 'hm-onduty') {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = HOME_CARD_SKELETON;
  let d;
  try { d = await API.get('/on-duty'); } catch (e) { box.innerHTML = ''; return; }
  const branches = (d && d.branches) || [];
  if (!branches.length) {
    box.innerHTML = `<div class="cc"><div class="board" style="margin-bottom:14px">
      <div class="bhead"><div class="bhrow"><div class="btitle">On duty today</div></div></div>
      <div class="rows"><div class="lrow" style="padding:12px 18px;color:var(--muted);font-size:13px">No one is scheduled on duty today.</div></div></div></div>`;
    return;
  }
  const total = branches.reduce((a, b) => a + b.staff.length, 0);
  box.innerHTML = `<div class="cc"><div class="board" style="margin-bottom:14px">
    <div class="bhead"><div class="bhrow"><div class="btitle">On duty today <span>${total} on shift</span></div></div></div>
    <div class="rows">
    ${branches.map(b => `
      <div style="padding:4px 0">
        <div style="font-weight:700;font-size:13px;padding:8px 18px 2px">${escapeHtml(b.branch_name)}</div>
        ${b.staff.map(onDutyRow).join('')}
      </div>`).join('')}
    </div>
  </div></div>`;
}

function onDutyRow(s) {
  const st = (typeof allShiftTypes !== 'undefined' && allShiftTypes)
    ? allShiftTypes.find(x => x.code === s.shift_code) : null;
  const color = st?.color || '#5B8DEF';   // functional: shift-type colour comes from data
  const badge = `<span style="display:inline-block;background:${color}1a;color:${color};font-size:11px;
    font-weight:700;padding:2px 8px;border-radius:9px">${escapeHtml(s.shift_code)}</span>`;
  const sec = s.section === 'US' ? 'US' : 'General';
  const phone = s.phone
    ? `<a href="tel:${encodeURIComponent(s.phone)}" style="color:var(--accent);text-decoration:none">${escapeHtml(s.phone)}</a>` : '';
  const tags = [sec, s.is_oncall ? 'On-call' : '', s.covering_at ? 'covering ' + escapeHtml(s.covering_at) : '']
    .filter(Boolean).join(' · ');
  return `<div class="lrow" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 18px">
      <div style="min-width:0">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.name)}</div>
        <div style="font-size:12px;color:var(--muted)">${tags}${phone ? ' · ' + phone : ''}</div>
      </div>
      ${badge}
    </div>`;
}
