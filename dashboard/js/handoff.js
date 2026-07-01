// ── Radiology handoff (step wizard) ───────────────────────────────────────────
// One patient at a time, in the order staff work:
//   Step 1  Patient   — look up the file, see paid/not-paid + the order, pick it
//   Step 2  Details   — exam · branch · priority · clinical indication
//   Step 3  DePACS    — "images sent" → poll until the new study lands → write it
//   Step 4  Message   — copy the ready WhatsApp text for the group
// Only the current step is on screen; a progress bar shows where you are.

let handoff = {
  step: 1,
  file: '', lookup: null, order: 0, priority: 'routine', history: '',
  studies: null, matched: null, studyId: '', candidates: null,
  baseline: null, polling: false, pollN: 0, pollTimer: null,
  msg: '', msgEdited: false,
};

const HO_POLL_EVERY_MS = 5000;
const HO_POLL_MAX = 36;            // ~3 minutes
const HO_STEPS = ['Patient', 'Details', 'DePACS', 'Message'];

function renderHandoffPage() {
  setTopbar('Radiology handoff', 'One patient, step by step');
  handoffStopPolling();
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Handoff', 'Radiology handoff', 'Look up the order, send to DePACS, write the indication, message the group')}
    <div id="ho-steps" class="ho-steps"></div>
    <div id="ho-body"></div>`;
  renderHandoffSteps();
  renderHandoffStep();
}

function handoffOrders() { return (handoff.lookup && handoff.lookup.orders) || []; }
function handoffOrder() { return handoffOrders()[handoff.order] || {}; }
function handoffHasOrders() { return handoffOrders().length > 0; }
function handoffMaxStep() { return handoffHasOrders() ? 4 : 1; }   // can't advance without an order

function renderHandoffSteps() {
  const bar = document.getElementById('ho-steps');
  if (!bar) return;
  bar.innerHTML = HO_STEPS.map((label, i) => {
    const n = i + 1;
    const state = n < handoff.step ? 'done' : (n === handoff.step ? 'cur' : 'idle');
    const reachable = n <= handoff.step || (n <= handoffMaxStep());
    return `<div class="ho-stepitem ${state}" ${reachable ? `onclick="handoffGo(${n})"` : ''}>
        <span class="ho-stepdot">${state === 'done' ? '✓' : n}</span>
        <span class="ho-steplabel">${label}</span>
      </div>${n < HO_STEPS.length ? '<span class="ho-stepbar"></span>' : ''}`;
  }).join('');
}

function handoffGo(step) {
  step = Math.max(1, Math.min(step, handoffMaxStep()));
  if (step !== 3) handoffStopPolling();
  handoff.step = step;
  renderHandoffSteps();
  renderHandoffStep();
}
function handoffNext() { handoffGo(handoff.step + 1); }
function handoffBack() { handoffGo(handoff.step - 1); }

function handoffNav(backLabel, nextLabel, nextEnabled, nextFn) {
  return `<div class="ho-nav">
    ${handoff.step > 1 ? `<button class="btn btn-ghost" onclick="handoffBack()">← ${escapeHtml(backLabel || 'Back')}</button>` : '<span></span>'}
    ${nextLabel ? `<button class="btn btn-primary" ${nextEnabled ? '' : 'disabled'} onclick="${nextFn || 'handoffNext()'}">${escapeHtml(nextLabel)} →</button>` : '<span></span>'}
  </div>`;
}

function renderHandoffStep() {
  const b = document.getElementById('ho-body');
  if (!b) return;
  if (handoff.step === 1) return hoStep1(b);
  if (handoff.step === 2) return hoStep2(b);
  if (handoff.step === 3) return hoStep3(b);
  if (handoff.step === 4) return hoStep4(b);
}

// ── Step 1 · Patient ──────────────────────────────────────────────────────────
function hoStep1(b) {
  b.innerHTML = `
    <div class="card">
      <div class="ho-step-title"><span class="ho-step-num">1</span> Patient file</div>
      <div class="ho-step-sub">Enter the file / MRN number to pull the order from the hospital system.</div>
      <div style="display:flex;gap:9px;flex-wrap:wrap;margin-left:32px">
        <input id="ho-file" class="input" inputmode="numeric" placeholder="File / MRN number"
               value="${escapeHtml(handoff.file)}" style="flex:1;min-width:200px"
               onkeydown="if(event.key==='Enter')handoffLookup()">
        <button class="btn btn-primary" onclick="handoffLookup()">Look up</button>
      </div>
      <div id="ho-patient" style="margin:16px 0 4px 32px"></div>
      ${handoffNav('Back', 'Next', handoffHasOrders())}
    </div>`;
  if (handoff.lookup) renderHandoffPatient();
}

async function handoffLookup() {
  const file = (document.getElementById('ho-file').value || '').trim();
  if (!file) return;
  handoffStopPolling();
  handoff = { ...handoff, file, lookup: null, order: 0, history: '', studies: null, matched: null,
              studyId: '', candidates: null, baseline: null, msg: '', msgEdited: false };
  const pane = document.getElementById('ho-patient');
  pane.innerHTML = LOADING_HTML;
  try {
    handoff.lookup = await API.get(`/radiology/lookup/${encodeURIComponent(file)}`);
    const o = handoffOrders()[0];
    handoff.priority = o && o.priority ? 'emergency' : 'routine';
    renderHandoffPatient();
    renderHandoffSteps();
    hoStep1(document.getElementById('ho-body'));   // refresh Next-enabled state
  } catch (e) {
    pane.innerHTML = `<div class="empty" style="padding:26px 16px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Lookup failed')}</p>
      <small>Check the file number, or that the HIS connector is reachable.</small></div>`;
  }
}

function renderHandoffPatient() {
  const d = handoff.lookup || {};
  const p = d.patient;
  const orders = d.orders || [];
  const pane = document.getElementById('ho-patient');
  const head = p ? `
    <div class="ho-patient-name">${escapeHtml(p.name || '—')}</div>
    <div class="ho-patient-meta">
      ${p.gender ? `<span>${escapeHtml(p.gender)}</span>` : ''}
      ${p.age ? `<span>· ${escapeHtml(p.age)}</span>` : ''}
      ${p.dob ? `<span>· ${escapeHtml(p.dob)}</span>` : ''}
      <span>📞 ${escapeHtml(p.phone || '—')}</span>
    </div>` : `<div style="color:var(--muted)">No patient record found for this file.</div>`;
  let block;
  if (!orders.length) {
    block = `<div class="empty" style="padding:24px 16px"><p>No radiology order on this file.</p>
      <small>The order appears here once it's placed in the hospital system.</small></div>`;
  } else {
    block = `<div class="ho-lbl" style="margin-top:14px">Radiology order${orders.length > 1 ? 's — pick the one you imaged' : ''}</div>` +
      orders.map((o, i) => {
        const imaged = o.imaged || (o.accessionNumber != null && String(o.accessionNumber).trim() !== '');
        const chip = imaged
          ? `<span class="badge badge-green">✅ تم التصوير · Imaged</span>`
          : `<span class="badge badge-orange">⏳ بانتظار التصوير · Not imaged</span>`;
        return `<label class="ho-row ${i === handoff.order ? 'sel' : ''}">
          <input type="radio" name="ho-order" ${i === handoff.order ? 'checked' : ''} onchange="handoffPickOrder(${i})">
          <div class="ho-row-main">
            <div class="ho-row-title">${escapeHtml(o.service || '—')} <span style="color:var(--muted);font-weight:500">(${escapeHtml(o.modality || '')})</span></div>
            <div class="ho-row-sub">🏥 ${escapeHtml(o.branch || '—')}${o.orderedDate ? ' · ' + escapeHtml(o.orderedDate) : ''}</div>
          </div>
          <div class="ho-badges">${chip}</div>
        </label>`;
      }).join('');
  }
  pane.innerHTML = head + block;
}

function handoffPickOrder(i) {
  handoffStopPolling();
  handoff.order = i; handoff.matched = null; handoff.studyId = ''; handoff.candidates = null; handoff.baseline = null;
  const o = handoffOrder();
  handoff.priority = o && o.priority ? 'emergency' : 'routine';
  if (!handoff.msgEdited) handoff.msg = '';
  renderHandoffPatient();
}

// ── Step 2 · Details ──────────────────────────────────────────────────────────
function hoStep2(b) {
  const o = handoffOrder();
  b.innerHTML = `
    <div class="card">
      <div class="ho-step-title"><span class="ho-step-num">2</span> Order details</div>
      <div style="margin:14px 0 0 32px">
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
          <textarea id="ho-history" class="input" rows="4" placeholder="Paste the clinical indication here…" oninput="handoff.history=this.value">${escapeHtml(handoff.history || '')}</textarea></div>
      </div>
      ${handoffNav('Back', 'Next', true)}
    </div>`;
}

function handoffSetPrio(p) {
  handoff.priority = p;
  document.querySelectorAll('#ho-prio button').forEach((b, idx) => b.classList.toggle('on', (p === 'routine') === (idx === 0)));
  handoffSyncMsg();
}

// ── Step 3 · DePACS ───────────────────────────────────────────────────────────
function hoStep3(b) {
  b.innerHTML = `
    <div class="card">
      <div class="ho-step-title"><span class="ho-step-num" id="ho-step3num">3</span> Send to DePACS</div>
      <div class="ho-step-sub">Image the patient and push the images to DePACS, then press the button — we keep checking until the new study lands, then write the indication into it.</div>
      <div id="ho-de" style="margin-left:32px"></div>
      <div id="ho-result" style="margin:12px 0 0 32px"></div>
      ${handoffNav('Back', 'Next', true)}
    </div>`;
  renderHandoffDE();
}

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
        <button class="btn btn-sm btn-ghost" onclick="handoffRepoll()">Re-check / change study</button>
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
         <button class="btn btn-sm btn-ghost" onclick="handoffStopPolling(true)">Stop</button></div>`
    : `<div class="ho-actions" style="margin-top:0">
         <button class="btn btn-primary" onclick="handoffStartPolling()">✅ Images sent — find the study</button>
         <button class="btn btn-sm btn-ghost" onclick="handoffStartPolling()">It's already there</button>
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
  try {
    const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
    handoff.studies = r.studies || [];
    const base = handoff.baseline instanceof Set ? handoff.baseline : new Set();
    let pool = handoff.studies.filter(s => !base.has(String(s.study_id)));
    if (!pool.length) pool = handoff.studies.filter(s => _isToday(s.study_date));
    if (pool.length === 1) { handoff.matched = pool[0]; handoff.studyId = String(pool[0].study_id); handoffStopPolling(); renderHandoffDE(); return; }
    if (pool.length > 1) { handoff.candidates = pool; handoffStopPolling(); renderHandoffDE(); return; }
  } catch (e) { /* keep polling through transient errors */ }
  if (handoff.pollN >= HO_POLL_MAX) {
    handoff.polling = false;
    const box = document.getElementById('ho-de');
    if (box) box.innerHTML = `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">No new study in DePACS yet — the images may still be on the way.</div>
      <div class="ho-actions" style="margin-top:0">
        <button class="btn btn-primary" onclick="handoffStartPolling()">Check again</button>
        <button class="btn btn-sm btn-ghost" onclick="handoffPickAny()">Pick from all studies</button></div>`;
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
  const history = (handoff.history || '').trim();
  const res = document.getElementById('ho-result');
  if (!handoff.studyId) { res.innerHTML = `<div class="ho-note">Find/select the DePACS study first.</div>`; return; }
  if (!history) { res.innerHTML = `<div class="ho-note">Go back to step 2 and add the clinical indication first.</div>`; return; }
  const s = handoff.matched || {};
  if (!confirm(`Write the indication into this DePACS study?\n\n${s.modality || ''} · ${String(s.study_date || '').slice(0,16).replace('T',' ')}${s.study_desc ? ' · ' + s.study_desc : ''}\nstudy #${handoff.studyId}\n\nOrder: ${o.service || ''} (${o.modality || ''})`)) return;
  const body = handoff.priority === 'emergency' ? `🚨 ER — ${history}` : history;
  btn.disabled = true; btn.textContent = 'Writing…';
  try {
    await API.post('/handoff/write-history', { study_id: handoff.studyId, history: body, file_no: handoff.file });
    res.innerHTML = `<div class="ho-de-box ok">✅ <b>Written</b> into DePACS study #${escapeHtml(String(handoff.studyId))}. Continue to the message →</div>`;
    try {
      const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
      const st = (r.studies || []).find(x => String(x.study_id) === String(handoff.studyId));
      if (st) { handoff.matched = st; renderHandoffDE(); }
    } catch (e) {}
  } catch (e) {
    res.innerHTML = `<div class="empty" style="padding:18px"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message || 'Write failed')}</p></div>`;
  } finally { btn.disabled = false; btn.textContent = 'Write indication to DePACS'; }
}

// ── Step 4 · Message ──────────────────────────────────────────────────────────
function hoStep4(b) {
  b.innerHTML = `
    <div class="card">
      <div class="ho-msg-head">
        <div class="ho-step-title"><span class="ho-step-num">4</span> WhatsApp message</div>
        <button class="btn btn-sm btn-primary" onclick="handoffCopy(this)">📋 Copy</button>
      </div>
      <textarea id="ho-message" class="input" rows="6" oninput="handoffMsgInput(this)"></textarea>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">Copy this and paste it into the radiology WhatsApp group.</div>
      <div class="ho-nav">
        <button class="btn btn-ghost" onclick="handoffBack()">← Back</button>
        <button class="btn btn-primary" onclick="handoffReset()">Done · new patient</button>
      </div>
    </div>`;
  handoffSyncMsg(true);
}
function handoffReset() {
  handoffStopPolling();
  handoff = { step: 1, file: '', lookup: null, order: 0, priority: 'routine', history: '',
              studies: null, matched: null, studyId: '', candidates: null,
              baseline: null, polling: false, pollN: 0, pollTimer: null, msg: '', msgEdited: false };
  renderHandoffSteps(); renderHandoffStep();
}

function handoffBuildMsg() {
  const exam = (document.getElementById('ho-exam')?.value || handoffOrder().service || '').trim();
  const branch = (document.getElementById('ho-branch')?.value || handoffOrder().branch || '').trim();
  const prio = handoff.priority === 'emergency' ? '🚨 طارئ / ER' : '🕒 روتيني / Routine';
  return ['🩻 طلب أشعة / Radiology handoff',
    `📄 الملف / File: ${handoff.file}`,
    exam ? `🔬 الفحص / Exam: ${exam}` : '',
    `⚑ الأولوية / Priority: ${prio}`,
    branch ? `🏥 الفرع / Branch: ${branch}` : ''].filter(Boolean).join('\n');
}
function handoffSyncMsg(force) {
  const m = document.getElementById('ho-message');
  if (force || !handoff.msgEdited) handoff.msg = handoffBuildMsg();
  if (m) m.value = handoff.msg;
}
function handoffMsgInput(el) { handoff.msgEdited = true; handoff.msg = el.value; }
async function handoffCopy(btn) {
  const m = document.getElementById('ho-message');
  if (!m) return;
  const done = () => { if (btn) { const t = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = t; }, 1400); } };
  try { await navigator.clipboard.writeText(m.value); done(); }
  catch (e) { m.select(); try { document.execCommand('copy'); done(); } catch (_e) {} }
}
