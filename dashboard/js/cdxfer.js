// ── Radiology CD transfers (admin) ────────────────────────────────────────────
// A branch uploads a full CD image (ISO/ZIP) through a token link; here an
// authorised user sees the uploads, downloads the file to import into PACS
// ("Import from CD"), and deletes it when done. Files auto-expire after the TTL.

let cdxfer = { data: null, ttl: 48, loading: false };

async function renderCdxferPage() {
  setTopbar('Radiology CD transfers', 'Receive imaging CDs from branches');
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('CD transfer', 'Radiology CD transfers', 'A branch uploads a CD image; you download it here to import into PACS')}
    <div id="cdx-link"></div>
    <div id="cdx-body">${LOADING_HTML}</div>`;
  cdxRenderLink();
  cdxLoad();
}

async function cdxRenderLink() {
  const box = document.getElementById('cdx-link');
  if (!box) return;
  let d;
  try { d = await API.get('/cdxfer/public-link'); } catch (e) { box.innerHTML = ''; return; }
  cdxfer.ttl = d.ttl_hours || 48;
  box.innerHTML = `<div class="card" style="margin-bottom:14px">
    <div class="ho-lbl" style="margin:0 0 4px">🔗 Branch upload link (no login)</div>
    <div style="font-size:12px;color:var(--muted);margin:2px 0 10px">Share privately with the branch. They open it, fill the patient's file number, and upload the CD as one ISO or ZIP (up to ${d.max_gb || 4} GB). Anyone with the link can upload, so keep it private and regenerate if it leaks. Uploaded files auto-delete after ${d.ttl_hours || 48} hours.</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input id="cdx-url" class="input" readonly value="${escapeHtml(d.url || '')}" style="flex:1;min-width:220px;font-size:12px">
      <button class="btn btn-sm btn-primary" onclick="cdxCopy()">Copy</button>
      <button class="btn btn-sm btn-ghost" onclick="cdxRegen()">Regenerate</button>
    </div></div>`;
}

async function cdxCopy() {
  const inp = document.getElementById('cdx-url'); if (!inp) return;
  try { await navigator.clipboard.writeText(inp.value); toast && toast('Link copied'); }
  catch (e) { inp.select(); try { document.execCommand('copy'); toast && toast('Link copied'); } catch (_) {} }
}
async function cdxRegen() {
  if (!confirm('Regenerate the branch upload link? The old link stops working immediately.')) return;
  try { await API.post('/cdxfer/public-link/regenerate'); toast && toast('New link generated'); cdxRenderLink(); }
  catch (e) { toast && toast(e.message || 'Failed', 'err'); }
}

async function cdxLoad() {
  cdxfer.loading = true;
  try {
    const d = await API.get('/cdxfer/list');
    cdxfer.data = d.transfers || [];
    if (d.ttl_hours) cdxfer.ttl = d.ttl_hours;
  } catch (e) {
    const b = document.getElementById('cdx-body');
    if (b) b.innerHTML = `<div class="card"><div class="empty" style="padding:24px 16px"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message || 'Could not load transfers')}</p><button class="btn btn-sm" style="margin-top:10px" onclick="cdxLoad()">Retry</button></div></div>`;
    return;
  } finally { cdxfer.loading = false; }
  cdxRenderBody();
}

function cdxSize(n) {
  n = Number(n || 0);
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function cdxWhen(iso) {
  if (!iso) return '—';
  const t = new Date((iso.includes('T') ? iso : iso.replace(' ', 'T')) + 'Z');
  if (isNaN(t)) return escapeHtml(iso);
  try { return t.toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); }
  catch (e) { return escapeHtml(iso); }
}
const CDX_STATUS = {
  uploading: ['badge-orange', '⏳ uploading'], ready: ['badge-green', '✅ ready'],
  downloaded: ['badge-purple', '⬇️ downloaded'], deleted: ['badge-red', '🗑️ deleted'],
  expired: ['badge-red', '⌛ expired'], failed: ['badge-red', '⚠️ failed'],
};

function cdxRenderBody() {
  const b = document.getElementById('cdx-body');
  if (!b) return;
  const rows = cdxfer.data || [];
  if (!rows.length) {
    b.innerHTML = `<div class="card"><div class="empty" style="padding:30px 16px"><div class="empty-icon">📀</div>
      <p>No CD uploads yet.</p><small>Share the branch link above; uploads appear here.</small></div></div>`;
    return;
  }
  b.innerHTML = rows.map(r => {
    const [cls, label] = CDX_STATUS[r.status] || ['badge', escapeHtml(r.status || '')];
    const canGet = r.status === 'ready' || r.status === 'downloaded';
    const canDel = !['deleted', 'expired'].includes(r.status);
    return `<div class="card" style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <div style="min-width:0">
          <div style="font-weight:800;font-size:15px">File ${escapeHtml(r.file_no || '—')}
            <span class="badge ${cls}" style="margin-left:6px">${label}</span>
            <span class="badge" style="margin-left:4px">${escapeHtml((r.kind || '').toUpperCase())}</span></div>
          <div style="font-size:12px;color:var(--muted);margin-top:3px">
            ${escapeHtml(r.ref || '')} · ${escapeHtml(r.branch || '—')}${r.exam_type ? ' · ' + escapeHtml(r.exam_type) : ''}${r.exam_date ? ' · ' + escapeHtml(r.exam_date) : ''}${r.patient_initials ? ' · ' + escapeHtml(r.patient_initials) : ''}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">
            ${cdxSize(r.size_bytes)} · by ${escapeHtml(r.uploader || '—')} · uploaded ${cdxWhen(r.uploaded_at || r.created_at)}${r.downloaded_at ? ' · downloaded ' + cdxWhen(r.downloaded_at) : ''}</div>
          ${r.dicom_check ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">🔬 ${escapeHtml(r.dicom_check)}</div>` : ''}
          ${r.note ? `<div style="font-size:12px;margin-top:3px">📝 ${escapeHtml(r.note)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${canGet ? `<button class="btn btn-sm btn-primary" onclick="cdxDownload('${escapeHtml(r.ref)}')">⬇️ Download</button>` : ''}
          ${canDel ? `<button class="btn btn-sm btn-ghost" onclick="cdxDelete('${escapeHtml(r.ref)}')">Delete</button>` : ''}
        </div>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:6px">expires ${cdxWhen(r.expires_at)}${r.upload_ip ? ' · from ' + escapeHtml(r.upload_ip) : ''}</div>
    </div>`;
  }).join('') + `<div style="text-align:center;margin-top:6px"><button class="btn btn-sm btn-ghost" onclick="cdxLoad()">↻ Refresh</button></div>`;
}

function cdxDownload(ref) {
  // Direct browser download (carries the auth cookie); FileResponse sends it as an
  // attachment, so the page doesn't navigate away. Refresh the list shortly after
  // so the "downloaded" status shows.
  const a = document.createElement('a');
  a.href = '/api/cdxfer/' + encodeURIComponent(ref) + '/download';
  a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(cdxLoad, 4000);
}
async function cdxDelete(ref) {
  if (!confirm('Delete this uploaded CD file now? This cannot be undone.')) return;
  try { await API.delete('/cdxfer/' + encodeURIComponent(ref)); toast && toast('File deleted'); cdxLoad(); }
  catch (e) { toast && toast(e.message || 'Delete failed', 'err'); }
}
