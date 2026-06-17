// ── Leaves page ───────────────────────────────────────────────────────────────
let allLeaves = [];
const LEAVE_LABELS = { AL:'Annual Leave', SL:'Sick Leave', TB:'Time-Back', OT:'Over Time' };

async function loadLeaves(branchId, year, month) {
  let params = branchId ? `branch_id=${branchId}` : '';
  if (year)  params += `${params?'&':''}year=${year}`;
  if (month) params += `${params?'&':''}month=${month}`;
  allLeaves = await API.get(`/leaves?${params}`);
  return allLeaves;
}

function renderLeavesPage() {
  const canEdit = ['admin','superadmin'].includes(currentUser?.role);
  const isSuper = currentUser?.role === 'superadmin';
  const isStaff = currentUser?.role === 'staff';
  const title = isStaff ? 'My Leave' : 'Leave Management';
  const actions = [
    isSuper ? `<button class="btn btn-ghost btn-sm" onclick="openHolidaysModal()">🗓 Holidays</button>` : '',
    (canEdit || isStaff) ? `<button class="btn btn-sm" onclick="openLeaveModal()">${isStaff ? '🌴 Request Leave' : '+ Add Leave'}</button>` : '',
  ].filter(Boolean).join(' ');
  setTopbar(title, 'Annual leave, sick leave, time-back', actions);
  const c = document.getElementById('content');
  c.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
      <select id="leave-filter-year" onchange="filterLeaves()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:13px;background:var(--card-alt);color:var(--text);outline:none"></select>
      <select id="leave-filter-month" onchange="filterLeaves()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:13px;background:var(--card-alt);color:var(--text);outline:none">
        <option value="">All months</option>
        ${MONTHS.map((m,i)=>`<option value="${i+1}">${m}</option>`).join('')}
      </select>
      ${currentUser?.role==='superadmin' ? `<select id="leave-filter-branch" onchange="filterLeaves()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:13px;background:var(--card-alt);color:var(--text);outline:none"><option value="">All Branches</option>${allBranches.map(b=>`<option value="${b.id}">${b.name}</option>`).join('')}</select>` : ''}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>#</th><th>Staff</th><th>Branch</th><th>From</th><th>To</th><th>Days</th><th>Type</th><th>Status</th><th>Note</th>
          ${canEdit ? '<th>Actions</th>' : ''}
        </tr></thead>
        <tbody id="leaves-tbody"></tbody>
      </table>
    </div>`;

  // Populate year filter
  const ys = document.getElementById('leave-filter-year');
  const now = new Date();
  for (let y = now.getFullYear() + 1; y >= now.getFullYear() - 1; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y;
    if (y === now.getFullYear()) o.selected = true;
    ys.appendChild(o);
  }
  filterLeaves();
}

async function filterLeaves() {
  const year  = document.getElementById('leave-filter-year')?.value;
  const month = document.getElementById('leave-filter-month')?.value || '';
  const bid   = document.getElementById('leave-filter-branch')?.value || '';
  showLoader('Loading leaves…');
  try {
    await loadLeaves(bid || (currentUser?.branch_id || ''), year, month);
    renderLeavesList();
  } finally { hideLoader(); }
}

function renderLeavesList() {
  const tb     = document.getElementById('leaves-tbody');
  if (!tb) return;  // e.g. a staff member requested leave from the My Schedule page
  const canEdit = ['admin','superadmin'].includes(currentUser?.role);
  const isReviewer = ['manager','superadmin'].includes(currentUser?.role);
  if (!allLeaves.length) {
    tb.innerHTML = `<tr><td colspan="${canEdit?10:9}" style="text-align:center;padding:24px;color:var(--muted)">No leave records found</td></tr>`;
    return;
  }

  // Group consecutive days for same staff+type+status into ranges
  const groups = groupLeaveRanges(allLeaves);

  const statusBadge = { approved:'badge-green', pending:'badge-orange', rejected:'badge-gray' };
  tb.innerHTML = groups.map((g, i) => {
    const badge = { AL:'badge-purple', SL:'badge-orange', TB:'badge-yellow', OT:'badge-green' }[g.leave_type] || 'badge-gray';
    const fromStr = fmtDateDisplay(g.date_from);
    const toStr   = g.date_from === g.date_to ? '—' : fmtDateDisplay(g.date_to);
    const days    = g.day_count;
    const st      = g.status || 'approved';
    const idsArg  = JSON.stringify(g.ids).replace(/"/g, '&quot;');
    let actions = '';
    if (canEdit) {
      actions = '<td style="white-space:nowrap">';
      if (isReviewer && st === 'pending') {
        actions += `<button class="action-btn" onclick="setLeaveRangeStatus(${idsArg},'approved')">Approve</button>
                    <button class="action-btn danger" onclick="setLeaveRangeStatus(${idsArg},'rejected')">Reject</button> `;
      }
      actions += `<button class="action-btn danger" onclick="deleteLeaveRange(${idsArg})">Delete</button></td>`;
    }
    return `<tr>
      <td style="color:var(--muted);font-size:12px;text-align:center">${i+1}</td>
      <td style="font-weight:600">${g.staff_name}</td>
      <td style="font-size:12px;color:var(--muted)">${g.branch_name || '—'}</td>
      <td>${fromStr}</td>
      <td>${toStr}</td>
      <td style="text-align:center;font-weight:600">${days}</td>
      <td><span class="badge ${badge}">${g.leave_type}</span> <span style="font-size:11px;color:var(--muted)">${LEAVE_LABELS[g.leave_type]||''}</span></td>
      <td><span class="badge ${statusBadge[st]||'badge-gray'}">${st}</span></td>
      <td style="font-size:12px;color:var(--muted)">${g.note || '—'}</td>
      ${actions}
    </tr>`;
  }).join('');
}

async function setLeaveRangeStatus(ids, status) {
  showLoader(status === 'approved' ? 'Approving…' : 'Rejecting…');
  try {
    await Promise.all(ids.map(id => API.put(`/leaves/${id}/status`, { status })));
    ids.forEach(id => { const lv = allLeaves.find(l => l.id === id); if (lv) lv.status = status; });
    renderLeavesList();
    toast(`Leave ${status}`);
  } catch (e) { toast(e.message, 'err'); }
  finally { hideLoader(); }
}

// Group individual leave rows into date ranges (same staff + type + consecutive days)
function groupLeaveRanges(leaves) {
  // Sort by staff, type, date
  const sorted = [...leaves].sort((a, b) => {
    if (a.staff_id !== b.staff_id) return a.staff_id - b.staff_id;
    if (a.leave_type !== b.leave_type) return a.leave_type.localeCompare(b.leave_type);
    if ((a.status||'') !== (b.status||'')) return (a.status||'').localeCompare(b.status||'');
    return new Date(a.date) - new Date(b.date);
  });

  const groups = [];
  for (const lv of sorted) {
    const d = new Date(lv.date);
    const last = groups[groups.length - 1];
    // Check if this extends the last group (same staff, type, status, consecutive day)
    if (last &&
        last.staff_id    === lv.staff_id &&
        last.leave_type  === lv.leave_type &&
        last.status      === (lv.status || 'approved')) {
      const lastDate   = new Date(last.date_to);
      const nextDay    = new Date(lastDate);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      if (d.toISOString().slice(0,10) === nextDay.toISOString().slice(0,10)) {
        last.date_to  = lv.date;
        last.day_count++;
        last.ids.push(lv.id);
        continue;
      }
    }
    groups.push({
      ids:         [lv.id],
      staff_id:    lv.staff_id,
      staff_name:  lv.staff_name,
      branch_name: lv.branch_name,
      leave_type:  lv.leave_type,
      status:      lv.status || 'approved',
      date_from:   lv.date,
      date_to:     lv.date,
      day_count:   1,
      note:        lv.note,
    });
  }
  return groups;
}

function fmtDateDisplay(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' });
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openLeaveModal() {
  const ls = document.getElementById('leave-staff');
  const staffField = ls.closest('.form-field');
  const isStaff = currentUser?.role === 'staff';
  // A staff member requests leave only for themselves — hide the picker entirely.
  if (staffField) staffField.style.display = isStaff ? 'none' : '';
  ls.innerHTML = '<option value="">Select staff…</option>';
  if (!isStaff) {
    const filtered = ['superadmin','manager'].includes(currentUser?.role)
      ? allStaff
      : allStaff.filter(s => s.branch_id === currentUser?.branch_id);
    filtered.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = `${s.name} (${s.branch_name || '?'})`;
      ls.appendChild(opt);
    });
  }

  const today = fmtDate(new Date());
  document.getElementById('leave-date-from').value = today;
  document.getElementById('leave-date-to').value   = today;
  document.getElementById('leave-type').value      = 'AL';
  document.getElementById('leave-note').value      = '';
  document.getElementById('leave-msg').textContent = '';
  document.getElementById('leave-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('leave-staff').focus(), 50);
}

function closeLeaveModal() {
  document.getElementById('leave-modal-overlay').classList.remove('open');
}

async function saveLeave() {
  const msg        = document.getElementById('leave-msg');
  const btn        = document.getElementById('leave-save-btn');
  const isStaff    = currentUser?.role === 'staff';
  // Staff request for themselves; the backend pins it to their own record.
  const staff_id   = isStaff ? (currentUser?.staff_id || '') : document.getElementById('leave-staff').value;
  const date_from  = document.getElementById('leave-date-from').value;
  const date_to    = document.getElementById('leave-date-to').value;
  const leave_type = document.getElementById('leave-type').value;
  const note       = document.getElementById('leave-note').value.trim();

  if (!isStaff && !staff_id) { msg.className='msg err'; msg.textContent='Select a staff member'; return; }
  if (!date_from)  { msg.className='msg err'; msg.textContent='From date required'; return; }
  if (!date_to)    { msg.className='msg err'; msg.textContent='To date required'; return; }
  if (date_to < date_from) { msg.className='msg err'; msg.textContent='"To" date must be on or after "From" date'; return; }

  msg.className = 'msg'; msg.textContent = '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const result = await API.post('/leaves', {
      staff_id: Number(staff_id), date_from, date_to, leave_type, note
    });
    const staffObj  = allStaff.find(s => s.id === Number(staff_id));
    const branchObj = allBranches.find(b => b.id === staffObj?.branch_id);
    (result.leaves || []).forEach(l => {
      allLeaves.unshift({ ...l, staff_name: staffObj?.name || '?', branch_name: branchObj?.name || '?' });
    });
    closeLeaveModal();
    renderLeavesList();
    const dayWord = `${result.inserted} day${result.inserted !== 1 ? 's' : ''}`;
    toast(result.status === 'pending'
      ? `${dayWord} of ${leave_type} requested — awaiting manager approval`
      : `${dayWord} of ${leave_type} added`);
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

async function deleteLeaveRange(ids) {
  const ok = await showConfirm('Delete Leave', `Remove ${ids.length} day${ids.length !== 1 ? 's' : ''} of leave?`);
  if (!ok) return;
  showLoader('Deleting leave…');
  try {
    await Promise.all(ids.map(id => API.delete(`/leaves/${id}`)));
    allLeaves = allLeaves.filter(l => !ids.includes(l.id));
    renderLeavesList();
    toast(`${ids.length} leave day${ids.length !== 1 ? 's' : ''} deleted`);
  } catch (err) { toast(err.message, 'err'); }
  finally { hideLoader(); }
}
