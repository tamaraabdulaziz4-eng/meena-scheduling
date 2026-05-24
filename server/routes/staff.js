const router = require('express').Router();
const db     = require('../db');
const { authMiddleware, requireAdmin, canAccessBranch } = require('../auth');

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const branchId = req.user.role === 'superadmin' ? (req.query.branch_id || null) : req.user.branch_id;
    res.json(await db.getAllStaff(branchId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, phone, branch_id, speciality, is_cross_branch } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    if (!canAccessBranch(req.user, branch_id)) return res.status(403).json({ error: 'Forbidden' });
    const staff = await db.insertStaff({ name: name.trim(), phone, branch_id, speciality, is_cross_branch });
    await db.insertAudit({ userId: req.user.id, username: req.user.username, role: req.user.role, branch: req.user.branch_name, action: 'CREATE_STAFF', target: name });
    res.json(staff);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await db.getStaffById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (!canAccessBranch(req.user, existing.branch_id)) return res.status(403).json({ error: 'Forbidden' });
    const staff = await db.updateStaff(req.params.id, req.body);
    res.json(staff);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await db.getStaffById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (!canAccessBranch(req.user, existing.branch_id)) return res.status(403).json({ error: 'Forbidden' });
    await db.deleteStaff(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
