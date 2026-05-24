const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { getUserByUsername } = require('../db');
const { signToken, authMiddleware } = require('../auth');

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = await getUserByUsername(username.trim().toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({
      id: user.id, username: user.username,
      role: user.role, branch_id: user.branch_id,
      branch_name: user.branch_name
    });

    res.cookie('token', token, {
      httpOnly: true, sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.json({
      id: user.id, username: user.username,
      role: user.role, branch_id: user.branch_id,
      branch_name: user.branch_name
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', authMiddleware, (req, res) => {
  res.json(req.user);
});

module.exports = router;
