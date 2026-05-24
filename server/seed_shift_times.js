/**
 * Seed per-branch shift time overrides from PDF legends.
 * Run: node server/seed_shift_times.js
 *
 * Global defaults (branch_id NULL) stay as-is.
 * Each entry here creates/updates a branch-specific override row.
 *
 * PDF sources:
 *  NEST 1: D=08–17, EV=13–21, A=07–15, B=15–23, C=23–07, D1=10–22
 *  NEST 2: D1=08–17:30, EV=13–21, A=07–15, B=15–23, C=23–07, R=20–02, R1=20–04, D1Y3=09–21
 *  NEST 3: D1=10–22, EV=14–22, A=08–16, B=15–23, C=23–07, R=20–02, D1Y3=09–21
 *  NEST 4: D=08–16, EV=16–00, A=08–16, B=15–23, C=23–07
 *  NEST 6: D=08–17, EV=13–21, A=08–16, B=15–23, C=00–08, D1=09–21
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Helper: get or derive sort_order from global
async function getGlobalSort(code) {
  const r = await pool.query(
    `SELECT sort_order FROM scheduling.shift_types WHERE branch_id IS NULL AND code=$1`, [code]
  );
  return r.rows[0]?.sort_order || 99;
}

const branchOverrides = [
  // ── NEST 1 ────────────────────────────────────────────────────────────────
  // D: 08:00–17:00 (PDF: "08:00 AM – 05:00 PM")
  { branch: 'NEST 1', code: 'D',  label: 'Day D (08–17)',      start: '08:00', end: '17:00' },
  // EV: 13:00–21:00 (PDF: "13:00 PM – 21:00 PM")
  { branch: 'NEST 1', code: 'EV', label: 'Evening EV (13–21)', start: '13:00', end: '21:00' },
  // A: 07:00–15:00
  { branch: 'NEST 1', code: 'A',  label: 'Morning A (07–15)',  start: '07:00', end: '15:00' },
  // C: 23:00–07:00 (PDF: "C : 23:00PM – 07:00 AM")
  { branch: 'NEST 1', code: 'C',  label: 'Night C (23–07)',    start: '23:00', end: '07:00' },
  // D1: 10:00–22:00
  { branch: 'NEST 1', code: 'D1', label: 'Day D1 (10–22)',     start: '10:00', end: '22:00' },

  // ── NEST 2 ────────────────────────────────────────────────────────────────
  // D1: 08:00–17:30 (PDF: "D1: 08:00 A.M - 17:30 PM")
  { branch: 'NEST 2', code: 'D1', label: 'Day D1 (08–17:30)',  start: '08:00', end: '17:30' },
  // EV: 13:00–21:00
  { branch: 'NEST 2', code: 'EV', label: 'Evening EV (13–21)', start: '13:00', end: '21:00' },
  // A: 07:00–15:00
  { branch: 'NEST 2', code: 'A',  label: 'Morning A (07–15)',  start: '07:00', end: '15:00' },
  // C: 23:00–07:00
  { branch: 'NEST 2', code: 'C',  label: 'Night C (23–07)',    start: '23:00', end: '07:00' },
  // R: 20:00–02:00
  { branch: 'NEST 2', code: 'R',  label: 'Night R (20–02)',    start: '20:00', end: '02:00' },
  // R1: 20:00–04:00
  { branch: 'NEST 2', code: 'R1', label: 'Night R1 (20–04)',   start: '20:00', end: '04:00' },

  // ── NEST 3 ────────────────────────────────────────────────────────────────
  // D1: 10:00–22:00 (PDF: "D1: 10:00 A.M - 22:00 PM")
  { branch: 'NEST 3', code: 'D1', label: 'Day D1 (10–22)',     start: '10:00', end: '22:00' },
  // EV: 14:00–22:00 (PDF: "EV: 14:00 – 22:00 PM") — DIFFERENT from global!
  { branch: 'NEST 3', code: 'EV', label: 'Evening EV (14–22)', start: '14:00', end: '22:00' },
  // A: 08:00–16:00 (PDF: "A: 8:00AM - 16:00PM")
  { branch: 'NEST 3', code: 'A',  label: 'Morning A (08–16)',  start: '08:00', end: '16:00' },
  // C: 23:00–07:00 (PDF: "C: 23:00PM – 07:00AM")
  { branch: 'NEST 3', code: 'C',  label: 'Night C (23–07)',    start: '23:00', end: '07:00' },
  // R: 20:00–02:00
  { branch: 'NEST 3', code: 'R',  label: 'Night R (20–02)',    start: '20:00', end: '02:00' },

  // ── NEST 4 ────────────────────────────────────────────────────────────────
  // D: 08:00–16:00 (PDF: "8AM–4PM")
  { branch: 'NEST 4', code: 'D',  label: 'Day D (08–16)',      start: '08:00', end: '16:00' },
  // EV: 16:00–00:00 (PDF: "4PM–12AM") — DIFFERENT from global!
  { branch: 'NEST 4', code: 'EV', label: 'Evening EV (16–00)', start: '16:00', end: '00:00' },
  // A: 08:00–16:00
  { branch: 'NEST 4', code: 'A',  label: 'Morning A (08–16)',  start: '08:00', end: '16:00' },
  // C: 23:00–07:00
  { branch: 'NEST 4', code: 'C',  label: 'Night C (23–07)',    start: '23:00', end: '07:00' },

  // ── NEST 6 ────────────────────────────────────────────────────────────────
  // D: 08:00–17:00 (PDF: "D: 08:00 AM – 5 PM")
  { branch: 'NEST 6', code: 'D',  label: 'Day D (08–17)',      start: '08:00', end: '17:00' },
  // EV: 13:00–21:00 (PDF: "EV: 13:00 PM – 21:00 PM")
  { branch: 'NEST 6', code: 'EV', label: 'Evening EV (13–21)', start: '13:00', end: '21:00' },
  // A: 08:00–16:00 (PDF: "A: 8:00AM – 16:00PM")
  { branch: 'NEST 6', code: 'A',  label: 'Morning A (08–16)',  start: '08:00', end: '16:00' },
  // C: 00:00–08:00 (PDF: "C: 12:00AM – 8:00AM") — DIFFERENT from global!
  { branch: 'NEST 6', code: 'C',  label: 'Night C (00–08)',    start: '00:00', end: '08:00' },
  // D1: 09:00–21:00 (PDF: "D1: 09:00 AM – 21:00 PM")
  { branch: 'NEST 6', code: 'D1', label: 'Day D1 (09–21)',     start: '09:00', end: '21:00' },
];

async function run() {
  // Build branch name → id map
  const { rows: branches } = await pool.query(`SELECT id, name FROM scheduling.branches`);
  const branchMap = {};
  branches.forEach(b => { branchMap[b.name] = b.id; });

  // Get global colors/flags for reference
  const { rows: globals } = await pool.query(
    `SELECT code, color, is_off, is_leave, is_oncall, sort_order FROM scheduling.shift_types WHERE branch_id IS NULL`
  );
  const globalMap = {};
  globals.forEach(g => { globalMap[g.code] = g; });

  let inserted = 0, updated = 0, skipped = 0;

  for (const o of branchOverrides) {
    const branchId = branchMap[o.branch];
    if (!branchId) {
      console.warn(`  ⚠ Branch "${o.branch}" not found — skipping ${o.code}`);
      skipped++;
      continue;
    }

    const g = globalMap[o.code] || {};
    const color     = g.color     || '#6B4EFF';
    const is_off    = g.is_off    || false;
    const is_leave  = g.is_leave  || false;
    const is_oncall = g.is_oncall || false;
    const sort_order = g.sort_order || 99;

    // Check if branch override already exists
    const existing = await pool.query(
      `SELECT id, start_time, end_time FROM scheduling.shift_types WHERE branch_id=$1 AND code=$2`,
      [branchId, o.code]
    );

    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.start_time === o.start && row.end_time === o.end) {
        console.log(`  → Already correct: ${o.branch} / ${o.code} (${o.start}–${o.end})`);
        skipped++;
        continue;
      }
      await pool.query(
        `UPDATE scheduling.shift_types SET label=$1, start_time=$2, end_time=$3 WHERE id=$4`,
        [o.label, o.start, o.end, row.id]
      );
      console.log(`  ✏ Updated: ${o.branch} / ${o.code}: ${row.start_time}–${row.end_time} → ${o.start}–${o.end}`);
      updated++;
    } else {
      await pool.query(`
        INSERT INTO scheduling.shift_types
          (branch_id, code, label, start_time, end_time, color, is_off, is_leave, is_oncall, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [branchId, o.code, o.label, o.start, o.end, color, is_off, is_leave, is_oncall, sort_order]);
      console.log(`  ✓ Created: ${o.branch} / ${o.code} (${o.start}–${o.end})`);
      inserted++;
    }
  }

  console.log(`\nDone. Inserted: ${inserted}, Updated: ${updated}, Skipped: ${skipped}`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
