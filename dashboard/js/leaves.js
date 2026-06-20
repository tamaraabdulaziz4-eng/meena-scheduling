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

async function renderLeavesPage() {
  // Managers are reviewers too — they add/approve/delete leave (matches the
  // backend's require_admin / require_reviewer). Only 'admin','superadmin' here
  // would hide approval from a manager-role account.
  const canEdit = ['admin','superadmin','manager'].includes(currentUser?.role);
  const isSuper = currentUser?.role === 'superadmin';
  const isStaff = currentUser?.role === 'staff';
  const title = isStaff ? 'My Leave' : 'Leave Management';
  const actions = [
    isSuper ? `<button class="btn btn-ghost btn-sm" onclick="openHolidaysModal()">⚙️ Settings</button>` : '',
    (canEdit || isStaff) ? `<button class="btn btn-ghost btn-sm" onclick="openTimebackModal()">⏱ Time-back</button>` : '',
    (canEdit || isStaff) ? `<button class="btn btn-sm" onclick="openLeaveModal()">${isStaff ? '🌴 Request Leave' : '+ Add Leave'}</button>` : '',
  ].filter(Boolean).join(' ');
  setTopbar(title, 'Annual leave, sick leave, time-back', actions);
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Annual leave · sick leave · time-back', title)}
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
          ${(canEdit || isStaff) ? '<th>Actions</th>' : ''}
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
  await filterLeaves();
}

async function filterLeaves() {
  const year  = document.getElementById('leave-filter-year')?.value;
  const month = document.getElementById('leave-filter-month')?.value || '';
  const bid   = document.getElementById('leave-filter-branch')?.value || '';
  const tb = document.getElementById('leaves-tbody');
  const canEdit = ['admin','superadmin','manager'].includes(currentUser?.role);
  const isStaff = currentUser?.role === 'staff';
  const cols = (canEdit || isStaff) ? 10 : 9;
  if (tb) tb.innerHTML = `<tr><td colspan="${cols}">${LOADING_HTML}</td></tr>`;
  try {
    await loadLeaves(bid || (currentUser?.branch_id || ''), year, month);
    renderLeavesList();
    animateIn('leaves-tbody');
  } catch (e) {
    if (tb) tb.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;color:var(--muted);padding:20px">${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
  }
}

function renderLeavesList() {
  const tb     = document.getElementById('leaves-tbody');
  if (!tb) return;  // e.g. a staff member requested leave from the My Schedule page
  const canEdit = ['admin','superadmin','manager'].includes(currentUser?.role);
  const isReviewer = ['manager','superadmin'].includes(currentUser?.role);
  const isStaff = currentUser?.role === 'staff';
  if (!allLeaves.length) {
    tb.innerHTML = `<tr><td colspan="${(canEdit||isStaff)?10:9}" style="text-align:center;padding:24px;color:var(--muted)">No leave records found</td></tr>`;
    return;
  }

  // Group consecutive days for same staff+type+status into ranges
  const groups = groupLeaveRanges(allLeaves);

  // Two-stage chain so everyone (incl. the staff member) sees where it stands.
  const LEAVE_STATUS = {
    pending:       ['Awaiting team lead', 'badge-orange'],
    lead_approved: ['Awaiting manager',   'badge-yellow'],
    approved:      ['Approved',           'badge-green'],
    rejected:      ['Rejected',           'badge-gray'],
  };
  tb.innerHTML = groups.map((g, i) => {
    const badge = { AL:'badge-purple', SL:'badge-orange', TB:'badge-yellow', OT:'badge-green' }[g.leave_type] || 'badge-gray';
    const fromStr = fmtDateDisplay(g.date_from);
    const toStr   = g.date_from === g.date_to ? '—' : fmtDateDisplay(g.date_to);
    const days    = g.day_count;
    const st      = g.status || 'approved';
    const idsArg  = JSON.stringify(g.ids).replace(/"/g, '&quot;');
    // Sick leave → a "find cover" button for reviewers, the branch lead and the owner.
    const coverBtn = g.leave_type === 'SL'
      ? `<button class="action-btn" onclick="openCoverModal(${g.ids[0]})">🔁 Cover</button> ` : '';
    let actions = '';
    if (canEdit) {
      actions = '<td style="white-space:nowrap">' + coverBtn;
      // Stage 1 ('pending') → team lead OR manager can act; stage 2
      // ('lead_approved') → manager/superadmin only.
      const canAct = (st === 'pending' && canEdit) || (st === 'lead_approved' && isReviewer);
      if (canAct) {
        actions += `<button class="action-btn" onclick="setLeaveRangeStatus(${idsArg},'approved')">${(st === 'pending' && !isReviewer) ? 'Approve → manager' : 'Approve'}</button>
                    <button class="action-btn danger" onclick="setLeaveRangeStatus(${idsArg},'rejected')">Reject</button> `;
      }
      actions += `<button class="action-btn danger" onclick="deleteLeaveRange(${idsArg})">Delete</button></td>`;
    } else if (isStaff) {
      // A staff member can withdraw their own pending request, and find cover for their own sick leave.
      actions = '<td style="white-space:nowrap">' + coverBtn;
      actions += st === 'pending'
        ? `<button class="action-btn danger" onclick="withdrawLeaveRange(${idsArg})">Withdraw</button>`
        : (coverBtn ? '' : '<span style="font-size:11px;color:var(--muted)">—</span>');
      actions += '</td>';
    }
    return `<tr>
      <td style="color:var(--muted);font-size:12px;text-align:center">${i+1}</td>
      <td style="font-weight:600">${g.staff_name}</td>
      <td style="font-size:12px;color:var(--muted)">${g.branch_name || '—'}</td>
      <td>${fromStr}</td>
      <td>${toStr}</td>
      <td style="text-align:center;font-weight:600">${days}</td>
      <td><span class="badge ${badge}">${g.leave_type}</span> <span style="font-size:11px;color:var(--muted)">${LEAVE_LABELS[g.leave_type]||''}</span></td>
      <td><span class="badge ${(LEAVE_STATUS[st]||['',''])[1]||'badge-gray'}">${(LEAVE_STATUS[st]||[st])[0]}</span></td>
      <td style="font-size:12px;color:var(--muted)">${g.note || '—'}</td>
      ${actions}
    </tr>`;
  }).join('');
}

async function setLeaveRangeStatus(ids, status) {
  // One batched call → the requester gets a single summary notification instead
  // of one ping per day. A coverage gap warns once for the whole range.
  let cancelled = false;
  showLoader(status === 'approved' ? 'Approving…' : 'Rejecting…');
  try {
    try {
      await API.put('/leaves/status', { ids, status });
    } catch (e) {
      if (status === 'approved' && e?.data?.detail?.confirm_required === 'coverage_gap') {
        hideLoader();
        const ok = await showConfirm('⚠ Coverage gap', e.message, 'Approve anyway', 'confirm-ok');
        if (!ok) { cancelled = true; }
        else { showLoader('Approving…'); await API.put('/leaves/status', { ids, status, confirm: true }); }
      } else { throw e; }
    }
    if (!cancelled) toast(`Leave ${status}`);
  } catch (e) { toast(e.message, 'err'); }
  finally { hideLoader(); }
  // Reload so the list reflects exactly what the server recorded.
  try { await filterLeaves(); } catch (e) { /* page may have changed */ }
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
  // Cutoff hint (staff & team leads are bound by it; managers can override).
  const msgEl = document.getElementById('leave-msg');
  if (['staff','admin'].includes(currentUser?.role)) {
    msgEl.className = 'msg';
    msgEl.textContent = `Note: a month's leave must be requested before day ${leaveCutoffDay} of the previous month — no same-month requests.`;
  } else {
    msgEl.textContent = '';
  }
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
  // Cutoff: staff & team leads can't request next-month leave past the deadline.
  if (['staff','admin'].includes(currentUser?.role)) {
    for (const d of [date_from, date_to]) {
      const w = leaveWindowOpen(d);
      if (!w.ok) { msg.className='msg err'; msg.textContent = w.msg; return; }
    }
  }

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
    // Say exactly where the request stands (the two-stage chain) instead of always
    // claiming "manager". And flag a partial save if some days didn't go through.
    const stageMsg = {
      pending:       `${dayWord} of ${leave_type} requested — awaiting team lead approval`,
      lead_approved: `${dayWord} of ${leave_type} requested — awaiting manager approval`,
      approved:      `${dayWord} of ${leave_type} added to the rota`,
    }[result.status] || `${dayWord} of ${leave_type} saved`;
    const failed = Number(result.failed || 0);
    toast(failed ? `${stageMsg} — but ${failed} day${failed !== 1 ? 's' : ''} couldn't be saved` : stageMsg,
          failed ? 'err' : undefined);
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

async function withdrawLeaveRange(ids) {
  const ok = await showConfirm('Withdraw request',
    `Withdraw your ${ids.length} day${ids.length !== 1 ? 's' : ''} leave request?`, 'Withdraw');
  if (!ok) return;
  showLoader('Withdrawing…');
  try {
    await Promise.all(ids.map(id => API.delete(`/leaves/${id}`)));
    allLeaves = allLeaves.filter(l => !ids.includes(l.id));
    renderLeavesList();
    toast('Request withdrawn');
  } catch (err) { toast(err.message, 'err'); }
  finally { hideLoader(); }
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

// ── Sick-leave cover suggestions ──────────────────────────────────────────────
let _coverLeaveId = null;
async function openCoverModal(lid) {
  _coverLeaveId = lid;
  document.getElementById('cover-summary').textContent = '';
  document.getElementById('cover-list').innerHTML = LOADING_HTML;
  document.getElementById('cover-modal-overlay').classList.add('open');
  try {
    const r = await API.get(`/leaves/${lid}/cover-suggestions`);
    document.getElementById('cover-summary').innerHTML =
      `Cover for <b>${escapeHtml(r.absent || '')}</b> — ${r.gap_shift ? 'shift <b>' + escapeHtml(r.gap_shift) + '</b>' : 'their shift'}` +
      ` · ${escapeHtml(r.branch_name || '')} · ${fmtDateDisplay(r.date)} · section <b>${escapeHtml(r.section)}</b>`;
    const list = document.getElementById('cover-list');
    const cands = r.candidates || [];
    if (!cands.length) {
      list.innerHTML = `<div class="empty"><p>No free ${escapeHtml(r.section)} staff found across the branches that day.</p></div>`;
      return;
    }
    list.innerHTML = cands.map(c => `
      <div class="cover-row">
        <div style="flex:1">
          <b>${escapeHtml(c.name)}</b>
          <span class="badge ${c.same_branch ? 'badge-purple' : 'badge-gray'}" style="margin-left:6px">${escapeHtml(c.branch_name || '')}</span>
          <div style="font-size:11.5px;color:var(--muted);margin-top:2px">Off that day · ${c.shifts_month} shifts this month${c.same_branch ? ' · same branch' : ''}</div>
        </div>
        <button class="btn btn-sm" onclick="requestCover(${c.staff_id}, ${JSON.stringify(c.name).replace(/"/g,'&quot;')})">Request</button>
      </div>`).join('');
  } catch (e) {
    document.getElementById('cover-list').innerHTML = `<div class="empty"><p>${escapeHtml(e.message)}</p></div>`;
  }
}
function closeCoverModal() { document.getElementById('cover-modal-overlay').classList.remove('open'); }
async function requestCover(staffId, name) {
  try {
    await API.post(`/leaves/${_coverLeaveId}/request-cover`, { staff_id: staffId });
    toast(`Cover request sent to ${name}`);
  } catch (e) { toast(e.message, 'err'); }
}

// ── Time-back claims + balance ────────────────────────────────────────────────
const TB_REASONS = { covered: 'Covered for a colleague', offday: 'Worked an off-day',
                     extra: 'Extra shift / overtime', oncall: 'On-call / emergency' };
const TB_STATUS = { pending: ['Awaiting team lead', 'badge-orange'], lead_approved: ['Awaiting manager', 'badge-yellow'],
                    approved: ['Approved', 'badge-green'], rejected: ['Rejected', 'badge-gray'] };
async function openTimebackModal() {
  document.getElementById('tb-msg').textContent = '';
  document.getElementById('tb-date').value = fmtDate(new Date());
  const isStaff = currentUser?.role === 'staff';
  // Reviewers/leads pick which staff the claim is for.
  const staffRow = document.getElementById('tb-staff-row');
  if (!isStaff) {
    staffRow.style.display = '';
    if (!allStaff.length) { try { await loadStaff(); } catch (e) {} }
    document.getElementById('tb-staff').innerHTML =
      allStaff.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  } else staffRow.style.display = 'none';
  document.getElementById('timeback-modal-overlay').classList.add('open');
  loadTimeback();
}
function closeTimebackModal() { document.getElementById('timeback-modal-overlay').classList.remove('open'); }
async function loadTimeback() {
  const bal = document.getElementById('tb-balance');
  const list = document.getElementById('tb-list');
  list.innerHTML = LOADING_HTML;
  try {
    const claims = await API.get('/timeback');
    // Balance: for a staff member, their own; otherwise hidden (shown per row).
    if (currentUser?.role === 'staff') {
      const b = await API.get('/timeback/balance').catch(() => null);
      bal.innerHTML = b ? `Your balance: <b>${b.balance}</b> day${b.balance === 1 ? '' : 's'}` : '';
      bal.style.display = '';
    } else bal.style.display = 'none';
    renderTimebackList(claims);
  } catch (e) { list.innerHTML = `<div class="empty"><p>${escapeHtml(e.message)}</p></div>`; }
}
function renderTimebackList(claims) {
  const list = document.getElementById('tb-list');
  if (!claims.length) { list.innerHTML = `<div class="hm-muted" style="padding:8px 0">No claims yet.</div>`; return; }
  const isStaff = currentUser?.role === 'staff';
  const isReviewer = ['manager', 'superadmin'].includes(currentUser?.role);
  const canEdit = ['admin', 'superadmin', 'manager'].includes(currentUser?.role);
  list.innerHTML = claims.map(t => {
    const stt = TB_STATUS[t.status] || [t.status, 'badge-gray'];
    const canAct = (t.status === 'pending' && canEdit) || (t.status === 'lead_approved' && isReviewer);
    let act = '';
    if (canAct) act = `<button class="action-btn" onclick="setTimebackStatus(${t.id},'approved')">${(t.status === 'pending' && !isReviewer) ? 'Approve → manager' : 'Approve'}</button>
                       <button class="action-btn danger" onclick="setTimebackStatus(${t.id},'rejected')">Reject</button>`;
    else if (isStaff && t.status === 'pending') act = `<button class="action-btn danger" onclick="withdrawTimeback(${t.id})">Withdraw</button>`;
    return `<div class="tb-row">
      <div style="flex:1">
        <b>${escapeHtml(t.staff_name || '')}</b> · ${TB_REASONS[t.reason] || t.reason}
        <div style="font-size:11.5px;color:var(--muted)">${fmtDateDisplay(t.date)}${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
      </div>
      <span class="badge ${stt[1]}">${stt[0]}</span>
      <div style="white-space:nowrap">${act}</div>
    </div>`;
  }).join('');
}
async function submitTimeback() {
  const msg = document.getElementById('tb-msg'); msg.className = 'msg';
  const body = { date: document.getElementById('tb-date').value,
                 reason: document.getElementById('tb-reason').value,
                 note: document.getElementById('tb-note').value.trim() };
  if (currentUser?.role !== 'staff') body.staff_id = document.getElementById('tb-staff').value || null;
  if (!body.date) { msg.classList.add('err'); msg.textContent = 'Pick a date'; return; }
  try {
    await API.post('/timeback', body);
    document.getElementById('tb-note').value = '';
    toast('Claim submitted'); loadTimeback();
  } catch (e) { msg.classList.add('err'); msg.textContent = e.message; }
}
async function setTimebackStatus(id, status) {
  try { await API.put(`/timeback/${id}/status`, { status }); toast(`Claim ${status === 'approved' ? 'approved' : 'rejected'}`); loadTimeback(); }
  catch (e) { toast(e.message, 'err'); }
}
async function withdrawTimeback(id) {
  try { await API.delete(`/timeback/${id}`); toast('Claim withdrawn'); loadTimeback(); }
  catch (e) { toast(e.message, 'err'); }
}
