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
  ov.innerHTML = `<div class="cn-sheet"><div class="cn-head"><div><div class="cn-title">إقرار عدم الحمل</div>
    <div class="cn-sub">Non-Pregnancy Consent</div></div><button class="cn-x" onclick="closeConsent()">✕</button></div>
    <div class="cn-body" style="text-align:center"><div class="mini-spin"></div><p style="margin-top:10px;color:var(--muted)">Preparing link…</p></div></div>`;
  try {
    const r = await API.post('/consent/link', _consent.prefill);
    if (!r || !r.ok) throw new Error('Could not create the consent link');
    renderConsentQR(ov, r);
    consentStartPoll(r.id);
  } catch (e) {
    const body = ov.querySelector('.cn-body');
    if (body) body.innerHTML = `<div class="cn-err">${escapeHtml(e.message || 'Failed to prepare the link')}</div>
      <div style="margin-top:12px"><button class="btn btn-primary" onclick="consentSignHere()">Sign on this device · وقّعي على هذا الجهاز</button></div>`;
  }
}
function renderConsentQR(ov, r) {
  const p = _consent.prefill || {};
  ov.querySelector('.cn-sheet').innerHTML = `
    <div class="cn-head"><div><div class="cn-title">إقرار عدم الحمل</div><div class="cn-sub">Non-Pregnancy Consent · ${escapeHtml(p.name || '')}</div></div>
      <button class="cn-x" onclick="closeConsent()">✕</button></div>
    <div class="cn-body" style="text-align:center">
      <p style="font-size:14px;font-weight:700;margin-bottom:4px">اطلبي من المريضة مسح الرمز بجوالها</p>
      <p style="font-size:12.5px;color:var(--muted);direction:ltr;margin-bottom:14px">Ask the patient to scan this with her phone camera</p>
      ${r.qr ? `<img src="${escapeHtml(r.qr)}" alt="QR" style="width:230px;max-width:70vw;height:auto;border:1px solid var(--border);border-radius:14px;padding:8px;background:#fff">` : ''}
      <div style="margin-top:14px;display:flex;gap:8px;align-items:center;max-width:420px;margin-inline:auto">
        <input class="input" readonly value="${escapeHtml(r.url || '')}" style="flex:1;font-size:12px" onclick="this.select()">
        <button class="btn btn-sm" onclick="consentCopyLink(this,'${jsAttr(r.url || '')}')">Copy</button>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;max-width:420px;margin-inline:auto">
        <input id="cn-sms-phone" class="input" value="${escapeHtml(p.phone || '')}" placeholder="جوال المريضة · patient mobile e.g. 05xxxxxxxx" style="flex:1;font-size:13px">
        <button class="btn btn-sm btn-primary" onclick="consentSendSms(this,'${jsAttr(r.url || '')}')">📱 Send SMS</button>
      </div>
      <div id="cn-sms-msg" style="font-size:12px;color:var(--muted);margin-top:4px"></div>
      <div id="cn-poll" class="cn-poll">⏳ بانتظار توقيع المريضة… · waiting for signature…</div>
      <div style="margin-top:14px;border-top:1px dashed var(--border);padding-top:12px">
        <button class="btn btn-ghost btn-sm" onclick="consentSignHere()">أو وقّعي على هذا الجهاز · sign on this device</button>
      </div>
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
        const box = document.getElementById('cn-poll');
        if (box) box.innerHTML = `<span class="cn-ok">✅ تم التوقيع · Signed</span>
          <a class="btn btn-sm" style="margin-inline-start:8px" href="/api/consent/${id}/pdf?file=${encodeURIComponent((_consent.prefill && (_consent.prefill.file_no || _consent.prefill.mrno)) || '')}" target="_blank" rel="noopener">View PDF</a>`;
        const done = _consent.onDone;
        if (typeof done === 'function') done(id);
        setTimeout(closeConsent, 2500);
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
    <div class="cn-sheet">
      <div class="cn-head">
        <div>
          <div class="cn-title">نموذج إقرار بعدم وجود حمل</div>
          <div class="cn-sub">Declaration of Non-Pregnancy · Radiology</div>
        </div>
        <button class="cn-x" onclick="closeConsent()" aria-label="Close">✕</button>
      </div>

      <div class="cn-body">
        <!-- Her data, already registered — read-only summary -->
        <div class="cn-summary">
          <div class="cn-sum-row"><span>المريضة · Patient</span><b>${escapeHtml(p.name || '—')}</b></div>
          <div class="cn-sum-row"><span>الملف · File</span><b>${escapeHtml(p.mrno || p.file_no || '—')}</b></div>
          ${p.dob ? `<div class="cn-sum-row"><span>الميلاد · DOB</span><b>${escapeHtml(p.dob)}</b></div>` : ''}
          <div class="cn-sum-row"><span>الإجراء · Procedure</span><b>${escapeHtml(p.procedure || '—')}</b></div>
          ${p.branch ? `<div class="cn-sum-row"><span>الفرع · Branch</span><b>${escapeHtml(p.branch)}</b></div>` : ''}
          <div class="cn-sum-row"><span>النوع · Type</span><b>${isER ? 'طوارئ · ER' : 'مراجعة · Outpatient'}</b></div>
          ${p.physician ? `<div class="cn-sum-row"><span>الطبيب · Physician</span><b>${escapeHtml(p.physician)}</b></div>` : ''}
        </div>
        <input type="hidden" id="cn-proc" value="${escapeHtml(p.procedure || '')}">

        <!-- Optional clinical values the specialist enters if measured -->
        <div class="cn-vitals">
          <div class="cn-vitals-h">قياسات (اختياري — يعبّيها الأخصائي) · Vitals (optional)</div>
          <div class="cn-vitals-row">
            <label><span>الوزن · Weight</span><input id="cn-weight" class="input" inputmode="decimal" value="${escapeHtml(p.weight || '')}" placeholder="kg"></label>
            <label><span>الطول · Height</span><input id="cn-height" class="input" inputmode="decimal" value="${escapeHtml(p.height || '')}" placeholder="cm"></label>
            <label><span>HCG</span><input id="cn-hcg" class="input" placeholder="—"></label>
          </div>
        </div>

        <!-- What the patient reads and chooses -->
        <div class="cn-declare">
          <div class="cn-declare-h">أقر بأني لست حامل أثناء عمل فحص الأشعة<br><span>I declare I am not pregnant during the exam.</span></div>
          <div class="cn-lbl" style="margin-top:10px">بسبب · Because:</div>
          <label class="cn-radio"><input type="radio" name="cn-reason" value="not_married" onchange="consentSetReason('not_married')"> لست متزوجة · Not married</label>
          <label class="cn-radio"><input type="radio" name="cn-reason" value="lmp" checked onchange="consentSetReason('lmp')"> تاريخ آخر دورة شهرية · Last menstrual period
            <input id="cn-lmp" type="date" class="input" style="max-width:180px;margin-inline-start:8px"></label>
          <label class="cn-radio"><input type="radio" name="cn-reason" value="iud" onchange="consentSetReason('iud')"> مانع الحمل اللولب · IUD</label>
        </div>

        <div class="cn-risk">⚠️ أدرك أن هذا الإجراء يستخدم الأشعة المؤيّنة وقد يعرّض الجنين للمخاطر، وأوافق على إجرائه.<br>
          <span>I understand this procedure uses ionizing radiation which may pose a risk to a fetus, and I consent to it.</span></div>

        <div class="cn-siglabel">التوقيع · Signature <span style="color:var(--muted);font-weight:500">— وقّعي هنا بإصبعك / sign with your finger</span></div>
        <div class="cn-sigwrap">
          <canvas id="cn-sig" class="cn-sig"></canvas>
          <button type="button" class="cn-sigclear" onclick="consentClearSig()">Clear · مسح</button>
        </div>
        <div id="cn-msg" class="cn-msg"></div>
      </div>

      <div class="cn-foot">
        <button class="btn btn-ghost" onclick="closeConsent()">Cancel · إلغاء</button>
        <button class="btn btn-primary" id="cn-save" onclick="consentSave(this)">Save &amp; file · حفظ وإرفاق</button>
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
  if (!_consent.hasInk) { if (msg) msg.innerHTML = `<span class="cn-err">Please have the patient sign first · التوقيع مطلوب</span>`; return; }
  const reason = (document.querySelector('input[name="cn-reason"]:checked') || {}).value || '';
  const lmp = (document.getElementById('cn-lmp') || {}).value || '';
  if (reason === 'lmp' && !lmp) { if (msg) msg.innerHTML = `<span class="cn-err">Enter the last menstrual period date · أدخلي تاريخ آخر دورة</span>`; return; }
  const c = document.getElementById('cn-sig');
  let signature = '';
  try { signature = c ? c.toDataURL('image/png') : ''; }
  catch (err) { if (msg) msg.innerHTML = `<span class="cn-err">Couldn't read the signature on this browser — try another. (${escapeHtml(err.message || '')})</span>`; return; }
  if (!signature || signature.length < 200) { if (msg) msg.innerHTML = `<span class="cn-err">Signature empty — please sign again · التوقيع فارغ</span>`; return; }
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
        ? `<span class="cn-ok" style="margin-inline-start:8px">📎 On the patient file · رُفعت لملف المريض</span>`
        : `<span class="pill" style="margin-inline-start:8px">Will attach to the report · تُرفق مع التقرير</span>`;
      if (msg) msg.innerHTML = `<span class="cn-ok">✅ Consent saved · تم الحفظ</span>${filedNote}
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
