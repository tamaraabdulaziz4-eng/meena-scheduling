// ── Radiology handoff ─────────────────────────────────────────────────────────
// The daily radiology hand-off, in the order staff actually work:
//   1) look up the patient's order(s) in Siratech HIS by file (MRN) number,
//   2) image the patient and push the images to DePACS ("DE" / Butterfly),
//   3) mark "images sent" → we POLL DePACS until the matching study lands
//      (images take a while to arrive),
//   4) write the clinical indication (+ ER / non-ER) into THAT study — matched to
//      the order's modality so a patient with several exams never gets the wrong
//      indication on the wrong study,
//   5) copy the ready-made WhatsApp message into the radiology group.

let handoff = {
  file: '', lookup: null, order: 0, priority: 'routine',
  studies: null, matched: null, studyId: '', polling: false, pollN: 0, pollTimer: null, candidates: null,
};

const HO_POLL_EVERY_MS = 5000;
const HO_POLL_MAX = 36;            // ~3 minutes

function renderHandoffPage() {
  setTopbar('Radiology handoff', 'Pull the order, send to DePACS, write the indication');
  handoffStopPolling();
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Radiology handoff', 'Handoff', 'Pull the order from HIS, wait for the images in DePACS, write the indication, and copy the group message')}
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
  handoffStopPolling();
  handoff = { ...handoff, file, lookup: null, order: 0, studies: null, matched: null, studyId: '', candidates: null };
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
  } catch (e) {
    pane.innerHTML = `<div class="empty"><p>${escapeHtml(e.message || 'Lookup failed')}</p></div>`;
  }
}

function handoffOrder() { return (handoff.lookup?.orders || [])[handoff.order] || {}; }

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
    <div style="font-size:12px;color:var(--muted);margin:6px 0">${orders.length} radiology order(s)${orders.length > 1 ? ' — pick the one you imaged' : ''}</div>
    ${orderRows}`;
}

function handoffPickOrder(i) {
  handoffStopPolling();
  handoff.order = i; handoff.matched = null; handoff.studyId = ''; handoff.candidates = null;
  const o = handoffOrder();
  handoff.priority = o && o.priority ? 'emergency' : 'routine';
  renderHandoffForm();
}

// ── Form ──────────────────────────────────────────────────────────────────────
function renderHandoffForm() {
  const o = handoffOrder();
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
          <button type="button" class="${handoff.priority === 'emergency' ? 'on' : ''}" onclick="handoffSetPrio('emergency')">🚨 ER / Emergency</button>
        </div>
      </div>
      <div style="margin-top:10px"><label class="ho-lbl">Clinical indication (written into DePACS)</label>
        <textarea id="ho-history" class="input" rows="4" placeholder="Paste the clinical indication here"></textarea></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div style="font-weight:600;margin-bottom:6px">Send to DePACS</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
        Image the patient and push the images to DePACS, then press the button — we'll keep checking until the
        <b>${escapeHtml(o.modality || '?')}</b> study for this order lands, then write the indication into it.</div>
      <div id="ho-de"></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <label class="ho-lbl" style="margin:0">WhatsApp group message</label>
        <button class="btn btn-sm btn-primary" onclick="handoffCopy()">📋 Copy message</button>
      </div>
      <textarea id="ho-message" class="input" rows="6"></textarea>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">Copy this and paste it into the radiology WhatsApp group.</div>
    </div>`;
  renderHandoffDE();
  handoffPreview();
}

function handoffSetPrio(p) {
  handoff.priority = p;
  document.querySelectorAll('#ho-prio button').forEach((b, idx) => b.classList.toggle('on', (p === 'routine') === (idx === 0)));
  handoffPreview();
}

// ── DePACS: poll → match → write ──────────────────────────────────────────────
function renderHandoffDE() {
  const box = document.getElementById('ho-de');
  if (!box) return;
  const o = handoffOrder();
  if (handoff.matched) {
    const s = handoff.matched;
    const ok = studyMatchesOrder(s, o);
    box.innerHTML = `
      <div style="padding:10px;border:1px solid ${ok ? '#bfe6cd' : '#f2c9c0'};background:${ok ? '#f3fbf5' : '#fef4f2'};border-radius:10px">
        <div style="font-weight:600">${ok ? '✅' : '⚠️'} ${escapeHtml(s.modality || '')} · ${escapeHtml(s.study_date || '')}${s.study_desc ? ' · ' + escapeHtml(s.study_desc) : ''}</div>
        <div style="font-size:12px;color:var(--muted)">study #${escapeHtml(String(s.study_id))} · ${escapeHtml(s.status || '')}${ok ? '' : ' — modality does NOT match the order (' + escapeHtml(o.modality || '') + ')'}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">Current history: ${escapeHtml(s.history || '—')}</div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="handoffWrite()">Write indication to DePACS</button>
        <button class="btn btn-sm" onclick="handoffRepoll()">Re-check / change study</button>
      </div>`;
    return;
  }
  if (handoff.candidates && handoff.candidates.length > 1) {
    box.innerHTML = `<div style="font-size:13px;color:#8a5a00;margin-bottom:8px">⚠️ More than one ${escapeHtml(o.modality || '')} study — pick the exact one to avoid writing to the wrong exam:</div>
      ${handoff.candidates.map(s => `
        <label style="display:flex;gap:10px;align-items:center;padding:7px 10px;border:1px solid var(--border,#e5e5ef);border-radius:10px;margin-bottom:6px;cursor:pointer">
          <input type="radio" name="ho-cand" onchange="handoffChoose(${s.study_id})">
          <div style="flex:1"><div style="font-weight:600">${escapeHtml(s.modality || '')} · ${escapeHtml(s.study_date || '')}${s.study_desc ? ' · ' + escapeHtml(s.study_desc) : ''}</div>
            <div style="font-size:12px;color:var(--muted)">study #${escapeHtml(String(s.study_id))} · ${escapeHtml(s.history || 'no history yet')}</div></div>
        </label>`).join('')}`;
    return;
  }
  box.innerHTML = handoff.polling
    ? `<div style="display:flex;gap:10px;align-items:center">
         <span style="font-size:16px">⏳</span>
         <span style="font-size:13px;color:var(--muted)">Waiting for the ${escapeHtml(o.modality || '')} study in DePACS… (check ${handoff.pollN}/${HO_POLL_MAX})</span>
         <button class="btn btn-sm" onclick="handoffStopPolling(true)">Stop</button></div>`
    : `<button class="btn btn-primary" onclick="handoffStartPolling()">✅ Images sent to DePACS — find the study</button>
       <button class="btn btn-sm" style="margin-left:8px" onclick="handoffStartPolling()">It's already there</button>`;
}

function studyMatchesOrder(s, o) {
  const om = (o.modality || '').toUpperCase().trim();
  const sm = (s.modality || '').toUpperCase().trim();
  return !!om && om === sm;
}

async function handoffStartPolling() {
  handoff.polling = true; handoff.pollN = 0; handoff.candidates = null; handoff.matched = null;
  renderHandoffDE();
  handoffPollTick();
}

function handoffStopPolling(rerender) {
  handoff.polling = false;
  if (handoff.pollTimer) { clearTimeout(handoff.pollTimer); handoff.pollTimer = null; }
  if (rerender) renderHandoffDE();
}

async function handoffPollTick() {
  if (!handoff.polling) return;
  handoff.pollN += 1;
  const o = handoffOrder();
  try {
    const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
    handoff.studies = r.studies || [];
    const cands = handoff.studies.filter(s => studyMatchesOrder(s, o));
    if (cands.length === 1) {
      handoff.matched = cands[0]; handoff.studyId = String(cands[0].study_id);
      handoffStopPolling(); renderHandoffDE(); return;
    }
    if (cands.length > 1) {
      // Narrow by study description vs the order's exam name; else ask the user.
      const exam = (handoffOrder().service || '').toUpperCase();
      const narrowed = cands.filter(s => (s.study_desc || '').toUpperCase() && exam.includes((s.study_desc || '').toUpperCase().split(' ')[0]));
      if (narrowed.length === 1) { handoff.matched = narrowed[0]; handoff.studyId = String(narrowed[0].study_id); handoffStopPolling(); renderHandoffDE(); return; }
      handoff.candidates = cands; handoffStopPolling(); renderHandoffDE(); return;
    }
  } catch (e) { /* keep polling through transient errors */ }
  if (handoff.pollN >= HO_POLL_MAX) {
    handoff.polling = false;
    const box = document.getElementById('ho-de');
    if (box) box.innerHTML = `<div style="font-size:13px;color:var(--muted);margin-bottom:8px">No matching ${escapeHtml(o.modality || '')} study in DePACS yet — the images may still be on the way.</div>
      <button class="btn btn-primary" onclick="handoffStartPolling()">Check again</button>`;
    return;
  }
  handoff.pollTimer = setTimeout(handoffPollTick, HO_POLL_EVERY_MS);
  renderHandoffDE();
}

function handoffRepoll() { handoff.matched = null; handoff.studyId = ''; handoff.candidates = null; handoffStartPolling(); }

function handoffChoose(studyId) {
  const s = (handoff.candidates || []).find(x => String(x.study_id) === String(studyId));
  if (!s) return;
  handoff.matched = s; handoff.studyId = String(studyId); handoff.candidates = null;
  renderHandoffDE();
}

async function handoffWrite() {
  const o = handoffOrder();
  const btn = event.target;
  const history = (document.getElementById('ho-history')?.value || '').trim();
  const res = document.getElementById('ho-result');
  if (!handoff.studyId) { res.innerHTML = `<div class="empty"><p>Find/select the DePACS study first.</p></div>`; return; }
  if (!history) { res.innerHTML = `<div class="empty"><p>Add the clinical indication first.</p></div>`; return; }
  if (handoff.matched && !studyMatchesOrder(handoff.matched, o)
      && !confirm(`The selected study is ${handoff.matched.modality || '?'} but the order is ${o.modality || '?'}. Write anyway?`)) return;
  const body = handoff.priority === 'emergency' ? `🚨 ER — ${history}` : history;
  btn.disabled = true; btn.textContent = 'Writing…';
  try {
    await API.post('/handoff/write-history', { study_id: handoff.studyId, history: body, file_no: handoff.file });
    res.innerHTML = `<div class="card">✅ Indication written into DePACS study #${escapeHtml(String(handoff.studyId))}. Now copy the message into the group.</div>`;
    // refresh the shown history on the matched card
    try { const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
      const s = (r.studies || []).find(x => String(x.study_id) === String(handoff.studyId));
      if (s) { handoff.matched = s; renderHandoffDE(); } } catch (e) {}
  } catch (e) {
    res.innerHTML = `<div class="empty"><p>${escapeHtml(e.message || 'Write failed')}</p></div>`;
  } finally { btn.disabled = false; btn.textContent = 'Write indication to DePACS'; }
}

// ── WhatsApp message (copy/paste) ─────────────────────────────────────────────
function handoffMessage() {
  const exam = (document.getElementById('ho-exam')?.value || '').trim();
  const branch = (document.getElementById('ho-branch')?.value || '').trim();
  const prio = handoff.priority === 'emergency' ? '🚨 طارئ / ER' : '🕒 روتيني / Routine';
  return ['🩻 طلب أشعة / Radiology handoff',
    `📄 الملف / File: ${handoff.file}`,
    exam ? `🔬 الفحص / Exam: ${exam}` : '',
    `⚑ الأولوية / Priority: ${prio}`,
    branch ? `🏥 الفرع / Branch: ${branch}` : ''].filter(Boolean).join('\n');
}

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
    if (typeof toast === 'function') toast('Message copied');
  } catch (e) {
    m.select(); try { document.execCommand('copy'); } catch (_e) {}
  }
}
