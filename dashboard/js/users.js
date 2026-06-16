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
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Username</th><th>Role</th><th>Branch</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody id="users-tbody"></tbody>
      </table>
    </div>`;
  renderUsersList();
}

const ROLE_BADGE = {
  superadmin: '<span class="badge badge-purple">Superadmin</span>',
  manager:    '<span class="badge badge-purple">Manager</span>',
  admin:      '<span class="badge badge-yellow">Admin</span>',
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
      <td><strong>${u.username}</strong></td>
      <td>${ROLE_BADGE[u.role] || u.role}</td>
      <td>${u.branch_name || '—'}</td>
      <td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
      <td>
        <button class="action-btn" onclick="openUserModal(${u.id})">Edit</button>
        ${u.id !== currentUser?.id
          ? `<button class="action-btn danger" onclick="deleteUserConfirm(${u.id},'${u.username.replace(/'/g,"\\'")}')">Delete</button>`
          : '<span style="font-size:11px;color:var(--muted)">(you)</span>'}
      </td>
    </tr>`).join('');
}

let _editUserId = null;
function openUserModal(id) {
  _editUserId = id || null;
  const u = id ? allUsers.find(x => x.id === id) : null;
  document.getElementById('user-modal-title').textContent = id ? 'Edit User' : 'Create User';
  document.getElementById('user-edit-id').value   = id || '';
  document.getElementById('user-username').value  = u?.username || '';
  document.getElementById('user-password').value  = '';
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

  toggleUserBranch();
  document.getElementById('user-modal-overlay').classList.add('open');
}
function closeUserModal() {
  document.getElementById('user-modal-overlay').classList.remove('open');
}
function toggleUserBranch() {
  const role = document.getElementById('user-role').value;
  // Superadmin and manager are cross-branch, so no single branch to assign.
  document.getElementById('user-branch-wrap').style.display =
    ['superadmin','manager'].includes(role) ? 'none' : 'flex';
}
async function saveUser() {
  const msg      = document.getElementById('user-msg');
  const username = document.getElementById('user-username').value.trim();
  const password = document.getElementById('user-password').value;
  const role     = document.getElementById('user-role').value;
  const branch_id = document.getElementById('user-branch').value || null;

  if (!username) { msg.className = 'msg err'; msg.textContent = 'Username required'; return; }
  if (!_editUserId && !password) { msg.className = 'msg err'; msg.textContent = 'Password required'; return; }

  try {
    const body = { username, role, branch_id: branch_id ? Number(branch_id) : null };
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
