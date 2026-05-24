// ── Leaves page ───────────────────────────────────────────────────────────────
let allLeaves = [];
const LEAVE_LABELS = { AL:'Annual Leave', SL:'Sick Leave', TB:'Time-Back', OT:'Over Time' };

async function loadLeaves(branchId, year, month) {
  const params = new URLSearchParams();
  if (branchId) params.append('branch_id', branchId);
  if (year)     params.append('year', year);
  if (month)    params.append('month', month);
  allLeaves = await API.get(`/leaves?${params}`);
  return allLeaves;
}

function renderLeavesPage() {
  const canEdit = ['admin','superadmin'].includes(currentUser?.role);
  setTopbar('Leave Management', 'Annual leave, sick leave, time-back',
    canEdit ? `<button class="btn btn-sm" onclick="openLeaveModal()">+ Add Leave</button>` : ''
  );

  const now = new Date();
  const c   = document.getElementById('content');
  c.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <select id="leave-filter-year" onchange="filterLeaves()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:13px;background:var(--card-alt);color:var(--text);outline:none"></select>
      <select id="leave-filter-month" onchange="filterLeaves()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:13px;background:var(--card-alt);color:var(--text);outline:none">
        <option value="">All Months</option>
        ${MONTHS.map((m,i) => `<option value="${i+1}"${i+1===now.getMonth()+1?' selected':''}>${m}</option>`).join('')}
      </select>
      ${currentUser?.role==='superadmin' ? `<select id="leave-filter-branch" onchange="filterLeaves()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:13px;background:var(--card-alt);color:var(--text);outline:none"><option value="">All Branches</option>${allBranches.map(b=>`<option value="${b.id}">${b.name}</option>`).join('')}</select>` : ''}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Staff</th><th>Branch</th><th>Date</th><th>Type</th><th>Note</th>
        ${canEdit ? '<th>Actions</th>' : ''}</tr></thead>
        <tbody id="leaves-tbody"></tbody>
      </table>
    </div>`;

  // Year selector
  const ys = document.getElementById('leave-filter-year');
  for (let y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    if (y === now.getFullYear()) opt.selected = true;
    ys.appendChild(opt);
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
  const tb = document.getElementById('leaves-tbody');
  if (!tb) return;
  const canEdit = ['admin','superadmin'].includes(currentUser?.role);
  if (!allLeaves.length) {
    tb.innerHTML = `<tr><td colspan="${canEdit?7:6}" style="text-align:center;padding:24px;color:var(--muted)">No leave records found</td></tr>`;
    return;
  }
  tb.innerHTML = allLeaves.map((l, i) => {
    const dateStr = l.date ? new Date(l.date).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—';
    const badge = { AL:'badge-purple', SL:'badge-orange', TB:'badge-yellow', OT:'badge-green' }[l.leave_type] || 'badge-gray';
    return `<tr>
      <td>${i+1}</td>
      <td><strong>${l.staff_name}</strong></td>
      <td>${l.branch_name || '—'}</td>
      <td>${dateStr}</td>
      <td><span class="badge ${badge}">${l.leave_type}</span> <span style="font-size:11px;color:var(--muted)">${LEAVE_LABELS[l.leave_type]||''}</span></td>
      <td>${l.note || '—'}</td>
      ${canEdit ? `<td><button class="action-btn danger" onclick="deleteLeaveConfirm(${l.id})">Delete</button></td>` : ''}
    </tr>`;
  }).join('');
}

function openLeaveModal() {
  // Populate staff select (filtered to user's branch)
  const ls = document.getElementById('leave-staff');
  ls.innerHTML = '<option value="">Select staff…</option>';
  const filtered = currentUser?.role === 'superadmin' ? allStaff : allStaff.filter(s => s.branch_id === currentUser?.branch_id);
  filtered.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = `${s.name} (${s.branch_name || '?'})`;
    ls.appendChild(opt);
  });
  document.getElementById('leave-date').value = fmtDate(new Date());
  document.getElementById('leave-type').value = 'AL';
  document.getElementById('leave-note').value = '';
  document.getElementById('leave-msg').textContent = '';
  document.getElementById('leave-modal-overlay').classList.add('open');
}
function closeLeaveModal() {
  document.getElementById('leave-modal-overlay').classList.remove('open');
}
async function saveLeave() {
  const msg = document.getElementById('leave-msg');
  const staff_id   = document.getElementById('leave-staff').value;
  const date        = document.getElementById('leave-date').value;
  const leave_type  = document.getElementById('leave-type').value;
  const note        = document.getElementById('leave-note').value.trim();
  if (!staff_id || !date) { msg.className='msg err'; msg.textContent='Staff and date required'; return; }
  try {
    const l = await API.post('/leaves', { staff_id: Number(staff_id), date, leave_type, note });
    allLeaves.unshift({ ...l, staff_name: allStaff.find(s=>s.id===Number(staff_id))?.name || '?', branch_name: allBranches.find(b=>b.id===allStaff.find(s=>s.id===Number(staff_id))?.branch_id)?.name || '?' });
    closeLeaveModal();
    renderLeavesList();
    toast('Leave added');
  } catch (err) { msg.className='msg err'; msg.textContent=err.message; }
}
async function deleteLeaveConfirm(id) {
  const ok = await showConfirm('Delete Leave', 'Remove this leave record?');
  if (!ok) return;
  try {
    await API.delete(`/leaves/${id}`);
    allLeaves = allLeaves.filter(l => l.id !== id);
    renderLeavesList();
    toast('Leave deleted');
  } catch (err) { toast(err.message, 'err'); }
}
