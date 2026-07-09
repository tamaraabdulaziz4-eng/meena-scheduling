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

  box.innerHTML = `
    <div class="board" style="margin-bottom:14px">
      <div style="padding:16px 18px">
        <div style="font-size:16px;font-weight:800">HIS user ${escapeHtml(d.userId || '')}</div>
        <div style="font-size:12px;color:var(--muted)">${total} privileges held · ${radHave}/${HIS_RAD_KEYS.length} radiology · ${granted.size}${sites.length ? '/' + sites.length : ''} branches · catalogue ${catalog.length}</div>
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
      </div></div>
      <div style="padding:14px 18px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
          <input id="his-priv-search" class="input" placeholder="Search privileges · e.g. REPORT, BILLING, RESULT" style="flex:1;min-width:200px" oninput="hisPrivSearch(this.value)">
          <label style="font-size:12px;display:flex;gap:5px;align-items:center;white-space:nowrap"><input type="checkbox" id="his-only-missing" onchange="hisAccessRenderList()"> only not-granted</label>
        </div>
        <div style="font-size:11.5px;color:var(--muted);margin-bottom:8px">Green = the user already has it. Tick any to add, then Grant.</div>
        <div id="his-priv-list"></div>
        <div id="his-grant-bar" style="display:none;position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--border);padding:10px 0 2px;margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <span id="his-sel-count" style="font-weight:700"></span>
          <button class="btn btn-primary" style="width:auto" onclick="hisGrant()">Grant selected</button>
          <button class="btn btn-ghost" style="width:auto" onclick="_hisSelect=new Set();hisAccessRenderList()">Clear</button>
        </div>
      </div>
    </div>`;
  hisAccessRenderList();
}

function hisPrivSearch(v) { _hisFilter = String(v || '').trim().toUpperCase(); hisAccessRenderList(); }

function hisAccessRenderList() {
  const host = document.getElementById('his-priv-list');
  if (!host) return;
  const onlyMissing = document.getElementById('his-only-missing')?.checked;
  let keys = (_hisCatalog || []);
  if (_hisFilter) keys = keys.filter((k) => k.toUpperCase().includes(_hisFilter));
  if (onlyMissing) keys = keys.filter((k) => !_hisGranted.has(k));
  const CAP = 500;
  const shown = keys.slice(0, CAP);
  const groups = hisGroupByPrefix(shown);
  host.innerHTML = groups.map(([prefix, ks]) => `
    <div class="ps-sec" style="margin-top:12px">
      <div class="ps-sec-l">${escapeHtml(prefix)} · ${ks.length}</div>
      ${ks.map((k) => {
        const on = _hisGranted.has(k);
        const sel = _hisSelect.has(k);
        return `<label style="display:flex;align-items:center;gap:9px;padding:5px 0;border-bottom:1px solid var(--border);cursor:${on ? 'default' : 'pointer'}">
          <input type="checkbox" ${on ? 'checked disabled' : (sel ? 'checked' : '')} onchange="hisToggleSel('${jsAttr(k)}',this.checked)">
          <span class="sc ${on ? 'ok' : 'no'}" style="margin:0;min-width:64px;justify-content:center">${on ? 'Granted' : 'Add'}</span>
          <span class="tnum" style="font-size:12px;flex:1;min-width:0">${escapeHtml(k)}</span>
        </label>`;
      }).join('')}
    </div>`).join('') + (keys.length > CAP ? `<div style="font-size:11.5px;color:var(--muted);padding:10px 0">Showing first ${CAP} of ${keys.length} — refine the search to see the rest.</div>` : '');
  hisSyncGrantBar();
}

function hisToggleSel(key, on) { if (on) _hisSelect.add(key); else _hisSelect.delete(key); hisSyncGrantBar(); }

function hisSyncGrantBar() {
  const bar = document.getElementById('his-grant-bar');
  const cnt = document.getElementById('his-sel-count');
  if (!bar) return;
  bar.style.display = _hisSelect.size ? 'flex' : 'none';
  if (cnt) cnt.textContent = `${_hisSelect.size} selected to add`;
}

async function hisGrant() {
  const uid = (_hisData && _hisData.userId) || '';
  const picks = [..._hisSelect];
  if (!picks.length) return;
  try {
    // Attempts the write via the connector. Siratech currently exposes no privilege-write API,
    // so this returns a clear "not supported" until the real Save endpoint is wired in.
    const r = await API.post(`/radiology/his-user/${encodeURIComponent(uid)}/grant`, { privileges: picks });
    if (r && r.ok) {
      toast(`Granted ${picks.length} privilege${picks.length !== 1 ? 's' : ''}`);
      hisAccessLookup();
    } else {
      toast((r && r.message) || 'Grant not available', 'err');
    }
  } catch (e) {
    // Expected until the Siratech Save request is captured and wired.
    await showConfirm('Granting not wired yet',
      `Meena can read privileges but Siratech exposes no API to write them, so these ${picks.length} can't be pushed yet.\n\nTo enable this button: in Siratech admin, open DevTools → Network, grant one privilege, and send me that Save request (URL + body). I'll wire it here and it will work.\n\nSelected: ${picks.slice(0, 8).join(', ')}${picks.length > 8 ? ` …+${picks.length - 8}` : ''}`,
      'OK');
  }
}
