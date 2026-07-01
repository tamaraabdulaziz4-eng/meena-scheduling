// ── Radiology handoff ─────────────────────────────────────────────────────────
// One screen for the daily radiology hand-off:
//   1) look up the patient's order in Siratech HIS by file (MRN) number,
//   2) write the clinical history into the DePACS (Butterfly) study,
//   3) prepare a ready-to-paste WhatsApp message (file · exam · priority · branch)
//      that staff copy into the radiology group themselves.
// Clinical history comes from a paste (HIS exposes it only after the order is
// paid), so the textarea is the source of truth for what gets written & sent.

let handoff = { file: '', lookup: null, order: 0, studies: null, studyId: '', priority: 'routine' };

async function renderHandoffPage() {
  setTopbar('Radiology handoff', 'Pull the order, write the history, prepare the group message');
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Radiology handoff', 'Handoff', 'Pull the order from HIS, write the clinical history to DePACS, and copy the group message')}
    <div class="card" style="margin-bottom:14px">
      <div style="font-weight:600;margin-bottom:8px">Patient file</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="ho-file" class="input" placeholder="File / MRN number" value="${escapeHtml(handoff.file)}"
               style="flex:1;min-width:200px" onkeydown="if(event.key==='Enter')handoffLookup()">
        <button class="btn btn-primary" onclick="handoffLookup()">Look up</button>
      </div>
      <div id="ho-patient" style="margin-top:12px"></div>
    </div>
    <div id="ho-form"></div>
    <div id="ho-result" style="margin-top:14px"></div>`;
  if (handoff.lookup) { renderHandoffPatient(); renderHandoffForm(); }
}

// ── HIS lookup ────────────────────────────────────────────────────────────────
async function handoffLookup() {
  const file = (document.getElementById('ho-file').value || '').trim();
  if (!file) return;
  handoff.file = file; handoff.lookup = null; handoff.studies = null; handoff.studyId = ''; handoff.order = 0;
  const pane = document.getElementById('ho-patient');
  pane.innerHTML = LOADING_HTML;
  document.getElementById('ho-form').innerHTML = '';
  document.getElementById('ho-result').innerHTML = '';
  try {
    handoff.lookup = await API.get(`/radiology/lookup/${encodeURIComponent(file)}`);
    const o = (handoff.lookup.orders || [])[handoff.order];
    handoff.priority = o && o.priority ? 'emergency' : 'routine';
    renderHandoffPatient();
    renderHandoffForm();
    loadHandoffStudies();
  } catch (e) {
    pane.innerHTML = `<div class="empty"><p>${escapeHtml(e.message || 'Lookup failed')}</p></div>`;
  }
}

function renderHandoffPatient() {
  const d = handoff.lookup || {};
  const p = d.patient;
  const orders = d.orders || [];
  const pane = document.getElementById('ho-patient');
  const patientCard = p ? `
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;margin-bottom:10px">
      <div style="font-size:16px;font-weight:700">${escapeHtml(p.name || '—')}</div>
      <div style="color:var(--muted);font-size:13px">${escapeHtml(p.gender || '')} · ${escapeHtml(p.age || '')} · ${escapeHtml(p.dob || '')}</div>
      <div style="color:var(--muted);font-size:13px">📞 ${escapeHtml(p.phone || '—')}</div>
      ${p.nationalId ? `<div style="color:var(--muted);font-size:13px">ID ${escapeHtml(p.nationalId)}</div>` : ''}
    </div>` : `<div style="color:var(--muted)">No patient record found for this file.</div>`;
  const orderRows = orders.length ? orders.map((o, i) => {
    const paid = o.paid
      ? `<span class="badge" style="background:#e7f7ec;color:#1a7f43">Billed</span>`
      : `<span class="badge" style="background:#fdeecf;color:#8a5a00">Pending / unpaid</span>`;
    return `<label style="display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid var(--border,#e5e5ef);border-radius:10px;margin-bottom:6px;cursor:pointer">
        <input type="radio" name="ho-order" ${i === handoff.order ? 'checked' : ''} onchange="handoffPickOrder(${i})">
        <div style="flex:1">
          <div style="font-weight:600">${escapeHtml(o.service || '—')} <span style="color:var(--muted);font-weight:400">(${escapeHtml(o.modality || '')})</span></div>
          <div style="font-size:12px;color:var(--muted)">🏥 ${escapeHtml(o.branch || '—')} · ${escapeHtml(o.orderedDate || '')}</div>
        </div>
        ${paid}
        ${o.accessionNumber ? `<span class="badge">ACC ${escapeHtml(o.accessionNumber)}</span>` : ''}
      </label>`;
  }).join('') : `<div style="color:var(--muted)">No radiology orders on this file.</div>`;
  pane.innerHTML = `${patientCard}
    <div style="font-size:12px;color:var(--muted);margin:6px 0">${orders.length} radiology order(s)</div>
    ${orderRows}`;
}

function handoffPickOrder(i) {
  handoff.order = i;
  const o = (handoff.lookup.orders || [])[i];
  handoff.priority = o && o.priority ? 'emergency' : 'routine';
  renderHandoffForm();
}

// ── Butterfly studies (write target) ──────────────────────────────────────────
async function loadHandoffStudies() {
  const box = document.getElementById('ho-studies');
  if (!box) return;
  box.innerHTML = LOADING_HTML;
  try {
    const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
    handoff.studies = r.studies || [];
    renderHandoffStudies();
  } catch (e) {
    box.innerHTML = `<div style="font-size:12px;color:var(--muted)">Couldn't load DePACS studies: ${escapeHtml(e.message || '')}. You can still copy the message.</div>`;
  }
}

function renderHandoffStudies() {
  const box = document.getElementById('ho-studies');
  if (!box) return;
  const studies = handoff.studies || [];
  if (!studies.length) {
    box.innerHTML = `<div style="font-size:12px;color:var(--muted)">No imaging study in DePACS yet (it appears after the exam is done). Write the history once it's there.</div>`;
    return;
  }
  box.innerHTML = studies.map(s => `
    <label style="display:flex;gap:10px;align-items:center;padding:7px 10px;border:1px solid var(--border,#e5e5ef);border-radius:10px;margin-bottom:6px;cursor:pointer">
      <input type="radio" name="ho-study" ${String(handoff.studyId) === String(s.study_id) ? 'checked' : ''} onchange="handoff.studyId='${s.study_id}'">
      <div style="flex:1">
        <div style="font-weight:600">${escapeHtml(s.modality || '')} · ${escapeHtml(s.study_date || '')}</div>
        <div style="font-size:12px;color:var(--muted)">${escapeHtml((s.history || '') || 'no clinical history yet')}</div>
      </div>
      <span class="badge">${escapeHtml(s.status || '')}</span>
    </label>`).join('');
}

// ── Hand-off form ─────────────────────────────────────────────────────────────
function renderHandoffForm() {
  const o = (handoff.lookup.orders || [])[handoff.order] || {};
  const form = document.getElementById('ho-form');
  form.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><label class="ho-lbl">Exam</label>
          <input id="ho-exam" class="input" value="${escapeHtml(o.service || '')}" oninput="handoffPreview()"></div>
        <div><label class="ho-lbl">Branch</label>
          <input id="ho-branch" class="input" value="${escapeHtml(o.branch || '')}" oninput="handoffPreview()"></div>
      </div>
      <div style="margin-top:10px"><label class="ho-lbl">Priority</label>
        <div class="seg" id="ho-prio">
          <button type="button" class="${handoff.priority === 'routine' ? 'on' : ''}" onclick="handoffSetPrio('routine')">🕒 Routine</button>
          <button type="button" class="${handoff.priority === 'emergency' ? 'on' : ''}" onclick="handoffSetPrio('emergency')">🚨 Emergency</button>
        </div>
      </div>
      <div style="margin-top:10px"><label class="ho-lbl">Clinical history (written into DePACS)</label>
        <textarea id="ho-history" class="input" rows="4" placeholder="Paste the clinical history / indication here"></textarea></div>
      <div style="margin-top:12px"><label class="ho-lbl">DePACS study to write into</label>
        <div id="ho-studies">${LOADING_HTML}</div></div>
      <div style="margin-top:14px">
        <button class="btn btn-primary" onclick="handoffWrite()">Write history to DePACS</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <label class="ho-lbl" style="margin:0">WhatsApp group message</label>
        <button class="btn btn-sm btn-primary" onclick="handoffCopy()">📋 Copy message</button>
      </div>
      <textarea id="ho-message" class="input" rows="6"></textarea>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">Copy this and paste it into the radiology WhatsApp group.</div>
    </div>`;
  if (handoff.studies) renderHandoffStudies();
  handoffPreview();
}

function handoffSetPrio(p) {
  handoff.priority = p;
  document.querySelectorAll('#ho-prio button').forEach((b, idx) => b.classList.toggle('on', (p === 'routine') === (idx === 0)));
  handoffPreview();
}

function handoffMessage() {
  const exam = (document.getElementById('ho-exam')?.value || '').trim();
  const branch = (document.getElementById('ho-branch')?.value || '').trim();
  const prio = handoff.priority === 'emergency' ? '🚨 طارئ / Emergency' : '🕒 روتيني / Routine';
  return ['🩻 طلب أشعة / Radiology handoff',
    `📄 الملف / File: ${handoff.file}`,
    exam ? `🔬 الفحص / Exam: ${exam}` : '',
    `⚑ الأولوية / Priority: ${prio}`,
    branch ? `🏥 الفرع / Branch: ${branch}` : ''].filter(Boolean).join('\n');
}

// Keep the message in sync with the fields until the user edits it by hand.
function handoffPreview() {
  const m = document.getElementById('ho-message');
  if (m && !m._touched) m.value = handoffMessage();
  if (m && !m._bound) { m._bound = true; m.addEventListener('input', () => { m._touched = true; }); }
}

async function handoffCopy() {
  const m = document.getElementById('ho-message');
  if (!m) return;
  try {
    await navigator.clipboard.writeText(m.value);
    if (typeof toast === 'function') toast('Message copied'); else { m.select(); document.execCommand('copy'); }
  } catch (e) {
    m.select(); try { document.execCommand('copy'); } catch (_e) {}
  }
}

async function handoffWrite() {
  const btn = event.target;
  const study = handoff.studyId;
  const history = (document.getElementById('ho-history')?.value || '').trim();
  const res = document.getElementById('ho-result');
  if (!study) { res.innerHTML = `<div class="empty"><p>Pick a DePACS study to write into.</p></div>`; return; }
  if (!history) { res.innerHTML = `<div class="empty"><p>Add the clinical history first.</p></div>`; return; }
  btn.disabled = true; btn.textContent = 'Writing…';
  try {
    await API.post('/handoff/write-history', { study_id: study, history, file_no: handoff.file });
    res.innerHTML = `<div class="card">✅ Clinical history written into the DePACS study. Now copy the message and paste it into the group.</div>`;
    loadHandoffStudies();   // refresh the study's shown history
  } catch (e) {
    res.innerHTML = `<div class="empty"><p>${escapeHtml(e.message || 'Write failed')}</p></div>`;
  } finally { btn.disabled = false; btn.textContent = 'Write history to DePACS'; }
}
