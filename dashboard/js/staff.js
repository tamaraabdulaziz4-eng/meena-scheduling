// ── Staff page ────────────────────────────────────────────────────────────────
let allStaff = [];
let pendingRegs = [];

async function loadStaff() {
  allStaff = await API.get('/staff');
  return allStaff;
}

async function loadRegistrations() {
  // Only editors have the endpoint; ignore failures (e.g. viewers).
  try { pendingRegs = await API.get('/registrations'); }
  catch (e) { pendingRegs = []; }
  return pendingRegs;
}

function renderStaffPage() {
  // Renders from the already-loaded allStaff / pendingRegs (no fetch) so
  // re-rendering after an edit/delete is instant. Initial data load happens in
  // the router (loadStaff + loadRegistrations).
  const canEdit = ['admin','superadmin','manager'].includes(currentUser?.role);
  setTopbar('Staff', 'Manage radiology staff',
    canEdit ? `<button class="btn btn-sm" onclick="openStaffModal()">+ Add Staff</button>` : ''
  );

  // Group by branch
  const byBranch = {};
  allStaff.forEach(s => {
    const key = s.branch_name || 'Unassigned';
    if (!byBranch[key]) byBranch[key] = [];
    byBranch[key].push(s);
  });

  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Radiology team directory', 'Staff', `<b>${allStaff.length}</b> member${allStaff.length !== 1 ? 's' : ''}`)}
    <div id="staff-pending"></div>
    <div style="display:flex;flex-direction:column;gap:20px" id="staff-branch-sections"></div>`;

  if (canEdit) renderPendingRegs();
  const container = document.getElementById('staff-branch-sections');
  if (!allStaff.length) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">👥</div><p>No staff added yet</p><small>Add staff members to get started</small></div>`;
    return;
  }

  Object.entries(byBranch).forEach(([branch, staff]) => {
    const section = document.createElement('div');
    section.className = 'card';
    section.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--primary)">${escapeHtml(branch)}</div>
          <div style="font-size:11px;color:var(--muted)">${staff.length} staff member${staff.length!==1?'s':''}</div>
        </div>
      </div>
      <div class="table-wrap" style="border-radius:10px">
        <table>
          <thead><tr>
            <th>#</th><th>Name</th><th>ID / Email</th><th>Section</th>
            ${canEdit ? '<th>Actions</th>' : ''}
          </tr></thead>
          <tbody>${staff.map((s, i) => `
            <tr>
              <td>${i+1}</td>
              <td><strong>${escapeHtml(s.name)}</strong>${!s.active ? ' <span class="badge badge-gray" style="font-size:9px">Inactive</span>' : ''}${s.self_registered ? ' <span class="badge badge-green" style="font-size:9px">New</span>' : ''}</td>
              <td style="font-size:12px;color:var(--muted)">
                ${s.employee_id ? escapeHtml(s.employee_id) : '<span style="color:#c9880a">no ID</span>'}
                ${s.email ? '<br>' + escapeHtml(s.email) : ''}
              </td>
              <td>${(() => {
                const specs = (s.speciality || []).map(x => String(x || '').toUpperCase());
                const sec = (specs.includes('US') || specs.includes('ULTRASOUND')) ? 'US' : 'General';
                return `<span class="spec-tag ${sec.toLowerCase()}">${sec}</span>`;
              })()}</td>
              ${canEdit ? `<td>
                <button class="action-btn" onclick="openStaffModal(${s.id})">Edit</button>
                <button class="action-btn danger" onclick="deleteStaffConfirm(${s.id},'${jsAttr(s.name)}')">Delete</button>
              </td>` : ''}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    container.appendChild(section);
  });
}

function renderPendingRegs() {
  const box = document.getElementById('staff-pending');
  if (!box) return;
  if (!pendingRegs.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="card" style="margin-bottom:20px;border-color:rgba(255,159,67,.5)">
      <div style="font-size:14px;font-weight:700;color:var(--primary);margin-bottom:4px">⏳ Pending registrations (${pendingRegs.length})</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px">Staff who registered themselves — approve to add them, or reject.</div>
      <div class="table-wrap" style="border-radius:10px">
        <table>
          <thead><tr><th>Name</th><th>Branch</th><th>Section</th><th>ID</th><th>National ID</th><th>Email / Mobile</th><th>Actions</th></tr></thead>
          <tbody>${pendingRegs.map(r => `
            <tr>
              <td><strong>${escapeHtml(r.name)}</strong>${r.name_ar ? `<br><span style="font-size:11px;color:var(--muted)">${escapeHtml(r.name_ar)}</span>` : ''}</td>
              <td style="font-size:12px;color:var(--muted)">${escapeHtml(r.branch_name || '—')}</td>
              <td><span class="spec-tag ${(r.section||'General').toLowerCase()}">${escapeHtml(r.section || 'General')}</span></td>
              <td style="font-size:12px">${escapeHtml(r.employee_id || '—')}</td>
              <td style="font-size:12px">${r.national_id ? `${escapeHtml(r.national_id)} <span title="Verified with Nafath" style="color:#1a9d6a">✓</span>` : '<span style="color:var(--muted)">—</span>'}</td>
              <td style="font-size:12px;color:var(--muted)">${escapeHtml(r.email || '—')}${r.phone ? '<br>' + escapeHtml(r.phone) : ''}</td>
              <td style="white-space:nowrap">
                <button class="action-btn" onclick="approveReg(${r.id})">Approve</button>
                <button class="action-btn danger" onclick="rejectReg(${r.id})">Reject</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function approveReg(id) {
  showLoader('Approving…');
  try {
    await API.post(`/registrations/${id}/approve`, {});
    pendingRegs = pendingRegs.filter(r => r.id !== id);
    await loadStaff();
    renderStaffPage();
    toast('Registration approved — staff added');
  } catch (e) { toast(e.message, 'err'); }
  finally { hideLoader(); }
}

async function rejectReg(id) {
  const ok = await showConfirm('Reject registration', 'Reject this self-registration?');
  if (!ok) return;
  showLoader('Rejecting…');
  try {
    await API.post(`/registrations/${id}/reject`, {});
    pendingRegs = pendingRegs.filter(r => r.id !== id);
    renderPendingRegs();
    toast('Registration rejected');
  } catch (e) { toast(e.message, 'err'); }
  finally { hideLoader(); }
}

let _editStaffId = null;
function openStaffModal(id) {
  _editStaffId = id || null;
  const s = id ? allStaff.find(x => x.id === id) : null;
  document.getElementById('staff-modal-title').textContent = id ? 'Edit Staff' : 'Add Staff';
  document.getElementById('staff-edit-id').value = id || '';
  document.getElementById('staff-name').value    = s?.name || '';
  const eidEl = document.getElementById('staff-empid'); if (eidEl) eidEl.value = s?.employee_id || '';
  const emEl  = document.getElementById('staff-email'); if (emEl)  emEl.value  = s?.email || '';
  const phEl  = document.getElementById('staff-phone'); if (phEl)  phEl.value  = s?.phone || '';
  document.getElementById('staff-msg').textContent = '';

  // Branch select — cross-branch roles (superadmin, manager) see all branches;
  // a team lead is pinned to their own.
  const bs = document.getElementById('staff-branch');
  bs.innerHTML = '';
  const branches = ['superadmin','manager'].includes(currentUser?.role)
    ? allBranches
    : allBranches.filter(b => b.id === currentUser?.branch_id);
  branches.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id; opt.textContent = b.name;
    if (s?.branch_id === b.id || (!s && b.id === currentUser?.branch_id)) opt.selected = true;
    bs.appendChild(opt);
  });

  // Section select (stored in DB as speciality[0])
  const specs = (s?.speciality || []).map(x => String(x || '').toUpperCase());
  const secEl = document.getElementById('staff-section');
  secEl.value = (specs.includes('US') || specs.includes('ULTRASOUND')) ? 'US' : 'General';

  const cr = document.getElementById('staff-can-report');
  if (cr) cr.checked = !!s?.can_report;

  document.getElementById('staff-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('staff-name').focus(), 50);
}
function closeStaffModal() {
  document.getElementById('staff-modal-overlay').classList.remove('open');
}
async function saveStaff() {
  const msg    = document.getElementById('staff-msg');
  const name   = document.getElementById('staff-name').value.trim();
  const bid    = document.getElementById('staff-branch').value;
  const section = document.getElementById('staff-section').value;
  const specs  = [section];

  if (!name) { msg.className = 'msg err'; msg.textContent = 'Name required'; return; }
  if (!specs[0]) { msg.className = 'msg err'; msg.textContent = 'Select a section'; return; }

  const body = { name, branch_id: bid ? Number(bid) : null, speciality: specs,
                 can_report: !!document.getElementById('staff-can-report')?.checked,
                 employee_id: document.getElementById('staff-empid')?.value.trim() || null,
                 email: document.getElementById('staff-email')?.value.trim() || null,
                 phone: document.getElementById('staff-phone')?.value.trim() || null };

  showLoader(_editStaffId ? 'Saving…' : 'Adding…');
  try {
    if (_editStaffId) {
      const s = await API.put(`/staff/${_editStaffId}`, body);
      const idx = allStaff.findIndex(x => x.id === _editStaffId);
      if (idx >= 0) allStaff[idx] = { ...allStaff[idx], ...s };
    } else {
      const s = await API.post('/staff', body);
      allStaff.push(s);
    }
    closeStaffModal();
    renderStaffPage();
    showSuccess(_editStaffId ? 'Staff updated' : 'Staff added');
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;
  } finally { hideLoader(); }
}
async function deleteStaffConfirm(id, name) {
  const ok = await showConfirm('Delete Staff', `Remove "${name}" from the system?`);
  if (!ok) return;
  showLoader('Removing…');
  try {
    await API.delete(`/staff/${id}`);
    allStaff = allStaff.filter(s => s.id !== id);
    renderStaffPage();
    toast('Staff removed');
  } catch (err) { toast(err.message, 'err'); }
  finally { hideLoader(); }
}
