require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initSchema() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS scheduling;`);

  // ── Step 1: tables with no user FK ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduling.branches (
      id         SERIAL PRIMARY KEY,
      name       TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scheduling.users (
      id         SERIAL PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'viewer',
      branch_id  INTEGER REFERENCES scheduling.branches(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scheduling.staff (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      phone            TEXT,
      branch_id        INTEGER REFERENCES scheduling.branches(id) ON DELETE SET NULL,
      speciality       TEXT[] NOT NULL DEFAULT '{"General"}',
      is_cross_branch  BOOLEAN NOT NULL DEFAULT false,
      active           BOOLEAN NOT NULL DEFAULT true,
      phase            INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scheduling.shift_types (
      id          SERIAL PRIMARY KEY,
      branch_id   INTEGER REFERENCES scheduling.branches(id) ON DELETE CASCADE,
      code        TEXT NOT NULL,
      label       TEXT NOT NULL,
      start_time  TEXT,
      end_time    TEXT,
      color       TEXT NOT NULL DEFAULT '#6B4EFF',
      is_off      BOOLEAN NOT NULL DEFAULT false,
      is_leave    BOOLEAN NOT NULL DEFAULT false,
      is_oncall   BOOLEAN NOT NULL DEFAULT false,
      sort_order  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scheduling.schedules (
      id          SERIAL PRIMARY KEY,
      branch_id   INTEGER NOT NULL REFERENCES scheduling.branches(id) ON DELETE CASCADE,
      year        INTEGER NOT NULL,
      month       INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'draft',
      created_by  INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
      reviewed_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
      approved_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP,
      approved_at TIMESTAMP,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW(),
      UNIQUE(branch_id, year, month)
    );

    CREATE TABLE IF NOT EXISTS scheduling.schedule_entries (
      id              SERIAL PRIMARY KEY,
      schedule_id     INTEGER NOT NULL REFERENCES scheduling.schedules(id) ON DELETE CASCADE,
      staff_id        INTEGER NOT NULL REFERENCES scheduling.staff(id) ON DELETE CASCADE,
      date            DATE NOT NULL,
      shift_code      TEXT NOT NULL DEFAULT 'O',
      cross_branch_id INTEGER REFERENCES scheduling.branches(id) ON DELETE SET NULL,
      is_oncall       BOOLEAN NOT NULL DEFAULT false,
      note            TEXT,
      UNIQUE(schedule_id, staff_id, date)
    );

    CREATE TABLE IF NOT EXISTS scheduling.leave_requests (
      id          SERIAL PRIMARY KEY,
      staff_id    INTEGER NOT NULL REFERENCES scheduling.staff(id) ON DELETE CASCADE,
      date        DATE NOT NULL,
      leave_type  TEXT NOT NULL DEFAULT 'AL',
      status      TEXT NOT NULL DEFAULT 'approved',
      note        TEXT,
      created_by  INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scheduling.audit_log (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER,
      username   TEXT,
      role       TEXT,
      branch     TEXT,
      action     TEXT NOT NULL,
      target     TEXT,
      detail     TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Partial unique indexes for shift_types (NULL branch_id needs special handling)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS shift_types_global_code
      ON scheduling.shift_types (code) WHERE branch_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS shift_types_branch_code
      ON scheduling.shift_types (branch_id, code) WHERE branch_id IS NOT NULL;
  `);

  // Migrations: add columns that may not exist on older DBs
  await pool.query(`
    ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS phase INTEGER NOT NULL DEFAULT 0;
  `);

  console.log('Scheduling schema ready.');
}

// ── Seed defaults ────────────────────────────────────────────────────────────
async function seedDefaults() {
  // Default branches
  const defaultBranches = [
    'NEST 1', 'NEST 2', 'NEST 3', 'NEST 4', 'NEST 6', 'Al-Jubail'
  ];
  for (const name of defaultBranches) {
    await pool.query(
      `INSERT INTO scheduling.branches (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [name]
    );
  }

  // Default shift types (global — branch_id NULL means applies to all)
  const globalShifts = [
    { code: 'M',    label: 'Morning (12h)',   start: '08:00', end: '20:00', color: '#2B9FFF', off: false, leave: false, oc: false, sort: 1 },
    { code: 'N',    label: 'Night (12h)',      start: '20:00', end: '08:00', color: '#6B4EFF', off: false, leave: false, oc: false, sort: 2 },
    { code: 'D',    label: 'Day (08–17)',        start: '08:00', end: '17:00', color: '#00C896', off: false, leave: false, oc: false, sort: 3 },
    { code: 'D1',   label: 'Day D1 (10–22)',    start: '10:00', end: '22:00', color: '#00B884', off: false, leave: false, oc: false, sort: 4 },
    { code: 'EV',   label: 'Evening (16–00)',   start: '16:00', end: '00:00', color: '#FFBA49', off: false, leave: false, oc: false, sort: 5 },
    { code: 'A',    label: 'Morning A (07–15)', start: '07:00', end: '15:00', color: '#4ECDC4', off: false, leave: false, oc: false, sort: 6 },
    { code: 'B',    label: 'Afternoon B (15–23)',start: '15:00', end: '23:00', color: '#FF9F43', off: false, leave: false, oc: false, sort: 7 },
    { code: 'C',    label: 'Night C (23–07)',   start: '23:00', end: '07:00', color: '#A29BFE', off: false, leave: false, oc: false, sort: 8 },
    { code: 'R',    label: 'Night R (20–02)',   start: '20:00', end: '02:00', color: '#B8839F', off: false, leave: false, oc: false, sort: 9 },
    { code: 'R1',   label: 'Night R1 (20–04)',  start: '20:00', end: '04:00', color: '#9B59B6', off: false, leave: false, oc: false, sort: 10 },
    { code: 'O',    label: 'Off',              start: null,    end: null,    color: '#E0E0E0', off: true,  leave: false, oc: false, sort: 11 },
    { code: 'OC',   label: 'On-Call',          start: null,    end: null,    color: '#FF6B6B', off: false, leave: false, oc: true,  sort: 12 },
    { code: 'AL',   label: 'Annual Leave',     start: null,    end: null,    color: '#FD79A8', off: false, leave: true,  oc: false, sort: 13 },
    { code: 'SL',   label: 'Sick Leave',       start: null,    end: null,    color: '#FAB1A0', off: false, leave: true,  oc: false, sort: 14 },
    { code: 'TB',   label: 'Time-Back',        start: null,    end: null,    color: '#FDCB6E', off: false, leave: true,  oc: false, sort: 15 },
    { code: 'OT',   label: 'Overtime',         start: null,    end: null,    color: '#55EFC4', off: false, leave: false, oc: false, sort: 16 },
  ];

  for (const s of globalShifts) {
    // Use partial index-safe insert: check existence first
    const exists = await pool.query(
      `SELECT id FROM scheduling.shift_types WHERE branch_id IS NULL AND code=$1`, [s.code]
    );
    if (!exists.rows.length) {
      await pool.query(`
        INSERT INTO scheduling.shift_types
          (branch_id, code, label, start_time, end_time, color, is_off, is_leave, is_oncall, sort_order)
        VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [s.code, s.label, s.start, s.end, s.color, s.off, s.leave, s.oc, s.sort]);
    }
  }

  console.log('Default branches and shift types seeded.');
}

async function seedAdmin() {
  const bcrypt = require('bcryptjs');
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASS || 'admin123';
  const hashed = await bcrypt.hash(password, 10);

  const { rows } = await pool.query(
    `SELECT id FROM scheduling.users WHERE username = $1`, [username]
  );
  if (rows.length) {
    await pool.query(
      `UPDATE scheduling.users SET password=$1, role='superadmin' WHERE username=$2`,
      [hashed, username]
    );
  } else {
    await pool.query(
      `INSERT INTO scheduling.users (username, password, role) VALUES ($1, $2, 'superadmin')`,
      [username, hashed]
    );
  }
  console.log(`Admin user "${username}" ready.`);
}

// ── BRANCHES ─────────────────────────────────────────────────────────────────
async function getAllBranches() {
  const { rows } = await pool.query(
    `SELECT id, name, created_at FROM scheduling.branches ORDER BY name`
  );
  return rows;
}
async function getBranchById(id) {
  const { rows } = await pool.query(`SELECT id, name FROM scheduling.branches WHERE id=$1`, [id]);
  return rows[0] || null;
}
async function insertBranch(name) {
  const { rows } = await pool.query(
    `INSERT INTO scheduling.branches (name) VALUES ($1) RETURNING id, name, created_at`, [name]
  );
  return rows[0];
}
async function updateBranch(id, name) {
  const { rows } = await pool.query(
    `UPDATE scheduling.branches SET name=$1 WHERE id=$2 RETURNING id, name`, [name, id]
  );
  return rows[0] || null;
}
async function deleteBranch(id) {
  await pool.query(`DELETE FROM scheduling.branches WHERE id=$1`, [id]);
}

// ── USERS ─────────────────────────────────────────────────────────────────────
async function getUserByUsername(username) {
  const { rows } = await pool.query(
    `SELECT u.*, b.name AS branch_name FROM scheduling.users u
     LEFT JOIN scheduling.branches b ON b.id = u.branch_id
     WHERE u.username=$1`, [username]
  );
  return rows[0] || null;
}
async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.branch_id, u.created_at, b.name AS branch_name
     FROM scheduling.users u
     LEFT JOIN scheduling.branches b ON b.id = u.branch_id
     WHERE u.id=$1`, [id]
  );
  return rows[0] || null;
}
async function getAllUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.branch_id, u.created_at, b.name AS branch_name
     FROM scheduling.users u
     LEFT JOIN scheduling.branches b ON b.id = u.branch_id
     ORDER BY u.created_at`
  );
  return rows;
}
async function insertUser(username, hashedPw, role, branchId) {
  const { rows } = await pool.query(
    `INSERT INTO scheduling.users (username, password, role, branch_id)
     VALUES ($1,$2,$3,$4) RETURNING id, username, role, branch_id, created_at`,
    [username, hashedPw, role, branchId || null]
  );
  return rows[0];
}
async function updateUser(id, fields) {
  const sets = []; const params = []; let i = 1;
  if (fields.username  !== undefined) { sets.push(`username=$${i++}`);  params.push(fields.username); }
  if (fields.role      !== undefined) { sets.push(`role=$${i++}`);      params.push(fields.role); }
  if (fields.branch_id !== undefined) { sets.push(`branch_id=$${i++}`); params.push(fields.branch_id || null); }
  if (!sets.length) return getUserById(id);
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE scheduling.users SET ${sets.join(',')} WHERE id=$${i} RETURNING id, username, role, branch_id, created_at`,
    params
  );
  return rows[0] || null;
}
async function updateUserPassword(id, hashed) {
  await pool.query(`UPDATE scheduling.users SET password=$1 WHERE id=$2`, [hashed, id]);
}
async function deleteUser(id) {
  await pool.query(`DELETE FROM scheduling.users WHERE id=$1`, [id]);
}

// ── STAFF ─────────────────────────────────────────────────────────────────────
async function getAllStaff(branchId) {
  const params = [];
  let q = `SELECT s.*, b.name AS branch_name FROM scheduling.staff s
           LEFT JOIN scheduling.branches b ON b.id = s.branch_id`;
  if (branchId) { q += ` WHERE s.branch_id=$1`; params.push(branchId); }
  q += ` ORDER BY b.name, s.name`;
  const { rows } = await pool.query(q, params);
  return rows;
}
async function getStaffById(id) {
  const { rows } = await pool.query(
    `SELECT s.*, b.name AS branch_name FROM scheduling.staff s
     LEFT JOIN scheduling.branches b ON b.id = s.branch_id WHERE s.id=$1`, [id]
  );
  return rows[0] || null;
}
async function insertStaff({ name, phone, branch_id, speciality, is_cross_branch }) {
  const { rows } = await pool.query(
    `INSERT INTO scheduling.staff (name, phone, branch_id, speciality, is_cross_branch)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, phone || null, branch_id || null, speciality || ['General'], is_cross_branch || false]
  );
  return rows[0];
}
async function updateStaff(id, fields) {
  const sets = []; const params = []; let i = 1;
  if (fields.name             !== undefined) { sets.push(`name=$${i++}`);             params.push(fields.name); }
  if (fields.phone            !== undefined) { sets.push(`phone=$${i++}`);            params.push(fields.phone || null); }
  if (fields.branch_id        !== undefined) { sets.push(`branch_id=$${i++}`);        params.push(fields.branch_id || null); }
  if (fields.speciality       !== undefined) { sets.push(`speciality=$${i++}`);       params.push(fields.speciality); }
  if (fields.is_cross_branch  !== undefined) { sets.push(`is_cross_branch=$${i++}`);  params.push(fields.is_cross_branch); }
  if (fields.active           !== undefined) { sets.push(`active=$${i++}`);           params.push(fields.active); }
  if (fields.phase            !== undefined) { sets.push(`phase=$${i++}`);            params.push(fields.phase); }
  if (!sets.length) return getStaffById(id);
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE scheduling.staff SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, params
  );
  return rows[0] || null;
}
async function deleteStaff(id) {
  await pool.query(`DELETE FROM scheduling.staff WHERE id=$1`, [id]);
}

// ── SHIFT TYPES ───────────────────────────────────────────────────────────────
async function getShiftTypes(branchId) {
  // Returns effective view: global (branch_id NULL) + branch-specific merged,
  // branch-specific overrides global for same code
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (code) id, branch_id, code, label, start_time, end_time,
           color, is_off, is_leave, is_oncall, sort_order
    FROM scheduling.shift_types
    WHERE branch_id IS NULL OR branch_id = $1
    ORDER BY code, branch_id DESC NULLS LAST, sort_order
  `, [branchId || 0]);
  return rows.sort((a, b) => a.sort_order - b.sort_order);
}

async function getAllShiftTypes() {
  // Returns ALL rows (global + every branch override) — for admin settings page
  const { rows } = await pool.query(`
    SELECT st.id, st.branch_id, st.code, st.label, st.start_time, st.end_time,
           st.color, st.is_off, st.is_leave, st.is_oncall, st.sort_order,
           b.name AS branch_name
    FROM scheduling.shift_types st
    LEFT JOIN scheduling.branches b ON b.id = st.branch_id
    ORDER BY st.code, st.branch_id NULLS FIRST, st.sort_order
  `);
  return rows;
}

async function upsertShiftType({ branch_id, code, label, start_time, end_time, color, is_off, is_leave, is_oncall, sort_order }) {
  const bid = branch_id || null;
  // Check for existing
  const existing = await pool.query(
    bid
      ? `SELECT id FROM scheduling.shift_types WHERE branch_id=$1 AND code=$2`
      : `SELECT id FROM scheduling.shift_types WHERE branch_id IS NULL AND code=$1`,
    bid ? [bid, code] : [code]
  );
  if (existing.rows.length) {
    const { rows } = await pool.query(`
      UPDATE scheduling.shift_types SET label=$1, start_time=$2, end_time=$3, color=$4,
        is_off=$5, is_leave=$6, is_oncall=$7, sort_order=$8
      WHERE id=$9 RETURNING *
    `, [label, start_time||null, end_time||null, color||'#6B4EFF',
        is_off||false, is_leave||false, is_oncall||false, sort_order||0, existing.rows[0].id]);
    return rows[0];
  }
  const { rows } = await pool.query(`
    INSERT INTO scheduling.shift_types
      (branch_id, code, label, start_time, end_time, color, is_off, is_leave, is_oncall, sort_order)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
  `, [bid, code, label, start_time||null, end_time||null,
      color||'#6B4EFF', is_off||false, is_leave||false, is_oncall||false, sort_order||0]);
  return rows[0];
}

async function updateShiftType(id, fields) {
  const sets = []; const params = []; let i = 1;
  if (fields.label      !== undefined) { sets.push(`label=$${i++}`);      params.push(fields.label); }
  if (fields.start_time !== undefined) { sets.push(`start_time=$${i++}`); params.push(fields.start_time || null); }
  if (fields.end_time   !== undefined) { sets.push(`end_time=$${i++}`);   params.push(fields.end_time || null); }
  if (fields.color      !== undefined) { sets.push(`color=$${i++}`);      params.push(fields.color); }
  if (fields.is_off     !== undefined) { sets.push(`is_off=$${i++}`);     params.push(fields.is_off); }
  if (fields.is_leave   !== undefined) { sets.push(`is_leave=$${i++}`);   params.push(fields.is_leave); }
  if (fields.is_oncall  !== undefined) { sets.push(`is_oncall=$${i++}`);  params.push(fields.is_oncall); }
  if (fields.sort_order !== undefined) { sets.push(`sort_order=$${i++}`); params.push(fields.sort_order); }
  if (!sets.length) { const r = await pool.query(`SELECT * FROM scheduling.shift_types WHERE id=$1`,[id]); return r.rows[0]||null; }
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE scheduling.shift_types SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, params
  );
  return rows[0] || null;
}

async function deleteShiftType(id) {
  await pool.query(`DELETE FROM scheduling.shift_types WHERE id=$1`, [id]);
}

// ── SCHEDULES ─────────────────────────────────────────────────────────────────
async function getSchedule(branchId, year, month) {
  const { rows } = await pool.query(`
    SELECT s.*, b.name AS branch_name,
           uc.username AS created_by_name,
           ur.username AS reviewed_by_name,
           ua.username AS approved_by_name
    FROM scheduling.schedules s
    JOIN scheduling.branches b ON b.id = s.branch_id
    LEFT JOIN scheduling.users uc ON uc.id = s.created_by
    LEFT JOIN scheduling.users ur ON ur.id = s.reviewed_by
    LEFT JOIN scheduling.users ua ON ua.id = s.approved_by
    WHERE s.branch_id=$1 AND s.year=$2 AND s.month=$3
  `, [branchId, year, month]);
  return rows[0] || null;
}
async function getAllSchedules(branchId) {
  const params = [];
  let q = `SELECT s.id, s.branch_id, s.year, s.month, s.status, s.created_at, s.updated_at,
                  b.name AS branch_name
           FROM scheduling.schedules s
           JOIN scheduling.branches b ON b.id = s.branch_id`;
  if (branchId) { q += ` WHERE s.branch_id=$1`; params.push(branchId); }
  q += ` ORDER BY s.year DESC, s.month DESC`;
  const { rows } = await pool.query(q, params);
  return rows;
}
async function upsertSchedule(branchId, year, month, userId) {
  const { rows } = await pool.query(`
    INSERT INTO scheduling.schedules (branch_id, year, month, status, created_by)
    VALUES ($1,$2,$3,'draft',$4)
    ON CONFLICT (branch_id, year, month) DO UPDATE SET updated_at=NOW()
    RETURNING *
  `, [branchId, year, month, userId || null]);
  return rows[0];
}
async function updateScheduleStatus(id, status, userId) {
  let extra = '';
  const params = [status, id];
  if (status === 'reviewed')  { extra = `, reviewed_by=$3, reviewed_at=NOW()`; params.splice(2, 0, userId); }
  if (status === 'approved')  { extra = `, approved_by=$3, approved_at=NOW()`; params.splice(2, 0, userId); }
  const { rows } = await pool.query(
    `UPDATE scheduling.schedules SET status=$1, updated_at=NOW()${extra} WHERE id=$2 RETURNING *`,
    params
  );
  return rows[0] || null;
}
async function deleteSchedule(id) {
  await pool.query(`DELETE FROM scheduling.schedules WHERE id=$1`, [id]);
}

// ── SCHEDULE ENTRIES ──────────────────────────────────────────────────────────
async function getEntries(scheduleId) {
  const { rows } = await pool.query(`
    SELECT e.id, e.schedule_id, e.staff_id,
           TO_CHAR(e.date, 'YYYY-MM-DD') AS date,
           e.shift_code, e.cross_branch_id, e.is_oncall, e.note,
           s.name AS staff_name, s.speciality, s.is_cross_branch,
           b.name AS cross_branch_name
    FROM scheduling.schedule_entries e
    JOIN scheduling.staff s ON s.id = e.staff_id
    LEFT JOIN scheduling.branches b ON b.id = e.cross_branch_id
    WHERE e.schedule_id=$1
    ORDER BY s.name, e.date
  `, [scheduleId]);
  return rows;
}
async function upsertEntry({ schedule_id, staff_id, date, shift_code, cross_branch_id, is_oncall, note }) {
  const { rows } = await pool.query(`
    INSERT INTO scheduling.schedule_entries
      (schedule_id, staff_id, date, shift_code, cross_branch_id, is_oncall, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (schedule_id, staff_id, date) DO UPDATE SET
      shift_code=$4, cross_branch_id=$5, is_oncall=$6, note=$7
    RETURNING *
  `, [schedule_id, staff_id, date, shift_code || 'O',
      cross_branch_id || null, is_oncall || false, note || null]);
  return rows[0];
}
async function bulkUpsertEntries(entries) {
  if (!entries.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      await client.query(`
        INSERT INTO scheduling.schedule_entries
          (schedule_id, staff_id, date, shift_code, cross_branch_id, is_oncall, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (schedule_id, staff_id, date) DO UPDATE SET
          shift_code=$4, cross_branch_id=$5, is_oncall=$6, note=$7
      `, [e.schedule_id, e.staff_id, e.date, e.shift_code || 'O',
          e.cross_branch_id || null, e.is_oncall || false, e.note || null]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
async function deleteEntry(scheduleId, staffId, date) {
  await pool.query(
    `DELETE FROM scheduling.schedule_entries WHERE schedule_id=$1 AND staff_id=$2 AND date=$3`,
    [scheduleId, staffId, date]
  );
}
async function clearScheduleEntries(scheduleId) {
  await pool.query(`DELETE FROM scheduling.schedule_entries WHERE schedule_id=$1`, [scheduleId]);
}

// ── LEAVE ─────────────────────────────────────────────────────────────────────
async function getLeaves(branchId, year, month) {
  let q = `
    SELECT l.id, l.staff_id, TO_CHAR(l.date, 'YYYY-MM-DD') AS date,
           l.leave_type, l.status, l.note, l.created_by, l.created_at,
           s.name AS staff_name, s.branch_id, b.name AS branch_name
    FROM scheduling.leave_requests l
    JOIN scheduling.staff s ON s.id = l.staff_id
    LEFT JOIN scheduling.branches b ON b.id = s.branch_id
    WHERE 1=1
  `;
  const params = [];
  if (branchId) { q += ` AND s.branch_id=$${params.length+1}`; params.push(branchId); }
  if (year)     { q += ` AND EXTRACT(YEAR FROM l.date)=$${params.length+1}`;  params.push(year); }
  if (month)    { q += ` AND EXTRACT(MONTH FROM l.date)=$${params.length+1}`; params.push(month); }
  q += ` ORDER BY l.date`;
  const { rows } = await pool.query(q, params);
  return rows;
}
async function insertLeave({ staff_id, date, leave_type, note, created_by }) {
  const { rows } = await pool.query(`
    INSERT INTO scheduling.leave_requests (staff_id, date, leave_type, status, note, created_by)
    VALUES ($1,$2,$3,'approved',$4,$5) RETURNING *
  `, [staff_id, date, leave_type || 'AL', note || null, created_by || null]);
  return rows[0];
}
async function deleteLeave(id) {
  await pool.query(`DELETE FROM scheduling.leave_requests WHERE id=$1`, [id]);
}

// ── AUDIT ─────────────────────────────────────────────────────────────────────
async function insertAudit({ userId, username, role, branch, action, target, detail }) {
  await pool.query(
    `INSERT INTO scheduling.audit_log (user_id, username, role, branch, action, target, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId || null, username || null, role || null, branch || null,
     action, target || null, detail || null]
  );
}
async function getAudit(limit = 300) {
  const { rows } = await pool.query(
    `SELECT id, username, role, branch, action, target, detail, created_at
     FROM scheduling.audit_log ORDER BY created_at DESC LIMIT $1`, [limit]
  );
  return rows;
}

const schemaReady = initSchema()
  .then(seedDefaults)
  .catch(err => {
    console.error('Schema init failed:', err);
    process.exit(1);
  });

module.exports = {
  pool, schemaReady, seedAdmin,
  getAllBranches, getBranchById, insertBranch, updateBranch, deleteBranch,
  getUserByUsername, getUserById, getAllUsers, insertUser, updateUser, updateUserPassword, deleteUser,
  getAllStaff, getStaffById, insertStaff, updateStaff, deleteStaff,
  getShiftTypes, getAllShiftTypes, upsertShiftType, updateShiftType, deleteShiftType,
  getSchedule, getAllSchedules, upsertSchedule, updateScheduleStatus, deleteSchedule,
  getEntries, upsertEntry, bulkUpsertEntries, deleteEntry, clearScheduleEntries,
  getLeaves, insertLeave, deleteLeave,
  insertAudit, getAudit,
};
