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
