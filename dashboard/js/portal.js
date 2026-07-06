// ── Staff self-service portal ─────────────────────────────────────────────────
// A 'staff' user sees only their own monthly rota (read-only) and can request
// leave. Reuses the shared shift-type styling and leave modal.
let myScheduleData = null;
let portalYear  = new Date().getFullYear();
let portalMonth = new Date().getMonth() + 1;

async function renderMySchedulePage() {
  setTopbar('My Schedule', '', `<button class="btn btn-sm" onclick="openLeaveModal()">Request Leave</button>`);
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="cc">
    ${pageHero(`Welcome, ${currentUser?.username || ''}`, 'My Schedule', 'Your shifts, leave and swaps')}
    <div class="month-nav" style="margin-bottom:14px">
      <button onclick="changePortalMonth(-1)">&#8249;</button>
      <span class="month-label" id="portal-month-label">${monthLabel(portalYear, portalMonth)}</span>
      <button onclick="changePortalMonth(1)">&#8250;</button>
    </div>
    <div id="portal-banner"></div>
    <div id="ms-shiftcheck"></div>
    <div id="ms-eotm"></div>
    <div id="portal-grid">${LOADING_HTML}</div>
    <div id="portal-legend" style="margin-top:16px"></div>
    <div id="ms-prefs" style="margin-top:20px"></div>
    <div id="ms-docs" style="margin-top:20px"></div>
    <div id="portal-requests" style="margin-top:20px"></div>
    </div>`;
  await loadMySchedule();
  loadMyRequests();   // "everything that's mine" — open requests + their stage
  if (typeof renderHomeEotm === 'function') renderHomeEotm('ms-eotm');   // celebrate EOTM for staff too
  renderMyShiftChecks();   // equipment-check confirmation for the shift they're on
  renderMyPreferences();   // day-off / unavailable wishes for the rota generator
  renderMyDocuments();     // employee-file documents — fill dates + print the file
}

// ── My documents (employee file) ──────────────────────────────────────────────
let _myDocs = {};   // kind → saved record

async function renderMyDocuments() {
  const box = document.getElementById('ms-docs');
  if (!box) return;
  let docs = [];
  try { docs = await API.get('/my-credentials'); } catch (e) { box.innerHTML = ''; return; }
  _myDocs = {};
  (docs || []).forEach(d => { if (!_myDocs[d.kind]) _myDocs[d.kind] = d; });

  const rows = DOC_TYPES.map(def => {
    const rec = _myDocs[def.kind] || {};
    const st  = docStatus(def, _myDocs[def.kind]);
    return `<div class="doc-row" style="display:grid;grid-template-columns:1.4fr 1fr auto;gap:10px;align-items:end;padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:600;font-size:13px">${escapeHtml(def.en)}
          <span class="sc" style="color:${st.color};border:1px solid ${st.color}55;background:${st.color}14;margin-inline-start:6px">${st.label}</span></div>
        <div style="font-size:11px;color:var(--muted)">${escapeHtml(def.ar)}</div>
        <input class="input" id="doc-num-${def.kind}" placeholder="Number (optional)" value="${escapeHtml(rec.number || '')}" style="margin-top:6px;width:100%;font-size:12px">
      </div>
      <div style="display:flex;gap:8px">
        <label style="flex:1;font-size:10px;color:var(--muted)">Issue
          <input type="date" class="input" id="doc-iss-${def.kind}" value="${rec.issue_date || ''}" style="width:100%;font-size:12px"></label>
        ${def.exp ? `<label style="flex:1;font-size:10px;color:var(--muted)">Expiry
          <input type="date" class="input" id="doc-exp-${def.kind}" value="${rec.expiry_date || ''}" style="width:100%;font-size:12px"></label>` : ''}
      </div>
      <button class="btn btn-sm" onclick="saveMyDoc('${def.kind}',${def.exp})">Save</button>
    </div>`;
  }).join('');

  box.innerHTML = `<div class="hm-card">
    <div class="hm-card-head" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div class="hm-card-title">My documents (employee file)</div>
      <button class="btn btn-sm btn-primary" onclick="printMyFile()">🖨️ Print my file</button>
    </div>
    <div class="hm-muted" style="font-size:12px;margin:4px 0 8px">Fill in your document dates (license, BLS, ID…). You'll be reminded before anything expires.</div>
    ${rows}</div>`;
}

async function saveMyDoc(kind, expires) {
  const num = (document.getElementById('doc-num-' + kind)?.value || '').trim();
  const iss = document.getElementById('doc-iss-' + kind)?.value || '';
  const exp = expires ? (document.getElementById('doc-exp-' + kind)?.value || '') : '';
  if (expires && !exp) { toast('Add the expiry date', 'err'); return; }
  try {
    await API.put('/my-credentials', { kind, number: num, issue_date: iss, expiry_date: exp });
    toast('Saved');
    renderMyDocuments();
  } catch (e) { toast(e.message || 'Could not save', 'err'); }
}

function printMyFile() {
  const s = (myScheduleData && myScheduleData.staff) || { name: currentUser?.username };
  printEmployeeFile(s, Object.values(_myDocs));
}

// ── My preferences (prefer-off / unavailable days before the rota is built) ───
let _myPrefs = {};   // day(int) → 'off' | 'unavailable'

async function renderMyPreferences() {
  const box = document.getElementById('ms-prefs');
  if (!box) return;
  let data;
  try { data = await API.get(`/preferences?year=${portalYear}&month=${portalMonth}`); }
  catch (e) { box.innerHTML = ''; return; }
  _myPrefs = {};
  (data.preferences || []).forEach(p => { _myPrefs[p.day] = p.kind; });
  const nDays = daysInMonth(portalYear, portalMonth);
  let cells = '';
  for (let day = 1; day <= nDays; day++) {
    const dow = dayOfWeek(portalYear, portalMonth, day);
    const k = _myPrefs[day];
    const bg = k === 'unavailable' ? '#E2555522' : k === 'off' ? '#E2933F22' : 'var(--card-alt)';
    const bd = k === 'unavailable' ? '#E25555' : k === 'off' ? '#E2933F' : 'var(--border)';
    cells += `<button class="pref-day" onclick="cyclePreference(${day})" title="Tap to change"
        style="background:${bg};border:1px solid ${bd};border-radius:8px;padding:6px 0;cursor:pointer;text-align:center;min-width:0">
        <div style="font-size:13px;font-weight:700">${day}</div>
        <div style="font-size:9px;color:var(--muted)">${DAYS[dow]}</div></button>`;
  }
  box.innerHTML = `<div class="hm-card">
    <div class="hm-card-head"><div class="hm-card-title">My day preferences — ${monthLabel(portalYear, portalMonth)}</div></div>
    <div class="hm-muted" style="font-size:12px;margin:4px 0 10px">Tap a day to cycle: normal → prefer off → can't work. Your team lead sees these before building the rota. Preferred-off is a wish; can't-work is kept off.</div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px">${cells}</div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:12px">
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#E2933F22;border:1px solid #E2933F;vertical-align:middle"></span> Prefer off</span>
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#E2555522;border:1px solid #E25555;vertical-align:middle"></span> Can't work</span>
    </div></div>`;
}

async function cyclePreference(day) {
  const order = { '': 'off', 'off': 'unavailable', 'unavailable': 'none' };
  const next = order[_myPrefs[day] || ''] || 'off';
  try {
    await API.put('/preferences', { year: portalYear, month: portalMonth, day, kind: next });
    if (next === 'none') delete _myPrefs[day]; else _myPrefs[day] = next;
    renderMyPreferences();
  } catch (e) { toast(e.message || 'Could not save', 'err'); }
}

// ── Per-shift equipment check (تشييك الأجهزة) ────────────────────────────────
async function renderMyShiftChecks() {
  const box = document.getElementById('ms-shiftcheck');
  if (!box) return;
  let data;
  try { data = await API.get('/shift-checks/mine'); } catch (e) { box.innerHTML = ''; return; }
  const checks = (data && data.checks) || [];
  if (!checks.length) { box.innerHTML = ''; return; }
  box.innerHTML = checks.map(c => {
    if (c.done) {
      return `<div class="hm-card" style="border-left:4px solid #2BAE66">
        <b>${c.label} equipment check — done</b>
        <div class="hm-muted" style="font-size:12px;margin-top:2px">${c.confirmed_by_name ? 'By ' + escapeHtml(c.confirmed_by_name) : ''}${c.confirmed_at ? ' · ' + new Date(c.confirmed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</div>
      </div>`;
    }
    return `<div class="hm-card" style="border-left:4px solid #FF9F43;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <b>${c.label} equipment check</b>
        <div class="hm-muted" style="font-size:12px;margin-top:2px">Confirm the device check for your shift.</div>
      </div>
      <button class="btn btn-sm" onclick="confirmMyShiftCheck('${c.shift}','${c.date}',${c.branch_id})">Confirm done</button>
    </div>`;
  }).join('');
}

async function confirmMyShiftCheck(shift, date, branchId) {
  try {
    await API.post('/shift-checks', { shift, date, branch_id: branchId });
    toast('Equipment check confirmed');
    renderMyShiftChecks();
  } catch (e) { toast(e.message, 'err'); }
}

// A consolidated "My requests" card so a staff member tracks every open request
// (leave, swap, time-back) and its stage — incl. the reason if it was rejected —
// without hunting across pages.
async function loadMyRequests() {
  const box = document.getElementById('portal-requests');
  if (!box) return;
  let leaves = [], swaps = [], tbs = [];
  try {
    [leaves, swaps, tbs] = await Promise.all([
      API.get('/leaves').catch(() => []),
      API.get('/swaps').catch(() => []),
      API.get('/timeback').catch(() => []),
    ]);
  } catch (e) { return; }

  // Stage → Clinical Calm pill (matches the Leaves/Swaps pages): awaiting team
  // lead → progress, awaiting manager → prelim, approved → final, rejected → red chip.
  const LBL = {
    pending: ['Awaiting team lead', 'progress'], lead_approved: ['Awaiting manager', 'prelim'],
    pending_lead: ['Awaiting team lead', 'progress'], pending_manager: ['Awaiting manager', 'prelim'],
    approved: ['Approved', 'final'], rejected: ['Rejected', 'rejected'],
  };
  const swapLbl = Object.assign({}, LBL, { pending: ['Awaiting peer', 'scheduled'] });
  const rows = [];

  // Leaves — grouped into ranges; show anything not yet fully approved (or rejected).
  const groups = (typeof groupLeaveRanges === 'function') ? groupLeaveRanges(leaves || []) : (leaves || []);
  groups.forEach(g => {
    if (g.status === 'approved') return;
    const span = g.date_to && g.date_to !== g.date_from ? `${fmtDateDisplay(g.date_from)} → ${fmtDateDisplay(g.date_to)}` : fmtDateDisplay(g.date_from || g.date);
    rows.push({ kind: g.leave_type || 'Leave', what: span, status: g.status, lbl: LBL[g.status], note: g.status === 'rejected' ? g.note : '' });
  });
  // Swaps I'm part of that aren't finished.
  (swaps || []).forEach(s => {
    if (['approved', 'cancelled'].includes(s.status)) return;
    const who = s.staff_b_name ? ` with ${s.staff_b_name}` : '';
    rows.push({ kind: 'Swap', what: `${fmtDateDisplay(s.date_a)}${who}`, status: s.status, lbl: swapLbl[s.status] || ['Pending', 'badge-orange'], note: s.status === 'rejected' ? (s.reject_note || s.note) : '' });
  });
  // Time-back claims still in flight.
  (tbs || []).forEach(t => {
    if (t.status === 'approved') return;
    rows.push({ kind: 'Time-back', what: `${t.days} day${t.days > 1 ? 's' : ''} · ${fmtDateDisplay(t.date)}`, status: t.status, lbl: LBL[t.status], note: t.status === 'rejected' ? t.note : '' });
  });

  if (!rows.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="hm-card">
      <div class="hm-card-head"><div class="hm-card-title">My open requests</div>
        <div class="hm-card-meta">${rows.length} open</div></div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
        ${rows.map(r => {
          const [txt, cls] = r.lbl || ['Pending', 'scheduled'];
          const pill = cls === 'rejected'
            ? `<span class="sc no">✕ ${escapeHtml(txt)}</span>`
            : `<span class="ris ${cls}"><span class="rd"></span>${escapeHtml(txt)}</span>`;
          return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:10px">
            <div><div style="font-weight:600;font-size:13px">${escapeHtml(r.kind)} · ${escapeHtml(r.what)}</div>
              ${r.note ? `<div style="font-size:11px;color:#E63946">Reason: ${escapeHtml(r.note)}</div>` : ''}</div>
            ${pill}
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

async function changePortalMonth(delta) {
  portalMonth += delta;
  if (portalMonth > 12) { portalMonth = 1; portalYear++; }
  if (portalMonth < 1)  { portalMonth = 12; portalYear--; }
  document.getElementById('portal-month-label').textContent = monthLabel(portalYear, portalMonth);
  const grid = document.getElementById('portal-grid');
  if (grid) grid.innerHTML = LOADING_HTML;
  await loadMySchedule();
  animateIn('portal-grid');
  renderMyPreferences();
}

async function loadMySchedule() {
  try {
    // Shift types power the colours/labels; load once.
    if (!allShiftTypes || !allShiftTypes.length) {
      try { allShiftTypes = await API.get('/shift-types'); } catch (e) { allShiftTypes = []; }
    }
    myScheduleData = await API.get(`/my-schedule?year=${portalYear}&month=${portalMonth}`);
    renderPortalGrid();
  } catch (e) {
    document.getElementById('portal-grid').innerHTML =
      `<div class="empty"><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderPortalGrid() {
  const d = myScheduleData;
  const banner = document.getElementById('portal-banner');
  const grid   = document.getElementById('portal-grid');
  if (!d) return;

  // Status banner
  if (!d.status) {
    banner.innerHTML = `<div class="tl-status-banner"><div class="ico"></div><div style="flex:1"><div class="ttl">No schedule yet</div><div class="sub">Your team lead hasn't created this month's rota.</div></div></div>`;
  } else if (!d.finalised) {
    banner.innerHTML = `<div class="tl-status-banner warn"><div class="ico" style="background:rgba(255,159,67,.15)"></div><div style="flex:1"><div class="ttl">Draft — not final</div><div class="sub">This rota is still being prepared and may change.</div></div></div>`;
  } else if (d.status === 'approved') {
    banner.innerHTML = `<div class="tl-status-banner ok"><div class="ico" style="background:rgba(0,200,150,.15)"></div><div style="flex:1"><div class="ttl" style="color:#009B74">Approved</div><div class="sub">This rota has been approved by your manager.</div></div></div>`;
  } else {
    banner.innerHTML = `<div class="tl-status-banner"><div class="ico"></div><div style="flex:1"><div class="ttl">Under review</div><div class="sub">Submitted to the manager — may still change.</div></div></div>`;
  }

  // Leave balance + next-leave countdown, above the status banner — Clinical
  // Calm KPI tiles.
  const bal = (d.leave_balance ?? null);
  const up = d.upcoming_leave;
  if (bal !== null || up) {
    let tiles = '';
    if (bal !== null) tiles += `<div class="kpi c"><div class="kl"><span class="kd" style="background:var(--green,#00C896)"></span>Leave balance</div><div class="kv">${bal}</div><div class="kt">days left</div></div>`;
    if (up) {
      const dd = up.days_until;
      tiles += `<div class="kpi d"><div class="kl"><span class="kd" style="background:var(--accent,#6B4EFF)"></span>Next leave</div><div class="kv">${dd === 0 ? 'Today' : dd}</div><div class="kt">${dd === 0 ? 'your leave starts today' : 'days until your leave'} · ${fmtDateDisplay(up.date)}</div></div>`;
    }
    banner.innerHTML = `<div class="kpis" style="margin-bottom:12px">${tiles}</div>` + banner.innerHTML;
  }

  const nDays = daysInMonth(portalYear, portalMonth);
  const byDate = {};
  (d.entries || []).forEach(e => { byDate[e.date] = e; });
  // Cross-branch cover days take precedence — that's where they actually work.
  (d.cover || []).forEach(c => {
    byDate[c.date] = { date: c.date, shift_code: c.shift_code, is_oncall: c.is_oncall,
                       cross_branch_name: c.cover_at_branch };
  });

  let cells = '';
  for (let day = 1; day <= nDays; day++) {
    const dateStr = `${portalYear}-${String(portalMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dow = dayOfWeek(portalYear, portalMonth, day);
    const e   = byDate[dateStr];
    const code = e?.shift_code || '';
    const st   = code ? allShiftTypes.find(x => x.code === code) : null;
    const bg   = (!code || code === 'O') ? 'var(--card-alt)' : (st?.color || '#888');
    const txt  = (!code || code === 'O') ? 'var(--muted)' : contrastColor(st?.color || '#888');
    const hij  = (typeof hijriShort === 'function') ? hijriShort(portalYear, portalMonth, day) : '';
    const timeStr = (st && st.start_time && st.end_time) ? `${fmt12(st.start_time)}–${fmt12(st.end_time)}` : '';
    cells += `
      <div class="portal-day" style="border-color:${dow===5?'var(--accent)':'var(--border)'}">
        <div class="pd-top"><span class="pd-num">${day}</span><span class="pd-dow">${DAYS[dow]}</span></div>
        ${hij ? `<div class="pd-hijri">${hij}</div>` : ''}
        <div class="pd-shift" style="background:${bg};color:${txt}">
          ${code && code !== 'O' ? code : '—'}${e?.is_oncall ? ' <sup>OC</sup>' : ''}
        </div>
        ${timeStr ? `<div class="pd-time">${timeStr}</div>` : ''}
        ${e?.cross_branch_name ? `<div class="pd-time" style="color:var(--accent)">↗ ${escapeHtml(e.cross_branch_name)}</div>` : ''}
      </div>`;
  }

  // Count working shifts (including cross-branch cover days)
  const worked = Object.values(byDate).filter(e => !['O','AL','SL','TB','OC',''].includes(e.shift_code) && !e.is_oncall).length;
  grid.innerHTML = `
    <div style="font-size:13px;color:var(--muted);margin-bottom:10px">
      <strong>${escapeHtml(d.staff?.name || '')}</strong> · ${escapeHtml(d.staff?.branch_name || '')}
      · <strong>${worked}</strong> shift${worked!==1?'s':''} this month
    </div>
    <div class="portal-grid-wrap">${cells}</div>`;

  // Legend
  renderPortalLegend();
}

function renderPortalLegend() {
  const leg = document.getElementById('portal-legend');
  if (!leg) return;
  const shifts = (allShiftTypes || []).filter(st => st.code !== 'O');
  leg.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap">` +
    shifts.map(st => `<span class="sc" style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;color:${st.color};background:${st.color}18;border:1px solid ${st.color}40">
      <b>${st.code}</b> ${escapeHtml(st.label || '')}</span>`).join('') + `</div>`;
}
