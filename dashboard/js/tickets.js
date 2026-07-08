// ── Support tickets ───────────────────────────────────────────────────────────
// Staff raise an issue / fault / request; a team lead or manager escalates it and
// marks the action taken. Every status change notifies whoever raised it.

const TICKET_STATUS_META = {
  open:        { label: 'Open',        color: '#FF9F43' },
  escalated:   { label: 'Escalated',   color: 'var(--danger-ink,#e25555)' },
  in_progress: { label: 'In progress', color: '#5B8DEF' },
  resolved:    { label: 'Resolved',    color: '#2BAE66' },
  closed:      { label: 'Closed',      color: '#9a95ba' },
};
const TICKET_CATEGORY_META = {
  device_fault:   { label: 'Device fault',      icon: '' },
  pacs:           { label: 'PACS / imaging',    icon: '' },
  report_blocked: { label: 'Blocked report',    icon: '' },
  ovr:            { label: 'OVR / incident',    icon: '' },
  stock:          { label: 'Stock / supplies',  icon: '' },
  request:        { label: 'Request',           icon: '' },
  other:          { label: 'Other',             icon: '' },
  // legacy values kept for older tickets
  issue:          { label: 'Issue',             icon: '' },
  fault:          { label: 'Fault',             icon: '' },
};
const TICKET_PRIORITY_META = {
  low:    { label: 'Low',    color: '#9a95ba' },
  normal: { label: 'Normal', color: '#5B8DEF' },
  high:   { label: 'High',   color: 'var(--danger-ink,#e25555)' },
};

let ticketsData = [];
let ticketsFilter = 'active';
let ticketsCategory = '';

function ticketStatusBadge(s) {
  const m = TICKET_STATUS_META[s] || { label: s, color: '#9a95ba' };
  return `<span style="display:inline-block;background:${m.color}1a;color:${m.color};font-size:11px;
    font-weight:700;padding:2px 9px;border-radius:10px">${m.label}</span>`;
}

// Clinical Calm dotted pill for the list (inside .cc only — the detail modal
// lives outside .cc so it keeps ticketStatusBadge above).
function ticketStatusPill(s) {
  if (s === 'escalated') return '<span class="sc no">Escalated</span>';
  const map = { open: 'progress', in_progress: 'arrived', resolved: 'final', closed: 'scheduled' };
  const m = TICKET_STATUS_META[s] || { label: s };
  return `<span class="ris ${map[s] || 'scheduled'}"><span class="rd"></span>${m.label}</span>`;
}

function renderTicketsPage() {
  const isManager = ['admin', 'manager', 'superadmin'].includes(currentUser?.role);
  setTopbar('Support', 'Raise and track tickets',
    `<button class="btn btn-sm" onclick="openCreateTicketModal()">+ New Ticket</button>`);
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="cc">
    <div class="phero no-print">
      <div class="phero-orb p1"></div><div class="phero-orb p2"></div>
      <div class="phero-inner">
        <div class="phero-logo"><img src="/meena_logo.png" alt="Meena"></div>
        <div class="phero-text">
          <div class="phero-hi">${isManager ? 'Tickets from your team' : 'Your support tickets'}</div>
          <div class="phero-title">Support</div>
          <div class="phero-sub">${isManager
            ? 'Pick up a ticket, escalate it, and mark the action taken — the person who raised it is notified.'
            : 'Report an issue, fault, or request. You\'ll be notified the moment an action is taken.'}</div>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
      <div class="seg" id="tickets-filter">
        <button data-f="active">Active</button>
        <button data-f="">All</button>
        <button data-f="resolved">Resolved</button>
        <button data-f="closed">Closed</button>
      </div>
      <select id="tickets-cat" style="max-width:200px">
        <option value="">All types</option>
        <option value="device_fault">Device fault</option>
        <option value="pacs">PACS / imaging</option>
        <option value="report_blocked">Blocked report</option>
        <option value="ovr">OVR / incident</option>
        <option value="stock">Stock / supplies</option>
        <option value="request">Request</option>
        <option value="other">Other</option>
      </select>
      <button class="open pri" style="width:auto;margin-inline-start:auto" onclick="openCreateTicketModal()">+ New Ticket</button>
    </div>
    <div id="tickets-list">${LOADING_HTML}</div>
    </div>`;
  // Wire the segmented filter.
  c.querySelectorAll('#tickets-filter button').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-f') === ticketsFilter);
    b.onclick = () => { ticketsFilter = b.getAttribute('data-f'); renderTicketsPage(); };
  });
  const catEl = document.getElementById('tickets-cat');
  if (catEl) { catEl.value = ticketsCategory; catEl.onchange = () => { ticketsCategory = catEl.value; loadTickets(); }; }
  loadTickets();
}

async function loadTickets() {
  const list = document.getElementById('tickets-list');
  try {
    const params = [];
    if (ticketsFilter) params.push(`status=${ticketsFilter}`);
    if (ticketsCategory) params.push(`category=${ticketsCategory}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    ticketsData = await API.get(`/tickets${qs}`) || [];
    renderTicketsList();
  } catch (e) {
    if (list) list.innerHTML = `<div class="empty"><p>${escapeHtml(e.message || 'Failed to load')}</p></div>`;
  }
}

function renderTicketsList() {
  const list = document.getElementById('tickets-list');
  if (!list) return;
  if (!ticketsData.length) {
    list.innerHTML = `<div class="listcard"><div class="lrow" style="flex-direction:column;justify-content:center;padding:24px;color:var(--muted)">
      <p style="margin:0">No tickets here.</p>
      <button class="open pri" style="width:auto;margin-top:12px" onclick="openCreateTicketModal()">+ Raise a ticket</button></div></div>`;
    return;
  }
  const isManager = ['admin', 'manager', 'superadmin'].includes(currentUser?.role);
  list.innerHTML = `<div class="listcard">${ticketsData.map(t => {
    const cat = TICKET_CATEGORY_META[t.category] || TICKET_CATEGORY_META.other;
    const hi = t.priority === 'high' ? '<span class="sc no">High</span>' : '';
    return `
      <div class="lrow ticket-row" onclick="openTicketDetail(${t.id})" style="cursor:pointer;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">#${t.id} · ${escapeHtml(t.subject)}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">
            ${cat.label}
            ${isManager ? ' · ' + escapeHtml(t.staff_name || t.created_by_name || '') : ''}
            ${t.branch_name ? ' · ' + escapeHtml(t.branch_name) : ''}
            · ${timeAgo(t.updated_at, { weekFallback: true })}${Number(t.updates) ? ' · ' + t.updates + ' replies' : ''}
          </div>
        </div>
        ${hi}
        ${ticketStatusPill(t.status)}
      </div>`;
  }).join('')}</div>`;
}

// ── Create ────────────────────────────────────────────────────────────────────
function openCreateTicketModal() {
  ensureTicketModal();
  document.getElementById('tk-subject').value = '';
  document.getElementById('tk-desc').value = '';
  document.getElementById('tk-category').value = 'device_fault';
  document.getElementById('tk-priority').value = 'normal';
  document.getElementById('tk-msg').textContent = '';
  document.getElementById('ticket-create-overlay').classList.add('open');
  setTimeout(() => document.getElementById('tk-subject').focus(), 50);
}
function closeCreateTicketModal() {
  document.getElementById('ticket-create-overlay').classList.remove('open');
}
async function saveTicket() {
  const msg = document.getElementById('tk-msg');
  const btn = document.getElementById('tk-save-btn');
  const subject = document.getElementById('tk-subject').value.trim();
  if (!subject) { msg.className = 'msg err'; msg.textContent = 'Please add a short subject'; return; }
  const payload = {
    subject,
    description: document.getElementById('tk-desc').value.trim(),
    category: document.getElementById('tk-category').value,
    priority: document.getElementById('tk-priority').value,
  };
  msg.className = 'msg'; msg.textContent = '';
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  try {
    await API.post('/tickets', payload);
    closeCreateTicketModal();
    toast('Ticket submitted — you\'ll be notified when it\'s actioned');
    if (currentPage === 'tickets') loadTickets();
    if (typeof loadTicketsBadge === 'function') loadTicketsBadge();
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Ticket'; }
  }
}

// ── Detail + thread ───────────────────────────────────────────────────────────
let _openTicketId = null;
async function openTicketDetail(id) {
  ensureTicketDetailModal();
  _openTicketId = id;
  document.getElementById('ticket-detail-overlay').classList.add('open');
  document.getElementById('td-body').innerHTML = LOADING_HTML;
  try {
    const t = await API.get(`/tickets/${id}`);
    renderTicketDetail(t);
  } catch (e) {
    document.getElementById('td-body').innerHTML = `<div class="empty"><p>${escapeHtml(e.message)}</p></div>`;
  }
}
function closeTicketDetail() {
  document.getElementById('ticket-detail-overlay').classList.remove('open');
  _openTicketId = null;
}

function renderTicketDetail(t) {
  const cat = TICKET_CATEGORY_META[t.category] || TICKET_CATEGORY_META.other;
  const pri = TICKET_PRIORITY_META[t.priority] || TICKET_PRIORITY_META.normal;
  const canManage = !!t.can_manage;
  const isCreator = t.created_by === currentUser?.id;
  const thread = (t.updates || []).map(u => `
    <div style="padding:10px 12px;border-radius:12px;margin-bottom:8px;
                background:${u.is_status_change ? 'rgba(91,141,239,0.08)' : 'var(--card)'};
                border:1px solid var(--border)">
      <div style="font-size:12px;color:var(--muted);margin-bottom:3px">
        ${escapeHtml(u.author || 'system')} · ${timeAgo(u.created_at, { weekFallback: true })}
      </div>
      <div style="white-space:pre-wrap">${escapeHtml(u.body)}</div>
    </div>`).join('') || `<div style="color:var(--muted);font-size:13px;padding:6px 0">No replies yet.</div>`;

  const statusActions = canManage ? `
    <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:12px">
      <div style="font-weight:600;font-size:13px;margin-bottom:8px">Take action</div>
      <textarea id="td-note" rows="2" placeholder="Optional note for the staff member (e.g. what you did)"
        style="width:100%;margin-bottom:8px"></textarea>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${t.status !== 'escalated'   ? `<button class="btn btn-sm btn-ghost" onclick="setTicketStatus('escalated')">Escalate</button>` : ''}
        ${t.status !== 'in_progress' ? `<button class="btn btn-sm btn-ghost" onclick="setTicketStatus('in_progress')">In progress</button>` : ''}
        ${t.status !== 'resolved'    ? `<button class="btn btn-sm" onclick="setTicketStatus('resolved')">Resolved</button>` : ''}
        ${t.status !== 'closed'      ? `<button class="btn btn-sm btn-ghost" onclick="setTicketStatus('closed')">Close</button>` : ''}
      </div>
    </div>` : '';

  const canDelete = canManage || (isCreator && t.status === 'open');
  document.getElementById('td-title').innerHTML = `#${t.id} · ${escapeHtml(t.subject)}`;
  document.getElementById('td-body').innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      ${ticketStatusBadge(t.status)}
      <span style="font-size:12px;color:var(--muted)">${cat.label}</span>
      <span style="font-size:12px;color:${pri.color};font-weight:600">● ${pri.label}</span>
      ${t.branch_name ? `<span style="font-size:12px;color:var(--muted)">${escapeHtml(t.branch_name)}</span>` : ''}
    </div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
      Raised by ${escapeHtml(t.staff_name || t.created_by_name || '')} · ${timeAgo(t.created_at, { weekFallback: true })}
      ${t.handled_by_name ? ' · handled by ' + escapeHtml(t.handled_by_name) : ''}
    </div>
    ${t.description ? `<div style="white-space:pre-wrap;padding:12px;border:1px solid var(--border);
        border-radius:12px;margin-bottom:14px">${escapeHtml(t.description)}</div>` : ''}
    ${t.resolution ? `<div style="padding:10px 12px;border-radius:12px;margin-bottom:14px;
        background:#2BAE661a;border:1px solid #2BAE6633"><b>Resolution:</b> ${escapeHtml(t.resolution)}</div>` : ''}

    <div style="font-weight:600;font-size:13px;margin-bottom:8px">Activity</div>
    ${thread}

    <div style="margin-top:12px">
      <textarea id="td-reply" rows="2" placeholder="Write a reply…" style="width:100%;margin-bottom:8px"></textarea>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <button class="btn btn-sm" onclick="sendTicketReply()">Send reply</button>
        ${canDelete ? `<button class="btn btn-sm btn-ghost" style="color:var(--danger-ink,#e25555)" onclick="deleteTicket(${t.id})">Delete</button>` : ''}
      </div>
    </div>
    ${statusActions}
    <div class="msg" id="td-msg" style="margin-top:10px"></div>`;
}

async function setTicketStatus(status) {
  const note = (document.getElementById('td-note')?.value || '').trim();
  const msg = document.getElementById('td-msg');
  try {
    await API.put(`/tickets/${_openTicketId}/status`, { status, note });
    toast(`Ticket marked ${TICKET_STATUS_META[status]?.label || status}`);
    await openTicketDetail(_openTicketId);   // refresh detail
    if (currentPage === 'tickets') loadTickets();
    if (typeof loadTicketsBadge === 'function') loadTicketsBadge();
  } catch (e) { if (msg) { msg.className = 'msg err'; msg.textContent = e.message; } }
}

async function sendTicketReply() {
  const ta = document.getElementById('td-reply');
  const msg = document.getElementById('td-msg');
  const body = (ta?.value || '').trim();
  if (!body) { if (msg) { msg.className = 'msg err'; msg.textContent = 'Write something first'; } return; }
  try {
    await API.post(`/tickets/${_openTicketId}/updates`, { body });
    await openTicketDetail(_openTicketId);
  } catch (e) { if (msg) { msg.className = 'msg err'; msg.textContent = e.message; } }
}

async function deleteTicket(id) {
  const ok = await showConfirm('Delete ticket', 'This permanently removes the ticket and its thread.', 'Delete');
  if (!ok) return;
  try {
    await API.delete(`/tickets/${id}`);
    closeTicketDetail();
    toast('Ticket deleted');
    if (currentPage === 'tickets') loadTickets();
    if (typeof loadTicketsBadge === 'function') loadTicketsBadge();
  } catch (e) { toast(e.message, 'err'); }
}

// ── Nav badge ─────────────────────────────────────────────────────────────────
async function loadTicketsBadge() {
  try {
    const d = await API.get('/dashboard');
    const badge = document.getElementById('tickets-badge');
    if (!badge) return;
    const n = d?.open_tickets || 0;
    if (n > 0) { badge.textContent = n; badge.style.display = 'inline-block'; }
    else badge.style.display = 'none';
  } catch (e) { /* silent */ }
}

// ── Helpers + lazily-injected modals ──────────────────────────────────────────

function ensureTicketModal() {
  if (document.getElementById('ticket-create-overlay')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="modal-overlay" id="ticket-create-overlay">
      <div class="modal">
        <div class="modal-header">
          <h3>Raise a Ticket</h3>
          <button class="modal-close" onclick="closeCreateTicketModal()">&times;</button>
        </div>
        <div class="modal-body">
          <div style="display:flex;flex-direction:column;gap:14px">
            <div class="form-field">
              <label>Subject *</label>
              <input type="text" id="tk-subject" maxlength="200" placeholder="Short summary of the problem">
            </div>
            <div class="form-row">
              <div class="form-field" style="flex:1">
                <label>Type</label>
                <select id="tk-category">
                  <option value="device_fault">Device fault / breakdown</option>
                  <option value="pacs">PACS / imaging system</option>
                  <option value="report_blocked">Blocked report</option>
                  <option value="ovr">OVR / incident</option>
                  <option value="stock">Stock / supplies needed</option>
                  <option value="request">Request</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div class="form-field" style="flex:1">
                <label>Priority</label>
                <select id="tk-priority">
                  <option value="low">Low</option>
                  <option value="normal" selected>Normal</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>
            <div class="form-field">
              <label>Details</label>
              <textarea id="tk-desc" rows="4" placeholder="Describe what happened, where, and when"></textarea>
            </div>
            <div class="msg" id="tk-msg"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeCreateTicketModal()">Cancel</button>
          <button class="btn" id="tk-save-btn" onclick="saveTicket()">Submit Ticket</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(div.firstElementChild);
}

function ensureTicketDetailModal() {
  if (document.getElementById('ticket-detail-overlay')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="modal-overlay" id="ticket-detail-overlay">
      <div class="modal" style="max-width:560px">
        <div class="modal-header">
          <h3 id="td-title">Ticket</h3>
          <button class="modal-close" onclick="closeTicketDetail()">&times;</button>
        </div>
        <div class="modal-body" id="td-body">${LOADING_HTML}</div>
      </div>
    </div>`;
  document.body.appendChild(div.firstElementChild);
}
