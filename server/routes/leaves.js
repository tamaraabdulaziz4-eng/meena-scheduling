const router = require('express').Router();
const db     = require('../db');
const { authMiddleware, requireAdmin, canAccessBranch } = require('../auth');

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const { branch_id, year, month } = req.query;
    const bid = req.user.role === 'superadmin' ? (branch_id || null) : req.user.branch_id;
    res.json(await db.getLeaves(bid, year || null, month || null));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST — accepts date_from + date_to, expands to one row per day
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { staff_id, date_from, date_to, leave_type = 'AL', note } = req.body;

    if (!staff_id || !date_from) return res.status(400).json({ error: 'staff_id and date_from required' });

    const staff = await db.getStaffById(staff_id);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    if (!canAccessBranch(req.user, staff.branch_id)) return res.status(403).json({ error: 'Forbidden' });

    // Build list of dates in range — treat as plain dates (no timezone shift)
    if (date_to && date_to < date_from)
      return res.status(400).json({ error: '"To" date must be on or after "From" date' });

    const maxDays = 365;
    const dates = [];
    const [fy, fm, fd] = date_from.split('-').map(Number);
    const [ty, tm, td] = (date_to || date_from).split('-').map(Number);
    const from = new Date(Date.UTC(fy, fm - 1, fd));
    const to   = new Date(Date.UTC(ty, tm - 1, td));

    const cur = new Date(from);
    while (cur <= to && dates.length < maxDays) {
      dates.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    // Insert one row per day (skip duplicates via ON CONFLICT DO NOTHING)
    const leaves = [];
    for (const date of dates) {
      try {
        const l = await db.insertLeave({ staff_id, date, leave_type, note, created_by: req.user.id });
        if (l) leaves.push(l);
      } catch (e) {
        // Duplicate date for same staff — skip silently
        if (!e.message?.includes('duplicate') && !e.code === '23505') throw e;
      }
    }

    res.json({ inserted: leaves.length, leaves });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteLeave(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
