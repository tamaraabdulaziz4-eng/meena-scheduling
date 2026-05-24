const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const { authMiddleware, requireRole } = require('../auth');

router.use(authMiddleware);

router.get('/', requireRole('superadmin'), async (req, res) => {
  try { res.json(await db.getAllUsers()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireRole('superadmin'), async (req, res) => {
  try {
    const { username, password, role, branch_id } = req.body;
    if (!username?.trim() || !password || !role) return res.status(400).json({ error: 'Missing fields' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    const hashed = await bcrypt.hash(password, 10);
    const user = await db.insertUser(username.trim().toLowerCase(), hashed, role, branch_id || null);
    await db.insertAudit({ userId: req.user.id, username: req.user.username, role: req.user.role, action: 'CREATE_USER', target: username });
    res.json(user);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const { username, role, branch_id, password } = req.body;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
      await db.updateUserPassword(req.params.id, await bcrypt.hash(password, 10));
    }
    const user = await db.updateUser(req.params.id, { username, role, branch_id });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: "Can't delete yourself" });
    await db.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
