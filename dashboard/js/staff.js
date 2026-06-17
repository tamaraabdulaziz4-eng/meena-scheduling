// ── Staff page ────────────────────────────────────────────────────────────────
let allStaff = [];

async function loadStaff() {
  allStaff = await API.get('/staff');
  return allStaff;
}

function renderStaffPage() {
  // Managers manage staff too (backend require_admin allows admin/superadmin/manager).
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
    <div style="display:flex;flex-direction:column;gap:20px" id="staff-branch-sections"></div>`;

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
            <th>#</th><th>Name</th><th>Section</th>
            ${canEdit ? '<th>Actions</th>' : ''}
          </tr></thead>
          <tbody>${staff.map((s, i) => `
            <tr>
              <td>${i+1}</td>
              <td><strong>${escapeHtml(s.name)}</strong>${!s.active ? ' <span class="badge badge-gray" style="font-size:9px">Inactive</span>' : ''}</td>
              <td>${(() => {
                const specs = (s.speciality || []).map(x => String(x || '').toUpperCase());
                const sec = (specs.includes('US') || specs.includes('ULTRASOUND')) ? 'US' : 'General';
                return `<span class="spec-tag ${sec.toLowerCase()}">${sec}</span>`;
              })()}</td>
              ${canEdit ? `<td>
                <button class="action-btn" onclick="openStaffModal(${s.id})">Edit</button>
                <button class="action-btn danger" onclick="deleteStaffConfirm(${s.id},'${s.name.replace(/'/g,"\\'")}')">Delete</button>
              </td>` : ''}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    container.appendChild(section);
  });
}

let _editStaffId = null;
function openStaffModal(id) {
  _editStaffId = id || null;
  const s = id ? allStaff.find(x => x.id === id) : null;
  document.getElementById('staff-modal-title').textContent = id ? 'Edit Staff' : 'Add Staff';
  document.getElementById('staff-edit-id').value = id || '';
  document.getElementById('staff-name').value    = s?.name || '';
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
                 can_report: !!document.getElementById('staff-can-report')?.checked };

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
  }
}
async function deleteStaffConfirm(id, name) {
  const ok = await showConfirm('Delete Staff', `Remove "${name}" from the system?`);
  if (!ok) return;
  try {
    await API.delete(`/staff/${id}`);
    allStaff = allStaff.filter(s => s.id !== id);
    renderStaffPage();
    toast('Staff removed');
  } catch (err) { toast(err.message, 'err'); }
}
