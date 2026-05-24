const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'scheduling_secret';

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.token || req.headers?.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// Admin or superadmin
function requireAdmin(req, res, next) {
  return requireRole('admin', 'superadmin')(req, res, next);
}

// Check if user can access a branch (superadmin = all, admin/viewer = own branch)
function canAccessBranch(user, branchId) {
  if (user.role === 'superadmin') return true;
  return String(user.branch_id) === String(branchId);
}

module.exports = { signToken, verifyToken, authMiddleware, requireRole, requireAdmin, canAccessBranch };
