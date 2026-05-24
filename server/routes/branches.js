const router = require('express').Router();
const db     = require('../db');
const { authMiddleware, requireRole } = require('../auth');

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    res.json(await db.getAllBranches());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireRole('superadmin'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const branch = await db.insertBranch(name.trim());
    await db.insertAudit({ userId: req.user.id, username: req.user.username, role: req.user.role, action: 'CREATE_BRANCH', target: name });
    res.json(branch);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Branch already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const branch = await db.updateBranch(req.params.id, req.body.name?.trim());
    if (!branch) return res.status(404).json({ error: 'Not found' });
    res.json(branch);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    await db.deleteBranch(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
