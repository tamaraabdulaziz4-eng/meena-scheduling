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
    <div id="hm-kpis" class="rep-kpis screen-kpis"></div>
    <div id="hm-actions" class="hm-actions"></div>
    <div id="hm-approvals"></div>
    <div class="hm-card">
      <div class="hm-card-head"><div class="hm-card-title">Find a staff member</div></div>
      <input id="hm-staff-q" type="search" placeholder="Search by name or employee ID…" autocomplete="off"
        oninput="homeStaffSearch(this.value)"
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-top:8px;font-family:inherit;font-size:13px">
      <div id="hm-staff-results" style="margin-top:10px"></div>
    </div>
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
function homeStaffSearch(term) {
  clearTimeout(_hmSearchTimer);
  const box = document.getElementById('hm-staff-results');
  const q = (term || '').trim();
  if (q.length < 2) { if (box) box.innerHTML = ''; return; }
  _hmSearchTimer = setTimeout(async () => {
    try {
      const r = await API.get(`/staff/search?q=${encodeURIComponent(q)}`);
      renderHomeStaffResults(r.results || []);
    } catch (e) { if (box) box.innerHTML = `<div class="hm-muted">${escapeHtml(e.message)}</div>`; }
  }, 220);
}

function renderHomeStaffResults(rows) {
  const box = document.getElementById('hm-staff-results');
  if (!box) return;
  if (!rows.length) { box.innerHTML = `<div class="hm-muted" style="padding:6px 2px">No matching staff.</div>`; return; }
  const stName = code => {
    if (!code) return '<span class="hm-muted">— off today</span>';
    if (['O','AL','SL','TB'].includes(code)) return `<span class="badge badge-gray">${code}</span>`;
    return `<span class="badge badge-green">${escapeHtml(code)}</span>`;
  };
  box.innerHTML = rows.map(s => `
    <div style="border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="font-weight:700;font-size:14px">${escapeHtml(s.name)}
          <span class="hm-muted" style="font-weight:500;font-size:12px">· ${escapeHtml(s.branch_name || '—')} · ${escapeHtml(s.section || '')}</span>
        </div>
        <div style="font-size:12px">Today: ${stName(s.today_shift)}</div>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--muted)">
        ${s.employee_id ? `<span>🆔 ${escapeHtml(s.employee_id)}</span>` : ''}
        ${s.phone ? `<span>📱 ${escapeHtml(s.phone)}</span>` : ''}
        ${s.email ? `<span>✉️ ${escapeHtml(s.email)}</span>` : ''}
        ${s.join_date ? `<span>📅 joined ${escapeHtml(s.join_date)}</span>` : ''}
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:12px">
        <span><b>${s.shifts_month}</b> shifts this month</span>
        <span><b>${s.leave_days_month}</b> leave days this month</span>
        <span><b>${(s.leave_balance ?? 0)}</b> days leave balance</span>
        <button class="action-btn" style="margin-left:auto" onclick="openStaffSchedule(${s.branch_id})">View rota →</button>
      </div>
    </div>`).join('');
}

// Jump to a branch's rota from a search result.
function openStaffSchedule(branchId) {
  if (branchId) window._pendingScheduleBranch = branchId;
  showPage('schedule');
}
