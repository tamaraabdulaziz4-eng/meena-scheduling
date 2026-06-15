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

// ── PDF Export (branded, mirrors the dashboard rota) ──────────────────────────
async function exportPDF() {
  if (!currentSchedule || !scheduleStaff.length) { toast('No schedule loaded', 'err'); return; }

  // Load jsPDF + autotable from CDN once
  if (!window.jspdf) {
    showLoader('Loading PDF library…');
    try {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    } catch (e) {
      hideLoader();
      toast('Could not load PDF library — check your connection', 'err');
      return;
    }
    hideLoader();
  }

  showLoader('Building PDF…');
  try {
    const { jsPDF } = window.jspdf;
    const nDays = daysInMonth(scheduleYear, scheduleMonth);
    const branchName = allBranches.find(b => b.id === currentBranchId)?.name || '';

    // Landscape A4 — best fit for a wide month grid
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();

    // Meena brand palette
    const NAVY   = [43, 36, 88];
    const PURPLE = [107, 78, 255];
    const LIGHT  = [238, 240, 251];

    // ── Header band ──
    doc.setFillColor(...NAVY);
    doc.rect(0, 0, pageW, 22, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text('Meena Health — Radiology', 12, 10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text(`${monthLabel(scheduleYear, scheduleMonth)} Rota  ·  ${branchName}`, 12, 17);

    // ── Build table head: Name | 1..N | Shifts ──
    const head = [
      ['Name',
       ...Array.from({ length: nDays }, (_, i) => String(i + 1)),
       'Shifts'],
      ['',
       ...Array.from({ length: nDays }, (_, i) => DAYS[dayOfWeek(scheduleYear, scheduleMonth, i + 1)]),
       ''],
    ];

    // ── Shift colour map from configured shift types ──
    const shiftColors = {};
    (allShiftTypes || []).forEach(st => {
      if (st.colour) {
        const h = st.colour.replace('#', '');
        shiftColors[st.code] = [
          parseInt(h.substr(0, 2), 16),
          parseInt(h.substr(2, 2), 16),
          parseInt(h.substr(4, 2), 16),
        ];
      }
    });

    const body = [];
    const cellColors = []; // [{r,c,color}] to paint via didParseCell

    function pushStaff(arr, sectionLabel) {
      if (sectionLabel) {
        const r = [sectionLabel, ...Array(nDays + 1).fill('')];
        body.push(r);
        cellColors.push({ row: body.length - 1, section: true });
      }
      arr.forEach(s => {
        let count = 0;
        const row = [s.name];
        for (let d = 1; d <= nDays; d++) {
          const dateStr = `${scheduleYear}-${String(scheduleMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const entry = entryMap[`${s.id}_${dateStr}`];
          const code = entry?.shift_code || 'O';
          if (code !== 'O' && !['AL','SL','TB'].includes(code)) count++;
          row.push(code === 'O' ? '' : code);
        }
        row.push(String(count));
        body.push(row);
      });
    }

    const generalStaff = scheduleStaff.filter(s => !s.speciality?.includes('Ultrasound') || s.speciality?.includes('General'));
    const usStaff      = scheduleStaff.filter(s => s.speciality?.includes('Ultrasound') && !s.speciality?.includes('General'));
    if (usStaff.length && generalStaff.length) {
      pushStaff(generalStaff, 'General Radiology');
      pushStaff(usStaff, 'Ultrasound (US)');
    } else {
      pushStaff(scheduleStaff, '');
    }

    doc.autoTable({
      head, body,
      startY: 26,
      theme: 'grid',
      styles: { fontSize: 6, cellPadding: 0.8, halign: 'center', valign: 'middle', lineColor: [220,220,235], lineWidth: 0.1 },
      headStyles: { fillColor: NAVY, textColor: 255, fontSize: 6, fontStyle: 'bold' },
      columnStyles: { 0: { halign: 'left', cellWidth: 28, fontStyle: 'bold' } },
      alternateRowStyles: { fillColor: [250, 250, 255] },
      margin: { left: 8, right: 8 },
      didParseCell: (data) => {
        // Section header rows span + colour
        const meta = cellColors.find(c => c.row === data.row.index && c.section);
        if (meta && data.section === 'body') {
          data.cell.styles.fillColor = LIGHT;
          data.cell.styles.textColor = NAVY;
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.halign = 'left';
        }
        // Colour shift code cells
        if (data.section === 'body' && data.column.index > 0 && data.column.index <= nDays) {
          const code = data.cell.raw;
          if (code && shiftColors[code]) {
            data.cell.styles.fillColor = shiftColors[code];
            data.cell.styles.textColor = 255;
            data.cell.styles.fontStyle = 'bold';
          }
        }
      },
    });

    // ── Legend ──
    let ly = doc.lastAutoTable.finalY + 6;
    if (ly > doc.internal.pageSize.getHeight() - 20) { doc.addPage('a4', 'landscape'); ly = 14; }
    doc.setTextColor(...NAVY); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('Shift Legend', 8, ly);
    ly += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
    let lx = 8;
    (allShiftTypes || []).forEach(st => {
      const label = `${st.code}: ${st.label}${st.start_time ? ` (${fmt12(st.start_time)}–${fmt12(st.end_time)})` : ''}`;
      const w = doc.getTextWidth(label) + 8;
      if (lx + w > pageW - 8) { lx = 8; ly += 5; }
      if (st.colour) {
        const h = st.colour.replace('#','');
        doc.setFillColor(parseInt(h.substr(0,2),16), parseInt(h.substr(2,2),16), parseInt(h.substr(4,2),16));
        doc.circle(lx + 1.5, ly - 1.5, 1.3, 'F');
      }
      doc.setTextColor(60,60,80);
      doc.text(label, lx + 4, ly);
      lx += w;
    });

    // ── Footer ──
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(6); doc.setTextColor(150,150,170);
      doc.text(`Generated ${new Date().toLocaleDateString()}  ·  Meena Health Scheduling`,
        8, doc.internal.pageSize.getHeight() - 5);
      doc.text(`Page ${i} / ${pageCount}`, pageW - 24, doc.internal.pageSize.getHeight() - 5);
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
