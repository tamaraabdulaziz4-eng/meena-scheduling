// ── Command palette (⌘/Ctrl-K) + topbar quick-jump ───────────────────────────
// A power-user launcher that mirrors the sidebar nav and jumps to a patient by
// MRN. It never re-implements navigation — activating a nav result just clicks
// the underlying .nav-item, so routing, auth-gating and mobile-drawer close all
// keep working exactly as before. Self-contained: injects its own overlay and a
// topbar trigger button, and binds the global shortcut.

(function cmdk() {
  let _open = false, _sel = 0, _items = [], _built = false;

  function ensureDom() {
    if (document.getElementById('cmdk-overlay')) return;
    const ov = document.createElement('div');
    ov.id = 'cmdk-overlay';
    ov.innerHTML =
      '<div class="cmdk">' +
        '<div class="cmdk-inp-wrap">' +
          '<svg class="cmdk-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>' +
          '<input id="cmdk-input" type="text" autocomplete="off" spellcheck="false" placeholder="Jump to a page, or type a patient MRN…">' +
          '<span class="cmdk-esc">esc</span>' +
        '</div>' +
        '<div class="cmdk-list" id="cmdk-list"></div>' +
      '</div>';
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeCmdK(); });
    document.body.appendChild(ov);
    const inp = ov.querySelector('#cmdk-input');
    inp.addEventListener('input', render);
    inp.addEventListener('keydown', onKey);
  }

  // Collect the visible sidebar nav items + bottom actions as commands.
  function collect() {
    const out = [];
    const els = document.querySelectorAll('.sidebar-nav .nav-item, .sidebar-bottom .nav-item');
    els.forEach((el) => {
      if (el.offsetParent === null && el.style.display === 'none') return;   // hidden by role
      const label = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) return;
      const oc = el.getAttribute('onclick') || '';
      const isNav = /showPage\(/.test(oc);
      out.push({ label, el, kind: isNav ? 'page' : 'action' });
    });
    return out;
  }

  function matches(q, label) {
    q = q.toLowerCase(); label = label.toLowerCase();
    if (!q) return true;
    if (label.includes(q)) return true;
    // subsequence (fuzzy) match
    let i = 0; for (const c of label) { if (c === q[i]) i++; if (i === q.length) return true; }
    return false;
  }

  function render() {
    const q = (document.getElementById('cmdk-input').value || '').trim();
    const list = document.getElementById('cmdk-list');
    const cmds = collect();
    _items = [];

    // Patient jump — a bare MRN-ish number gets a top action.
    if (/^\d{4,}$/.test(q)) {
      _items.push({
        label: 'Open patient ' + q, hint: 'Patient card', icon: 'user',
        run: () => {
          if (typeof wlOpenPatientCard === 'function') wlOpenPatientCard(q);
          else if (typeof showPage === 'function') showPage('patientsearch');
        }
      });
    }
    cmds.filter(c => matches(q, c.label)).forEach(c => {
      _items.push({ label: c.label, hint: c.kind === 'page' ? 'Page' : 'Action', icon: c.kind === 'page' ? 'page' : 'bolt',
        run: () => c.el.click() });
    });

    if (_sel >= _items.length) _sel = Math.max(0, _items.length - 1);
    list.innerHTML = _items.length ? _items.map((it, i) =>
      '<button class="cmdk-row' + (i === _sel ? ' sel' : '') + '" data-i="' + i + '">' +
        '<span class="cmdk-row-ico">' + rowIcon(it.icon) + '</span>' +
        '<span class="cmdk-row-label">' + esc(it.label) + '</span>' +
        '<span class="cmdk-row-hint">' + esc(it.hint || '') + '</span>' +
      '</button>').join('')
      : '<div class="cmdk-empty">No matches</div>';
    list.querySelectorAll('.cmdk-row').forEach(r => {
      r.addEventListener('mousemove', () => { _sel = +r.dataset.i; paintSel(); });
      r.addEventListener('click', () => activate(+r.dataset.i));
    });
  }

  function paintSel() {
    document.querySelectorAll('#cmdk-list .cmdk-row').forEach((r, i) => r.classList.toggle('sel', i === _sel));
    const cur = document.querySelector('#cmdk-list .cmdk-row.sel');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function activate(i) {
    const it = _items[i]; if (!it) return;
    closeCmdK();
    try { it.run(); } catch (e) { /* navigation errors surface on the page itself */ }
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); _sel = Math.min(_items.length - 1, _sel + 1); paintSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _sel = Math.max(0, _sel - 1); paintSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(_sel); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCmdK(); }
  }

  function openCmdK() {
    ensureDom();
    _open = true; _sel = 0;
    const ov = document.getElementById('cmdk-overlay');
    ov.classList.add('open');
    const inp = document.getElementById('cmdk-input');
    inp.value = ''; render();
    setTimeout(() => inp.focus(), 30);
  }
  function closeCmdK() {
    _open = false;
    const ov = document.getElementById('cmdk-overlay');
    if (ov) ov.classList.remove('open');
  }
  window.openCmdK = openCmdK; window.closeCmdK = closeCmdK;

  // Global shortcut — ⌘K / Ctrl-K (and Ctrl-/ as a friendly alias).
  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'k') { e.preventDefault(); _open ? closeCmdK() : openCmdK(); }
  });

  // Inject a topbar trigger button (once the shell exists).
  function mountTrigger() {
    const right = document.querySelector('.topbar-right');
    if (!right || document.getElementById('cmdk-trigger')) return;
    const btn = document.createElement('button');
    btn.id = 'cmdk-trigger'; btn.className = 'cmdk-trigger'; btn.type = 'button';
    btn.title = 'Search & jump (Ctrl/⌘ K)'; btn.setAttribute('aria-label', 'Search and jump');
    btn.onclick = openCmdK;
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>' +
      '<span class="cmdk-trigger-txt">Search</span><span class="cmdk-kbd">⌘K</span>';
    right.insertBefore(btn, right.firstChild);
  }
  if (document.readyState !== 'loading') mountTrigger();
  else document.addEventListener('DOMContentLoaded', mountTrigger);
  // The shell may render after login — retry a few times.
  let tries = 0; const iv = setInterval(() => { mountTrigger(); if (document.getElementById('cmdk-trigger') || ++tries > 40) clearInterval(iv); }, 250);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function rowIcon(k) {
    if (k === 'user') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 12 0v1"/></svg>';
    if (k === 'bolt') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7z"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>';
  }
})();
