// ── HIS User Access (Siratech privileges viewer + grant UI) ───────────────────
// Superadmin-only. Enter a Siratech HIS user id → see their branches and ALL privileges
// (granted vs not), search across the full ~3,269-privilege catalogue, select privileges,
// and grant. NOTE: Siratech exposes NO privilege-write API, so the Grant action needs the
// real Save request captured from Siratech's admin before it can push changes.

// A curated shortlist of the radiology-relevant privileges (for the quick summary at top).
const HIS_RAD_KEYS = [
  'EMR_ACCESS','EMR_CPOE_VIEW','EMR_MNU_EMR_ORDERS',
  'RADIOLOGY_STUDY_VIEW','RADIOLOGY_STUDY_EDIT','RADIOLOGY_REPORT_VIEW','RADIOLOGY_REPORT_ADD',
  'RADIOLOGY_REPORT_EDIT','RADIOLOGY_REPORT_AUTHORISE','RADIOLOGY_REPORT_UNLOCK','RADIOLOGY_REPORT_PRINT',
  'RADIOLOGY_REPORT_DELETE','RADIOLOGY_MODALITY_VIEW','RADIOLOGY_MODALITY_ADD','RADIOLOGY_MODALITY_EDIT',
  'RADIOLOGY_MODALITY_DELETE','RADIOLOGY_TEMPLATE_VIEW','RADIOLOGY_TEMPLATE_ADD','RADIOLOGY_TEMPLATE_EDIT',
  'RADIOLOGY_TEMPLATE_DELETE','RESULT_ENTRY','RESULT_FIRST_LEVEL_AUTHORIZE','RESULT_FIRST_LEVEL_UNAUTHORIZE',
  'RESULT_SECOND_LEVEL_AUTHORIZE','RESULT_SECOND_LEVEL_UNAUTHORIZE','RESULT_PRINT','RESULT_DRAFT_PRINT',
  'RESULT_FAX_SEND','RIS_CANCELLATION','SCANNED_DOCUMENTS','SCANNED_DOCUMENT_PRINT','SCANNED_DOCUMENT_MOVE',
  'SCANNED_DOCUMENT_DELETE','MACHINE_MASTER',
];

let _hisCatalog = null;        // master list of ALL privilege keys (from admin user 1)
let _hisData = null;           // the currently looked-up user's response
let _hisGranted = new Set();   // that user's currently-held privilege keys
let _hisSelect = new Set();    // privileges the operator has ticked to grant
let _hisFilter = '';

function renderHisAccessPage() {
  setTopbar('HIS User Access', 'Audit & assign a Siratech user’s branches and privileges');
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="cc">
      ${pageHero('Siratech privileges', 'HIS User Access')}
      <div class="board" style="margin-bottom:14px">
        <div class="bhead"><div class="bhrow"><div class="btitle">Look up a HIS user</div></div></div>
        <div style="padding:16px 18px">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <input id="his-uid" class="input" placeholder="HIS user id · e.g. 102240" style="flex:1;min-width:200px"
                   onkeydown="if(event.key==='Enter')hisAccessLookup()">
            <button class="open pri" style="width:auto" onclick="hisAccessLookup()">Look up</button>
          </div>
        </div>
      </div>
      <div id="his-access-result"></div>
    </div>`;
}

async function hisAccessLookup() {
  const uid = (document.getElementById('his-uid')?.value || '').trim();
  const box = document.getElementById('his-access-result');
  if (!uid) { if (box) box.innerHTML = ''; return; }
  _hisSelect = new Set();
  if (box) box.innerHTML = `<div class="board"><div style="padding:22px 18px;color:var(--muted)">Reading privileges from Siratech…</div></div>`;
  try {
    // The master catalogue = every privilege that exists. Admin user "1" holds all of them.
    if (!_hisCatalog) {
      const master = await API.get(`/radiology/his-user/1/privileges`);
      _hisCatalog = (master.privilegesByUser && master.privilegesByUser.names || []).slice().sort();
    }
    _hisData = await API.get(`/radiology/his-user/${encodeURIComponent(uid)}/privileges`);
    _hisGranted = new Set(_hisData.privilegesByUser && _hisData.privilegesByUser.names || []);
  } catch (e) {
    if (box) box.innerHTML = `<div class="board"><div style="padding:22px 18px;color:var(--danger-ink)">Could not read this user: ${escapeHtml(e.message || 'error')}</div></div>`;
    return;
  }
  hisAccessRender();
}

// Group a list of privilege keys by their leading token (module prefix).
function hisGroupByPrefix(keys) {
  const g = {};
  for (const k of keys) { const p = String(k).split('_')[0] || '?'; (g[p] = g[p] || []).push(k); }
  return Object.entries(g).sort((a, b) => b[1].length - a[1].length);
}

function hisAccessRender() {
  const box = document.getElementById('his-access-result');
  if (!box || !_hisData) return;
  const d = _hisData;
  const total = (d.privilegesByUser && d.privilegesByUser.count) || _hisGranted.size;
  const sites = d.sites || [];
  const granted = new Set((d.grantedSites || []).filter((id) => Number(id) > 0));
  const missing = sites.filter((s) => !granted.has(Number(s.id)));
  const catalog = _hisCatalog || [];

  const siteChips = (sites.length ? sites : (d.grantedSites || []).filter((x) => x > 0).map((id) => ({ id, name: 'Site ' + id })))
    .map((s) => { const on = granted.has(Number(s.id)); return `<span class="sc ${on ? 'ok' : 'no'}" style="margin:0">${on ? '✓' : '✕'} ${escapeHtml(s.name)}</span>`; }).join('');

  const radHave = HIS_RAD_KEYS.filter((k) => _hisGranted.has(k)).length;
  const groups = d.groups || [];

  box.innerHTML = `
    <div class="board" style="margin-bottom:14px">
      <div style="padding:16px 18px">
        <div style="font-size:16px;font-weight:800">HIS user ${escapeHtml(d.userId || '')}</div>
        <div style="font-size:12px;color:var(--muted)">${groups.length} groups · ${total} privileges held · ${radHave}/${HIS_RAD_KEYS.length} radiology · ${granted.size}${sites.length ? '/' + sites.length : ''} branches · catalogue ${catalog.length}</div>
      </div>
    </div>

    <div class="board" style="margin-bottom:14px">
      <div class="bhead"><div class="bhrow"><div class="btitle">Groups <span>${groups.length}</span></div></div></div>
      <div style="padding:14px 18px">
        <div style="font-size:11.5px;color:var(--muted);margin-bottom:8px">Access in Siratech is granted by <b>group</b> — a save assigns groups, not loose privileges. To change access, assign the matching group in the Siratech admin UI.</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap">${
          groups.length ? groups.map((g) => `<span class="sc ok" style="margin:0">${escapeHtml(g.name || ('Group ' + g.id))} <span style="opacity:.6">#${escapeHtml(String(g.id))}</span></span>`).join('')
          : '<span style="color:var(--muted)">No groups assigned</span>'
        }</div>
      </div>
    </div>

    <div class="board" style="margin-bottom:14px">
      <div class="bhead"><div class="bhrow"><div class="btitle">Branch access <span>${granted.size}${sites.length ? ' of ' + sites.length : ''}</span></div></div></div>
      <div style="padding:14px 18px">
        <div style="display:flex;gap:7px;flex-wrap:wrap">${siteChips || '<span style="color:var(--muted)">No branches</span>'}</div>
        ${missing.length ? `<div class="ps-alert" style="margin-top:12px">⚠️ Missing: <b>${missing.map((s) => escapeHtml(s.name)).join(', ')}</b></div>` : ''}
      </div>
    </div>

    <div class="board">
      <div class="bhead"><div class="bhrow">
        <div class="btitle">All privileges <span>${catalog.length}</span></div>
        <button class="btn btn-sm" style="width:auto" onclick="hisExportCatalog()">⬇︎ Download all (CSV)</button>
      </div></div>
      <div style="padding:14px 18px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
          <input id="his-priv-search" class="input" placeholder="Search privileges · e.g. REPORT, BILLING, RESULT" style="flex:1;min-width:200px" oninput="hisPrivSearch(this.value)">
          <label style="font-size:12px;display:flex;gap:5px;align-items:center;white-space:nowrap"><input type="checkbox" id="his-only-missing" onchange="hisAccessRenderList()"> only not-granted</label>
        </div>
        <div style="font-size:11.5px;color:var(--muted);margin-bottom:8px">Read-only audit. Green = the user holds it. Grants are done by group in the Siratech admin UI.</div>
        <div id="his-priv-list"></div>
      </div>
    </div>`;
  hisAccessRenderList();
}

function hisPrivSearch(v) { _hisFilter = String(v || '').trim().toUpperCase(); hisAccessRenderList(); }

// Export the full privilege catalogue as a categorised CSV (category = module prefix),
// with a column flagging whether the looked-up user holds each one.
function hisExportCatalog() {
  const keys = (_hisCatalog || []).slice().sort();
  if (!keys.length) { toast('No privileges loaded — look up a user first', 'err'); return; }
  const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const rows = [['category', 'privilege', 'held_by_looked_up_user']];
  for (const k of keys) rows.push([String(k).split('_')[0] || '?', k, _hisGranted.has(k) ? 'yes' : 'no']);
  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `siratech-privileges-${(_hisData && _hisData.userId) || 'catalog'}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  const cats = new Set(keys.map((k) => String(k).split('_')[0] || '?'));
  toast(`Exported ${keys.length} privileges across ${cats.size} categories`);
}

function hisAccessRenderList() {
  const host = document.getElementById('his-priv-list');
  if (!host) return;
  const onlyMissing = document.getElementById('his-only-missing')?.checked;
  let keys = (_hisCatalog || []);
  if (_hisFilter) keys = keys.filter((k) => k.toUpperCase().includes(_hisFilter));
  if (onlyMissing) keys = keys.filter((k) => !_hisGranted.has(k));
  const CAP = 500;
  const shown = keys.slice(0, CAP);
  const grouped = hisGroupByPrefix(shown);
  host.innerHTML = grouped.map(([prefix, ks]) => `
    <div class="ps-sec" style="margin-top:12px">
      <div class="ps-sec-l">${escapeHtml(prefix)} · ${ks.length}</div>
      ${ks.map((k) => {
        const on = _hisGranted.has(k);
        return `<div style="display:flex;align-items:center;gap:9px;padding:5px 0;border-bottom:1px solid var(--border)">
          <span class="sc ${on ? 'ok' : 'no'}" style="margin:0;min-width:74px;justify-content:center">${on ? 'Granted' : 'Not held'}</span>
          <span class="tnum" style="font-size:12px;flex:1;min-width:0">${escapeHtml(k)}</span>
        </div>`;
      }).join('')}
    </div>`).join('') + (keys.length > CAP ? `<div style="font-size:11.5px;color:var(--muted);padding:10px 0">Showing first ${CAP} of ${keys.length} — refine the search to see the rest.</div>` : '');
}
