// ── XLSX Export (using SheetJS via CDN) ───────────────────────────────────────
// SheetJS loaded via CDN in index.html (added below)

async function exportXLSX() {
  if (!currentSchedule || !scheduleStaff.length) { toast('No schedule loaded', 'err'); return; }

  // Load XLSX library if not already loaded
  if (!window.XLSX) {
    showLoader('Loading export library…');
    await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js');
    hideLoader();
  }

  const nDays = daysInMonth(scheduleYear, scheduleMonth);

  // ── Build worksheet data ──────────────────────────────────────────────────
  const wsData = [];

  // Title row
  wsData.push([`Meena Health - Radiology`, '', '', ...Array(nDays).fill(''), '']);
  wsData.push([`${monthLabel(scheduleYear, scheduleMonth)} ROTA — ${allBranches.find(b=>b.id===currentBranchId)?.name||''}`, ...Array(nDays+2).fill('')]);
  wsData.push([]); // blank

  // Header row: Name | 1 | 2 | … | 31 | Shifts
  wsData.push(['Name', ...Array.from({length:nDays},(_,i)=>i+1), 'Shifts']);

  // Day-of-week row
  wsData.push(['', ...Array.from({length:nDays},(_,i)=>DAYS[dayOfWeek(scheduleYear,scheduleMonth,i+1)]), '']);

  // Staff rows
  function addStaffRows(staffArr, sectionLabel) {
    if (sectionLabel) {
      wsData.push([sectionLabel, ...Array(nDays+1).fill('')]);
    }
    staffArr.forEach(s => {
      let shiftCount = 0;
      const row = [s.name];
      for (let d = 1; d <= nDays; d++) {
        const dateStr = `${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const entry   = entryMap[`${s.id}_${dateStr}`];
        const code    = entry?.shift_code || 'O';
        if (code !== 'O' && !['AL','SL','TB'].includes(code)) shiftCount++;
        row.push(code + (entry?.is_oncall ? '/OC' : '') + (entry?.cross_branch_id ? `↗` : ''));
      }
      row.push(shiftCount);
      wsData.push(row);
    });
  }

  const generalStaff = scheduleStaff.filter(s => !isUSStaff(s));
  const usStaff      = scheduleStaff.filter(s => isUSStaff(s));

  if (usStaff.length && generalStaff.length) {
    addStaffRows(generalStaff, '');
    wsData.push(['US']);
    addStaffRows(usStaff, '');
  } else {
    addStaffRows(scheduleStaff, '');
  }

  // Blank + legend
  wsData.push([]);
  wsData.push(['Shift Legend:']);
  allShiftTypes.forEach(st => {
    wsData.push([st.code, `${st.label}${st.start_time ? ` (${fmt12(st.start_time)} – ${fmt12(st.end_time)})` : ''}`]);
  });

  // ── Create workbook ───────────────────────────────────────────────────────
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Column widths
  ws['!cols'] = [{ wch: 22 }, ...Array(nDays).fill({ wch: 5 }), { wch: 7 }];

  const wb = XLSX.utils.book_new();
  const sheetName = `${MONTHS[scheduleMonth-1].slice(0,3)} ${scheduleYear}`;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const branchName = allBranches.find(b=>b.id===currentBranchId)?.name?.replace(/\s+/g,'-') || 'Branch';
  XLSX.writeFile(wb, `ROTA-${branchName}-${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}.xlsx`);
  toast('XLSX exported');
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── Colour helpers: soften the vivid shift colours for a calm, printed look ──
function _parseColor(s) {
  s = (s || '').trim();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2]]; }
  return [208, 208, 208];
}
function _mixRgb(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function _rgbCss(a) { return `rgb(${a.map(x => Math.round(x)).join(',')})`; }
// Soft pastel fill + a readable dark-of-hue text, so cells are "shaded" not loud.
function _muteFill(color) { return _rgbCss(_mixRgb(_parseColor(color), [255, 255, 255], 0.76)); }
function _muteText(color) { return _rgbCss(_mixRgb(_parseColor(color), [40, 30, 70], 0.55)); }

// ── PDF Export (exact snapshot of the on-screen rota) ─────────────────────────
async function exportPDF() {
  if (!currentSchedule || !scheduleStaff.length) { toast('No schedule loaded', 'err'); return; }

  const rota = document.getElementById('rota-wrap');
  if (!rota) { toast('Schedule table not found', 'err'); return; }

  // Load html2canvas + jsPDF from CDN once
  if (!window.html2canvas || !window.jspdf) {
    showLoader('Loading PDF library…');
    try {
      if (!window.html2canvas) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
      if (!window.jspdf)       await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    } catch (e) {
      hideLoader();
      toast('Could not load PDF library — check your connection', 'err');
      return;
    }
    hideLoader();
  }

  showLoader('Building PDF…');
  try {
    const branchName = allBranches.find(b => b.id === currentBranchId)?.name || '';

    // Temporarily expand the scroll container so the FULL table is captured,
    // not just the visible part. Save current styles to restore after.
    const prev = {
      maxHeight: rota.style.maxHeight,
      overflow:  rota.style.overflow,
      width:     rota.style.width,
    };

    // Snapshot the table. Three fixes vs. the old capture:
    //  1. Expand the wrap to the table's FULL width so no days are cut off.
    //  2. Drop sticky positioning (pdf-capture class) so the name column and
    //     headers don't overlap the day cells in the rendered image.
    //  3. Soften the vivid shift colours to calm pastels with dark text.
    // Everything is restored in finally, even if capture throws.
    const muted = [];
    let canvas;
    // Always export on a light sheet — a dark-mode rota prints as dark blocks.
    const wasDark = document.body.classList.contains('dark');
    try {
      if (wasDark) document.body.classList.remove('dark');
      rota.style.maxHeight = 'none';
      rota.style.overflow  = 'visible';
      rota.classList.add('pdf-capture');
      // Widen so the whole month is laid out (no horizontal clipping).
      const fullW = rota.scrollWidth;
      rota.style.width = fullW + 'px';
      // Soften coloured cells: pastel fill + dark legible text.
      rota.querySelectorAll('.rota-cell:not(.blank-cell)').forEach(td => {
        const bg = td.style.background;
        if (!bg || bg === 'transparent') return;
        const chip = td.querySelector('.shift-chip');
        muted.push([td, bg, chip, chip ? chip.style.color : null]);
        td.style.background = _muteFill(bg);
        if (chip) chip.style.color = _muteText(bg);
      });
      canvas = await html2canvas(rota, {
        scale: 2,                                   // crisp on retina / print
        backgroundColor: '#ffffff',
        useCORS: true,
        windowWidth: fullW + 40,
        windowHeight: rota.scrollHeight + 40,
      });
    } finally {
      rota.classList.remove('pdf-capture');
      muted.forEach(([td, bg, chip, col]) => { td.style.background = bg; if (chip) chip.style.color = col; });
      rota.style.maxHeight = prev.maxHeight;
      rota.style.overflow  = prev.overflow;
      rota.style.width     = prev.width;
      if (wasDark) document.body.classList.add('dark');
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();

    // ── Branded header band ──
    const NAVY = [43, 36, 88];
    doc.setFillColor(...NAVY);
    doc.rect(0, 0, pageW, 20, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text('Meena Health — Radiology', 12, 9);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(`${monthLabel(scheduleYear, scheduleMonth)} Rota  ·  ${branchName}`, 12, 15);

    // ── Place the captured image, scaled to fit width, paginated if tall ──
    const imgData = canvas.toDataURL('image/png');
    const margin = 6;
    const topOffset = 24;
    const usableW = pageW - margin * 2;
    const imgW = usableW;
    const imgH = (canvas.height * imgW) / canvas.width;

    if (imgH <= pageH - topOffset - margin) {
      // Fits on one page
      doc.addImage(imgData, 'PNG', margin, topOffset, imgW, imgH);
    } else {
      // Tall table — slice across multiple pages
      const sliceH = pageH - topOffset - margin;            // mm available per page
      const pxPerMm = canvas.height / imgH;                 // canvas px per mm
      const slicePx = sliceH * pxPerMm;
      let renderedPx = 0;
      let firstPage = true;
      while (renderedPx < canvas.height) {
        const curPx = Math.min(slicePx, canvas.height - renderedPx);
        // Make a temp canvas for this slice
        const tmp = document.createElement('canvas');
        tmp.width = canvas.width; tmp.height = curPx;
        tmp.getContext('2d').drawImage(canvas, 0, renderedPx, canvas.width, curPx, 0, 0, canvas.width, curPx);
        const sliceData = tmp.toDataURL('image/png');
        const sliceMmH = curPx / pxPerMm;

        if (!firstPage) {
          doc.addPage('a4', 'landscape');
          // repeat header band
          doc.setFillColor(...NAVY); doc.rect(0, 0, pageW, 20, 'F');
          doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(14);
          doc.text('Meena Health — Radiology', 12, 9);
          doc.setFont('helvetica','normal'); doc.setFontSize(9);
          doc.text(`${monthLabel(scheduleYear, scheduleMonth)} Rota  ·  ${branchName}`, 12, 15);
        }
        doc.addImage(sliceData, 'PNG', margin, topOffset, imgW, sliceMmH);
        renderedPx += curPx;
        firstPage = false;
      }
    }

    // ── Footer on every page ──
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(6); doc.setTextColor(150,150,170);
      doc.text(`Generated ${new Date().toLocaleDateString('en-GB')}  ·  Meena Health Scheduling`, margin, pageH - 4);
      doc.text(`Page ${i} / ${pageCount}`, pageW - 24, pageH - 4);
    }

    const fname = `ROTA-${branchName.replace(/\s+/g,'-')||'Branch'}-${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}.pdf`;
    doc.save(fname);
    hideLoader();
    toast('PDF exported');
  } catch (err) {
    hideLoader();
    toast('PDF export failed: ' + err.message, 'err');
  }
}

// ── Print CSS (injected for print view) ──────────────────────────────────────
(function injectPrintCSS() {
  const style = document.createElement('style');
  style.textContent = `
    @media print {
      body:not(.mode-report) #sidebar, body:not(.mode-report) .sidebar-toggle,
      body:not(.mode-report) #topbar-actions, body:not(.mode-report) .schedule-toolbar .btn,
      body:not(.mode-report) .legend, body:not(.mode-report) .stats-row,
      body:not(.mode-report) #shift-picker, body:not(.mode-report) #toast, body:not(.mode-report) #page-loader,
      body:not(.mode-report) #confirm-overlay, body:not(.mode-report) .modal-overlay,
      body:not(.mode-report) #schedule-status-bar button { display: none !important; }
      body:not(.mode-report) { background: white !important; color: black !important; font-size: 10px !important; }
      body:not(.mode-report) .rota-wrap { max-height: none !important; overflow: visible !important; border: none !important; }
      body:not(.mode-report) .rota-table { font-size: 9px !important; }
      body:not(.mode-report) .rota-table th, body:not(.mode-report) .rota-table td { border: 1px solid #ccc !important; padding: 2px !important; }
      body:not(.mode-report) .rota-name-col { min-width: 100px !important; }
      body:not(.mode-report) .shift-chip { font-size: 8px !important; }
      body:not(.mode-report) .main { overflow: visible !important; }
      body:not(.mode-report) .layout { display: block !important; height: auto !important; }
    }
  `;
  document.head.appendChild(style);
})();
