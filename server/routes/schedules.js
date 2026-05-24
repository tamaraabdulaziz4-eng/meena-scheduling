const router = require('express').Router();
const db     = require('../db');
const { authMiddleware, requireAdmin, canAccessBranch } = require('../auth');

router.use(authMiddleware);

// List schedules
router.get('/', async (req, res) => {
  try {
    const branchId = req.user.role === 'superadmin' ? (req.query.branch_id || null) : req.user.branch_id;
    res.json(await db.getAllSchedules(branchId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get or create a schedule for branch/year/month
router.post('/open', requireAdmin, async (req, res) => {
  try {
    const { branch_id, year, month } = req.body;
    if (!canAccessBranch(req.user, branch_id)) return res.status(403).json({ error: 'Forbidden' });
    const schedule = await db.upsertSchedule(branch_id, year, month, req.user.id);
    const entries  = await db.getEntries(schedule.id);
    res.json({ schedule, entries });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get entries for a schedule
router.get('/:id/entries', async (req, res) => {
  try {
    res.json(await db.getEntries(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save a single entry (cell edit)
router.put('/:id/entries', requireAdmin, async (req, res) => {
  try {
    const entry = await db.upsertEntry({ schedule_id: req.params.id, ...req.body });
    res.json(entry);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk save entries (after generate)
router.put('/:id/entries/bulk', requireAdmin, async (req, res) => {
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries must be array' });
    const withId = entries.map(e => ({ ...e, schedule_id: Number(req.params.id) }));
    await db.bulkUpsertEntries(withId);
    await db.insertAudit({ userId: req.user.id, username: req.user.username, role: req.user.role, branch: req.user.branch_name, action: 'BULK_SAVE', target: `schedule:${req.params.id}`, detail: `${entries.length} entries` });
    res.json({ ok: true, count: entries.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clear all entries for a schedule
router.delete('/:id/entries', requireAdmin, async (req, res) => {
  try {
    await db.clearScheduleEntries(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update schedule status (draft → submitted → reviewed → approved)
router.put('/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['draft', 'submitted', 'reviewed', 'approved'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    // Role gates
    if (status === 'reviewed' && req.user.role === 'admin') return res.status(403).json({ error: 'Only supervisor/superadmin can review' });
    if (status === 'approved' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only manager can approve' });

    const schedule = await db.updateScheduleStatus(req.params.id, status, req.user.id);
    await db.insertAudit({ userId: req.user.id, username: req.user.username, role: req.user.role, branch: req.user.branch_name, action: `SCHEDULE_${status.toUpperCase()}`, target: `schedule:${req.params.id}` });
    res.json(schedule);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a schedule
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteSchedule(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
