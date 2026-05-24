/**
 * Nest config CRUD — admin only
 *
 * GET    /api/nest-config                 → all nests (grouped)
 * GET    /api/nest-config/:nestKey        → sections for one nest
 * PUT    /api/nest-config/:nestKey/:sectionName  → upsert section
 * DELETE /api/nest-config/:id            → delete section by id
 */

const router = require('express').Router();
const db     = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');

router.use(authMiddleware);

// ── GET all nests ─────────────────────────────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const rows = await db.getAllNestConfigs();
    // Group by nest_key
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.nest_key]) grouped[row.nest_key] = [];
      grouped[row.nest_key].push(row);
    }
    res.json({ nests: grouped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET one nest ──────────────────────────────────────────────────────────────
router.get('/:nestKey', async (req, res) => {
  try {
    const rows = await db.getNestConfig(req.params.nestKey.toUpperCase());
    res.json({ sections: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT (upsert) section ──────────────────────────────────────────────────────
router.put('/:nestKey/:sectionName', requireAdmin, async (req, res) => {
  try {
    const nest_key     = req.params.nestKey.toUpperCase();
    const section_name = req.params.sectionName;
    const {
      staff, staff_db_names, allowed_shifts,
      coverage, exact_coverage, sort_order,
    } = req.body;

    if (!Array.isArray(staff))          return res.status(400).json({ error: 'staff must be array' });
    if (!Array.isArray(allowed_shifts)) return res.status(400).json({ error: 'allowed_shifts must be array' });

    const row = await db.upsertNestSection({
      nest_key, section_name,
      staff, staff_db_names: staff_db_names || {},
      allowed_shifts, coverage: coverage || {},
      exact_coverage: exact_coverage || {},
      sort_order: sort_order ?? 0,
    });

    await db.insertAudit({
      userId:   req.user.id,
      username: req.user.username,
      role:     req.user.role,
      branch:   req.user.branch_name,
      action:   'UPDATE_NEST_CONFIG',
      target:   `${nest_key}/${section_name}`,
      detail:   `staff=${staff.length} allowed_shifts=${allowed_shifts.join(',')}`,
    });

    res.json({ section: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE section by id ──────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    await db.deleteNestSection(id);

    await db.insertAudit({
      userId:   req.user.id,
      username: req.user.username,
      role:     req.user.role,
      branch:   req.user.branch_name,
      action:   'DELETE_NEST_SECTION',
      target:   String(id),
      detail:   null,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
