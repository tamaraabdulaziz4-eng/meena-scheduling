// ── Direct messaging: custom WhatsApp / email / in-app to chosen staff ────────

let _msgRecipients = [];
let _msgSelected = new Set();
let _msgChannels = new Set(['whatsapp', 'app']);
let _msgSection = '';
let _msgSearch = '';
let _msgBranch = '';

function _msgIsManager() { return ['manager', 'superadmin'].includes(currentUser?.role); }

async function renderMessagesPage() {
  setTopbar('Messages', 'Send a custom message to staff');
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Messages', 'Send a message', 'Pick staff, choose WhatsApp / email / in-app, and send a custom message')}
    <div style="display:grid;grid-template-columns:1fr;gap:16px">
      <div class="rep-card">
        <div class="rep-card-head"><div class="rep-card-title">Message</div>
          ${_msgIsManager() ? `<select id="msg-branch" class="rep-select" style="max-width:200px"></select>` : ''}
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Channels — tap to turn on/off (✓ = will be sent):</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px" id="msg-channels">
          ${[['whatsapp', 'WhatsApp'], ['email', 'Email'], ['app', 'In-app + push 🔔']].map(([v, l]) =>
            `<button type="button" class="seg-chip" data-ch="${v}" data-label="${l}" onclick="msgToggleChannel('${v}')">${l}</button>`).join('')}
        </div>
        <div id="msg-subject-wrap" style="display:none;margin-bottom:10px">
          <input id="msg-subject" class="input" maxlength="120" placeholder="Email subject" style="width:100%"></div>
        <textarea id="msg-body" class="input" rows="5" style="width:100%;resize:vertical" placeholder="Type your message…  Use {name} to personalise (e.g. Hi {name}, …)"></textarea>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Tip: <code>{name}</code> is replaced with each recipient's name.</div>
      </div>

      <div class="rep-card" style="padding:0;overflow:hidden">
        <div class="rep-card-head" style="padding:16px 18px 0">
          <div class="rep-card-title">Recipients (<span id="msg-count">0</span>)</div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-xs btn-ghost" onclick="msgSelectAll(true)">Select all</button>
            <button class="btn btn-xs btn-ghost" onclick="msgSelectAll(false)">None</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;padding:10px 18px 0">
          <input id="msg-q" class="input" placeholder="Search staff…" style="flex:1;min-width:160px" oninput="msgSearch(this.value)">
          <div class="seg" id="msg-secfilter">
            <button data-s="" class="on" onclick="msgSetSection('')">All</button>
            <button data-s="General" onclick="msgSetSection('General')">General</button>
            <button data-s="US" onclick="msgSetSection('US')">US</button>
          </div>
        </div>
        <div id="msg-list" style="padding:12px 18px 18px">${LOADING_HTML}</div>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:10px;align-items:center">
        <span id="msg-status" style="font-size:13px;color:var(--muted)"></span>
        <button class="btn btn-primary" id="msg-send" onclick="sendMessage()">Send</button>
      </div>
    </div>`;
  document.querySelectorAll('#msg-channels .seg-chip').forEach(_msgPaintChip);
  _msgSubjectVisibility();
  if (_msgIsManager()) {
    try { if (!allBranches.length) await loadBranches(); } catch (e) {}
    const sel = document.getElementById('msg-branch');
    if (sel) {
      sel.innerHTML = `<option value="">All branches</option>` + allBranches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
      sel.value = _msgBranch;
      sel.onchange = () => { _msgBranch = sel.value; _msgSelected.clear(); loadMsgRecipients(); };
    }
  }
  loadMsgRecipients();
}

function _msgSubjectVisibility() {
  const w = document.getElementById('msg-subject-wrap');
  if (w) w.style.display = _msgChannels.has('email') ? 'block' : 'none';
}
function _msgPaintChip(b) {
  const ch = b.getAttribute('data-ch');
  const on = _msgChannels.has(ch);
  b.classList.toggle('on', on);
  b.textContent = (on ? '✓ ' : '') + (b.getAttribute('data-label') || '');
}
function msgToggleChannel(ch) {
  if (_msgChannels.has(ch)) _msgChannels.delete(ch); else _msgChannels.add(ch);
  const b = document.querySelector(`#msg-channels .seg-chip[data-ch="${ch}"]`);
  if (b) _msgPaintChip(b);
  _msgSubjectVisibility();
}

async function loadMsgRecipients() {
  const box = document.getElementById('msg-list');
  if (!box) return;
  const qs = _msgBranch ? `?branch_id=${_msgBranch}` : '';
  let d;
  try { d = await API.get(`/messages/recipients${qs}`); }
  catch (e) { box.innerHTML = `<div class="rep-empty">${escapeHtml(e.message || 'Failed to load')}</div>`; return; }
  _msgRecipients = d.recipients || [];
  renderMsgList();
}

function renderMsgList() {
  const box = document.getElementById('msg-list');
  if (!box) return;
  const q = _msgSearch.toLowerCase();
  const rows = _msgRecipients.filter(r =>
    (!_msgSection || r.section === _msgSection) &&
    (!q || (r.name || '').toLowerCase().includes(q)));
  if (!rows.length) { box.innerHTML = `<div class="rep-empty">No staff match.</div>`; }
  else box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">${rows.map(r => {
    const on = _msgSelected.has(r.id);
    const ch = [r.has_phone ? 'WA' : '', r.has_email ? '@' : '', r.has_push ? '🔔 push' : (r.has_login ? 'app' : '')].filter(Boolean).join(' · ');
    return `<label style="display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};border-radius:11px;cursor:pointer;background:${on ? 'rgba(107,78,255,.06)' : 'var(--card-alt)'}">
      <input type="checkbox" ${on ? 'checked' : ''} onchange="msgToggle(${r.id})" style="width:auto">
      <div style="min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.name)}</div>
        <div style="font-size:11px;color:var(--muted)">${escapeHtml(r.branch_name || '')}${ch ? ' · ' + ch : ''}</div>
      </div></label>`;
  }).join('')}</div>`;
  const cnt = document.getElementById('msg-count');
  if (cnt) cnt.textContent = _msgSelected.size;
}

function msgToggle(id) { if (_msgSelected.has(id)) _msgSelected.delete(id); else _msgSelected.add(id); renderMsgList(); }
function msgSelectAll(on) {
  const q = _msgSearch.toLowerCase();
  _msgRecipients.filter(r => (!_msgSection || r.section === _msgSection) && (!q || (r.name || '').toLowerCase().includes(q)))
    .forEach(r => { if (on) _msgSelected.add(r.id); else _msgSelected.delete(r.id); });
  renderMsgList();
}
function msgSetSection(s) {
  _msgSection = s;
  document.querySelectorAll('#msg-secfilter button').forEach(b => b.classList.toggle('on', b.getAttribute('data-s') === s));
  renderMsgList();
}
function msgSearch(v) { _msgSearch = v || ''; renderMsgList(); }

async function sendMessage() {
  const message = document.getElementById('msg-body').value.trim();
  if (!message) { toast('Type a message', 'err'); return; }
  if (!_msgChannels.size) { toast('Pick a channel', 'err'); return; }
  if (!_msgSelected.size) { toast('Pick at least one recipient', 'err'); return; }
  const payload = {
    message, channels: [..._msgChannels],
    staff_ids: [..._msgSelected],
    subject: (document.getElementById('msg-subject')?.value || '').trim(),
  };
  const btn = document.getElementById('msg-send'); btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await API.post('/messages/send', payload);
    const parts = [];
    if (r.whatsapp) parts.push(`${r.whatsapp} WhatsApp`);
    if (r.email) parts.push(`${r.email} email`);
    if (r.app) parts.push(`${r.app} in-app`);
    if (r.push) parts.push(`${r.push} device 🔔`);
    toast(`Sent to ${r.delivered} staff${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
    // Make the "no device notification" case obvious so it's clear why a phone stayed silent.
    let status = `Last send: ${r.delivered} reached`;
    if (_msgChannels.has('app') && !r.push) status += ' · no recipient has device notifications on yet';
    else if (r.push) status += ` · ${r.push} device${r.push > 1 ? 's' : ''} pinged`;
    document.getElementById('msg-status').textContent = status + '.';
  } catch (e) { toast(e.message || 'Failed to send', 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Send'; }
}
