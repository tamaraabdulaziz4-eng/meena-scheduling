// ── Peer Review — radiology QA (RADPEER-style) ────────────────────────────────
// A second radiologist scores agreement with a colleague's report on a 1–4 scale.
// The discrepancy rate (score ≥ 2) and significant-discrepancy rate (score ≥ 3 or
// flagged) — overall and per reader — is the accreditation-grade quality metric
// (CBAHI / ACR; the ACR benchmark discrepancy rate is ~3%). All Meena-owned; nothing
// is written back to Siratech.

let _prDays = 90;
let _prReader = '';
const _prCache = new Map();   // `${days}|${reader}` -> {sum, list} — stale-first: repaint instantly on re-entry, refresh underneath

const PR_SCORE = {
  1: { label: 'Concur', desc: 'Agree with the interpretation', color: '#22c55e' },
  2: { label: 'Discrepancy — understandable miss', desc: 'Not ordinarily expected to be made', color: '#eab308' },
  3: { label: 'Discrepancy — should usually be caught', desc: 'Should be made most of the time', color: '#f59e0b' },
  4: { label: 'Discrepancy — misinterpretation', desc: 'Should be made almost every time', color: '#ef4444' },
};

function renderPeerReviewPage() {
  setTopbar('Peer Review', 'Radiology QA — peer scoring & discrepancy rate');
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="cc">
      ${pageHero('Quality', 'Peer Review')}
      <div class="board" style="margin-bottom:14px">
        <div style="padding:14px 18px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between">
          <div style="display:flex;gap:6px;flex-wrap:wrap" id="pr-range"></div>
          <button class="open pri" style="width:auto" onclick="prLogForm()">＋ Log peer review</button>
        </div>
      </div>
      <div id="pr-summary"></div>
      <div id="pr-list" style="margin-top:14px"></div>
    </div>`;
  prRenderRange();
  prLoad();
}

function prRenderRange() {
  const el = document.getElementById('pr-range');
  if (!el) return;
  const opts = [[30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']];
  el.innerHTML = opts.map(([d, label]) =>
    `<button class="chip ${_prDays === d ? 'on' : ''}" onclick="prSetDays(${d})">${label}</button>`).join('');
}

function prSetDays(d) { _prDays = d; _prReader = ''; prRenderRange(); prLoad(); }
function prSetReader(r) { _prReader = r || ''; prLoad(); }

async function prLoad() {
  const sBox = document.getElementById('pr-summary');
  const lBox = document.getElementById('pr-list');
  const key = `${_prDays}|${_prReader}`;
  const cached = _prCache.get(key);
  if (cached) { prRenderSummary(cached.sum || {}); prRenderList((cached.list && cached.list.items) || []); }
  else if (sBox) sBox.innerHTML = `<div class="board"><div style="padding:22px 18px;color:var(--muted)">Loading…</div></div>`;
  let sum, list;
  try {
    [sum, list] = await Promise.all([
      API.get(`/radiology/peer-review/summary?days=${_prDays}`),
      API.get(`/radiology/peer-review?days=${_prDays}${_prReader ? '&reader=' + encodeURIComponent(_prReader) : ''}`),
    ]);
  } catch (e) {
    if (!cached && sBox) sBox.innerHTML = `<div class="board"><div style="padding:22px 18px;color:var(--danger-ink)">Could not load: ${escapeHtml(e.message || 'error')}</div></div>`;
    if (!cached && lBox) lBox.innerHTML = '';
    return;   // on a refresh error, keep the stale summary/list on screen
  }
  _prCache.set(key, { sum, list });
  prRenderSummary(sum || {});
  prRenderList((list && list.items) || []);
}

function prRateColor(rate) {
  // ACR benchmark discrepancy rate ≈ 3%. Green under 5%, amber under 10%, red above.
  if (rate < 5) return '#22c55e';
  if (rate < 10) return '#f59e0b';
  return '#ef4444';
}

function prRenderSummary(s) {
  const box = document.getElementById('pr-summary');
  if (!box) return;
  const reviews = s.reviews || 0;
  if (!reviews) {
    box.innerHTML = `<div class="board"><div style="padding:26px 18px;text-align:center;color:var(--muted)">
      No peer reviews logged in this period. Use <b>＋ Log peer review</b> to record the first one.</div></div>`;
    return;
  }
  const kpi = (val, label, color, sub) => `
    <div class="board" style="flex:1;min-width:150px">
      <div style="padding:16px 18px">
        <div style="font-size:30px;font-weight:800;color:${color || 'var(--primary)'};line-height:1">${val}</div>
        <div style="font-size:11.5px;font-weight:600;color:var(--muted);margin-top:5px">${label}</div>
        ${sub ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${sub}</div>` : ''}
      </div>
    </div>`;
  const dRate = s.discrepancyRate || 0, sRate = s.significantRate || 0;
  const cards = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
    ${kpi(reviews, 'Reviews', 'var(--accent,#6b4eff)')}
    ${kpi(dRate + '%', 'Discrepancy rate', prRateColor(dRate), `${s.discrepancies || 0} of ${reviews} · ACR benchmark ≈ 3%`)}
    ${kpi(sRate + '%', 'Significant discrepancy', prRateColor(sRate), `${s.significant || 0} clinically significant`)}
  </div>`;

  const rows = (s.byReader || []);
  const maxRev = Math.max(1, ...rows.map((r) => r.reviews || 0));
  const table = rows.length ? `
    <div class="board"><div style="padding:14px 18px">
      <div style="font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);margin-bottom:10px">Discrepancy rate by radiologist</div>
      ${rows.map((r) => {
        const rate = r.discrepancyRate || 0;
        const active = _prReader && _prReader === r.reader;
        return `<div class="pr-readrow ${active ? 'on' : ''}" onclick="prSetReader('${_prReader === r.reader ? '' : jsAttr(r.reader)}')" title="Filter the list by this reader">
          <div class="pr-readname">${escapeHtml(r.reader || '—')}</div>
          <div class="pr-readbar"><span style="width:${Math.round((r.reviews / maxRev) * 100)}%"></span></div>
          <div class="pr-readn">${r.reviews} rev</div>
          <div class="pr-readrate" style="color:${prRateColor(rate)}">${rate}%${r.significant ? ` · ${r.significant}⚠` : ''}</div>
        </div>`;
      }).join('')}
    </div></div>` : '';
  box.innerHTML = cards + table;
}

function prRenderList(items) {
  const box = document.getElementById('pr-list');
  if (!box) return;
  const head = `<div style="display:flex;align-items:center;gap:10px;margin:0 2px 8px">
    <div style="font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)">Reviews${_prReader ? ' — ' + escapeHtml(_prReader) : ''}</div>
    ${_prReader ? `<button class="chip" onclick="prSetReader('')">✕ clear filter</button>` : ''}</div>`;
  if (!items.length) {
    box.innerHTML = head + `<div class="board"><div style="padding:22px 18px;text-align:center;color:var(--muted)">No reviews to show</div></div>`;
    return;
  }
  box.innerHTML = head + items.map(prCard).join('');
}

function prCard(r) {
  const sc = PR_SCORE[r.score] || PR_SCORE[1];
  const chip = `<span class="sc" style="margin:0;background:${sc.color};color:#fff">${r.score} · ${escapeHtml(sc.label)}</span>`;
  return `
    <div class="board" style="margin-bottom:10px;${r.significant ? 'border-color:var(--danger)' : ''}">
      <div style="padding:13px 18px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:5px">
          ${chip}
          <span style="font-weight:800;font-size:14.5px">${escapeHtml(r.patient_name || r.mrno || '')}</span>
          <span style="color:var(--muted);font-size:12px">MRN ${escapeHtml(r.mrno || '')}${r.exam ? ' · ' + escapeHtml(r.exam) : ''}${r.modality ? ' · ' + escapeHtml(r.modality) : ''}${r.accession ? ' · ' + escapeHtml(r.accession) : ''}</span>
          <span style="flex:1"></span>
          ${r.significant ? `<span style="color:var(--danger-ink);font-weight:700;font-size:11.5px">⚠ clinically significant</span>` : ''}
        </div>
        ${r.note ? `<div style="font-size:13px;margin:4px 0 6px;white-space:pre-wrap">${escapeHtml(r.note)}</div>` : ''}
        <div style="font-size:11.5px;color:var(--muted)">
          Read by <b>${escapeHtml(r.original_reader || '—')}</b> · reviewed by ${escapeHtml(r.reviewer_name || '—')}${r.created_at ? ' · ' + prWhen(r.created_at) : ''}
        </div>
      </div>
    </div>`;
}

function prWhen(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); } }

function prLogForm(prefill) {
  const p = prefill || {};
  showModal('pr-log-modal', `
    <div style="font-size:17px;font-weight:800;margin-bottom:4px">Log peer review</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px">Score your agreement with a colleague's report. A review must be by a different radiologist than the one who read it.</div>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Agreement score (RADPEER) *</label>
    <select id="pr-score" class="input" style="margin-bottom:10px">
      ${[1, 2, 3, 4].map((n) => `<option value="${n}">${n} — ${PR_SCORE[n].label} · ${PR_SCORE[n].desc}</option>`).join('')}
    </select>
    <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin-bottom:12px;cursor:pointer">
      <input type="checkbox" id="pr-sig" style="width:auto"> The discrepancy is clinically significant
    </label>
    <div style="display:flex;gap:10px">
      <div style="flex:1"><label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Patient MRN *</label><input id="pr-mrno" class="input" style="margin-bottom:10px" value="${escapeHtml(p.mrno || '')}" placeholder="MRN"></div>
      <div style="flex:1"><label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Patient name</label><input id="pr-pname" class="input" style="margin-bottom:10px" value="${escapeHtml(p.patientName || '')}" placeholder="Patient name"></div>
    </div>
    <div style="display:flex;gap:10px">
      <div style="flex:1"><label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Exam</label><input id="pr-exam" class="input" style="margin-bottom:10px" value="${escapeHtml(p.exam || '')}" placeholder="e.g. CT Head"></div>
      <div style="flex:1"><label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Modality</label><input id="pr-mod" class="input" style="margin-bottom:10px" value="${escapeHtml(p.modality || '')}" placeholder="CT / MRI / US / XR"></div>
    </div>
    <div style="display:flex;gap:10px">
      <div style="flex:1"><label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Original reader (radiologist) *</label><input id="pr-reader" class="input" style="margin-bottom:10px" value="${escapeHtml(p.originalReader || '')}" placeholder="Whose report this is"></div>
      <div style="flex:1"><label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Accession</label><input id="pr-acc" class="input" style="margin-bottom:10px" value="${escapeHtml(p.accession || '')}" placeholder="Accession"></div>
    </div>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Note</label>
    <textarea id="pr-note" class="input" rows="3" style="margin-bottom:16px" placeholder="What differed, or a teaching point">${escapeHtml(p.note || '')}</textarea>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-ghost" style="width:auto" onclick="closeModal('pr-log-modal')">Cancel</button>
      <button class="btn btn-primary" style="width:auto" onclick="prLogSubmit(${p.site != null ? p.site : 'null'})">Save review</button>
    </div>`);
}

async function prLogSubmit(site) {
  const mrno = (document.getElementById('pr-mrno')?.value || '').trim();
  const reader = (document.getElementById('pr-reader')?.value || '').trim();
  if (!mrno) { toast('Patient MRN is required', 'err'); return; }
  if (!reader) { toast('Name the radiologist whose report you reviewed', 'err'); return; }
  const body = {
    mrno,
    score: Number(document.getElementById('pr-score')?.value || 1),
    clinicallySignificant: !!document.getElementById('pr-sig')?.checked,
    patientName: (document.getElementById('pr-pname')?.value || '').trim(),
    exam: (document.getElementById('pr-exam')?.value || '').trim(),
    modality: (document.getElementById('pr-mod')?.value || '').trim(),
    originalReader: reader,
    accession: (document.getElementById('pr-acc')?.value || '').trim(),
    note: (document.getElementById('pr-note')?.value || '').trim(),
    site: site,
  };
  try {
    await API.post('/radiology/peer-review', body);
    closeModal('pr-log-modal');
    toast('Peer review saved');
    prLoad();
  } catch (e) {
    toast(e.message || 'Could not save', 'err');
  }
}
