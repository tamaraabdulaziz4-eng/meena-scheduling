/**
 * Schedule generator — delegates to Python CP-SAT solver
 *
 * Flow:
 *   1. Load staff + leaves from DB
 *   2. Build AL schedule map (staff db_name → [day numbers])
 *   3. Determine nest name from branch
 *   4. Spawn Python solver: generator.py --nest X --year Y --month M --al ... --json
 *   5. Parse JSON output → { SOLVER_KEY: [code, ...], ... }
 *   6. Map solver keys → staff DB ids (via config staff_db_names)
 *   7. Save entries to DB (same as before)
 */

const router     = require('express').Router();
const { spawn }  = require('child_process');
const path       = require('path');
const db         = require('../db');
const { authMiddleware, requireAdmin, canAccessBranch } = require('../auth');

router.use(authMiddleware);

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Map branch name → solver nest key */
function branchToNest(branchName) {
  const n = (branchName || '').toUpperCase();
  if (n.includes('NEST 1') || n.includes('NEST1')) return 'NEST1';
  if (n.includes('NEST 2') || n.includes('NEST2')) return 'NEST2';
  if (n.includes('NEST 3') || n.includes('NEST3')) return 'NEST3';
  if (n.includes('NEST 4') || n.includes('NEST4')) return 'NEST4';
  if (n.includes('NEST 6') || n.includes('NEST6')) return 'NEST6';
  if (n.includes('Y5'))                             return 'Y5';
  return null;
}

/** Run the Python solver, return parsed JSON result */
function runSolver(nestName, year, month, alArgs, prevTail = {}, dominantArg = null, timeoutSec = 120, configArg = null) {
  return new Promise((resolve, reject) => {
    const schedulerDir = path.join(__dirname, '../../scheduler');
    const args = [
      'generator.py',
      '--nest',    nestName,
      '--year',    String(year),
      '--month',   String(month),
      '--timeout', String(timeoutSec),
      '--json',
    ];
    if (alArgs.length) args.push('--al', ...alArgs);
    if (Object.keys(prevTail).length) {
      args.push('--prev-tail', JSON.stringify(prevTail));
    }
    if (dominantArg) {
      args.push('--dominant', dominantArg);
    }
    if (configArg) {
      args.push('--config', configArg);
    }

    console.log('[Solver] cmd: python3', args.join(' '));
    const proc = spawn('python3', args, { cwd: schedulerDir });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      // Log solver output for debugging
      if (stderr) console.log('[Solver stderr]', stderr.trim());
      if (stdout) console.log('[Solver stdout raw]', stdout.slice(0, 500));
      if (code !== 0) return reject(new Error(`Solver exited ${code}: ${stderr.slice(0, 300)}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Solver JSON parse error: ${e.message}\nOutput: ${stdout.slice(0, 300)}`));
      }
    });

    proc.on('error', err => reject(new Error(`Failed to start solver: ${err.message}`)));
  });
}

// ── Main route ────────────────────────────────────────────────────────────────

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { branch_id, year, month } = req.body;
    if (!canAccessBranch(req.user, branch_id))
      return res.status(403).json({ error: 'Forbidden' });

    // ── 1. Load data ──────────────────────────────────────────────────────────
    // Also load last 3 days of previous month for cross-month boundary enforcement
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;

    const [staffList, leaves, branch, prevTail] = await Promise.all([
      db.getAllStaff(branch_id),
      db.getLeaves(branch_id, year, month),
      db.getBranchById(branch_id),
      db.getLastDaysOfMonth(branch_id, prevYear, prevMonth, 3).catch(() => []),
    ]);

    const activeStaff = staffList.filter(s => s.active);
    if (!activeStaff.length)
      return res.status(400).json({ error: 'No active staff for this branch' });

    // ── 2. Determine nest ─────────────────────────────────────────────────────
    const nestName = branchToNest(branch?.name);
    if (!nestName)
      return res.status(400).json({ error: `Branch "${branch?.name}" not mapped to a nest. Contact admin.` });

    // ── 3. Build name → staff map (db name, case-insensitive) ─────────────────
    // e.g. "Wafa Assiri" → staff object
    const nameToStaff = {};
    for (const s of activeStaff) {
      nameToStaff[s.name.toLowerCase().trim()] = s;
    }

    // ── 4. Load nest config from DB ───────────────────────────────────────────
    const nestSections = await db.getNestConfig(nestName);

    // Build nestConfig in the format expected by generator.py:
    // { "sections": { "General": { staff, staff_db_names, allowed_shifts, coverage, exact } } }
    const nestConfigForSolver = { sections: {} };
    for (const sec of nestSections) {
      nestConfigForSolver.sections[sec.section_name] = {
        staff:          sec.staff,
        staff_db_names: sec.staff_db_names,
        allowed_shifts: sec.allowed_shifts,
        coverage:       sec.coverage,
        exact:          sec.exact_coverage,
      };
    }

    // Build configJson: { db_name_lower → solver_key }  (from DB config)
    const configJson = {};
    for (const sec of nestSections) {
      for (const [solverKey, dbName] of Object.entries(sec.staff_db_names || {})) {
        configJson[dbName.toLowerCase().trim()] = solverKey;
      }
    }

    // ── 5. Build AL args from DB leaves ───────────────────────────────────────
    // leaves from DB: { staff_id, date, leave_type }
    // Group by staff name, collect day numbers
    const alByStaff = {}; // db_name → [day, ...]
    for (const lv of leaves) {
      const s = activeStaff.find(x => x.id === lv.staff_id);
      if (!s) continue;
      const day = new Date(lv.date).getUTCDate();
      if (!alByStaff[s.name]) alByStaff[s.name] = [];
      alByStaff[s.name].push(day);
    }

    // configJson: { "wafa assiri": "WAFA", "cheryl": "CHERYL", ... }
    const alArgs = [];
    for (const [dbName, days] of Object.entries(alByStaff)) {
      const solverKey = configJson[dbName.toLowerCase().trim()];
      if (solverKey && days.length) {
        alArgs.push(`${solverKey}:${days.sort((a,b)=>a-b).join(',')}`);
      }
    }

    // ── 5. Build prev-month tail for cross-month boundary ─────────────────────
    // Format: { "SOLVER_KEY": ["M","N","O"] }  (last 3 days, oldest first)
    const prevTailBySolver = {};
    for (const row of prevTail) {
      const solverKey = configJson[row.staff_name.toLowerCase().trim()];
      if (!solverKey) continue;
      if (!prevTailBySolver[solverKey]) prevTailBySolver[solverKey] = [];
      prevTailBySolver[solverKey].push(row.shift_code);
    }

    // ── 6. Run solver ─────────────────────────────────────────────────────────
    console.log(`[Generate] ${nestName} ${year}-${String(month).padStart(2,'0')} AL:`, alArgs);
    console.log(`[Generate] prev-month tail:`, prevTailBySolver);
    // Pass DB config as JSON so solver doesn't need to read config.py for nest structure
    const configArg = nestSections.length ? JSON.stringify(nestConfigForSolver) : null;
    const solverResult = await runSolver(nestName, year, month, alArgs, prevTailBySolver, null, 120, configArg);

    if (solverResult.status === 'INFEASIBLE') {
      return res.status(422).json({
        error: 'Solver could not find a valid schedule. Check staff count and AL dates.',
        solver_status: solverResult.status,
      });
    }

    if (!solverResult.schedule || !Object.keys(solverResult.schedule).length) {
      return res.status(500).json({ error: 'Solver returned empty schedule', solver_status: solverResult.status });
    }

    // solverResult.schedule: { "WAFA": ["M","O","N",...], ... }

    // ── 6. Reverse map: solver key → staff id ─────────────────────────────────
    // configJson is { db_name_lower → solver_key }; invert it
    const solverKeyToDbNameLower = {};
    for (const [dbNameL, solverKey] of Object.entries(configJson)) {
      solverKeyToDbNameLower[solverKey] = dbNameL;
    }

    const daysInMonth = new Date(year, month, 0).getDate();
    const dates = Array.from({ length: daysInMonth }, (_, i) => new Date(year, month - 1, i + 1));

    // ── 7. Build flat entries ─────────────────────────────────────────────────
    const flatEntries = [];
    const summary     = [];
    let   totalWork   = 0;

    for (const [solverKey, row] of Object.entries(solverResult.schedule)) {
      const dbNameL = solverKeyToDbNameLower[solverKey];
      const staff   = dbNameL ? nameToStaff[dbNameL] : null;

      if (!staff) {
        console.warn(`[Generate] Solver key "${solverKey}" not matched to any DB staff — skipping`);
        continue;
      }

      let workCount = 0;
      for (let i = 0; i < daysInMonth; i++) {
        const ds   = fmt(dates[i]);
        const code = row[i] || 'O';
        if (!['O','AL','SL'].includes(code)) workCount++;
        flatEntries.push({
          schedule_id:    null,   // filled after upsert below
          staff_id:       staff.id,
          date:           ds,
          shift_code:     code,
          cross_branch_id: null,
          is_oncall:      false,
          note:           null,
        });
      }

      totalWork += workCount;
      summary.push({ staff_id: staff.id, staff_name: staff.name, shifts: workCount });
    }

    // ── 8. Persist ────────────────────────────────────────────────────────────
    const schedule = await db.upsertSchedule(branch_id, year, month, req.user.id);
    await db.clearScheduleEntries(schedule.id);

    // Fill in schedule_id now that we have it
    for (const e of flatEntries) e.schedule_id = schedule.id;
    await db.bulkUpsertEntries(flatEntries);

    // ── 9. Audit ──────────────────────────────────────────────────────────────
    await db.insertAudit({
      userId:   req.user.id,
      username: req.user.username,
      role:     req.user.role,
      branch:   req.user.branch_name,
      action:   'GENERATE_SCHEDULE',
      target:   `${year}-${String(month).padStart(2, '0')}`,
      detail:   `${summary.length} staff · nest=${nestName} · solver=${solverResult.status} · ${solverResult.elapsed}s`,
    });

    // ── 10. Build dominant map keyed by staff_id for the UI ──────────────────
    // solverResult.dominant: { "WAFA": "M", "CHERYL": "N", ... }
    // We send back:
    //   dominant:         { staff_id → shift_code }  for display
    //   dominant_raw:     { solver_key → shift_code } for re-generating
    //   solver_key_by_id: { staff_id → solver_key }  for building overrides in UI
    // ── 11. Response ──────────────────────────────────────────────────────────
    const avg = summary.length ? Math.round(totalWork / summary.length) : 0;
    res.json({
      schedule,
      entry_count:    flatEntries.length,
      solver_status:  solverResult.status,
      solver_elapsed: solverResult.elapsed,
      summary,
      avg_shifts:     avg,
    });

  } catch (err) {
    console.error('[Generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /generate/allowed-shifts?branch_id=X ─────────────────────────────────
// Returns { sections: { sec_name: { staff: [...], allowed_shifts: [...] } } }
// Used by the frontend to filter the shift picker per staff member.
router.get('/allowed-shifts', async (req, res) => {
  try {
    const branch_id = Number(req.query.branch_id);
    if (!branch_id) return res.status(400).json({ error: 'branch_id required' });

    const branch = await db.getBranchById(branch_id);
    const nestName = branchToNest(branch?.name);
    if (!nestName) return res.json({ sections: {}, staff_allowed: {} });

    // Load from DB instead of reading config.py
    const nestSections = await db.getNestConfig(nestName);

    // Build result: { "General": { allowed_shifts: [...], staff_db_names: {...} }, ... }
    const result = {};
    for (const sec of nestSections) {
      result[sec.section_name] = {
        allowed_shifts: sec.allowed_shifts,
        staff_db_names: sec.staff_db_names,
      };
    }

    // Map db_name (lower) → section name, so frontend can look up by staff name
    const dbNameToSection = {};
    const sectionAllowed  = {};
    for (const [secName, secData] of Object.entries(result)) {
      sectionAllowed[secName] = secData.allowed_shifts || [];
      for (const dbName of Object.values(secData.staff_db_names || {})) {
        dbNameToSection[dbName.toLowerCase().trim()] = secName;
      }
    }

    // Load staff to map staff_id → allowed shifts via their db name
    const staffList = await db.getAllStaff(branch_id);
    const staffIdToAllowed = {};
    for (const s of staffList) {
      const secName = dbNameToSection[s.name.toLowerCase().trim()];
      if (secName) {
        staffIdToAllowed[s.id] = sectionAllowed[secName] || [];
      }
    }

    res.json({
      nest: nestName,
      sections: result,
      staff_allowed: staffIdToAllowed,   // { staff_id: [shift_codes] }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
