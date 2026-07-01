// ── Radiology handoff ─────────────────────────────────────────────────────────
// The daily radiology hand-off, in the order staff actually work:
//   1) look up the patient's order(s) in Siratech HIS by file (MRN) number,
//   2) image the patient and push the images to DePACS ("DE" / Butterfly),
//   3) mark "images sent" → poll DePACS until the newly-arrived study lands,
//   4) write the clinical indication (+ ER / non-ER) into THAT study — matched by
//      a baseline snapshot so a patient with several exams never gets the wrong
//      indication on the wrong study,
//   5) copy the ready-made WhatsApp message into the radiology group.

let handoff = {
  file: '', lookup: null, order: 0, priority: 'routine',
  studies: null, matched: null, studyId: '', candidates: null,
  baseline: null, polling: false, pollN: 0, pollTimer: null,
  msg: '', msgEdited: false,
};

const HO_POLL_EVERY_MS = 5000;
const HO_POLL_MAX = 36;            // ~3 minutes

function renderHandoffPage() {
  setTopbar('Radiology handoff', 'Pull the order, send to DePACS, write the indication');
  handoffStopPolling();
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Handoff', 'Radiology handoff', 'Pull the order from HIS, wait for the images in DePACS, write the indication, and copy the group message')}
    <div class="card" style="margin-bottom:16px">
      <div class="ho-step-title"><span class="ho-step-num">1</span> Patient file</div>
      <div class="ho-step-sub">Enter the file / MRN number to pull the radiology order from the hospital system.</div>
      <div style="display:flex;gap:9px;flex-wrap:wrap;margin-left:32px">
        <input id="ho-file" class="input" inputmode="numeric" placeholder="File / MRN number"
               value="${escapeHtml(handoff.file)}" style="flex:1;min-width:200px"
               onkeydown="if(event.key==='Enter')handoffLookup()">
        <button class="btn btn-primary" onclick="handoffLookup()">Look up</button>
      </div>
      <div id="ho-patient" style="margin-top:14px;margin-left:32px"></div>
    </div>
    <div id="ho-form"></div>
    <div id="ho-result" style="margin-top:14px"></div>`;
  if (handoff.lookup) { renderHandoffPatient(); renderHandoffForm(); }
}

// ── HIS lookup ────────────────────────────────────────────────────────────────
async function handoffLookup() {
  const file = (document.getElementById('ho-file').value || '').trim();
  if (!file) return;
  handoffStopPolling();
  handoff = { ...handoff, file, lookup: null, order: 0, studies: null, matched: null,
              studyId: '', candidates: null, baseline: null, msg: '', msgEdited: false };
  const pane = document.getElementById('ho-patient');
  pane.innerHTML = LOADING_HTML;
  document.getElementById('ho-form').innerHTML = '';
  document.getElementById('ho-result').innerHTML = '';
  try {
    handoff.lookup = await API.get(`/radiology/lookup/${encodeURIComponent(file)}`);
    const o = (handoff.lookup.orders || [])[0];
    handoff.priority = o && o.priority ? 'emergency' : 'routine';
    renderHandoffPatient();
    renderHandoffForm();
  } catch (e) {
    pane.innerHTML = `<div class="empty" style="padding:30px 16px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Lookup failed')}</p>
      <small>Check the file number, or that the HIS connector is reachable.</small></div>`;
  }
}

function handoffOrder() { return (handoff.lookup && handoff.lookup.orders || [])[handoff.order] || {}; }
function handoffHasOrders() { return !!(handoff.lookup && (handoff.lookup.orders || []).length); }

function renderHandoffPatient() {
  const d = handoff.lookup || {};
  const p = d.patient;
  const orders = d.orders || [];
  const pane = document.getElementById('ho-patient');
  const patientCard = p ? `
    <div class="ho-patient-name">${escapeHtml(p.name || '—')}</div>
    <div class="ho-patient-meta">
      ${p.gender ? `<span>${escapeHtml(p.gender)}</span>` : ''}
      ${p.age ? `<span>· ${escapeHtml(p.age)}</span>` : ''}
      ${p.dob ? `<span>· ${escapeHtml(p.dob)}</span>` : ''}
      <span>📞 ${escapeHtml(p.phone || '—')}</span>
      ${p.nationalId ? `<span>· ID ${escapeHtml(p.nationalId)}</span>` : ''}
    </div>` : `<div style="color:var(--muted)">No patient record found for this file.</div>`;
  let orderBlock;
  if (!orders.length) {
    orderBlock = `<div class="empty" style="padding:24px 16px"><p>No radiology order on this file.</p>
      <small>The order shows here once it's placed in the hospital system.</small></div>`;
  } else {
    orderBlock = `<div class="ho-lbl" style="margin-top:14px">Radiology order${orders.length > 1 ? 's — pick the one you imaged' : ''}</div>` +
      orders.map((o, i) => {
        const isImaged = o.imaged || (o.accessionNumber != null && String(o.accessionNumber).trim() !== '');
        return `<label class="ho-row ${i === handoff.order ? 'sel' : ''}">
          <input type="radio" name="ho-order" ${i === handoff.order ? 'checked' : ''} onchange="handoffPickOrder(${i})">
          <div class="ho-row-main">
            <div class="ho-row-title">${escapeHtml(o.service || '—')} <span style="color:var(--muted);font-weight:500">(${escapeHtml(o.modality || '')})</span></div>
            <div class="ho-row-sub">🏥 ${escapeHtml(o.branch || '—')}${o.orderedDate ? ' · ' + escapeHtml(o.orderedDate) : ''}</div>
          </div>
          <div class="ho-badges">
            ${o.status ? `<span class="badge badge-purple">${escapeHtml(o.status)}</span>` : ''}
            <span class="badge ${isImaged ? 'badge-green' : 'badge-orange'}">${isImaged ? 'In PACS' : 'Not imaged'}</span>
            ${o.accessionNumber ? `<span class="badge badge-yellow">ACC ${escapeHtml(o.accessionNumber)}</span>` : ''}
          </div>
        </label>`;
      }).join('');
  }
  pane.innerHTML = patientCard + orderBlock;
}

function handoffPickOrder(i) {
  handoffStopPolling();
  handoff.order = i; handoff.matched = null; handoff.studyId = ''; handoff.candidates = null; handoff.baseline = null;
  const o = handoffOrder();
  handoff.priority = o && o.priority ? 'emergency' : 'routine';
  if (!handoff.msgEdited) handoff.msg = '';
  renderHandoffPatient();
  renderHandoffForm();
}

// ── Steps 2–4 ─────────────────────────────────────────────────────────────────
function renderHandoffForm() {
  const form = document.getElementById('ho-form');
  if (!handoffHasOrders()) { form.innerHTML = ''; return; }
  const o = handoffOrder();
  form.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="ho-step-title"><span class="ho-step-num">2</span> Order details</div>
      <div style="margin-left:32px;margin-top:12px">
        <div class="ho-grid">
          <div><label class="ho-lbl">Exam</label>
            <input id="ho-exam" class="input" style="width:100%" value="${escapeHtml(o.service || '')}" oninput="handoffSyncMsg()"></div>
          <div><label class="ho-lbl">Branch</label>
            <input id="ho-branch" class="input" style="width:100%" value="${escapeHtml(o.branch || '')}" oninput="handoffSyncMsg()"></div>
        </div>
        <div style="margin-top:13px"><label class="ho-lbl">Priority</label>
          <div class="seg" id="ho-prio">
            <button type="button" class="${handoff.priority === 'routine' ? 'on' : ''}" onclick="handoffSetPrio('routine')">🕒 Routine</button>
            <button type="button" class="${handoff.priority === 'emergency' ? 'on' : ''}" onclick="handoffSetPrio('emergency')">🚨 ER / Emergency</button>
          </div>
        </div>
        <div style="margin-top:13px"><label class="ho-lbl">Clinical indication <span style="font-weight:500">(written into DePACS)</span></label>
          <textarea id="ho-history" class="input" rows="4" placeholder="Paste the clinical indication here…"></textarea></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="ho-step-title"><span class="ho-step-num" id="ho-step3num">3</span> Send to DePACS</div>
      <div class="ho-step-sub">Image the patient and push the images to DePACS, then press the button — we'll keep checking until the new study for this order lands, then write the indication into it.</div>
      <div id="ho-de" style="margin-left:32px"></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="ho-msg-head">
        <div class="ho-step-title"><span class="ho-step-num">4</span> WhatsApp message</div>
        <button class="btn btn-sm btn-primary" onclick="handoffCopy(this)">📋 Copy</button>
      </div>
      <textarea id="ho-message" class="input" rows="6" oninput="handoffMsgInput(this)"></textarea>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">Copy this and paste it into the radiology WhatsApp group.</div>
    </div>`;
  renderHandoffDE();
  handoffSyncMsg(true);
  const hist = document.getElementById('ho-history');
  if (hist && handoff.history) hist.value = handoff.history;
  if (hist) hist.oninput = () => { handoff.history = hist.value; };
}

function handoffSetPrio(p) {
  handoff.priority = p;
  document.querySelectorAll('#ho-prio button').forEach((b, idx) => b.classList.toggle('on', (p === 'routine') === (idx === 0)));
  handoffSyncMsg();
}

// ── DePACS: poll → match → write ──────────────────────────────────────────────
function renderHandoffDE() {
  const box = document.getElementById('ho-de');
  if (!box) return;
  const o = handoffOrder();
  const num = document.getElementById('ho-step3num');

  if (handoff.matched) {
    if (num) { num.classList.add('done'); num.textContent = '✓'; }
    const s = handoff.matched;
    box.innerHTML = `
      <div class="ho-de-box ok">
        <div style="font-weight:700;color:var(--text)">🖼️ ${escapeHtml(s.modality || '')}${s.study_date ? ' · ' + escapeHtml(String(s.study_date).slice(0,16).replace('T',' ')) : ''}${s.study_desc ? ' · ' + escapeHtml(s.study_desc) : ''}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">study #${escapeHtml(String(s.study_id))}${s.status ? ' · ' + escapeHtml(s.status) : ''} · order: <b>${escapeHtml(o.service || '')}</b> (${escapeHtml(o.modality || '')})</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">Current history: ${escapeHtml(s.history || '—')}</div>
        <div class="ho-note">⚠️ Make sure this is the exam you just sent before writing.</div>
      </div>
      <div class="ho-actions">
        <button class="btn btn-primary" onclick="handoffWrite(this)">Write indication to DePACS</button>
        <button class="btn btn-sm" onclick="handoffRepoll()">Re-check / change study</button>
      </div>`;
    return;
  }
  if (num) { num.classList.remove('done'); num.textContent = '3'; }

  if (handoff.candidates && handoff.candidates.length > 1) {
    box.innerHTML = `<div class="ho-note" style="margin:0 0 8px">⚠️ More than one recent study — pick the exact exam you sent (order: <b>${escapeHtml(o.service || '')}</b> ${escapeHtml(o.modality || '')}):</div>
      ${handoff.candidates.map(s => `
        <label class="ho-row">
          <input type="radio" name="ho-cand" onchange="handoffChoose(${s.study_id})">
          <div class="ho-row-main">
            <div class="ho-row-title">${escapeHtml(s.modality || '')}${s.study_date ? ' · ' + escapeHtml(String(s.study_date).slice(0,16).replace('T',' ')) : ''}${s.study_desc ? ' · ' + escapeHtml(s.study_desc) : ''}</div>
            <div class="ho-row-sub">study #${escapeHtml(String(s.study_id))} · ${escapeHtml(s.history || 'no history yet')}</div>
          </div>
        </label>`).join('')}`;
    return;
  }

  box.innerHTML = handoff.polling
    ? `<div class="ho-de-box" style="display:flex;gap:10px;align-items:center">
         <span style="font-size:16px">⏳</span>
         <span style="font-size:13px;color:var(--muted);flex:1">Waiting for the study in DePACS… (check ${handoff.pollN}/${HO_POLL_MAX})</span>
         <button class="btn btn-sm" onclick="handoffStopPolling(true)">Stop</button></div>`
    : `<div class="ho-actions" style="margin-top:0">
         <button class="btn btn-primary" onclick="handoffStartPolling()">✅ Images sent — find the study</button>
         <button class="btn btn-sm" onclick="handoffStartPolling()">It's already there</button>
       </div>`;
}

async function handoffStartPolling() {
  handoff.polling = true; handoff.pollN = 0; handoff.candidates = null; handoff.matched = null;
  renderHandoffDE();
  if (!(handoff.baseline instanceof Set)) {
    try {
      const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
      handoff.baseline = new Set((r.studies || []).map(s => String(s.study_id)));
    } catch (e) { handoff.baseline = new Set(); }
  }
  handoffPollTick();
}

function handoffStopPolling(rerender) {
  handoff.polling = false;
  if (handoff.pollTimer) { clearTimeout(handoff.pollTimer); handoff.pollTimer = null; }
  if (rerender) renderHandoffDE();
}

function _isToday(d) {
  if (!d) return false;
  const t = new Date();
  return String(d).slice(0, 10) === `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

async function handoffPollTick() {
  if (!handoff.polling) return;
  handoff.pollN += 1;
  const o = handoffOrder();
  try {
    const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
    handoff.studies = r.studies || [];
    const base = handoff.baseline instanceof Set ? handoff.baseline : new Set();
    let pool = handoff.studies.filter(s => !base.has(String(s.study_id)));   // freshly-arrived
    if (!pool.length) pool = handoff.studies.filter(s => _isToday(s.study_date));  // today, as a fallback
    if (pool.length === 1) { handoff.matched = pool[0]; handoff.studyId = String(pool[0].study_id); handoffStopPolling(); renderHandoffDE(); return; }
    if (pool.length > 1) { handoff.candidates = pool; handoffStopPolling(); renderHandoffDE(); return; }
  } catch (e) { /* keep polling through transient errors */ }
  if (handoff.pollN >= HO_POLL_MAX) {
    handoff.polling = false;
    const box = document.getElementById('ho-de');
    if (box) box.innerHTML = `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">No new study in DePACS yet — the images may still be on the way.</div>
      <div class="ho-actions" style="margin-top:0">
        <button class="btn btn-primary" onclick="handoffStartPolling()">Check again</button>
        <button class="btn btn-sm" onclick="handoffPickAny()">Pick from all studies</button></div>`;
    return;
  }
  handoff.pollTimer = setTimeout(handoffPollTick, HO_POLL_EVERY_MS);
  renderHandoffDE();
}

function handoffRepoll() { handoff.matched = null; handoff.studyId = ''; handoff.candidates = null; handoffStartPolling(); }

function handoffPickAny() {
  const all = (handoff.studies || []).slice();
  if (!all.length) { handoffStartPolling(); return; }
  if (all.length === 1) { handoff.matched = all[0]; handoff.studyId = String(all[0].study_id); handoff.candidates = null; }
  else { handoff.candidates = all; }
  renderHandoffDE();
}

function handoffChoose(studyId) {
  const s = (handoff.candidates || []).find(x => String(x.study_id) === String(studyId));
  if (!s) return;
  handoff.matched = s; handoff.studyId = String(studyId); handoff.candidates = null;
  renderHandoffDE();
}

async function handoffWrite(btn) {
  const o = handoffOrder();
  const history = (document.getElementById('ho-history')?.value || '').trim();
  const res = document.getElementById('ho-result');
  if (!handoff.studyId) { res.innerHTML = `<div class="empty" style="padding:22px"><p>Find/select the DePACS study first.</p></div>`; return; }
  if (!history) { res.innerHTML = `<div class="empty" style="padding:22px"><p>Add the clinical indication first.</p></div>`; return; }
  const s = handoff.matched || {};
  if (!confirm(`Write the indication into this DePACS study?\n\n${s.modality || ''} · ${String(s.study_date || '').slice(0,16).replace('T',' ')}${s.study_desc ? ' · ' + s.study_desc : ''}\nstudy #${handoff.studyId}\n\nOrder: ${o.service || ''} (${o.modality || ''})`)) return;
  const body = handoff.priority === 'emergency' ? `🚨 ER — ${history}` : history;
  btn.disabled = true; btn.textContent = 'Writing…';
  try {
    await API.post('/handoff/write-history', { study_id: handoff.studyId, history: body, file_no: handoff.file });
    res.innerHTML = `<div class="card" style="border:1.5px solid #a9e2bf;background:rgba(0,200,150,.06)">
      ✅ <b>Clinical indication written</b> into DePACS study #${escapeHtml(String(handoff.studyId))}. Now copy the message and paste it into the group.</div>`;
    try {
      const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
      const st = (r.studies || []).find(x => String(x.study_id) === String(handoff.studyId));
      if (st) { handoff.matched = st; renderHandoffDE(); }
    } catch (e) {}
  } catch (e) {
    res.innerHTML = `<div class="empty" style="padding:22px"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message || 'Write failed')}</p></div>`;
  } finally { btn.disabled = false; btn.textContent = 'Write indication to DePACS'; }
}

// ── WhatsApp message (copy/paste) ─────────────────────────────────────────────
function handoffBuildMsg() {
  const exam = (document.getElementById('ho-exam')?.value || '').trim();
  const branch = (document.getElementById('ho-branch')?.value || '').trim();
  const prio = handoff.priority === 'emergency' ? '🚨 طارئ / ER' : '🕒 روتيني / Routine';
  return ['🩻 طلب أشعة / Radiology handoff',
    `📄 الملف / File: ${handoff.file}`,
    exam ? `🔬 الفحص / Exam: ${exam}` : '',
    `⚑ الأولوية / Priority: ${prio}`,
    branch ? `🏥 الفرع / Branch: ${branch}` : ''].filter(Boolean).join('\n');
}

// Keep the message in sync with the fields until the user edits it by hand.
function handoffSyncMsg(force) {
  const m = document.getElementById('ho-message');
  if (!m) return;
  if (force || !handoff.msgEdited) { handoff.msg = handoffBuildMsg(); m.value = handoff.msg; }
}
function handoffMsgInput(el) { handoff.msgEdited = true; handoff.msg = el.value; }

async function handoffCopy(btn) {
  const m = document.getElementById('ho-message');
  if (!m) return;
  const done = () => { if (btn) { const t = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = t; }, 1400); } };
  try { await navigator.clipboard.writeText(m.value); done(); }
  catch (e) { m.select(); try { document.execCommand('copy'); done(); } catch (_e) {} }
}
