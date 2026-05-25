// ── Schedule page ─────────────────────────────────────────────────────────────
let currentSchedule   = null;
let currentEntries    = [];   // flat array from server
let scheduleYear      = new Date().getFullYear();
let scheduleMonth     = new Date().getMonth() + 1;
let currentBranchId   = null;
let scheduleStaff     = [];   // staff for current branch
let entryMap          = {};   // "staffId_dateStr" → entry
let staffAllowedShifts = {}; // staff_id → [allowed shift codes]

// Shift picker state
let pickerCell = null;


async function renderSchedulePage() {
  // Choose branch: admin sees own, superadmin picks
  currentBranchId = currentUser.branch_id || (allBranches[0]?.id);

  setTopbar('Schedule', '', '');

  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="schedule-toolbar">
      ${currentUser.role === 'superadmin' ? `
        <select id="sched-branch-select" onchange="onBranchChange()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 12px;font-size:13px;background:var(--card-alt);color:var(--text);font-family:inherit;outline:none;cursor:pointer">
          ${allBranches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
        </select>` : `<span style="font-size:14px;font-weight:700;color:var(--primary)">${currentUser.branch_name || 'My Branch'}</span>`}

      <div class="month-nav">
        <button onclick="changeMonth(-1)">&#8249;</button>
        <span class="month-label" id="month-label"></span>
        <button onclick="changeMonth(1)">&#8250;</button>
      </div>

      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${['admin','superadmin'].includes(currentUser.role) ? `
          <button class="btn btn-ghost btn-sm" onclick="openGenerateModal()">⚡ Generate</button>
          <button class="btn btn-ghost btn-sm" onclick="exportXLSX()">📥 Export XLSX</button>
        ` : ''}
        <button class="btn btn-ghost btn-sm" onclick="window.print()">🖨 Print</button>
      </div>
    </div>

    <div id="schedule-status-bar" style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap"></div>

    <div class="stats-row" id="schedule-stats"></div>

    <div class="rota-wrap" id="rota-wrap">
      <div class="empty"><div class="empty-icon">📅</div><p>Loading schedule…</p></div>
    </div>

    <div class="legend" id="shift-legend" style="margin-top:20px"></div>`;

  document.getElementById('month-label').textContent = monthLabel(scheduleYear, scheduleMonth);
  await loadScheduleData();
}

async function onBranchChange() {
  const sel = document.getElementById('sched-branch-select');
  currentBranchId = Number(sel.value);
  await loadScheduleData();
}

async function changeMonth(delta) {
  scheduleMonth += delta;
  if (scheduleMonth > 12) { scheduleMonth = 1; scheduleYear++; }
  if (scheduleMonth < 1)  { scheduleMonth = 12; scheduleYear--; }
  document.getElementById('month-label').textContent = monthLabel(scheduleYear, scheduleMonth);
  await loadScheduleData();
}

async function loadScheduleData() {
  showLoader('Loading schedule…');
  try {
    // Load staff for this branch
    const staffData = await API.get(`/staff?branch_id=${currentBranchId}`);
    scheduleStaff = staffData.filter(s => s.active);

    // Open/get schedule
    const data = await API.post('/schedules/open', {
      branch_id: currentBranchId, year: scheduleYear, month: scheduleMonth
    });
    currentSchedule = data.schedule;
    currentEntries  = data.entries;
    buildEntryMap();

    // Load shift types for this branch
    await loadShiftTypes(currentBranchId);

    // Load allowed shifts per staff from solver config (for cell picker filtering)
    try {
      const allowedData = await API.get(`/generate/allowed-shifts?branch_id=${currentBranchId}`);
      staffAllowedShifts = allowedData.staff_allowed || {};
    } catch (e) {
      staffAllowedShifts = {}; // fallback: show all shifts if config unavailable
    }

    renderScheduleStatusBar();
    renderShiftLegend();
    renderScheduleStats();
    renderRotaGrid();
    updateTopbarActions();
  } catch (err) {
    document.getElementById('rota-wrap').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠️</div><p>${err.message}</p></div>`;
  } finally { hideLoader(); }
}

function buildEntryMap() {
  entryMap = {};
  for (const e of currentEntries) {
    const dateStr = e.date ? e.date.slice(0,10) : '';
    entryMap[`${e.staff_id}_${dateStr}`] = e;
  }
}

function updateTopbarActions() {
  if (!currentSchedule) return;
  const canEdit    = ['admin','superadmin'].includes(currentUser.role);
  const canReview  = currentUser.role === 'superadmin';
  const canApprove = currentUser.role === 'superadmin';
  const status     = currentSchedule.status;

  let actions = '';
  if (canEdit && status === 'draft') {
    actions += `<button class="btn btn-outline btn-sm" onclick="submitSchedule()">Submit for Review</button>`;
  }
  if (canReview && status === 'submitted') {
    actions += `<button class="btn btn-sm" onclick="reviewSchedule()">✓ Mark Reviewed</button>`;
  }
  if (canApprove && status === 'reviewed') {
    actions += `<button class="btn btn-sm" style="background:#00C896" onclick="approveSchedule()">✓✓ Approve</button>`;
  }
  if (canEdit && (status === 'draft' || status === 'submitted')) {
    actions += `<button class="btn btn-ghost btn-sm" onclick="openGenerateModal()">⚡ Generate</button>`;
  }
  actions += `<button class="btn btn-ghost btn-sm" onclick="exportXLSX()">📥 XLSX</button>`;
  actions += `<button class="btn btn-ghost btn-sm" onclick="window.print()">🖨 Print</button>`;
  document.getElementById('topbar-actions').innerHTML = actions;
}

function renderScheduleStatusBar() {
  const bar = document.getElementById('schedule-status-bar');
  if (!bar || !currentSchedule) return;
  const s = currentSchedule;
  const badges = {
    draft:     'badge-gray',
    submitted: 'badge-yellow',
    reviewed:  'badge-purple',
    approved:  'badge-green'
  };
  const isAdmin = ['admin','superadmin'].includes(currentUser?.role);

  bar.innerHTML = `
    <span class="badge ${badges[s.status] || 'badge-gray'}" style="font-size:11px;padding:4px 12px">
      ${s.status.charAt(0).toUpperCase()+s.status.slice(1)}
    </span>
    ${isAdmin ? `
      <button onclick="toggleScheduleLock()"
        style="font-size:11px;padding:3px 12px;border-radius:20px;border:none;cursor:pointer;font-weight:600;
               background:${s.is_locked ? '#f39c12' : '#dfe6e9'};color:${s.is_locked ? '#fff' : '#636e72'}"
        title="${s.is_locked ? 'Click to unlock' : 'Click to lock'}">
        ${s.is_locked ? '🔒 Locked' : '🔓 Unlocked'}
      </button>` : `
      <span style="font-size:11px;font-weight:600;color:${s.is_locked ? '#e17055' : '#636e72'}">
        ${s.is_locked ? '🔒 Locked' : ''}
      </span>`}
    ${s.created_by_name  ? `<span style="font-size:11px;color:var(--muted)">Created by: <strong>${s.created_by_name}</strong></span>` : ''}
    ${s.reviewed_by_name ? `<span style="font-size:11px;color:var(--muted)">Reviewed by: <strong>${s.reviewed_by_name}</strong></span>` : ''}
    ${s.approved_by_name ? `<span style="font-size:11px;color:var(--muted)">Approved by: <strong>${s.approved_by_name}</strong></span>` : ''}
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

  bar.innerHTML = `
    <div class="stat-pill">👥 <strong>${total}</strong> staff</div>
    <div class="stat-pill">📅 <strong>${nDays}</strong> days</div>
    <div class="stat-pill">✅ <strong>${working}</strong> shifts assigned</div>
    <div class="stat-pill">📞 <strong>${onCall}</strong> on-call</div>
    <div class="stat-pill">🌴 <strong>${leaves}</strong> leaves</div>`;
}

// ── Rota Grid ─────────────────────────────────────────────────────────────────
function renderRotaGrid() {
  const wrap = document.getElementById('rota-wrap');
  if (!wrap) return;

  const nDays   = daysInMonth(scheduleYear, scheduleMonth);
  const isLocked = currentSchedule?.status === 'approved';

  // Group staff: General first, then US
  const generalStaff = scheduleStaff.filter(s => !s.speciality?.includes('Ultrasound') || s.speciality?.includes('General'));
  const usStaff      = scheduleStaff.filter(s => s.speciality?.includes('Ultrasound') && !s.speciality?.includes('General'));
  // If everyone is general, show no section split
  const hasBothSections = usStaff.length > 0 && generalStaff.length > 0;

  let html = `<table class="rota-table" id="rota-table">
    <thead>
      <tr>
        <th class="rota-name-col" rowspan="2">Name</th>
        ${Array.from({length:nDays},(_,i)=>{
          const d = i+1;
          const dow = dayOfWeek(scheduleYear, scheduleMonth, d);
          return `<th style="${dow===5||dow===6?'background:rgba(107,78,255,0.12);':''}${d===new Date().getDate()&&scheduleMonth===new Date().getMonth()+1&&scheduleYear===new Date().getFullYear()?'border-bottom:2px solid var(--accent);':''}">${d}</th>`;
        }).join('')}
        <th style="min-width:60px">Shifts</th>
      </tr>
      <tr>
        ${Array.from({length:nDays},(_,i)=>{
          const dow = dayOfWeek(scheduleYear, scheduleMonth, i+1);
          const isWeekend = dow===5||dow===6;
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
        const weekend  = dow===5||dow===6 ? 'rgba(107,78,255,0.04)' : '';

        // Readonly if schedule approved OR schedule is_locked
        const cellReadonly = isLocked || !!currentSchedule?.is_locked;
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
        <td class="rota-name-col">${s.name}${s.is_cross_branch?'<sup title="Cross-branch">↗</sup>':''}</td>
        ${cells}
        <td style="text-align:center;font-weight:700;font-size:12px;color:var(--primary)">${shiftCount}</td>
      </tr>`;
    });
    return rows;
  }

  if (hasBothSections) {
    html += staffRows(generalStaff, 'General Radiology');
    html += staffRows(usStaff, 'Ultrasound (US)');
  } else {
    html += staffRows(scheduleStaff, '');
  }

  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

// ── Cell click → shift picker ─────────────────────────────────────────────────
function cellClick(cell) {
  if (currentSchedule?.status === 'approved') return;
  if (!['admin','superadmin'].includes(currentUser?.role)) return;

  // If picker already open for this cell, close it (toggle)
  if (pickerCell === cell && document.getElementById('shift-picker').style.display === 'grid') {
    closePicker();
    return;
  }


  pickerCell = cell;
  const picker = document.getElementById('shift-picker');

  // Filter shift types to only those allowed for this staff member's section.
  // Always include O (off), AL, SL (leaves), and OC (on-call) as universal options.
  // Note: staffAllowedShifts keys are strings (from JSON), so look up with string key.
  const staffId = cell.dataset.staff; // keep as string to match API keys
  const allowed = staffAllowedShifts[staffId];  // array or undefined
  const universalCodes = new Set(['O', 'AL', 'SL', 'OC']);
  const allowedSet = allowed?.length
    ? new Set([...allowed, ...universalCodes])
    : null; // null = show all (fallback for unmapped branches)

  const visibleShifts = allowedSet
    ? allShiftTypes.filter(st => allowedSet.has(st.code))
    : allShiftTypes;

  picker.innerHTML = visibleShifts.map(st => `
    <div class="shift-picker-item"
      style="background:${st.color};color:${contrastColor(st.color)}"
      onclick="applyShift('${st.code}')" title="${st.label}">
      ${st.code}
    </div>`).join('') +
    // Cross-branch button
    `<div class="shift-picker-item" style="background:#55EFC4;color:#2B2458;font-size:9px" onclick="applyCrossBranch()" title="Cross-branch assignment">↗XBR</div>` +
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

async function applyShift(code) {
  if (!pickerCell) return;
  const staffId  = Number(pickerCell.dataset.staff);
  const date     = pickerCell.dataset.date;
  const oldCode  = pickerCell.dataset.code;
  closePicker();
  if (code === oldCode) return;

  try {
    const entry = await API.put(`/schedules/${currentSchedule.id}/entries`, {
      staff_id: staffId, date, shift_code: code,
      cross_branch_id: null, is_oncall: false,
    });
    // Update local
    const key = `${staffId}_${date}`;
    currentEntries = currentEntries.filter(e => !(e.staff_id===staffId && e.date?.slice(0,10)===date));
    currentEntries.push(entry);
    buildEntryMap();
    renderRotaGrid();
    renderScheduleStats();
    toast(`${date}: ${code}`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function toggleOnCall() {
  if (!pickerCell) return;
  const staffId = Number(pickerCell.dataset.staff);
  const date    = pickerCell.dataset.date;
  const key     = `${staffId}_${date}`;
  const entry   = entryMap[key];
  closePicker();
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
  } catch (err) { toast(err.message, 'err'); }
}

async function toggleScheduleLock() {
  if (!currentSchedule) return;
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
    renderRotaGrid();
    toast(willLock ? '🔒 Schedule locked' : '🔓 Schedule unlocked', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function clearCell() {
  if (!pickerCell) return;
  const staffId = Number(pickerCell.dataset.staff);
  const date    = pickerCell.dataset.date;
  closePicker();
  try {
    await API.delete(`/schedules/${currentSchedule.id}/entries/cell`, { staff_id: staffId, date });
    currentEntries = currentEntries.filter(e => !(e.staff_id===staffId && e.date?.slice(0,10)===date));
    buildEntryMap();
    renderRotaGrid();
    renderScheduleStats();
    toast(`${date}: cleared`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function applyCrossBranch() {
  if (!pickerCell) return;
  closePicker();
  // Simple prompt — pick branch
  const names = allBranches.filter(b => b.id !== currentBranchId).map(b => `${b.id}:${b.name}`).join('\n');
  const picked = prompt(`Enter branch ID for cross-branch assignment:\n${names}`);
  if (!picked) return;
  const crossId = parseInt(picked);
  if (isNaN(crossId)) return;

  const staffId = Number(pickerCell.dataset.staff);
  const date    = pickerCell.dataset.date;
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
  } catch (err) { toast(err.message, 'err'); }
}

// ── Status transitions ────────────────────────────────────────────────────────
async function submitSchedule() {
  const ok = await showConfirm('Submit Schedule', 'Submit this schedule for supervisor review?', 'Submit', 'confirm-ok');
  if (!ok) return;
  try {
    currentSchedule = await API.put(`/schedules/${currentSchedule.id}/status`, { status: 'submitted' });
    renderScheduleStatusBar();
    updateTopbarActions();
    toast('Schedule submitted for review');
  } catch (err) { toast(err.message, 'err'); }
}
async function reviewSchedule() {
  try {
    currentSchedule = await API.put(`/schedules/${currentSchedule.id}/status`, { status: 'reviewed' });
    renderScheduleStatusBar(); updateTopbarActions();
    toast('Schedule marked as reviewed');
  } catch (err) { toast(err.message, 'err'); }
}
async function approveSchedule() {
  const ok = await showConfirm('Approve Schedule', 'Approve this schedule? It will be locked.', 'Approve');
  if (!ok) return;
  try {
    currentSchedule = await API.put(`/schedules/${currentSchedule.id}/status`, { status: 'approved' });
    renderScheduleStatusBar(); updateTopbarActions(); renderRotaGrid();
    toast('Schedule approved and locked ✓', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

// ── Generate modal ────────────────────────────────────────────────────────────

function openGenerateModal() {
  document.getElementById('gen-msg').textContent = '';
  document.getElementById('generate-modal-overlay').classList.add('open');
}
function closeGenerateModal() {
  document.getElementById('generate-modal-overlay').classList.remove('open');
}

async function runGenerate() {
  const btn = document.getElementById('gen-btn');
  const msg = document.getElementById('gen-msg');
  btn.disabled = true; btn.textContent = 'Generating…';
  msg.textContent = '';
  try {
    const result = await API.post('/generate', {
      branch_id: currentBranchId,
      year:      scheduleYear,
      month:     scheduleMonth,
    });
    currentSchedule = result.schedule;

    // Reload entries
    currentEntries = await API.get(`/schedules/${currentSchedule.id}/entries`);
    buildEntryMap();
    closeGenerateModal();
    renderScheduleStatusBar();
    renderScheduleStats();
    renderRotaGrid();
    updateTopbarActions();

    toast(`Schedule generated (${result.solver_status} · ${result.solver_elapsed}s)`);
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = '⚡ Generate';
  }
}
