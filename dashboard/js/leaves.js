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
  setTopbar('Leave Management', 'Annual leave, sick leave, time-back',
    canEdit ? `<button class="btn btn-sm" onclick="openLeaveModal()">+ Add Leave</button>` : ''
  );
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
          <th>#</th><th>Staff</th><th>Branch</th><th>From</th><th>To</th><th>Days</th><th>Type</th><th>Note</th>
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
  const canEdit = ['admin','superadmin'].includes(currentUser?.role);
  if (!allLeaves.length) {
    tb.innerHTML = `<tr><td colspan="${canEdit?9:8}" style="text-align:center;padding:24px;color:var(--muted)">No leave records found</td></tr>`;
    return;
  }

  // Group consecutive days for same staff+type into ranges
  const groups = groupLeaveRanges(allLeaves);

  tb.innerHTML = groups.map((g, i) => {
    const badge = { AL:'badge-purple', SL:'badge-orange', TB:'badge-yellow', OT:'badge-green' }[g.leave_type] || 'badge-gray';
    const fromStr = fmtDateDisplay(g.date_from);
    const toStr   = g.date_from === g.date_to ? '—' : fmtDateDisplay(g.date_to);
    const days    = g.day_count;
    return `<tr>
      <td style="color:var(--muted);font-size:12px;text-align:center">${i+1}</td>
      <td style="font-weight:600">${g.staff_name}</td>
      <td style="font-size:12px;color:var(--muted)">${g.branch_name || '—'}</td>
      <td>${fromStr}</td>
      <td>${toStr}</td>
      <td style="text-align:center;font-weight:600">${days}</td>
      <td><span class="badge ${badge}">${g.leave_type}</span> <span style="font-size:11px;color:var(--muted)">${LEAVE_LABELS[g.leave_type]||''}</span></td>
      <td style="font-size:12px;color:var(--muted)">${g.note || '—'}</td>
      ${canEdit ? `<td><button class="action-btn danger" onclick="deleteLeaveRange(${JSON.stringify(g.ids)})">Delete</button></td>` : ''}
    </tr>`;
  }).join('');
}

// Group individual leave rows into date ranges (same staff + type + consecutive days)
function groupLeaveRanges(leaves) {
  // Sort by staff, type, date
  const sorted = [...leaves].sort((a, b) => {
    if (a.staff_id !== b.staff_id) return a.staff_id - b.staff_id;
    if (a.leave_type !== b.leave_type) return a.leave_type.localeCompare(b.leave_type);
    return new Date(a.date) - new Date(b.date);
  });

  const groups = [];
  for (const lv of sorted) {
    const d = new Date(lv.date);
    const last = groups[groups.length - 1];
    // Check if this extends the last group (same staff, type, consecutive day)
    if (last &&
        last.staff_id    === lv.staff_id &&
        last.leave_type  === lv.leave_type) {
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
  ls.innerHTML = '<option value="">Select staff…</option>';
  const filtered = currentUser?.role === 'superadmin'
    ? allStaff
    : allStaff.filter(s => s.branch_id === currentUser?.branch_id);
  filtered.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = `${s.name} (${s.branch_name || '?'})`;
    ls.appendChild(opt);
  });

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
  const staff_id   = document.getElementById('leave-staff').value;
  const date_from  = document.getElementById('leave-date-from').value;
  const date_to    = document.getElementById('leave-date-to').value;
  const leave_type = document.getElementById('leave-type').value;
  const note       = document.getElementById('leave-note').value.trim();

  if (!staff_id)   { msg.className='msg err'; msg.textContent='Select a staff member'; return; }
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
    toast(`${result.inserted} day${result.inserted !== 1 ? 's' : ''} of ${leave_type} added`);
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
