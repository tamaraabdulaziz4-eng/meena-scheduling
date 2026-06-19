// ── Users page ────────────────────────────────────────────────────────────────
let allUsers = [];

async function loadUsers() {
  if (currentUser?.role !== 'superadmin') return;
  allUsers = await API.get('/users');
}

function renderUsersPage() {
  setTopbar('Users', 'Manage system users',
    `<button class="btn btn-sm" onclick="openUserModal()">+ Add User</button>`
  );
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Accounts, roles & access', 'Users')}
    <div class="table-wrap" id="users-wrap">
      <table>
        <thead><tr><th>#</th><th>Username</th><th>Role</th><th>Branch</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody id="users-tbody"></tbody>
      </table>
    </div>
    ${currentUser?.role === 'superadmin' ? `
    <div class="danger-zone">
      <div class="dz-head">⚠️ Danger zone</div>
      <p class="dz-text">Clear all test data for a clean production start. This removes staff,
        schedules, leave, swaps, daily cases, sign-ups, notifications and every non-superadmin
        login. It <b>keeps</b> branches, shift types, nest sections, holidays, settings and your
        admin account. This cannot be undone.</p>
      <button class="btn btn-sm btn-danger" onclick="clearTestData()">Clear all test data</button>
    </div>` : ''}`;
  renderUsersList();
}

const ROLE_BADGE = {
  superadmin: '<span class="badge badge-purple">Superadmin</span>',
  manager:    '<span class="badge badge-purple">Manager</span>',
  admin:      '<span class="badge badge-yellow">Admin</span>',
  staff:      '<span class="badge badge-green">Staff</span>',
  viewer:     '<span class="badge badge-gray">Viewer</span>',
};

function renderUsersList() {
  const tb = document.getElementById('users-tbody');
  if (!tb) return;
  if (!allUsers.length) {
    tb.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--muted)">No users</td></tr>`;
    return;
  }
  tb.innerHTML = allUsers.map((u, i) => `
    <tr>
      <td>${i+1}</td>
      <td><strong>${escapeHtml(u.username)}</strong></td>
      <td>${ROLE_BADGE[u.role] || escapeHtml(u.role)}</td>
      <td>${escapeHtml(u.branch_name || '—')}</td>
      <td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
      <td>
        <button class="action-btn" onclick="openUserModal(${u.id})">Edit</button>
        ${u.id !== currentUser?.id
          ? `<button class="action-btn danger" onclick="deleteUserConfirm(${u.id},'${u.username.replace(/'/g,"\\'")}')">Delete</button>`
          : '<span style="font-size:11px;color:var(--muted)">(you)</span>'}
      </td>
    </tr>`).join('');
}

// Wipe test/operational data for a clean production start (superadmin only).
// Two confirmations + an exact "RESET" token so it can't fire by accident.
async function clearTestData() {
  const ok1 = await showConfirm('Clear all test data',
    'This deletes staff, schedules, leave, swaps, daily cases, sign-ups, notifications and all non-superadmin logins. Branches, shift types, nest sections, holidays, settings and your admin account are kept. This cannot be undone.',
    'Continue');
  if (!ok1) return;
  const ok2 = await showConfirm('Are you absolutely sure?',
    'Last chance — everything above will be permanently erased so you can set up fresh.',
    'Yes, clear it');
  if (!ok2) return;
  showLoader('Clearing data…');
  try {
    const r = await API.post('/admin/reset-data', { confirm: 'RESET' });
    const total = Object.values(r.deleted || {}).reduce((a, b) => a + (b || 0), 0);
    toast(`Cleared ${total} record${total !== 1 ? 's' : ''} — ready for a fresh setup`);
    await loadUsers();
    renderUsersPage();
  } catch (e) {
    toast(e.message || 'Reset failed', 'err');
  } finally { hideLoader(); }
}

let _editUserId = null;
function openUserModal(id) {
  _editUserId = id || null;
  const u = id ? allUsers.find(x => x.id === id) : null;
  document.getElementById('user-modal-title').textContent = id ? 'Edit User' : 'Create User';
  document.getElementById('user-edit-id').value   = id || '';
  document.getElementById('user-username').value  = u?.username || '';
  document.getElementById('user-password').value  = '';
  document.getElementById('user-email').value     = u?.email || '';
  document.getElementById('user-email-notif').checked = u ? (u.email_notifications !== false) : true;
  document.getElementById('user-role').value      = u?.role || 'viewer';
  document.getElementById('user-pw-hint').style.display = id ? 'inline' : 'none';
  document.getElementById('user-pw-hint').textContent   = id ? '(leave blank to keep current)' : '(required)';
  document.getElementById('user-msg').textContent = '';

  // Populate branch select
  const bs = document.getElementById('user-branch');
  bs.innerHTML = '<option value="">— All branches —</option>';
  allBranches.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id; opt.textContent = b.name;
    if (u?.branch_id === b.id) opt.selected = true;
    bs.appendChild(opt);
  });

  // Populate the linked-staff select (used only for the Staff role)
  const ss = document.getElementById('user-staff');
  if (ss) {
    ss.innerHTML = '<option value="">Select staff…</option>';
    (allStaff || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = `${s.name} (${s.branch_name || '?'})`;  // textContent — safe
      if (u?.staff_id === s.id) opt.selected = true;
      ss.appendChild(opt);
    });
  }

  toggleUserBranch();
  document.getElementById('user-modal-overlay').classList.add('open');
}
function closeUserModal() {
  document.getElementById('user-modal-overlay').classList.remove('open');
}
function toggleUserBranch() {
  const role = document.getElementById('user-role').value;
  const isStaff = role === 'staff';
  // A staff account picks a staff member (its branch follows that record), so
  // hide the manual branch picker; show the staff picker instead.
  document.getElementById('user-branch-wrap').style.display =
    (['superadmin','manager'].includes(role) || isStaff) ? 'none' : 'flex';
  const sw = document.getElementById('user-staff-wrap');
  if (sw) sw.style.display = isStaff ? 'block' : 'none';
}
async function saveUser() {
  const msg      = document.getElementById('user-msg');
  const username = document.getElementById('user-username').value.trim();
  const password = document.getElementById('user-password').value;
  const role     = document.getElementById('user-role').value;
  const branch_id = document.getElementById('user-branch').value || null;
  const staff_id  = document.getElementById('user-staff')?.value || null;

  if (!username) { msg.className = 'msg err'; msg.textContent = 'Username required'; return; }
  if (!_editUserId && !password) { msg.className = 'msg err'; msg.textContent = 'Password required'; return; }
  if (role === 'staff' && !staff_id) { msg.className = 'msg err'; msg.textContent = 'Pick the staff member this account belongs to'; return; }

  try {
    const body = { username, role, branch_id: branch_id ? Number(branch_id) : null,
                   email: document.getElementById('user-email').value.trim(),
                   email_notifications: !!document.getElementById('user-email-notif').checked };
    if (role === 'staff') body.staff_id = Number(staff_id);
    if (password) body.password = password;

    if (_editUserId) {
      const u = await API.put(`/users/${_editUserId}`, body);
      const idx = allUsers.findIndex(x => x.id === _editUserId);
      if (idx >= 0) allUsers[idx] = { ...allUsers[idx], ...u };
    } else {
      const u = await API.post('/users', body);
      allUsers.push(u);
    }
    closeUserModal();
    renderUsersList();
    showSuccess(_editUserId ? 'User updated' : 'User created');
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;
  }
}
async function deleteUserConfirm(id, username) {
  const ok = await showConfirm('Delete User', `Delete "${username}"?`);
  if (!ok) return;
  try {
    await API.delete(`/users/${id}`);
    allUsers = allUsers.filter(u => u.id !== id);
    renderUsersList();
    toast('User deleted');
  } catch (err) { toast(err.message, 'err'); }
}
