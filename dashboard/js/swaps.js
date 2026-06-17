// ── Shift swaps page ──────────────────────────────────────────────────────────
let allSwaps = [];

async function loadSwaps() {
  const bid = document.getElementById('swap-filter-branch')?.value || '';
  const st  = document.getElementById('swap-filter-status')?.value || '';
  let params = [];
  if (bid) params.push(`branch_id=${bid}`);
  if (st)  params.push(`status=${st}`);
  allSwaps = await API.get(`/swaps${params.length ? '?' + params.join('&') : ''}`);
  return allSwaps;
}

function renderSwapsPage() {
  const canRequest = ['admin','superadmin'].includes(currentUser?.role);
  setTopbar('Shift Swaps', 'Request and approve shift exchanges',
    canRequest ? `<button class="btn btn-sm" onclick="openSwapModal()">+ Request Swap</button>` : ''
  );
  const isSuper = currentUser?.role === 'superadmin';
  const c = document.getElementById('content');
  c.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
      <select id="swap-filter-status" onchange="refreshSwaps()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:13px;background:var(--card-alt);color:var(--text);outline:none">
        <option value="">All statuses</option>
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="rejected">Rejected</option>
      </select>
      ${isSuper ? `<select id="swap-filter-branch" onchange="refreshSwaps()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:13px;background:var(--card-alt);color:var(--text);outline:none"><option value="">All Branches</option>${allBranches.map(b=>`<option value="${b.id}">${b.name}</option>`).join('')}</select>` : ''}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>#</th><th>Branch</th><th>Staff A</th><th>Date A</th><th></th><th>Staff B</th><th>Date B</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody id="swaps-tbody"></tbody>
      </table>
    </div>`;
  refreshSwaps();
}

async function refreshSwaps() {
  showLoader('Loading swaps…');
  try { await loadSwaps(); renderSwapsList(); }
  catch (e) { toast(e.message, 'err'); }
  finally { hideLoader(); }
}

function renderSwapsList() {
  const tb = document.getElementById('swaps-tbody');
  if (!tb) return;
  const isReviewer = ['manager','superadmin'].includes(currentUser?.role);
  if (!allSwaps.length) {
    tb.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--muted)">No swap requests</td></tr>`;
    return;
  }
  const badge = { pending:'badge-orange', approved:'badge-green', rejected:'badge-gray' };
  tb.innerHTML = allSwaps.map((s, i) => `
    <tr>
      <td style="color:var(--muted);font-size:12px;text-align:center">${i+1}</td>
      <td style="font-size:12px;color:var(--muted)">${s.branch_name || '—'}</td>
      <td style="font-weight:600">${escapeHtml(s.staff_a_name)}</td>
      <td>${fmtDateDisplay(s.date_a)}</td>
      <td style="text-align:center;color:var(--accent)">↔</td>
      <td style="font-weight:600">${escapeHtml(s.staff_b_name)}</td>
      <td>${fmtDateDisplay(s.date_b)}</td>
      <td><span class="badge ${badge[s.status]||'badge-gray'}">${s.status}</span></td>
      <td>${(isReviewer && s.status === 'pending') ? `
        <button class="action-btn" onclick="decideSwap(${s.id},'approved')">Approve</button>
        <button class="action-btn danger" onclick="decideSwap(${s.id},'rejected')">Reject</button>` : '—'}</td>
    </tr>`).join('');
}

async function decideSwap(id, status) {
  if (status === 'approved') {
    const ok = await showConfirm('Approve swap', 'This will exchange the two shifts on the schedule. Continue?', 'Approve', 'confirm-ok');
    if (!ok) return;
  }
  try {
    await API.put(`/swaps/${id}/status`, { status });
    toast(`Swap ${status}`);
    await refreshSwaps();
  } catch (e) { toast(e.message, 'err'); }
}

// ── Request modal ─────────────────────────────────────────────────────────────
function swapStaffOptions() {
  const filtered = ['superadmin','manager'].includes(currentUser?.role)
    ? allStaff
    : allStaff.filter(s => s.branch_id === currentUser?.branch_id);
  return '<option value="">Select staff…</option>' +
    filtered.map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.branch_name || '?')})</option>`).join('');
}

function openSwapModal() {
  document.getElementById('swap-a-staff').innerHTML = swapStaffOptions();
  document.getElementById('swap-b-staff').innerHTML = swapStaffOptions();
  const today = fmtDate(new Date());
  document.getElementById('swap-a-date').value = today;
  document.getElementById('swap-b-date').value = today;
  document.getElementById('swap-note').value = '';
  document.getElementById('swap-msg').textContent = '';
  document.getElementById('swap-modal-overlay').classList.add('open');
}

function closeSwapModal() {
  document.getElementById('swap-modal-overlay').classList.remove('open');
}

async function saveSwap() {
  const msg = document.getElementById('swap-msg');
  const btn = document.getElementById('swap-save-btn');
  const staff_a = document.getElementById('swap-a-staff').value;
  const date_a  = document.getElementById('swap-a-date').value;
  const staff_b = document.getElementById('swap-b-staff').value;
  const date_b  = document.getElementById('swap-b-date').value;
  const note    = document.getElementById('swap-note').value.trim();
  if (!staff_a || !staff_b) { msg.className='msg err'; msg.textContent='Pick both staff members'; return; }
  if (staff_a === staff_b && date_a === date_b) { msg.className='msg err'; msg.textContent='Pick two different shifts to swap'; return; }
  if (!date_a || !date_b) { msg.className='msg err'; msg.textContent='Both dates are required'; return; }
  msg.className='msg'; msg.textContent='';
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  try {
    await API.post('/swaps', { staff_a: Number(staff_a), date_a, staff_b: Number(staff_b), date_b, note });
    closeSwapModal();
    toast('Swap request submitted');
    if (currentPage === 'swaps') await refreshSwaps();
  } catch (e) {
    msg.className='msg err'; msg.textContent = e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Request'; }
  }
}
