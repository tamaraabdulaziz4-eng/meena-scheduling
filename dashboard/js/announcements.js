// ── Announcements / circulars ─────────────────────────────────────────────────
// Managers (and team leads for their branch) post bulletins / circulars. An
// "action required" circular asks staff to acknowledge it, and can be broadcast
// over WhatsApp + email to everyone.

let announcementsData = [];

function annCanPost() {
  return ['admin', 'manager', 'superadmin'].includes(currentUser?.role);
}

// Swap {name}/{الاسم} for the viewer's own name when showing a circular (the
// WhatsApp/email copy is already personalised per recipient on the server).
function _viewerName() {
  if (currentUser?.staff_id && typeof allStaff !== 'undefined' && Array.isArray(allStaff)) {
    const s = allStaff.find(x => x.id === currentUser.staff_id);
    if (s && s.name) return s.name;
  }
  return currentUser?.username || '';
}
function personalizeAnnouncement(body) {
  const nm = _viewerName();
  return String(body || '').replace(/\{name\}/g, nm || 'there').replace(/\{الاسم\}/g, nm || 'زميلنا');
}

function renderAnnouncementsPage() {
  setTopbar('Announcements', 'Circulars & bulletins',
    annCanPost() ? `<button class="btn btn-sm" onclick="openAnnModal()">+ New Circular</button>` : '');
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="phero no-print">
      <div class="phero-orb p1"></div><div class="phero-orb p2"></div>
      <div class="phero-inner">
        <div class="phero-logo"><img src="/meena_logo.png" alt="Meena"></div>
        <div class="phero-text">
          <div class="phero-hi">Department circulars & bulletins</div>
          <div class="phero-title">Announcements</div>
          <div class="phero-sub">Official circulars from management. Action-required ones need your acknowledgement.</div>
        </div>
      </div>
    </div>
    <div id="ann-list">${LOADING_HTML}</div>`;
  loadAnnouncements();
}

async function loadAnnouncements() {
  const list = document.getElementById('ann-list');
  try {
    announcementsData = await API.get('/announcements') || [];
    renderAnnouncementsList();
  } catch (e) {
    if (list) list.innerHTML = `<div class="empty"><p>${escapeHtml(e.message || 'Failed to load')}</p></div>`;
  }
}

function renderAnnouncementsList() {
  const list = document.getElementById('ann-list');
  if (!list) return;
  if (!announcementsData.length) {
    list.innerHTML = `<div class="empty"><p>No announcements yet.</p></div>`;
    return;
  }
  const canManage = annCanPost();
  list.innerHTML = announcementsData.map(a => {
    const required = a.kind === 'action_required';
    const kindBadge = required
      ? `<span style="background:#E255551a;color:#E25555;font-size:11px;font-weight:700;padding:2px 9px;border-radius:10px">Action required</span>`
      : `<span style="background:#5B8DEF1a;color:#5B8DEF;font-size:11px;font-weight:700;padding:2px 9px;border-radius:10px">Announcement</span>`;
    const ackBtn = (required && !a.acked)
      ? `<button class="btn btn-sm" onclick="ackAnnouncement(${a.id})">Acknowledge</button>`
      : (required && a.acked ? `<span style="color:#2BAE66;font-size:12px;font-weight:600">Acknowledged</span>` : '');
    const mgrTools = canManage ? `
      ${required ? `<button class="btn btn-sm btn-ghost" onclick="viewAnnAcks(${a.id})">${a.ack_count || 0} acknowledged</button>` : ''}
      <button class="btn btn-sm btn-ghost" style="color:#E25555" onclick="deleteAnnouncement(${a.id})">Delete</button>` : '';
    return `
      <div style="border:1px solid var(--border);border-left:4px solid ${required ? '#E25555' : '#5B8DEF'};
                  border-radius:14px;padding:16px;margin-bottom:12px;background:var(--card)">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          ${a.pinned ? '<span style="background:var(--border);color:var(--muted);font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px">PINNED</span>' : ''}${kindBadge}
          <span style="font-weight:700;font-size:15px">${escapeHtml(a.title)}</span>
        </div>
        <div style="white-space:pre-wrap;margin:6px 0 10px">${escapeHtml(personalizeAnnouncement(a.body))}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div style="font-size:12px;color:var(--muted)">
            ${escapeHtml(a.created_by_name || 'Management')}
            ${a.audience === 'branch' && a.branch_name ? ' · ' + escapeHtml(a.branch_name) : ' · All staff'}
            · ${annTimeAgo(a.created_at)}
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${ackBtn}${mgrTools}</div>
        </div>
      </div>`;
  }).join('');
}

async function ackAnnouncement(id) {
  try {
    await API.post(`/announcements/${id}/ack`, {});
    toast('Acknowledged');
    loadAnnouncements();
    if (typeof loadAnnouncementsBadge === 'function') loadAnnouncementsBadge();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteAnnouncement(id) {
  const ok = await showConfirm('Delete circular', 'This removes the announcement for everyone.', 'Delete');
  if (!ok) return;
  try {
    await API.delete(`/announcements/${id}`);
    toast('Deleted');
    loadAnnouncements();
  } catch (e) { toast(e.message, 'err'); }
}

async function viewAnnAcks(id) {
  try {
    const d = await API.get(`/announcements/${id}/acks`);
    const acked = (d.acked || []).length ? d.acked.map(r => `• ${escapeHtml(r.username)}`).join('<br>') : '—';
    const pending = (d.pending || []).length ? d.pending.map(r => `• ${escapeHtml(r.username)}`).join('<br>') : 'Everyone acknowledged.';
    const body = `<div style="text-align:left;max-height:300px;overflow:auto">
        <b>Acknowledged:</b><br>${acked}
        <br><br><b style="color:#E25555">Still pending (${(d.pending || []).length}):</b><br>${pending}</div>`;
    const title = `${d.ack_count || 0} of ${d.target_count || 0} acknowledged`;
    if ((d.pending || []).length) {
      const ok = await showConfirm(title, body, 'Remind pending', '');
      if (ok) {
        const r = await API.post(`/announcements/${id}/remind`, {});
        toast(`Reminded ${r.reminded} pending`);
      }
    } else {
      await showConfirm(title, body, 'Close', '');
    }
  } catch (e) { toast(e.message, 'err'); }
}

// ── Create modal ──────────────────────────────────────────────────────────────
function openAnnModal() {
  ensureAnnModal();
  document.getElementById('ann-title').value = '';
  document.getElementById('ann-body').value = '';
  document.getElementById('ann-kind').value = 'announcement';
  document.getElementById('ann-pinned').checked = false;
  document.getElementById('ann-broadcast').checked = false;
  document.getElementById('ann-msg').textContent = '';
  // Audience: a team lead can only post to their own branch.
  const isLead = currentUser?.role === 'admin';
  const audWrap = document.getElementById('ann-audience-wrap');
  const aud = document.getElementById('ann-audience');
  if (isLead) {
    audWrap.style.display = 'none';
  } else {
    audWrap.style.display = '';
    const opts = ['<option value="all">Everyone (all branches)</option>']
      .concat((allBranches || []).map(b => `<option value="branch:${b.id}">${escapeHtml(b.name)} only</option>`));
    aud.innerHTML = opts.join('');
    aud.value = 'all';
  }
  document.getElementById('ann-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('ann-title').focus(), 50);
}
function closeAnnModal() {
  document.getElementById('ann-modal-overlay').classList.remove('open');
}

async function saveAnnouncement() {
  const msg = document.getElementById('ann-msg');
  const btn = document.getElementById('ann-save-btn');
  const title = document.getElementById('ann-title').value.trim();
  const bodyTxt = document.getElementById('ann-body').value.trim();
  if (!title || !bodyTxt) { msg.className = 'msg err'; msg.textContent = 'Title and body are required'; return; }
  const payload = {
    title, body: bodyTxt,
    kind: document.getElementById('ann-kind').value,
    pinned: document.getElementById('ann-pinned').checked,
    broadcast: document.getElementById('ann-broadcast').checked,
  };
  const isLead = currentUser?.role === 'admin';
  if (isLead) {
    payload.audience = 'branch';   // server defaults branch_id to the lead's branch
  } else {
    const aud = document.getElementById('ann-audience').value;
    if (aud.startsWith('branch:')) { payload.audience = 'branch'; payload.branch_id = Number(aud.split(':')[1]); }
    else payload.audience = 'all';
  }
  msg.className = 'msg'; msg.textContent = '';
  if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
  try {
    const r = await API.post('/announcements', payload);
    closeAnnModal();
    toast(r.broadcast ? `Posted & sent to ${r.delivered} staff` : 'Announcement posted');
    if (currentPage === 'announcements') loadAnnouncements();
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Post Circular'; }
  }
}

// ── Nav badge: action-required circulars not yet acknowledged ──────────────────
async function loadAnnouncementsBadge() {
  try {
    const d = await API.get('/dashboard');
    const badge = document.getElementById('announcements-badge');
    if (!badge) return;
    const n = d?.announcements_todo || 0;
    if (n > 0) { badge.textContent = n; badge.style.display = 'inline-block'; }
    else badge.style.display = 'none';
  } catch (e) { /* silent */ }
}

function annTimeAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts); const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
  return d.toLocaleDateString('en-GB');
}

function ensureAnnModal() {
  if (document.getElementById('ann-modal-overlay')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="modal-overlay" id="ann-modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <h3>New Circular</h3>
          <button class="modal-close" onclick="closeAnnModal()">&times;</button>
        </div>
        <div class="modal-body">
          <div style="display:flex;flex-direction:column;gap:14px">
            <div class="form-field">
              <label>Title *</label>
              <input type="text" id="ann-title" maxlength="200" placeholder="e.g. New infection-control protocol">
            </div>
            <div class="form-field">
              <label>Message *</label>
              <textarea id="ann-body" rows="5" placeholder="Write the circular / bulletin text"></textarea>
              <div style="font-size:11px;color:var(--muted);margin-top:4px">Tip: type <b>{name}</b> to greet each person by their own name.</div>
            </div>
            <div class="form-row">
              <div class="form-field" style="flex:1">
                <label>Type</label>
                <select id="ann-kind">
                  <option value="announcement">Announcement</option>
                  <option value="action_required">Action required (needs acknowledgement)</option>
                </select>
              </div>
              <div class="form-field" style="flex:1" id="ann-audience-wrap">
                <label>Send to</label>
                <select id="ann-audience"></select>
              </div>
            </div>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input type="checkbox" id="ann-broadcast"> Also send over <b>WhatsApp + email</b> to everyone now
            </label>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input type="checkbox" id="ann-pinned"> Pin to top
            </label>
            <div class="msg" id="ann-msg"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeAnnModal()">Cancel</button>
          <button class="btn" id="ann-save-btn" onclick="saveAnnouncement()">Post Circular</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(div.firstElementChild);
}
