// ── Home dashboard ────────────────────────────────────────────────────────────
// Clean overview centred on TODAY'S CASES, with a compact action strip.

function _greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

async function renderHomePage() {
  setTopbar('Home', 'Your overview at a glance');
  const today = new Date();
  const greg = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const date = (typeof operationalDate === 'function') ? operationalDate() : fmtDate(today);

  document.getElementById('content').innerHTML = `
    <div class="phero">
      <div class="phero-orb p1"></div><div class="phero-orb p2"></div>
      <div class="phero-inner">
        <div class="phero-logo"><img src="/meena_logo.png" alt="Meena"></div>
        <div class="phero-text">
          <div class="phero-hi">${_greeting()},</div>
          <div class="phero-title">${escapeHtml(currentUser?.username || '')}</div>
          <div class="phero-sub">${greg}</div>
        </div>
      </div>
    </div>
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
    <div id="hm-kpis" class="rep-kpis screen-kpis"></div>
    <div id="hm-actions" class="hm-actions"></div>
    <div id="hm-approvals"></div>
    <div class="hm-card">
      <div class="hm-card-head">
        <div class="hm-card-title">Today's cases</div>
        <div class="hm-card-meta" id="hm-cases-meta"></div>
      </div>
      <div class="home-bar"><div class="home-bar-fill" id="hm-bar" style="width:0%"></div></div>
      <div id="hm-cases-list" class="hm-branch-list">${LOADING_HTML}</div>
    </div>`;

  // Action counters (compact) + per-branch cases in parallel.
  const [dash, ov] = await Promise.all([
    API.get('/dashboard').catch(() => null),
    API.get(`/daily-cases/overview?date=${date}`).catch(() => null),
  ]);
  renderHomeKpis(dash, ov);
  renderHomeActions(dash);
  renderHomeCases(ov);
  if (['admin', 'manager', 'superadmin'].includes(currentUser?.role)) renderHomeApprovals();
  renderHomeRecent();
  _bindHomeSearchShortcut();
}

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
  const isReviewer = ['manager', 'superadmin'].includes(currentUser?.role);
  let leaves = [], tbs = [], swaps = [];
  try {
    [leaves, tbs, swaps] = await Promise.all([
      API.get('/leaves').catch(() => []),
      API.get('/timeback').catch(() => []),
      API.get('/swaps').catch(() => []),
    ]);
  } catch (e) { return; }

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

function renderHomeKpis(d, ov) {
  const box = document.getElementById('hm-kpis');
  if (!box) return;
  const s = (ov && ov.summary) || {};
  const branches = (ov && ov.branches) || [];
  const submitted = branches.filter(b => b.case && b.case.locked).length;
  const pending = d ? ((d.pending_reviews || 0) + (d.pending_leaves || 0) + (d.pending_swaps || 0) + (d.pending_registrations || 0)) : 0;
  const kpi = (cls, label, value, sub) => `
    <div class="rep-kpi">
      <div class="rep-kpi-top"><span class="rep-dot ${cls}"></span><span class="rep-kpi-label">${label}</span></div>
      <div class="rep-kpi-num">${value}</div>
      <div class="rep-kpi-sub">${escapeHtml(sub)}</div>
    </div>`;
  box.innerHTML =
    kpi('v', "Today's Cases", s.total_cases || 0, 'All branches') +
    kpi('v', 'Patients', s.total_pt || 0, 'Registered today') +
    kpi('v', 'Submitted', `${submitted}/${branches.length || 0}`, 'Branches reported') +
    kpi(pending ? 'r' : 'v', 'Pending', pending, 'Awaiting you');
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

function renderHomeCases(ov) {
  const list = document.getElementById('hm-cases-list');
  const meta = document.getElementById('hm-cases-meta');
  const bar  = document.getElementById('hm-bar');
  if (!ov || !list) { if (list) list.innerHTML = `<div class="hm-muted">Couldn't load today's cases.</div>`; return; }
  const branches = ov.branches || [];
  const s = ov.summary || {};
  const total = branches.length;
  const submitted = branches.filter(b => b.case && b.case.locked).length;
  const pct = total ? Math.round((submitted / total) * 100) : 0;
  if (bar) { bar.style.width = pct + '%'; bar.classList.toggle('done', total && submitted >= total); }
  if (meta) meta.innerHTML = `<b>${submitted}/${total}</b> submitted · ${s.total_cases || 0} cases · ${s.total_pt || 0} patients`;
  if (!total) { list.innerHTML = `<div class="hm-muted">No branches yet.</div>`; return; }
  list.innerHTML = branches.map(b => {
    const c = b.case, done = c && c.locked;
    return `<div class="hm-branch" onclick="showPage('cases')">
      <span class="hm-branch-name">${escapeHtml(b.branch_name)}</span>
      ${done
        ? `<span class="hm-branch-cases">${c.total_cases} cases · ${c.total_pt || 0} pt</span>
           <span class="hm-pill ok">Submitted</span>`
        : `<span class="hm-branch-cases hm-muted">—</span>
           <span class="hm-pill wait">Pending</span>`}
    </div>`;
  }).join('');
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
        </div>
        <div class="hm-sct">
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
