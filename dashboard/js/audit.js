// ── Audit Log page ────────────────────────────────────────────────────────────
async function renderAuditPage() {
  setTopbar('Audit Log', 'System activity history');
  // Paint the shell + inline loader INSTANTLY so the page switches on click, then
  // fill the table when the data lands (was: blank/global spinner until the fetch
  // returned, which felt like the button did nothing).
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="cc">
    ${pageHero('System activity history', 'Audit Log', 'recent events')}
    <div id="audit-body">${LOADING_HTML}</div>
    </div>`;
  const body = document.getElementById('audit-body');
  try {
    const logs = await API.get('/audit');
    if (currentPage !== 'audit' || !document.getElementById('audit-body')) return;   // navigated away
    body.innerHTML = `
      <div class="board">
        <div class="bhead"><div class="bhrow">
          <div class="btitle">Activity <span>${logs.length} event${logs.length !== 1 ? 's' : ''}</span></div>
        </div></div>
        <div class="rows">${logs.length ? logs.map(l => `
          <div class="lrow" style="display:flex;align-items:flex-start;gap:12px;padding:10px 18px;flex-wrap:wrap">
            <div style="font-size:11px;color:var(--muted);width:118px;flex-shrink:0;font-variant-numeric:tabular-nums">${l.created_at ? new Date(l.created_at).toLocaleString('en-GB') : '—'}</div>
            <div style="flex:1;min-width:200px">
              <div><strong>${escapeHtml(l.username || '—')}</strong>
                <span style="font-size:11.5px;color:var(--muted)"> · ${escapeHtml(l.role || '—')}${l.branch ? ' · ' + escapeHtml(l.branch) : ''}</span></div>
              <div style="font-size:12px;margin-top:2px">${escapeHtml(l.target || '—')}
                ${l.detail ? `<span style="color:var(--muted)"> — ${escapeHtml(l.detail)}</span>` : ''}</div>
            </div>
            <span class="sc" style="flex-shrink:0">${escapeHtml(l.action || '')}</span>
          </div>`).join('') : `<div class="lrow" style="text-align:center;padding:24px;color:var(--muted)">No activity yet</div>`}
        </div>
      </div>`;
  } catch (err) {
    if (body) body.innerHTML = `<div class="empty"><p>${escapeHtml(err.message)}</p></div>`;
  }
}
