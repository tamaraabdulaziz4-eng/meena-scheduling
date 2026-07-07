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
    <div class="cc">
    ${pageHero('Hospital branches & nests', 'Branches', `<b>${allBranches.length}</b> branch${allBranches.length !== 1 ? 'es' : ''}`)}
    <div class="board" id="branches-wrap">
      <div class="bhead"><div class="bhrow">
        <div class="btitle">Branches <span>${allBranches.length} branch${allBranches.length !== 1 ? 'es' : ''}</span></div>
        ${currentUser?.role === 'superadmin' ? `<div class="bh-actions"><button class="open pri" onclick="openBranchModal()">+ Add Branch</button></div>` : ''}
      </div></div>
      <div class="rows" id="branches-rows"></div>
    </div>
    </div>`;
  animateIn('branches-wrap');
  renderBranchesList();
}

function renderBranchesList() {
  const tb = document.getElementById('branches-rows');
  if (!tb) return;
  if (!allBranches.length) {
    tb.innerHTML = `<div class="lrow" style="text-align:center;padding:24px;color:var(--muted)">No branches yet</div>`;
    return;
  }
  tb.innerHTML = allBranches.map((b, i) => `
    <div class="lrow" style="display:flex;align-items:center;gap:12px;padding:10px 18px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--muted);width:20px">${i+1}</span>
      <div style="flex:1;min-width:140px">
        <strong>${escapeHtml(b.name)}</strong>
        <div style="font-size:11.5px;color:var(--muted)">${b.city ? escapeHtml(b.city) : 'City not set'} · created ${b.created_at ? new Date(b.created_at).toLocaleDateString('en-GB') : '—'}</div>
      </div>
      ${b.shares_staff ? '<span class="sc ok">✓ shares staff</span>' : '<span class="sc">solo</span>'}
      ${currentUser?.role === 'superadmin' ? `
      <div style="display:flex;gap:6px">
        <button class="ghost" onclick="openBranchModal(${b.id},'${jsAttr(b.name)}')">Edit</button>
        <button class="ghost" style="color:var(--danger,#E25555)" onclick="deleteBranchConfirm(${b.id},'${jsAttr(b.name)}')">Delete</button>
      </div>` : ''}
    </div>`).join('');
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
  const ok = await showTypedConfirm('Delete Branch',
    `Deleting "${name}" also removes its schedules, staff links, and case reports. This cannot be undone.`,
    name);
  if (!ok) return;
  try {
    await API.delete(`/branches/${id}`);
    allBranches = allBranches.filter(b => b.id !== id);
    renderBranchesList();
    toast('Branch deleted');
  } catch (err) { toast(err.message, 'err'); }
}
