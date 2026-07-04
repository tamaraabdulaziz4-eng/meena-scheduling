// ── Audit Log page ────────────────────────────────────────────────────────────
async function renderAuditPage() {
  setTopbar('Audit Log', 'System activity history');
  // Paint the shell + inline loader INSTANTLY so the page switches on click, then
  // fill the table when the data lands (was: blank/global spinner until the fetch
  // returned, which felt like the button did nothing).
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('System activity history', 'Audit Log', 'recent events')}
    <div id="audit-body">${LOADING_HTML}</div>`;
  const body = document.getElementById('audit-body');
  try {
    const logs = await API.get('/audit');
    if (currentPage !== 'audit' || !document.getElementById('audit-body')) return;   // navigated away
    body.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>User</th><th>Role</th><th>Branch</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
          <tbody>${logs.length ? logs.map(l => `<tr>
            <td style="font-size:11px;color:var(--muted)">${l.created_at ? new Date(l.created_at).toLocaleString('en-GB') : '—'}</td>
            <td><strong>${escapeHtml(l.username || '—')}</strong></td>
            <td>${escapeHtml(l.role || '—')}</td>
            <td>${escapeHtml(l.branch || '—')}</td>
            <td><span class="badge badge-purple" style="font-size:9px">${escapeHtml(l.action || '')}</span></td>
            <td>${escapeHtml(l.target || '—')}</td>
            <td style="font-size:11px;color:var(--muted)">${escapeHtml(l.detail || '—')}</td>
          </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted)">No activity yet</td></tr>`}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    if (body) body.innerHTML = `<div class="empty"><p>${escapeHtml(err.message)}</p></div>`;
  }
}
