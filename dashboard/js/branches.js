// ── Branches page ─────────────────────────────────────────────────────────────
let allBranches = [];

async function loadBranches() {
  allBranches = await API.get('/branches');
  return allBranches;
}

function renderBranchesPage() {
  setTopbar('Branches', 'Manage hospital branches / nests',
    currentUser?.role === 'superadmin'
      ? `<button class="btn btn-sm" onclick="openBranchModal()">+ Add Branch</button>` : ''
  );
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Hospital branches & nests', 'Branches', `<b>${allBranches.length}</b> branch${allBranches.length !== 1 ? 'es' : ''}`)}
    <div class="table-wrap" id="branches-wrap">
      <table>
        <thead><tr>
          <th>#</th><th>Branch Name</th><th>City</th><th>Shares staff</th><th>Created</th>
          ${currentUser?.role === 'superadmin' ? '<th>Actions</th>' : ''}
        </tr></thead>
        <tbody id="branches-tbody"></tbody>
      </table>
    </div>`;
  animateIn('branches-wrap');
  renderBranchesList();
}

function renderBranchesList() {
  const tb = document.getElementById('branches-tbody');
  if (!tb) return;
  if (!allBranches.length) {
    tb.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--muted)">No branches yet</td></tr>`;
    return;
  }
  tb.innerHTML = allBranches.map((b, i) => `
    <tr>
      <td>${i+1}</td>
      <td><strong>${escapeHtml(b.name)}</strong></td>
      <td>${b.city ? escapeHtml(b.city) : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${b.shares_staff ? '<span style="color:var(--accent,#6B4EFF);font-weight:700">✓ shares</span>' : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${b.created_at ? new Date(b.created_at).toLocaleDateString() : '—'}</td>
      ${currentUser?.role === 'superadmin' ? `
      <td>
        <button class="action-btn" onclick="openBranchModal(${b.id},'${b.name.replace(/'/g,"\\'")}')">Edit</button>
        <button class="action-btn danger" onclick="deleteBranchConfirm(${b.id},'${b.name.replace(/'/g,"\\'")}')">Delete</button>
      </td>` : ''}
    </tr>`).join('');
  revealTable('branches-wrap');
}

let _editBranchId = null;
function openBranchModal(id, name) {
  _editBranchId = id || null;
  const b = id ? allBranches.find(x => x.id === id) : null;
  document.getElementById('branch-modal-title').textContent = id ? 'Edit Branch' : 'Add Branch';
  document.getElementById('branch-name').value = name || '';
  document.getElementById('branch-city').value = b?.city || '';
  document.getElementById('branch-shares').checked = !!b?.shares_staff;
  document.getElementById('branch-need').value = b?.cover_need_per_day || 0;
  document.getElementById('branch-msg').textContent = '';
  document.getElementById('branch-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('branch-name').focus(), 50);
}
function closeBranchModal() {
  document.getElementById('branch-modal-overlay').classList.remove('open');
}
async function saveBranch() {
  const name = document.getElementById('branch-name').value.trim();
  const city = document.getElementById('branch-city').value.trim();
  const shares_staff = document.getElementById('branch-shares').checked;
  const cover_need_per_day = Math.max(0, parseInt(document.getElementById('branch-need').value) || 0);
  const msg  = document.getElementById('branch-msg');
  if (!name) { msg.className = 'msg err'; msg.textContent = 'Name required'; return; }
  try {
    if (_editBranchId) {
      const b = await API.put(`/branches/${_editBranchId}`, { name, city, shares_staff, cover_need_per_day });
      const idx = allBranches.findIndex(x => x.id === _editBranchId);
      if (idx >= 0) allBranches[idx] = b;
    } else {
      const b = await API.post('/branches', { name });
      if (city || shares_staff || cover_need_per_day) {
        const upd = await API.put(`/branches/${b.id}`, { name, city, shares_staff, cover_need_per_day });
        allBranches.push(upd);
      } else {
        allBranches.push(b);
      }
    }
    closeBranchModal();
    renderBranchesList();
    showSuccess(_editBranchId ? 'Branch updated' : 'Branch added');
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;
  }
}
async function deleteBranchConfirm(id, name) {
  const ok = await showConfirm('Delete Branch', `Delete "${name}"? This cannot be undone.`);
  if (!ok) return;
  try {
    await API.delete(`/branches/${id}`);
    allBranches = allBranches.filter(b => b.id !== id);
    renderBranchesList();
    toast('Branch deleted');
  } catch (err) { toast(err.message, 'err'); }
}
