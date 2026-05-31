// ── Schedule page ─────────────────────────────────────────────────────────────
let currentSchedule   = null;
let currentEntries    = [];   // flat array from server
let scheduleYear      = new Date().getFullYear();
let scheduleMonth     = new Date().getMonth() + 1;
let currentBranchId   = null;
let scheduleStaff     = [];   // staff for current branch
let entryMap          = {};   // "staffId_dateStr" → entry
let staffAllowedShifts  = {}; // staff_id → [allowed shift codes]
let staffMonthSettings  = {}; // staff_id → { min_shifts, max_shifts }

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
          <button class="btn btn-ghost btn-sm" onclick="openStaffSettingsModal()" title="Staff shift settings">⚙️ Settings</button>
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
      staffAllowedShifts = {};
    }

    // Load per-month min/max settings for each staff
    try {
      staffMonthSettings = await API.get(
        `/staff-month-settings?branch_id=${currentBranchId}&year=${scheduleYear}&month=${scheduleMonth}`
      );
    } catch (e) {
      staffMonthSettings = {};
    }

    renderScheduleStatusBar();
    renderShiftLegend();
    renderScheduleStats();
    renderRotaGrid();
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


function renderScheduleStatusBar() {
  const bar = document.getElementById('schedule-status-bar');
  if (!bar || !currentSchedule) return;
  const s = currentSchedule;
  const isAdmin = ['admin','superadmin'].includes(currentUser?.role);

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
  const isLocked = !!currentSchedule?.is_locked;

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

        const cellReadonly = isLocked;
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
  if (currentSchedule?.is_locked) return;
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
    toast(`${date}: ${code}`, 'ok');
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

async function saveStaffMonthSetting(staffId, field, value, inputEl) {
  const ms = staffMonthSettings[staffId] || { min_shifts: 17, max_shifts: 17, max_consecutive: 4 };
  const updated = { ...ms, [field]: parseInt(value) };

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
          <input type="number" min="0" max="31" value="${minS}" style="${inputStyle}"
            onchange="saveStaffMonthSetting(${s.id}, 'min_shifts', this.value, this)">
        </td>
        <td style="padding:8px 6px;text-align:center">
          <input type="number" min="0" max="31" value="${maxS}" style="${inputStyle}"
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
          <input type="number" min="1" max="14" value="${sec.min_al_block ?? 1}" style="${inputStyle}"
            onchange="saveSectionMonthSetting(${secId}, 'min_al_block', this.value, this)">
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
        <td style="padding:8px 6px;text-align:center;color:var(--muted)">${sec.min_al_block ?? 1}</td>
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
          <th style="${thStyle}">Min AL Block</th>
        </tr></thead>
        <tbody>${sectionRows || `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">No sections found</td></tr>`}</tbody>
      </table>
    </div>
    ${canEdit ? `<div style="font-size:11px;color:var(--muted);margin-top:12px">Changes save automatically on input and will apply from the next Generate.</div>` : ''}
    `}
  `);
}

async function saveSectionMonthSetting(sectionId, field, value, inputEl) {
  const sec = sectionMonthSettings[sectionId] || { min_m:1, max_m:2, min_n:1, max_n:2, max_consecutive: 4, min_al_block: 1 };
  const updated = { ...sec, [field]: parseInt(value) };
  inputEl.disabled = true; inputEl.style.opacity = '0.5';
  try {
    await API.put(`/section-month-settings/${sectionId}`, {
      year: scheduleYear, month: scheduleMonth,
      min_m: updated.min_m, max_m: updated.max_m,
      min_n: updated.min_n, max_n: updated.max_n,
      max_consecutive: updated.max_consecutive ?? 4,
      min_al_block: updated.min_al_block ?? 1,
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
  overlay.innerHTML = `
    <div style="background:var(--card);border-radius:14px;padding:24px;width:90%;max-width:520px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,0.25)">
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

function openGenerateModal() {
  document.getElementById('gen-msg').textContent = '';

  const branchName = allBranches.find(b => b.id === currentBranchId)?.name || 'this branch';
  const monthName  = new Date(scheduleYear, scheduleMonth - 1).toLocaleString('default', { month: 'long' });
  document.getElementById('gen-overwrite-warning').innerHTML =
    `⚠ This will <strong>overwrite</strong> the current schedule for <strong>${branchName}</strong> — <strong>${monthName} ${scheduleYear}</strong>.`;

  document.getElementById('generate-modal-overlay').classList.add('open');
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

    toast(`Schedule generated (${result.solver_status})`);

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

    return `
      <div style="padding:12px 12px;border:1px solid var(--border);border-radius:12px;margin-top:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="font-weight:700">${esc(name)}</div>
          <div style="font-size:12px;padding:4px 10px;border-radius:999px;background:rgba(0,0,0,0.05);border:1px solid var(--border)">${esc(status)}</div>
        </div>
        ${listHtml}
        ${shortageHtml}
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
