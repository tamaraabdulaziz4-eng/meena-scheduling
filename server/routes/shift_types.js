const router = require('express').Router();
const db     = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');

router.use(authMiddleware);

// GET /shift-types?branch_id=X  — effective merged view for a branch (used by scheduler)
router.get('/', async (req, res) => {
  try {
    const branchId = req.query.branch_id || req.user.branch_id;
    res.json(await db.getShiftTypes(branchId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /shift-types/all  — every row: global + all branch overrides (used by settings page)
router.get('/all', async (req, res) => {
  try {
    res.json(await db.getAllShiftTypes());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /shift-types  — create or upsert (by code+branch combo)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const st = await db.upsertShiftType(req.body);
    res.json(st);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /shift-types/:id  — update specific row by id
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const st = await db.updateShiftType(req.params.id, req.body);
    if (!st) return res.status(404).json({ error: 'Not found' });
    res.json(st);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /shift-types/:id  — only branch overrides can be deleted (global protected in UI)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteShiftType(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
