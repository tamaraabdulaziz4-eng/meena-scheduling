// ── Audit Log page ────────────────────────────────────────────────────────────
async function renderAuditPage() {
  setTopbar('Audit Log', 'System activity history');
  showLoader('Loading audit log…');
  try {
    const logs = await API.get('/audit');
    const c = document.getElementById('content');
    c.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>User</th><th>Role</th><th>Branch</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
          <tbody>${logs.length ? logs.map(l => `<tr>
            <td style="font-size:11px;color:var(--muted)">${l.created_at ? new Date(l.created_at).toLocaleString() : '—'}</td>
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
    document.getElementById('content').innerHTML = `<div class="empty"><p>${err.message}</p></div>`;
  } finally { hideLoader(); }
}
