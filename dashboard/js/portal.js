// ── Staff self-service portal ─────────────────────────────────────────────────
// A 'staff' user sees only their own monthly rota (read-only) and can request
// leave. Reuses the shared shift-type styling and leave modal.
let myScheduleData = null;
let portalYear  = new Date().getFullYear();
let portalMonth = new Date().getMonth() + 1;

async function renderMySchedulePage() {
  setTopbar('My Schedule', '', `<button class="btn btn-sm" onclick="openLeaveModal()">🌴 Request Leave</button>`);
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="month-nav" style="margin-bottom:14px">
      <button onclick="changePortalMonth(-1)">&#8249;</button>
      <span class="month-label" id="portal-month-label">${monthLabel(portalYear, portalMonth)}</span>
      <button onclick="changePortalMonth(1)">&#8250;</button>
    </div>
    <div id="portal-banner"></div>
    <div id="portal-grid"><div class="empty"><div class="empty-icon">⏳</div><p>Loading…</p></div></div>
    <div id="portal-legend" style="margin-top:16px"></div>`;
  await loadMySchedule();
}

async function changePortalMonth(delta) {
  portalMonth += delta;
  if (portalMonth > 12) { portalMonth = 1; portalYear++; }
  if (portalMonth < 1)  { portalMonth = 12; portalYear--; }
  document.getElementById('portal-month-label').textContent = monthLabel(portalYear, portalMonth);
  await loadMySchedule();
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
      `<div class="empty"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderPortalGrid() {
  const d = myScheduleData;
  const banner = document.getElementById('portal-banner');
  const grid   = document.getElementById('portal-grid');
  if (!d) return;

  // Status banner
  if (!d.status) {
    banner.innerHTML = `<div class="tl-status-banner"><div class="ico">📭</div><div style="flex:1"><div class="ttl">No schedule yet</div><div class="sub">Your team lead hasn't created this month's rota.</div></div></div>`;
  } else if (!d.finalised) {
    banner.innerHTML = `<div class="tl-status-banner warn"><div class="ico" style="background:rgba(255,159,67,.15)">✏️</div><div style="flex:1"><div class="ttl">Draft — not final</div><div class="sub">This rota is still being prepared and may change.</div></div></div>`;
  } else if (d.status === 'approved') {
    banner.innerHTML = `<div class="tl-status-banner ok"><div class="ico" style="background:rgba(0,200,150,.15)">✓</div><div style="flex:1"><div class="ttl" style="color:#009B74">Approved</div><div class="sub">This rota has been approved by your manager.</div></div></div>`;
  } else {
    banner.innerHTML = `<div class="tl-status-banner"><div class="ico">👀</div><div style="flex:1"><div class="ttl">Under review</div><div class="sub">Submitted to the manager — may still change.</div></div></div>`;
  }

  const nDays = daysInMonth(portalYear, portalMonth);
  const byDate = {};
  (d.entries || []).forEach(e => { byDate[e.date] = e; });

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
      <div class="portal-day" style="border-color:${dow===5||dow===6?'var(--accent)':'var(--border)'}">
        <div class="pd-top"><span class="pd-num">${day}</span><span class="pd-dow">${DAYS[dow]}</span></div>
        ${hij ? `<div class="pd-hijri">${hij}</div>` : ''}
        <div class="pd-shift" style="background:${bg};color:${txt}">
          ${code && code !== 'O' ? code : '—'}${e?.is_oncall ? ' <sup>OC</sup>' : ''}
        </div>
        ${timeStr ? `<div class="pd-time">${timeStr}</div>` : ''}
        ${e?.cross_branch_name ? `<div class="pd-time" style="color:var(--accent)">↗ ${escapeHtml(e.cross_branch_name)}</div>` : ''}
      </div>`;
  }

  // Count working shifts
  const worked = (d.entries || []).filter(e => !['O','AL','SL','TB','OC'].includes(e.shift_code) && !e.is_oncall).length;
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
  leg.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap">` +
    shifts.map(st => `<span class="badge" style="background:${st.color}22;color:${st.color};border:1px solid ${st.color}55">
      <b>${st.code}</b> ${escapeHtml(st.label || '')}</span>`).join('') + `</div>`;
}
