// ── Radiology consent · Declaration of Non-Pregnancy ──────────────────────────
// A patient-facing, full-screen consent the specialist hands to the patient on the
// same device: the patient reads the bilingual declaration, fills the reason, signs
// with a finger, and the signed PDF is generated server-side and filed to her file.

let _consent = { prefill: null, onDone: null, drawing: false, hasInk: false };
let _consentPoll = null;

// ── QR flow: the patient scans and signs on HER OWN phone ─────────────────────
// The specialist opens this, the patient scans the QR, reads & signs on her phone,
// and this screen flips to ✅ the moment she submits (polling the consent status).
async function openConsentQR(prefill, onDone) {
  _consent = { prefill: prefill || {}, onDone: onDone || null, drawing: false, hasInk: false };
  let ov = document.getElementById('consent-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'consent-overlay'; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="cn-sheet cnq-plat"><div class="cn-head"><div><div class="cn-title">Non-Pregnancy Consent</div>
    <div class="cn-sub">Radiology · Meena Health</div></div><button class="cn-x" onclick="closeConsent()">✕</button></div>
    <div class="cn-body" style="text-align:center"><div class="mini-spin"></div><p style="margin-top:10px;color:var(--muted)">Preparing link…</p></div></div>`;
  try {
    const r = await API.post('/consent/link', _consent.prefill);
    if (!r || !r.ok) throw new Error('Could not create the consent link');
    renderConsentQR(ov, r);
    consentStartPoll(r.id);
  } catch (e) {
    const body = ov.querySelector('.cn-body');
    if (body) body.innerHTML = `<div class="cn-err">${escapeHtml(e.message || 'Failed to prepare the link')}</div>
      <div style="margin-top:12px"><button class="btn btn-primary" onclick="consentSignHere()">Sign on this device</button></div>`;
  }
}
function renderConsentQR(ov, r) {
  const p = _consent.prefill || {};
  const initial = (p.name_en || p.name || '?').trim().charAt(0).toUpperCase() || '?';
  const isER = (p.patient_type === 'er');
  ov.querySelector('.cn-sheet').innerHTML = `
    <div class="cn-head">
      <div><div class="cn-title">Non-Pregnancy Consent</div><div class="cn-sub">Radiology · Meena Health</div></div>
      <button class="cn-x" onclick="closeConsent()">✕</button>
    </div>
    <div class="cn-body cnq">
      <!-- Who this consent is for — identity check at a glance -->
      <div class="cnq-patient">
        <div class="cnq-ava">${escapeHtml(initial)}</div>
        <div class="cnq-pinfo">
          <b>${escapeHtml(p.name_en || p.name || '—')}</b>
          <span>${escapeHtml([`File ${p.mrno || p.file_no || '—'}`, p.procedure || ''].filter(Boolean).join(' · '))}</span>
        </div>
        <span class="cnq-type ${isER ? 'er' : ''}">${isER ? 'ER' : 'OPD'}</span>
      </div>

      <div class="cnq-steps">
        <div class="s on"><i>1</i><em>Scan</em></div><span class="ln"></span>
        <div class="s"><i>2</i><em>Read &amp; sign</em></div><span class="ln"></span>
        <div class="s"><i>3</i><em>Filed</em></div>
      </div>

      <div class="cnq-qrcard">
        ${r.qr ? `<img class="cnq-qr" src="${escapeHtml(r.qr)}" alt="QR">` : `<div class="cn-err">QR unavailable — use the link below</div>`}
        <div class="cnq-hint">Ask the patient to scan this with her phone camera.<br>She reads and signs on her own phone.</div>
      </div>

      <div id="cn-poll" class="cnq-status"><span class="cnq-dots"><i></i><i></i><i></i></span>Waiting for the patient's signature…</div>

      <div class="cnq-divider"><span>or send her the link</span></div>

      <div class="cnq-row">
        <input id="cn-sms-phone" class="input" inputmode="tel" value="${escapeHtml(p.phone || '')}" placeholder="Patient mobile · 05xxxxxxxx">
        <button class="btn btn-primary cnq-go" onclick="consentSendSms(this,'${jsAttr(r.url || '')}')">Send SMS</button>
      </div>
      <div id="cn-sms-msg" class="cnq-note"></div>
      <div class="cnq-row cnq-linkrow">
        <input class="input" readonly value="${escapeHtml(r.url || '')}" onclick="this.select()">
        <button class="btn cnq-go" onclick="consentCopyLink(this,'${jsAttr(r.url || '')}')">Copy</button>
      </div>

      <div class="cnq-alt"><button onclick="consentSignHere()">Or sign on this device instead</button></div>
    </div>`;
}
function consentCopyLink(btn, url) {
  try { navigator.clipboard.writeText(url).then(() => { const t = btn.textContent; btn.textContent = '✓'; setTimeout(() => btn.textContent = t, 1200); }); } catch (e) {}
}
async function consentSendSms(btn, url) {
  const phone = (document.getElementById('cn-sms-phone')?.value || '').trim();
  const msg = document.getElementById('cn-sms-msg');
  if (!phone) { if (msg) { msg.textContent = 'Enter the patient mobile number first'; msg.style.color = 'var(--danger-ink)'; } return; }
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Sending…';
  try {
    await API.post('/consent/send-sms', { phone, url });
    if (msg) { msg.textContent = '✓ Consent link sent by SMS'; msg.style.color = 'var(--success-ink)'; }
    btn.textContent = '✓ Sent';
  } catch (e) {
    if (msg) { msg.textContent = (e.message || 'SMS failed'); msg.style.color = 'var(--danger-ink)'; }
    btn.disabled = false; btn.textContent = orig;
  }
}
function consentSignHere() {
  const pre = _consent.prefill, done = _consent.onDone;
  consentStopPoll();
  openConsent(pre, done);
}
function consentStartPoll(id) {
  consentStopPoll();
  let handled = false;   // overlapping in-flight polls must fire onDone/close only once
  _consentPoll = setInterval(async () => {
    if (!document.getElementById('consent-overlay')) { consentStopPoll(); return; }
    try {
      const s = await API.get(`/consent/status/${id}`);
      if (s && s.status === 'signed' && !handled) {
        handled = true;
        consentStopPoll();
        // Flip the whole sheet to the success view — the moment the tech is waiting for.
        const body = document.querySelector('#consent-overlay .cn-body');
        const fileq = encodeURIComponent((_consent.prefill && (_consent.prefill.file_no || _consent.prefill.mrno)) || '');
        if (body) body.innerHTML = `
          <div class="cnq-done">
            <div class="cnq-done-ring"><svg viewBox="0 0 52 52"><path d="M14 27l8 8 16-17"/></svg></div>
            <div class="t">Consent signed</div>
            <div class="s">Filed to the patient's record.</div>
            <a class="btn btn-primary" href="/api/consent/${id}/pdf?file=${fileq}" target="_blank" rel="noopener">View PDF</a>
          </div>`;
        const done = _consent.onDone;
        if (typeof done === 'function') done(id);
        setTimeout(closeConsent, 3200);
      }
    } catch (e) {}
  }, 3000);
}
function consentStopPoll() { if (_consentPoll) { clearInterval(_consentPoll); _consentPoll = null; } }

// Open the consent for a patient. prefill: {file_no,name,mrn,dob,procedure,weight,
// height,patient_type,physician}. onDone(consentId) fires after a successful save.
function openConsent(prefill, onDone) {
  _consent = { prefill: prefill || {}, onDone: onDone || null, drawing: false, hasInk: false };
  let ov = document.getElementById('consent-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'consent-overlay'; document.body.appendChild(ov); }
  renderConsent(ov);
}
function closeConsent() {
  consentStopPoll();
  const ov = document.getElementById('consent-overlay');
  if (ov) ov.remove();
}

function renderConsent(ov) {
  const p = _consent.prefill || {};
  const isER = (p.patient_type === 'er');
  ov.innerHTML = `
    <div class="cn-sheet" dir="ltr">
      <div class="cn-head">
        <div>
          <div class="cn-title">Declaration of Non-Pregnancy</div>
          <div class="cn-sub">Radiology consent</div>
        </div>
        <button class="cn-x" onclick="closeConsent()" aria-label="Close">✕</button>
      </div>

      <div class="cn-body">
        <!-- Her data, already registered — read-only summary -->
        <div class="cn-summary">
          <div class="cn-sum-row"><span>Patient</span><b>${escapeHtml(p.name || '—')}</b></div>
          <div class="cn-sum-row"><span>File / MRN</span><b>${escapeHtml(p.mrno || p.file_no || '—')}</b></div>
          ${p.dob ? `<div class="cn-sum-row"><span>Date of birth</span><b>${escapeHtml(p.dob)}</b></div>` : ''}
          <div class="cn-sum-row"><span>Procedure</span><b>${escapeHtml(p.procedure || '—')}</b></div>
          ${p.branch ? `<div class="cn-sum-row"><span>Branch</span><b>${escapeHtml(p.branch)}</b></div>` : ''}
          <div class="cn-sum-row"><span>Type</span><b>${isER ? 'ER' : 'Outpatient'}</b></div>
          ${p.physician ? `<div class="cn-sum-row"><span>Physician</span><b>${escapeHtml(p.physician)}</b></div>` : ''}
        </div>
        <input type="hidden" id="cn-proc" value="${escapeHtml(p.procedure || '')}">

        <!-- Optional clinical values the specialist enters if measured -->
        <div class="cn-vitals">
          <div class="cn-vitals-h">Vitals (optional)</div>
          <div class="cn-vitals-row">
            <label><span>Weight</span><input id="cn-weight" class="input" inputmode="decimal" value="${escapeHtml(p.weight || '')}" placeholder="kg"></label>
            <label><span>Height</span><input id="cn-height" class="input" inputmode="decimal" value="${escapeHtml(p.height || '')}" placeholder="cm"></label>
            <label><span>HCG</span><input id="cn-hcg" class="input" placeholder="—"></label>
          </div>
        </div>

        <!-- What the patient reads and chooses -->
        <div class="cn-declare">
          <div class="cn-declare-h">I declare I am not pregnant during the exam.</div>
          <div class="cn-lbl" style="margin-top:10px">Because:</div>
          <label class="cn-radio"><input type="radio" name="cn-reason" value="not_married" onchange="consentSetReason('not_married')"> Not married</label>
          <label class="cn-radio"><input type="radio" name="cn-reason" value="lmp" checked onchange="consentSetReason('lmp')"> Last menstrual period
            <input id="cn-lmp" type="date" class="input" style="max-width:180px;margin-inline-start:8px"></label>
          <label class="cn-radio"><input type="radio" name="cn-reason" value="iud" onchange="consentSetReason('iud')"> IUD</label>
        </div>

        <div class="cn-risk">⚠️ I understand this procedure uses ionizing radiation which may pose a risk to a fetus, and I consent to it.</div>

        <div class="cn-siglabel">Signature <span style="color:var(--muted);font-weight:500">— sign with your finger</span></div>
        <div class="cn-sigwrap">
          <canvas id="cn-sig" class="cn-sig"></canvas>
          <button type="button" class="cn-sigclear" onclick="consentClearSig()">Clear</button>
        </div>
        <div id="cn-msg" class="cn-msg"></div>
      </div>

      <div class="cn-foot">
        <button class="btn btn-ghost" onclick="closeConsent()">Cancel</button>
        <button class="btn btn-primary" id="cn-save" onclick="consentSave(this)">Save &amp; file</button>
      </div>
    </div>`;
  consentInitPad();
}

function consentSetReason(r) {
  const lmp = document.getElementById('cn-lmp');
  if (lmp) lmp.disabled = (r !== 'lmp');
}

// ── Signature pad ─────────────────────────────────────────────────────────────
function consentInitPad() {
  const c = document.getElementById('cn-sig');
  if (!c) return;
  const resize = () => {
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // Preserve nothing on resize (fresh pad); set backing store to CSS size * dpr.
    // Fall back to non-zero dims if the element isn't laid out yet (a 0-size canvas
    // makes toDataURL throw on some engines).
    c.width = Math.round((r.width || c.offsetWidth || 320) * dpr);
    c.height = Math.round((r.height || c.offsetHeight || 180) * dpr);
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#12227a';
  };
  resize();
  const ctx = c.getContext('2d');
  const pos = (e) => {
    const r = c.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  const start = (e) => { e.preventDefault(); _consent.drawing = true; const q = pos(e); ctx.beginPath(); ctx.moveTo(q.x, q.y); };
  const move = (e) => { if (!_consent.drawing) return; e.preventDefault(); const q = pos(e); ctx.lineTo(q.x, q.y); ctx.stroke(); _consent.hasInk = true; };
  const end = () => { _consent.drawing = false; };
  c.addEventListener('mousedown', start); c.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  c.addEventListener('touchstart', start, { passive: false });
  c.addEventListener('touchmove', move, { passive: false });
  c.addEventListener('touchend', end);
}
function consentClearSig() {
  const c = document.getElementById('cn-sig');
  if (!c) return;
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  _consent.hasInk = false;
}

async function consentSave(btn) {
  const msg = document.getElementById('cn-msg');
  const p = _consent.prefill || {};
  if (!_consent.hasInk) { if (msg) msg.innerHTML = `<span class="cn-err">Please have the patient sign first</span>`; return; }
  const reason = (document.querySelector('input[name="cn-reason"]:checked') || {}).value || '';
  const lmp = (document.getElementById('cn-lmp') || {}).value || '';
  if (reason === 'lmp' && !lmp) { if (msg) msg.innerHTML = `<span class="cn-err">Enter the last menstrual period date</span>`; return; }
  const c = document.getElementById('cn-sig');
  let signature = '';
  try { signature = c ? c.toDataURL('image/png') : ''; }
  catch (err) { if (msg) msg.innerHTML = `<span class="cn-err">Couldn't read the signature on this browser — try another. (${escapeHtml(err.message || '')})</span>`; return; }
  if (!signature || signature.length < 200) { if (msg) msg.innerHTML = `<span class="cn-err">Signature empty — please sign again</span>`; return; }
  const payload = {
    file_no: p.file_no || p.mrno || '',
    mrn: p.mrno || p.file_no || '',
    name: p.name || '',
    name_en: p.name_en || '',   // English name kept for the Siratech filing name-match
    dob: p.dob || '',
    procedure: (document.getElementById('cn-proc') || {}).value || '',
    weight: (document.getElementById('cn-weight') || {}).value || '',
    height: (document.getElementById('cn-height') || {}).value || '',
    hcg: (document.getElementById('cn-hcg') || {}).value || '',
    patient_type: p.patient_type || 'outpatient',
    reason, lmp_date: lmp,
    physician: p.physician || '',
    bill_no: p.bill_no || '', site: p.site || null,
    signature,
  };
  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Saving…';
  if (msg) msg.innerHTML = '';
  try {
    const r = await API.post('/consent', payload);
    if (r && r.ok) {
      const filedNote = r.filed
        ? `<span class="cn-ok" style="margin-inline-start:8px">📎 On the patient file</span>`
        : `<span class="pill" style="margin-inline-start:8px">Will attach to the report</span>`;
      if (msg) msg.innerHTML = `<span class="cn-ok">✅ Consent saved</span>${filedNote}
        <a class="btn btn-sm" style="margin-inline-start:8px" href="/api/consent/${r.id}/pdf?file=${encodeURIComponent(payload.file_no || '')}" target="_blank" rel="noopener">View PDF</a>`;
      const done = _consent.onDone;
      setTimeout(() => { closeConsent(); if (typeof done === 'function') done(r.id); }, 900);
    } else {
      if (msg) msg.innerHTML = `<span class="cn-err">Could not save the consent.</span>`;
    }
  } catch (e) {
    if (msg) msg.innerHTML = `<span class="cn-err">${escapeHtml(e.message || 'Save failed')}</span>`;
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}
