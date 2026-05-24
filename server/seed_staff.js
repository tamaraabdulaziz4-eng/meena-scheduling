/**
 * Seed staff from all reference ROTAs into the database.
 * Run: node server/seed_staff.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const staff = [
  // ── NEST 1 ──────────────────────────────────────────────────────────────────
  // General section
  { name: 'Wafa Assiri',       phone: '0557055480', branch: 'NEST 1', speciality: ['General'],           cross: false },
  { name: 'Cheryl',            phone: null,          branch: 'NEST 1', speciality: ['General'],           cross: false },
  { name: 'Muhanned',          phone: null,          branch: 'NEST 1', speciality: ['General'],           cross: true  }, // goes to Y3
  { name: 'Elham',             phone: null,          branch: 'NEST 1', speciality: ['General'],           cross: false },
  { name: 'Aminah',            phone: null,          branch: 'NEST 1', speciality: ['General'],           cross: false },
  { name: 'Mnayer',            phone: null,          branch: 'NEST 1', speciality: ['General'],           cross: false },
  // US section
  { name: 'Rawan',             phone: null,          branch: 'NEST 1', speciality: ['Ultrasound'],        cross: false },
  { name: 'Tagreed',           phone: null,          branch: 'NEST 1', speciality: ['Ultrasound'],        cross: false },
  { name: 'Sadeem',            phone: null,          branch: 'NEST 1', speciality: ['Ultrasound'],        cross: false },
  { name: 'Alanood',           phone: null,          branch: 'NEST 1', speciality: ['Ultrasound'],        cross: false },
  { name: 'Alnoud Alrashdi',   phone: null,          branch: 'NEST 1', speciality: ['Ultrasound'],        cross: false },

  // ── NEST 2 ──────────────────────────────────────────────────────────────────
  // General section
  { name: 'Badrih',            phone: null,          branch: 'NEST 2', speciality: ['General'],           cross: false },
  { name: 'Dalal',             phone: null,          branch: 'NEST 2', speciality: ['General'],           cross: false },
  { name: 'Wedad',             phone: null,          branch: 'NEST 2', speciality: ['General'],           cross: false },
  { name: 'Layan',             phone: null,          branch: 'NEST 2', speciality: ['General'],           cross: true  }, // goes to Y3
  { name: 'Fatin',             phone: null,          branch: 'NEST 2', speciality: ['General'],           cross: false },
  { name: 'Naif',              phone: null,          branch: 'NEST 2', speciality: ['General'],           cross: false },
  { name: 'Mohammed Batt',     phone: '0547002189',  branch: 'NEST 2', speciality: ['General'],           cross: true  }, // Supervisor — floats
  // US section
  { name: 'Alhanouf Bin Ammar',phone: null,          branch: 'NEST 2', speciality: ['Ultrasound'],        cross: false },
  { name: 'Hajer AL Mutiri',   phone: '0501853719',  branch: 'NEST 2', speciality: ['Ultrasound'],        cross: false }, // Team leader
  { name: 'Joy',               phone: null,          branch: 'NEST 2', speciality: ['Ultrasound'],        cross: false },
  { name: 'Alhanouf Alazmi',   phone: null,          branch: 'NEST 2', speciality: ['Ultrasound'],        cross: false },

  // ── NEST 3 ──────────────────────────────────────────────────────────────────
  // General section
  { name: 'Duaa',              phone: null,          branch: 'NEST 3', speciality: ['General'],           cross: false },
  { name: 'Rawan Alharbi',     phone: null,          branch: 'NEST 3', speciality: ['General'],           cross: false },
  { name: 'Nourah',            phone: null,          branch: 'NEST 3', speciality: ['General'],           cross: false },
  { name: 'Abdulaziz Alanazi', phone: '0581453234',  branch: 'NEST 3', speciality: ['General'],           cross: false }, // Team leader
  { name: 'Bushra Alqahani',   phone: null,          branch: 'NEST 3', speciality: ['General'],           cross: false }, // General — above US header in PDF
  // US section
  { name: 'Alma Tolentino',    phone: null,          branch: 'NEST 3', speciality: ['Ultrasound'],        cross: false },
  { name: 'Manar',             phone: null,          branch: 'NEST 3', speciality: ['Ultrasound'],        cross: false },
  { name: 'Qamraa',            phone: null,          branch: 'NEST 3', speciality: ['Ultrasound'],        cross: false },
  { name: 'Reem Alharbi',      phone: null,          branch: 'NEST 3', speciality: ['Ultrasound'],        cross: false },

  // ── NEST 4 ──────────────────────────────────────────────────────────────────
  // General section (only 2 general staff)
  { name: 'Sara Halawani',     phone: '0565253630',  branch: 'NEST 4', speciality: ['General'],           cross: false }, // Team leader — on-call every shift (D/OC, EV/OC pattern)
  { name: 'Arob',              phone: null,          branch: 'NEST 4', speciality: ['General'],           cross: false }, // EV shifts all month
  // US section (confirmed from PDF image — Rana, Aeshah, Taif, Alaa all under US header)
  { name: 'Rana',              phone: null,          branch: 'NEST 4', speciality: ['Ultrasound'],        cross: false },
  { name: 'Aeshah',            phone: null,          branch: 'NEST 4', speciality: ['Ultrasound'],        cross: false },
  { name: 'Taif',              phone: null,          branch: 'NEST 4', speciality: ['Ultrasound'],        cross: false },
  { name: 'Alaa',              phone: null,          branch: 'NEST 4', speciality: ['Ultrasound'],        cross: false }, // Fixed B shift most of month

  // ── NEST 6 ──────────────────────────────────────────────────────────────────
  // General section
  { name: 'Mohammed',          phone: null,          branch: 'NEST 6', speciality: ['General'],           cross: true  }, // goes to Y3
  { name: 'Naif',              phone: null,          branch: 'NEST 6', speciality: ['General'],           cross: false },
  { name: 'Naif Almutari',     phone: null,          branch: 'NEST 6', speciality: ['General'],           cross: false },
  { name: 'Ruba',              phone: null,          branch: 'NEST 6', speciality: ['General'],           cross: false },
  { name: 'Shahad',            phone: null,          branch: 'NEST 6', speciality: ['General'],           cross: false },
  { name: 'Wedad N6',          phone: null,          branch: 'NEST 6', speciality: ['General'],           cross: false },
  { name: 'Layan N6',          phone: null,          branch: 'NEST 6', speciality: ['General'],           cross: false },
  { name: 'Dalal N6',          phone: null,          branch: 'NEST 6', speciality: ['General'],           cross: false },
  // US section
  { name: 'Rana N6',           phone: null,          branch: 'NEST 6', speciality: ['Ultrasound'],        cross: false },
  { name: 'Meyan',             phone: null,          branch: 'NEST 6', speciality: ['Ultrasound'],        cross: false },
  { name: 'Alanoud N6',        phone: null,          branch: 'NEST 6', speciality: ['Ultrasound'],        cross: false },
  { name: 'Hajer N6',          phone: null,          branch: 'NEST 6', speciality: ['Ultrasound'],        cross: false },
  { name: 'Alma N6',           phone: null,          branch: 'NEST 6', speciality: ['Ultrasound'],        cross: false },

  // ── AL-JUBAIL ────────────────────────────────────────────────────────────────
  { name: 'Manal Salem',       phone: '0508083660',  branch: 'Al-Jubail', speciality: ['General', 'Ultrasound'], cross: false }, // Team leader + solo
];

async function run() {
  // Get all branches
  const { rows: branches } = await pool.query(`SELECT id, name FROM scheduling.branches`);
  const branchMap = {};
  branches.forEach(b => { branchMap[b.name] = b.id; });

  console.log('Branches found:', Object.keys(branchMap));

  let inserted = 0, skipped = 0;

  for (const s of staff) {
    const branchId = branchMap[s.branch];
    if (!branchId) {
      console.warn(`  ⚠ Branch "${s.branch}" not found — skipping ${s.name}`);
      skipped++;
      continue;
    }

    // Check if already exists (by name + branch)
    const existing = await pool.query(
      `SELECT id FROM scheduling.staff WHERE name=$1 AND branch_id=$2`,
      [s.name, branchId]
    );
    if (existing.rows.length) {
      console.log(`  → Already exists: ${s.name} (${s.branch})`);
      skipped++;
      continue;
    }

    await pool.query(
      `INSERT INTO scheduling.staff (name, phone, branch_id, speciality, is_cross_branch, active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [s.name, s.phone || null, branchId, s.speciality, s.cross]
    );
    console.log(`  ✓ Added: ${s.name} — ${s.branch} [${s.speciality.join(', ')}]${s.cross ? ' ↗ cross-branch' : ''}`);
    inserted++;
  }

  console.log(`\nDone. Inserted: ${inserted}, Skipped: ${skipped}`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
