// ── HIS User Access (Siratech privileges viewer) ──────────────────────────────
// Superadmin-only, READ-ONLY. Enter a Siratech HIS user id → see their site scope and
// radiology privileges live from the HIS. Siratech exposes NO privilege-write API, so this
// audits access (spot a missing branch or a missing privilege); changes are made in Siratech.

// The radiology-relevant privilege catalogue (of Siratech's 3,269) with plain-English labels.
// A user either has each key or not — we show granted (green) vs not (grey).
const HIS_RAD_PRIVS = [
  { group: 'Access', items: [
    ['EMR_ACCESS', 'Open the EMR'],
    ['EMR_CPOE_VIEW', 'View doctor orders (CPOE)'],
    ['EMR_MNU_EMR_ORDERS', 'EMR orders menu'],
  ]},
  { group: 'Studies & reports', items: [
    ['RADIOLOGY_STUDY_VIEW', 'View studies'],
    ['RADIOLOGY_STUDY_EDIT', 'Edit studies'],
    ['RADIOLOGY_REPORT_VIEW', 'Read reports'],
    ['RADIOLOGY_REPORT_ADD', 'Write a report'],
    ['RADIOLOGY_REPORT_EDIT', 'Edit a report'],
    ['RADIOLOGY_REPORT_AUTHORISE', 'Sign off / authorise a report'],
    ['RADIOLOGY_REPORT_UNLOCK', 'Reopen a signed report'],
    ['RADIOLOGY_REPORT_PRINT', 'Print a report'],
    ['RADIOLOGY_REPORT_DELETE', 'Delete a report'],
  ]},
  { group: 'Result entry & verification', items: [
    ['RESULT_ENTRY', 'Enter a result'],
    ['RESULT_FIRST_LEVEL_AUTHORIZE', 'First-level verify'],
    ['RESULT_FIRST_LEVEL_UNAUTHORIZE', 'Undo first-level verify'],
    ['RESULT_SECOND_LEVEL_AUTHORIZE', 'Second-level verify'],
    ['RESULT_SECOND_LEVEL_UNAUTHORIZE', 'Undo second-level verify'],
    ['RESULT_PRINT', 'Print result'],
    ['RESULT_DRAFT_PRINT', 'Print draft result'],
    ['RESULT_FAX_SEND', 'Fax a result'],
    ['RIS_CANCELLATION', 'Cancel an order'],
  ]},
  { group: 'Modality · templates · documents', items: [
    ['RADIOLOGY_MODALITY_VIEW', 'View modalities'],
    ['RADIOLOGY_MODALITY_ADD', 'Add modality'],
    ['RADIOLOGY_MODALITY_EDIT', 'Edit modality'],
    ['RADIOLOGY_MODALITY_DELETE', 'Delete modality'],
    ['RADIOLOGY_TEMPLATE_VIEW', 'View report templates'],
    ['RADIOLOGY_TEMPLATE_ADD', 'Add template'],
    ['RADIOLOGY_TEMPLATE_EDIT', 'Edit template'],
    ['RADIOLOGY_TEMPLATE_DELETE', 'Delete template'],
    ['SCANNED_DOCUMENTS', 'Scanned documents'],
    ['SCANNED_DOCUMENT_PRINT', 'Print scanned document'],
    ['SCANNED_DOCUMENT_MOVE', 'Move scanned document'],
    ['SCANNED_DOCUMENT_DELETE', 'Delete scanned document'],
    ['MACHINE_MASTER', 'Machine configuration'],
  ]},
];

let _hisAccessData = null;

function renderHisAccessPage() {
  setTopbar('HIS User Access', 'Audit a Siratech user’s branches & radiology privileges');
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="cc">
      ${pageHero('Siratech privileges', 'HIS User Access')}
      <div class="board" style="margin-bottom:14px">
        <div class="bhead"><div class="bhrow">
          <div class="btitle">Look up a HIS user</div>
        </div></div>
        <div style="padding:16px 18px">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <input id="his-uid" class="input" placeholder="HIS user id · e.g. 102240" style="flex:1;min-width:200px"
                   onkeydown="if(event.key==='Enter')hisAccessLookup()">
            <button class="open pri" style="width:auto" onclick="hisAccessLookup()">Look up</button>
          </div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:8px">
            Read-only. Siratech provides no API to change privileges &mdash; grants/removals are done in the Siratech admin console.
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
  if (box) box.innerHTML = `<div class="board"><div style="padding:22px 18px;color:var(--muted)">Reading privileges from Siratech…</div></div>`;
  let d;
  try {
    d = await API.get(`/radiology/his-user/${encodeURIComponent(uid)}/privileges`);
  } catch (e) {
    if (box) box.innerHTML = `<div class="board"><div style="padding:22px 18px;color:var(--danger-ink)">Could not read this user: ${escapeHtml(e.message || 'error')}</div></div>`;
    return;
  }
  _hisAccessData = d;
  hisAccessRender(d);
}

function hisAccessRender(d) {
  const box = document.getElementById('his-access-result');
  if (!box) return;
  const pv = (d && d.privilegesByUser) || {};
  const names = new Set(pv.names || []);
  const total = pv.count || (pv.names ? pv.names.length : 0);
  const sites = d.sites || [];
  // Site 0 is a "global/all" scope marker in the HIS, not a real branch — exclude it from the count.
  const granted = new Set((d.grantedSites || []).filter((id) => Number(id) > 0));

  // Sites: every HIS site, granted (green) or missing (red).
  const siteChips = sites.length
    ? sites.map((s) => {
        const on = granted.has(Number(s.id));
        return `<span class="sc ${on ? 'ok' : 'no'}" style="margin:0">${on ? '✓' : '✕'} ${escapeHtml(s.name)}</span>`;
      }).join('')
    : (d.grantedSites || []).map((id) => `<span class="sc ok" style="margin:0">✓ Site ${id}</span>`).join('');
  const missing = sites.filter((s) => !granted.has(Number(s.id)));

  // Radiology privileges: catalogue with granted/not.
  const radBlocks = HIS_RAD_PRIVS.map((grp) => {
    const rows = grp.items.map(([key, label]) => {
      const on = names.has(key);
      return `<div style="display:flex;align-items:center;gap:9px;padding:5px 0;border-bottom:1px solid var(--border)">
        <span class="sc ${on ? 'ok' : 'no'}" style="margin:0;min-width:64px;justify-content:center">${on ? 'Granted' : '—'}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600">${escapeHtml(label)}</div>
          <div class="tnum" style="font-size:10.5px;color:var(--muted)">${escapeHtml(key)}</div>
        </div>
      </div>`;
    }).join('');
    const gc = grp.items.filter(([k]) => names.has(k)).length;
    return `<div class="ps-sec" style="margin-top:14px">
      <div class="ps-sec-l" style="display:flex;justify-content:space-between">
        <span>${escapeHtml(grp.group)}</span>
        <span style="color:var(--muted);font-weight:600">${gc}/${grp.items.length}</span>
      </div>
      ${rows}
    </div>`;
  }).join('');

  const radHave = HIS_RAD_PRIVS.reduce((n, g) => n + g.items.filter(([k]) => names.has(k)).length, 0);
  const radTotal = HIS_RAD_PRIVS.reduce((n, g) => n + g.items.length, 0);

  box.innerHTML = `
    <div class="board" style="margin-bottom:14px">
      <div style="padding:16px 18px;display:flex;gap:16px;flex-wrap:wrap;align-items:center">
        <div style="flex:1;min-width:180px">
          <div style="font-size:16px;font-weight:800">HIS user ${escapeHtml(d.userId || '')}</div>
          <div style="font-size:12px;color:var(--muted)">${total} total privileges · ${radHave}/${radTotal} radiology · ${granted.size}${sites.length ? '/' + sites.length : ''} branches</div>
        </div>
      </div>
    </div>

    <div class="board" style="margin-bottom:14px">
      <div class="bhead"><div class="bhrow"><div class="btitle">Branch access <span>${granted.size}${sites.length ? ' of ' + sites.length : ''}</span></div></div></div>
      <div style="padding:14px 18px">
        <div style="display:flex;gap:7px;flex-wrap:wrap">${siteChips || '<span style="color:var(--muted)">No branches</span>'}</div>
        ${missing.length ? `<div class="ps-alert" style="margin-top:12px">⚠️ Missing: <b>${missing.map((s) => escapeHtml(s.name)).join(', ')}</b> — add in Siratech if this user should cover ${missing.length > 1 ? 'these branches' : 'this branch'}.</div>` : ''}
      </div>
    </div>

    <div class="board">
      <div class="bhead"><div class="bhrow"><div class="btitle">Radiology privileges <span>${radHave} of ${radTotal}</span></div></div></div>
      <div style="padding:6px 18px 16px">${radBlocks}</div>
    </div>`;
}
