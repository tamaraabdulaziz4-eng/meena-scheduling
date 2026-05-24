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

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { staff_id, date, leave_type, note } = req.body;
    if (!staff_id || !date) return res.status(400).json({ error: 'staff_id and date required' });
    const staff = await db.getStaffById(staff_id);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    if (!canAccessBranch(req.user, staff.branch_id)) return res.status(403).json({ error: 'Forbidden' });
    const leave = await db.insertLeave({ staff_id, date, leave_type, note, created_by: req.user.id });
    res.json(leave);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteLeave(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
