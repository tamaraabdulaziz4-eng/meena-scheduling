// ── Radiology monthly report — presentation deck ──────────────────────────────
// Builds a slide-style report (same Meena design) from the live HIS stats:
// executive KPIs with month-over-month deltas, branch / modality / financial /
// trend slides, auto insights, and — at the start of a quarter — a
// quarter-over-quarter comparison. Viewable on screen (arrow through slides) and
// downloadable as a landscape PDF (each slide = one page).
//
// Reuses the radstats renderers (rsDonut / rsArea / rsBarRows / rsNum / rsSAR)
// so the charts match the live dashboard exactly. Scope follows the page: a
// team lead's report is their branch; a manager's follows the current selection.

const RSR = { idx: 0, count: 0, meta: null };

function _rsrKsaToday() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
function _rsrMonthLast(y, m) { return new Date(y, m, 0).getDate(); }
function _rsrMonthLabel(y, m) { return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }
function _rsrPad(n) { return String(n).padStart(2, '0'); }

// Quarter (Jan-Mar=Q1 …) that CONTAINS a given month (handles month<1 wrap).
function _rsrQuarterContaining(y, month) {
  let yy = y, mm = month;
  while (mm < 1) { yy -= 1; mm += 12; }
  while (mm > 12) { yy += 1; mm -= 12; }
  const qi = Math.floor((mm - 1) / 3);
  const sm = qi * 3 + 1, em = qi * 3 + 3;
  return { y: yy, sm, em, from: `${yy}-${_rsrPad(sm)}-01`, to: `${yy}-${_rsrPad(em)}-${_rsrPad(_rsrMonthLast(yy, em))}`, label: `Q${qi + 1} ${yy}` };
}

async function _rsrFetch(from, to, full) {
  const q = new URLSearchParams();
  q.set('from', from); q.set('to', to);
  if (full) q.set('full', '1');
  const s = (typeof rsSitesParam === 'function') ? rsSitesParam() : '';
  if (s) q.set('sites', s);
  return API.get('/radiology/stats?' + q.toString());
}

// Pull the comparable numbers out of one stats payload (mirrors rsRenderBody).
function _rsrExtract(d) {
  if (!d || !d.ok) return null;
  const total = d.total || 0;
  const emg = (d.priority && d.priority.emergency) || 0;
  const rtn = (d.priority && d.priority.routine) || 0;
  const m = d.modality, f = d.financial;
  let exams = null;
  if (m) exams = m.truncated ? Math.round((m.exams / Math.max(1, m.sampled)) * m.ofTotal) : (m.exams || 0);
  let revenue = null, insCount = null, insShare = null;
  if (f) {
    revenue = Math.round(f.revenue || 0);
    const priced = f.requests || 0;
    const cov = ((f.byPayer || []).find((p) => p.type === 'Insurance') || {}).count || 0;
    insShare = priced ? cov / priced : 0;
    insCount = f.truncated ? Math.round(total * insShare) : cov;
  }
  return {
    total, patients: d.patients != null ? d.patients : null, emg, rtn, exams,
    revenue, insCount, insShare, aged: (d.aging && d.aging['>7d']) || 0,
    byBranch: d.byBranch || [], byDoctor: d.byDoctor || [], byDepartment: d.byDepartment || [],
    daily: d.daily || [], modality: m, financial: f,
  };
}

// A coloured ▲/▼ change chip. invert=true → a drop is the "good" (green) case.
function _rsrDelta(cur, prev, opt) {
  opt = opt || {};
  if (cur == null || prev == null || prev === 0) return `<span class="rsr-delta flat">— new</span>`;
  const diff = cur - prev;
  const pct = Math.round((diff / prev) * 100);
  const flat = diff === 0;
  const good = opt.invert ? diff < 0 : diff > 0;
  const cls = flat ? 'flat' : (good ? 'up' : 'down');
  const arrow = flat ? '→' : (diff > 0 ? '▲' : '▼');
  const sign = diff > 0 ? '+' : '';
  return `<span class="rsr-delta ${cls}">${arrow} ${sign}${pct}%</span>`;
}

function _rsrKpi(label, cur, prev, fmt, opt) {
  fmt = fmt || rsNum; opt = opt || {};
  const per = opt.period || 'month';
  const prevTxt = (prev != null) ? `vs ${fmt(prev)} last ${per}` : `no prior ${per}`;
  const val = cur != null ? fmt(cur) : '<span class="rsr-dim">…</span>';
  return `<div class="rsr-kpi">
    <div class="rsr-kpi-l">${label}</div>
    <div class="rsr-kpi-v">${val}</div>
    <div class="rsr-kpi-d">${cur != null ? _rsrDelta(cur, prev, opt) : ''} <span class="rsr-kpi-prev">${prevTxt}</span></div>
  </div>`;
}

function _rsrSlide(kicker, title, inner, cls) {
  return `<section class="rsr-slide${cls ? ' ' + cls : ''}">
    <div class="rsr-slide-head">
      <div><div class="rsr-kicker">${escapeHtml(kicker)}</div><div class="rsr-title">${title}</div></div>
      <div class="rsr-brand"><img src="/meena_logo.png" alt="Meena"></div>
    </div>
    <div class="rsr-slide-body">${inner}</div>
  </section>`;
}

// Per-branch this-vs-last comparison rows (name · this · last · delta bar).
function _rsrBranchCompare(cur, prev) {
  const prevMap = new Map((prev ? prev.byBranch : []).map((b) => [String(b.site), b.count]));
  const rows = (cur.byBranch || []).slice().sort((a, b) => b.count - a.count);
  if (!rows.length) return `<div class="rs-empty">No branch data</div>`;
  const max = Math.max(1, ...rows.map((b) => b.count));
  return `<div class="rsr-bc">` + rows.map((b) => {
    const p = prevMap.get(String(b.site));
    const pct = Math.round((b.count / max) * 100);
    return `<div class="rsr-bc-row">
      <div class="rsr-bc-name" title="${escapeHtml(b.name || ('Branch ' + b.site))}">${escapeHtml(b.name || ('Branch ' + b.site))}</div>
      <div class="rsr-bc-track"><div class="rsr-bc-fill" style="width:${pct}%"></div></div>
      <div class="rsr-bc-now">${rsNum(b.count)}</div>
      <div class="rsr-bc-delta">${p != null ? _rsrDelta(b.count, p) : '<span class="rsr-delta flat">—</span>'}</div>
    </div>`;
  }).join('') + `</div>`;
}

// A compact "metric | this | last | change" comparison table.
function _rsrTable(rows) {
  return `<table class="rsr-table"><thead><tr>
      <th>Metric</th><th>This period</th><th>Previous</th><th>Change</th></tr></thead><tbody>` +
    rows.map((r) => `<tr>
      <td class="rsr-td-m">${r.label}</td>
      <td class="rsr-td-v">${r.cur != null ? r.fmt(r.cur) : '—'}</td>
      <td class="rsr-td-p">${r.prev != null ? r.fmt(r.prev) : '—'}</td>
      <td>${(r.cur != null && r.prev != null) ? _rsrDelta(r.cur, r.prev, r.opt || {}) : '—'}</td>
    </tr>`).join('') + `</tbody></table>`;
}

// Auto-written headline insights for the closing slide.
function _rsrInsights(cur, prev, meta) {
  const notes = [];
  if (prev && prev.total) {
    const d = cur.total - prev.total, pct = Math.round((d / prev.total) * 100);
    notes.push(`Total requests ${d >= 0 ? 'rose' : 'fell'} ${Math.abs(pct)}% vs the previous ${meta.period} (${rsNum(cur.total)} vs ${rsNum(prev.total)}).`);
  } else {
    notes.push(`${rsNum(cur.total)} radiology requests this ${meta.period}.`);
  }
  // Biggest-moving branch
  if (prev) {
    const pm = new Map(prev.byBranch.map((b) => [String(b.site), b.count]));
    let best = null;
    cur.byBranch.forEach((b) => {
      const p = pm.get(String(b.site)); if (p == null || p === 0) return;
      const g = (b.count - p) / p;
      if (!best || g > best.g) best = { name: b.name, g, now: b.count, was: p };
    });
    if (best && best.g > 0) notes.push(`${escapeHtml(best.name)} grew the most (+${Math.round(best.g * 100)}%, ${rsNum(best.was)}→${rsNum(best.now)}).`);
  }
  // Busiest modality
  if (cur.modality && cur.modality.mix && cur.modality.mix.length) {
    const top = cur.modality.mix.slice().sort((a, b) => b.count - a.count)[0];
    if (top) notes.push(`${escapeHtml(top.modality)} was the busiest modality (${rsNum(top.count)} exams).`);
  }
  // Emergency share
  if (cur.total) {
    const share = Math.round((cur.emg / cur.total) * 100);
    let t = `Emergency made up ${share}% of requests`;
    if (prev && prev.total) { const ps = Math.round((prev.emg / prev.total) * 100); t += ` (was ${ps}%)`; }
    notes.push(t + '.');
  }
  // Revenue
  if (cur.revenue != null) {
    let t = `Billed revenue was ${rsSAR(cur.revenue)}`;
    if (prev && prev.revenue) { const pct = Math.round(((cur.revenue - prev.revenue) / prev.revenue) * 100); t += ` (${pct >= 0 ? '+' : ''}${pct}% vs last ${meta.period})`; }
    notes.push(t + '.');
  }
  if (cur.aged) notes.push(`${rsNum(cur.aged)} request${cur.aged !== 1 ? 's' : ''} still pending after 7+ days at period end.`);
  return notes;
}

const RSR_MOD_COLOR = { CT: '#6B4EFF', MRI: '#0ea5e9', 'X-Ray': '#22c55e', Ultrasound: '#f59e0b', Mammography: '#ec4899', 'DEXA / Bone Density': '#14b8a6', Fluoroscopy: '#8b5cf6', Other: '#94a3b8' };
const RSR_PAYER_COLOR = { 'Insurance': '#6B4EFF', 'Cash / self-pay': '#22c55e', 'Insurance + copay': '#f59e0b' };

function _rsrBuildDeck(ctx) {
  const { cur, prev, quarter, meta } = ctx;
  const slides = [];
  const scope = meta.scope || 'All branches';
  const per = meta.period;

  // 1 — Cover
  slides.push(`<section class="rsr-slide rsr-cover">
    <div class="rsr-cover-orb a"></div><div class="rsr-cover-orb b"></div>
    <div class="rsr-cover-logo"><img src="/meena_logo.png" alt="Meena"></div>
    <div class="rsr-cover-kick">Radiology · Monthly Report</div>
    <div class="rsr-cover-title">${escapeHtml(meta.title)}</div>
    <div class="rsr-cover-sub">${escapeHtml(scope)} · vs ${escapeHtml(meta.prevLabel)}</div>
    <div class="rsr-cover-meta"><span class="rsr-cover-dot"></span>Live from Siratech HIS · generated ${escapeHtml(meta.generated)}</div>
    ${meta.partialNote ? `<div class="rsr-cover-note">${escapeHtml(meta.partialNote)}</div>` : ''}
  </section>`);

  // 2 — Executive KPIs
  slides.push(_rsrSlide('Executive summary', `Key numbers <span class="rsr-tvs">vs ${escapeHtml(meta.prevLabel)}</span>`, `
    <div class="rsr-kpis">
      ${_rsrKpi('Requests', cur.total, prev ? prev.total : null, rsNum, { period: per })}
      ${_rsrKpi('Patients', cur.patients, prev ? prev.patients : null, rsNum, { period: per })}
      ${_rsrKpi('Exams', cur.exams, prev ? prev.exams : null, rsNum, { period: per })}
      ${_rsrKpi('Revenue', cur.revenue, prev ? prev.revenue : null, rsSAR, { period: per })}
      ${_rsrKpi('Emergency', cur.emg, prev ? prev.emg : null, rsNum, { period: per, invert: true })}
      ${_rsrKpi('Pending &gt;7d', cur.aged, prev ? prev.aged : null, rsNum, { period: per, invert: true })}
    </div>`));

  // 3 — Full comparison table
  slides.push(_rsrSlide('Month over month', `Full comparison`, _rsrTable([
    { label: 'Requests', cur: cur.total, prev: prev ? prev.total : null, fmt: rsNum },
    { label: 'Patients', cur: cur.patients, prev: prev ? prev.patients : null, fmt: rsNum },
    { label: 'Exams', cur: cur.exams, prev: prev ? prev.exams : null, fmt: rsNum },
    { label: 'Emergency', cur: cur.emg, prev: prev ? prev.emg : null, fmt: rsNum, opt: { invert: true } },
    { label: 'Routine', cur: cur.rtn, prev: prev ? prev.rtn : null, fmt: rsNum },
    { label: 'Revenue (billed)', cur: cur.revenue, prev: prev ? prev.revenue : null, fmt: rsSAR },
    { label: 'Insurance-covered', cur: cur.insCount, prev: prev ? prev.insCount : null, fmt: rsNum },
    { label: 'Pending > 7 days', cur: cur.aged, prev: prev ? prev.aged : null, fmt: rsNum, opt: { invert: true } },
  ])));

  // 4 — By branch (compare)
  if ((cur.byBranch || []).length > 1) {
    slides.push(_rsrSlide('Where the work is', `By branch <span class="rsr-tvs">this ${per} vs last</span>`, _rsrBranchCompare(cur, prev)));
  }

  // 5 — Modality mix
  if (cur.modality && cur.modality.mix && cur.modality.mix.length) {
    const segs = cur.modality.mix.map((x) => ({ label: x.modality, count: x.count, color: RSR_MOD_COLOR[x.modality] || '#94a3b8' }));
    slides.push(_rsrSlide('Case mix', `Modality mix — exams`, `<div class="rsr-center">${rsDonut(segs, { centerVal: cur.exams, centerLabel: 'exams' })}</div>`));
  }

  // 6 — Financial
  if (cur.financial) {
    const f = cur.financial;
    const payerSegs = (f.byPayer || []).map((p) => ({ label: p.type, count: p.count, color: RSR_PAYER_COLOR[p.type] || '#94a3b8' }));
    const revDonut = rsDonut([
      { label: 'Insurance', count: Math.round(f.sponsor || 0), color: '#6B4EFF' },
      { label: 'Cash / copay', count: Math.round(f.patient || 0), color: '#22c55e' },
    ], { centerVal: Math.round(f.revenue || 0), centerLabel: 'SAR' });
    slides.push(_rsrSlide('Revenue', `Financial — billed revenue &amp; payer`, `
      <div class="rsr-fin-head">
        <div><div class="rsr-fin-n">${rsSAR(f.revenue)}</div><div class="rsr-fin-l">total billed ${prev && prev.revenue ? _rsrDelta(cur.revenue, prev.revenue) : ''}</div></div>
        <div><div class="rsr-fin-n">${rsNum(f.requests)}</div><div class="rsr-fin-l">requests priced</div></div>
      </div>
      <div class="rsr-two">
        <div><div class="rs-subhead">Requests by payer</div>${rsDonut(payerSegs, { centerVal: f.requests || 0, centerLabel: 'requests' })}</div>
        <div><div class="rs-subhead">Revenue: insurance vs cash</div>${revDonut}</div>
      </div>`));
  }

  // 7 — Daily trend
  if ((cur.daily || []).length) {
    slides.push(_rsrSlide('Rhythm', `Daily request trend`, `<div class="rsr-area">${rsArea(cur.daily)}</div>`));
  }

  // 8 — Doctors & departments
  const docItems = (cur.byDoctor || []).map((x) => ({ label: x.name, count: x.count }));
  const deptItems = (cur.byDepartment || []).map((x) => ({ label: x.name, count: x.count }));
  if (docItems.length || deptItems.length) {
    slides.push(_rsrSlide('Who is ordering', `Top ordering doctors &amp; departments`, `
      <div class="rsr-two">
        <div><div class="rs-subhead">Top ordering doctors</div>${rsBarRows(docItems.slice(0, 10), '#0ea5e9')}</div>
        <div><div class="rs-subhead">By ordering department</div>${rsBarRows(deptItems.slice(0, 10), '#8358FD')}</div>
      </div>`));
  }

  // 9 — Quarter over quarter (only at a quarter start)
  if (quarter && quarter.cur) {
    const qc = quarter.cur, qp = quarter.prev;
    slides.push(_rsrSlide('Quarter over quarter', `${escapeHtml(quarter.curLabel)} <span class="rsr-tvs">vs ${escapeHtml(quarter.prevLabel)}</span>`, `
      <div class="rsr-kpis rsr-kpis-3">
        ${_rsrKpi('Requests', qc.total, qp ? qp.total : null, rsNum, { period: 'quarter' })}
        ${_rsrKpi('Emergency', qc.emg, qp ? qp.emg : null, rsNum, { period: 'quarter', invert: true })}
        ${_rsrKpi('Routine', qc.rtn, qp ? qp.rtn : null, rsNum, { period: 'quarter' })}
      </div>
      ${(qc.byBranch || []).length > 1 ? `<div class="rs-subhead" style="margin-top:8px">By branch</div>${_rsrBranchCompare(qc, qp)}` : ''}`));
  }

  // 10 — Insights / closing
  const notes = _rsrInsights(cur, prev, meta);
  slides.push(_rsrSlide('Takeaways', `Highlights`, `
    <ul class="rsr-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>
    <div class="rsr-close">Meena Health · Radiology analytics — ${escapeHtml(meta.generated)}</div>`));

  return slides;
}

// ── Orchestration ─────────────────────────────────────────────────────────────
let _rsrPickY = null, _rsrPickM = null;

function rsOpenReport() {
  const t = _rsrKsaToday();
  _rsrPickY = Number(t.slice(0, 4));
  _rsrPickM = Number(t.slice(5, 7));
  _rsrRenderPicker();
  document.getElementById('rsr-pick-ov').classList.add('open');
}

function _rsrEnsurePicker() {
  if (document.getElementById('rsr-pick-ov')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="modal-overlay" id="rsr-pick-ov">
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><h3>📊 Monthly report</h3>
          <button class="modal-close" onclick="document.getElementById('rsr-pick-ov').classList.remove('open')">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--muted);margin:0 0 14px;line-height:1.5">
            A presentation-style report for the chosen month, compared to the month before.
            At the start of a quarter it also adds a quarter-over-quarter comparison.</p>
          <div class="rsr-monthpick">
            <button onclick="_rsrPickShift(-1)">‹</button>
            <div class="rsr-monthpick-lbl" id="rsr-pick-lbl"></div>
            <button onclick="_rsrPickShift(1)" id="rsr-pick-next">›</button>
          </div>
          <div id="rsr-pick-note" class="rsr-pick-note"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('rsr-pick-ov').classList.remove('open')">Cancel</button>
          <button class="btn btn-primary btn-sm" onclick="_rsrGenerate()">Generate report</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(div.firstElementChild);
}
function _rsrRenderPicker() {
  _rsrEnsurePicker();
  const lbl = document.getElementById('rsr-pick-lbl');
  if (lbl) lbl.textContent = _rsrMonthLabel(_rsrPickY, _rsrPickM);
  const t = _rsrKsaToday();
  const curY = Number(t.slice(0, 4)), curM = Number(t.slice(5, 7));
  // Don't allow picking a future month.
  const next = document.getElementById('rsr-pick-next');
  if (next) next.disabled = (_rsrPickY > curY || (_rsrPickY === curY && _rsrPickM >= curM));
  const note = document.getElementById('rsr-pick-note');
  if (note) {
    const isCurrent = (_rsrPickY === curY && _rsrPickM === curM);
    const isQ = [1, 4, 7, 10].includes(_rsrPickM);
    const bits = [];
    if (isCurrent) bits.push('“Month to date” — compared to the same day span last month.');
    if (isQ) bits.push('Quarter start → adds a quarter-over-quarter comparison.');
    note.innerHTML = bits.length ? bits.map((b) => `<div>• ${escapeHtml(b)}</div>`).join('') : '';
  }
}
function _rsrPickShift(d) {
  const t = _rsrKsaToday();
  const curY = Number(t.slice(0, 4)), curM = Number(t.slice(5, 7));
  let y = _rsrPickY, m = _rsrPickM + d;
  if (m < 1) { m = 12; y -= 1; } if (m > 12) { m = 1; y += 1; }
  if (y > curY || (y === curY && m > curM)) return;   // no future
  _rsrPickY = y; _rsrPickM = m; _rsrRenderPicker();
}

async function _rsrGenerate() {
  const y = _rsrPickY, m = _rsrPickM;
  document.getElementById('rsr-pick-ov').classList.remove('open');
  const t = _rsrKsaToday();
  const isCurrent = (y === Number(t.slice(0, 4)) && m === Number(t.slice(5, 7)));
  const todayDay = Number(t.slice(8, 10));

  // Reporting range: full month, or month-to-date if it's the current month.
  const lastDay = _rsrMonthLast(y, m);
  const curFrom = `${y}-${_rsrPad(m)}-01`;
  const curTo = isCurrent ? t : `${y}-${_rsrPad(m)}-${_rsrPad(lastDay)}`;
  // Previous month, matched to the same span for a fair comparison.
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const pLast = _rsrMonthLast(py, pm);
  const prevFrom = `${py}-${_rsrPad(pm)}-01`;
  const prevTo = isCurrent ? `${py}-${_rsrPad(pm)}-${_rsrPad(Math.min(todayDay, pLast))}` : `${py}-${_rsrPad(pm)}-${_rsrPad(pLast)}`;

  const scope = radstats.leadLocked ? (radstats.leadBranchName || 'Your branch')
    : (radstats.sel && radstats.sel.size === 1
      ? ((radstats.branches.find((b) => b.siteId === [...radstats.sel][0]) || {}).name || 'One branch')
      : 'All branches');

  _rsrShow(null);   // loading state
  const isQ = [1, 4, 7, 10].includes(m);

  try {
    const [curD, prevD] = await Promise.all([
      _rsrFetch(curFrom, curTo, true),
      _rsrFetch(prevFrom, prevTo, true).catch(() => null),
    ]);
    const cur = _rsrExtract(curD);
    if (!cur) throw new Error('No data for the selected month');
    const prev = _rsrExtract(prevD);

    let quarter = null;
    if (isQ) {
      const je = _rsrQuarterContaining(y, m - 1);        // quarter that just ended
      const be = _rsrQuarterContaining(je.y, je.sm - 1); // the one before it
      const [qc, qp] = await Promise.all([
        _rsrFetch(je.from, je.to, false).catch(() => null),
        _rsrFetch(be.from, be.to, false).catch(() => null),
      ]);
      const qcx = _rsrExtract(qc);
      if (qcx) quarter = { cur: qcx, prev: _rsrExtract(qp), curLabel: je.label, prevLabel: be.label };
    }

    const meta = {
      title: _rsrMonthLabel(y, m), prevLabel: _rsrMonthLabel(py, pm),
      scope, period: 'month', generated: _rsrKsaToday(),
      partialNote: isCurrent ? `Month to date (1–${todayDay} ${_rsrMonthLabel(y, m).split(' ')[0]}) vs the same 1–${Math.min(todayDay, pLast)} span last month.` : '',
    };
    const slides = _rsrBuildDeck({ cur, prev, quarter, meta });
    _rsrShow(slides);
  } catch (e) {
    _rsrClose();
    if (typeof toast === 'function') toast('Could not build the report: ' + (e.message || e), 'err');
  }
}

// ── Viewer overlay ────────────────────────────────────────────────────────────
function _rsrEnsureViewer() {
  if (document.getElementById('rsr-ov')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div id="rsr-ov">
      <div class="rsr-bar">
        <div class="rsr-bar-l" id="rsr-bar-title">Monthly report</div>
        <div class="rsr-bar-r">
          <span class="rsr-count" id="rsr-count"></span>
          <button class="btn btn-primary btn-sm" onclick="_rsrDownload()">⬇ Download PDF</button>
          <button class="btn btn-ghost btn-sm" onclick="_rsrClose()">✕ Close</button>
        </div>
      </div>
      <div class="rsr-stage" id="rsr-stage"></div>
      <button class="rsr-nav prev" onclick="_rsrGo(-1)" aria-label="Previous">‹</button>
      <button class="rsr-nav next" onclick="_rsrGo(1)" aria-label="Next">›</button>
      <div class="rsr-dots" id="rsr-dots"></div>
    </div>`;
  document.body.appendChild(div.firstElementChild);
  document.addEventListener('keydown', _rsrKey);
}
function _rsrKey(e) {
  if (!document.getElementById('rsr-ov') || !document.body.classList.contains('rsr-open')) return;
  if (e.key === 'ArrowRight') _rsrGo(1);
  else if (e.key === 'ArrowLeft') _rsrGo(-1);
  else if (e.key === 'Escape') _rsrClose();
}
function _rsrShow(slides) {
  _rsrEnsureViewer();
  const stage = document.getElementById('rsr-stage');
  document.body.classList.add('rsr-open');
  document.getElementById('rsr-ov').classList.add('open');
  if (!slides) {
    stage.innerHTML = `<div class="rsr-loading">
      <div class="rsr-load-logo"><img src="/meena_logo.png" alt="Meena"></div>
      <div class="ploader-dots"><i></i><i></i><i></i></div>
      <div class="rsr-load-msg">Building your report… reading this month &amp; last month from the HIS</div></div>`;
    document.getElementById('rsr-count').textContent = '';
    document.getElementById('rsr-dots').innerHTML = '';
    _rsrToggleNav(false);
    return;
  }
  RSR.slides = slides; RSR.count = slides.length; RSR.idx = 0;
  stage.innerHTML = slides.map((s, i) => `<div class="rsr-slot${i === 0 ? ' active' : ''}" data-i="${i}">${s}</div>`).join('');
  document.getElementById('rsr-dots').innerHTML = slides.map((_, i) => `<button class="rsr-dot${i === 0 ? ' on' : ''}" onclick="_rsrJump(${i})"></button>`).join('');
  _rsrToggleNav(true);
  _rsrSync();
}
function _rsrToggleNav(on) {
  document.querySelectorAll('#rsr-ov .rsr-nav').forEach((b) => b.style.display = on ? '' : 'none');
}
function _rsrSync() {
  const stage = document.getElementById('rsr-stage');
  stage.querySelectorAll('.rsr-slot').forEach((el) => el.classList.toggle('active', Number(el.getAttribute('data-i')) === RSR.idx));
  document.querySelectorAll('#rsr-dots .rsr-dot').forEach((d, i) => d.classList.toggle('on', i === RSR.idx));
  document.getElementById('rsr-count').textContent = `${RSR.idx + 1} / ${RSR.count}`;
  const stg = document.getElementById('rsr-stage'); if (stg) stg.scrollTop = 0;
}
function _rsrGo(d) { if (!RSR.count) return; RSR.idx = Math.max(0, Math.min(RSR.count - 1, RSR.idx + d)); _rsrSync(); }
function _rsrJump(i) { RSR.idx = i; _rsrSync(); }
function _rsrClose() {
  const ov = document.getElementById('rsr-ov'); if (ov) ov.classList.remove('open');
  document.body.classList.remove('rsr-open');
}
// Print/download: drop every slide into the report canvas (all visible) and print
// landscape — one slide per page.
function _rsrDownload() {
  if (!RSR.slides || !RSR.slides.length) return;
  if (typeof openReport !== 'function') { window.print(); return; }
  openReport(`<div class="rsr-print">${RSR.slides.join('')}</div>`, true);
}
