const router = require('express').Router();
const db     = require('../db');
const { authMiddleware, requireRole } = require('../auth');

router.use(authMiddleware);

router.get('/', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    res.json(await db.getAudit(500));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
