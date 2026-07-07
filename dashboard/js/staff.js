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
    <div class="cc">
    ${pageHero('Radiology team directory', 'Staff', `<b>${allStaff.length}</b> member${allStaff.length !== 1 ? 's' : ''}`)}
    ${canEdit ? `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px">
      <button class="ghost" onclick="printStaffDirectory()">🖨️ PDF</button>
      <button class="ghost" onclick="exportStaffCsv()">⬇️ Export CSV</button></div>` : ''}
    <div id="staff-eotm"></div>
    <div id="staff-pending"></div>
    <div style="display:flex;flex-direction:column;gap:20px" id="staff-branch-sections"></div>
    </div>`;

  if (typeof renderHomeEotm === 'function') renderHomeEotm('staff-eotm');   // Employee of the Month moved here from Home
  if (canEdit) renderPendingRegs();
  const container = document.getElementById('staff-branch-sections');
  if (!allStaff.length) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">👥</div><p>No staff added yet</p><small>Add staff members to get started</small></div>`;
    return;
  }

  Object.entries(byBranch).forEach(([branch, staff]) => {
    const section = document.createElement('div');
    section.className = 'board';
    section.innerHTML = `
      <div class="bhead">
        <div class="bhrow">
          <div class="btitle">${escapeHtml(branch)} <span>${staff.length} staff member${staff.length!==1?'s':''}</span></div>
        </div>
      </div>
      <div class="rows">${staff.map((s, i) => {
        const specs = (s.speciality || []).map(x => String(x || '').toUpperCase());
        const sec = (specs.includes('US') || specs.includes('ULTRASOUND')) ? 'US' : 'General';
        return `
        <div class="lrow">
          <div style="width:26px;text-align:center;color:var(--muted);font-size:12px;flex:none">${i+1}</div>
          <div style="flex:2;min-width:160px">
            <div style="font-weight:700">${escapeHtml(s.name)}</div>
            <div style="font-size:11.5px;color:var(--muted)">
              ${s.employee_id ? escapeHtml(s.employee_id) : '<span style="color:#c9880a">no ID</span>'}${s.email ? ' · ' + escapeHtml(s.email) : ''}
            </div>
          </div>
          <div style="flex:1;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <span class="sc ${sec === 'US' ? 'ok' : 'warn'}">${sec}</span>
            ${s.active
              ? '<span class="ris completed"><span class="rd"></span>Active</span>'
              : '<span class="sc no">Inactive</span>'}
            ${s.self_registered ? '<span class="sc ok">New</span>' : ''}
          </div>
          ${canEdit ? `<div style="display:flex;gap:6px;white-space:nowrap;flex:none">
            <button class="ghost" onclick="openStaffModal(${s.id})">Edit</button>
            <button class="ghost" onclick="deleteStaffConfirm(${s.id},'${jsAttr(s.name)}')" style="color:var(--danger,#E63946)">Delete</button>
          </div>` : ''}
        </div>`;
      }).join('')}
      </div>`;
    container.appendChild(section);
  });
}

function renderPendingRegs() {
  const box = document.getElementById('staff-pending');
  if (!box) return;
  if (!pendingRegs.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="board" style="margin-bottom:20px">
      <div class="bhead">
        <div class="bhrow">
          <div class="btitle">⏳ Pending registrations (${pendingRegs.length}) <span>Staff who registered themselves — approve to add them, or reject.</span></div>
        </div>
      </div>
      <div class="rows">${pendingRegs.map(r => `
        <div class="lrow">
          <div style="flex:2;min-width:150px">
            <div style="font-weight:700">${escapeHtml(r.name)}</div>
            ${r.name_ar ? `<div style="font-size:11px;color:var(--muted)">${escapeHtml(r.name_ar)}</div>` : ''}
            <div style="font-size:11.5px;color:var(--muted)">${escapeHtml(r.branch_name || '—')}</div>
          </div>
          <div style="flex:1;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <span class="sc ${String(r.section || 'General').toUpperCase() === 'US' ? 'ok' : 'warn'}">${escapeHtml(r.section || 'General')}</span>
            <span class="ris progress"><span class="rd"></span>Pending</span>
          </div>
          <div style="flex:2;min-width:150px;font-size:12px;color:var(--muted)">
            <div>ID: ${escapeHtml(r.employee_id || '—')}</div>
            <div>National ID: ${r.national_id ? `${escapeHtml(r.national_id)} <span title="Verified with Nafath" style="color:#1a9d6a">✓</span>` : '—'}</div>
            <div>${escapeHtml(r.email || '—')}${r.phone ? ' · ' + escapeHtml(r.phone) : ''}</div>
          </div>
          <div style="display:flex;gap:6px;white-space:nowrap;flex:none">
            <button class="open" onclick="approveReg(${r.id})">Approve</button>
            <button class="ghost" onclick="rejectReg(${r.id})" style="color:var(--danger,#E63946)">Reject</button>
          </div>
        </div>`).join('')}
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

// Export the full staff directory (name, ID, email, phone, branch, section) as a
// CSV. Uses the already-loaded list — no backend call. BOM keeps Arabic readable
// in Excel.
function exportStaffCsv() {
  if (!allStaff || !allStaff.length) { toast('No staff to export', 'err'); return; }
  const esc = v => { const s = (v == null ? '' : String(v)).replace(/"/g, '""'); return /[",\n]/.test(s) ? `"${s}"` : s; };
  const rows = [['Name', 'Employee ID', 'Email', 'Phone', 'Branch', 'Section', 'Active']];
  allStaff.forEach(s => {
    const specs = (s.speciality || []).map(x => String(x || '').toUpperCase());
    const sec = (specs.includes('US') || specs.includes('ULTRASOUND')) ? 'US' : 'General';
    rows.push([s.name, s.employee_id, s.email, s.phone, (s.branch_name || s.branch || ''), sec, s.active === false ? 'No' : 'Yes']);
  });
  const csv = '﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `radiology_staff_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  toast(`Exported ${allStaff.length} staff`);
}

// Printable PDF of the whole staff directory (name, ID, email, phone, section),
// grouped by branch, with a letterhead. Opens the print dialog → Save as PDF.
function printStaffDirectory() {
  if (!allStaff || !allStaff.length) { toast('No staff to export', 'err'); return; }
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const sectionOf = s => { const sp = (s.speciality || []).map(x => String(x || '').toUpperCase()); return (sp.includes('US') || sp.includes('ULTRASOUND')) ? 'US' : 'General'; };
  const byBranch = {};
  allStaff.forEach(s => { const k = s.branch_name || 'Unassigned'; (byBranch[k] = byBranch[k] || []).push(s); });
  let body = '';
  Object.entries(byBranch).forEach(([branch, staff]) => {
    body += `<h2>${escapeHtml(branch)} <span class="cnt">${staff.length}</span></h2>
      <table><thead><tr><th>#</th><th>Name</th><th>ID</th><th>Email</th><th>Phone</th><th>Section</th></tr></thead><tbody>` +
      staff.map((s, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(s.name || '')}</td><td>${escapeHtml(s.employee_id || '')}</td><td>${escapeHtml(s.email || '')}</td><td>${escapeHtml(s.phone || '')}</td><td>${sectionOf(s)}</td></tr>`).join('') +
      `</tbody></table>`;
  });
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to export the PDF', 'err'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Radiology Staff — ${today}</title>
    <style>*{box-sizing:border-box}body{font-family:'Poppins',system-ui,Arial,sans-serif;color:#2B2458;margin:0;padding:28px 30px}
    .hd{display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #6B4EFF;padding-bottom:12px;margin-bottom:16px}
    .hd img{height:34px}.hd .t{text-align:right}.hd .t b{font-size:16px}.hd .t div{font-size:11px;color:#8585A8}
    h1{font-size:18px;margin:4px 0}.sub{color:#8585A8;font-size:12px;margin-bottom:16px}
    h2{font-size:13px;margin:16px 0 6px;color:#6B4EFF}h2 .cnt{background:#efeafe;color:#6B4EFF;border-radius:10px;padding:1px 8px;font-size:10px;margin-inline-start:6px}
    table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:6px}
    th{background:#f4f1fb;color:#5b5b78;text-align:left;padding:6px 8px;font-size:10px;text-transform:uppercase}
    td{padding:6px 8px;border-bottom:1px solid #eee}tr:nth-child(even) td{background:#fafafe}
    .foot{margin-top:18px;font-size:10px;color:#9a95ba;text-align:center;border-top:1px solid #eee;padding-top:8px}
    @media print{body{padding:0}}</style></head><body>
    <div class="hd"><img src="/meena_logo.png" onerror="this.style.display='none'"><div class="t"><b>Radiology Staff Directory</b><div>دليل موظفي الأشعة</div></div></div>
    <h1>Staff Directory</h1><div class="sub">${allStaff.length} members · Generated ${today}</div>
    ${body}<div class="foot">Meena Health · ${today}</div>
    <script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script></body></html>`);
  w.document.close();
}
