// ── Radiology consent · Declaration of Non-Pregnancy ──────────────────────────
// A patient-facing, full-screen consent the specialist hands to the patient on the
// same device: the patient reads the bilingual declaration, fills the reason, signs
// with a finger, and the signed PDF is generated server-side and filed to her file.

let _consent = { prefill: null, onDone: null, drawing: false, hasInk: false };

// Open the consent for a patient. prefill: {file_no,name,mrn,dob,procedure,weight,
// height,patient_type,physician}. onDone(consentId) fires after a successful save.
function openConsent(prefill, onDone) {
  _consent = { prefill: prefill || {}, onDone: onDone || null, drawing: false, hasInk: false };
  let ov = document.getElementById('consent-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'consent-overlay'; document.body.appendChild(ov); }
  renderConsent(ov);
}
function closeConsent() {
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
        <div class="cn-patient">
          <div><span>Patient / المريضة</span><b>${escapeHtml(p.name || '—')}</b></div>
          <div><span>File / الملف</span><b>${escapeHtml(p.mrno || p.file_no || '—')}</b></div>
          ${p.dob ? `<div><span>DOB / الميلاد</span><b>${escapeHtml(p.dob)}</b></div>` : ''}
        </div>

        <div class="cn-grid">
          <label class="cn-f"><span>Procedure · الإجراء</span>
            <input id="cn-proc" class="input" value="${escapeHtml(p.procedure || '')}" placeholder="Exam"></label>
          <label class="cn-f"><span>Weight · الوزن</span>
            <input id="cn-weight" class="input" value="${escapeHtml(p.weight || '')}" placeholder="kg"></label>
          <label class="cn-f"><span>Height · الطول</span>
            <input id="cn-height" class="input" value="${escapeHtml(p.height || '')}" placeholder="cm"></label>
          <label class="cn-f"><span>HCG (if applicable) · تحليل الحمل</span>
            <input id="cn-hcg" class="input" placeholder="—"></label>
        </div>

        <div class="cn-seg">
          <span class="cn-lbl">Patient type · نوع المريضة</span>
          <div class="seg" id="cn-type">
            <button type="button" class="${!isER ? 'on' : ''}" onclick="consentSetType('outpatient',this)">Outpatient · مراجعة</button>
            <button type="button" class="${isER ? 'on' : ''}" onclick="consentSetType('er',this)">ER · طوارئ</button>
          </div>
        </div>

        <div class="cn-declare">
          <div class="cn-declare-h">أقر بأني لست حامل أثناء عمل فحص الأشعة — I declare I am not pregnant during the exam.</div>
          <div class="cn-lbl" style="margin-top:8px">Because · بسبب:</div>
          <label class="cn-radio"><input type="radio" name="cn-reason" value="not_married" onchange="consentSetReason('not_married')"> لست متزوجة · I'm not married</label>
          <label class="cn-radio"><input type="radio" name="cn-reason" value="lmp" checked onchange="consentSetReason('lmp')"> تاريخ آخر دورة شهرية · Last menstrual period
            <input id="cn-lmp" type="date" class="input" style="max-width:180px;margin-inline-start:8px"></label>
          <label class="cn-radio"><input type="radio" name="cn-reason" value="iud" onchange="consentSetReason('iud')"> مانع الحمل اللولب · IUD</label>
        </div>

        <div class="cn-risk">⚠️ أدرك أن هذا الإجراء يستخدم الأشعة المؤيّنة وقد يعرّض الجنين للمخاطر.<br>
          I understand this procedure uses ionizing radiation which may pose a risk to a fetus, and I consent to it.</div>

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

function consentSetType(t, btn) {
  _consent.prefill.patient_type = t;
  const seg = document.getElementById('cn-type');
  if (seg) seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
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
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
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
  const signature = c ? c.toDataURL('image/png') : '';
  const payload = {
    file_no: p.file_no || p.mrno || '',
    mrn: p.mrno || p.file_no || '',
    name: p.name || '',
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
      if (msg) msg.innerHTML = `<span class="cn-ok">✅ Consent saved · تم الحفظ</span>
        <a class="btn btn-sm" style="margin-inline-start:8px" href="/api/consent/${r.id}/pdf" target="_blank" rel="noopener">View PDF</a>`;
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
