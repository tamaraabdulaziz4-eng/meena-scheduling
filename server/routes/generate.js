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
function runSolver(nestName, year, month, alArgs, timeoutSec = 120) {
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

    const proc = spawn('python3', args, { cwd: schedulerDir });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      // Log solver output for debugging
      if (stderr) console.log('[Solver]', stderr.trim());
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
    const [staffList, leaves, branch] = await Promise.all([
      db.getAllStaff(branch_id),
      db.getLeaves(branch_id, year, month),
      db.getBranchById(branch_id),
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

    // ── 4. Build AL args from DB leaves ───────────────────────────────────────
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

    // Convert to solver format: "SOLVER_KEY:d1,d2,d3"
    // We need to reverse-map db_name → solver key using config
    // Load config dynamically via python to get staff_db_names
    // Simpler: build reverse map by calling python once to get config
    // Even simpler: we store staff_db_names in config — read it with a quick python call

    // Get solver config (staff_db_names) once
    const schedulerDir = path.join(__dirname, '../../scheduler');
    const configJson = await new Promise((resolve, reject) => {
      const proc = spawn('python3', ['-c', `
import json, sys
sys.path.insert(0, '${schedulerDir}')
from config import NESTS
nest = NESTS.get('${nestName}', {})
out = {}
for sec_name, sec in nest.get('sections', {}).items():
    for key, db_name in sec.get('staff_db_names', {}).items():
        out[db_name.lower().strip()] = key
print(json.dumps(out))
`]);
      let out = '';
      proc.stdout.on('data', d => { out += d; });
      proc.on('close', () => {
        try { resolve(JSON.parse(out)); }
        catch (e) { resolve({}); }  // if config missing staff_db_names, proceed without AL
      });
      proc.on('error', () => resolve({}));
    });

    // configJson: { "wafa assiri": "WAFA", "cheryl": "CHERYL", ... }
    const alArgs = [];
    for (const [dbName, days] of Object.entries(alByStaff)) {
      const solverKey = configJson[dbName.toLowerCase().trim()];
      if (solverKey && days.length) {
        alArgs.push(`${solverKey}:${days.sort((a,b)=>a-b).join(',')}`);
      }
    }

    // ── 5. Run solver ─────────────────────────────────────────────────────────
    console.log(`[Generate] ${nestName} ${year}-${String(month).padStart(2,'0')} AL:`, alArgs);
    const solverResult = await runSolver(nestName, year, month, alArgs);

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

    // ── 10. Response ──────────────────────────────────────────────────────────
    const avg = summary.length ? Math.round(totalWork / summary.length) : 0;
    res.json({
      schedule,
      entry_count:   flatEntries.length,
      solver_status: solverResult.status,
      solver_elapsed: solverResult.elapsed,
      summary,
      avg_shifts:    avg,
    });

  } catch (err) {
    console.error('[Generate]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
