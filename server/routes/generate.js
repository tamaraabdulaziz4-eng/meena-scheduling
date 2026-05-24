/**
 * Auto-schedule generator — Phase-Block v4
 *
 * CORRECT MENTAL MODEL (from client + PDF analysis):
 *
 *   SHIFTS:
 *     M = 08:00–20:00 (12h) — Primary daytime slot
 *     N = 20:00–08:00 (12h) — Primary night slot
 *     D = 08:00–17:00 (9h)  — Supplementary day (subset of M hours)
 *
 *   RULES:
 *     1. Every workday needs: someone on M (or D) AND someone on N — 24h coverage
 *     2. D is supplementary — not every day needs it, assigned when daytime headcount low
 *     3. Fri + Sat = always OFF (Islamic weekend)
 *     4. Staff are in one of two phases: DAY-phase or NIGHT-phase
 *        - Phase stored per staff in DB (staff.phase: 0=day, 1=night)
 *        - Phase stays the SAME for the whole month
 *        - Admin flips it manually between months (or we auto-flip after generation)
 *     5. DAY-phase staff get: M for most of month, D when supplementary needed
 *        NIGHT-phase staff get: N for the whole month
 *     6. NO O on any workday unless:
 *        - Staff has an approved leave (AL/SL/TB)
 *        - Rest constraint genuinely violated (N ends 08:00, M starts 08:00 = 0h rest)
 *     7. US staff in NEST 1 use M/N same as General (confirmed from PDF)
 *        US staff in branches with A/B defined use A/B
 *     8. Shift counts vary naturally: staff on AL get fewer shifts — that's correct
 *     9. After generation, staff.phase is flipped (0→1, 1→0) for next month
 *
 *   PRIORITY ORDER per day:
 *     Step 1: Assign N to all NIGHT-phase staff (not on leave)
 *     Step 2: Assign M to all DAY-phase staff (not on leave)
 *     Step 3: Check if daytime headcount < MIN_DAYTIME → upgrade some M→D or add D
 *     Step 4: Verify coverage, repair gaps
 *     Step 5: Eliminate any remaining workday O (should be 0 after above)
 */

const router = require('express').Router();
const db     = require('../db');
const { authMiddleware, requireAdmin, canAccessBranch } = require('../auth');

router.use(authMiddleware);

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isWeekend(d) {
  const w = d.getDay();
  return w === 5 || w === 6; // Fri=5, Sat=6
}

function shiftEndDt(date, st) {
  if (!st?.end_time || !st?.start_time) return null;
  const [eh, em] = st.end_time.split(':').map(Number);
  const [sh]     = st.start_time.split(':').map(Number);
  const dt = new Date(date);
  dt.setHours(eh, em, 0, 0);
  if (eh <= sh) dt.setDate(dt.getDate() + 1); // overnight
  return dt;
}

function enoughRest(lastEnd, date, st, minHours = 11) {
  if (!lastEnd || !st?.start_time) return true;
  const [sh, sm] = st.start_time.split(':').map(Number);
  const start = new Date(date);
  start.setHours(sh, sm, 0, 0);
  return (start - lastEnd) >= minHours * 3600 * 1000;
}

// ── Main route ────────────────────────────────────────────────────────────────

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { branch_id, year, month, options = {} } = req.body;
    if (!canAccessBranch(req.user, branch_id))
      return res.status(403).json({ error: 'Forbidden' });

    const {
      min_rest_hours  = 11,   // min hours between shift end and next start
      cross_interval  = 3,    // cross-branch: Y3 every N working days
      flip_phase      = true, // auto-flip staff phase after generation
      phase_weeks     = 3,    // weeks in starting phase before flipping within the month
                              // 3 = work 3 weeks on starting shift, 1 week on opposite
                              // 4 = whole month on one shift (no mid-month flip)
      section         = 'all' // 'General' | 'Ultrasound' | 'all'
    } = options;

    // ── 1. Load data ──────────────────────────────────────────────────────────
    const [staffList, shiftTypes, leaves, allBranches] = await Promise.all([
      db.getAllStaff(branch_id),
      db.getShiftTypes(branch_id),
      db.getLeaves(branch_id, year, month),
      db.getAllBranches(),
    ]);

    let activeStaff = staffList.filter(s => s.active);
    if (section === 'General') {
      activeStaff = activeStaff.filter(s =>
        (s.speciality || []).some(x => x.toLowerCase() === 'general'));
    } else if (section === 'Ultrasound') {
      activeStaff = activeStaff.filter(s =>
        (s.speciality || []).some(x => x.toLowerCase() === 'ultrasound'));
    }
    if (!activeStaff.length)
      return res.status(400).json({ error: 'No active staff for this section' });

    // Shift map: code → shiftType object
    const shiftMap = {};
    for (const st of shiftTypes) shiftMap[st.code] = st;

    // Calendar
    const daysInMonth = new Date(year, month, 0).getDate();
    const dates    = Array.from({ length: daysInMonth }, (_, i) => new Date(year, month - 1, i + 1));
    const workdays = dates.filter(d => !isWeekend(d));

    // Leave map: "staffId_dateStr" → leave_code
    const leaveMap = {};
    for (const l of leaves) {
      const ds = (l.date instanceof Date ? l.date.toISOString() : String(l.date)).slice(0, 10);
      leaveMap[`${l.staff_id}_${ds}`] = l.leave_type || 'AL';
    }

    // Y3 branch for cross-branch assignments
    const y3Branch = allBranches.find(b => /y3|youth/i.test(b.name || ''));

    // ── 2. Classify staff ─────────────────────────────────────────────────────
    //
    // US-only (Ultrasound, not General):
    //   - If branch has A/B shifts → use A (day) / B (night)
    //   - Otherwise (NEST 1 style) → use M (day) / N (night) same as General
    //
    // General (or mixed General+US): → M (day) / N (night)
    //   - D is supplementary and assigned on top, not as primary
    //
    // Phase (from staff.phase in DB):
    //   0 = DAY-phase this month  → gets M (or A for US)
    //   1 = NIGHT-phase this month → gets N (or B for US)

    const hasD  = !!shiftMap['D'];
    const hasAB = !!shiftMap['A'] && !!shiftMap['B'];

    function staffKind(s) {
      const specs = (s.speciality || []).map(x => x.toLowerCase());
      return (specs.includes('ultrasound') && !specs.includes('general')) ? 'us' : 'general';
    }

    // Primary shift codes for a staff member based on their kind
    // Returns { day: 'M'|'A', night: 'N'|'B' }
    function primaryShifts(s) {
      if (staffKind(s) === 'us' && hasAB) return { day: 'A', night: 'B' };
      return { day: 'M', night: 'N' };
    }

    // What shift should this staff member work on a given date?
    // For the first phase_weeks weeks → starting phase shift
    // After phase_weeks weeks → opposite shift (mid-month rotation)
    // This matches the real pattern: 3 weeks D then 1 week N (or vice versa)
    const phaseFlipDay = phase_weeks * 7 + 1; // e.g. phase_weeks=3 → flips on day 22

    function shiftForDate(s, date) {
      const { day, night } = primaryShifts(s);
      const startPhase = s.phase || 0; // 0=day-first, 1=night-first
      const inFirstPhase = date.getDate() < phaseFlipDay;
      // First phase: use starting shift. Second phase: use opposite.
      const wantsDay = startPhase === 0 ? inFirstPhase : !inFirstPhase;
      return wantsDay ? day : night;
    }

    // Split staff into day-phase and night-phase groups (for coverage tracking)
    const dayPhaseStaff   = activeStaff.filter(s => (s.phase || 0) === 0);
    const nightPhaseStaff = activeStaff.filter(s => (s.phase || 0) === 1);

    // ── 3. Initialise entries ─────────────────────────────────────────────────
    const entries   = {}; // staffId → dateStr → { code, is_oncall, cross_branch_id }
    const lastEnd   = {}; // staffId → Date
    const workCount = {}; // staffId → int
    const crossCtr  = {}; // staffId → working day counter

    for (const s of activeStaff) {
      entries[s.id]   = {};
      lastEnd[s.id]   = null;
      workCount[s.id] = 0;
      crossCtr[s.id]  = 0;

      // Pre-fill approved leaves
      for (const d of dates) {
        const ds = fmt(d);
        const lv = leaveMap[`${s.id}_${ds}`];
        if (lv) entries[s.id][ds] = { code: lv, is_oncall: false, cross_branch_id: null };
      }
    }

    // ── 4. Main assignment: weekend = O, workday = monthly shift ─────────────
    //
    // PRIORITY:
    //   1. If leave pre-filled → skip
    //   2. If weekend → O
    //   3. Assign their monthly phase shift (M or N or A or B)
    //      - Check rest constraint
    //      - If rest violated → give ONE rest day (only valid workday O case)
    //   4. Cross-branch staff: every cross_interval working days → tag as Y3

    for (const d of dates) {
      const ds = fmt(d);

      for (const s of activeStaff) {
        // Already set (leave)
        if (entries[s.id][ds]) continue;

        // Weekend → off
        if (isWeekend(d)) {
          entries[s.id][ds] = { code: 'O', is_oncall: false, cross_branch_id: null };
          continue;
        }

        // Determine their shift for this date (phase-aware, may flip mid-month)
        const code = shiftForDate(s, d);
        const st   = shiftMap[code];

        // Cross-branch check
        let crossBranchId = null;
        if (s.is_cross_branch && y3Branch) {
          crossCtr[s.id]++;
          if (crossCtr[s.id] % cross_interval === 0) crossBranchId = y3Branch.id;
        }

        // Rest constraint
        if (st && !enoughRest(lastEnd[s.id], d, st, min_rest_hours)) {
          // Only valid case: night shift ended at 08:00, morning shift starts 08:00 → 0h rest
          // This should NOT happen in steady-state (same phase all month = same shift every day)
          // It can happen at the very first day if last month's last shift was night
          // → Give one rest day, pick up again tomorrow
          entries[s.id][ds] = { code: 'O', is_oncall: false, cross_branch_id: null };
          continue;
        }

        // Assign
        entries[s.id][ds] = { code, is_oncall: false, cross_branch_id: crossBranchId };
        workCount[s.id]++;
        lastEnd[s.id] = shiftEndDt(d, st);
      }
    }

    // ── 5. Add supplementary D shifts (daytime headcount top-up) ─────────────
    //
    // Rule: if count of staff working during 08:00–17:00 window < MIN_DAYTIME
    // then assign D to available night-phase staff who are OFF today
    // (They're off because they're night-phase, but daytime needs extra hands)
    //
    // Actually from PDF: D is used for day-phase staff who do 9h instead of 12h
    // The distinction is: some day-phase staff do M (full 12h), some do D (9h)
    // We'll keep it simple: all day-phase get M; D is not auto-assigned for now
    // (Admin can manually change M→D on specific cells)
    // This avoids the complexity and matches what most branches actually do.

    // ── 6. Coverage repair ────────────────────────────────────────────────────
    //
    // Every workday must have:
    //   General: ≥1 on M (or D) AND ≥1 on N
    //   US (if present): ≥1 on their day shift
    //
    // If short → pull from staff on O (not on leave)
    // Scale minimums to branch size

    const generalStaff = activeStaff.filter(s => staffKind(s) === 'general');
    const usStaff      = activeStaff.filter(s => staffKind(s) === 'us');

    const minM = generalStaff.length >= 2 ? 1 : 0;
    const minN = generalStaff.length >= 2 ? 1 : 0;
    const minU = usStaff.length > 0 ? 1 : 0;

    const genDayCodes   = ['M', 'D'];   // both count as daytime general coverage
    const genNightCodes = ['N'];
    const usDayCodes    = ['A', 'M'];
    const usNightCodes  = ['B', 'N'];

    for (const d of workdays) {
      const ds = fmt(d);

      const covM = generalStaff.filter(s => genDayCodes.includes(entries[s.id][ds]?.code)).length;
      const covN = generalStaff.filter(s => genNightCodes.includes(entries[s.id][ds]?.code)).length;
      const covU = usStaff.filter(s => usDayCodes.includes(entries[s.id][ds]?.code)).length;

      // Repair general M
      if (covM < minM) {
        const pool = generalStaff
          .filter(s => entries[s.id][ds]?.code === 'O' && !leaveMap[`${s.id}_${ds}`])
          .sort((a, b) => workCount[a.id] - workCount[b.id]);
        for (let i = 0; i < Math.min(minM - covM, pool.length); i++) {
          const s = pool[i]; const st = shiftMap['M'];
          if (enoughRest(lastEnd[s.id], d, st, min_rest_hours)) {
            entries[s.id][ds] = { code: 'M', is_oncall: false, cross_branch_id: null };
            workCount[s.id]++; lastEnd[s.id] = shiftEndDt(d, st);
          }
        }
      }

      // Repair general N
      if (covN < minN) {
        const pool = generalStaff
          .filter(s => entries[s.id][ds]?.code === 'O' && !leaveMap[`${s.id}_${ds}`])
          .sort((a, b) => workCount[a.id] - workCount[b.id]);
        for (let i = 0; i < Math.min(minN - covN, pool.length); i++) {
          const s = pool[i]; const st = shiftMap['N'];
          if (enoughRest(lastEnd[s.id], d, st, min_rest_hours)) {
            entries[s.id][ds] = { code: 'N', is_oncall: false, cross_branch_id: null };
            workCount[s.id]++; lastEnd[s.id] = shiftEndDt(d, st);
          }
        }
      }

      // Repair US day
      if (minU > 0 && covU < minU) {
        const usDayCode = hasAB ? 'A' : 'M';
        const pool = usStaff
          .filter(s => entries[s.id][ds]?.code === 'O' && !leaveMap[`${s.id}_${ds}`])
          .sort((a, b) => workCount[a.id] - workCount[b.id]);
        for (let i = 0; i < Math.min(minU - covU, pool.length); i++) {
          const s = pool[i]; const st = shiftMap[usDayCode];
          if (st && enoughRest(lastEnd[s.id], d, st, min_rest_hours)) {
            entries[s.id][ds] = { code: usDayCode, is_oncall: false, cross_branch_id: null };
            workCount[s.id]++; lastEnd[s.id] = shiftEndDt(d, st);
          }
        }
      }
    }

    // ── 7. Eliminate remaining workday O's ────────────────────────────────────
    //
    // Any staff still on O on a workday (not on leave) → assign their monthly shift
    // This handles the edge case where rest constraint fired on day 1
    // and the weekend gap has since provided enough rest.

    for (const s of activeStaff) {
      for (const d of workdays) {
        const ds = fmt(d);
        if (entries[s.id][ds]?.code !== 'O') continue;
        if (leaveMap[`${s.id}_${ds}`]) continue; // real leave → keep O

        const code = shiftForDate(s, d);
        const st   = shiftMap[code];
        if (st && enoughRest(lastEnd[s.id], d, st, min_rest_hours)) {
          entries[s.id][ds] = { code, is_oncall: false, cross_branch_id: null };
          workCount[s.id]++;
          lastEnd[s.id] = shiftEndDt(d, st);
        }
        // If STILL can't assign → O stays (genuinely impossible due to rest)
      }
    }

    // ── 8. On-call overlay ────────────────────────────────────────────────────
    if (Array.isArray(options.oncall_staff_ids)) {
      for (const staffId of options.oncall_staff_ids) {
        const s = activeStaff.find(x => x.id === staffId);
        if (!s) continue;
        for (const d of workdays) {
          const ds = fmt(d);
          const e  = entries[s.id]?.[ds];
          if (e && !shiftMap[e.code]?.is_off && !shiftMap[e.code]?.is_leave) {
            entries[s.id][ds] = { ...e, is_oncall: true };
          }
        }
      }
    }

    // ── 9. Persist entries ────────────────────────────────────────────────────
    const schedule = await db.upsertSchedule(branch_id, year, month, req.user.id);
    await db.clearScheduleEntries(schedule.id);

    const flatEntries = [];
    for (const s of activeStaff) {
      for (const d of dates) {
        const ds = fmt(d);
        const e  = entries[s.id][ds] || { code: 'O', is_oncall: false, cross_branch_id: null };
        flatEntries.push({
          schedule_id: schedule.id, staff_id: s.id, date: ds,
          shift_code: e.code, cross_branch_id: e.cross_branch_id || null,
          is_oncall: e.is_oncall || false, note: null,
        });
      }
    }
    await db.bulkUpsertEntries(flatEntries);

    // ── 10. Flip phases for next month (if requested) ─────────────────────────
    //
    // After generating, flip each staff member's phase so next month they swap.
    // phase 0→1 (day→night), phase 1→0 (night→day)
    // This ensures fair rotation: not the same people always on nights.

    if (flip_phase) {
      for (const s of activeStaff) {
        await db.updateStaff(s.id, { phase: s.phase === 0 ? 1 : 0 });
      }
    }

    // ── 11. Audit ─────────────────────────────────────────────────────────────
    await db.insertAudit({
      userId: req.user.id, username: req.user.username,
      role: req.user.role, branch: req.user.branch_name,
      action: 'GENERATE_SCHEDULE',
      target: `${year}-${String(month).padStart(2, '0')}`,
      detail: `${activeStaff.length} staff · day-phase:${dayPhaseStaff.length} · night-phase:${nightPhaseStaff.length} · algo=phase-v4`,
    });

    // ── 12. Response ──────────────────────────────────────────────────────────
    // Workday O audit
    const workdayOs = [];
    for (const s of activeStaff) {
      for (const d of workdays) {
        const ds = fmt(d);
        if (entries[s.id][ds]?.code === 'O' && !leaveMap[`${s.id}_${ds}`]) {
          workdayOs.push({ staff: s.name, date: ds });
        }
      }
    }

    // Coverage report
    const coverageReport = workdays.map(d => {
      const ds = fmt(d);
      return {
        date:  ds,
        M:     generalStaff.filter(s => genDayCodes.includes(entries[s.id][ds]?.code)).length,
        N:     generalStaff.filter(s => genNightCodes.includes(entries[s.id][ds]?.code)).length,
        US_d:  usStaff.filter(s => usDayCodes.includes(entries[s.id][ds]?.code)).length,
        US_n:  usStaff.filter(s => usNightCodes.includes(entries[s.id][ds]?.code)).length,
      };
    });

    const uncoveredDays = coverageReport.filter(r =>
      r.M < minM || r.N < minN || (minU > 0 && r.US_d < minU));

    const summary = activeStaff.map(s => {
      const breakdown = {};
      for (const d of dates) {
        const code = entries[s.id][fmt(d)]?.code || 'O';
        breakdown[code] = (breakdown[code] || 0) + 1;
      }
      return {
        staff_id: s.id, staff_name: s.name,
        kind: staffKind(s),
        phase_this_month: s.phase || 0,
        phase_next_month: flip_phase ? (s.phase === 0 ? 1 : 0) : (s.phase || 0),
        starting_shift: shiftForDate(s, dates[2]), // what shift they start on (first workday)
        shifts: workCount[s.id],
        breakdown,
      };
    });

    res.json({
      schedule, entry_count: flatEntries.length,
      summary, coverage_report: coverageReport,
      uncovered_days: uncoveredDays,
      workday_os: workdayOs,
    });

  } catch (err) {
    console.error('[Generate]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
