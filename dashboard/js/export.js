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

  const generalStaff = scheduleStaff.filter(s => !s.speciality?.includes('Ultrasound') || s.speciality?.includes('General'));
  const usStaff      = scheduleStaff.filter(s => s.speciality?.includes('Ultrasound') && !s.speciality?.includes('General'));

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

    const isDark = document.body.classList.contains('dark');

    // Snapshot the table exactly as rendered. The expand/restore is wrapped so
    // the on-screen table always returns to normal even if capture throws.
    let canvas;
    try {
      rota.style.maxHeight = 'none';
      rota.style.overflow  = 'visible';
      canvas = await html2canvas(rota, {
        scale: 2,                                   // crisp on retina / print
        backgroundColor: isDark ? '#1c1a35' : '#ffffff',
        useCORS: true,
        windowWidth: rota.scrollWidth,
        windowHeight: rota.scrollHeight,
      });
    } finally {
      rota.style.maxHeight = prev.maxHeight;
      rota.style.overflow  = prev.overflow;
      rota.style.width     = prev.width;
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
      doc.text(`Generated ${new Date().toLocaleDateString()}  ·  Meena Health Scheduling`, margin, pageH - 4);
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
      #sidebar, .sidebar-toggle, #topbar-actions, .schedule-toolbar .btn,
      .legend, .stats-row, #shift-picker, #toast, #page-loader,
      #confirm-overlay, .modal-overlay, #schedule-status-bar button { display: none !important; }
      body { background: white !important; color: black !important; font-size: 10px !important; }
      .rota-wrap { max-height: none !important; overflow: visible !important; border: none !important; }
      .rota-table { font-size: 9px !important; }
      .rota-table th, .rota-table td { border: 1px solid #ccc !important; padding: 2px !important; }
      .rota-name-col { min-width: 100px !important; }
      .shift-chip { font-size: 8px !important; }
      .main { overflow: visible !important; }
      .layout { display: block !important; height: auto !important; }
    }
  `;
  document.head.appendChild(style);
})();
