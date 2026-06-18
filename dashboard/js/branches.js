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
    <div class="table-wrap" id="branches-wrap">
      <table>
        <thead><tr>
          <th>#</th><th>Branch Name</th><th>Created</th>
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
    tb.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--muted)">No branches yet</td></tr>`;
    return;
  }
  tb.innerHTML = allBranches.map((b, i) => `
    <tr>
      <td>${i+1}</td>
      <td><strong>${escapeHtml(b.name)}</strong></td>
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
  document.getElementById('branch-modal-title').textContent = id ? 'Edit Branch' : 'Add Branch';
  document.getElementById('branch-name').value = name || '';
  document.getElementById('branch-msg').textContent = '';
  document.getElementById('branch-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('branch-name').focus(), 50);
}
function closeBranchModal() {
  document.getElementById('branch-modal-overlay').classList.remove('open');
}
async function saveBranch() {
  const name = document.getElementById('branch-name').value.trim();
  const msg  = document.getElementById('branch-msg');
  if (!name) { msg.className = 'msg err'; msg.textContent = 'Name required'; return; }
  try {
    if (_editBranchId) {
      const b = await API.put(`/branches/${_editBranchId}`, { name });
      const idx = allBranches.findIndex(x => x.id === _editBranchId);
      if (idx >= 0) allBranches[idx] = b;
    } else {
      const b = await API.post('/branches', { name });
      allBranches.push(b);
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
