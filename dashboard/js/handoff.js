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
  written: null, writing: false,
  msg: '', msgEdited: false,
};

const HO_POLL_EVERY_MS = 5000;
const HO_POLL_MAX = 36;            // ~3 minutes
const HO_STEPS = ['Patient', 'Details', 'DePACS', 'Message'];

// Modality normaliser (mirror of the connector's results.normMod): DX/CR/DR→XR,
// MRI→MR, etc. Used to guard the auto-write — when a patient is imaged for several
// exams in one sitting, studies land in DePACS one at a time, and we must NOT
// auto-write the picked order's indication into a study of a DIFFERENT modality
// (e.g. the chest study landing first while you're handling the abdomen order).
const HO_MOD_MAP = { DX: 'XR', CR: 'XR', DR: 'XR', XR: 'XR', CT: 'CT', MR: 'MR', MRI: 'MR', US: 'US', MG: 'MG', NM: 'NM', PT: 'PT', XA: 'XA' };
function hoNormMod(m) {
  const s = String(m || '').toUpperCase().trim();
  if (HO_MOD_MAP[s]) return HO_MOD_MAP[s];
  if (/\bXR\b|X-?RAY|RADIOGRAPH|\bDX\b|\bCR\b|\bDR\b/.test(s)) return 'XR';
  if (/ULTRA\s?SOUND|SONOGRAM|\bUS\b/.test(s)) return 'US';
  if (/\bCT\b|COMPUTED\s+TOMOG/.test(s)) return 'CT';
  if (/\bMRI?\b|MAGNETIC\s+RES/.test(s)) return 'MR';
  if (/MAMMOG|\bMG\b/.test(s)) return 'MG';
  return s;
}
// Does an arrived DePACS study match the modality of the order being handed off?
// Unknown/blank on either side → treat as a match (don't block on missing data);
// only a CONFIRMED mismatch (both known and different) blocks the silent auto-write.
function hoModalityMatches(study, order) {
  const a = hoNormMod(study && study.modality);
  const b = hoNormMod(order && order.modality);
  if (!a || !b) return true;
  return a === b;
}
// Body-part tokens (light client mirror of the connector's bodyTokens): drop the
// modality/view/laterality filler and keep the anatomy words, so we can tell a
// CHEST study apart from a KNEE study when both are the same modality (XR).
const HO_STOP = new Set(['XR', 'CT', 'MR', 'MRI', 'US', 'THE', 'AND', 'VIEW', 'VIEWS', 'AP',
  'PA', 'LAT', 'LATERAL', 'OBLIQUE', 'OBLIQUES', 'LT', 'RT', 'LEFT', 'RIGHT', 'BILATERAL',
  'BILAT', 'BOTH', 'WITH', 'WITHOUT', 'CONTRAST', 'SERIES', 'STUDY', 'SCAN', 'PLAIN',
  'ROUTINE', 'PORTABLE', 'STANDING', 'ERECT', 'SUPINE', 'ONE', 'TWO', 'THREE']);
function hoBodyTokens(s) {
  let t = ' ' + String(s || '').toUpperCase().replace(/[^A-Z]/g, ' ').replace(/\s+/g, ' ') + ' ';
  t = t.replace(/\bLUMBO\s?SACRAL\b/g, ' LUMBAR SPINE ').replace(/\bABDO?\b/g, ' ABDOMEN ').replace(/\bCXR\b/g, ' CHEST ');
  return [...new Set(t.split(/\s+/).filter((w) => w.length > 2 && !HO_STOP.has(w)))];
}
function hoBodyOverlap(study, order) {
  const a = hoBodyTokens((study && (study.study_desc || study.desc)) || '');
  const b = hoBodyTokens((order && order.service) || '');
  if (!a.length || !b.length) return false;   // no anatomy to compare → can't confirm
  return a.some((t) => b.includes(t));
}
// Is an arrived study safe to bind to THIS order? Modality must match; and when the
// patient has more than one exam on file (the wrong-study-write risk), the body part
// must also line up. A single-exam file has no sibling to confuse it, so modality
// alone suffices (keeps auto-write working even when DePACS leaves study_desc blank).
function hoStudyMatchesOrder(study, order) {
  if (!hoModalityMatches(study, order)) return false;
  if (handoffOrders().length <= 1) return true;
  return hoBodyOverlap(study, order);
}

function renderHandoffPage() {
  setTopbar('Radiology handoff', 'One patient, step by step');
  handoffStopPolling();
  const c = document.getElementById('content');
  c.innerHTML = `<div class="cc">
    ${pageHero('Handoff', 'Radiology handoff', 'Look up the order, send to DePACS, write the indication, message the group')}
    <div id="ho-reports-link"></div>
    <div id="ho-steps" class="ho-steps"></div>
    <div id="ho-body"></div>
  </div>`;
  renderHandoffSteps();
  renderHandoffStep();
  handoffRenderReportsLink();
  // Deep-link from the RIS worklist: pre-fill the file and look it up immediately.
  if (window._handoffPreload) {
    const file = String(window._handoffPreload); window._handoffPreload = null;
    const inp = document.getElementById('ho-file');
    if (inp) { inp.value = file; handoffLookup(); }
  }
}

// Shareable, login-free link for doctors to look up a patient's finished report
// by file number (temporary, until result write-back is automated).
async function handoffRenderReportsLink() {
  const box = document.getElementById('ho-reports-link');
  if (!box) return;
  let d;
  try { d = await API.get('/reports/public-link'); } catch (e) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card" style="margin-bottom:14px">
    <div class="ho-msg-head"><div class="ho-lbl" style="margin:0">🔗 Doctors' report link (no login)</div></div>
    <div style="font-size:12px;color:var(--muted);margin:2px 0 10px">Share privately with doctors. They open it, type a file number, and read the finished radiology report — no account needed. Anyone with the link can read reports, so keep it private and regenerate if it leaks.</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input id="ho-rlink" class="input" readonly value="${escapeHtml(d.url || '')}" style="flex:1;min-width:200px;font-size:12px">
      <button class="open pri" style="width:auto" onclick="handoffCopyReportsLink()">Copy</button>
      <button class="ghost" onclick="handoffRegenReportsLink()">Regenerate</button>
    </div></div>`;
}
async function handoffCopyReportsLink() {
  const inp = document.getElementById('ho-rlink'); if (!inp) return;
  try { await navigator.clipboard.writeText(inp.value); toast && toast('Link copied'); }
  catch (e) { inp.select(); try { document.execCommand('copy'); toast && toast('Link copied'); } catch (_) {} }
}
async function handoffRegenReportsLink() {
  if (!confirm('Regenerate the doctors\' link? The old link stops working immediately.')) return;
  try { await API.post('/reports/public-link/regenerate'); toast && toast('New link generated'); handoffRenderReportsLink(); }
  catch (e) { toast && toast(e.message || 'Failed', 'err'); }
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
    ${handoff.step > 1 ? `<button class="ghost" onclick="handoffBack()">← ${escapeHtml(backLabel || 'Back')}</button>` : '<span></span>'}
    ${nextLabel ? `<button class="open pri" style="width:auto" ${nextEnabled ? '' : 'disabled'} onclick="${nextFn || 'handoffNext()'}">${escapeHtml(nextLabel)} →</button>` : '<span></span>'}
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
        <button class="open pri" style="width:auto" onclick="handoffLookup()">Look up</button>
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
              studyId: '', candidates: null, baseline: null, baselineFailed: false, msg: '', msgEdited: false,
              // Reset per-patient write/file state too — a spread kept the PREVIOUS patient's
              // written/filed/writing sets, which could block patient B's first write.
              written: new Set(), filed: {}, writing: false, pollGen: (handoff.pollGen || 0) + 1 };
  const pane = document.getElementById('ho-patient');
  pane.innerHTML = LOADING_HTML;
  try {
    handoff.lookup = await API.get(`/radiology/lookup/${encodeURIComponent(file)}`);
    handoffApplyOrder(handoffOrders()[0]);
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
        // "Imaged" = present in PACS / has a report / carries an accession. Keying it
        // off the accession alone showed "waiting" for already-imaged orders (accession
        // is usually null on this HIS), so accept pacsId/hasReport too.
        const imaged = o.imaged || !!o.pacsId || !!o.hasReport || (o.accessionNumber != null && String(o.accessionNumber).trim() !== '');
        // Payment status — the key signal for "the patient HAS an order but it isn't paid
        // yet" (why it never reached the worklist). Show the HIS billing text as-is,
        // coloured green when it reads as paid/billed and red otherwise; muted when HIS
        // returned no billing for the order (unknown, not asserted as unpaid).
        const bs = String(o.billingStatus || '').trim();
        const paidLike = /\b(billed|paid|posted)\b/i.test(bs) && !/\b(not|un|no|pending|hold|partial)\b/i.test(bs);
        const payChip = bs
          ? `<span class="sc ${paidLike ? 'ok' : 'no'}" title="حالة الفوترة من HIS">${escapeHtml(bs)}</span>`
          : `<span class="sc warn" title="ما رجعت حالة فوترة لهذا الطلب من HIS">الفوترة غير معروفة</span>`;
        const chips = [
          o.isER ? `<span class="sc no" title="Emergency encounter">🚨 ER</span>` : '',
          payChip,
          imaged ? `<span class="ris completed"><span class="rd"></span>تم التصوير</span>` : `<span class="ris scheduled"><span class="rd"></span>بانتظار التصوير</span>`,
        ].filter(Boolean).join('');
        const ci = [o.clinicalIndication, o.reasonForOrder].filter(Boolean).join(' · ');
        // Ordering doctor + live HIS order (CPOE) status — so a patient who isn't on the
        // worklist can still be traced: who ordered it, at which branch, and its CPOE state.
        const meta2 = [
          o.provider ? '👨‍⚕️ ' + escapeHtml(o.provider) : '',
          o.status ? 'CPOE: ' + escapeHtml(o.status) : '',
        ].filter(Boolean).join(' · ');
        return `<label class="ho-row ${i === handoff.order ? 'sel' : ''}">
          <input type="radio" name="ho-order" ${i === handoff.order ? 'checked' : ''} onchange="handoffPickOrder(${i})">
          <div class="ho-row-main">
            <div class="ho-row-title">${escapeHtml(o.service || '—')} <span style="color:var(--muted);font-weight:500">(${escapeHtml(o.modality || '')})</span></div>
            <div class="ho-row-sub">🏥 ${escapeHtml(o.branch || '—')}${o.orderedDate ? ' · ' + escapeHtml(o.orderedDate) : ''}</div>
            ${meta2 ? `<div class="ho-row-sub">${meta2}</div>` : ''}
            ${ci ? `<div class="ho-row-sub" style="color:var(--accent)">📋 ${escapeHtml(ci.slice(0, 90))}${ci.length > 90 ? '…' : ''}</div>` : ''}
          </div>
          <div class="ho-badges">${chips}</div>
        </label>`;
      }).join('');
  }
  pane.innerHTML = head + block;
}

function handoffPickOrder(i) {
  handoffStopPolling();
  handoff.order = i; handoff.matched = null; handoff.studyId = ''; handoff.candidates = null; handoff.baseline = null;
  handoffApplyOrder(handoffOrder());
  if (!handoff.msgEdited) handoff.msg = '';
  renderHandoffPatient();
}

// Auto-fill from the order: clinical indication (+ reason) into the textarea, and
// priority from the ER encounter. Overwrites on order switch (deliberate action).
function handoffApplyOrder(o) {
  if (!o) return;
  handoff.priority = o.isER ? 'emergency' : (o.priority ? 'emergency' : 'routine');
  const ci = [o.clinicalIndication, o.reasonForOrder].filter(Boolean).join('\n').trim();
  handoff.history = ci;
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
        <div style="margin-top:13px"><label class="ho-lbl">Clinical indication <span style="font-weight:500">— auto-filled from HIS, edit if needed (written into DePACS)</span></label>
          <textarea id="ho-history" class="input" rows="4" placeholder="Auto-filled from the order; paste here if empty…" oninput="handoff.history=this.value;handoffSyncMsg()">${escapeHtml(handoff.history || '')}</textarea></div>
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
    const modMismatch = !hoModalityMatches(s, o);
    const bodyDoubt = !modMismatch && !hoStudyMatchesOrder(s, o);   // same modality, but body-part didn't confirm (multi-exam file)
    const suspect = modMismatch || bodyDoubt;
    box.innerHTML = `
      <div class="ho-de-box ${suspect ? '' : 'ok'}"${suspect ? ' style="border-color:var(--warn,#b7791f)"' : ''}>
        <div style="font-weight:700;color:var(--text)">🖼️ ${escapeHtml(s.modality || '')}${s.study_date ? ' · ' + escapeHtml(String(s.study_date).slice(0,16).replace('T',' ')) : ''}${s.study_desc ? ' · ' + escapeHtml(s.study_desc) : ''}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">study #${escapeHtml(String(s.study_id))}${s.status ? ' · ' + escapeHtml(s.status) : ''} · order: <b>${escapeHtml(o.service || '')}</b> (${escapeHtml(o.modality || '')})</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">Current history: ${escapeHtml(s.history || '—')}</div>
        ${modMismatch
          ? `<div class="ho-note" style="color:var(--warn,#b7791f)">⚠️ This study is <b>${escapeHtml(hoNormMod(s.modality))}</b> but the order is <b>${escapeHtml(hoNormMod(o.modality))}</b> — likely a different exam. Did not auto-write. Confirm it's the right study before writing.</div>`
          : bodyDoubt
          ? `<div class="ho-note" style="color:var(--warn,#b7791f)">⚠️ This file has more than one exam and we couldn't confirm this study is the <b>${escapeHtml(o.service || 'ordered')}</b> exam. Did not auto-write. Verify the study matches the order before writing.</div>`
          : `<div class="ho-note">⚠️ Make sure this is the exam you just sent before writing.</div>`}
      </div>
      <div class="ho-actions">
        <button class="open pri" style="width:auto" onclick="handoffWrite(this)">Write indication to DePACS</button>
        <button class="ghost" onclick="handoffRepoll()">Re-check / change study</button>
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
         <button class="ghost" onclick="handoffStopPolling(true)">Stop</button></div>`
    : `<div class="ho-actions" style="margin-top:0">
         <button class="open pri" style="width:auto" onclick="handoffStartPolling()">✅ Images sent — find the study</button>
         <button class="ghost" onclick="handoffFindExisting()">It's already there</button>
       </div>`;
}

// "It's already there": the exam was imaged earlier (even a previous day), so a
// baseline-diff poll would never surface it (it's in the baseline, and _isToday
// only rescues same-day studies). Fetch the studies and let the user pick from
// what's actually on the file, instead of dead-ending in the 3-minute timeout.
async function handoffFindExisting() {
  handoffStopPolling();
  handoff.matched = null; handoff.studyId = ''; handoff.candidates = null;
  const box = document.getElementById('ho-de');
  if (box) box.innerHTML = LOADING_HTML;
  try {
    const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
    handoff.studies = r.studies || [];
  } catch (e) {
    if (box) box.innerHTML = `<div class="empty" style="padding:18px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Could not load studies')}</p>
      <div class="ho-actions" style="margin-top:8px"><button class="open pri" style="width:auto" onclick="handoffFindExisting()">Try again</button></div></div>`;
    return;
  }
  if (!(handoff.studies || []).length) {
    if (box) box.innerHTML = `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">No studies on this file in DePACS yet.</div>
      <div class="ho-actions" style="margin-top:0"><button class="open pri" style="width:auto" onclick="handoffStartPolling()">Wait for images</button></div>`;
    return;
  }
  handoffPickAny();   // one study → auto-select; several → list them to choose
}

async function handoffStartPolling() {
  // Re-entrant guard: kill any live loop and bump the generation so an older loop's
  // in-flight tick (and its auto-write) can't fire alongside this one.
  handoffStopPolling();
  handoff.polling = true; handoff.pollN = 0; handoff.candidates = null; handoff.matched = null;
  const gen = (handoff.pollGen = (handoff.pollGen || 0) + 1);
  renderHandoffDE();
  if (!(handoff.baseline instanceof Set)) {
    try {
      const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
      handoff.baseline = new Set((r.studies || []).map(s => String(s.study_id)));
      handoff.baselineFailed = false;
    } catch (e) {
      // Baseline UNKNOWN (not empty). An empty Set would make every pre-existing study
      // look newly-arrived, so a stale prior study could auto-write. Mark the failure so
      // the tick still lets the user pick/confirm, but never AUTO-writes (fail closed).
      handoff.baseline = new Set();
      handoff.baselineFailed = true;
    }
  }
  if (gen === handoff.pollGen && handoff.polling) handoffPollTick(gen);
}
function handoffStopPolling(rerender) {
  handoff.polling = false;
  if (handoff.pollTimer) { clearTimeout(handoff.pollTimer); handoff.pollTimer = null; }
  if (rerender) renderHandoffDE();
}
function _isToday(d) {
  if (!d) return false;
  // DePACS timestamps studies in KSA (UTC+3), so "today" must be the KSA calendar
  // day — comparing against the browser's local/UTC day mis-judged studies near
  // midnight KSA.
  let today;
  try {
    today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) {
    const t = new Date();
    today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  }
  return String(d).slice(0, 10) === today;
}
async function handoffPollTick(gen) {
  if (!handoff.polling || gen !== handoff.pollGen) return;   // superseded loop → exit
  // Stop if the user navigated away from the handoff page — otherwise polling (and
  // a background auto-write to DePACS) would keep running unsupervised on a page
  // the user has left.
  if (typeof currentPage !== 'undefined' && currentPage !== 'handoff') { handoffStopPolling(); return; }
  handoff.pollN += 1;
  try {
    const r = await API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`);
    if (!handoff.polling || gen !== handoff.pollGen) return;   // stopped/superseded mid-flight
    handoff.studies = r.studies || [];
    const base = handoff.baseline instanceof Set ? handoff.baseline : new Set();
    // Studies already written to in THIS handoff must never resurface in the
    // worklist — otherwise the one you just filed pops back in on the next tick
    // (and the today-fallback below would re-list it for another write).
    const done = handoff.written instanceof Set ? handoff.written : new Set();
    let pool = handoff.studies.filter(s => !base.has(String(s.study_id)) && !done.has(String(s.study_id)));
    if (!pool.length) pool = handoff.studies.filter(s => _isToday(s.study_date) && !done.has(String(s.study_id)));
    if (pool.length === 1) { handoff.matched = pool[0]; handoff.studyId = String(pool[0].study_id); handoffStopPolling(); renderHandoffDE();
      // Auto-write ONLY when the arrived study safely matches the picked order
      // (modality + — when the patient has other exams — body part). On a multi-exam
      // sitting a same-modality wrong-body study (XR chest vs XR knee) can land first;
      // auto-writing it would bind this order's indication + Emergency flag to the
      // wrong exam. On any doubt we leave it selected (with a warning) for manual write.
      if ((handoff.history || '').trim() && !handoff.baselineFailed && hoStudyMatchesOrder(pool[0], handoffOrder())) handoffAutoWrite();
      return; }
    if (pool.length > 1) { handoff.candidates = pool; handoffStopPolling(); renderHandoffDE(); return; }
  } catch (e) { /* keep polling through transient errors */ }
  if (!handoff.polling || gen !== handoff.pollGen) return;   // stopped/superseded — don't re-arm
  if (handoff.pollN >= HO_POLL_MAX) {
    handoff.polling = false;
    const box = document.getElementById('ho-de');
    if (box) box.innerHTML = `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">No new study in DePACS yet — the images may still be on the way.</div>
      <div class="ho-actions" style="margin-top:0">
        <button class="open pri" style="width:auto" onclick="handoffStartPolling()">Check again</button>
        <button class="ghost" onclick="handoffPickAny()">Pick from all studies</button></div>`;
    return;
  }
  handoff.pollTimer = setTimeout(() => handoffPollTick(gen), HO_POLL_EVERY_MS);
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
async function handoffWriteCore() {
  // Re-entrancy guard: auto-write (poll match) and a manual Write click can both
  // fire for the same study — the second one would write twice and leave the UI
  // stuck on "Writing…". One write at a time.
  if (handoff.writing) return;
  handoff.writing = true;
  try {
  const history = (handoff.history || '').trim();
  const body = handoff.priority === 'emergency' ? `🚨 ER — ${history}` : history;
  // Pass the selected order's accession so the server stamps it onto the DePACS study.
  // That turns the later result-filing match from a fuzzy body-part guess into a
  // deterministic accession key (blank is fine — the server just skips the stamp).
  const accession = (handoffOrder().accessionNumber != null ? String(handoffOrder().accessionNumber).trim() : '');
  const w = await API.post('/handoff/write-history', { study_id: handoff.studyId, history: body, file_no: handoff.file, priority: handoff.priority, accession });
  // Remember we've handled this study so polling won't resurface it.
  (handoff.written || (handoff.written = new Set())).add(String(handoff.studyId));
  const res = document.getElementById('ho-result');
  let flag = '';
  // Surface a stamped accession so staff know the return-match is now deterministic.
  if (w && w.accession_stamped && w.accession_stamped.stamped && w.accession_stamped.accession) {
    flag += ` · <b>Accession ${escapeHtml(String(w.accession_stamped.accession))} linked</b>`;
  }
  if (w && w.emergency) {
    // emergency_confirmed is the read-back result: true = the PACS actually shows
    // Emergency now; false = the write was ACKed but the flag didn't stick (warn so
    // staff can set it by hand); null/undefined = couldn't re-read (assume ok).
    if (w.emergency_confirmed === false) {
      flag += ` · <b style="color:#c0392b">⚠ Emergency did NOT stick</b> — set it manually in DePACS`;
    } else {
      flag += ` · <b>Emergency ✓</b>${w.category ? ' · Category ' + escapeHtml(w.category) : ''}`;
    }
  } else if (w && w.category) {
    // Routine study — still filed under its category (Others), no Emergency flag.
    flag += ` · Routine · Category ${escapeHtml(w.category)}`;
  }
  if (res) res.innerHTML = `<div class="ho-de-box ok">✅ <b>Indication written into DePACS</b> study #${escapeHtml(String(handoff.studyId))}${flag}. Continue to the message →</div>`;
  // Refresh the matched study's status in the BACKGROUND — don't hold the write
  // (and the disabled button) on a second full HIS lookup, which made it hang.
  const sid = String(handoff.studyId);
  API.get(`/reports/search?file_no=${encodeURIComponent(handoff.file)}`).then((r) => {
    const st = (r.studies || []).find(x => String(x.study_id) === sid);
    if (st && String(handoff.studyId) === sid) { handoff.matched = st; renderHandoffDE(); }
  }).catch(() => {});
  } finally {
    handoff.writing = false;
  }
}

// Manual write (from the button) — asks to confirm the study first.
async function handoffWrite(btn) {
  const o = handoffOrder();
  const history = (handoff.history || '').trim();
  const res = document.getElementById('ho-result');
  if (!handoff.studyId) { res.innerHTML = `<div class="ho-note">Find/select the DePACS study first.</div>`; return; }
  if (!history) { res.innerHTML = `<div class="ho-note">Go back to step 2 and add the clinical indication first.</div>`; return; }
  const s = handoff.matched || {};
  if (!confirm(`Write the indication into this DePACS study?\n\n${s.modality || ''} · ${String(s.study_date || '').slice(0,16).replace('T',' ')}${s.study_desc ? ' · ' + s.study_desc : ''}\nstudy #${handoff.studyId}\n\nOrder: ${o.service || ''} (${o.modality || ''})`)) return;
  btn.disabled = true; btn.textContent = 'Writing…';
  try { await handoffWriteCore(); }
  catch (e) { res.innerHTML = `<div class="empty" style="padding:18px"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message || 'Write failed')}</p></div>`; }
  finally { btn.disabled = false; btn.textContent = 'Write indication to DePACS'; }
}

// Auto write (full DE linkage) — fires when polling matches exactly one new study.
async function handoffAutoWrite() {
  const res = document.getElementById('ho-result');
  if (res) res.innerHTML = `<div class="ho-de-box">✍️ Study arrived — writing the indication into DePACS…</div>`;
  try { await handoffWriteCore(); }
  catch (e) {
    if (res) res.innerHTML = `<div class="empty" style="padding:18px"><div class="empty-icon">⚠️</div><p>Auto-write failed: ${escapeHtml(e.message || '')}. Use the Write button.</p></div>`;
  }
}

// ── Step 4 · Message ──────────────────────────────────────────────────────────
function hoStep4(b) {
  b.innerHTML = `
    <div class="card">
      <div class="ho-msg-head">
        <div class="ho-step-title"><span class="ho-step-num">4</span> WhatsApp message</div>
        <div style="display:flex;gap:8px">
          <button class="ghost" onclick="handoffCopy(this)">Copy</button>
          <button class="open pri" style="width:auto" onclick="handoffSendWhatsApp()">Send on WhatsApp</button>
        </div>
      </div>
      <textarea id="ho-message" class="input" rows="6" oninput="handoffMsgInput(this)"></textarea>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">Tap <b>Send on WhatsApp</b> — WhatsApp opens with this message ready; pick the radiology group and hit send.</div>
      <div class="ho-results-sec">
        <div class="ho-msg-head" style="margin-top:4px">
          <div class="ho-lbl" style="margin:0">🔬 Radiology report — is it back yet?</div>
          <button class="ghost" onclick="handoffCheckResults(this)">Check report</button>
        </div>
        <div style="font-size:12px;color:var(--muted);margin:2px 0 8px">
          Matches the finished DePACS report to the correct order/exam — never guesses. Ready ones can be filed in Siratech.</div>
        <div id="ho-results"></div>
      </div>
      <div class="ho-nav">
        <button class="ghost" onclick="handoffBack()">← Back</button>
        <button class="open pri" style="width:auto" onclick="handoffReset()">Done · new patient</button>
      </div>
    </div>`;
  // Build the message once from the details; do NOT force-rebuild on re-entry.
  // Step-2 inputs are gone by now, so rebuilding would fall back to order values
  // and silently discard both manual edits and any step-2 exam/branch tweaks made
  // while leaving and returning to this step.
  if (!handoff.msgEdited && !(handoff.msg || '').trim()) handoff.msg = handoffBuildMsg();
  const m = document.getElementById('ho-message');
  if (m) m.value = handoff.msg;
}

// ── Reverse flow · match the finished report to the right order/exam ──────────
async function handoffCheckResults(btn) {
  const box = document.getElementById('ho-results');
  if (!handoff.file) { box.innerHTML = `<div class="ho-note">Look up a patient first.</div>`; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  box.innerHTML = LOADING_HTML;
  try {
    const o = handoffOrder();
    const siteQ = (o && o.siteId != null) ? `?site=${encodeURIComponent(o.siteId)}` : '';   // scope to the patient's branch
    const d = await API.get(`/radiology/results/match/${encodeURIComponent(handoff.file)}${siteQ}`);
    renderHandoffResults(d);
  } catch (e) {
    box.innerHTML = `<div class="empty" style="padding:18px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Result match failed')}</p></div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check report'; }
  }
}

function renderHandoffResults(d) {
  const box = document.getElementById('ho-results');
  const orders = (d && d.orders) || [];
  if (!orders.length) {
    box.innerHTML = `<div class="ho-note">No radiology order awaiting a result for this file.</div>`;
    return;
  }
  const site = (d && d.site) || 0;
  const filed = handoff.filed || (handoff.filed = {});   // session-level: billNo|serviceId → true
  const testCard = (t, billNo) => {
    const s = t.study || {};
    const rep = t.report || {};
    if (t.decision === 'unique') {
      const sid = (t.test && t.test.invMastServiceId) || '';
      const isFiled = !!filed[`${billNo}|${sid}`];   // already filed this session → no re-file
      return `<div class="ho-de-box ok" style="display:block">
        <div><b>✅ ${escapeHtml(t.test.serviceName || '')}</b> — report ready</div>
        <div style="font-size:12px;color:var(--muted);margin:3px 0">
          matched: ${escapeHtml(s.modality || '')} · ${escapeHtml(s.desc || '')} ·
          ${escapeHtml(String(s.studyDate || '').slice(0,16).replace('T',' '))} · study #${escapeHtml(String(s.studyId))}
          ${rep.pdfOk ? ' · 📄 PDF' : ''}</div>
        ${rep.preview ? `<textarea class="input" rows="4" readonly style="font-size:12px">${escapeHtml(rep.preview)}${rep.preview.length >= 590 ? '…' : ''}</textarea>
        <button class="ghost" style="margin-top:6px" onclick="handoffCopyText(this)">📋 Copy report</button>` : ''}
        <div class="ho-actions" style="margin-top:8px">
          ${isFiled
            ? `<button class="ghost" disabled>✅ Filed</button>`
            : canFileRadiology()
              ? `<button class="open pri" style="width:auto" onclick='handoffFileResult(${JSON.stringify(String(billNo || ''))}, ${JSON.stringify(String(sid))}, ${Number(site) || 0}, this)'>📤 File to Siratech + Authorize</button>`
              : `<span style="font-size:12px;color:var(--muted)">View only — ask an admin to enable radiology filing for your account.</span>`}
        </div>
        <div class="ho-file-out" style="margin-top:8px"></div>
      </div>`;
    }
    const cands = (t.candidates || []).filter(c => c.bodyMatch && c.bodyMatch.length);
    return `<div class="ho-de-box" style="display:block;border-color:var(--warn,#b7791f)">
      <div><b>⚠️ ${escapeHtml(t.test.serviceName || '')}</b> — needs manual review</div>
      <div style="font-size:12px;color:var(--muted);margin-top:3px">${escapeHtml(t.reason || t.decision)}.
      ${cands.length ? 'Possible: ' + escapeHtml(cands.map(c => `${c.desc} (#${c.studyId})`).join(', ')) : 'No confident match — do not file automatically.'}</div>
    </div>`;
  };
  box.innerHTML = orders.map(o => {
    const tests = (o.tests || []).map(t => testCard(t, o.order.billNo)).join('');
    return `<div style="margin-bottom:10px">
      <div class="ho-lbl" style="margin:6px 0 4px">Order ${escapeHtml(o.order.billNo || '')}
        ${o.allUnique ? '<span class="ris completed"><span class="rd"></span>all matched</span>' : '<span class="sc no">⚠ review needed</span>'}</div>
      ${tests}</div>`;
  }).join('');
}

// Reverse flow · file the matched report PDF back into Siratech + authorize it.
// Two steps for safety on a live medical record: (1) DRY-RUN shows exactly what
// will be written; (2) the user confirms → real save + 1st-level authorization.
async function handoffFileResult(billNo, serviceId, site, btn) {
  const card = btn.closest('.ho-de-box');
  const out = card ? card.querySelector('.ho-file-out') : null;
  if (!out) return;
  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Checking…';
  out.innerHTML = LOADING_HTML;
  try {
    const p = await API.post('/radiology/results/file', { file: handoff.file, billNo, serviceId, site, confirm: false });
    if (p && (p.needsPick || p.writable === false)) {
      out.innerHTML = `<div class="ho-note">Can't file automatically — ${escapeHtml(p.reason || p.decision || 'not a unique match')}. File it manually in Siratech.</div>`;
      return;
    }
    if (p && p.wrote === false && p.step === 'report') {
      out.innerHTML = `<div class="ho-note">${escapeHtml(p.note || 'No valid report PDF to file yet.')}</div>`;
      return;
    }
    const plan = (p && p.plan) || {};
    const tgt = plan.target || {}, st = plan.study || {}, rep = plan.report || {};
    const rng = plan.range ? `${plan.range.classified || '—'} (${plan.range.source || ''})` : '';
    out.innerHTML = `<div class="ho-de-box" style="display:block;border-color:var(--accent)">
      <div style="font-size:12.5px"><b>Ready to file into Siratech + authorize:</b></div>
      <div style="font-size:12px;color:var(--muted);margin:4px 0">
        ${escapeHtml(tgt.serviceName || '')} · study #${escapeHtml(String(st.studyId || ''))} ·
        ${rep.pdfOk ? '📄 PDF ' + Math.round((rep.pdfBytes || 0) / 1024) + 'KB' : '⚠️ no PDF'} ·
        range: ${escapeHtml(rng)}</div>
      <div class="ho-actions" style="margin-top:6px">
        <button class="open pri" style="width:auto" onclick='handoffFileConfirm(${JSON.stringify(String(billNo || ''))}, ${JSON.stringify(String(serviceId || ''))}, ${Number(site) || 0}, this, ${JSON.stringify(String(st.studyId || ''))})'>✅ Confirm — file + authorize</button>
        <button class="ghost" onclick="this.closest('.ho-file-out').innerHTML=''">Cancel</button>
      </div></div>`;
  } catch (e) {
    out.innerHTML = `<div class="empty" style="padding:14px"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message || 'Check failed')}</p></div>`;
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}
async function handoffFileConfirm(billNo, serviceId, site, btn, expectStudyId) {
  const out = btn.closest('.ho-file-out');
  if (!out) return;
  btn.disabled = true; btn.textContent = 'Filing…';
  try {
    const r = await API.post('/radiology/results/file', { file: handoff.file, billNo, serviceId, site, confirm: true, authorize: true, expectStudyId: expectStudyId || undefined });
    if (r && r.wrote === false && r.step === 'changed') {
      out.innerHTML = `<div class="ho-note">${escapeHtml(r.note || 'The matched study changed — re-check the report.')}</div>`;
      return;
    }
    if (r && r.wrote) {
      // When HIS did NOT confirm the authorization, surface its actual response
      // (status + message + raw) so the reason is visible instead of a blind
      // "pending" — this is what tells us how to fix the authorize payload.
      let authDbg = '';
      if (!r.authorized && r.authorize) {
        const a = r.authorize;
        const raw = a.raw != null ? (typeof a.raw === 'string' ? a.raw : JSON.stringify(a.raw)) : '';
        authDbg = `<div style="font-size:11px;color:var(--warn,#b7791f);margin-top:5px;border-top:1px dashed var(--border);padding-top:4px;word-break:break-all;line-height:1.7">
          🔎 authorize → HTTP ${escapeHtml(String(a.status != null ? a.status : '—'))}${a.isSuccess != null ? ' · isSuccess:' + escapeHtml(String(a.isSuccess)) : ''}${a.message ? ' · msg: ' + escapeHtml(String(a.message)) : ''}${raw ? '<br>raw: ' + escapeHtml(raw.slice(0, 400)) : ''}</div>`;
      }
      out.innerHTML = `<div class="ho-de-box ok" style="display:block">✅ <b>Filed into Siratech</b>${r.authorized ? ' and <b>authorized</b>' : ' — <b>pending authorization</b> (verify in Siratech)'}.${r.note ? `<div style="font-size:11px;color:var(--muted);margin-top:3px">${escapeHtml(r.note)}</div>` : ''}${authDbg}</div>`;
      // Filed successfully — record it at SESSION level (keyed by bill+service) so a
      // later "Check report" that re-renders fresh buttons can't re-file it, and
      // neutralise the current button immediately.
      (handoff.filed || (handoff.filed = {}))[`${billNo}|${serviceId}`] = true;
      const card = out.closest('.ho-de-box');
      const fileBtn = card && card.querySelector('.ho-actions .open.pri');
      if (fileBtn) { fileBtn.disabled = true; fileBtn.textContent = '✅ Filed'; fileBtn.onclick = null; }
    } else {
      out.innerHTML = `<div class="ho-note">Not filed — ${escapeHtml((r && (r.note || r.reason || r.step)) || 'unknown reason')}.</div>`;
    }
  } catch (e) {
    out.innerHTML = `<div class="empty" style="padding:14px"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message || 'Filing failed')}</p></div>`;
  }
}

function handoffCopyText(btn) {
  const ta = btn.previousElementSibling;
  if (!ta) return;
  const done = () => { const t = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = t; }, 1400); };
  try { navigator.clipboard.writeText(ta.value).then(done, () => { ta.select(); document.execCommand('copy'); done(); }); }
  catch (e) { ta.select(); try { document.execCommand('copy'); done(); } catch (_e) {} }
}
function handoffReset() {
  handoffStopPolling();
  handoff = { step: 1, file: '', lookup: null, order: 0, priority: 'routine', history: '',
              studies: null, matched: null, studyId: '', candidates: null,
              baseline: null, polling: false, pollN: 0, pollTimer: null,
              written: null, writing: false, msg: '', msgEdited: false };
  renderHandoffSteps(); renderHandoffStep();
}

// Strip emoji / pictographs (and their variation selectors / ZWJ) from a string —
// used to keep the clinical indication clean text in the WhatsApp message.
function hoStripEmoji(s) {
  try { return String(s || '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim(); }
  catch (_e) { return String(s || '').replace(/\s+/g, ' ').trim(); }   // older engines: no \p{…}
}
function handoffBuildMsg() {
  // Plain English, no emoji. WhatsApp bold (*..*) on the labels so the group can
  // scan File / Exam / Priority / Indication at a glance. Branch is intentionally
  // omitted, and the indication is emoji-stripped so it stays clean clinical text.
  const exam = (document.getElementById('ho-exam')?.value || handoffOrder().service || '').trim();
  const indication = hoStripEmoji(handoff.history || '');
  const prio = handoff.priority === 'emergency' ? 'Emergency' : 'Routine';
  return [
    `*File:* ${handoff.file}`,
    exam ? `*Exam:* ${exam}` : '',
    `*Priority:* ${prio}`,
    `*Indication:* ${indication || '-'}`,
  ].filter(Boolean).join('\n');
}
function handoffSyncMsg(force) {
  const m = document.getElementById('ho-message');
  if (force || !handoff.msgEdited) handoff.msg = handoffBuildMsg();
  if (m) m.value = handoff.msg;
}
function handoffMsgInput(el) { handoff.msgEdited = true; handoff.msg = el.value; }
// Open WhatsApp with the (current, possibly-edited) message pre-filled. WhatsApp
// has no public link that targets a specific GROUP with pre-filled text, so this
// opens the app/Web with the text ready — the user picks the radiology group and
// hits send (usually the top/most-recent chat). Works on mobile and desktop.
function handoffSendWhatsApp() {
  const m = document.getElementById('ho-message');
  const text = ((m && m.value) || handoff.msg || '').trim();
  if (!text) { toast && toast('Nothing to send'); return; }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
}
async function handoffCopy(btn) {
  const m = document.getElementById('ho-message');
  if (!m) return;
  const done = () => { if (btn) { const t = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = t; }, 1400); } };
  try { await navigator.clipboard.writeText(m.value); done(); }
  catch (e) { m.select(); try { document.execCommand('copy'); done(); } catch (_e) {} }
}
