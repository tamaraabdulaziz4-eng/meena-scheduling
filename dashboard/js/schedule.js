// ── Schedule page ─────────────────────────────────────────────────────────────
let currentSchedule   = null;
let currentEntries    = [];   // flat array from server
let scheduleYear      = new Date().getFullYear();
let scheduleMonth     = new Date().getMonth() + 1;
let currentBranchId   = null;
let scheduleStaff     = [];   // staff for current branch
let entryMap          = {};   // "staffId_dateStr" → entry
// staffAllowedShifts removed: shift types are global, no per-staff filtering.
let staffMonthSettings  = {}; // staff_id → { min_shifts, max_shifts }

// Shift picker state
let pickerCell = null;


async function renderSchedulePage() {
  // Choose branch: a pending branch (e.g. opened from Review) wins; otherwise
  // a team lead sees their own branch, cross-branch roles default to the first.
  if (window._pendingScheduleBranch) {
    currentBranchId = window._pendingScheduleBranch;
    window._pendingScheduleBranch = null;
  } else {
    currentBranchId = currentUser.branch_id || (allBranches[0]?.id);
  }

  // If there are genuinely no branches yet, show a friendly note instead of
  // firing a request that would fail.
  if (!currentBranchId) {
    setTopbar('Schedule', '', '');
    document.getElementById('content').innerHTML =
      `<div class="empty"><div class="empty-icon">🏥</div><p>No branches available yet.</p></div>`;
    return;
  }

  setTopbar('Schedule', '', '');

  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Monthly staff rota', 'Schedule')}
    <div class="schedule-toolbar">
      ${['superadmin','manager'].includes(currentUser.role) ? `
        <select id="sched-branch-select" onchange="onBranchChange()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 12px;font-size:13px;background:var(--card-alt);color:var(--text);font-family:inherit;outline:none;cursor:pointer">
          ${allBranches.map(b => `<option value="${b.id}" ${b.id === currentBranchId ? 'selected' : ''}>${b.name}</option>`).join('')}
        </select>` : `<span style="font-size:14px;font-weight:700;color:var(--primary)">${currentUser.branch_name || 'My Branch'}</span>`}

      <div class="month-nav">
        <button onclick="changeMonth(-1)">&#8249;</button>
        <span class="month-label" id="month-label"></span>
        <button onclick="changeMonth(1)">&#8250;</button>
      </div>

      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${['admin','superadmin'].includes(currentUser.role) ? `
          <button class="btn btn-ghost btn-sm btn-glow" onclick="openGenerateModal()" id="btn-generate">⚡ Generate</button>
          <button class="btn btn-ghost btn-sm" onclick="openStaffSettingsModal()" id="btn-settings" title="Staff shift settings">⚙️ Settings</button>
        ` : ''}
        ${['superadmin','manager'].includes(currentUser.role) ? `
          <button class="btn btn-ghost btn-sm" onclick="openCoverModal()" id="btn-cover" title="Cover a day with a staff member from another branch">🔁 Cross-branch cover</button>
          <button class="btn btn-ghost btn-sm" onclick="openAutofillModal()" id="btn-autofill" title="Auto-fill this branch from surplus staff at same-city sharing branches">🏗 Fill from other branches</button>
        ` : ''}
        ${['admin','superadmin','manager'].includes(currentUser.role) ? `
          <button class="btn btn-ghost btn-sm" onclick="exportXLSX()">📥 Export XLSX</button>
          <button class="btn btn-ghost btn-sm" onclick="exportPDF()">📄 Export PDF</button>
        ` : ''}
        <button class="btn btn-ghost btn-sm" onclick="printSchedule()">🖨 Print</button>
      </div>
    </div>

    <div id="schedule-status-bar" style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap"></div>

    <div id="tl-status-banner-wrap"></div>

    <div class="stats-row" id="schedule-stats"></div>

    <div class="rota-wrap" id="rota-wrap">${LOADING_HTML}</div>

    <div class="legend" id="shift-legend" style="margin-top:20px"></div>`;

  document.getElementById('month-label').textContent = monthLabel(scheduleYear, scheduleMonth);
  await loadScheduleData();
}

async function onBranchChange() {
  const sel = document.getElementById('sched-branch-select');
  currentBranchId = Number(sel.value);
  await loadScheduleData();
  animateIn('rota-wrap');
}

async function changeMonth(delta) {
  // Any modal/overlay left open (settings, generate diagnostics, shift picker)
  // would otherwise stay as a dark dimming layer over the new month — looking
  // like a "black screen" / frozen page. Clear them before we switch.
  dismissScheduleOverlays();
  scheduleMonth += delta;
  if (scheduleMonth > 12) { scheduleMonth = 1; scheduleYear++; }
  if (scheduleMonth < 1)  { scheduleMonth = 12; scheduleYear--; }
  document.getElementById('month-label').textContent = monthLabel(scheduleYear, scheduleMonth);
  await loadScheduleData();
  animateIn('rota-wrap');
}

// Hide any open schedule modal/picker overlays and the busy loaders. Used when
// changing month/branch so a stuck overlay can't leave the page dark or
// unclickable (the reported "hangs / goes black on month change").
function dismissScheduleOverlays() {
  ['staff-settings-modal', 'generate-diagnostics-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  if (typeof closePicker === 'function') { try { closePicker(); } catch (_) {} }
  if (typeof hideLoader === 'function') { try { hideLoader(); } catch (_) {} }
}

function printSchedule() {
  const wrap = document.getElementById('rota-wrap');
  if (!wrap || !wrap.querySelector('table')) { toast('Nothing to export yet'); return; }
  openReport(buildScheduleReport(), true);   // landscape
}

function buildScheduleReport() {
  const branch = ['superadmin', 'manager'].includes(currentUser?.role)
    ? (allBranches.find(b => b.id === currentBranchId)?.name || '')
    : (currentUser?.branch_name || '');
  const sc = currentSchedule || {};
  const cap = v => v ? String(v).charAt(0).toUpperCase() + String(v).slice(1) : '—';
  const wrap = document.getElementById('rota-wrap');
  const rotaHtml = wrap ? wrap.innerHTML : '';
  const legend = document.querySelector('.legend');
  const legendHtml = legend ? legend.outerHTML : '';
  const staffCount = wrap ? wrap.querySelectorAll('.rota-table tbody tr').length : 0;
  const days = new Date(scheduleYear, scheduleMonth, 0).getDate();
  const approved = sc.status === 'approved';
  const printed = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  const kpi = (cls, label, value, sub) => `
    <div class="rep-kpi">
      <div class="rep-kpi-top"><span class="rep-dot ${cls}"></span><span class="rep-kpi-label">${label}</span></div>
      <div class="rep-kpi-num">${value}</div>
      <div class="rep-kpi-sub">${escapeHtml(sub || '')}</div>
    </div>`;

  return `
    ${reportHeader('Monthly Roster', `${branch} · ${monthLabel(scheduleYear, scheduleMonth)}`)}
    <div class="rep-kpis">
      ${kpi('v', 'Branch', escapeHtml(branch || '—'), 'This roster')}
      ${kpi('v', 'Staff', staffCount, 'On the rota')}
      ${kpi('v', 'Days', days, monthLabel(scheduleYear, scheduleMonth))}
      ${kpi(approved ? 'v' : 'r', 'Status', approved ? 'Approved' : (sc.status || 'Draft'), `Printed ${printed}`)}
    </div>
    <div class="rep-card rep-rota">${rotaHtml}${legendHtml}</div>
    <div class="rep-sign-row">
      <div class="rep-sign">
        <div class="rep-sign-role">Prepared by</div>
        <div class="rep-sign-name">${escapeHtml(cap(sc.created_by_name))}</div>
        <div class="rep-sign-line">Team Lead</div>
      </div>
      <div class="rep-sign">
        <div class="rep-sign-role">Approved by</div>
        <div class="rep-sign-name">${sc.approved_by_name ? escapeHtml(cap(sc.approved_by_name)) : '—'}</div>
        <div class="rep-sign-line">Manager</div>
      </div>
      <div class="rep-sign-stamp ${approved ? 'approved' : 'pending'}">${approved ? '✔ APPROVED' : (sc.status || 'DRAFT').toUpperCase()}</div>
    </div>`;
}

let _scheduleLoadToken = 0;
async function loadScheduleData() {
  // Guard against overlapping loads: clicking the month arrows quickly fires
  // several loads at once, and whichever HTTP response lands LAST would win —
  // even if it's for an older month — leaving the grid stuck on stale data
  // (the reported "hangs when I change the month"). Only the newest load is
  // allowed to mutate state and render.
  const token = ++_scheduleLoadToken;
  // Animated inline loader (no dimming overlay) while the month/branch loads.
  const wrap = document.getElementById('rota-wrap');
  if (wrap) wrap.innerHTML = LOADING_HTML;
  try {
    // These four requests don't depend on each other, so fire them in parallel
    // instead of awaiting one after another — much faster, especially on a
    // cold Railway start.
    const [staffData, schedData, , monthSettings, , secSettings] = await Promise.all([
      API.get(`/staff?branch_id=${currentBranchId}`),
      API.post('/schedules/open', { branch_id: currentBranchId, year: scheduleYear, month: scheduleMonth }),
      loadShiftTypes(currentBranchId),
      API.get(`/staff-month-settings?branch_id=${currentBranchId}&year=${scheduleYear}&month=${scheduleMonth}`)
        .catch(() => ({})),
      (typeof loadHolidaysForMonth === 'function'
        ? loadHolidaysForMonth(scheduleYear, scheduleMonth) : Promise.resolve()),
      // Per-section coverage requirements (min M / min N) drive the coverage row,
      // which differs between General (24h) and Ultrasound (often daytime only).
      API.get(`/section-month-settings?branch_id=${currentBranchId}&year=${scheduleYear}&month=${scheduleMonth}`)
        .catch(() => ({})),
    ]);

    // A newer load started while we were awaiting — drop this stale result.
    if (token !== _scheduleLoadToken) return;

    sectionMonthSettings = secSettings || {};
    scheduleStaff   = staffData.filter(s => s.active);
    currentSchedule = schedData.schedule;
    currentEntries  = schedData.entries;
    buildEntryMap();
    staffMonthSettings = monthSettings || {};

    renderScheduleStatusBar();
    renderTeamLeadBanner();
    renderShiftLegend();
    renderScheduleStats();
    renderRotaGrid();
  } catch (err) {
    if (token !== _scheduleLoadToken) return;
    document.getElementById('rota-wrap').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠️</div><p>${escapeHtml(err.message)}</p></div>`;
  }
}

function buildEntryMap() {
  entryMap = {};
  for (const e of currentEntries) {
    const dateStr = e.date ? e.date.slice(0,10) : '';
    entryMap[`${e.staff_id}_${dateStr}`] = e;
  }
}

// ── Team-lead submission status banner ────────────────────────────────────────
function renderTeamLeadBanner() {
  const wrap = document.getElementById('tl-status-banner-wrap');
  if (!wrap || !currentSchedule) return;
  const status = currentSchedule.status || 'draft';
  const note   = currentSchedule.review_note;
  const sid    = currentSchedule.id;
  // Reviewers (manager / full admin) don't submit/withdraw — they use the
  // Review page and can edit directly — so skip the team-lead banner for them.
  const isReviewer = ['superadmin','manager'].includes(currentUser?.role);
  if (isReviewer) { wrap.innerHTML = ''; return; }

  // When the schedule is locked, disable editing tools so the team lead can't
  // try actions the server will reject anyway. A schedule is "locked" either
  // because it's in the review pipeline (submitted/reviewed/approved) OR because
  // someone hit the manual 🔒 toggle while it was still a draft/returned. Both
  // cases block Generate server-side, so both must disable the button — otherwise
  // the user clicks Generate, gets a "withdraw it first" error, and finds no
  // Withdraw button to use.
  const lockedForReview = ['submitted','reviewed','approved'].includes(status);
  const manuallyLocked  = !!currentSchedule.is_locked && !lockedForReview;
  const editingLocked   = lockedForReview || manuallyLocked;
  const genBtn = document.getElementById('btn-generate');
  const setBtn = document.getElementById('btn-settings');
  [genBtn, setBtn].forEach(b => {
    if (!b) return;
    b.disabled = editingLocked;
    b.style.opacity = editingLocked ? '0.45' : '';
    b.style.pointerEvents = editingLocked ? 'none' : '';
  });

  let html = '';
  if (manuallyLocked) {
    // Draft/returned but manually locked: Generate is blocked but there's no
    // review step to withdraw from — surface an Unlock action instead.
    html = `
      <div class="tl-status-banner warn">
        <div class="ico" style="background:rgba(243,156,18,.15)">🔒</div>
        <div style="flex:1">
          <div class="ttl">Schedule locked</div>
          <div class="sub">This schedule is manually locked, so it can't be generated or edited. Unlock it to make changes.</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="toggleScheduleLock()">🔓 Unlock</button>
      </div>`;
  } else if (status === 'draft' || status === 'returned') {
    const returned = status === 'returned';
    html = `
      <div class="tl-status-banner ${returned ? 'err' : ''}">
        <div class="ico" style="background:${returned ? 'rgba(255,107,107,.15)' : 'rgba(133,133,168,.15)'}">${returned ? '↩' : '📝'}</div>
        <div style="flex:1">
          <div class="ttl">${returned ? 'Returned for edits' : 'Draft — not submitted yet'}</div>
          <div class="sub">${returned && note ? 'Manager note: ' + escapeHtml(note) : 'Finish the rota, then send it to your manager for review.'}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="submitScheduleForReview(${sid})"
          style="background:linear-gradient(135deg,var(--accent2),var(--accent));color:#fff;font-weight:700">
          📤 Submit for review
        </button>
      </div>`;
  } else if (status === 'submitted') {
    // Manager hasn't acted yet — the team lead can still pull it back.
    html = `
      <div class="tl-status-banner warn">
        <div class="ico" style="background:rgba(255,159,67,.15)">⏳</div>
        <div style="flex:1">
          <div class="ttl">Pending manager review</div>
          <div class="sub">The schedule is locked until the manager reviews it.</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="withdrawSchedule(${sid})">↩ Withdraw</button>
      </div>`;
  } else if (status === 'reviewed') {
    // Manager has already reviewed it — only the manager can reopen it now.
    html = `
      <div class="tl-status-banner warn">
        <div class="ico" style="background:rgba(255,159,67,.15)">👀</div>
        <div style="flex:1">
          <div class="ttl">Reviewed by manager — locked</div>
          <div class="sub">${note ? 'Manager note: ' + escapeHtml(note) : 'To make changes, ask your manager to return the schedule.'}</div>
        </div>
      </div>`;
  } else if (status === 'approved') {
    html = `
      <div class="tl-status-banner ok">
        <div class="ico" style="background:rgba(0,200,150,.15)">✓</div>
        <div style="flex:1">
          <div class="ttl" style="color:#009B74">Approved — locked</div>
          <div class="sub">${note ? 'Manager note: ' + escapeHtml(note) : 'This schedule is approved. To make changes, ask your manager to return it.'}</div>
        </div>
      </div>`;
  }
  wrap.innerHTML = html;
}

async function submitScheduleForReview(scheduleId) {
  // Don't submit an empty rota — count assigned work shifts first.
  const hasShifts = currentEntries?.some(e => !['O','AL','SL','TB'].includes(e.shift_code));
  if (!hasShifts) {
    toast('Add shifts before submitting for review', 'err');
    return;
  }
  const ok = await showConfirm(
    'Submit for review',
    'Send this schedule to your manager? It will be locked until reviewed.',
    'Submit'
  );
  if (!ok) return;
  showLoader('Submitting…');
  try {
    await API.put(`/schedules/${scheduleId}/status`, { status: 'submitted' });
    await loadScheduleData();
    toast('Submitted for review');
  } catch (e) { toast(e.message, 'err'); }
  finally { hideLoader(); }
}
async function withdrawSchedule(scheduleId) {
  showLoader('Withdrawing…');
  try {
    await API.put(`/schedules/${scheduleId}/status`, { status: 'draft' });
    await loadScheduleData();
    toast('Withdrawn — back to draft');
  } catch (e) { toast(e.message, 'err'); }
  finally { hideLoader(); }
}


function renderScheduleStatusBar() {
  const bar = document.getElementById('schedule-status-bar');
  if (!bar || !currentSchedule) return;
  const s = currentSchedule;
  const isAdmin = ['admin','superadmin'].includes(currentUser?.role);
  const isReviewer = ['superadmin','manager'].includes(currentUser?.role);

  bar.innerHTML = `
    ${isAdmin ? `
      <button onclick="toggleScheduleLock()"
        style="font-size:11px;padding:3px 12px;border-radius:20px;border:none;cursor:pointer;font-weight:600;
               background:${s.is_locked ? '#f39c12' : '#dfe6e9'};color:${s.is_locked ? '#fff' : '#636e72'}"
        title="${s.is_locked ? 'Click to unlock' : 'Click to lock'}">
        ${s.is_locked ? '🔒 Locked' : '🔓 Unlocked'}
      </button>` : `
      <span style="font-size:11px;font-weight:600;color:${s.is_locked ? '#e17055' : ''}">
        ${s.is_locked ? '🔒 Locked' : ''}
      </span>`}
    ${(isReviewer && s.is_locked) ? `<span style="font-size:11px;font-weight:600;color:var(--accent)">✎ You can edit this as a manager</span>` : ''}
    ${s.created_by_name ? `<span style="font-size:11px;color:var(--muted)">Created by: <strong>${s.created_by_name}</strong></span>` : ''}
  `;
}

function renderShiftLegend() {
  const leg = document.getElementById('shift-legend');
  if (!leg) return;

  // Show all shift types available for this branch (not just used ones)
  const workShifts   = allShiftTypes.filter(st => !st.is_off && !st.is_leave && !st.is_oncall && st.code !== 'O');
  const statusShifts = allShiftTypes.filter(st => (st.is_leave || st.is_oncall) && st.code !== 'O');

  function cellText(st) {
    const t = (st.start_time && st.end_time) ? `(${fmt12(st.start_time)} - ${fmt12(st.end_time)})` : null;
    return t ? `${st.code}: ${t}` : st.label;
  }

  function colorStyle(st) {
    // Subtle tinted background using the shift color
    return `style="color:${st.color};background:${st.color}18"`;
  }

  // Build rows: pair work shifts into left/right columns (fill left first then right)
  const half = Math.ceil(workShifts.length / 2);
  const leftCol  = workShifts.slice(0, half);
  const rightCol = workShifts.slice(half);

  // Pad right col to same length
  while (rightCol.length < leftCol.length) rightCol.push(null);

  const workRows = leftCol.map((l, i) => {
    const r = rightCol[i];
    return `<tr>
      <td class="leg-cell" ${colorStyle(l)}>${cellText(l)}</td>
      <td class="leg-cell" ${r ? colorStyle(r) : ''}>${r ? cellText(r) : ''}</td>
    </tr>`;
  }).join('');

  const statusRows = statusShifts.map(st => {
    return `<tr>
      <td class="leg-cell leg-status" colspan="2" style="color:${st.color};background:${st.color}18;text-align:center;font-weight:700">${st.code} (${st.label})</td>
    </tr>`;
  }).join('');

  leg.innerHTML = `
    <table class="legend-table">
      <tbody>
        ${workRows}
        ${statusRows}
      </tbody>
    </table>`;
}

function renderScheduleStats() {
  const bar = document.getElementById('schedule-stats');
  if (!bar) return;
  const total    = scheduleStaff.length;
  const nDays    = daysInMonth(scheduleYear, scheduleMonth);
  const working  = Object.values(entryMap).filter(e => !['O','AL','SL','TB','OC'].includes(e.shift_code) && !e.is_oncall).length;
  const onCall   = Object.values(entryMap).filter(e => e.is_oncall || e.shift_code === 'OC').length;
  const leaves   = Object.values(entryMap).filter(e => ['AL','SL','TB'].includes(e.shift_code)).length;

  const icoStaff = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>';
  const icoDays  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
  const icoShift = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
  const icoCall  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
  const icoLeaf  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

  // Hijri month span for this Gregorian month (e.g. "Dhuʻl-Q. – Dhuʻl-H. 1447").
  let hijriPill = '';
  if (typeof _hijriFullFmt !== 'undefined' && _hijriFullFmt) {
    const part = (d) => new Intl.DateTimeFormat('en-u-ca-islamic-umalqura',{month:'short'}).format(new Date(scheduleYear, scheduleMonth-1, d));
    const yr   = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura',{year:'numeric'}).format(new Date(scheduleYear, scheduleMonth-1, 15));
    const m1 = part(1), m2 = part(nDays);
    const span = (m1 === m2) ? m1 : `${m1}–${m2}`;
    hijriPill = `<div class="stat-pill" title="Hijri (Umm al-Qura)">🌙 <strong>${span} ${yr}</strong></div>`;
  }

  bar.innerHTML = `
    <div class="stat-pill">${icoStaff} <strong data-count="${total}">0</strong> staff</div>
    <div class="stat-pill">${icoDays} <strong data-count="${nDays}">0</strong> days</div>
    <div class="stat-pill">${icoShift} <strong data-count="${working}">0</strong> shifts assigned</div>
    <div class="stat-pill">${icoCall} <strong data-count="${onCall}">0</strong> on-call</div>
    <div class="stat-pill">${icoLeaf} <strong data-count="${leaves}">0</strong> leaves</div>
    ${hijriPill}`;

  // Animate each number counting up
  bar.querySelectorAll('strong[data-count]').forEach(el => countUp(el, parseInt(el.dataset.count) || 0));
}

// ── Rota Grid ─────────────────────────────────────────────────────────────────
function renderRotaGrid() {
  const wrap = document.getElementById('rota-wrap');
  if (!wrap) return;

  const nDays   = daysInMonth(scheduleYear, scheduleMonth);
  const isLocked = !!currentSchedule?.is_locked;
  // Reviewers (manager / full admin) are the authority on a schedule — the lock
  // exists to stop the team lead changing it mid-review, not the manager. So a
  // reviewer can still edit cells directly even when the schedule is locked.
  const isReviewer = ['superadmin','manager'].includes(currentUser?.role);

  // Group staff: General first, then US
  const generalStaff = scheduleStaff.filter(s => !s.speciality?.includes('Ultrasound') || s.speciality?.includes('General'));
  const usStaff      = scheduleStaff.filter(s => s.speciality?.includes('Ultrasound') && !s.speciality?.includes('General'));
  // If everyone is general, show no section split
  const hasBothSections = usStaff.length > 0 && generalStaff.length > 0;

  let html = `<table class="rota-table" id="rota-table">
    <thead>
      <tr>
        <th class="rota-name-col" rowspan="2" style="min-width:160px">Name</th>
        ${Array.from({length:nDays},(_,i)=>{
          const d = i+1;
          const dow = dayOfWeek(scheduleYear, scheduleMonth, d);
          const dateStr = `${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const holiday = (typeof holidayMap !== 'undefined') ? holidayMap[dateStr] : null;
          const hij = (typeof hijriFull === 'function') ? hijriFull(scheduleYear, scheduleMonth, d) : '';
          const isToday = d===new Date().getDate()&&scheduleMonth===new Date().getMonth()+1&&scheduleYear===new Date().getFullYear();
          const title = [hij, holiday ? ('🎌 ' + holiday) : ''].filter(Boolean).join(' — ');
          const bg = holiday ? 'background:rgba(255,107,107,0.18);' : (dow===5?'background:rgba(107,78,255,0.12);':'');
          return `<th title="${escapeHtml(title)}" style="${bg}${isToday?'border-bottom:2px solid var(--accent);':''}${holiday?'border-top:2px solid #FF6B6B;':''}">${d}${holiday?'<span style="color:#FF6B6B">•</span>':''}</th>`;
        }).join('')}
        <th style="min-width:60px">Shifts</th>
      </tr>
      <tr>
        ${Array.from({length:nDays},(_,i)=>{
          const dow = dayOfWeek(scheduleYear, scheduleMonth, i+1);
          const isWeekend = dow===5;
          return `<th style="font-size:8px;font-weight:700;color:${isWeekend?'var(--accent)':'var(--muted)'};padding:2px;${isWeekend?'background:rgba(107,78,255,0.1);':''}">${DAYS[dow]}</th>`;
        }).join('')}
        <th></th>
      </tr>
    </thead>
    <tbody id="rota-tbody">`;

  function staffRows(staffArr, section) {
    let rows = '';
    if (hasBothSections && section) {
      rows += `<tr class="rota-section-row"><td colspan="${nDays+2}">${section}</td></tr>`;
    }
    staffArr.forEach(s => {
      let shiftCount = 0;
      const cells = Array.from({length:nDays},(_,i)=>{
        const d      = i+1;
        const dow    = dayOfWeek(scheduleYear, scheduleMonth, d);
        const dateStr = `${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const entry   = entryMap[`${s.id}_${dateStr}`];
        const isBlank = !entry;
        const code    = entry?.shift_code || '';
        const st      = code ? (allShiftTypes.find(x => x.code === code) || { color: '#D0D0D0', is_off: false, is_leave: false }) : null;
        const isOC    = entry?.is_oncall;
        const isCross = entry?.cross_branch_id;
        if (st && !st.is_off && !st.is_leave) shiftCount++;

        const bgColor  = isBlank ? '#000000' : (st?.color || '#D0D0D0');
        const txtColor = isBlank ? '#000000' : contrastColor(bgColor);
        const weekend  = dow===5 ? 'rgba(107,78,255,0.04)' : '';

        const cellReadonly = isLocked && !isReviewer;
        const classes = ['rota-cell', cellReadonly?'readonly':'', isBlank?'blank-cell':''].filter(Boolean).join(' ');
        return `<td class="${classes}"
          data-staff="${s.id}" data-date="${dateStr}" data-code="${code}"
          onclick="${cellReadonly?'':'cellClick(this)'}"
          style="background:${bgColor};${weekend?`outline:1px solid rgba(107,78,255,0.15);`:''}"
          title="${s.name} — ${dateStr}${code ? ': '+code : ' (blank)'}${isOC?' + OC':''}${isCross?' (cross)':''}">
          <div class="shift-chip${isOC?' has-oc':''}${isCross?' cross':''}" style="color:${txtColor}">
            ${isBlank ? '' : code}${isCross?'<sup style="font-size:7px">↗</sup>':''}
          </div>
        </td>`;
      }).join('');
      rows += `<tr>
        <td class="rota-name-col" style="padding:4px 8px !important;white-space:nowrap">
          <span style="font-weight:600;font-size:12px">${s.name}${s.is_cross_branch?'<sup title="Cross-branch">↗</sup>':''}</span>
        </td>
        ${cells}
        <td style="text-align:center;font-weight:700;font-size:12px;color:var(--primary)">${shiftCount}</td>
      </tr>`;
    });
    return rows;
  }

  if (hasBothSections) {
    // Each section gets its OWN coverage row against its OWN requirements —
    // General and Ultrasound don't have the same M/N needs.
    html += staffRows(generalStaff, 'General Radiology');
    html += coverageRow(nDays, generalStaff, 'General', sectionReqByName('General'));
    html += staffRows(usStaff, 'Ultrasound (US)');
    html += coverageRow(nDays, usStaff, 'US', sectionReqByName('US'));
  } else {
    html += staffRows(scheduleStaff, '');
    const onlyKey = usStaff.length ? 'US' : 'General';
    html += coverageRow(nDays, scheduleStaff, onlyKey, sectionReqByName(onlyKey));
  }

  // Cross-branch cover: staff from OTHER branches placed on this rota show up as
  // entries whose staff_id isn't one of this branch's staff. Render them in
  // their own section so the covered days are visible here too.
  html += visitorRows(nDays);

  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

// Rows for visiting (cross-branch) cover staff on this rota.
function visitorRows(nDays) {
  const ownIds = new Set(scheduleStaff.map(s => s.id));
  const visitors = {};   // staff_id → { name, home }
  for (const e of (currentEntries || [])) {
    if (ownIds.has(e.staff_id)) continue;
    if (!visitors[e.staff_id]) visitors[e.staff_id] = { name: e.staff_name || `#${e.staff_id}`, home: e.cross_branch_name || '' };
  }
  const ids = Object.keys(visitors);
  if (!ids.length) return '';

  const isReviewer = ['superadmin', 'manager'].includes(currentUser?.role);
  let rows = `<tr class="rota-section-row"><td colspan="${nDays + 2}">🔁 Cross-branch Cover</td></tr>`;
  for (const sid of ids) {
    const v = visitors[sid];
    let shiftCount = 0;
    const cells = Array.from({ length: nDays }, (_, i) => {
      const d = i + 1;
      const dateStr = `${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const entry = entryMap[`${sid}_${dateStr}`];
      const code = entry?.shift_code || '';
      const st = code ? (allShiftTypes.find(x => x.code === code) || { color: '#D0D0D0', is_off: false, is_leave: false }) : null;
      if (st && !st.is_off && !st.is_leave) shiftCount++;
      const bg = code ? (st?.color || '#D0D0D0') : 'transparent';
      const txt = code ? contrastColor(bg) : 'inherit';
      const removable = isReviewer && !!entry;
      return `<td class="rota-cell" style="background:${bg};position:relative"
        title="${escapeHtml(v.name)} (from ${escapeHtml(v.home || 'another branch')}) — ${dateStr}${code ? ': ' + code : ''}">
        <div class="shift-chip" style="color:${txt}">${code || ''}</div>
        ${removable ? `<span onclick="removeCover(${sid},'${dateStr}')" title="Remove cover"
          style="position:absolute;top:-1px;right:1px;font-size:9px;color:#E63946;cursor:pointer;font-weight:800">×</span>` : ''}
      </td>`;
    }).join('');
    rows += `<tr>
      <td class="rota-name-col" style="padding:4px 8px !important;white-space:nowrap">
        <span style="font-weight:600;font-size:12px">${escapeHtml(v.name)}</span>
        <sup title="From ${escapeHtml(v.home)}" style="color:var(--accent,#6B4EFF)">↗ ${escapeHtml(v.home || '')}</sup>
      </td>
      ${cells}
      <td style="text-align:center;font-weight:700;font-size:12px;color:var(--primary)">${shiftCount}</td>
    </tr>`;
  }
  return rows;
}
// from the per-month section settings. Falls back to 24h (1 M + 1 N) when a
// section has no explicit settings yet.
function sectionReqByName(name) {
  const want = String(name || '').toUpperCase();
  const isUS = want === 'US' || want === 'ULTRASOUND';
  for (const sec of Object.values(sectionMonthSettings || {})) {
    const sn = String(sec.section_name || '').toUpperCase();
    const secIsUS = sn === 'US' || sn === 'ULTRASOUND';
    if (sn === want || (isUS && secIsUS)) {
      return { min_m: sec.min_m ?? 1, min_n: sec.min_n ?? 1 };
    }
  }
  return { min_m: 1, min_n: 1 };
}

// ── Section coverage check row ────────────────────────────────────────────────
// Per section, verify each day meets THAT section's daily requirement: at least
// `min_m` morning(s) and `min_n` night(s) among the section's own staff. This is
// section-specific because General (24h: needs nights) and Ultrasound (often
// daytime only, min_n=0) don't share the same requirement. A section with
// min_n=0 is judged on mornings alone — no false "missing night" flags.
function coverageRow(nDays, staffArr, sectionKey, req) {
  const minM = Math.max(0, parseInt(req?.min_m ?? 1) || 0);
  const minN = Math.max(0, parseInt(req?.min_n ?? 1) || 0);
  const needsNight = minN >= 1;
  const label = needsNight ? '24h Coverage' : 'Day Coverage';
  const secName = sectionKey === 'US' ? 'Ultrasound' : (sectionKey || '');

  let cells = '';
  for (let i = 0; i < nDays; i++) {
    const d       = i + 1;
    const dateStr = `${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    // Count M and N among THIS section's staff for this day
    let mCount = 0, nCount = 0;
    staffArr.forEach(s => {
      const code = entryMap[`${s.id}_${dateStr}`]?.shift_code;
      if (code === 'M') mCount++;
      else if (code === 'N') nCount++;
    });

    const hasM = mCount >= minM;
    const hasN = !needsNight || nCount >= minN;
    const covered = hasM && hasN;

    let marker, color, title;
    if (covered) {
      marker = '✓';
      color  = '#00C896';
      title  = `Day ${d}${secName ? ' · ' + secName : ''}: covered (M:${mCount}/${minM}${needsNight ? ` · N:${nCount}/${minN}` : ' · no night needed'})`;
    } else {
      marker = '✕';
      color  = '#E63946';
      const missing = [];
      if (!hasM) missing.push(`M (need ${minM}, have ${mCount})`);
      if (!hasN) missing.push(`N (need ${minN}, have ${nCount})`);
      title  = `Day ${d}${secName ? ' · ' + secName : ''}: NOT covered — short ${missing.join(' + ')}`;
    }

    cells += `<td style="text-align:center;padding:3px 0;background:${covered?'rgba(0,200,150,0.10)':'rgba(230,57,70,0.18)'}"
      title="${title}">
      <span style="font-weight:800;font-size:12px;color:${color}">${marker}</span>
    </td>`;
  }

  return `<tr class="rota-coverage-row" style="border-top:2px solid var(--accent)">
    <td class="rota-name-col" style="padding:4px 8px !important;white-space:nowrap;font-weight:700;font-size:11px;color:var(--muted)">
      ${secName ? secName + ' — ' : ''}${label}
    </td>
    ${cells}
    <td></td>
  </tr>`;
}

// ── Cell click → shift picker ─────────────────────────────────────────────────
function cellClick(cell) {
  const isReviewer = ['superadmin','manager'].includes(currentUser?.role);
  // A lock blocks the team lead, but a reviewer can always edit (see renderRotaGrid).
  if (currentSchedule?.is_locked && !isReviewer) return;
  if (!['admin','superadmin','manager'].includes(currentUser?.role)) return;

  // If picker already open for this cell, close it (toggle)
  if (pickerCell === cell && document.getElementById('shift-picker').style.display === 'grid') {
    closePicker();
    return;
  }


  pickerCell = cell;
  const picker = document.getElementById('shift-picker');

  const visibleShifts = allShiftTypes;

  picker.innerHTML = visibleShifts.map(st => `
    <div class="shift-picker-item"
      style="background:${st.color};color:${contrastColor(st.color)}"
      onclick="applyShift('${st.code}')" title="${st.label}">
      ${st.code}
    </div>`).join('') +
    // On-call toggle
    `<div class="shift-picker-item" style="background:#FF6B6B;color:white;font-size:9px" onclick="toggleOnCall()" title="Toggle On-Call">+OC</div>` +
    // Blank/clear cell
    `<div class="shift-picker-item" style="background:#f0f0f0;color:#666;font-size:9px;border:1px dashed #aaa" onclick="clearCell()" title="Clear cell (leave blank)">✕ blank</div>`;

  // Position near cell using fixed coordinates (getBoundingClientRect already gives viewport coords)
  const rect = cell.getBoundingClientRect();
  const pickerW = 250;
  const pickerH = 160;
  let top  = rect.bottom + 4;
  let left = rect.left;

  // Flip up if too close to bottom
  if (top + pickerH > window.innerHeight) top = rect.top - pickerH - 4;
  // Clamp to right edge
  if (left + pickerW > window.innerWidth) left = window.innerWidth - pickerW - 8;
  // Clamp to left edge
  if (left < 4) left = 4;

  picker.style.position = 'fixed';
  picker.style.top      = `${top}px`;
  picker.style.left     = `${left}px`;
  picker.style.display  = 'grid';

  // Remove any previous outside-click listener before adding new one
  document.removeEventListener('click', closePicker);
  // Delay so this same click event doesn't immediately trigger closePicker
  setTimeout(() => {
    document.addEventListener('click', closePicker, { once: true });
  }, 50);
}

function closePicker() {
  document.getElementById('shift-picker').style.display = 'none';
  pickerCell = null;
}

// Show a small spinning indicator on a cell while saving
function setCellSaving(cell, saving) {
  if (!cell) return;
  if (saving) {
    cell.style.opacity = '0.5';
    cell.style.pointerEvents = 'none';
    const chip = cell.querySelector('.shift-chip');
    if (chip) chip.dataset.prevText = chip.textContent;
    if (chip) chip.textContent = '…';
  } else {
    cell.style.opacity = '';
    cell.style.pointerEvents = '';
  }
}

async function applyShift(code) {
  if (!pickerCell) return;
  const staffId  = Number(pickerCell.dataset.staff);
  const date     = pickerCell.dataset.date;
  const oldCode  = pickerCell.dataset.code;
  const savedCell = pickerCell;
  closePicker();
  if (code === oldCode) return;

  setCellSaving(savedCell, true);
  try {
    const entry = await API.put(`/schedules/${currentSchedule.id}/entries`, {
      staff_id: staffId, date, shift_code: code,
      cross_branch_id: null, is_oncall: false,
    });
    currentEntries = currentEntries.filter(e => !(e.staff_id===staffId && e.date?.slice(0,10)===date));
    currentEntries.push(entry);
    buildEntryMap();
    renderRotaGrid();
    renderScheduleStats();
    // Subtle green flash on the changed cell for instant visual confirmation.
    const newCell = document.querySelector(`td[data-staff="${staffId}"][data-date="${date}"]`);
    if (newCell) { newCell.classList.add('cell-flash'); setTimeout(() => newCell.classList.remove('cell-flash'), 700); }
  } catch (err) {
    setCellSaving(savedCell, false);
    toast(err.message, 'err');
  }
}

async function toggleOnCall() {
  if (!pickerCell) return;
  const staffId   = Number(pickerCell.dataset.staff);
  const date      = pickerCell.dataset.date;
  const key       = `${staffId}_${date}`;
  const entry     = entryMap[key];
  const savedCell = pickerCell;
  closePicker();
  setCellSaving(savedCell, true);
  try {
    const updated = await API.put(`/schedules/${currentSchedule.id}/entries`, {
      staff_id: staffId, date,
      shift_code: entry?.shift_code || 'OC',
      is_oncall: !entry?.is_oncall
    });
    currentEntries = currentEntries.filter(e => !(e.staff_id===staffId && e.date?.slice(0,10)===date));
    currentEntries.push(updated);
    buildEntryMap();
    renderRotaGrid();
  } catch (err) {
    setCellSaving(savedCell, false);
    toast(err.message, 'err');
  }
}

async function toggleScheduleLock() {
  if (!currentSchedule) return;
  // A team lead can't override the lock on a schedule that's in the review
  // pipeline — but a reviewer (manager / full admin) can unlock it to edit.
  const reviewStatuses = ['submitted', 'reviewed', 'approved'];
  const isReviewer = ['superadmin', 'manager'].includes(currentUser?.role);
  if (reviewStatuses.includes(currentSchedule.status) && !isReviewer) {
    toast('This schedule is in review — ask a manager to return it.', 'err');
    return;
  }
  const willLock = !currentSchedule.is_locked;
  const label = willLock ? 'Lock' : 'Unlock';
  const ok = await showConfirm(
    `${label} Schedule`,
    willLock
      ? 'Lock this schedule? No edits will be possible until unlocked.'
      : 'Unlock this schedule? Edits will be allowed again.',
    label
  );
  if (!ok) return;
  try {
    currentSchedule = await API.put(`/schedules/${currentSchedule.id}/lock`, { locked: willLock });
    renderScheduleStatusBar();
    renderTeamLeadBanner();
    renderRotaGrid();
    toast(willLock ? '🔒 Schedule locked' : '🔓 Schedule unlocked', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function saveStaffMonthSetting(staffId, field, value, inputEl) {
  const ms = staffMonthSettings[staffId] || { min_shifts: 0, max_shifts: 31, max_consecutive: 4 };
  const updated = { ...ms, [field]: parseInt(value) };

  // Keep min ≤ max automatically so we never send an invalid pair to the server.
  // If the user lowered max below min, pull min down to match (and vice-versa).
  if (field === 'min_shifts' && updated.min_shifts > updated.max_shifts) {
    updated.max_shifts = updated.min_shifts;
  }
  if (field === 'max_shifts' && updated.max_shifts < updated.min_shifts) {
    updated.min_shifts = updated.max_shifts;
  }

  // Show spinner on the input
  if (inputEl) {
    const orig = inputEl.style.cssText;
    inputEl.disabled = true;
    inputEl.style.opacity = '0.5';
    try {
      await API.put(`/staff-month-settings/${staffId}`, {
        year: scheduleYear, month: scheduleMonth,
        min_shifts:      updated.min_shifts,
        max_shifts:      updated.max_shifts,
        max_consecutive: updated.max_consecutive,
      });
      staffMonthSettings[staffId] = updated;
      inputEl.style.borderColor = '#27ae60';
      setTimeout(() => { inputEl.style.borderColor = ''; }, 800);
      // If a clamp adjusted the sibling field, reflect it in the row's inputs.
      const row = inputEl.closest('tr');
      if (row) {
        const minEl = row.querySelector('input[data-field="min_shifts"]');
        const maxEl = row.querySelector('input[data-field="max_shifts"]');
        if (minEl && document.activeElement !== minEl) minEl.value = updated.min_shifts;
        if (maxEl && document.activeElement !== maxEl) maxEl.value = updated.max_shifts;
      }
    } catch (err) {
      toast(err.message, 'err');
      inputEl.value = ms[field] ?? value; // revert
    } finally {
      inputEl.disabled = false;
      inputEl.style.opacity = '1';
    }
  } else {
    try {
      await API.put(`/staff-month-settings/${staffId}`, {
        year: scheduleYear, month: scheduleMonth,
        min_shifts:      updated.min_shifts,
        max_shifts:      updated.max_shifts,
        max_consecutive: updated.max_consecutive,
      });
      staffMonthSettings[staffId] = updated;
    } catch (err) { toast(err.message, 'err'); }
  }
}

// ── Staff Settings Modal ──────────────────────────────────────────────────────

let sectionMonthSettings = {}; // section_id → { section_name, min_m, max_m, min_n, max_n }

async function openStaffSettingsModal(tab) {
  tab = tab || 'staff';
  const monthName = new Date(scheduleYear, scheduleMonth - 1).toLocaleString('default', { month: 'long' });
  const canEdit = ['admin','superadmin'].includes(currentUser?.role) && !currentSchedule?.is_locked;
  const inputStyle = `width:52px;padding:3px 6px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:var(--text);font-size:13px;text-align:center`;
  const thStyle = `padding:8px 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);text-align:center;border-bottom:1px solid var(--border)`;

  // Load section settings if on section tab
  if (tab === 'section') {
    try {
      sectionMonthSettings = await API.get(`/section-month-settings?branch_id=${currentBranchId}&year=${scheduleYear}&month=${scheduleMonth}`);
    } catch (e) { sectionMonthSettings = {}; }
  }

  // Staff tab rows
  const staffRows = scheduleStaff.map(s => {
    const ms   = staffMonthSettings[s.id] || {};
    const minS = ms.min_shifts     ?? 17;
    const maxS = ms.max_shifts     ?? 17;
    const maxC = ms.max_consecutive ?? 4;
    if (canEdit) {
      return `<tr>
        <td style="padding:8px 10px;font-weight:600;font-size:13px">${s.name}</td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="0" max="31" value="${minS}" style="${inputStyle}" data-field="min_shifts"
            onchange="saveStaffMonthSetting(${s.id}, 'min_shifts', this.value, this)">
        </td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="0" max="31" value="${maxS}" style="${inputStyle}" data-field="max_shifts"
            onchange="saveStaffMonthSetting(${s.id}, 'max_shifts', this.value, this)">
        </td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="1" max="14" value="${maxC}" style="${inputStyle}"
            onchange="saveStaffMonthSetting(${s.id}, 'max_consecutive', this.value, this)">
        </td>
      </tr>`;
    } else {
      return `<tr>
        <td style="padding:8px 10px;font-weight:600;font-size:13px">${s.name}</td>
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${minS}</td>
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${maxS}</td>
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${maxC}</td>
      </tr>`;
    }
  }).join('');

  // Section tab rows
  const sectionRows = Object.entries(sectionMonthSettings).map(([secId, sec]) => {
    if (canEdit) {
      return `<tr>
        <td style="padding:8px 10px;font-weight:600;font-size:13px">${sec.section_name}</td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="0" max="10" value="${sec.min_m}" style="${inputStyle}"
            onchange="saveSectionMonthSetting(${secId}, 'min_m', this.value, this)">
        </td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="1" max="10" value="${sec.max_m}" style="${inputStyle}"
            onchange="saveSectionMonthSetting(${secId}, 'max_m', this.value, this)">
        </td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="0" max="10" value="${sec.min_n}" style="${inputStyle}"
            onchange="saveSectionMonthSetting(${secId}, 'min_n', this.value, this)">
        </td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="1" max="10" value="${sec.max_n}" style="${inputStyle}"
            onchange="saveSectionMonthSetting(${secId}, 'max_n', this.value, this)">
        </td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="1" max="14" value="${sec.max_consecutive ?? 4}" style="${inputStyle}"
            onchange="saveSectionMonthSetting(${secId}, 'max_consecutive', this.value, this)">
        </td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="1" max="14" value="${sec.min_o_block ?? 2}" style="${inputStyle}"
            onchange="saveSectionMonthSetting(${secId}, 'min_o_block', this.value, this)">
        </td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="0" max="31" value="${sec.max_o_block ?? 0}" style="${inputStyle}"
            title="Max consecutive days off (0 = no limit)"
            onchange="saveSectionMonthSetting(${secId}, 'max_o_block', this.value, this)">
        </td>
      </tr>`;
    } else {
      return `<tr>
        <td style="padding:8px 10px;font-weight:600;font-size:13px">${sec.section_name}</td>
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${sec.min_m}</td>
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${sec.max_m}</td>
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${sec.min_n}</td>
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${sec.max_n}</td>
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${sec.max_consecutive ?? 4}</td>
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${sec.min_o_block ?? 2}</td>
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${(sec.max_o_block ?? 0) || '—'}</td>
      </tr>`;
    }
  }).join('');

  const tabBtn = (t, label) => `<button onclick="openStaffSettingsModal('${t}')" style="padding:5px 14px;border-radius:20px;border:none;cursor:pointer;font-size:13px;font-weight:600;${tab===t ? 'background:var(--accent,#4a90e2);color:#fff' : 'background:var(--card-alt);color:var(--muted)'}">${label}</button>`;

  showModal('staff-settings-modal', `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div>
        <div style="font-size:16px;font-weight:700">⚙️ Shift Settings</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">${monthName} ${scheduleYear}</div>
      </div>
      <button onclick="closeModal('staff-settings-modal')" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted)">×</button>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:14px">
      ${tabBtn('staff', 'Staff')}
      ${tabBtn('section', 'Section Limits')}
    </div>
    ${tab === 'staff' ? `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="${thStyle};text-align:left;padding-left:10px">Staff</th>
          <th style="${thStyle}">Min Shifts</th>
          <th style="${thStyle}">Max Shifts</th>
          <th style="${thStyle}">Max Consecutive</th>
        </tr></thead>
        <tbody>${staffRows}</tbody>
      </table>
    </div>
    ${canEdit ? `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;gap:8px">
      <div style="font-size:11px;color:var(--muted)">Changes save automatically on input and will apply from the next Generate.</div>
      <button class="btn btn-sm btn-ghost" style="color:var(--danger,#e74c3c);border-color:var(--danger,#e74c3c)" onclick="resetStaffSettingsToDefault()">Reset to Default</button>
    </div>` : ''}
    ` : `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="${thStyle};text-align:left;padding-left:10px">Section</th>
          <th style="${thStyle}">Min M</th>
          <th style="${thStyle}">Max M</th>
          <th style="${thStyle}">Min N</th>
          <th style="${thStyle}">Max N</th>
          <th style="${thStyle}">Max Consecutive</th>
          <th style="${thStyle}">Min Off Block</th>
          <th style="${thStyle}">Max Off Block</th>
        </tr></thead>
        <tbody>${sectionRows || `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted)">No sections found</td></tr>`}</tbody>
      </table>
    </div>
    ${canEdit ? `<div style="font-size:11px;color:var(--muted);margin-top:12px">Changes save automatically on input and will apply from the next Generate.</div>` : ''}
    `}
  `);
}

async function saveSectionMonthSetting(sectionId, field, value, inputEl) {
  const sec = sectionMonthSettings[sectionId] || { min_m:1, max_m:2, min_n:1, max_n:2, max_consecutive: 4, min_o_block: 2, max_o_block: 0 };
  const updated = { ...sec, [field]: parseInt(value) };
  inputEl.disabled = true; inputEl.style.opacity = '0.5';
  try {
    await API.put(`/section-month-settings/${sectionId}`, {
      branch_id: currentBranchId,
      year: scheduleYear, month: scheduleMonth,
      min_m: updated.min_m, max_m: updated.max_m,
      min_n: updated.min_n, max_n: updated.max_n,
      max_consecutive: updated.max_consecutive ?? 4,
      min_o_block: updated.min_o_block ?? 2,
      max_o_block: updated.max_o_block ?? 0,
    });
    sectionMonthSettings[sectionId] = updated;
    inputEl.style.borderColor = '#27ae60';
    setTimeout(() => { inputEl.style.borderColor = ''; }, 800);
  } catch (err) {
    toast(err.message, 'err');
    inputEl.value = sec[field] ?? value;
  } finally {
    inputEl.disabled = false; inputEl.style.opacity = '1';
  }
}

function showModal(id, html) {
  let overlay = document.getElementById(id);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = id;
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000`;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(id); });
    document.body.appendChild(overlay);
  }
  const maxWidthById = {
    'staff-settings-modal': '900px',
    'generate-diagnostics-modal': '900px',
  };
  const maxWidth = maxWidthById[id] || '520px';
  overlay.innerHTML = `
    <div style="background:var(--card);border-radius:14px;padding:24px;width:94%;max-width:${maxWidth};max-height:86vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,0.25)">
      ${html}
    </div>`;
  overlay.style.display = 'flex';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

async function clearCell() {
  if (!pickerCell) return;
  const staffId  = Number(pickerCell.dataset.staff);
  const date     = pickerCell.dataset.date;
  const savedCell = pickerCell;
  closePicker();
  setCellSaving(savedCell, true);
  try {
    await API.delete(`/schedules/${currentSchedule.id}/entries/cell`, { staff_id: staffId, date });
    currentEntries = currentEntries.filter(e => !(e.staff_id===staffId && e.date?.slice(0,10)===date));
    buildEntryMap();
    renderRotaGrid();
    renderScheduleStats();
    toast(`${date}: cleared`, 'ok');
  } catch (err) {
    setCellSaving(savedCell, false);
    toast(err.message, 'err');
  }
}

async function applyCrossBranch() {
  if (!pickerCell) return;
  const savedCell = pickerCell;
  closePicker();
  // Simple prompt — pick branch
  const names = allBranches.filter(b => b.id !== currentBranchId).map(b => `${b.id}:${b.name}`).join('\n');
  const picked = prompt(`Enter branch ID for cross-branch assignment:\n${names}`);
  if (!picked) return;
  const crossId = parseInt(picked);
  if (isNaN(crossId)) return;

  const staffId = Number(savedCell.dataset.staff);
  const date    = savedCell.dataset.date;
  setCellSaving(savedCell, true);
  try {
    const entry = await API.put(`/schedules/${currentSchedule.id}/entries`, {
      staff_id: staffId, date, shift_code: 'M',
      cross_branch_id: crossId, is_oncall: false
    });
    currentEntries = currentEntries.filter(e => !(e.staff_id===staffId && e.date?.slice(0,10)===date));
    currentEntries.push(entry);
    buildEntryMap();
    renderRotaGrid();
    toast('Cross-branch assigned');
  } catch (err) {
    setCellSaving(savedCell, false);
    toast(err.message, 'err');
  }
}

// ── Generate modal ────────────────────────────────────────────────────────────

// Which section the next Generate run targets: '' = all sections.
let genSectionChoice = '';

function openGenerateModal() {
  document.getElementById('gen-msg').textContent = '';

  const branchName = allBranches.find(b => b.id === currentBranchId)?.name || 'this branch';
  const monthName  = new Date(scheduleYear, scheduleMonth - 1).toLocaleString('default', { month: 'long' });
  document.getElementById('gen-overwrite-warning').innerHTML =
    `⚠ This will <strong>overwrite</strong> the current schedule for <strong>${branchName}</strong> — <strong>${monthName} ${scheduleYear}</strong>.`;

  // Offer "General / Ultrasound / Both" only when this branch actually has both
  // sections staffed — otherwise there's nothing to choose.
  const hasUS = scheduleStaff.some(s => s.speciality?.includes('Ultrasound') && !s.speciality?.includes('General'));
  const hasGen = scheduleStaff.some(s => !s.speciality?.includes('Ultrasound') || s.speciality?.includes('General'));
  const pick = document.getElementById('gen-section-pick');
  if (hasUS && hasGen) {
    genSectionChoice = '';
    const opts = [['', 'Both sections'], ['General', 'General only'], ['US', 'Ultrasound only']];
    document.getElementById('gen-section-choices').innerHTML = opts.map(([val, label]) =>
      `<button type="button" class="gen-sec-chip" data-val="${val}" onclick="setGenSection('${val}')"
        style="${genSecChipStyle(val === genSectionChoice)}">${label}</button>`).join('');
    pick.style.display = 'block';
  } else {
    genSectionChoice = '';
    pick.style.display = 'none';
  }

  document.getElementById('generate-modal-overlay').classList.add('open');
}

function genSecChipStyle(active) {
  return `padding:6px 14px;border-radius:20px;border:1px solid ${active ? 'var(--accent,#6B4EFF)' : 'var(--border)'};`
       + `cursor:pointer;font-size:12px;font-weight:600;`
       + (active ? 'background:var(--accent,#6B4EFF);color:#fff' : 'background:var(--card-alt);color:var(--muted)');
}

function setGenSection(val) {
  genSectionChoice = val;
  document.querySelectorAll('#gen-section-choices .gen-sec-chip').forEach(el => {
    el.style.cssText = genSecChipStyle(el.dataset.val === val);
  });
}

async function resetStaffSettingsToDefault() {
  const ok = await showConfirm(
    'Reset to Default',
    `Reset all staff settings for this month to:\n  · Min shifts: 17\n  · Max shifts: 17\n  · Max consecutive days: 4\n\nThis applies to ${scheduleStaff.length} staff for this branch and month only.`,
    'Reset'
  );
  if (!ok) return;
  try {
    await Promise.all(scheduleStaff.map(s =>
      API.put(`/staff-month-settings/${s.id}`, {
        year: scheduleYear, month: scheduleMonth,
        min_shifts: 17, max_shifts: 17, max_consecutive: 4
      }).then(() => { staffMonthSettings[s.id] = { min_shifts: 17, max_shifts: 17, max_consecutive: 4 }; })
    ));
    const genMsg = document.getElementById('gen-msg');
    if (genMsg) { genMsg.className = 'msg'; genMsg.textContent = '✓ Reset to defaults — you can try Generate again.'; }
    // Refresh settings modal if it's open
    if (document.getElementById('staff-settings-modal')?.style.display === 'flex') {
      openStaffSettingsModal();
    }
    toast('Settings reset to defaults');
  } catch (err) {
    toast(err.message, 'err');
  }
}
function closeGenerateModal() {
  document.getElementById('generate-modal-overlay').classList.remove('open');
}

// ── Cross-branch cover (manager only) ─────────────────────────────────────────
function openCoverModal() {
  if (!currentSchedule?.id) { toast('Open a branch schedule first', 'err'); return; }
  const today = new Date();
  const def = (scheduleYear === today.getFullYear() && scheduleMonth === today.getMonth() + 1)
    ? `${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`
    : `${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}-01`;
  const last = daysInMonth(scheduleYear, scheduleMonth);
  showModal('cover-modal', `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div style="font-size:17px;font-weight:800">🔁 Cover from another branch</div>
      <button onclick="closeModal('cover-modal')" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted)">×</button>
    </div>
    <div style="font-size:12px;color:var(--muted);margin-top:4px">Pick a day and a free staff member from another branch to cover it. It won't affect Generate.</div>
    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
      <label style="flex:1;min-width:120px"><div style="font-size:12px;font-weight:600;margin-bottom:4px">Date</div>
        <input type="date" id="cover-date" value="${def}"
          min="${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}-01"
          max="${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}-${String(last).padStart(2,'0')}"
          onchange="loadCoverCandidates()" style="width:100%;padding:7px;border:1px solid var(--border);border-radius:8px"></label>
      <label style="width:110px"><div style="font-size:12px;font-weight:600;margin-bottom:4px">Shift</div>
        <select id="cover-shift" style="width:100%;padding:7px;border:1px solid var(--border);border-radius:8px">
          <option value="M">Morning (M)</option><option value="N">Night (N)</option>
        </select></label>
      <label style="width:140px"><div style="font-size:12px;font-weight:600;margin-bottom:4px">Section</div>
        <select id="cover-section" onchange="loadCoverCandidates()" style="width:100%;padding:7px;border:1px solid var(--border);border-radius:8px">
          <option value="">Any section</option><option value="General">General</option><option value="US">Ultrasound</option>
        </select></label>
    </div>
    <div style="font-size:12px;font-weight:600;margin:14px 0 6px">Available staff (other branches)</div>
    <div id="cover-candidates" style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:6px">
      <div style="color:var(--muted);padding:12px;text-align:center">Loading…</div>
    </div>
    <div class="msg" id="cover-msg" style="margin-top:8px"></div>
  `);
  loadCoverCandidates();
}

async function loadCoverCandidates() {
  const box = document.getElementById('cover-candidates');
  if (!box) return;
  const date = document.getElementById('cover-date').value;
  const section = document.getElementById('cover-section').value;
  box.innerHTML = `<div style="color:var(--muted);padding:12px;text-align:center">Loading…</div>`;
  try {
    const res = await API.get(`/cover-candidates?branch_id=${currentBranchId}&date=${date}${section ? '&section=' + section : ''}`);
    const cands = res.candidates || [];
    if (!cands.length) {
      box.innerHTML = `<div style="color:var(--muted);padding:12px;text-align:center">No free staff from other branches on this day.</div>`;
      return;
    }
    box.innerHTML = cands.map(c => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-weight:600;font-size:13px">${escapeHtml(c.name)}</div>
          <div style="font-size:11px;color:var(--muted)">${escapeHtml(c.branch_name || '')} · ${escapeHtml(c.section)} · ${c.shifts_month} shifts this month</div>
        </div>
        <button class="btn btn-sm" onclick="submitCover(${c.staff_id}, '${escapeHtml(c.name)}')">Assign</button>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div style="color:var(--danger,#e74c3c);padding:12px;text-align:center">${escapeHtml(e.message)}</div>`;
  }
}

async function submitCover(staffId, name) {
  const date = document.getElementById('cover-date').value;
  const shift = document.getElementById('cover-shift').value;
  const msg = document.getElementById('cover-msg');
  try {
    await API.post(`/schedules/${currentSchedule.id}/cover`, { staff_id: staffId, date, shift_code: shift });
    msg.className = 'msg'; msg.textContent = `✓ ${name} assigned to cover ${shift} on ${date}`;
    currentEntries = await API.get(`/schedules/${currentSchedule.id}/entries`);
    buildEntryMap();
    renderRotaGrid();
    loadCoverCandidates();
    toast('Cover assigned');
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
}

async function removeCover(staffId, date) {
  if (!currentSchedule?.id) return;
  try {
    await API.delete(`/schedules/${currentSchedule.id}/cover?staff_id=${staffId}&date=${date}`);
    currentEntries = await API.get(`/schedules/${currentSchedule.id}/entries`);
    buildEntryMap();
    renderRotaGrid();
    toast('Cover removed');
  } catch (e) { toast(e.message, 'err'); }
}

// ── Auto-fill from surplus staff at same-city sharing branches (manager only) ──
function openAutofillModal() {
  if (!currentSchedule?.id) { toast('Open a branch schedule first', 'err'); return; }
  const shiftOpts = (allShiftTypes || [])
    .filter(s => !s.is_off && !s.is_leave)
    .map(s => `<option value="${s.code}"${s.code==='Y3'?' selected':(s.code==='M'?'':'')}>${s.code} — ${escapeHtml(s.label||s.code)}</option>`).join('');
  showModal('autofill-modal', `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div style="font-size:17px;font-weight:800">🏗 Fill from other branches</div>
      <button onclick="closeModal('autofill-modal')" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted)">×</button>
    </div>
    <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">
      Relocates <b>surplus</b> staff from same-city branches that have opted to share — only people already
      working a day where their branch is over its minimum. Rest days are never touched, and no one's shift
      count goes up.
    </div>
    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
      <label style="width:150px"><div style="font-size:12px;font-weight:600;margin-bottom:4px">Shift to assign</div>
        <select id="af-shift" style="width:100%;padding:7px;border:1px solid var(--border);border-radius:8px">${shiftOpts}</select></label>
      <label style="width:120px"><div style="font-size:12px;font-weight:600;margin-bottom:4px">Staff per day</div>
        <input type="number" id="af-perday" value="1" min="1" max="10" style="width:100%;padding:7px;border:1px solid var(--border);border-radius:8px"></label>
      <label style="width:150px"><div style="font-size:12px;font-weight:600;margin-bottom:4px">Section</div>
        <select id="af-section" style="width:100%;padding:7px;border:1px solid var(--border);border-radius:8px">
          <option value="">Any section</option><option value="General">General</option><option value="US">Ultrasound</option>
        </select></label>
    </div>
    <div style="display:flex;gap:18px;margin-top:12px;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px">
        <input type="checkbox" id="af-skipfri" checked style="width:auto"> Skip Fridays (branch closed)</label>
      <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px">
        <input type="checkbox" id="af-lock" style="width:auto"> Lock the schedule when done</label>
    </div>
    <div class="msg" id="af-msg" style="margin-top:10px"></div>
    <div id="af-report" style="margin-top:10px"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
      <button class="btn btn-ghost btn-sm" onclick="closeModal('autofill-modal')">Close</button>
      <button class="btn btn-sm" id="af-run" onclick="runAutofill()">Fill now</button>
    </div>
  `);
}

async function runAutofill() {
  const msg = document.getElementById('af-msg');
  const report = document.getElementById('af-report');
  const btn = document.getElementById('af-run');
  const payload = {
    shift_code: document.getElementById('af-shift').value,
    per_day: parseInt(document.getElementById('af-perday').value) || 1,
    section: document.getElementById('af-section').value || null,
    skip_fridays: document.getElementById('af-skipfri').checked,
    lock: document.getElementById('af-lock').checked,
  };
  btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Filling…'; report.innerHTML = '';
  try {
    const res = await API.post(`/schedules/${currentSchedule.id}/autofill-cross-cover`, payload);
    if (res.detail) { msg.className = 'msg err'; msg.textContent = res.detail; btn.disabled = false; return; }
    msg.className = 'msg'; msg.textContent = `✓ Placed ${res.filled} shift${res.filled!==1?'s':''} from: ${(res.donors||[]).join(', ') || '—'}`;
    if ((res.shortfalls || []).length) {
      report.innerHTML = `<div style="font-size:12px;color:#E63946;background:rgba(230,57,70,0.08);border-radius:8px;padding:8px 10px">
        ⚠ Couldn't fully fill ${res.shortfalls.length} day(s): ${res.shortfalls.map(s=>`${s.date.slice(8)} (−${s.missing})`).join(', ')}.
        Not enough surplus staff at sharing branches.</div>`;
    }
    await loadScheduleData();
    toast(`Filled ${res.filled} shift(s)`);
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
  btn.disabled = false;
}

async function runGenerate() {
  const btn = document.getElementById('gen-btn');
  const msg = document.getElementById('gen-msg');
  btn.disabled = true; btn.textContent = 'Generating…';
  msg.textContent = '';
  showLoaderCycling([
    'Reading staff & leaves…',
    'Computing fair shift targets…',
    'Solving the schedule…',
    'Checking 24h coverage…',
    'Finalising…',
  ], 1500);
  try {
    let result, confirmGen = false;
    while (true) {
      try {
        result = await API.post('/generate', {
          branch_id: currentBranchId,
          year:      scheduleYear,
          month:     scheduleMonth,
          confirm:   confirmGen,
          section:   genSectionChoice || undefined,
        });
        break;
      } catch (err) {
        // Pending leave requests for this month — warn, then let them proceed.
        if (!confirmGen && err?.data?.detail?.confirm_required === 'pending_leaves') {
          hideLoader();
          const ok = await showConfirm('Pending leave requests', err.message, 'Generate anyway', 'confirm-ok');
          if (!ok) { msg.textContent = ''; return; }
          confirmGen = true;
          showLoaderCycling(['Solving the schedule…', 'Finalising…'], 1500);
          continue;
        }
        throw err;
      }
    }
    currentSchedule = result.schedule;

    // Reload entries
    currentEntries = await API.get(`/schedules/${currentSchedule.id}/entries`);
    buildEntryMap();
    closeGenerateModal();
    renderScheduleStatusBar();
    renderScheduleStats();
    renderRotaGrid();

    showSuccess(genSectionChoice
      ? `${genSectionChoice === 'US' ? 'Ultrasound' : genSectionChoice} section generated`
      : 'Schedule generated');

    // Show diagnostics if any section is non-optimal or infeasible.
    const sections = result.sections || {};
    const nonOptimal = Object.values(sections).some(s => s?.status && s.status !== 'OPTIMAL');
    if (nonOptimal) {
      openGenerateDiagnosticsModal({
        title: 'Generation completed with warnings',
        solver_status: result.solver_status,
        sections,
      });
    }
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;

    // If backend provided detailed diagnostics, show them in a popup.
    const data = err?.data || err?.response || null;
    const sections = data?.detail?.sections || data?.sections;
    if (sections) {
      openGenerateDiagnosticsModal({
        title: 'Could not generate schedule',
        solver_status: data?.detail?.solver_status || data?.solver_status,
        sections,
        top_error: (typeof data?.detail === 'string' ? data.detail : data?.detail?.error) || data?.error,
      });
    }
  } finally {
    hideLoader();
    btn.disabled = false; btn.textContent = '⚡ Generate';
  }
}

function openGenerateDiagnosticsModal({ title, solver_status, sections, top_error }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const sectionRows = Object.entries(sections || {}).map(([name, info]) => {
    const status = info?.status || 'UNKNOWN';
    const diag = info?.diagnostics || {};
    const msgs = (diag.messages || []).slice(0, 6);
    const shortages = (diag.daily_shortages || []).slice(0, 6);
    const extra = [];

    if (status === 'FEASIBLE') extra.push('Found a feasible schedule but could not prove optimality within the time limit.');
    if (status === 'INFEASIBLE') extra.push('No schedule satisfies the current constraints for this section.');
    if (diag.required_month_min_shifts && diag.capacity_month_max_mn && diag.required_month_min_shifts > diag.capacity_month_max_mn) {
      extra.push(`Monthly minimum shifts demand (${diag.required_month_min_shifts}) exceeds capacity (${diag.capacity_month_max_mn}).`);
    }

    const list = [...extra, ...msgs].filter(Boolean);
    const listHtml = list.length
      ? `<ul style="margin:10px 0 0 18px;color:var(--text);line-height:1.35">${list.map(m => `<li>${esc(m)}</li>`).join('')}</ul>`
      : `<div style="margin-top:10px;color:var(--muted)">No additional diagnostics provided.</div>`;

    const shortageHtml = shortages.length
      ? `<div style="margin-top:10px;color:var(--muted);font-size:12px">Example shortage days: ${shortages.map(s => `Day ${s.day} (avail ${s.available_staff} / need ${s.required_staff})`).join(', ')}</div>`
      : '';

    // The exact setting(s) that, changed, make this section solvable.
    const fixes = diag.fixes || [];
    const fixesHtml = fixes.length
      ? `<div style="margin-top:12px;padding:11px 13px;border-radius:10px;background:rgba(0,155,116,0.10);border:1px solid rgba(0,155,116,0.30)">
           <div style="font-weight:700;color:#009B74;font-size:13px">✅ How to fix it — change one of these settings:</div>
           <ul style="margin:8px 0 0 18px;color:var(--text);line-height:1.5">
             ${fixes.map(f => `<li><strong>${esc(f.setting)}</strong>: ${esc(f.change)}</li>`).join('')}
           </ul>
           <div style="font-size:11px;color:var(--muted);margin-top:7px">Open ⚙️ Settings → Section Limits to change these for this month.</div>
         </div>`
      : (status === 'INFEASIBLE'
          ? `<div style="margin-top:12px;color:var(--muted);font-size:12px">No single setting change unlocked it — the section is short of staff for this coverage. Add staff, reduce leave, or lower the daily Min M / Min N.</div>`
          : '');

    return `
      <div style="padding:12px 12px;border:1px solid var(--border);border-radius:12px;margin-top:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="font-weight:700">${esc(name)}</div>
          <div style="font-size:12px;padding:4px 10px;border-radius:999px;background:rgba(0,0,0,0.05);border:1px solid var(--border)">${esc(status)}</div>
        </div>
        ${listHtml}
        ${shortageHtml}
        ${fixesHtml}
      </div>`;
  }).join('');

  showModal('generate-diagnostics-modal', `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div style="font-size:18px;font-weight:800">${esc(title || 'Diagnostics')}</div>
      <button onclick="closeModal('generate-diagnostics-modal')" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted)">×</button>
    </div>
    ${top_error ? `<div style="margin-top:10px;color:var(--text)">${esc(top_error)}</div>` : ''}
    <div style="margin-top:8px;color:var(--muted);font-size:12px">Solver status: ${esc(solver_status || 'UNKNOWN')}</div>
    ${sectionRows || `<div style="margin-top:12px;color:var(--muted)">No section details.</div>`}
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px">
      <button onclick="closeModal('generate-diagnostics-modal')" class="btn">Close</button>
    </div>
  `);
}
