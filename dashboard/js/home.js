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

async function renderHomePage() {
  setTopbar('Home', 'Your overview at a glance');
  const today = new Date();
  const greg = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const c0 = _hmClockParts();

  document.getElementById('content').innerHTML = `
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
    <div id="hm-radstats"></div>
    <div id="hm-approvals"></div>
    <div class="hm-search">
      <div class="hm-searchbar">
        <span class="hm-search-ic">🔎</span>
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
    `;

  _hmStartClock();

  // Home is a lean, live operational snapshot: today's radiology across all
  // branches (auto-refreshing) + the manager's approval queue. On-duty, equipment
  // checks, and Employee-of-the-Month moved to their own pages (Schedule / Maintenance
  // / Staff); expiring-credentials and the duplicate count-chips were removed.
  if (['admin', 'manager', 'superadmin'].includes(currentUser?.role)) {
    renderHomeRadstats();
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
    box.innerHTML = `<div class="hm-card"><div class="hm-card-head"><div class="hm-card-title">Needs your approval</div></div>
      <div class="hm-muted" style="padding:6px 2px">You're all caught up 🎉</div></div>`;
    return;
  }
  const row = (left, right) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:13px">${left}</div><div style="font-size:12px">${right}</div></div>`;
  const section = (title, count, link, rows) => !count ? '' : `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
        <div style="font-weight:700;font-size:13px">${title} <span class="badge badge-orange">${count}</span></div>
        <button class="action-btn" onclick="showPage('${link}')">View all →</button>
      </div>
      ${rows}
    </div>`;

  const leaveRows = groups.slice(0, 5).map(g => {
    const span = g.date_to && g.date_to !== g.date_from ? `${fmtDateDisplay(g.date_from)}–${fmtDateDisplay(g.date_to)}` : fmtDateDisplay(g.date_from);
    return row(`<b>${escapeHtml(g.staff_name || '')}</b> · ${escapeHtml(g.leave_type)} · ${span} <span class="hm-muted">(${g.day_count}d)</span>`,
      `<button class="action-btn" onclick='homeApproveLeave(${JSON.stringify(g.ids)})'>✓ Approve</button>`);
  }).join('');
  const tbRows = tbPending.slice(0, 5).map(t => row(
    `<b>${escapeHtml(t.staff_name || '')}</b> · ${t.days}d · ${fmtDateDisplay(t.date)}`,
    `<button class="action-btn" onclick="homeApproveTimeback(${t.id})">✓ Approve</button>`)).join('');
  const swapRows = swapPending.slice(0, 5).map(s => row(
    `<b>${escapeHtml(s.staff_a_name || '')}</b> ↔ ${escapeHtml(s.staff_b_name || '?')} · ${fmtDateDisplay(s.date_a)}`,
    `<span class="badge badge-yellow">${escapeHtml(s.status.replace('pending_', 'awaiting '))}</span>`)).join('');

  box.innerHTML = `<div class="hm-card">
    <div class="hm-card-head"><div class="hm-card-title">Needs your approval</div></div>
    <div style="margin-top:6px">
      ${section('Leave requests', groups.length, 'leaves', leaveRows)}
      ${section('Time-back', tbPending.length, 'leaves', tbRows)}
      ${section('Shift swaps', swapPending.length, 'swaps', swapRows)}
    </div></div>`;
}

// ── Expiring credentials alert (team lead: own branch · manager: all) ─────────
async function renderHomeCredentials() {
  const box = document.getElementById('hm-credentials');
  if (!box) return;
  let d;
  try { d = await API.get('/credentials/expiring?days=60'); } catch (e) { box.innerHTML = ''; return; }
  const items = (d && d.items) || [];
  if (!items.length) { box.innerHTML = ''; return; }   // nothing expiring → no clutter
  const kindLabel = (k) => (typeof _credKindLabel === 'function' ? _credKindLabel(k) : (k || 'Other'));
  const statusOf = (n) => {
    n = Number(n);
    if (n < 0) return [`Expired ${Math.abs(n)}d ago`, '#E25555'];
    if (n === 0) return ['Expires today', '#E25555'];
    if (n <= 30) return [`${n}d left`, '#E2933F'];
    return [`${n}d left`, '#C9A227'];
  };
  const rows = items.slice(0, 8).map(r => {
    const [txt, col] = statusOf(r.days_left);
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:13px"><b>${escapeHtml(r.staff_name || '')}</b> · ${escapeHtml(kindLabel(r.kind))}${r.label ? ' · ' + escapeHtml(r.label) : ''} <span class="hm-muted">(${escapeHtml(r.expiry_date || '')})</span></div>
      <div style="font-size:12px;font-weight:700;color:${col}">${txt}</div></div>`;
  }).join('');
  box.innerHTML = `<div class="hm-card">
    <div class="hm-card-head">
      <div class="hm-card-title">Expiring credentials <span class="badge badge-orange">${items.length}</span></div>
      <button class="action-btn" onclick="showPage('reports')">Manage →</button>
    </div>
    <div style="margin-top:6px">${rows}</div></div>`;
}

// TODAY's radiology across all branches — the live centrepiece of the manager
// Home. Auto-refreshes so it reads as a real-time control room. A team lead is
// scoped to their own branch (fail-closed); managers/superadmin see all branches.
let _hmRadTimer = null;
function _hmKsaToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) { return new Date().toISOString().slice(0, 10); }
}
async function renderHomeRadstats() {
  const box = document.getElementById('hm-radstats');
  if (!box) { if (_hmRadTimer) { clearInterval(_hmRadTimer); _hmRadTimer = null; } return; }
  const isLead = currentUser?.role === 'admin';
  let site = null, scopeName = '';
  if (isLead && typeof rsMySite === 'function') {
    let mine = null;
    try { mine = await rsMySite(); } catch (e) {}
    if (mine) { site = mine.siteId; scopeName = currentUser?.branch_name || mine.shortName || mine.name; }
    else {
      // FAIL CLOSED — a team lead whose branch we can't resolve must NOT get an
      // unscoped (all-branch) query.
      box.innerHTML = `<div class="hm-card"><div class="hm-card-head"><div class="hm-card-title">Radiology</div></div>
        <div class="rs-loadnote" style="margin:8px 0 0;color:var(--muted)">Your branch isn't linked to the hospital system yet — ask an admin to link it.</div></div>`;
      return;
    }
  }
  if (!box.dataset.loaded) {
    const t = scopeName ? `Radiology today · ${escapeHtml(scopeName)}` : 'Radiology today · all branches';
    box.innerHTML = `<div class="hm-card"><div class="hm-card-head"><div class="hm-card-title">${t}</div></div>
      <div class="rs-loadnote" style="margin:8px 0 0"><span class="mini-spin"></span> Loading live data…</div></div>`;
  }
  await _hmRadFetch(site, scopeName);
  // Live auto-refresh; self-stops when the user leaves Home.
  if (_hmRadTimer) clearInterval(_hmRadTimer);
  _hmRadTimer = setInterval(() => {
    if (!document.getElementById('hm-radstats') || (typeof currentPage !== 'undefined' && currentPage !== 'home')) {
      clearInterval(_hmRadTimer); _hmRadTimer = null; return;
    }
    _hmRadFetch(site, scopeName);
  }, 90000);
}
async function _hmRadFetch(site, scopeName) {
  const box = document.getElementById('hm-radstats');
  if (!box) return;
  const today = _hmKsaToday();
  const q = `from=${today}&to=${today}${site ? `&sites=${site}` : ''}`;
  let d;
  try { d = await API.get(`/radiology/stats?${q}`); } catch (e) { return; }   // keep last-good on a blip
  if (!d || !d.ok) { if (!box.dataset.loaded) box.innerHTML = ''; return; }
  box.dataset.loaded = '1';
  const total = d.total || 0, emg = (d.priority && d.priority.emergency) || 0;
  const rtn = (d.priority && d.priority.routine) || 0;
  const top = (d.byBranch || []).filter(b => b.count > 0)[0];
  const upd = _hmClockParts();
  const title = scopeName ? `Radiology today · ${escapeHtml(scopeName)}` : 'Radiology today · all branches';
  const kpi = (n, l, cls) => `<div class="hm-rad-kpi${cls ? ' ' + cls : ''}"><b>${Number(n).toLocaleString()}</b><span>${l}</span></div>`;
  const tiles = [kpi(total, 'requests'), kpi(emg, 'emergency', emg ? 'warn' : ''), kpi(rtn, 'routine')];
  if (!site) tiles.push(`<div class="hm-rad-kpi"><b style="font-size:15px">${top ? escapeHtml(top.name || ('Branch ' + top.site)) : '—'}</b><span>busiest branch</span></div>`);
  box.innerHTML = `<div class="hm-card">
    <div class="hm-card-head">
      <div class="hm-card-title">${title}
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#2BAE66;box-shadow:0 0 0 3px rgba(43,174,102,.18);margin-left:6px;vertical-align:middle"></span></div>
      <button class="action-btn" onclick="showPage('radstats')">Open →</button>
    </div>
    <div class="hm-rad-kpis">${tiles.join('')}</div>
    <div style="font-size:11px;color:var(--muted);margin-top:8px">🟢 Live · updated ${upd.hm}:${upd.ss} Riyadh</div>
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

function renderHomeActions(d) {
  const box = document.getElementById('hm-actions');
  if (!box || !d) { if (box) box.innerHTML = ''; return; }
  const items = [];
  if (['manager', 'superadmin'].includes(d.role)) items.push(['Reviews', d.pending_reviews, 'review']);
  if (['manager', 'superadmin', 'admin'].includes(d.role)) {
    items.push(['Leave', d.pending_leaves, 'leaves']);
    items.push(['Registrations', d.pending_registrations || 0, 'staff']);
  }
  items.push(['Swaps', d.pending_swaps, 'swaps']);
  box.innerHTML = items.map(([label, n, link]) => `
    <button class="hm-chip${n > 0 ? ' on' : ''}" onclick="showPage('${link}')">
      <span class="hm-chip-n">${n}</span>
      <span class="hm-chip-l">${label}</span>
    </button>`).join('');
}

// ── Manager home: live staff lookup by name / employee ID ─────────────────────
let _hmSearchTimer = null;
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
  _hmSearchTimer = setTimeout(async () => {
    try {
      const r = await API.get(`/staff/search?q=${encodeURIComponent(q)}`);
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
          ${s.national_id ? `🪪 ${escapeHtml(s.national_id)} · ` : ''}${s.name_ar ? `${escapeHtml(s.name_ar)} · ` : ''}
          ${s.employee_id ? `🆔 ${escapeHtml(s.employee_id)}` : ''}
          ${s.phone ? ` · 📱 ${escapeHtml(s.phone)}` : ''}
          ${s.email ? ` · ✉️ ${escapeHtml(s.email)}` : ''}
          ${s.join_date ? ` · joined ${escapeHtml(s.join_date)}` : ''}
        </div>
        <div class="hm-chips">
          <span class="hm-chip2"><b>${s.shifts_month}</b> shifts this month</span>
          <span class="hm-chip2"><b>${s.leave_days_month}</b> leave days</span>
          <span class="hm-chip2"><b>${bal}</b> days balance</span>
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
    box.innerHTML = isReviewer ? `
      <div class="hm-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div><b>Employee of the Month</b>
          <span class="hm-muted" style="margin-left:6px">not set</span></div>
        <button class="btn btn-sm" onclick="openEotmModal()">Choose</button>
      </div>` : '';
    return;
  }
  const s = d.staff;
  box.innerHTML = `
    <div class="hm-card hm-eotm-card hm-eotm-filled">
      <div class="hm-eotm-shine"></div>
      <div class="hm-eotm-row">
        <div class="hm-eotm-medal">🏆</div>
        <div class="hm-eotm-main">
          <div class="hm-eotm-kicker">Employee of the Month${d.period ? ' · ' + escapeHtml(d.period) : ''}</div>
          <div class="hm-eotm-name">${escapeHtml(s.name)}</div>
          <div class="hm-muted" style="font-size:13px">${escapeHtml(s.branch_name || '')}</div>
          ${d.note ? `<div class="hm-eotm-note">“${escapeHtml(d.note)}”</div>` : ''}
        </div>
        ${isReviewer ? `<div class="hm-eotm-actions">
          <button class="btn btn-sm btn-ghost" onclick="openEotmModal()">Change</button>
          <button class="btn btn-sm btn-ghost" style="color:#E25555" onclick="clearEotm()">Clear</button>
        </div>` : ''}
      </div>
    </div>`;
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
    const color = done ? '#2BAE66' : '#E8A33D';
    const who = done && c.confirmed_by_name ? ` title="By ${escapeHtml(c.confirmed_by_name)}"` : '';
    return `<span${who} style="display:inline-block;background:${color}1a;color:${color};font-size:11px;
      font-weight:700;padding:2px 9px;border-radius:10px;margin-left:6px">${done ? '✓' : '○'} ${c.label}</span>`;
  };
  box.innerHTML = `<div class="hm-card">
    <div class="hm-card-head"><div class="hm-card-title">Equipment checks today</div></div>
    <div style="margin-top:6px">
      ${branches.map(b => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:13px;font-weight:600">${escapeHtml(b.branch_name)}</div>
          <div>${b.checks.map(pill).join('')}</div>
        </div>`).join('')}
    </div></div>`;
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
    box.innerHTML = `<div class="hm-card"><div class="hm-card-head"><div class="hm-card-title">On duty today</div></div>
      <div class="hm-muted" style="padding:6px 2px">No one is scheduled on duty today.</div></div>`;
    return;
  }
  const total = branches.reduce((a, b) => a + b.staff.length, 0);
  box.innerHTML = `<div class="hm-card">
    <div class="hm-card-head"><div class="hm-card-title">On duty today</div>
      <div class="hm-card-meta">${total} on shift</div></div>
    ${branches.map(b => `
      <div style="margin-top:8px">
        <div style="font-weight:700;font-size:13px;margin-bottom:4px">${escapeHtml(b.branch_name)}</div>
        ${b.staff.map(onDutyRow).join('')}
      </div>`).join('')}
  </div>`;
}

function onDutyRow(s) {
  const st = (typeof allShiftTypes !== 'undefined' && allShiftTypes)
    ? allShiftTypes.find(x => x.code === s.shift_code) : null;
  const color = st?.color || '#5B8DEF';
  const badge = `<span style="display:inline-block;background:${color}1a;color:${color};font-size:11px;
    font-weight:700;padding:2px 8px;border-radius:9px">${escapeHtml(s.shift_code)}</span>`;
  const sec = s.section === 'US' ? 'US' : 'General';
  const phone = s.phone
    ? `<a href="tel:${encodeURIComponent(s.phone)}" style="color:var(--accent);text-decoration:none">${escapeHtml(s.phone)}</a>` : '';
  const tags = [sec, s.is_oncall ? 'On-call' : '', s.covering_at ? 'covering ' + escapeHtml(s.covering_at) : '']
    .filter(Boolean).join(' · ');
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="min-width:0">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.name)}</div>
        <div style="font-size:12px;color:var(--muted)">${tags}${phone ? ' · ' + phone : ''}</div>
      </div>
      ${badge}
    </div>`;
}
