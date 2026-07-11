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
    <div class="cc">
    ${pageHero('Accounts, roles & access', 'Users')}
    <div class="board" id="users-wrap">
      <div class="bhead"><div class="bhrow">
        <div class="btitle">Users <span>${allUsers.length} account${allUsers.length !== 1 ? 's' : ''}</span></div>
        <div class="bh-actions"><button class="open pri" onclick="openUserModal()">+ Add User</button></div>
      </div></div>
      <div class="rows" id="users-rows"></div>
    </div>
    ${currentUser?.role === 'superadmin' ? `
    <div class="danger-zone">
      <div class="dz-head">⚠️ Danger zone</div>
      <p class="dz-text">Clear all test data for a clean production start. This removes staff,
        schedules, leave, swaps, daily cases, sign-ups, notifications and every non-superadmin
        login. It <b>keeps</b> branches, shift types, nest sections, holidays, settings and your
        admin account. This cannot be undone.</p>
      <button class="btn btn-sm btn-danger" onclick="clearTestData()">Clear all test data</button>
    </div>` : ''}
    </div>`;
  renderUsersList();
}

// Role → Clinical Calm dotted pill (.ris palette: final=violet, completed=green,
// progress=blue, scheduled=slate).
const ROLE_BADGE = {
  superadmin: '<span class="ris final"><span class="rd"></span>Superadmin</span>',
  manager:    '<span class="ris final"><span class="rd"></span>Manager</span>',
  admin:      '<span class="ris progress"><span class="rd"></span>Admin</span>',
  staff:      '<span class="ris completed"><span class="rd"></span>Staff</span>',
  viewer:     '<span class="ris scheduled"><span class="rd"></span>Viewer</span>',
};

function renderUsersList() {
  const tb = document.getElementById('users-rows');
  if (!tb) return;
  if (!allUsers.length) {
    tb.innerHTML = `<div class="lrow" style="text-align:center;padding:24px;color:var(--muted)">No users</div>`;
    return;
  }
  tb.innerHTML = allUsers.map((u, i) => `
    <div class="lrow" style="display:flex;align-items:center;gap:12px;padding:10px 18px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--muted);width:20px">${i+1}</span>
      <div style="flex:1;min-width:140px">
        <strong>${escapeHtml(u.username)}</strong>
        <div style="font-size:11.5px;color:var(--muted)">${escapeHtml(u.branch_name || 'All branches')} · created ${u.created_at ? new Date(u.created_at).toLocaleDateString('en-GB') : '—'}</div>
      </div>
      ${ROLE_BADGE[u.role] || escapeHtml(u.role)}
      <div style="display:flex;gap:6px">
        <button class="ghost" onclick="openUserModal(${u.id})">Edit</button>
        ${u.role !== 'superadmin' ? `<button class="ghost" onclick="openPermsModal(${u.id})">Permissions</button>` : ''}
        ${u.id !== currentUser?.id
          ? `<button class="ghost" style="color:var(--danger,#E25555)" onclick="deleteUserConfirm(${u.id},'${jsAttr(u.username)}')">Delete</button>`
          : '<span style="font-size:11px;color:var(--muted)">(you)</span>'}
      </div>
    </div>`).join('');
}

// ── Per-user permissions editor ───────────────────────────────────────────────
// A superadmin toggles any feature on/off for a user. The role sets the defaults; a
// toggle that DIFFERS from the role default is stored as an override (grant or revoke).
let _permCatalog = null;
async function permsCatalog() {
  if (!_permCatalog) _permCatalog = await API.get('/permissions/catalog');
  return _permCatalog;
}
async function openPermsModal(id) {
  const u = allUsers.find(x => x.id === id);
  if (!u) return;
  let cat;
  try { cat = await permsCatalog(); } catch (e) { toast('Could not load the permission list', 'err'); return; }
  const roleDef = new Set(u.role_perms || (cat.roleDefaults[u.role] || []));
  const eff = new Set(u.perms || []);
  const override = (u.permissions && typeof u.permissions === 'object') ? u.permissions : {};
  const grid = cat.groups.map(g => `
    <div class="perm-grp">
      <div class="perm-grp-h">${escapeHtml(g.group)}</div>
      ${g.items.map(it => {
        const on = eff.has(it.key), def = roleDef.has(it.key), ov = it.key in override;
        const tag = ov ? (on ? 'granted' : 'revoked') : (def ? 'role default' : '');
        return `<label class="perm-row">
          <input type="checkbox" class="perm-cb" data-key="${it.key}" data-def="${def ? 1 : 0}" ${on ? 'checked' : ''}>
          <span class="perm-lbl">${escapeHtml(it.label)}</span>
          <span class="perm-tag ${ov ? (on ? 'g' : 'r') : ''}">${tag}</span>
        </label>`;
      }).join('')}
    </div>`).join('');
  const wrap = document.createElement('div');
  wrap.id = 'perms-modal-overlay';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  wrap.innerHTML = `<div class="card" style="max-width:600px;width:100%;max-height:88vh;display:flex;flex-direction:column;padding:0">
    <div style="display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--border)">
      <div style="flex:1"><div style="font-size:16px;font-weight:800">Permissions</div>
        <div style="font-size:12px;color:var(--muted)">${escapeHtml(u.username)} · ${escapeHtml(u.role)}</div></div>
      <button class="ghost" onclick="document.getElementById('perms-modal-overlay').remove()">✕</button>
    </div>
    <div style="padding:14px 18px;overflow:auto">
      <p style="font-size:12.5px;color:var(--muted);margin:0 0 12px">Toggle any feature for <b>${escapeHtml(u.username)}</b>. “Role default” means their <b>${escapeHtml(u.role)}</b> role already grants it — unticking removes it just for this user; ticking an extra feature grants it just to them.</p>
      <div class="perm-grid">${grid}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:14px 18px;border-top:1px solid var(--border)">
      <button class="ghost" onclick="permsResetToRole()">Reset to role default</button>
      <span style="flex:1"></span>
      <button class="ghost" onclick="document.getElementById('perms-modal-overlay').remove()">Cancel</button>
      <button class="open pri" onclick="savePerms(${u.id})">Save</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
}
function permsResetToRole() {
  document.querySelectorAll('#perms-modal-overlay .perm-cb').forEach(cb => { cb.checked = cb.dataset.def === '1'; });
}
async function savePerms(id) {
  const override = {};
  document.querySelectorAll('#perms-modal-overlay .perm-cb').forEach(cb => {
    const desired = cb.checked, def = cb.dataset.def === '1';
    if (desired !== def) override[cb.dataset.key] = desired;   // store ONLY real overrides
  });
  try {
    await API.put(`/users/${id}`, { permissions: override });
    toast('Permissions updated');
    document.getElementById('perms-modal-overlay')?.remove();
    await loadUsers();
    renderUsersList();
  } catch (e) { toast(e.message || 'Save failed', 'err'); }
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
  const ru = document.getElementById('user-raduse'); if (ru) ru.checked = !!(u && (u.can_use_radiology || u.can_file_radiology));
  const rf = document.getElementById('user-radfile'); if (rf) rf.checked = !!(u && u.can_file_radiology);
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
  // The radiology privileges only matter for a staff member (team leads and up have
  // radiology by role); hide them for other roles.
  const uw = document.getElementById('user-raduse-wrap');
  if (uw) uw.style.display = isStaff ? 'block' : 'none';
  const rw = document.getElementById('user-radfile-wrap');
  if (rw) rw.style.display = isStaff ? 'block' : 'none';
}
// Filing implies access — enabling "can use" is required to file, and ticking file
// auto-ticks use.
function onRadUseToggle() {
  const ru = document.getElementById('user-raduse'), rf = document.getElementById('user-radfile');
  if (ru && rf && !ru.checked) rf.checked = false;   // no access → can't file
}
function onRadFileToggle() {
  const ru = document.getElementById('user-raduse'), rf = document.getElementById('user-radfile');
  if (ru && rf && rf.checked) ru.checked = true;     // filing implies access
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
    if (role === 'staff') {
      body.staff_id = Number(staff_id);
      const canFile = !!document.getElementById('user-radfile')?.checked;
      // Filing implies access — never store "can file" without "can use".
      body.can_use_radiology = !!document.getElementById('user-raduse')?.checked || canFile;
      body.can_file_radiology = canFile;
    }
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
