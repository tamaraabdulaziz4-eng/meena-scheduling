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
  // Anyone but a plain viewer can start a swap — a staff member requests with a
  // colleague; team leads/managers may also raise one on someone's behalf.
  const canRequest = currentUser?.role && currentUser.role !== 'viewer';
  setTopbar('Shift Swaps', 'Request and approve shift exchanges',
    canRequest ? `<button class="btn btn-sm" onclick="openSwapModal()">+ Request Swap</button>` : ''
  );
  // Cross-branch roles get a branch filter.
  const crossBranch = ['superadmin','manager'].includes(currentUser?.role);
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="cc">
    ${pageHero('Request & approve shift exchanges', 'Shift Swaps')}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
      <select id="swap-filter-status" onchange="refreshSwaps()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:13px;background:var(--card-alt);color:var(--text);outline:none">
        <option value="">All statuses</option>
        <option value="pending_peer">Awaiting colleague</option>
        <option value="pending_lead">Awaiting team lead</option>
        <option value="pending_manager">Awaiting manager</option>
        <option value="approved">Approved</option>
        <option value="rejected">Rejected</option>
      </select>
      ${crossBranch ? `<select id="swap-filter-branch" onchange="refreshSwaps()" style="border:1.5px solid var(--border);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:13px;background:var(--card-alt);color:var(--text);outline:none"><option value="">All Branches</option>${allBranches.map(b=>`<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')}</select>` : ''}
    </div>
    <div class="board">
      <div class="bhead">
        <div class="bhrow">
          <div class="btitle">Swap requests <span>colleague → team lead → manager</span></div>
        </div>
      </div>
      <div class="rows" id="swaps-tbody"></div>
    </div>
    </div>`;
  refreshSwaps();
}

async function refreshSwaps() {
  const tb = document.getElementById('swaps-tbody');
  if (tb) tb.innerHTML = `<div style="padding:16px">${LOADING_HTML}</div>`;
  try { await loadSwaps(); renderSwapsList(); animateIn('swaps-tbody'); }
  catch (e) { if (tb) tb.innerHTML = `<div style="text-align:center;color:var(--muted);padding:20px">${escapeHtml(e.message||'Failed to load')}</div>`; }
}

// The 3-step approval chain, rendered as a stepper.
const SWAP_STEP_ORDER = ['pending_peer', 'pending_lead', 'pending_manager', 'approved'];
function swapStepper(s) {
  // Each step: done if the swap has moved past it.
  const idx = SWAP_STEP_ORDER.indexOf(s.status);
  const rejected = s.status === 'rejected';
  const steps = [
    { key: 'peer',    label: 'Colleague',  when: s.peer_at, who: s.staff_b_name },
    { key: 'lead',    label: 'Team Lead',  when: s.lead_at, who: s.lead_name },
    { key: 'manager', label: 'Manager',    when: s.mgr_at,  who: s.mgr_name },
  ];
  return `<div class="swap-stepper">` + steps.map((step, i) => {
    // step i is "done" once status index > i (peer done at pending_lead=1, etc.)
    const done = idx > i;
    const current = !rejected && idx === i;
    const cls = done ? 'done' : (current ? 'current' : '');
    const mark = done ? '✓' : (current ? '●' : '○');
    const sub = done && step.who ? escapeHtml(step.who) : (current ? 'waiting' : '');
    return `<span class="swap-step ${cls}" title="${step.label}${sub?': '+sub:''}">
        <b>${mark}</b> ${step.label}${sub ? `<i>${sub}</i>` : ''}</span>`;
  }).join('<span class="swap-arrow">›</span>') + `</div>` +
  (rejected ? `<div class="swap-rejected">✕ Declined${s.reject_name ? ' by ' + escapeHtml(s.reject_name) : ''}${s.reject_note ? ' — ' + escapeHtml(s.reject_note) : ''}</div>` : '');
}

// What action (if any) can the current user take on this swap right now?
function swapActionsFor(s) {
  const role = currentUser?.role;
  const myStaff = currentUser?.staff_id;
  const isSuper = role === 'superadmin';
  const isReviewer = ['manager','superadmin'].includes(role);
  const hasBranch = ADMIN_ROLES.includes(role); // branch enforced server-side
  let primary = null;  // {label}
  if (s.status === 'pending_peer'    && ((role === 'staff' && myStaff === s.staff_b) || isSuper)) primary = 'Accept';
  else if (s.status === 'pending_lead'    && hasBranch) primary = 'Approve';
  else if (s.status === 'pending_manager' && isReviewer) primary = 'Approve';

  // Reject/cancel: peer, requester, branch lead/manager, or superadmin — while still open.
  const canReject = !['approved','rejected'].includes(s.status) &&
    (isSuper || hasBranch ||
     (role === 'staff' && (myStaff === s.staff_a || myStaff === s.staff_b)));
  const amRequester = role === 'staff' && myStaff === s.staff_a;

  let html = '';
  if (primary) html += `<button class="open" onclick="actSwap(${s.id},'${primary==='Accept'?'accept':'approve'}','${primary}')">${primary}</button> `;
  if (canReject) html += `<button class="ghost" onclick="actSwap(${s.id},'reject')" style="color:var(--danger,#E63946)">${amRequester && s.status==='pending_peer' ? 'Cancel' : 'Reject'}</button>`;
  return html || '<span style="font-size:11px;color:var(--muted)">—</span>';
}

// Clinical Calm dotted status pill for a swap's overall state.
function swapStatusPill(s) {
  const map = {
    pending_peer:    '<span class="ris scheduled"><span class="rd"></span>Awaiting colleague</span>',
    pending_lead:    '<span class="ris progress"><span class="rd"></span>Awaiting team lead</span>',
    pending_manager: '<span class="ris prelim"><span class="rd"></span>Awaiting manager</span>',
    approved:        '<span class="ris final"><span class="rd"></span>Approved</span>',
    rejected:        '<span class="sc no">✕ Rejected</span>',
  };
  return map[s.status] || `<span class="sc warn">${escapeHtml(s.status || '')}</span>`;
}

function renderSwapsList() {
  const tb = document.getElementById('swaps-tbody');
  if (!tb) return;
  if (!allSwaps.length) {
    tb.innerHTML = `<div style="text-align:center;padding:24px;color:var(--muted)">No swap requests</div>`;
    return;
  }
  tb.innerHTML = allSwaps.map((s, i) => `
    <div class="lrow">
      <div style="width:26px;text-align:center;color:var(--muted);font-size:12px;flex:none">${i+1}</div>
      <div style="flex:2;min-width:170px">
        <div style="font-weight:700">${escapeHtml(s.staff_a_name)} <span style="color:var(--accent)">↔</span> ${escapeHtml(s.staff_b_name)}</div>
        <div style="font-size:12px;color:var(--muted)">${fmtDateDisplay(s.date_a)} ↔ ${fmtDateDisplay(s.date_b)} · ${escapeHtml(s.branch_name || '—')}</div>
      </div>
      <div style="flex:2;min-width:200px">${swapStepper(s)}</div>
      <div style="flex:none">${swapStatusPill(s)}</div>
      <div style="white-space:nowrap;display:flex;gap:6px;flex:none">${swapActionsFor(s)}</div>
    </div>`).join('');
}

async function actSwap(id, action, label) {
  if (action === 'approve' || action === 'accept') {
    const ok = await showConfirm(`${label || 'Approve'} swap`,
      action === 'accept'
        ? 'Accept this shift swap with your colleague?'
        : 'Approve this step? Final manager approval will exchange the shifts.',
      label || 'Approve', 'confirm-ok');
    if (!ok) return;
  } else {
    const ok = await showConfirm('Reject swap', 'Decline this shift swap request?', 'Reject');
    if (!ok) return;
  }
  showLoader('Working…');
  try {
    await API.put(`/swaps/${id}/action`, { action });
    await refreshSwaps();
    toast('Done');
  } catch (e) { toast(e.message, 'err'); }
  finally { hideLoader(); }
}

// ── Request modal ─────────────────────────────────────────────────────────────
function swapStaffOptions() {
  const filtered = ['superadmin','manager'].includes(currentUser?.role)
    ? allStaff
    : allStaff.filter(s => s.branch_id === currentUser?.branch_id);
  return '<option value="">Select staff…</option>' +
    filtered.map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.branch_name || '?')})</option>`).join('');
}

async function openSwapModal() {
  const isStaff = currentUser?.role === 'staff';
  // Staff list may still be loading in the background — make sure it's ready.
  if (!allStaff || !allStaff.length) { try { await loadStaff(); } catch (e) {} }
  const aStaff = document.getElementById('swap-a-staff');
  const aField = aStaff.closest('.form-field');
  // A staff member is always "Staff A" (themselves) — hide that picker.
  if (aField) aField.style.display = isStaff ? 'none' : '';
  aStaff.innerHTML = swapStaffOptions();
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
  const isStaff = currentUser?.role === 'staff';
  const staff_a = isStaff ? (currentUser?.staff_id || '') : document.getElementById('swap-a-staff').value;
  const date_a  = document.getElementById('swap-a-date').value;
  const staff_b = document.getElementById('swap-b-staff').value;
  const date_b  = document.getElementById('swap-b-date').value;
  const note    = document.getElementById('swap-note').value.trim();
  if (!staff_a || !staff_b) { msg.className='msg err'; msg.textContent='Pick the colleague to swap with'; return; }
  if (String(staff_a) === String(staff_b)) { msg.className='msg err'; msg.textContent='Pick a different colleague'; return; }
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
