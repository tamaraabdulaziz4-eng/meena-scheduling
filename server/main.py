"""
Meena Health Radiology — FastAPI server
Replaces Node.js/Express. Same DB, same dashboard, same API paths.

Run:
    python -m uvicorn server.main:app --port 3002 --reload
"""

import os, sys, json, math, re, uuid, threading, mimetypes, hashlib, calendar as _cal

# Load .env from project root
_env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
if os.path.exists(_env_path):
    for _line in open(_env_path):
        _line = _line.strip()
        if _line and not _line.startswith('#') and '=' in _line:
            _k, _v = _line.split('=', 1)
            os.environ.setdefault(_k.strip(), _v.strip())
from datetime import datetime, date, timezone, timedelta
from typing import Optional, Any

import bcrypt
import psycopg2
import psycopg2.extras
import psycopg2.pool
from jose import jwt, JWTError
from fastapi import FastAPI, Request, Response, HTTPException, Depends, Cookie, Query
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

# Always put this file's dir on sys.path so bare sibling imports (webpush,
# consent_pdf) resolve whether we're launched as the `server.main` package
# (gunicorn, cwd=/app) or as a standalone script. Under the package launch,
# `from server import webpush` succeeds but bare `import consent_pdf` would NOT —
# so the path insert must happen unconditionally, not only in the fallback.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:                                   # local module, same package
    from server import webpush as _webpush
except Exception:                      # standalone / script import fallback
    import webpush as _webpush

# ── Config ────────────────────────────────────────────────────────────────────

DATABASE_URL = os.environ.get("DATABASE_URL", "")
JWT_SECRET   = os.environ.get("JWT_SECRET", "scheduling_secret")
JWT_ALG      = "HS256"
JWT_DAYS     = 30
ADMIN_USER   = os.environ.get("ADMIN_USER", "admin")
# No insecure default — a hardcoded fallback (e.g. "admin123") meant any deploy
# that forgot to set ADMIN_PASS shipped with a publicly-known superadmin login.
# When unset, seed_admin() generates a strong random password and logs it once.
ADMIN_PASS   = os.environ.get("ADMIN_PASS")

# ── DB connection pool ────────────────────────────────────────────────────────
# One pool per worker process — keeps 2 connections warm, up to 10 max.
# Eliminates the ~200ms SSL handshake cost on every request.

_pool: psycopg2.pool.ThreadedConnectionPool | None = None

def get_pool() -> psycopg2.pool.ThreadedConnectionPool:
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            # maxconn matches the request threadpool so a burst of clicks doesn't hit
            # "connection pool exhausted"; keepalives stop Neon from silently dropping
            # idle SSL connections (which forced a full-pool rebuild storm before).
            minconn=2, maxconn=int(os.environ.get("DB_MAXCONN") or 24),
            dsn=DATABASE_URL,
            cursor_factory=psycopg2.extras.RealDictCursor,
            keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3,
        )
    return _pool

def q(sql, params=(), *, one=False, many=False, exec_only=False):
    """Run a query using a pooled connection.
    Neon closes idle SSL connections; we detect stale connections and retry once
    with a fresh connection so callers never see 'SSL connection closed' errors.
    """
    # Neon can drop idle SSL connections. We retry and, if needed, rebuild the
    # whole pool so requests return normally instead of bubbling OperationalError.
    for attempt in range(3):
        pool = get_pool()
        conn = pool.getconn()
        try:
            # No preemptive conn.reset() here — it cost a full network round-trip on
            # EVERY query. A dropped/stale connection raises OperationalError on
            # execute (handled below with a retry + pool rebuild), and the generic
            # except rolls back so connections are always returned to the pool clean.
            #
            # Run the single statement in autocommit: the server commits it implicitly
            # in the SAME round-trip, so we avoid the separate COMMIT round-trip that
            # doubled latency on every query (a big deal against a remote Neon DB —
            # ~2x fewer round-trips per read). Multi-statement transactions never use
            # this helper (they take pool.getconn() directly and do manual
            # commit/rollback), and we always hand the connection back with autocommit
            # OFF, so their atomicity is unaffected.
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(sql, params)
                if exec_only:
                    result = None
                elif one:
                    row = cur.fetchone()
                    result = dict(row) if row else None
                else:
                    result = [dict(r) for r in cur.fetchall()]
            conn.autocommit = False
            pool.putconn(conn)
            return result
        except (psycopg2.OperationalError, psycopg2.InterfaceError):
            # Connection is dead (Neon dropped the idle SSL conn, or it was already
            # closed) — discard it and retry with a fresh one. InterfaceError
            # ("connection already closed") is a sibling of OperationalError and must
            # be retried the same way, not fall through to the generic handler.
            try:
                conn.autocommit = False
            except Exception:
                pass
            try:
                pool.putconn(conn, close=True)
            except Exception:
                pass
            # If we've already retried once, rebuild the pool (fresh SSL conns).
            if attempt == 1:
                global _pool
                try:
                    if _pool is not None:
                        _pool.closeall()
                except Exception:
                    pass
                _pool = None
            if attempt == 2:
                raise   # third attempt also failed, give up
        except Exception:
            # A query error (constraint violation, etc.). The connection is usually
            # fine after a rollback, so return it healthy; but if the rollback itself
            # raises (dead connection), discard it closed. Either way the connection
            # MUST go back to the pool — putconn is in its OWN try so a failing
            # rollback can never leak it.
            bad = False
            try:
                conn.autocommit = False
                conn.rollback()
            except Exception:
                bad = True
            try:
                pool.putconn(conn, close=bad)
            except Exception:
                pass
            raise

# ── Schema init ───────────────────────────────────────────────────────────────

def _direct_conn():
    """One-off connection for startup only (pool not ready yet)."""
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)

def init_schema():
    with _direct_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE SCHEMA IF NOT EXISTS scheduling;")

            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.branches (
                    id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS scheduling.users (
                    id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer',
                    branch_id INTEGER REFERENCES scheduling.branches(id) ON DELETE SET NULL,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS scheduling.staff (
                    id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT,
                    branch_id INTEGER REFERENCES scheduling.branches(id) ON DELETE SET NULL,
                    speciality TEXT[] NOT NULL DEFAULT '{"General"}',
                    is_cross_branch BOOLEAN NOT NULL DEFAULT false,
                    active BOOLEAN NOT NULL DEFAULT true,
                    phase INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS scheduling.shift_types (
                    id SERIAL PRIMARY KEY,
                    branch_id INTEGER REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    code TEXT NOT NULL, label TEXT NOT NULL,
                    start_time TEXT, end_time TEXT,
                    color TEXT NOT NULL DEFAULT '#6B4EFF',
                    is_off BOOLEAN NOT NULL DEFAULT false,
                    is_leave BOOLEAN NOT NULL DEFAULT false,
                    is_oncall BOOLEAN NOT NULL DEFAULT false,
                    sort_order INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS scheduling.schedules (
                    id SERIAL PRIMARY KEY,
                    branch_id INTEGER NOT NULL REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    year INTEGER NOT NULL, month INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'draft',
                    is_locked BOOLEAN NOT NULL DEFAULT false,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    reviewed_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    approved_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    reviewed_at TIMESTAMP, approved_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(branch_id, year, month)
                );
                ALTER TABLE scheduling.schedules ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false;
                ALTER TABLE scheduling.schedules ADD COLUMN IF NOT EXISTS review_note TEXT;
                CREATE TABLE IF NOT EXISTS scheduling.schedule_entries (
                    id SERIAL PRIMARY KEY,
                    schedule_id INTEGER NOT NULL REFERENCES scheduling.schedules(id) ON DELETE CASCADE,
                    staff_id INTEGER NOT NULL REFERENCES scheduling.staff(id) ON DELETE CASCADE,
                    date DATE NOT NULL, shift_code TEXT NOT NULL DEFAULT 'O',
                    cross_branch_id INTEGER REFERENCES scheduling.branches(id) ON DELETE SET NULL,
                    is_oncall BOOLEAN NOT NULL DEFAULT false,
                    note TEXT,
                    UNIQUE(schedule_id, staff_id, date)
                );
                CREATE TABLE IF NOT EXISTS scheduling.leave_requests (
                    id SERIAL PRIMARY KEY,
                    staff_id INTEGER NOT NULL REFERENCES scheduling.staff(id) ON DELETE CASCADE,
                    date DATE NOT NULL, leave_type TEXT NOT NULL DEFAULT 'AL',
                    status TEXT NOT NULL DEFAULT 'approved', note TEXT,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(staff_id, date)
                );
                CREATE TABLE IF NOT EXISTS scheduling.audit_log (
                    id SERIAL PRIMARY KEY, user_id INTEGER, username TEXT,
                    role TEXT, branch TEXT, action TEXT NOT NULL,
                    target TEXT, detail TEXT, created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS scheduling.nest_sections (
                    id SERIAL PRIMARY KEY,
                    nest_key TEXT NOT NULL, section_name TEXT NOT NULL,
                    staff TEXT[] NOT NULL DEFAULT '{}',
                    staff_db_names JSONB NOT NULL DEFAULT '{}',
                    allowed_shifts TEXT[] NOT NULL DEFAULT '{}',
                    coverage JSONB NOT NULL DEFAULT '{}',
                    exact_coverage JSONB NOT NULL DEFAULT '{}',
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(nest_key, section_name)
                );
            """)

            # Unique indexes for shift_types
            cur.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS shift_types_global_code
                    ON scheduling.shift_types (code) WHERE branch_id IS NULL;
                CREATE UNIQUE INDEX IF NOT EXISTS shift_types_branch_code
                    ON scheduling.shift_types (branch_id, code) WHERE branch_id IS NOT NULL;
            """)

            # Migrations
            # Shift types were originally supported as global (branch_id NULL) with
            # optional per-branch overrides. The app no longer uses branch-specific
            # shift types, so we consolidate everything into a single global list.
            #
            # Keep one row per code (prefer existing global), delete duplicates,
            # and set remaining branch_id to NULL.
            cur.execute("""
                WITH ranked AS (
                  SELECT id,
                         ROW_NUMBER() OVER (
                           PARTITION BY code
                           ORDER BY (branch_id IS NULL) DESC, id ASC
                         ) AS rn
                  FROM scheduling.shift_types
                )
                DELETE FROM scheduling.shift_types st
                USING ranked r
                WHERE st.id = r.id AND r.rn > 1;
            """)
            cur.execute("UPDATE scheduling.shift_types SET branch_id=NULL WHERE branch_id IS NOT NULL;")

            # Hand-entered cells are flagged so a later regenerate keeps them
            # (the solver builds the rest of the month around them).
            cur.execute("ALTER TABLE scheduling.schedule_entries ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT false;")

            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS phase INTEGER NOT NULL DEFAULT 0;")
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS min_shifts INTEGER NOT NULL DEFAULT 0;")
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS max_shifts INTEGER NOT NULL DEFAULT 17;")
            # NOTE: do NOT re-backfill max_shifts here. The column is NOT NULL DEFAULT 17,
            # so it is never NULL — an UPDATE …WHERE max_shifts=0 would run on every boot
            # and silently reset any staff an admin intentionally set to 0 (e.g. on long
            # leave / not to be scheduled). The DEFAULT already covers brand-new rows.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.section_month_settings (
                    id SERIAL PRIMARY KEY,
                    section_id INTEGER NOT NULL REFERENCES scheduling.nest_sections(id) ON DELETE CASCADE,
                    year INTEGER NOT NULL,
                    month INTEGER NOT NULL,
                    min_m INTEGER NOT NULL DEFAULT 1,
                    max_m INTEGER NOT NULL DEFAULT 2,
                    min_n INTEGER NOT NULL DEFAULT 1,
                    max_n INTEGER NOT NULL DEFAULT 2,
                    max_consecutive INTEGER NOT NULL DEFAULT 4,
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(section_id, year, month)
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.branch_settings (
                    id SERIAL PRIMARY KEY,
                    branch_id INTEGER UNIQUE NOT NULL REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    max_consecutive INTEGER NOT NULL DEFAULT 4,
                    min_shifts_default INTEGER NOT NULL DEFAULT 17,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS scheduling.staff_month_settings (
                    id SERIAL PRIMARY KEY,
                    staff_id INTEGER NOT NULL REFERENCES scheduling.staff(id) ON DELETE CASCADE,
                    year INTEGER NOT NULL,
                    month INTEGER NOT NULL,
                    min_shifts INTEGER NOT NULL DEFAULT 0,
                    max_shifts INTEGER NOT NULL DEFAULT 17,
                    max_consecutive INTEGER NOT NULL DEFAULT 4,
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(staff_id, year, month)
                );
            """)
            # Safe now that staff_month_settings exists (was previously run too early).
            cur.execute("ALTER TABLE scheduling.staff_month_settings ADD COLUMN IF NOT EXISTS max_consecutive INTEGER NOT NULL DEFAULT 4;")
            # Cross-branch staff sharing: a branch can lend its surplus staff, and
            # we only pair branches in the same city.
            cur.execute("ALTER TABLE scheduling.branches ADD COLUMN IF NOT EXISTS city TEXT;")
            cur.execute("ALTER TABLE scheduling.branches ADD COLUMN IF NOT EXISTS shares_staff BOOLEAN NOT NULL DEFAULT false;")
            # A target branch (e.g. Y3) that's staffed by importing General staff
            # from same-city sharing branches: how many it needs each working day.
            cur.execute("ALTER TABLE scheduling.branches ADD COLUMN IF NOT EXISTS cover_need_per_day INTEGER NOT NULL DEFAULT 0;")
            # Branch isolation for radiology ("كل فرع لفرعه"): the Siratech HIS site
            # id that this Meena branch maps to. When set, branch-locked team leads
            # (role=admin) only see this site's radiology stats/requests — never
            # another branch's PHI. superadmin/manager stay organisation-wide.
            # Left NULL until the owner confirms each branch's HIS site number, so
            # nothing is silently restricted before the mapping exists.
            cur.execute("ALTER TABLE scheduling.branches ADD COLUMN IF NOT EXISTS siratech_site_id INTEGER;")
            # Radiology WRITE privilege: staff can VIEW the worklist/reports and sign
            # consent by default, but FILING a result into the live HIS is off until a
            # superadmin grants this per-user flag. Team leads/managers/superadmin can
            # always file (their role implies it); this flag only elevates a `staff`.
            cur.execute("ALTER TABLE scheduling.users ADD COLUMN IF NOT EXISTS can_file_radiology BOOLEAN NOT NULL DEFAULT false;")
            # Radiology ACCESS privilege: a staff member sees/uses the radiology
            # worklist only when a superadmin grants this (so access is given to
            # certain people, not every staff account). Team leads/managers/superadmin
            # always have access by role. Filing (can_file_radiology) implies access.
            cur.execute("ALTER TABLE scheduling.users ADD COLUMN IF NOT EXISTS can_use_radiology BOOLEAN NOT NULL DEFAULT false;")
            # Per-user PERMISSION OVERRIDES: a JSON map {permKey: true|false} that grants
            # (true) or revokes (false) an individual feature on top of the role defaults.
            # Empty {} = pure role defaults. Only a superadmin edits it. See PERMISSION_KEYS.
            cur.execute("ALTER TABLE scheduling.users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;")
            # For older DBs created before `min_shifts_default` existed.
            cur.execute("ALTER TABLE scheduling.branch_settings ADD COLUMN IF NOT EXISTS min_shifts_default INTEGER NOT NULL DEFAULT 17;")
            # For older DBs created before section max_consecutive existed.
            cur.execute("ALTER TABLE scheduling.section_month_settings ADD COLUMN IF NOT EXISTS max_consecutive INTEGER NOT NULL DEFAULT 4;")
            # For O (Off) block policy (per-section per-month). 1 disables.
            cur.execute("ALTER TABLE scheduling.section_month_settings ADD COLUMN IF NOT EXISTS min_o_block INTEGER NOT NULL DEFAULT 2;")
            # If the column already existed from a previous deploy, ensure new
            # rows default to 2 (no isolated Off days).
            cur.execute("ALTER TABLE scheduling.section_month_settings ALTER COLUMN min_o_block SET DEFAULT 2;")
            # Max consecutive Off (Off) days per section per month. 0 disables
            # (unlimited). Set e.g. 3 to forbid runs of 4+ rest days in a row.
            cur.execute("ALTER TABLE scheduling.section_month_settings ADD COLUMN IF NOT EXISTS max_o_block INTEGER NOT NULL DEFAULT 0;")
            # Note: older DBs may have extra columns; migrations are additive.

            # ── Feature tables: notifications, leave workflow, swaps, holidays ──
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.notifications (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES scheduling.users(id) ON DELETE CASCADE,
                    type TEXT NOT NULL DEFAULT 'info',
                    message TEXT NOT NULL,
                    link TEXT,
                    is_read BOOLEAN NOT NULL DEFAULT false,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS notifications_user_unread
                    ON scheduling.notifications (user_id, is_read);

                CREATE TABLE IF NOT EXISTS scheduling.push_subscriptions (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES scheduling.users(id) ON DELETE CASCADE,
                    endpoint TEXT NOT NULL UNIQUE,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    user_agent TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS push_subscriptions_user
                    ON scheduling.push_subscriptions (user_id);

                CREATE TABLE IF NOT EXISTS scheduling.shift_swaps (
                    id SERIAL PRIMARY KEY,
                    branch_id INTEGER REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    year INTEGER NOT NULL, month INTEGER NOT NULL,
                    staff_a INTEGER NOT NULL REFERENCES scheduling.staff(id) ON DELETE CASCADE,
                    date_a DATE NOT NULL,
                    staff_b INTEGER NOT NULL REFERENCES scheduling.staff(id) ON DELETE CASCADE,
                    date_b DATE NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    note TEXT,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    decided_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    decided_at TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS scheduling.holidays (
                    id SERIAL PRIMARY KEY,
                    date DATE NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_at TIMESTAMP DEFAULT NOW()
                );
            """)
            # Leave requests gained an approval workflow; older rows stay 'approved'.
            cur.execute("ALTER TABLE scheduling.leave_requests ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';")
            # The shift a sick-leave (SL) replaced on the rota, so we can suggest
            # cover for exactly that shift later.
            cur.execute("ALTER TABLE scheduling.leave_requests ADD COLUMN IF NOT EXISTS covered_shift TEXT;")
            # Time-back / compensation claims: a staffer who covered a shift, worked
            # an off-day, did extra/overtime or took an on-call raises a claim; once
            # approved (team lead -> manager) it credits one day to their balance,
            # and a TB leave they later take debits it.
            cur.execute("""CREATE TABLE IF NOT EXISTS scheduling.timeback_claims (
                               id SERIAL PRIMARY KEY,
                               staff_id INTEGER NOT NULL REFERENCES scheduling.staff(id) ON DELETE CASCADE,
                               date DATE NOT NULL,
                               reason TEXT NOT NULL DEFAULT 'covered',
                               days NUMERIC NOT NULL DEFAULT 1,
                               note TEXT,
                               status TEXT NOT NULL DEFAULT 'pending',
                               created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                               reviewed_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                               reviewed_at TIMESTAMP,
                               created_at TIMESTAMP DEFAULT NOW()
                           );""")
            # Org-wide key/value settings (e.g. the leave-request cutoff day).
            cur.execute("""CREATE TABLE IF NOT EXISTS scheduling.app_settings (
                               key TEXT PRIMARY KEY, value TEXT);""")
            cur.execute("""INSERT INTO scheduling.app_settings (key,value) VALUES ('leave_cutoff_day','15')
                           ON CONFLICT (key) DO NOTHING;""")
            # Secure radiology-CD transfer: a branch uploads a full CD image (ISO/ZIP)
            # via a token link; an authorised user downloads it to import into PACS.
            # Files are auto-deleted after a short TTL; the row is the operations log.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.cd_transfers (
                    id SERIAL PRIMARY KEY,
                    ref TEXT UNIQUE NOT NULL,
                    upload_id TEXT,
                    file_no TEXT,
                    branch TEXT,
                    exam_type TEXT,
                    exam_date TEXT,
                    uploader TEXT,
                    patient_initials TEXT,
                    note TEXT,
                    orig_name TEXT,
                    stored_name TEXT,
                    kind TEXT,
                    size_bytes BIGINT NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'uploading',
                    dicom_check TEXT,
                    upload_ip TEXT,
                    download_ip TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    uploaded_at TIMESTAMPTZ,
                    downloaded_at TIMESTAMPTZ,
                    expires_at TIMESTAMPTZ
                );""")
            cur.execute("ALTER TABLE scheduling.cd_transfers ADD COLUMN IF NOT EXISTS file_count INT NOT NULL DEFAULT 0;")
            # Signed radiology consents (e.g. Declaration of Non-Pregnancy). The
            # completed, signed PDF is stored so it can be viewed/downloaded and filed
            # into the patient's Siratech/DePACS record.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.consents (
                    id SERIAL PRIMARY KEY,
                    kind TEXT NOT NULL DEFAULT 'non_pregnancy',
                    file_no TEXT NOT NULL,
                    mrn TEXT,
                    patient_name TEXT,
                    procedure TEXT,
                    patient_type TEXT,
                    reason TEXT,
                    lmp_date TEXT,
                    physician TEXT,
                    technologist TEXT,
                    bill_no TEXT,
                    site INT,
                    pdf BYTEA NOT NULL,
                    filed_siratech BOOLEAN NOT NULL DEFAULT false,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_by_name TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_consents_file ON scheduling.consents(file_no);")
            # QR / remote-signing support: a pending consent carries a one-time token
            # the patient opens on her own phone; the PDF is filled in only once she
            # signs, so `pdf` must be nullable and status tracks pending → signed.
            cur.execute("ALTER TABLE scheduling.consents ALTER COLUMN pdf DROP NOT NULL;")
            for col, typ in (("token", "TEXT"), ("status", "TEXT NOT NULL DEFAULT 'signed'"),
                             ("dob", "TEXT"), ("branch", "TEXT"), ("weight", "TEXT"),
                             ("height", "TEXT"), ("hcg", "TEXT"), ("signed_at", "TIMESTAMPTZ"),
                             ("expires_at", "TIMESTAMPTZ"),
                             # patient_name holds the DISPLAY name (Arabic for Arab patients);
                             # patient_name_en keeps the English name for the Siratech filing
                             # name-match, which compares against the HIS row's (English) name.
                             ("patient_name_en", "TEXT")):
                cur.execute(f"ALTER TABLE scheduling.consents ADD COLUMN IF NOT EXISTS {col} {typ};")
            cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_consents_token ON scheduling.consents(token) WHERE token IS NOT NULL;")
            # QR document upload: a one-time token the tech/patient opens on a phone to
            # snap or pick a document (outside report, referral, external lab); the file
            # is stored here, then filed to the patient's Siratech record. status flows
            # pending → uploaded → filed (or failed).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.doc_uploads (
                    id SERIAL PRIMARY KEY,
                    file_no TEXT NOT NULL,
                    mrn TEXT,
                    patient_name TEXT,
                    bill_no TEXT,
                    site INT,
                    doc_name TEXT,
                    pdf BYTEA,
                    status TEXT NOT NULL DEFAULT 'pending',
                    note TEXT,
                    token TEXT,
                    filed_siratech BOOLEAN NOT NULL DEFAULT false,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_by_name TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    uploaded_at TIMESTAMPTZ,
                    expires_at TIMESTAMPTZ
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_docup_file ON scheduling.doc_uploads(file_no);")
            cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_docup_token ON scheduling.doc_uploads(token) WHERE token IS NOT NULL;")
            # A 'staff' user account is linked to one staff record (self-service portal).
            cur.execute("ALTER TABLE scheduling.users ADD COLUMN IF NOT EXISTS staff_id INTEGER REFERENCES scheduling.staff(id) ON DELETE SET NULL;")
            # Session epoch: bumped on password change to invalidate old tokens.
            cur.execute("ALTER TABLE scheduling.users ADD COLUMN IF NOT EXISTS token_epoch INTEGER NOT NULL DEFAULT 0;")
            # Email + per-user opt-out for emailed notifications.
            cur.execute("ALTER TABLE scheduling.users ADD COLUMN IF NOT EXISTS email TEXT;")
            cur.execute("ALTER TABLE scheduling.users ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN NOT NULL DEFAULT true;")
            # Daily radiology-cases report (one row per branch per day).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.daily_cases (
                    id SERIAL PRIMARY KEY,
                    branch_id INTEGER NOT NULL REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    date DATE NOT NULL,
                    xray INT NOT NULL DEFAULT 0, ct INT NOT NULL DEFAULT 0, us INT NOT NULL DEFAULT 0,
                    mamo INT NOT NULL DEFAULT 0, bmd INT NOT NULL DEFAULT 0, insert_cd INT NOT NULL DEFAULT 0,
                    total_pt INT NOT NULL DEFAULT 0,
                    bmd_not_done INT NOT NULL DEFAULT 0, mamo_not_done INT NOT NULL DEFAULT 0,
                    locked BOOLEAN NOT NULL DEFAULT false,
                    submitted_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    submitted_at TIMESTAMP, updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(branch_id, date)
                );""")
            # Per-staff override: allowed to file the daily cases report.
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS can_report BOOLEAN NOT NULL DEFAULT false;")
            # Self-service onboarding fields — Employee/National ID disambiguates
            # staff who share a name. ID is unique when present (partial index).
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS employee_id TEXT;")
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS email TEXT;")
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS self_registered BOOLEAN NOT NULL DEFAULT false;")
            cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_employee_id
                           ON scheduling.staff(employee_id) WHERE employee_id IS NOT NULL;""")
            # Self-registrations wait here for the branch team lead to approve.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.staff_registrations (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    branch_id INTEGER REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    employee_id TEXT, email TEXT, phone TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    staff_id INTEGER REFERENCES scheduling.staff(id) ON DELETE SET NULL,
                    reviewed_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    reviewed_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("ALTER TABLE scheduling.staff_registrations ADD COLUMN IF NOT EXISTS section TEXT DEFAULT 'General';")
            # Self-registrants choose their own login now (username + password),
            # so an approved account can sign in — not just exist as a staff row.
            cur.execute("ALTER TABLE scheduling.staff_registrations ADD COLUMN IF NOT EXISTS username TEXT;")
            cur.execute("ALTER TABLE scheduling.staff_registrations ADD COLUMN IF NOT EXISTS password TEXT;")
            # Role-scoped invite links: a registration can target staff (default),
            # team-lead (admin) or manager. Higher roles need superadmin approval.
            cur.execute("ALTER TABLE scheduling.staff_registrations ADD COLUMN IF NOT EXISTS requested_role TEXT DEFAULT 'staff';")
            # Join date + current annual-leave balance (carried from Meena self-service
            # at sign-up) so we can track leave accrual (21 days/year) from here on.
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS join_date DATE;")
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS leave_balance NUMERIC(5,1) NOT NULL DEFAULT 0;")
            # When the balance above was recorded — accrual (22 days/yr) counts from here.
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS leave_balance_date DATE;")
            cur.execute("ALTER TABLE scheduling.staff_registrations ADD COLUMN IF NOT EXISTS join_date DATE;")
            cur.execute("ALTER TABLE scheduling.staff_registrations ADD COLUMN IF NOT EXISTS leave_balance NUMERIC(5,1) DEFAULT 0;")
            # Password-reset tokens (forgot-password via email). Stored hashed.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.password_resets (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES scheduling.users(id) ON DELETE CASCADE,
                    token_hash TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    used BOOLEAN NOT NULL DEFAULT false,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_pwreset_hash ON scheduling.password_resets(token_hash);")
            # Email verification codes for self-registration (one per email).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.email_verifications (
                    email TEXT PRIMARY KEY,
                    code TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            # Mobile-number verification codes sent over WhatsApp (one per number).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.phone_verifications (
                    phone TEXT PRIMARY KEY,
                    code TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            # Nafath (Sadq) identity verifications for self-registration. Keyed by
            # the GUID we generate; Sadq pushes the result to our public webhook.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.nafath_verifications (
                    request_id UUID PRIMARY KEY,
                    national_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    trans_id TEXT,
                    random_code TEXT,
                    name_ar TEXT,
                    name_en TEXT,
                    official_national_id TEXT,
                    consumed BOOLEAN NOT NULL DEFAULT false,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_nafath_national ON scheduling.nafath_verifications(national_id);")
            # National ID + Arabic official name captured from Nafath at sign-up.
            cur.execute("ALTER TABLE scheduling.staff_registrations ADD COLUMN IF NOT EXISTS national_id TEXT;")
            cur.execute("ALTER TABLE scheduling.staff_registrations ADD COLUMN IF NOT EXISTS name_ar TEXT;")
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS national_id TEXT;")
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS name_ar TEXT;")
            # Multi-stage swap approval: peer → team lead → manager. Track each step.
            for _col in ("peer_at TIMESTAMP",
                         "lead_by INTEGER", "lead_at TIMESTAMP",
                         "mgr_by INTEGER", "mgr_at TIMESTAMP",
                         "reject_by INTEGER", "reject_role TEXT", "reject_at TIMESTAMP",
                         "reject_note TEXT"):
                cur.execute(f"ALTER TABLE scheduling.shift_swaps ADD COLUMN IF NOT EXISTS {_col};")
            # Legacy single-step swaps used status='pending'; map them onto the
            # first stage of the new chain so they remain actionable.
            cur.execute("UPDATE scheduling.shift_swaps SET status='pending_peer' WHERE status='pending';")

            # Support tickets: a staff member raises an issue / fault / request; a
            # team lead or manager escalates it and marks the action taken. The
            # creator is notified at every status change so they always know where
            # it stands. ticket_updates is the conversation thread on a ticket.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.tickets (
                    id SERIAL PRIMARY KEY,
                    created_by INTEGER NOT NULL REFERENCES scheduling.users(id) ON DELETE CASCADE,
                    staff_id INTEGER REFERENCES scheduling.staff(id) ON DELETE SET NULL,
                    branch_id INTEGER REFERENCES scheduling.branches(id) ON DELETE SET NULL,
                    category TEXT NOT NULL DEFAULT 'issue',
                    priority TEXT NOT NULL DEFAULT 'normal',
                    subject TEXT NOT NULL,
                    description TEXT,
                    status TEXT NOT NULL DEFAULT 'open',
                    handled_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    resolution TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_tickets_status ON scheduling.tickets(status);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_tickets_creator ON scheduling.tickets(created_by);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_tickets_branch ON scheduling.tickets(branch_id);")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.ticket_updates (
                    id SERIAL PRIMARY KEY,
                    ticket_id INTEGER NOT NULL REFERENCES scheduling.tickets(id) ON DELETE CASCADE,
                    user_id INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    body TEXT NOT NULL,
                    is_status_change BOOLEAN NOT NULL DEFAULT false,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_ticket_updates_ticket ON scheduling.ticket_updates(ticket_id);")

            # Announcements / circulars (التعاميم والنشرات). A manager (or team lead
            # for their branch) posts a bulletin; an "action_required" one asks staff
            # to acknowledge. Optionally broadcast over WhatsApp + email to everyone.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.announcements (
                    id SERIAL PRIMARY KEY,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    kind TEXT NOT NULL DEFAULT 'announcement',
                    audience TEXT NOT NULL DEFAULT 'all',
                    branch_id INTEGER REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    pinned BOOLEAN NOT NULL DEFAULT false,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.announcement_acks (
                    announcement_id INTEGER NOT NULL REFERENCES scheduling.announcements(id) ON DELETE CASCADE,
                    user_id INTEGER NOT NULL REFERENCES scheduling.users(id) ON DELETE CASCADE,
                    acked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (announcement_id, user_id)
                );""")

            # Per-shift equipment-check confirmation (تشييك الأجهزة). One row per
            # branch/day/shift — the first person on that shift to confirm clears it
            # for the rest. A reminder is sent if it isn't confirmed within 30 min of
            # the shift starting.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.shift_checks (
                    id SERIAL PRIMARY KEY,
                    branch_id INTEGER NOT NULL REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    date DATE NOT NULL,
                    shift TEXT NOT NULL,
                    confirmed_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    confirmed_by_staff INTEGER REFERENCES scheduling.staff(id) ON DELETE SET NULL,
                    note TEXT,
                    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(branch_id, date, shift)
                );""")

            # Staff credentials / licenses with expiry (SCFHS, BLS/ACLS, Iqama…) —
            # so the team lead/manager is alerted before they lapse.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.staff_credentials (
                    id SERIAL PRIMARY KEY,
                    staff_id INTEGER NOT NULL REFERENCES scheduling.staff(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL DEFAULT 'other',
                    label TEXT,
                    number TEXT,
                    expiry_date DATE NOT NULL,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_staff_creds_staff ON scheduling.staff_credentials(staff_id);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_staff_creds_expiry ON scheduling.staff_credentials(expiry_date);")
            # Employee-file documents: some (CV, transcript, diploma) have no expiry,
            # and we record an issue date. Relax the original NOT-NULL expiry.
            cur.execute("ALTER TABLE scheduling.staff_credentials ADD COLUMN IF NOT EXISTS issue_date DATE;")
            cur.execute("ALTER TABLE scheduling.staff_credentials ALTER COLUMN expiry_date DROP NOT NULL;")

            # Staff shift preferences for a month — collected before generation.
            # kind: 'unavailable' (hard, forced Off) or 'off' (soft, prefer Off).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.shift_preferences (
                    id SERIAL PRIMARY KEY,
                    staff_id INTEGER NOT NULL REFERENCES scheduling.staff(id) ON DELETE CASCADE,
                    year INTEGER NOT NULL,
                    month INTEGER NOT NULL,
                    day INTEGER NOT NULL,
                    kind TEXT NOT NULL DEFAULT 'off',
                    note TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (staff_id, year, month, day)
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_shift_prefs_month ON scheduling.shift_preferences(year,month);")

            # ── Downtime registration (نموذج تعطّل النظام) ───────────────────────
            # When the radiology system (RIS/PACS) is down, staff log the patient
            # here and the system mints a unique Accession Number so images route
            # correctly once it's back. patient_id = national ID / iqama.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.downtime_studies (
                    id SERIAL PRIMARY KEY,
                    branch_id INTEGER NOT NULL REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    accession TEXT NOT NULL UNIQUE,
                    patient_name TEXT NOT NULL,
                    patient_id TEXT NOT NULL,
                    modality TEXT NOT NULL,
                    procedure_name TEXT,
                    indication TEXT,
                    ward TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_by_staff INTEGER REFERENCES scheduling.staff(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    reconciled_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    reconciled_at TIMESTAMPTZ
                );""")
            # specialist_id: the radiologist/tech ID typed on the public (no-login)
            # link, where there's no logged-in user to attribute the study to.
            cur.execute("ALTER TABLE scheduling.downtime_studies ADD COLUMN IF NOT EXISTS specialist_id TEXT;")
            cur.execute("ALTER TABLE scheduling.downtime_studies ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app';")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_downtime_branch ON scheduling.downtime_studies(branch_id, created_at);")
            # Atomic per-(code,day) sequence so concurrent registrations never collide.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.downtime_counters (
                    code TEXT NOT NULL, ymd TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (code, ymd)
                );""")

            # ── Consumables inventory ────────────────────────────────────────────
            # Each branch tracks stock items. Staff log what they take → qty drops;
            # when it reaches the reorder level (default half of full) the lead is
            # alerted to reorder. Every movement is logged for accountability.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.inventory_items (
                    id SERIAL PRIMARY KEY,
                    branch_id INTEGER NOT NULL REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    unit TEXT,
                    full_qty NUMERIC NOT NULL DEFAULT 0,
                    qty NUMERIC NOT NULL DEFAULT 0,
                    reorder_level NUMERIC NOT NULL DEFAULT 0,
                    low_notified BOOLEAN NOT NULL DEFAULT false,
                    active BOOLEAN NOT NULL DEFAULT true,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_inventory_branch ON scheduling.inventory_items(branch_id, active);")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.inventory_movements (
                    id SERIAL PRIMARY KEY,
                    item_id INTEGER NOT NULL REFERENCES scheduling.inventory_items(id) ON DELETE CASCADE,
                    delta NUMERIC NOT NULL,
                    reason TEXT,
                    by_user INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    by_staff INTEGER REFERENCES scheduling.staff(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_inventory_mov_item ON scheduling.inventory_movements(item_id, created_at);")

            # ── Equipment maintenance ────────────────────────────────────────────
            # Devices per branch with a next preventive-maintenance due date, plus a
            # log of every service. The lead is reminded before the PM is due.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.equipment (
                    id SERIAL PRIMARY KEY,
                    branch_id INTEGER NOT NULL REFERENCES scheduling.branches(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    model TEXT,
                    serial TEXT,
                    vendor TEXT,
                    next_pm_date DATE,
                    active BOOLEAN NOT NULL DEFAULT true,
                    pm_notified TEXT,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_equipment_branch ON scheduling.equipment(branch_id, active);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_equipment_pm ON scheduling.equipment(next_pm_date);")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.maintenance_records (
                    id SERIAL PRIMARY KEY,
                    equipment_id INTEGER NOT NULL REFERENCES scheduling.equipment(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL DEFAULT 'preventive',
                    service_date DATE NOT NULL,
                    next_due DATE,
                    vendor TEXT,
                    cost NUMERIC,
                    note TEXT,
                    created_by INTEGER REFERENCES scheduling.users(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_maint_equip ON scheduling.maintenance_records(equipment_id, service_date);")

            # Performance indexes for the hottest lookups. The UNIQUE constraints
            # already cover (schedule_id,staff_id,date), (branch_id,year,month),
            # (staff_id,date for leaves) and (branch_id,date for cases); these two
            # cover the access paths those don't:
            #  · my-schedule / on-duty / cross-month prev-tail scan a staff member
            #    across ALL schedules → needs staff_id leading.
            #  · staff listings filter by branch + active on nearly every page.
            cur.execute("CREATE INDEX IF NOT EXISTS idx_sched_entries_staff_date ON scheduling.schedule_entries(staff_id, date);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_staff_branch_active ON scheduling.staff(branch_id, active);")

            # Radiology statistics history — one immutable snapshot per calendar day,
            # captured from Siratech HIS by the daily job. This is what makes the
            # month-over-month and quarter-over-quarter comparisons possible (the
            # live view alone keeps no history). `payload` holds the full daily
            # aggregate (branch/department/doctor/…); the scalar columns exist for
            # fast monthly/quarterly roll-ups without unpacking JSON.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.radiology_stats_daily (
                    stat_date   DATE PRIMARY KEY,
                    total       INTEGER NOT NULL DEFAULT 0,
                    emergency   INTEGER NOT NULL DEFAULT 0,
                    routine     INTEGER NOT NULL DEFAULT 0,
                    by_branch     JSONB NOT NULL DEFAULT '[]',
                    by_department JSONB NOT NULL DEFAULT '[]',
                    by_doctor     JSONB NOT NULL DEFAULT '[]',
                    payload       JSONB NOT NULL DEFAULT '{}',
                    source      TEXT NOT NULL DEFAULT 'worklist',
                    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")

            # ── End-of-day "billed vs actually-performed" reconciliation snapshot.
            # Each night we sweep the trailing window's orders and check DePACS (PACS =
            # proof the exam was physically performed). One row per run_date. The `payload`
            # holds the aged "billed but not performed" follow-up list (patient + exam +
            # days-waiting) plus the by-branch breakdown.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.radiology_reconcile_daily (
                    run_date            DATE PRIMARY KEY,
                    window_from         DATE,
                    window_to           DATE,
                    flag_days           INTEGER NOT NULL DEFAULT 14,
                    ordered_total       INTEGER NOT NULL DEFAULT 0,
                    performed           INTEGER NOT NULL DEFAULT 0,
                    not_performed       INTEGER NOT NULL DEFAULT 0,
                    not_performed_aged  INTEGER NOT NULL DEFAULT 0,
                    awaiting_report     INTEGER NOT NULL DEFAULT 0,
                    reported            INTEGER NOT NULL DEFAULT 0,
                    payload             JSONB NOT NULL DEFAULT '{}',
                    captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")

            # ── Ordered-vs-Done by DAY, attributed to the ORDER date. Re-written every night
            # for the whole trailing window, so a patient who does the exam several days after
            # ordering makes that ORIGINAL day's `done` count go up (self-correcting — a day is
            # never frozen until it scrolls past the reconcile window, by when ~all exams are in).
            # by_modality holds {mod: {ordered, done}} for the exam-type breakdown.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.radiology_done_daily (
                    stat_date     DATE PRIMARY KEY,
                    ordered       INTEGER NOT NULL DEFAULT 0,
                    done          INTEGER NOT NULL DEFAULT 0,
                    unverifiable  INTEGER NOT NULL DEFAULT 0,
                    by_modality   JSONB NOT NULL DEFAULT '{}',
                    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")

            # ── RIS Phase 2: per-order lifecycle state + turnaround (TAT) + the durable
            # study binding. One row per radiology order (gen_pat_billing_id). Populated
            # from the live worklist (ordered → reported) and stamped 'filed' with the
            # bound DePACS study id when the report is filed. Real DICOM accession is
            # null on this HIS, so study_id IS the binding — once set it is the
            # deterministic link, no re-guessing.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.radiology_orders (
                    id             BIGSERIAL PRIMARY KEY,
                    site           INTEGER,
                    mrno           TEXT NOT NULL,
                    bill_no        TEXT,
                    gen_pat_billing_id BIGINT UNIQUE,
                    patient_name   TEXT,
                    department     TEXT,
                    doctor         TEXT,
                    emergency      BOOLEAN NOT NULL DEFAULT false,
                    ordered_at     TIMESTAMPTZ,
                    state          TEXT NOT NULL DEFAULT 'ordered',   -- ordered | reported | filed
                    study_id       BIGINT,                            -- the bound DePACS study
                    service_id     TEXT,
                    reported_at    TIMESTAMPTZ,
                    filed_at       TIMESTAMPTZ,
                    filed_by       INTEGER,
                    first_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rad_orders_state ON scheduling.radiology_orders(state);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rad_orders_mrno ON scheduling.radiology_orders(mrno);")
            # Imaging modality (CT/US/XR/MR/MG) captured from the worklist when known.
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS modality TEXT;")
            # How the order was closed: 'meena' (filed through our workflow, so its
            # turnaround is real) vs 'external' (reconciled — it left the Siratech board
            # having been filed/resolved outside Meena, so its TAT is unknown). Keeps the
            # stats honest: only 'meena' rows feed the turnaround averages.
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS filed_source TEXT;")
            # When the images first appeared in DePACS (order scanned but report pending).
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS imaged_at TIMESTAMPTZ;")
            # Deterministic image↔order link. accession is the DICOM key (from the MWL agent
            # or, once Siratech's cPACS is enabled, from the HIS EMR forward view). pacs_id /
            # cpacs_url point straight at the study in the PACS viewer. Filled opportunistically
            # from the connector's match; once accession is set, matching is exact — no fuzzing.
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS accession TEXT;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS accession_source TEXT;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS pacs_id TEXT;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS cpacs_url TEXT;")
            # ── RIS Phase 2: operator-driven workflow overlay (Meena-owned) ──────────────
            # receive / start / complete / assign technologist / note / cancel. This is a
            # LOCAL layer over the read-only HIS board — it is NEVER written back to
            # Siratech, and the auto-file/reconcile loops treat local_status='cancelled'
            # as off-limits so a "Not Done" order can't be auto-filed.
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS local_status TEXT;")   # received | in_progress | completed | cancelled
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS assigned_tech_id INTEGER;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS assigned_tech_name TEXT;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS note TEXT;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS local_by INTEGER;")
            cur.execute("ALTER TABLE scheduling.radiology_orders ADD COLUMN IF NOT EXISTS local_updated_at TIMESTAMPTZ;")
            # PER-EXAM lifecycle/filing state (#9). scheduling.radiology_orders is keyed per
            # BILL (gen_pat_billing_id) and carries the operator overlay (received/started/…),
            # which is correctly per-visit. But a bill bundles several exams, so the per-EXAM
            # stage/report/study/accession there collapse last-wins — hiding a sibling's
            # un-filed report from orphan detection and blurring per-exam TAT. This companion
            # table holds one row per exam (bill + service_id) with the display fields
            # denormalised, so the Orders history, orphan detection and the cold-open seed can
            # read per exam. The parent table is left untouched (overlay/worklist unaffected).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.radiology_exam_state (
                    gen_pat_billing_id BIGINT  NOT NULL,
                    service_id     TEXT    NOT NULL DEFAULT '',
                    site           INTEGER,
                    mrno           TEXT,
                    bill_no        TEXT,
                    patient_name   TEXT,
                    department     TEXT,
                    doctor         TEXT,
                    emergency      BOOLEAN DEFAULT FALSE,
                    modality       TEXT,
                    state          TEXT,           -- ordered | reported | filed
                    ordered_at     TIMESTAMPTZ,
                    reported_at    TIMESTAMPTZ,
                    imaged_at      TIMESTAMPTZ,
                    study_id       BIGINT,          -- matches radiology_orders.study_id (the bound DePACS study)
                    accession      TEXT,
                    accession_source TEXT,
                    pacs_id        TEXT,
                    cpacs_url      TEXT,
                    filed_at       TIMESTAMPTZ,
                    filed_by       INTEGER,
                    filed_source   TEXT,
                    updated_at     TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (gen_pat_billing_id, service_id)
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rad_exam_state_state ON scheduling.radiology_exam_state(state);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rad_exam_state_site ON scheduling.radiology_exam_state(site);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rad_exam_state_mrno ON scheduling.radiology_exam_state(mrno);")
            # One-time backfill so the per-exam store carries the existing history (one row per
            # bill to start; per-exam granularity accrues as the board re-upserts). ON CONFLICT
            # DO NOTHING makes it a no-op on every subsequent startup.
            cur.execute("""
                INSERT INTO scheduling.radiology_exam_state
                    (gen_pat_billing_id, service_id, site, mrno, bill_no, patient_name, department, doctor,
                     emergency, modality, state, ordered_at, reported_at, imaged_at, study_id, accession,
                     accession_source, pacs_id, cpacs_url, filed_at, filed_by, filed_source, updated_at)
                SELECT gen_pat_billing_id, COALESCE(service_id, ''), site, mrno, bill_no, patient_name, department, doctor,
                     emergency, modality, state, ordered_at, reported_at, imaged_at, study_id, accession,
                     accession_source, pacs_id, cpacs_url, filed_at, filed_by, filed_source, updated_at
                FROM scheduling.radiology_orders
                WHERE gen_pat_billing_id IS NOT NULL
                ON CONFLICT (gen_pat_billing_id, service_id) DO NOTHING;""")
            # ── Critical / urgent result closed-loop communication (Meena-owned) ─────────
            # A radiologist/tech flags a critical or urgent finding on a study; the loop is
            # not closed until someone documents that the result was communicated to (and
            # read back by) the referring team — with who/when. This is a CBAHI / Joint
            # Commission accreditation requirement the HIS didn't cover. Purely local; it is
            # NEVER written back to Siratech.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.critical_results (
                    id              BIGSERIAL PRIMARY KEY,
                    site            INTEGER,
                    mrno            TEXT NOT NULL,
                    gen_pat_billing_id BIGINT,
                    accession       TEXT,
                    patient_name    TEXT,
                    exam            TEXT,
                    severity        TEXT NOT NULL DEFAULT 'critical',  -- critical | urgent
                    finding         TEXT NOT NULL,
                    flagged_by      INTEGER,
                    flagged_by_name TEXT,
                    flagged_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    notify_to       TEXT,          -- referring doctor / team told
                    status          TEXT NOT NULL DEFAULT 'open',  -- open | acknowledged
                    acked_by        INTEGER,
                    acked_by_name   TEXT,
                    acked_at        TIMESTAMPTZ,
                    ack_note        TEXT,          -- how/whom communicated + read-back
                    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_critical_status ON scheduling.critical_results(status);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_critical_mrno ON scheduling.critical_results(mrno);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_critical_site ON scheduling.critical_results(site);")
            # Peer review (radiology QA). A second radiologist reviews a colleague's report
            # and scores agreement on the RADPEER 1–4 scale. The discrepancy rate per reader
            # and overall is an accreditation-grade quality metric (CBAHI / ACR). Purely
            # local — never written back to Siratech.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.peer_reviews (
                    id                BIGSERIAL PRIMARY KEY,
                    site              INTEGER,
                    mrno              TEXT NOT NULL,
                    accession         TEXT,
                    patient_name      TEXT,
                    exam              TEXT,
                    modality          TEXT,
                    original_reader   TEXT,          -- the radiologist whose report is reviewed
                    reviewer_id       INTEGER,
                    reviewer_name     TEXT,
                    score             SMALLINT NOT NULL,   -- RADPEER 1=concur .. 4=misinterpretation
                    clinically_significant BOOLEAN NOT NULL DEFAULT FALSE,
                    note              TEXT,
                    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_peer_site ON scheduling.peer_reviews(site);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_peer_reader ON scheduling.peer_reviews(original_reader);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_peer_created ON scheduling.peer_reviews(created_at);")
            # DICOM Modality Worklist entries pushed by the on-site MWL agent. Each row is
            # one scheduled procedure step carrying the Siratech-generated accession — the
            # deterministic key that links order → images → report. The HIS REST API
            # withholds this, so the agent reads it from the same worklist the machines use.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.radiology_mwl (
                    id           BIGSERIAL PRIMARY KEY,
                    accession    TEXT NOT NULL UNIQUE,
                    mrno         TEXT,
                    patient_name TEXT,
                    proc_id      TEXT,
                    proc_desc    TEXT,
                    modality     TEXT,
                    station      TEXT,
                    sps_date     TEXT,           -- DICOM YYYYMMDD, as sent by the broker
                    raw          JSONB,          -- full item, for when field semantics surprise us
                    first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rad_mwl_mrno ON scheduling.radiology_mwl(mrno);")

            # ── Live worklist MIRROR ──────────────────────────────────────────────────
            # A background job copies the all-branches board out of Siratech into this table
            # every few seconds; the /radiology/worklist endpoint then serves it from HERE
            # (a ~30ms DB read) instead of waiting on the 2 GB HIS box, with the live proxy
            # as the fallback when the mirror is cold/stale. One row per scope (date window).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scheduling.worklist_mirror (
                    scope_key  TEXT PRIMARY KEY,      -- "<from>|<to>" — the fast-board scope
                    payload    JSONB NOT NULL,        -- the raw HIS board (items + meta)
                    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );""")

            # ── Performance indexes for hot / growing tables (audit, on-duty, dashboard
            # counts). All additive and IF NOT EXISTS — safe to run every boot. ──
            cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_created ON scheduling.audit_log(created_at DESC);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_action_created ON scheduling.audit_log(action, created_at DESC);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_sched_entries_date ON scheduling.schedule_entries(date);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_leave_status ON scheduling.leave_requests(status);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_swaps_status ON scheduling.shift_swaps(status);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_staffreg_status ON scheduling.staff_registrations(status);")

            conn.commit()
    print("Scheduling schema ready.")


def seed_defaults():
    branches = ['NEST 1','NEST 2','NEST 3','NEST 4','NEST 6','Al-Jubail']
    for name in branches:
        q("INSERT INTO scheduling.branches (name) VALUES (%s) ON CONFLICT (name) DO NOTHING",
          (name,), exec_only=True)

    shifts = [
        ('M','Morning (12h)','08:00','20:00','#2B9FFF',False,False,False,1),
        ('N','Night (12h)','20:00','08:00','#6B4EFF',False,False,False,2),
        ('D','Day (08–17)','08:00','17:00','#00C896',False,False,False,3),
        ('D1','Day D1 (10–22)','10:00','22:00','#00B884',False,False,False,4),
        ('EV','Evening (16–00)','16:00','00:00','#FFBA49',False,False,False,5),
        ('A','Morning A (07–15)','07:00','15:00','#4ECDC4',False,False,False,6),
        ('B','Afternoon B (15–23)','15:00','23:00','#FF9F43',False,False,False,7),
        ('C','Night C (23–07)','23:00','07:00','#A29BFE',False,False,False,8),
        ('R','Night R (20–02)','20:00','02:00','#B8839F',False,False,False,9),
        ('R1','Night R1 (20–04)','20:00','04:00','#9B59B6',False,False,False,10),
        ('O','Off',None,None,'#E0E0E0',True,False,False,11),
        ('OC','On-Call',None,None,'#FF6B6B',False,False,True,12),
        ('AL','Annual Leave',None,None,'#FD79A8',False,True,False,13),
        ('SL','Sick Leave',None,None,'#FAB1A0',False,True,False,14),
        ('TB','Time-Back',None,None,'#FDCB6E',False,True,False,15),
        ('OT','Overtime',None,None,'#55EFC4',False,False,False,16),
        ('Y3','Y3 (09–21)','09:00','21:00','#E17055',False,False,False,17),
        ('D_US','D US (10–22)','10:00','22:00','#74B9FF',False,False,False,18),
    ]
    for s in shifts:
        exists = q("SELECT id FROM scheduling.shift_types WHERE branch_id IS NULL AND code=%s",
                   (s[0],), one=True)
        if not exists:
            q("""INSERT INTO scheduling.shift_types
                 (branch_id,code,label,start_time,end_time,color,is_off,is_leave,is_oncall,sort_order)
                 VALUES (NULL,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", s, exec_only=True)

    print("Default branches and shift types seeded.")


def seed_nest_config():
    # NOTE: shift types are global; per-section allowed_shifts are no longer used.
    # Auto-generate uses only M/N/O (and forced AL) regardless of other codes.
    # coverage/exact_coverage are legacy fields and are not used for auto-generate.
    _MN  = {'weekday':{'M':1,'N':1},'weekend':{'M':1,'N':1}}
    _ALL = ['M','N','D','D1','EV','A','B','C','N6','Y3','O','OC','AL','SL','TB']
    _N1  = {'N': 1}   # exact 1 night shift per section per day
    nests = [
        # NEST1
        dict(nest_key='NEST1', section_name='General', sort_order=0,
             staff=['WAFA','CHERYL','MUHANNED','ELHAM','AMINAH','MNAYER'],
             staff_db_names={'WAFA':'Wafa Assiri','CHERYL':'Cheryl','MUHANNED':'Muhanned',
                             'ELHAM':'Elham','AMINAH':'Aminah','MNAYER':'Mnayer'},
             allowed_shifts=_ALL, coverage=_MN, exact_coverage=_N1),
        dict(nest_key='NEST1', section_name='US', sort_order=1,
             staff=['RAWAN','ALANOOD','ALNOUD','TAGREED','SADEEM'],
             staff_db_names={'RAWAN':'Rawan','ALANOOD':'Alanood','ALNOUD':'Alnoud Alrashdi',
                             'TAGREED':'Tagreed','SADEEM':'Sadeem'},
             allowed_shifts=_ALL, coverage=_MN, exact_coverage=_N1),
        # NEST2
        dict(nest_key='NEST2', section_name='General', sort_order=0,
             staff=['BADRIH','DALAL','WEDAD','LAYAN','FATIN','NAIF','MOHAMMED_BATT'],
             staff_db_names={'BADRIH':'Badrih','DALAL':'Dalal','WEDAD':'Wedad','LAYAN':'Layan',
                             'FATIN':'Fatin','NAIF':'Naif','MOHAMMED_BATT':'Mohammed Batt'},
             allowed_shifts=_ALL, coverage=_MN, exact_coverage=_N1),
        dict(nest_key='NEST2', section_name='US', sort_order=1,
             staff=['ALHANOUF_BIN_AMMAR','HAJER','JOY','ALHANOUF_ALAZMI'],
             staff_db_names={'ALHANOUF_BIN_AMMAR':'Alhanouf Bin Ammar','HAJER':'Hajer AL Mutiri',
                             'JOY':'Joy','ALHANOUF_ALAZMI':'Alhanouf Alazmi'},
             allowed_shifts=_ALL, coverage=_MN, exact_coverage=_N1),
        # NEST3
        dict(nest_key='NEST3', section_name='General', sort_order=0,
             staff=['DUAA','RAWAN','NOURAH','ABDULAZIZ','BUSHRA'],
             staff_db_names={'DUAA':'Duaa','RAWAN':'Rawan Alharbi','NOURAH':'Nourah',
                             'ABDULAZIZ':'Abdulaziz Alanazi','BUSHRA':'Bushra Alqahani'},
             allowed_shifts=_ALL, coverage=_MN, exact_coverage=_N1),
        dict(nest_key='NEST3', section_name='US', sort_order=1,
             staff=['ALMA','MANAR','QAMRAA','REEM'],
             staff_db_names={'ALMA':'Alma Tolentino','MANAR':'Manar',
                             'QAMRAA':'Qamraa','REEM':'Reem Alharbi'},
             allowed_shifts=_ALL, coverage=_MN, exact_coverage=_N1),
        # NEST4
        dict(nest_key='NEST4', section_name='General', sort_order=0,
             staff=['SARAH','AROB'],
             staff_db_names={'SARAH':'Sara Halawani','AROB':'Arob'},
             allowed_shifts=_ALL, coverage=_MN, exact_coverage=_N1),
        dict(nest_key='NEST4', section_name='US', sort_order=1,
             staff=['RANA','AESHAH','TAIF','ALAA'],
             staff_db_names={'RANA':'Rana','AESHAH':'Aeshah','TAIF':'Taif','ALAA':'Alaa'},
             allowed_shifts=_ALL, coverage=_MN, exact_coverage=_N1),
        # NEST6
        dict(nest_key='NEST6', section_name='General', sort_order=0,
             staff=['MOHAMMED','NAIF_ALMUTARI','RUBA','SHAHAD','WEDAD','LAYAN','DALAL','NAIF'],
             staff_db_names={'MOHAMMED':'Mohammed','NAIF_ALMUTARI':'Naif Almutari','RUBA':'Ruba',
                             'SHAHAD':'Shahad','WEDAD':'Wedad N6','LAYAN':'Layan N6',
                             'DALAL':'Dalal N6','NAIF':'Naif'},
             allowed_shifts=_ALL, coverage=_MN, exact_coverage=_N1),
        dict(nest_key='NEST6', section_name='US', sort_order=1,
             staff=['RANA','MEYAN','ALANOUD','HAJER','ALMA'],
             staff_db_names={'RANA':'Rana N6','MEYAN':'Meyan','ALANOUD':'Alanoud N6',
                             'HAJER':'Hajer N6','ALMA':'Alma N6'},
             allowed_shifts=_ALL, coverage=_MN, exact_coverage=_N1),
        # Y5 — only 1 staff, can't enforce M+N, manual only
        dict(nest_key='Y5', section_name='General', sort_order=0,
             staff=['MANAL'],
             staff_db_names={'MANAL':'Manal Salem'},
             allowed_shifts=_ALL, coverage={}, exact_coverage={}),
    ]
    for n in nests:
        q("""INSERT INTO scheduling.nest_sections
             (nest_key,section_name,staff,staff_db_names,allowed_shifts,coverage,exact_coverage,sort_order)
             VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
             ON CONFLICT (nest_key,section_name) DO NOTHING""",
          (n['nest_key'], n['section_name'], n['staff'],
           json.dumps(n['staff_db_names']), n['allowed_shifts'],
           json.dumps(n['coverage']), json.dumps(n['exact_coverage']), n['sort_order']),
          exec_only=True)
    print("Nest configs seeded (skipped if already exist).")


def seed_admin():
    # Create the bootstrap admin once. Never overwrite an existing account's
    # password/role on restart — that would wipe a manual password change and
    # was an account-takeover risk.
    existing = q("SELECT id FROM scheduling.users WHERE username=%s", (ADMIN_USER,), one=True)
    if existing:
        return
    admin_pass = ADMIN_PASS
    if not admin_pass:
        # No ADMIN_PASS provided — mint a random one-time password instead of a
        # predictable default. Printed once here so the operator can log in.
        import secrets
        admin_pass = secrets.token_urlsafe(18)
        print("=" * 64)
        print("  ADMIN_PASS was not set — generated a one-time superadmin password.")
        print(f"    username: {ADMIN_USER}")
        print(f"    password: {admin_pass}")
        print("  Log in and change it immediately, or set ADMIN_PASS and redeploy.")
        print("=" * 64)
    pwd = bcrypt.hashpw(admin_pass.encode(), bcrypt.gensalt()).decode()
    q("INSERT INTO scheduling.users (username,password,role) VALUES (%s,%s,'superadmin')",
      (ADMIN_USER, pwd), exec_only=True)
    print(f'Admin user "{ADMIN_USER}" ready.')


# ── Auth helpers ──────────────────────────────────────────────────────────────

def sign_token(payload: dict) -> str:
    data = dict(payload)
    data["exp"] = datetime.now(timezone.utc) + timedelta(days=JWT_DAYS)
    return jwt.encode(data, get_jwt_secret(), algorithm=JWT_ALG)

_JWT_SECRET_CACHE = None
def get_jwt_secret() -> str:
    """Use a strong env secret if provided; otherwise fall back to a random
    secret persisted once in the DB (stable across restarts/workers) so the
    insecure default 'scheduling_secret' is never actually used to sign tokens."""
    global _JWT_SECRET_CACHE
    if _JWT_SECRET_CACHE:
        return _JWT_SECRET_CACHE
    env = os.environ.get("JWT_SECRET", "")
    if env and env != "scheduling_secret":
        _JWT_SECRET_CACHE = env
        return env
    import secrets as _secrets
    try:
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('jwt_secret',%s)
             ON CONFLICT (key) DO NOTHING""", (_secrets.token_hex(32),), exec_only=True)
        row = q("SELECT value FROM scheduling.app_settings WHERE key='jwt_secret'", one=True)
        _JWT_SECRET_CACHE = (row or {}).get("value") or "scheduling_secret"
    except Exception:
        _JWT_SECRET_CACHE = env or "scheduling_secret"
    return _JWT_SECRET_CACHE

def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALG])
    except JWTError:
        raise HTTPException(401, "Session expired")

# Simple in-memory login throttle (per username) to blunt brute force.
_login_fails: dict = {}
def _login_throttle_check(username):
    import time as _t
    now = _t.time()
    arr = [t for t in _login_fails.get(username, []) if now - t < 300]
    _login_fails[username] = arr
    if len(arr) >= 8:
        raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")
def _login_throttle_fail(username):
    import time as _t
    _login_fails.setdefault(username, []).append(_t.time())

def get_current_user(request: Request) -> dict:
    token = request.cookies.get("token") or \
            request.headers.get("authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "Not authenticated")
    payload = verify_token(token)
    # Re-validate against the DB so a deleted/downgraded account (or one whose
    # password was changed) can't keep using an old 30-day token. We trust the
    # live row for role/branch, not whatever was baked into the token.
    row = q("""SELECT u.id,u.username,u.role,u.branch_id,u.staff_id,
                      COALESCE(u.token_epoch,0) AS token_epoch,
                      COALESCE(u.can_file_radiology,false) AS can_file_radiology,
                      COALESCE(u.can_use_radiology,false) AS can_use_radiology,
                      COALESCE(u.permissions,'{}'::jsonb) AS permissions,
                      b.name AS branch_name
               FROM scheduling.users u
               LEFT JOIN scheduling.branches b ON b.id=u.branch_id
               WHERE u.id=%s""", (payload.get("id"),), one=True)
    if not row:
        raise HTTPException(401, "Account no longer exists")
    if int(payload.get("epoch", 0)) != int(row["token_epoch"]):
        raise HTTPException(401, "Session expired — please sign in again")
    return row

def require_admin(user: dict = Depends(get_current_user)) -> dict:
    # Team leads, managers, and full admins can all reach schedule editing routes.
    if user.get("role") not in ("admin", "superadmin", "manager"):
        raise HTTPException(403, "Forbidden")
    return user

def require_radiology(user: dict = Depends(get_current_user)) -> dict:
    # Access to the radiology WORKFLOW (worklist, patient/report check, consent).
    # Team leads / managers / full admins have it by role. A plain `staff` member has
    # it ONLY when a superadmin granted can_use_radiology (or can_file_radiology, which
    # implies access) — so radiology is given to certain people, not every staff
    # account. Branch isolation still applies via _rad_scope_site.
    # Radiology access = ANY radiology-view permission (effective — role default ± override).
    if effective_perms(user) & _RAD_VIEW_PERMS:
        return user
    raise HTTPException(403, "You don't have access to the radiology worklist. Ask an admin to enable it for you.")

def require_radiology_write(user: dict = Depends(get_current_user)) -> dict:
    # FILING a result into the live HIS is a privileged write. Team leads / managers /
    # full admins can always file (role implies it). A plain `staff` member is
    # VIEW-ONLY until a superadmin grants the per-user `can_file_radiology` flag.
    # Filing to the live HIS = the rad_file permission (effective — role default ± override).
    if has_perm(user, "rad_file"):
        return user
    raise HTTPException(403, "You don't have permission to file radiology results. Ask an admin to enable it for you.")

def require_superadmin(user: dict = Depends(get_current_user)) -> dict:
    # Full admin only — branch/user/shift-type management.
    if user.get("role") != "superadmin":
        raise HTTPException(403, "Forbidden")
    return user

def require_reviewer(user: dict = Depends(get_current_user)) -> dict:
    # Managers and full admins can review/approve/return schedules.
    if user.get("role") not in ("manager", "superadmin"):
        raise HTTPException(403, "Forbidden")
    return user

# ── Per-user permissions ──────────────────────────────────────────────────────
# Every grantable feature is a permission KEY. A user's EFFECTIVE permissions = the
# role defaults, then the per-user override map (permissions JSONB: {key:true|false})
# applied on top — true grants, false revokes. A superadmin always has everything (so
# the owner can never be locked out of the Users page). Only a superadmin edits overrides.
PERMISSION_GROUPS = [
    ("Scheduling", [
        ("myschedule", "My Schedule"), ("schedule", "Team Schedule"), ("staff", "Staff list"),
        ("leaves", "Leave"), ("swaps", "Swaps"), ("downtime", "Downtime registration"),
        ("inventory", "Inventory"), ("equipment", "Equipment"), ("review", "Review / approvals"),
    ]),
    ("Overview & comms", [
        ("home", "Home dashboard"), ("reports", "Reports"), ("messages", "Messages"),
    ]),
    ("Radiology", [
        ("worklist", "RIS Worklist"), ("patientsearch", "Patient search"), ("critical", "Critical results"),
        ("orders", "Orders / turnaround"), ("handoff", "Handoff"), ("cdxfer", "CD transfers"),
        ("rad_file", "File results to HIS (write)"), ("radstats", "Rad statistics"), ("peerreview", "Peer review"),
    ]),
    ("Admin tools", [
        ("admin_branches", "Branches"), ("admin_shifts", "Shift types"), ("admin_users", "Users & permissions"),
        ("admin_hisaccess", "HIS access"), ("admin_audit", "Audit log"),
    ]),
]
PERMISSION_KEYS = [k for _grp, items in PERMISSION_GROUPS for k, _lbl in items]
PERMISSION_LABELS = {k: lbl for _grp, items in PERMISSION_GROUPS for k, lbl in items}
_RAD_VIEW_PERMS = {"worklist", "patientsearch", "critical", "orders", "handoff", "cdxfer", "radstats", "peerreview"}
_STAFF_PERMS = {"myschedule", "leaves", "swaps", "downtime", "inventory", "equipment"}
_ADMIN_PERMS = _STAFF_PERMS | {"home", "schedule", "staff", "reports", "messages",
                              "worklist", "patientsearch", "critical", "orders", "handoff",
                              "cdxfer", "rad_file", "radstats", "peerreview"}
ROLE_DEFAULT_PERMS = {
    "viewer": set(),
    "staff": set(_STAFF_PERMS),
    "admin": set(_ADMIN_PERMS),
    "manager": _ADMIN_PERMS | {"review"},
    "superadmin": set(PERMISSION_KEYS),
}

def effective_perms(user: dict) -> set:
    role = user.get("role") or "viewer"
    if role == "superadmin":
        return set(PERMISSION_KEYS)           # never lock the owner out
    perms = set(ROLE_DEFAULT_PERMS.get(role, set()))
    # Legacy staff flags fold into the radiology perms (until fully migrated to overrides).
    if user.get("can_use_radiology"):
        perms |= {"worklist", "patientsearch", "critical", "orders", "handoff", "cdxfer"}
    if user.get("can_file_radiology"):
        perms |= {"worklist", "patientsearch", "critical", "orders", "handoff", "cdxfer", "rad_file"}
    ov = user.get("permissions") or {}
    if isinstance(ov, str):
        try: ov = json.loads(ov)
        except Exception: ov = {}
    if isinstance(ov, dict):
        for k, v in ov.items():
            if k in PERMISSION_KEYS:
                perms.add(k) if v else perms.discard(k)
    return perms

def has_perm(user: dict, key: str) -> bool:
    return key in effective_perms(user)

def require_perm(key: str):
    """Dependency factory — gate a route on a single permission key."""
    def _dep(user: dict = Depends(get_current_user)) -> dict:
        if has_perm(user, key):
            return user
        raise HTTPException(403, f"You don't have permission for this ({PERMISSION_LABELS.get(key, key)}). Ask an admin to enable it.")
    return _dep

def require_editor(user: dict = Depends(get_current_user)) -> dict:
    # Heavy schedule ops — GENERATE, lock/unlock, delete — are team leads + full
    # admins only (not managers). Note: managers CAN still fix individual cells
    # (those routes use require_admin) — they're reviewers who may correct a rota.
    if user.get("role") not in ("admin", "superadmin"):
        raise HTTPException(403, "Only a team lead or full admin can do this")
    return user

def _int_or_400(v, name="branch_id"):
    """Parse a query/body value to int, raising a clean 400 instead of a 500
    when a caller passes something non-numeric (e.g. ?branch_id=abc)."""
    try:
        return int(v)
    except (ValueError, TypeError):
        raise HTTPException(400, f"Invalid {name}")

def can_access_branch(user: dict, branch_id) -> bool:
    # Managers and full admins can see every branch; team leads only their own.
    if user.get("role") in ("superadmin", "manager"):
        return True
    return str(user.get("branch_id")) == str(branch_id)

def get_setting(key, default=None):
    r = q("SELECT value FROM scheduling.app_settings WHERE key=%s", (key,), one=True)
    return r["value"] if r else default

def set_setting(key, value):
    q("""INSERT INTO scheduling.app_settings (key,value) VALUES (%s,%s)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""",
      (key, str(value)), exec_only=True)

def get_leave_cutoff_day() -> int:
    try:
        d = int(get_setting("leave_cutoff_day", "15"))
        return d if 1 <= d <= 28 else 15
    except Exception:
        return 15

def leave_window_open(target_date_str, cutoff_day, today=None):
    """A leave request for month M must arrive on/before `cutoff_day` of the
    PREVIOUS month (M-1). That blocks both same-month requests (their deadline
    already passed) and next-month requests made after the cutoff — the schedule
    for M is built right after the cutoff. Managers bypass this (handled by the
    caller). Returns (ok: bool, message: str|None)."""
    from datetime import date as _date
    today = today or _date.today()
    try:
        y, m, _d = map(int, str(target_date_str).split("-")[:3])
    except (ValueError, TypeError):
        # Malformed date — let the caller's own date-format validation produce
        # the proper 400 instead of blowing up here with a 500.
        return True, None
    pm_year, pm_month = (y, m - 1) if m > 1 else (y - 1, 12)
    deadline = _date(pm_year, pm_month, min(cutoff_day, 28))
    if today <= deadline:
        return True, None
    return False, (f"Leave requests for {y}-{m:02d} closed on {deadline.isoformat()} "
                   f"(cutoff: day {cutoff_day} of the previous month).")

def assert_schedule_access(user: dict, sid) -> dict:
    """Resolve a schedule id to its branch and enforce branch access.

    The per-schedule-id routes (entries, lock, status, delete) take only a
    schedule id, so without this a branch-locked team lead could edit another
    branch's schedule just by guessing its id — which the docs explicitly
    promise can't happen. Returns the schedule row so callers can reuse it.
    """
    sched = q("SELECT * FROM scheduling.schedules WHERE id=%s", (sid,), one=True)
    if not sched:
        raise HTTPException(404, "Schedule not found")
    if not can_access_branch(user, sched.get("branch_id")):
        raise HTTPException(403, "Forbidden")
    return sched

def schedule_validation_sets(sched):
    """Valid staff ids (this branch) and shift codes for entry validation."""
    sids = {r["id"] for r in q("SELECT id FROM scheduling.staff WHERE branch_id=%s", (sched["branch_id"],))}
    codes = {r["code"] for r in q("SELECT code FROM scheduling.shift_types")}
    codes.add("O")
    return sids, codes

def check_entry(sched, sids, codes, staff_id, date, shift_code):
    """Reject cells that don't belong on this schedule (wrong branch staff, a
    date outside its month, or an unknown shift code)."""
    if staff_id not in sids:
        raise HTTPException(400, "Staff member is not in this schedule's branch")
    try:
        y, m = int(str(date)[:4]), int(str(date)[5:7])
    except Exception:
        raise HTTPException(400, "Invalid date")
    if y != sched["year"] or m != sched["month"]:
        raise HTTPException(400, "Date is outside this schedule's month")
    if (shift_code or "O") not in codes:
        raise HTTPException(400, f"Unknown shift code: {shift_code}")

def assert_can_edit_schedule(user: dict, sid) -> dict:
    """Branch access + lock policy for direct cell edits.

    The lock protects the review hand-off from the *team lead*. A reviewer
    (manager / full admin) is the authority and may edit a schedule directly
    even while it's locked/under review; a team lead may only edit it while
    it's unlocked. Returns the schedule row.
    """
    sched = assert_schedule_access(user, sid)
    if sched.get("is_locked") and user.get("role") not in ("superadmin", "manager"):
        raise HTTPException(403, "Schedule is locked. Unlock it first.")
    return sched

# ── Notifications ─────────────────────────────────────────────────────────────

# ── Email notifications ───────────────────────────────────────────────────────
# Preferred: Resend HTTP API — set RESEND_API_KEY (and optionally RESEND_FROM,
#   e.g. "Abdulaziz Alanazi <Abdulaziz.alanazi@meena-health.com>"; defaults to
#   the signature name+email, which must be on the domain you verified in Resend).
# Fallback: SMTP — SMTP_HOST, SMTP_PORT(587), SMTP_USER, SMTP_PASS, SMTP_FROM,
#   SMTP_SSL(0/1).
# Shared: APP_URL (link/logo target), ORG_NAME (branding). Neither configured →
#   in-app notifications only. SMTP_CAPTURE=1 → in-memory outbox (tests).
_email_outbox = []
# In-memory capture of outbound Nafath auth requests (tests / SADQ_MOCK).
_sadq_outbox = []

def _org_name():
    return os.environ.get("ORG_NAME", "Meena Health — Radiology Scheduling")

def _org_website():
    return os.environ.get("ORG_WEBSITE", "www.meena-health.com")

def _org_address():
    return os.environ.get("ORG_ADDRESS", "King Abdul Aziz Branch Rd, An Nafal, Riyadh 13312, KSA")

# Personal sender identity — emails go out under this name so staff feel a real
# person is on top of things. All overridable by env.
def _sig_name():   return os.environ.get("SIGNATURE_NAME", "Abdulaziz Alanazi")
def _sig_title():  return os.environ.get("SIGNATURE_TITLE", "Radiology Specialist")
def _sig_email():  return os.environ.get("SIGNATURE_EMAIL", "Abdulaziz.alanazi@meena-health.com")
def _sig_mobile(): return os.environ.get("SIGNATURE_MOBILE", "(966) 581453234")

def _email_text(message):
    url = os.environ.get("APP_URL", "").strip()
    lines = [message or ""]
    if url:
        lines += ["", f"Open the system: {url}"]
    lines += ["", "—", _sig_name(), _sig_title(),
              f"Email: {_sig_email()}", f"Mobile: {_sig_mobile()}",
              f"{_org_name()} · Subsidiary of Tawuniya",
              _org_website(), _org_address()]
    return "\n".join(lines)

def _email_html(message):
    org = _org_name()
    url = os.environ.get("APP_URL", "").strip()
    site = _org_website()
    addr = _org_address()
    logo = (url + "/meena_email_logo.jpeg") if url else ""
    safe = (message or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    header = (f'<img src="{logo}" alt="Meena" height="40" style="display:block">'
              if logo else f'<span style="font-size:18px;font-weight:800;color:#4b3fb3">{org}</span>')
    btn = (f'<a href="{url}" style="display:inline-block;background:#6B4EFF;color:#fff;'
           f'text-decoration:none;padding:11px 24px;border-radius:8px;font-weight:600;font-size:14px">'
           f'Open the system</a>') if url else ""
    site_link = f'<a href="https://{site}" style="color:#6B4EFF;text-decoration:none">{site}</a>'
    return f"""<!doctype html><html dir="ltr"><body dir="ltr" style="margin:0;background:#f4f5fb;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#2b2b3a;direction:ltr;text-align:left">
  <div style="max-width:540px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e7e7f0;direction:ltr;text-align:left">
    <div style="padding:20px 24px;border-bottom:1px solid #eee">{header}</div>
    <div style="padding:24px">
      <p style="font-size:15px;line-height:1.65;margin:0 0 20px">{safe}</p>
      {btn}
    </div>
    <div style="padding:18px 24px;background:#fafafe;border-top:1px solid #eee;font-size:12px;color:#5b5b70;line-height:1.7">
      <b style="color:#2b2b3a;font-size:13px">{_sig_name()}</b><br>
      <span style="color:#8a8aa0">{_sig_title()}</span><br>
      Email: <a href="mailto:{_sig_email()}" style="color:#6B4EFF;text-decoration:none">{_sig_email()}</a> ·
      Mobile: {_sig_mobile()}<br>
      <span style="color:#8a8aa0">{org} · Subsidiary of Tawuniya</span><br>
      {site_link} · {addr}
    </div>
  </div></body></html>"""

def _email_from():
    """The From header/address. Defaults to the personal identity on the
    verified domain so it reads as a real follow-up."""
    return (os.environ.get("RESEND_FROM") or os.environ.get("SMTP_FROM")
            or f"{_sig_name()} <{_sig_email()}>")

def _resend_payload(to, subject, body):
    """Build the JSON body for Resend's send-email API (pure → unit-testable)."""
    payload = {
        "from": _email_from(),
        "to": [to] if isinstance(to, str) else list(to),
        "subject": subject,
        "html": _email_html(body),
        "text": _email_text(body),
    }
    reply_to = _sig_email()
    if reply_to:
        payload["reply_to"] = reply_to
    return payload

def _resend_send(to, subject, body):
    import json, urllib.request, urllib.error
    data = json.dumps(_resend_payload(to, subject, body)).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails", data=data, method="POST",
        headers={"Authorization": f"Bearer {os.environ['RESEND_API_KEY']}",
                 "Content-Type": "application/json",
                 # Resend sits behind Cloudflare, which 403s (error 1010) the
                 # default "Python-urllib/x.y" agent as a bot. Use a normal UA.
                 "User-Agent": "MeenaScheduling/1.0 (+https://meena-health.com)",
                 "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        # Surface Resend's error body (bad From domain, etc.) so it's debuggable.
        raise RuntimeError(f"Resend {e.code}: {e.read().decode('utf-8', 'replace')}") from None

def _smtp_send(to, subject, body):
    import smtplib
    from email.message import EmailMessage
    from email.utils import formataddr
    msg = EmailMessage()
    from_addr = os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER", "")
    # Send under the person's name so it reads as a personal follow-up.
    msg["From"] = from_addr if "<" in from_addr else formataddr((_sig_name(), from_addr))
    reply_to = _sig_email()
    if reply_to:
        msg["Reply-To"] = reply_to
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(_email_text(body))
    msg.add_alternative(_email_html(body), subtype="html")
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    pwd  = os.environ.get("SMTP_PASS")
    if os.environ.get("SMTP_SSL", "0") == "1":
        srv = smtplib.SMTP_SSL(host, port, timeout=15)
    else:
        srv = smtplib.SMTP(host, port, timeout=15); srv.starttls()
    if user:
        srv.login(user, pwd or "")
    srv.send_message(msg); srv.quit()

def _email_webhook_url():
    """Resolve the Power Automate / webhook email URL: env var first, else the
    value saved from the Settings page (app_settings)."""
    return (os.environ.get("EMAIL_WEBHOOK_URL") or get_setting("email_webhook_url") or "").strip()

def _webhook_email_send(to, subject, body):
    """Send via an HTTP webhook — e.g. a Microsoft Power Automate flow whose
    'When an HTTP request is received' trigger forwards to Office 365 'Send an
    email (V2)', so mail goes out from the work mailbox. POSTs JSON the flow
    expects: {to, subject, body(html), text}."""
    import urllib.request, urllib.error, socket
    url = _email_webhook_url()
    payload = {"to": to, "subject": subject or "Meena Health",
               "body": _email_html(body), "text": str(body or "")}
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               "User-Agent": "MeenaScheduling/1.0 (+https://meena-health.com)"}
    tok = (os.environ.get("EMAIL_WEBHOOK_TOKEN") or "").strip()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Email webhook {e.code}: {e.read().decode('utf-8','replace')[:160]}") from None
    except (urllib.error.URLError, socket.timeout) as e:
        # DNS/timeout/connection-refused/TLS — surface a clean message, not a raw stack.
        reason = getattr(e, "reason", e)
        raise RuntimeError(f"Email webhook unreachable: {reason}") from None

def _deliver_email(to, subject, body):
    """Actually send (raises on failure). Power Automate webhook → Resend → SMTP."""
    if os.environ.get("SMTP_CAPTURE"):
        _email_outbox.append({"to": to, "subject": subject, "body": body,
                              "html": _email_html(body)})
        return
    if _email_webhook_url():
        _webhook_email_send(to, subject, body)
    elif os.environ.get("RESEND_API_KEY"):
        _resend_send(to, subject, body)
    elif os.environ.get("SMTP_HOST"):
        _smtp_send(to, subject, body)
    else:
        raise RuntimeError("No email provider configured (set EMAIL_WEBHOOK_URL, RESEND_API_KEY or SMTP_HOST)")

def send_email(to, subject, body):
    if not to:
        return
    if os.environ.get("SMTP_CAPTURE"):
        _email_outbox.append({"to": to, "subject": subject, "body": body,
                              "html": _email_html(body)})
        return
    if not (_email_webhook_url() or os.environ.get("RESEND_API_KEY") or os.environ.get("SMTP_HOST")):
        return  # email not configured → in-app only
    def _worker():
        try:
            _deliver_email(to, subject, body)
        except Exception as e:
            print(f"[email] failed to {to}: {e}")
    import threading
    threading.Thread(target=_worker, daemon=True).start()

def _normalize_whatsapp_number(raw):
    digits = re.sub(r"\D+", "", str(raw or "").strip())
    if not digits:
        return None
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("0"):
        cc = re.sub(r"\D+", "", os.environ.get("WHATSAPP_DEFAULT_COUNTRY", "966")) or "966"
        digits = cc + digits[1:]
    return digits if 8 <= len(digits) <= 15 else None

def _whatsapp_notify_enabled_for(ntype):
    url = (os.environ.get("WHATSAPP_NOTIFY_URL") or "").strip()
    if not url and not os.environ.get("WHATSAPP_CAPTURE"):
        return False
    raw = (os.environ.get("WHATSAPP_ONLY_TYPES") or "").strip()
    allowed = {x.strip() for x in raw.split(",") if x.strip()}
    return not allowed or ntype in allowed

# In-memory capture of outbound WhatsApp messages (tests; WHATSAPP_CAPTURE=1).
_whatsapp_outbox = []

def _whatsapp_send_now(to_normalized, message):
    """Send a WhatsApp message synchronously through the bridge and return its
    JSON response. Bypasses the notify type-filter (used for verification codes).
    Raises on failure so the caller can surface the real error."""
    if os.environ.get("WHATSAPP_CAPTURE"):
        _whatsapp_outbox.append({"to": to_normalized, "message": message, "type": "code"})
        return {"ok": True, "captured": True}
    url = (os.environ.get("WHATSAPP_NOTIFY_URL") or "").strip()
    if not url:
        raise RuntimeError("WhatsApp isn't configured")
    token = (os.environ.get("WHATSAPP_NOTIFY_TOKEN") or "").strip()
    import urllib.request, urllib.error
    data = json.dumps({"to": to_normalized, "message": message, "type": "info"}).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               "User-Agent": "MeenaScheduling/1.0 (+https://meena-health.com)"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Bridge {e.code}: {e.read().decode('utf-8', 'replace')}") from None

def _post_whatsapp(url, payload, token, timeout=40):
    """POST one message to the bridge. Returns (ok, detail). ok is True only when
    the bridge replies 2xx AND doesn't report a failure in its JSON body."""
    import urllib.request, urllib.error
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               "User-Agent": "MeenaScheduling/1.0 (+https://meena-health.com)"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
        try:
            j = json.loads(body)
            # Bridges commonly signal failure with ok:false / success:false / an error field.
            if isinstance(j, dict) and (j.get("ok") is False or j.get("success") is False or j.get("error")):
                return False, str(j.get("error") or j.get("message") or body)[:200]
        except Exception:
            pass
        return True, body[:200]
    except urllib.error.HTTPError as e:
        return False, f"bridge {e.code}: {e.read().decode('utf-8','replace')[:160]}"
    except Exception as e:
        return False, str(e)[:200]

def send_whatsapp(to, message, *, ntype="info", link=None, force=False, sync=False):
    # force=True bypasses the WHATSAPP_ONLY_TYPES filter — used for manager
    # broadcasts / required-action circulars that must reach WhatsApp regardless.
    # sync=True sends inline and returns {"ok","detail"} so the caller can show
    # the real bridge result (used by the interactive message-send).
    url = (os.environ.get("WHATSAPP_NOTIFY_URL") or "").strip()
    capture = os.environ.get("WHATSAPP_CAPTURE")
    if not (url or capture) or not to or not message:
        return {"ok": False, "detail": "WhatsApp not configured"} if sync else None
    if not force and not _whatsapp_notify_enabled_for(ntype):
        return {"ok": False, "detail": "filtered"} if sync else None
    to = _normalize_whatsapp_number(to)
    if not to:
        return {"ok": False, "detail": "invalid number"} if sync else None
    if capture:
        _whatsapp_outbox.append({"to": to, "message": message, "type": ntype})
        return {"ok": True, "detail": "captured"} if sync else None
    payload = {"to": to, "message": message, "type": ntype, "link": link}
    token = (os.environ.get("WHATSAPP_NOTIFY_TOKEN") or "").strip()
    if sync:
        ok, detail = _post_whatsapp(url, payload, token, timeout=20)
        if not ok:
            print(f"[whatsapp] failed to {to}: {detail}")
        return {"ok": ok, "detail": detail}
    def _worker():
        ok, detail = _post_whatsapp(url, payload, token)
        if not ok:
            print(f"[whatsapp] failed to {to}: {detail}")
    threading.Thread(target=_worker, daemon=True).start()

def _sms_config():
    """SMS gateway config (superadmin-set, stored in app_settings). Provider-agnostic:
    a URL + method + body template with {to}/{message}/{sender} placeholders, so any
    HTTP SMS provider (Unifonic, Twilio, a telecom gateway) can be plugged in."""
    return {
        "enabled": (get_setting("sms_enabled", "") or "").lower() in ("1", "true", "yes", "on"),
        "url": (get_setting("sms_url", "") or "").strip(),
        "method": (get_setting("sms_method", "POST") or "POST").strip().upper(),
        "content_type": (get_setting("sms_content_type", "json") or "json").strip().lower(),
        "headers": get_setting("sms_headers", "") or "",
        "body": get_setting("sms_body", "") or "",
        "sender": (get_setting("sms_sender", "") or "").strip(),
    }

def _sms_configured():
    c = _sms_config()
    return bool(c["enabled"] and c["url"])

def send_sms(to, message, *, sync=False):
    """Send one SMS via the configured generic HTTP gateway. Best-effort/async by
    default; sync=True sends inline and returns {ok, detail} (used by the test button
    and OTP send). Substitutes {to}/{message}/{sender} into the operator's templates."""
    import json as _json, urllib.request, urllib.parse
    c = _sms_config()
    if not (c["enabled"] and c["url"]) or not to or not message:
        return {"ok": False, "detail": "SMS not configured"} if sync else None
    num = _normalize_whatsapp_number(to)   # same E.164-style normalisation as WhatsApp
    if not num:
        return {"ok": False, "detail": "invalid number"} if sync else None

    def _do():
        headers = {}
        raw = (c["headers"] or "").strip()
        if raw:
            try:
                hd = _json.loads(raw)
                if isinstance(hd, dict):
                    headers.update({str(k): str(v) for k, v in hd.items()})
            except Exception:
                for line in raw.splitlines():          # fallback: "Key: Value" per line
                    if ":" in line:
                        k, v = line.split(":", 1); headers[k.strip()] = v.strip()
        method = c["method"] or "POST"
        ct = c["content_type"] or "json"
        tpl = (c["body"] or "").strip()
        url = c["url"]; data = None
        if method == "GET" or ct == "query":
            qs = (tpl.replace("{to}", urllib.parse.quote(num)).replace("{message}", urllib.parse.quote(message)).replace("{sender}", urllib.parse.quote(c["sender"]))
                  if tpl else urllib.parse.urlencode({"to": num, "message": message, **({"sender": c["sender"]} if c["sender"] else {})}))
            url = url + ("&" if "?" in url else "?") + qs
            method = "GET"
        elif ct == "form":
            # x-www-form-urlencoded: every value must be percent-encoded, else a message
            # with &/=/space/newline (consent links, OTP text) corrupts the body. Substitute
            # {message} LAST so a message that contains a literal placeholder isn't re-expanded.
            if tpl:
                body_str = (tpl.replace("{to}", urllib.parse.quote_plus(num))
                               .replace("{sender}", urllib.parse.quote_plus(c["sender"]))
                               .replace("{message}", urllib.parse.quote_plus(message)))
            else:
                body_str = urllib.parse.urlencode({"to": num, "message": message, **({"sender": c["sender"]} if c["sender"] else {})})
            data = body_str.encode(); headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        else:  # json
            base_tpl = tpl or '{"to":"{to}","message":"{message}"}'
            esc = lambda s: _json.dumps(str(s))[1:-1]   # JSON-escape without the surrounding quotes
            # Escape EVERY value (a sender with a quote/backslash otherwise breaks the JSON),
            # and substitute {message} last so a message containing a placeholder isn't re-expanded.
            body_str = (base_tpl.replace("{to}", esc(num))
                                .replace("{sender}", esc(c["sender"]))
                                .replace("{message}", esc(message)))
            data = body_str.encode(); headers.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return True, f"HTTP {resp.status}"
        except Exception as e:
            return False, str(e)[:200]

    if sync:
        ok, detail = _do()
        if not ok:
            print(f"[sms] failed to {num}: {detail}")
        return {"ok": ok, "detail": detail}
    threading.Thread(target=lambda: _do(), daemon=True).start()

def notify(user_id, message, link=None, ntype="info", whatsapp=True):
    """Create one in-app notification, and email/WhatsApp it when configured.
    Best-effort: never break the caller. Pass whatsapp=False to create the in-app
    (and email) record WITHOUT pinging the phone — used to avoid WhatsApp-ing
    someone who is off-shift at the time (e.g. a night reminder to day staff)."""
    if not user_id:
        return
    try:
        q("""INSERT INTO scheduling.notifications (user_id,message,link,type)
             VALUES (%s,%s,%s,%s)""", (user_id, message, link, ntype), exec_only=True)
    except Exception:
        pass
    # Fan out to email / WhatsApp (best-effort, async).
    try:
        u = q("""SELECT u.email, COALESCE(u.email_notifications,true) AS en,
                        st.phone AS staff_phone
                 FROM scheduling.users u
                 LEFT JOIN scheduling.staff st ON st.id=u.staff_id
                 WHERE u.id=%s""", (user_id,), one=True)
        if u and u.get("email") and u.get("en"):
            send_email(u["email"], "Meena Scheduling", message)
        if u and u.get("staff_phone") and whatsapp:
            send_whatsapp(u["staff_phone"], message, ntype=ntype, link=link)
    except Exception:
        pass
    # Browser push to the user's registered devices. Gated on the same `whatsapp`
    # flag so an off-shift night reminder doesn't buzz their phone either.
    if whatsapp:
        try:
            send_web_push_to_user(user_id, message, link=link)
        except Exception:
            pass

def notify_roles(roles, message, link=None, ntype="info", exclude_user=None):
    """Notify every user holding one of `roles` (used to alert reviewers)."""
    try:
        users = q("SELECT id FROM scheduling.users WHERE role = ANY(%s)", (list(roles),))
    except Exception:
        users = []
    for u in users:
        if exclude_user and u["id"] == exclude_user:
            continue
        notify(u["id"], message, link, ntype)

def notify_staff_member(staff_id, message, link=None, ntype="info"):
    """Notify a staff member. If they have a login they get an in-app + email +
    WhatsApp notification. If they were added manually (no login), still deliver
    WhatsApp + email straight to the staff record so manual staff aren't left out."""
    u = q("SELECT id FROM scheduling.users WHERE staff_id=%s", (staff_id,), one=True)
    if u:
        notify(u["id"], message, link, ntype)
        return
    # No login account → deliver directly to the staff record's phone/email.
    st = q("SELECT phone, email FROM scheduling.staff WHERE id=%s", (staff_id,), one=True)
    if not st:
        return
    if st.get("phone"):
        send_whatsapp(st["phone"], message, ntype=ntype, link=link)
    if st.get("email"):
        send_email(st["email"], "Meena Scheduling", message)

def notify_branch_leads(branch_id, message, link=None, ntype="info"):
    """Notify the team lead(s) of a branch (role 'admin' pinned to that branch)."""
    leads = q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s", (branch_id,))
    for u in leads:
        notify(u["id"], message, link, ntype)

def _personalize(template, name):
    """Substitute the recipient's name into a circular. Supports {name} and the
    Arabic {الاسم}; a blank name falls back to a neutral greeting word."""
    nm = (name or "").strip()
    out = str(template or "")
    if "{name}" in out or "{الاسم}" in out:
        out = out.replace("{name}", nm or "there").replace("{الاسم}", nm or "زميلنا")
    return out

def _broadcast_to_staff(staff_rows, message, link, ntype):
    """Push a circular to staff: an in-app record for those with a login, plus
    WhatsApp + email to everyone (force=True so it ignores the WhatsApp type
    filter — a manager broadcast must always go out). The message is personalised
    per recipient ({name}/{الاسم}). Returns how many staff were reached on at least
    one channel."""
    n = 0
    for st in staff_rows:
        msg = _personalize(message, st.get("name"))
        u = q("SELECT id FROM scheduling.users WHERE staff_id=%s", (st["id"],), one=True)
        reached = False
        if u:
            try:
                q("""INSERT INTO scheduling.notifications (user_id,message,link,type)
                     VALUES (%s,%s,%s,%s)""", (u["id"], msg, link, ntype), exec_only=True)
                try: send_web_push_to_user(u["id"], msg, link=link, title="Meena Health")
                except Exception: pass
                reached = True
            except Exception:
                pass
        if st.get("phone"):
            send_whatsapp(st["phone"], msg, ntype=ntype, link=link, force=True); reached = True
        if st.get("email"):
            send_email(st["email"], "Meena Scheduling", msg); reached = True
        if reached:
            n += 1
    return n

# ── Leave ↔ schedule sync ─────────────────────────────────────────────────────

def _schedule_for_leave(staff_id, date):
    """The schedule id covering this staff member's branch for the leave's month."""
    return q("""SELECT sc.id FROM scheduling.schedules sc
                JOIN scheduling.staff s ON s.branch_id=sc.branch_id
                WHERE s.id=%s
                  AND sc.year=EXTRACT(YEAR FROM %s::date)::int
                  AND sc.month=EXTRACT(MONTH FROM %s::date)::int""",
             (staff_id, date, date), one=True)

def apply_leave_to_schedule(staff_id, date, code):
    """Mark the cell as leave (AL/SL/TB) so an approved leave shows on the rota
    immediately — not only after a regenerate."""
    sched = _schedule_for_leave(staff_id, date)
    if not sched:
        return
    q("""INSERT INTO scheduling.schedule_entries (schedule_id,staff_id,date,shift_code)
         VALUES (%s,%s,%s,%s)
         ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET shift_code=EXCLUDED.shift_code""",
      (sched["id"], staff_id, date, code), exec_only=True)

def clear_leave_from_schedule(staff_id, date, code):
    """Undo apply_leave_to_schedule: if the cell still shows this leave, blank it."""
    sched = _schedule_for_leave(staff_id, date)
    if not sched:
        return
    q("""UPDATE scheduling.schedule_entries SET shift_code='O'
         WHERE schedule_id=%s AND staff_id=%s AND date=%s AND shift_code=%s""",
      (sched["id"], staff_id, date, code), exec_only=True)

def _leave_rota_sync(lv, status):
    """Reflect a leave decision on the rota: approved → mark it, else clear it.
    The interim 'lead_approved' stage is NOT on the rota yet."""
    if status == "approved":
        apply_leave_to_schedule(lv["staff_id"], lv["date"], lv["leave_type"])
    elif status == "rejected":
        clear_leave_from_schedule(lv["staff_id"], lv["date"], lv["leave_type"])

# Two-stage leave approval: a staff request waits for the branch team lead
# (stage 1 → 'lead_approved'), then the manager gives final approval (stage 2 →
# 'approved') which is what lands it on the rota. A lead's own entry skips stage
# 1; a manager's entry is final immediately. Either stage can reject.
LEAVE_AWAIT_LEAD    = "pending"
LEAVE_AWAIT_MANAGER = "lead_approved"

def _leave_decide(user, current, requested):
    """Next status for an approve/reject action, given the actor's role and the
    current stage. Raises if the actor can't act at this stage."""
    if requested not in ("approved", "rejected"):
        raise HTTPException(400, "status must be 'approved' or 'rejected'")
    if current not in (LEAVE_AWAIT_LEAD, LEAVE_AWAIT_MANAGER):
        raise HTTPException(400, f"Leave is already {current}")
    if requested == "rejected":
        return "rejected"
    if user["role"] in ("manager", "superadmin"):
        return "approved"                       # final approval at either stage
    if user["role"] == "admin":                 # team lead
        if current == LEAVE_AWAIT_LEAD:
            return LEAVE_AWAIT_MANAGER           # stage 1 done → manager's turn
        raise HTTPException(403, "Only a manager can give final approval")
    raise HTTPException(403, "Forbidden")

def _notify_leave_progress(lv, new_status, actor):
    """Keep the requester, the staff member, and the next approver in the loop."""
    if new_status == LEAVE_AWAIT_MANAGER:
        notify_roles(("manager", "superadmin"),
                     f"{lv['staff_name']}'s {lv['leave_type']} leave ({lv['date']}) cleared by the team lead — awaiting your final approval",
                     link="leaves", ntype="leave")
    elif new_status in ("approved", "rejected"):
        if lv.get("created_by") and lv["created_by"] != actor["id"]:
            notify(lv["created_by"],
                   f"{lv['staff_name']}'s {lv['leave_type']} leave on {lv['date']} was {new_status}",
                   link="leaves", ntype=new_status)
        notify_staff_member(lv["staff_id"],
                            f"Your {lv['leave_type']} leave on {lv['date']} was {new_status}",
                            link="leaves", ntype=new_status)

# Rota codes that are NOT a working shift (Off / leave / on-call marker).
_NONWORK_CODES = ("O", "AL", "SL", "TB", "OC", "")
def _is_working_code(code):
    return bool(code) and str(code) not in _NONWORK_CODES

def has_approved_leave(staff_id, date):
    """True if the staff member has an APPROVED leave on this date. The source of
    truth is leave_requests — NOT the rota cell, which a manual edit / swap / cover
    may have overwritten. Used to block writing a working shift onto a leave day
    (a person can't be 'on approved leave' and 'working' the same day)."""
    if staff_id is None or not date:
        return False
    r = q("""SELECT 1 FROM scheduling.leave_requests
             WHERE staff_id=%s AND date=%s AND status='approved' LIMIT 1""",
          (staff_id, date), one=True)
    return bool(r)

def leave_coverage_gap(staff_id, date, exclude_staff=None):
    """If this staff member is scheduled a *working* shift that day and is the
    only one on it, return that shift code (a coverage gap); else None. Used to
    warn before an approved leave silently leaves a day uncovered. `exclude_staff`
    (a set of staff ids) is treated as also-leaving, so a batch that removes two
    people from the same shift is correctly flagged instead of each masking the other."""
    sched = _schedule_for_leave(staff_id, date)
    if not sched:
        return None
    cur = q("""SELECT shift_code FROM scheduling.schedule_entries
               WHERE schedule_id=%s AND staff_id=%s AND date=%s""",
            (sched["id"], staff_id, date), one=True)
    code = cur and cur["shift_code"]
    if not code or code in ("O", "AL", "SL", "TB", "OC"):
        return None  # wasn't working that day → no gap
    excl = list(exclude_staff or [])
    excl.append(staff_id)
    others = q("""SELECT COUNT(*) AS n FROM scheduling.schedule_entries
                  WHERE schedule_id=%s AND date=%s AND shift_code=%s AND staff_id <> ALL(%s)""",
               (sched["id"], date, code, excl), one=True)
    return None if (others and others["n"] > 0) else code

def _current_rota_shift(staff_id, date):
    """The working shift a staff member currently has on the rota for a date
    (None if off / on leave / no rota). Captured before a sick-leave overwrites
    it, so we can suggest cover for exactly that shift."""
    sched = _schedule_for_leave(staff_id, date)
    if not sched:
        return None
    cur = q("""SELECT shift_code FROM scheduling.schedule_entries
               WHERE schedule_id=%s AND staff_id=%s AND date=%s""",
            (sched["id"], staff_id, date), one=True)
    code = cur and cur["shift_code"]
    if not code or code in ("O", "AL", "SL", "TB", "OC"):
        return None
    return code

# ── Nest helpers ──────────────────────────────────────────────────────────────

def branch_to_nest(branch_name: str) -> Optional[str]:
    n = (branch_name or "").upper()
    if "NEST 1" in n or "NEST1" in n: return "NEST1"
    if "NEST 2" in n or "NEST2" in n: return "NEST2"
    if "NEST 3" in n or "NEST3" in n: return "NEST3"
    if "NEST 4" in n or "NEST4" in n: return "NEST4"
    if "NEST 6" in n or "NEST6" in n: return "NEST6"
    if "Y5" in n or "JUBAIL" in n or "AL-JUBAIL" in n: return "Y5"
    return None

def _branch_id_for_nest(nest_key):
    """Reverse of branch_to_nest: which branch owns this nest_key (or the
    BRANCH_<id> fallback used for branches with no recognised nest)."""
    for b in q("SELECT id, name FROM scheduling.branches"):
        if branch_to_nest(b["name"]) == nest_key or f"BRANCH_{b['id']}" == nest_key:
            return b["id"]
    return None

def get_nest_sections(nest_key: str, year: int = None, month: int = None) -> list:
    # Shift types are global; sections implicitly allow all codes.
    global_codes = [r["code"] for r in q("""SELECT code FROM scheduling.shift_types
                                           WHERE branch_id IS NULL
                                           ORDER BY sort_order, code""")]
    if not global_codes:
        global_codes = ["M","N","O","AL","SL","OC","TB","D","D1","EV","A","B","C","N6","Y3","D_US","R","R1"]

    if year and month:
        rows = q("""
            SELECT ns.id,ns.nest_key,ns.section_name,ns.staff,ns.staff_db_names,
                   ns.allowed_shifts,ns.coverage,ns.exact_coverage,ns.sort_order,ns.updated_at,
                   COALESCE(sms.min_m,1) AS min_m, COALESCE(sms.max_m,2) AS max_m,
                   COALESCE(sms.min_n,1) AS min_n, COALESCE(sms.max_n,2) AS max_n,
                   COALESCE(sms.max_consecutive,4) AS max_consecutive,
                   COALESCE(sms.min_o_block,2) AS min_o_block,
                   COALESCE(sms.max_o_block,0) AS max_o_block
            FROM scheduling.nest_sections ns
            LEFT JOIN scheduling.section_month_settings sms
              ON sms.section_id=ns.id AND sms.year=%s AND sms.month=%s
            WHERE ns.nest_key=%s ORDER BY ns.sort_order,ns.section_name
        """, (year, month, nest_key))
    else:
        rows = q("""SELECT id,nest_key,section_name,staff,staff_db_names,
                           allowed_shifts,coverage,exact_coverage,sort_order,updated_at,
                           1 AS min_m, 2 AS max_m, 1 AS min_n, 2 AS max_n,
                           4 AS max_consecutive,
                           2 AS min_o_block,
                           0 AS max_o_block
                    FROM scheduling.nest_sections WHERE nest_key=%s
                    ORDER BY sort_order,section_name""", (nest_key,))
    for r in rows:
        r["allowed_shifts"] = global_codes
    return rows

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Meena Scheduling")

# The dashboard is served from the same origin, so cross-origin access is off by
# default. Set CORS_ORIGINS (comma-separated) only if a separate frontend needs it.
_CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_CORS_ORIGINS,
                   allow_credentials=bool(_CORS_ORIGINS),
                   allow_methods=["*"], allow_headers=["*"])
# Compress JSON/text responses — worklists, rosters, stats and base64 payloads are
# large and highly repetitive, so gzip typically cuts them ~70-85% over the wire.
try:
    from starlette.middleware.gzip import GZipMiddleware
    app.add_middleware(GZipMiddleware, minimum_size=1024)
except Exception:
    pass

@app.middleware("http")
async def _no_store_api(request: Request, call_next):
    """API data is dynamic — never let the browser or a CDN cache it, or a read
    right after an edit can serve a stale copy (the rota 'reverting' after a save).
    Static assets keep their own (versioned) caching."""
    resp = await call_next(request)
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
    # Baseline security headers on every response (PHI app). Clickjacking, MIME
    # sniffing, referrer leakage, and downgrade. CSP is intentionally omitted for
    # now — the SPA uses inline handlers and a strict policy would break it; add a
    # tested policy separately. HSTS is only honoured over HTTPS (Railway is HTTPS).
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return resp

def backfill_us_sections():
    """One-time restore of the Ultrasound (US) section tagging.

    Section assignment moved from the nest-config staff lists to staff.speciality,
    but existing US staff were never migrated — so across every branch they
    defaulted to General and the schedule's General/US split silently disappeared.
    This re-tags speciality=['US'] for staff whose name is in their nest's US list
    (from seed_nest_sections), only where it isn't already US, and only once."""
    try:
        if get_setting("us_section_backfill_v2") == "done":
            return
        import json as _json
        us_rows = q("""SELECT nest_key, staff_db_names FROM scheduling.nest_sections
                       WHERE UPPER(section_name) IN ('US', 'ULTRASOUND')""")
        # Per nest: the set of seeded US member names, each as a token set. We match
        # leniently — a staff member is US if a seed name's tokens are all present in
        # their name (e.g. seed "Alma Tolentino" matches "Alma Quenie Tolentino", and
        # "Manar" matches "Manar Almumtin"). Only ever SETS US; never removes it.
        def _tokens(name):
            return {t for t in re.split(r"\s+", str(name or "").strip().lower()) if t}
        seeds_by_nest = {}
        for r in us_rows:
            raw = r.get("staff_db_names") or {}
            m = raw if isinstance(raw, dict) else _json.loads(raw or "{}")
            toks = [_tokens(v) for v in m.values() if v and _tokens(v)]
            if toks:
                seeds_by_nest.setdefault(r["nest_key"], []).extend(toks)
        tagged = 0
        if seeds_by_nest:
            for b in q("SELECT id,name FROM scheduling.branches"):
                seeds = seeds_by_nest.get(branch_to_nest(b["name"]))
                if not seeds:
                    continue
                for s in q("SELECT id,name,speciality FROM scheduling.staff WHERE branch_id=%s", (b["id"],)):
                    stoks = _tokens(s["name"])
                    if not any(seed and seed.issubset(stoks) for seed in seeds):
                        continue
                    cur = [str(x).strip().upper() for x in (s.get("speciality") or [])]
                    if "US" not in cur and "ULTRASOUND" not in cur:
                        q("UPDATE scheduling.staff SET speciality=%s WHERE id=%s", (["US"], s["id"]), exec_only=True)
                        tagged += 1
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('us_section_backfill_v2','done')
             ON CONFLICT (key) DO UPDATE SET value='done'""", exec_only=True)
        if tagged:
            print(f"[backfill] tagged {tagged} staff as US section from nest config")
    except Exception as e:
        print(f"[backfill] us-section skipped: {e}")

@app.on_event("startup")
def startup():
    init_schema()
    seed_defaults()
    seed_nest_config()
    seed_admin()
    backfill_us_sections()
    start_scheduler()
    _start_worklist_mirror()   # background: keep the worklist board warm in our own DB

# ── Static dashboard ──────────────────────────────────────────────────────────

DASHBOARD = os.path.join(os.path.dirname(__file__), '..', 'dashboard')

# ── Automatic cache-busting ───────────────────────────────────────────────────
# Every deploy must invalidate the browser's cached JS/CSS with ZERO manual work
# (hand-bumped ?v= tags drifted and shipped stale code — the "stuck on old cache"
# bug). We compute ONE build id per deploy and stamp it onto every asset URL in
# index.html and onto the service-worker cache name as we serve them. A redeploy
# re-clones the repo → new file mtimes → new build id → the browser fetches fresh;
# a mere worker restart keeps the same id, so we don't bust cache for nothing.
import glob as _glob, hashlib as _hashlib, re as _re_cb
def _compute_build_id():
    sha = (os.environ.get("RAILWAY_GIT_COMMIT_SHA") or os.environ.get("SOURCE_VERSION")
           or os.environ.get("GIT_COMMIT") or "")
    if sha:
        return sha[:12]
    try:
        # Hash asset CONTENT, not mtime: a redeploy that doesn't bump mtimes (or a real
        # code change with an unchanged mtime) must still advance the id, otherwise BOTH
        # the ?v= URL buster and the SW cache name stay stuck and the device is pinned to
        # old code with no recovery path.
        files = sorted(_glob.glob(os.path.join(DASHBOARD, "js", "*.js")))
        files += sorted(_glob.glob(os.path.join(DASHBOARD, "css", "*.css")))
        files += [os.path.join(DASHBOARD, n) for n in ("index.html", "sw.js", "style.css")]
        h = _hashlib.md5()
        for f in files:
            if os.path.exists(f):
                with open(f, "rb") as fh:
                    h.update(fh.read())
        return h.hexdigest()[:12]
    except Exception:
        return "dev"
BUILD_ID = _compute_build_id()
_ASSET_VER_RE = _re_cb.compile(r'\?v=[0-9A-Za-z._-]+')

# Precompute the stamped index.html + sw.js once per process (build id is fixed for
# the life of the deploy) so we don't re-read/re-regex on every request.
def _stamped(name, transform):
    try:
        with open(os.path.join(DASHBOARD, name), encoding="utf-8") as f:
            return transform(f.read())
    except Exception:
        return None
_INDEX_HTML = _stamped("index.html", lambda h: _ASSET_VER_RE.sub(f'?v={BUILD_ID}', h)
                        .replace('</head>', f'<meta name="meena-build" content="{BUILD_ID}"></head>', 1))
_SW_JS = _stamped("sw.js", lambda j: _re_cb.sub(r"const CACHE\s*=\s*'[^']*'", f"const CACHE = 'meena-{BUILD_ID}'", j, count=1))

@app.get("/api/build")
def serve_build_id():
    """The current deploy's build id. The client compares it to the build baked into the
    page it loaded; a mismatch means a new deploy landed, so it can reload ONCE on its own
    terms (fixes the frozen-hadController stale-tab case and gives a recovery path even if
    the SW cache is stale). No auth — it's just a version string."""
    return Response('{"build":"%s"}' % BUILD_ID, media_type="application/json",
                    headers={"Cache-Control": "no-store"})

app.mount("/js", StaticFiles(directory=os.path.join(DASHBOARD, "js")), name="js")
# Split-out per-page stylesheets (worklist.css, radstats.css) loaded on demand by main.js.
app.mount("/css", StaticFiles(directory=os.path.join(DASHBOARD, "css")), name="css")
# Self-hosted WOFF2 fonts (subsetted Poppins + Cairo) + their @font-face CSS. Ensure the
# woff2 MIME is registered so StaticFiles serves `font/woff2` (a wrong type makes the browser
# ignore the file and fall back to a system font). Fonts are immutable per build.
mimetypes.add_type("font/woff2", ".woff2")
app.mount("/fonts", StaticFiles(directory=os.path.join(DASHBOARD, "fonts")), name="fonts")

@app.get("/style.css")
def serve_css():
    return FileResponse(
        os.path.join(DASHBOARD, "style.css"),
        media_type="text/css",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )

@app.get("/dt")
def serve_downtime_public():
    """Public, no-login downtime form (opened from the shared link)."""
    return FileResponse(
        os.path.join(DASHBOARD, "downtime-public.html"),
        media_type="text/html",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )

@app.get("/reports")
def serve_reports_public():
    """Public, login-free radiology report lookup (shared link for doctors)."""
    return FileResponse(
        os.path.join(DASHBOARD, "reports-public.html"),
        media_type="text/html",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )

@app.get("/cdupload")
def serve_cdupload_public():
    """Public, login-free radiology-CD upload page (shared link for a branch)."""
    return FileResponse(
        os.path.join(DASHBOARD, "cdupload-public.html"),
        media_type="text/html",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )

@app.get("/sw.js")
def serve_service_worker():
    """Served from root so the service worker controls the whole app scope. The cache
    name is stamped with the per-deploy build id so a new deploy purges the old cache
    automatically (the `activate` handler drops every cache whose key != CACHE)."""
    if _SW_JS is not None:
        return Response(_SW_JS, media_type="application/javascript",
                        headers={"Cache-Control": "no-cache, must-revalidate", "Service-Worker-Allowed": "/"})
    return FileResponse(os.path.join(DASHBOARD, "sw.js"), media_type="application/javascript",
                        headers={"Cache-Control": "no-cache, must-revalidate", "Service-Worker-Allowed": "/"})

@app.get("/manifest.json")
def serve_manifest():
    return FileResponse(
        os.path.join(DASHBOARD, "manifest.json"),
        media_type="application/manifest+json",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )

@app.get("/icon-192.png")
def serve_icon_192():
    return FileResponse(os.path.join(DASHBOARD, "icon-192.png"), media_type="image/png")

@app.get("/icon-512.png")
def serve_icon_512():
    return FileResponse(os.path.join(DASHBOARD, "icon-512.png"), media_type="image/png")

@app.get("/icon-maskable-512.png")
def serve_icon_maskable():
    return FileResponse(os.path.join(DASHBOARD, "icon-maskable-512.png"), media_type="image/png")

@app.get("/apple-touch-icon.png")
def serve_apple_touch_icon():
    return FileResponse(os.path.join(DASHBOARD, "apple-touch-icon.png"), media_type="image/png")

@app.get("/meena_logo_transparent.png")
def serve_logo():
    return FileResponse(os.path.join(DASHBOARD, "meena_logo_transparent.png"))

@app.get("/meena_logo.png")
def serve_logo_v2():
    p = os.path.join(DASHBOARD, "meena_logo.png")
    return FileResponse(p) if os.path.exists(p) else FileResponse(os.path.join(DASHBOARD, "meena_logo_transparent.png"))

@app.get("/logo.png")
def serve_logo2():
    p = os.path.join(DASHBOARD, "logo.png")
    return FileResponse(p) if os.path.exists(p) else FileResponse(os.path.join(DASHBOARD, "meena_logo_transparent.png"))

@app.get("/meena_email_logo.jpeg")
def serve_email_logo():
    p = os.path.join(DASHBOARD, "meena_email_logo.jpeg")
    return FileResponse(p) if os.path.exists(p) else FileResponse(os.path.join(DASHBOARD, "meena_logo_transparent.png"))

@app.get("/meena_onboarding_logo.jpeg")
def serve_onboarding_logo():
    p = os.path.join(DASHBOARD, "meena_onboarding_logo.jpeg")
    return FileResponse(p) if os.path.exists(p) else FileResponse(os.path.join(DASHBOARD, "meena_logo_transparent.png"))

@app.get("/nafath_logo.png")
def serve_nafath_logo():
    p = os.path.join(DASHBOARD, "nafath_logo.png")
    return FileResponse(p) if os.path.exists(p) else FileResponse(os.path.join(DASHBOARD, "meena_logo_transparent.png"))

@app.get("/sdaia_logo.png")
def serve_sdaia_logo():
    p = os.path.join(DASHBOARD, "sdaia_logo.png")
    return FileResponse(p) if os.path.exists(p) else FileResponse(os.path.join(DASHBOARD, "meena_logo_transparent.png"))

# ═══════════════════════════════════════════════════════════════════════════════
# API ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

# ── Auth ──────────────────────────────────────────────────────────────────────

@app.post("/api/auth/login")
async def login(request: Request, response: Response):
    body = await request.json()
    username = (body.get("username") or "").strip().lower()
    password = body.get("password") or ""
    if not username or not password:
        raise HTTPException(400, "Username and password required")

    _login_throttle_check(username)
    user = q("""SELECT u.*, b.name AS branch_name FROM scheduling.users u
                LEFT JOIN scheduling.branches b ON b.id=u.branch_id
                WHERE u.username=%s""", (username,), one=True)
    if not user or not bcrypt.checkpw(password.encode(), user["password"].encode()):
        _login_throttle_fail(username)
        raise HTTPException(401, "Invalid credentials")
    _login_fails.pop(username, None)  # clear on success

    payload = {k: user[k] for k in ("id","username","role","branch_id","branch_name")}
    payload["staff_id"] = user.get("staff_id")
    payload["epoch"] = int(user.get("token_epoch") or 0)
    token = sign_token(payload)
    # The client builds currentUser from THIS response on a fresh login — it must carry
    # the per-user radiology grants or a staff member granted the worklist sees no
    # radiology section until their next session restore (/auth/me has them; this didn't).
    payload["can_use_radiology"] = bool(user.get("can_use_radiology"))
    payload["can_file_radiology"] = bool(user.get("can_file_radiology"))
    # Effective permissions — the client gates every nav item + route on this list.
    payload["perms"] = sorted(effective_perms(user))
    # Secure cookie in production (HTTPS). Set COOKIE_SECURE=0 only for local HTTP.
    response.set_cookie("token", token, httponly=True, samesite="lax",
                        secure=os.environ.get("COOKIE_SECURE", "1") != "0",
                        max_age=JWT_DAYS * 86400)
    return payload

@app.post("/api/auth/change-password")
async def change_password(request: Request, response: Response, user=Depends(get_current_user)):
    """Let a signed-in user change their own password (any role). Verifies the
    current password, bumps the session epoch (killing OTHER sessions) and
    re-issues this session's cookie so the current tab stays signed in."""
    body = await request.json()
    current = body.get("current_password") or ""
    new = body.get("new_password") or ""
    if len(new) < 6:
        raise HTTPException(400, "New password must be at least 6 characters")
    row = q("SELECT password FROM scheduling.users WHERE id=%s", (user["id"],), one=True)
    if not row or not bcrypt.checkpw(current.encode(), row["password"].encode()):
        raise HTTPException(403, "Current password is incorrect")
    hashed = bcrypt.hashpw(new.encode(), bcrypt.gensalt()).decode()
    updated = q("""UPDATE scheduling.users
                   SET password=%s, token_epoch=COALESCE(token_epoch,0)+1
                   WHERE id=%s RETURNING token_epoch""", (hashed, user["id"]), one=True)
    # Re-issue this session's token with the new epoch so the current tab isn't
    # logged out by its own change (other devices/sessions will be).
    payload = {k: user.get(k) for k in ("id", "username", "role", "branch_id", "branch_name", "staff_id")}
    payload["epoch"] = int(updated["token_epoch"])
    response.set_cookie("token", sign_token(payload), httponly=True, samesite="lax",
                        secure=os.environ.get("COOKIE_SECURE", "1") != "0",
                        max_age=JWT_DAYS * 86400)
    insert_audit(user, "CHANGE_PASSWORD", user.get("username"))
    return {"ok": True}

@app.post("/api/auth/logout")
def logout(response: Response):
    # Clear with the SAME attributes the cookie was set with (path/samesite/
    # secure) so the browser reliably drops it — a mismatch can leave the cookie
    # in place and make logout look like it did nothing.
    response.delete_cookie("token", path="/", samesite="lax",
                           secure=os.environ.get("COOKIE_SECURE", "1") != "0")
    return {"ok": True}

def _hash_reset_token(tok: str) -> str:
    import hashlib
    return hashlib.sha256(tok.encode()).hexdigest()

@app.post("/api/auth/forgot")
async def forgot_password(request: Request):
    """Start a password reset. Emails a time-limited link to the address on file.
    Always returns the same generic message so it can't be used to probe which
    usernames/emails exist."""
    body = await request.json()
    ident = (body.get("username") or body.get("email") or "").strip().lower()
    generic = {"ok": True, "message": "If an account with that username/email exists, a reset link has been sent."}
    if not ident:
        return generic
    user = q("""SELECT id, username, email FROM scheduling.users
                WHERE lower(username)=%s OR lower(email)=%s""", (ident, ident), one=True)
    if not user or not user.get("email"):
        return generic   # don't reveal non-existence / missing email
    import secrets
    from datetime import datetime, timezone, timedelta
    tok = secrets.token_urlsafe(32)
    # Invalidate any earlier outstanding tokens, then store the new one (hashed).
    q("UPDATE scheduling.password_resets SET used=true WHERE user_id=%s AND used=false",
      (user["id"],), exec_only=True)
    q("""INSERT INTO scheduling.password_resets (user_id, token_hash, expires_at)
         VALUES (%s,%s,%s)""",
      (user["id"], _hash_reset_token(tok), datetime.now(timezone.utc) + timedelta(hours=1)),
      exec_only=True)
    app_url = os.environ.get("APP_URL", "").strip().rstrip("/")
    link = f"{app_url}/?reset={tok}" if app_url else f"/?reset={tok}"
    send_email(user["email"], "Meena Scheduling — password reset",
               f"We received a request to reset the password for your account ({user['username']}).\n\n"
               f"Open this link to set a new password (valid for 1 hour):\n{link}\n\n"
               f"If you didn't request this, you can safely ignore this email.")
    insert_audit({"id": user["id"], "username": user["username"]}, "PASSWORD_RESET_REQUEST", user["username"])
    return generic

@app.post("/api/auth/reset")
async def reset_password(request: Request):
    """Finish a reset: consume the token, set the new password, and invalidate
    every existing session for that user."""
    body = await request.json()
    tok = (body.get("token") or "").strip()
    password = body.get("password") or ""
    if not tok or len(password) < 6:
        raise HTTPException(400, "A valid token and a password of at least 6 characters are required")
    row = q("""SELECT pr.id, pr.user_id FROM scheduling.password_resets pr
               WHERE pr.token_hash=%s AND pr.used=false AND pr.expires_at > NOW()""",
            (_hash_reset_token(tok),), one=True)
    if not row:
        raise HTTPException(400, "This reset link is invalid or has expired. Please request a new one.")
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    # Set password + bump epoch (kills old tokens), and consume this reset token.
    q("UPDATE scheduling.users SET password=%s, token_epoch=COALESCE(token_epoch,0)+1 WHERE id=%s",
      (hashed, row["user_id"]), exec_only=True)
    q("UPDATE scheduling.password_resets SET used=true WHERE id=%s", (row["id"],), exec_only=True)
    insert_audit({"id": row["user_id"], "username": "self"}, "PASSWORD_RESET_DONE", f"user:{row['user_id']}")
    return {"ok": True, "message": "Your password has been reset. You can now sign in."}

# ── Self-service staff onboarding ─────────────────────────────────────────────
# An open link (carrying a shared code) lets staff submit their own details so
# the manager doesn't keep them by hand. Employee/National ID is the unique key
# that disambiguates people who share a name.

def _is_meena_email(email: str) -> bool:
    """Only accept a Meena work email — must contain '@meena' (e.g. @meena-health.com).
    Blocks personal gmail/hotmail/etc. sign-ups."""
    e = (email or "").strip().lower()
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", e)) and "@meena" in e

def _registration_code():
    """The current registration code, or None when onboarding is closed."""
    code = get_setting("registration_code", "off")
    return None if (not code or code == "off") else code

def _registration_open():
    """Self-registration is OPEN by default (no invite code needed) — a superadmin
    can close it by setting `registration_open` to 'off'."""
    return get_setting("registration_open", "on") != "off"

def _assert_registration_open():
    if not _registration_open():
        raise HTTPException(403, "Staff registration is currently closed. Please ask your manager.")

def _check_registration_code(code):
    cur = _registration_code()
    if not cur or (code or "") != cur:
        raise HTTPException(403, "Staff registration is closed. Ask your manager for the current link.")

# ── Nafath (Sadq) identity verification ───────────────────────────────────────
def _sadq_base():
    return os.environ.get("SADQ_BASE_URL", "https://api-sandbox.sadq-sa.com").rstrip("/")
def _sadq_account_id():
    return os.environ.get("SADQ_ACCOUNT_ID", "").strip()
def _sadq_thumbprint():
    return os.environ.get("SADQ_THUMBPRINT", "").strip()
def _sadq_mock():
    return os.environ.get("SADQ_MOCK") == "1"
def _sadq_configured():
    return bool(_sadq_account_id() and _sadq_thumbprint())

def _nafath_enabled():
    """Nafath is enforced when it's configured (prod sets SADQ_* env vars) or in
    mock mode — unless a superadmin explicitly turns it off."""
    if get_setting("nafath_required", "on") == "off":
        return False
    return _sadq_configured() or _sadq_mock()

def _nafath_webhook_url():
    base = os.environ.get("APP_URL", "").strip().rstrip("/")
    return f"{base}/api/nafath/webhook" if base else ""

def _valid_national_id(nid):
    """Saudi National ID / Iqama: 10 digits, citizen (1xxxxxxxxx) or resident (2…)."""
    return bool(re.match(r"^[12]\d{9}$", (nid or "").strip()))

def _join_name(*parts):
    return " ".join(str(p).strip() for p in parts if p and str(p).strip())

def _ci_get(d, *keys):
    """Case-insensitive lookup over a dict (Sadq's field casing varies)."""
    if not isinstance(d, dict):
        return None
    low = {str(k).lower(): v for k, v in d.items()}
    for k in keys:
        v = low.get(str(k).lower())
        if v not in (None, ""):
            return v
    return None

def _sadq_nafath_auth(national_ids, request_id, webhook_url):
    """Call IntegrationNafathAuth → returns the per-ID result list (each item has
    nationalId, transId, random, error). The `random` is the number the user
    selects in the Nafath app; the final result arrives later via webhook."""
    payload = {"nationalIds": national_ids, "requestId": request_id,
               "accountId": _sadq_account_id(), "webHookUrl": webhook_url}
    if _sadq_mock():
        # Deterministic fake for tests/local — matches the sandbox OTP (1234).
        results = [{"nationalId": nid, "transId": f"mock-{request_id[:8]}",
                    "random": "1234", "error": None, "code": None, "status": None}
                   for nid in national_ids]
        _sadq_outbox.append({"payload": payload, "results": results})
        return results
    import urllib.request, urllib.error
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{_sadq_base()}/Authentication/Authority/IntegrationNafathAuth",
        data=data, method="POST",
        headers={"thumbPrint": _sadq_thumbprint(), "accountId": _sadq_account_id(),
                 "Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": "MeenaScheduling/1.0 (+https://meena-health.com)"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Sadq {e.code}: {e.read().decode('utf-8', 'replace')}") from None
    try:
        parsed = json.loads(raw) if raw else []
    except ValueError:
        raise RuntimeError(f"Sadq returned non-JSON: {raw[:200]}")
    return parsed if isinstance(parsed, list) else [parsed]

@app.post("/api/register/nafath/start")
async def nafath_start(request: Request):
    """Kick off Nafath verification for a National ID during sign-up. Returns the
    `random` number the user must select in their Nafath app."""
    _assert_registration_open()
    body = await request.json()
    nid = (body.get("national_id") or "").strip()
    if not _valid_national_id(nid):
        raise HTTPException(400, "Enter a valid 10-digit National ID / Iqama (starts with 1 or 2)")
    if not (_sadq_configured() or _sadq_mock()):
        raise HTTPException(503, "Nafath verification isn't configured on the server yet. Ask your admin.")
    webhook = _nafath_webhook_url()
    if not _sadq_mock() and not webhook:
        raise HTTPException(503, "Server public URL (APP_URL) isn't set, so Nafath can't return the result. Ask your admin.")
    # Throttle: one new request per National ID per 30 seconds.
    prev = q("""SELECT created_at FROM scheduling.nafath_verifications
                WHERE national_id=%s ORDER BY created_at DESC LIMIT 1""", (nid,), one=True)
    if prev and prev.get("created_at") and \
       (datetime.now(timezone.utc) - prev["created_at"]).total_seconds() < 30:
        raise HTTPException(429, "A verification was just started — please wait a moment before retrying.")
    request_id = str(uuid.uuid4())
    try:
        results = _sadq_nafath_auth([nid], request_id, webhook)
    except Exception as e:
        raise HTTPException(502, f"Couldn't reach Nafath: {e}")
    # Log status only — never the national ID or the raw response (names/IDs = PHI).
    r0 = (results or [{}])[0] or {}
    print(f"[nafath] start req={request_id} ok={not _ci_get(r0, 'error', 'errorMessage', 'message')}", file=sys.stderr)
    err = _ci_get(r0, "error", "errorMessage", "message")
    random_code = str(_ci_get(r0, "random", "randomNumber", "code", "otp") or "")
    trans_id = _ci_get(r0, "transId", "transactionId", "id")
    # Only fail if Nafath gave an error AND no number to act on.
    if err and not random_code:
        raise HTTPException(400, f"Nafath rejected this request: {err}")
    q("""INSERT INTO scheduling.nafath_verifications
           (request_id, national_id, status, trans_id, random_code, created_at, updated_at)
         VALUES (%s,%s,'pending',%s,%s,NOW(),NOW())""",
      (request_id, nid, trans_id, random_code), exec_only=True)
    return {"ok": True, "request_id": request_id, "random": random_code}

@app.get("/api/register/nafath/status")
def nafath_status(request: Request):
    """Poll the verification result while the user approves in their Nafath app."""
    rid = (request.query_params.get("request_id") or "").strip()
    if not rid:
        raise HTTPException(400, "request_id required")
    row = q("""SELECT status, name_ar, name_en, official_national_id, national_id
               FROM scheduling.nafath_verifications WHERE request_id=%s""", (rid,), one=True)
    if not row:
        raise HTTPException(404, "Unknown verification request")
    return {"status": row["status"], "name_ar": row.get("name_ar"),
            "name_en": row.get("name_en"),
            "national_id": row.get("official_national_id") or row.get("national_id")}

@app.post("/api/nafath/webhook")
async def nafath_webhook(request: Request):
    """Public callback from Sadq/Nafath with the auth result. Matched by the
    unguessable requestId we generated. Always answers 200 so Sadq won't retry."""
    try:
        body = await request.json()
    except Exception:
        return {"ok": False}
    rid = str(body.get("requestId") or body.get("RequestId") or "").strip()
    if not rid:
        return {"ok": False}
    row = q("""SELECT request_id, national_id, status FROM scheduling.nafath_verifications
               WHERE request_id=%s""", (rid,), one=True)
    if not row:
        return {"ok": False}                       # unknown request — ignore quietly
    status_val = body.get("Status", body.get("status"))
    success = str(status_val) == "0"
    if success:
        users = body.get("usersInfo") or body.get("UsersInfo") or []
        u = (users[0] if users else {}) or {}
        off_nid = str(u.get("NationalId") or "").strip() or row["national_id"]
        # The verified National ID must match the one we asked about.
        if off_nid and row["national_id"] and off_nid != row["national_id"]:
            q("UPDATE scheduling.nafath_verifications SET status='failed', updated_at=NOW() WHERE request_id=%s",
              (rid,), exec_only=True)
            return {"ok": True}
        name_en = _join_name(u.get("FirstNameEn"), u.get("LastNameEn"))
        name_ar = _join_name(u.get("FirstNameAr"), u.get("MiddleNameAr"),
                             u.get("ThirdNameAr"), u.get("LastNameAr"))
        q("""UPDATE scheduling.nafath_verifications
             SET status='verified', name_ar=%s, name_en=%s, official_national_id=%s, updated_at=NOW()
             WHERE request_id=%s""", (name_ar or None, name_en or None, off_nid, rid), exec_only=True)
    else:
        q("UPDATE scheduling.nafath_verifications SET status='failed', updated_at=NOW() WHERE request_id=%s",
          (rid,), exec_only=True)
    return {"ok": True}

@app.get("/api/register/info")
def register_info(request: Request):
    """Branch list for the onboarding form. Open registration — no code needed."""
    _assert_registration_open()
    branches = q("SELECT id, name FROM scheduling.branches ORDER BY name")
    return {"ok": True, "branches": branches, "nafath_enabled": _nafath_enabled(),
            "phone_verify_enabled": _phone_verify_enabled()}

import secrets as _secrets_mod

# ── Mobile-number verification over WhatsApp ──────────────────────────────────
def _phone_verify_enabled():
    """Phone verification (WhatsApp code) is on when the bridge is configured —
    unless explicitly turned off with PHONE_VERIFY=off. The off switch lets you
    keep registration working (email + Nafath still verify identity) if the
    WhatsApp bridge is ever down or unlinked, without touching the VPS."""
    if (os.environ.get("PHONE_VERIFY") or "").strip().lower() in ("off", "0", "false", "no"):
        return False
    return bool((os.environ.get("WHATSAPP_NOTIFY_URL") or "").strip()) or bool(os.environ.get("WHATSAPP_CAPTURE"))

@app.post("/api/register/send-phone-code")
async def register_send_phone_code(request: Request):
    """WhatsApp a 6-digit code to the registrant's mobile to confirm they own it."""
    _assert_registration_open()
    body = await request.json()
    to = _normalize_whatsapp_number(body.get("phone"))
    if not to:
        raise HTTPException(400, "Enter a valid mobile number first")
    if not (_sms_configured() or _phone_verify_enabled()):
        raise HTTPException(503, "Phone verification isn't set up on the server yet. Ask your admin.")
    # Throttle: one code per 45 seconds per number.
    prev = q("SELECT created_at FROM scheduling.phone_verifications WHERE phone=%s", (to,), one=True)
    if prev and prev.get("created_at") and \
       (datetime.now(timezone.utc) - prev["created_at"]).total_seconds() < 45:
        raise HTTPException(429, "A code was just sent — please wait a moment before requesting another.")
    code = f"{_secrets_mod.randbelow(900000) + 100000}"
    q("""INSERT INTO scheduling.phone_verifications (phone, code, expires_at, attempts, created_at)
         VALUES (%s,%s,%s,0,NOW())
         ON CONFLICT (phone) DO UPDATE SET code=EXCLUDED.code, expires_at=EXCLUDED.expires_at,
                                           attempts=0, created_at=NOW()""",
      (to, code, datetime.now(timezone.utc) + timedelta(minutes=10)), exec_only=True)
    text = (f"Meena Scheduling verification code: {code}\n\n"
            f"It expires in 10 minutes. Enter it on the sign-up form to confirm your mobile number.")
    # Prefer SMS when a gateway is configured; otherwise fall back to WhatsApp.
    channel = "sms" if _sms_configured() else "whatsapp"
    try:
        if channel == "sms":
            res = send_sms(to, text, sync=True)
            if not (res and res.get("ok")):
                raise Exception((res or {}).get("detail") or "SMS send failed")
        else:
            _whatsapp_send_now(to, text)
    except Exception as e:
        raise HTTPException(502, f"Couldn't send the {channel.upper()} code: {e}")
    return {"ok": True, "channel": channel}

def _verify_phone_code(phone_raw, code, consume=True):
    """Validate a WhatsApp code for the number; raise 400 if missing/expired/wrong.
    With consume=False the code is checked but kept (used to gate a wizard step)."""
    to = _normalize_whatsapp_number(phone_raw)
    code = (code or "").strip()
    if not to:
        raise HTTPException(400, "Enter a valid mobile number")
    row = q("SELECT code, expires_at, attempts FROM scheduling.phone_verifications WHERE phone=%s", (to,), one=True)
    if not row:
        raise HTTPException(400, "Please request a WhatsApp code for your mobile first")
    if row["attempts"] >= 6:
        raise HTTPException(400, "Too many wrong attempts — request a new code")
    if row["expires_at"] and row["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(400, "Your WhatsApp code expired — request a new one")
    if not code or code != row["code"]:
        q("UPDATE scheduling.phone_verifications SET attempts=attempts+1 WHERE phone=%s", (to,), exec_only=True)
        raise HTTPException(400, "Incorrect WhatsApp code")
    if consume:
        q("DELETE FROM scheduling.phone_verifications WHERE phone=%s", (to,), exec_only=True)

@app.post("/api/register/check-phone-code")
async def register_check_phone_code(request: Request):
    """Validate the WhatsApp code WITHOUT consuming it, so the sign-up wizard can
    confirm the step before moving on (the code is consumed at final submit)."""
    _assert_registration_open()
    body = await request.json()
    _verify_phone_code(body.get("phone"), body.get("phone_code"), consume=False)
    return {"ok": True}

@app.post("/api/register/check-email-code")
async def register_check_email_code(request: Request):
    """Validate the email code WITHOUT consuming it (wizard step gate)."""
    _assert_registration_open()
    body = await request.json()
    _verify_email_code(body.get("email"), body.get("email_code"), consume=False)
    return {"ok": True}

@app.post("/api/register/send-code")
async def register_send_code(request: Request):
    """Email a 6-digit verification code to a Meena address so we can confirm the
    registrant owns it before their sign-up is accepted."""
    _assert_registration_open()
    body = await request.json()
    email = (body.get("email") or "").strip().lower()
    if not _is_meena_email(email):
        raise HTTPException(400, "Use your Meena work email (must contain @meena)")
    # Throttle: one code per 45 seconds per address.
    prev = q("SELECT created_at FROM scheduling.email_verifications WHERE email=%s", (email,), one=True)
    if prev and prev.get("created_at") and \
       (datetime.now(timezone.utc) - prev["created_at"]).total_seconds() < 45:
        raise HTTPException(429, "A code was just sent — please wait a moment before requesting another.")
    # No provider configured (and not in test capture) → don't pretend we sent it.
    # A Power Automate webhook counts as a provider, same as Resend/SMTP.
    if not (_email_webhook_url() or os.environ.get("SMTP_CAPTURE")
            or os.environ.get("RESEND_API_KEY") or os.environ.get("SMTP_HOST")):
        raise HTTPException(503, "Email isn't set up on the server yet, so codes can't be sent. Ask your admin.")
    code = f"{_secrets_mod.randbelow(900000) + 100000}"
    q("""INSERT INTO scheduling.email_verifications (email, code, expires_at, attempts, created_at)
         VALUES (%s,%s,%s,0,NOW())
         ON CONFLICT (email) DO UPDATE SET code=EXCLUDED.code, expires_at=EXCLUDED.expires_at,
                                           attempts=0, created_at=NOW()""",
      (email, code, datetime.now(timezone.utc) + timedelta(minutes=10)), exec_only=True)
    send_email(email, "Your Meena verification code",
               f"Your verification code is {code}\n\nIt expires in 10 minutes. "
               f"Enter it on the sign-up form to confirm your email.")
    return {"ok": True}

def _verify_email_code(email, code, consume=True):
    """Validate a verification code for `email`; raise 400 if missing/expired/wrong.
    With consume=False the code is checked but kept (used to gate a wizard step)."""
    email = (email or "").strip().lower()
    code = (code or "").strip()
    row = q("SELECT code, expires_at, attempts FROM scheduling.email_verifications WHERE email=%s", (email,), one=True)
    if not row:
        raise HTTPException(400, "Please request a verification code for your email first")
    if row["attempts"] >= 6:
        raise HTTPException(400, "Too many wrong attempts — request a new code")
    if row["expires_at"] and row["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(400, "Your verification code expired — request a new one")
    if not code or code != row["code"]:
        q("UPDATE scheduling.email_verifications SET attempts=attempts+1 WHERE email=%s", (email,), exec_only=True)
        raise HTTPException(400, "Incorrect verification code")
    if consume:
        q("DELETE FROM scheduling.email_verifications WHERE email=%s", (email,), exec_only=True)

@app.post("/api/register")
async def register_staff(request: Request, response: Response):
    """Self-registration. Staff activate immediately (identity is verified via
    Nafath + email + WhatsApp) and are signed in; team-lead/manager sign-ups
    still require a superadmin to activate (privileged roles)."""
    body = await request.json()
    _assert_registration_open()
    name = (body.get("name") or "").strip()
    emp_id = (body.get("employee_id") or "").strip()
    branch_id = body.get("branch_id")
    email = (body.get("email") or "").strip() or None
    phone = (body.get("phone") or "").strip() or None
    section = body.get("section") if body.get("section") in ("General", "US") else "General"
    username = (body.get("username") or "").strip().lower()
    password = body.get("password") or ""
    join_date = (body.get("join_date") or "").strip() or None
    try:
        leave_balance = float(body.get("leave_balance") or 0)
    except (TypeError, ValueError):
        leave_balance = 0.0
    if not math.isfinite(leave_balance):     # reject NaN/Inf, and cap to the column range
        leave_balance = 0.0
    leave_balance = min(leave_balance, 9999.9)
    # Which role is being requested (bound to the invite link). The role itself
    # grants nothing — an admin/manager sign-up only becomes that role once a
    # SUPERADMIN approves it (see approve_registration), so a tampered link can't
    # escalate privilege.
    role = body.get("role") if body.get("role") in ("staff", "admin", "manager") else "staff"
    if not name:
        raise HTTPException(400, "Your name is required")
    if not username or not password:
        raise HTTPException(400, "Choose a username and password to create your account")
    if len(username) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    if len(password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    # Branch is required for staff + team-lead; a manager spans all branches.
    if role in ("staff", "admin"):
        if not branch_id:
            raise HTTPException(400, "Please choose your branch")
        branch_id = _int_or_400(branch_id)
        if not q("SELECT 1 FROM scheduling.branches WHERE id=%s", (branch_id,), one=True):
            raise HTTPException(400, "Unknown branch")
    else:
        branch_id = None
    # Employee ID is required for staff (it's their rota identity); optional otherwise.
    if role == "staff" and not emp_id:
        raise HTTPException(400, "Employee ID is required")
    # Mobile number is required so the branch can reach the staff member.
    if not phone:
        raise HTTPException(400, "Mobile number is required")
    # Must be a Meena work email (not a personal gmail/etc.).
    if not email or not _is_meena_email(email):
        raise HTTPException(400, "Please use your Meena work email (must contain @meena)")
    if join_date and not re.match(r"^\d{4}-\d{2}-\d{2}$", join_date):
        raise HTTPException(400, "Join date must be a valid date")
    if leave_balance < 0:
        raise HTTPException(400, "Leave balance can't be negative")
    # Early, friendly check — the real guard is the UNIQUE index at approval.
    if q("SELECT 1 FROM scheduling.users WHERE username=%s", (username,), one=True):
        raise HTTPException(409, "That username is taken — please choose another")
    # Auto-activation must never overwrite an existing account: an Employee ID
    # that already has a login can't be re-registered (otherwise a new sign-up
    # could hijack that staff member's account). Recover via sign-in / forgot-
    # password instead. Checked before any verification code is consumed.
    if role == "staff" and emp_id:
        prior = q("SELECT id FROM scheduling.staff WHERE employee_id=%s", (emp_id,), one=True)
        if prior and q("SELECT 1 FROM scheduling.users WHERE staff_id=%s", (prior["id"],), one=True):
            raise HTTPException(409, "An account already exists for this Employee ID — please sign in or reset your password.")
    # Identity (Nafath) is checked FIRST — read-only — so a Nafath failure does
    # not burn the email/phone codes. Nafath is consumed later, only on success.
    national_id = name_ar = None
    nafath_rid = (body.get("nafath_request_id") or "").strip()
    if _nafath_enabled():
        nv = q("SELECT * FROM scheduling.nafath_verifications WHERE request_id=%s",
               (nafath_rid,), one=True) if nafath_rid else None
        if not nv or nv["status"] != "verified":
            raise HTTPException(400, "Please complete Nafath identity verification first")
        if nv.get("consumed"):
            raise HTTPException(400, "This Nafath verification was already used — verify again")
        name = nv.get("name_en") or nv.get("name_ar") or name
        name_ar = nv.get("name_ar")
        national_id = nv.get("official_national_id") or nv.get("national_id")
    # Mobile must be verified with the code we sent over WhatsApp (when enabled).
    # Checked before the email code so a failed phone check doesn't burn it.
    if _phone_verify_enabled():
        _verify_phone_code(phone, body.get("phone_code"))
    # Email must be verified with the code we just emailed.
    _verify_email_code(email, body.get("email_code"))
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    # A re-submission for the same Employee ID replaces any earlier pending one.
    if emp_id:
        q("""DELETE FROM scheduling.staff_registrations
             WHERE status='pending' AND employee_id IS NOT NULL AND employee_id=%s""",
          (emp_id,), exec_only=True)

    # ── STAFF: activate immediately, no approval. Identity is already verified
    #          (Nafath + email + WhatsApp), so create the account and sign them in.
    if role == "staff":
        sec = section if section in ("General", "US") else "General"
        try:
            staff = q("""INSERT INTO scheduling.staff (name, branch_id, employee_id, email, phone, speciality,
                              self_registered, join_date, leave_balance, leave_balance_date, national_id, name_ar)
                         VALUES (%s,%s,%s,%s,%s,%s,true,%s,%s,CURRENT_DATE,%s,%s)
                         ON CONFLICT (employee_id) WHERE employee_id IS NOT NULL
                         DO UPDATE SET name=EXCLUDED.name, branch_id=EXCLUDED.branch_id, email=EXCLUDED.email,
                              phone=EXCLUDED.phone, speciality=EXCLUDED.speciality, self_registered=true,
                              join_date=EXCLUDED.join_date, leave_balance=EXCLUDED.leave_balance,
                              leave_balance_date=CURRENT_DATE, national_id=EXCLUDED.national_id, name_ar=EXCLUDED.name_ar
                         RETURNING id, name""",
                      (name, branch_id, emp_id or None, email, phone, [sec], join_date, leave_balance,
                       national_id, name_ar), one=True)
        except psycopg2.errors.UniqueViolation:
            raise HTTPException(409, "That Employee ID is already on a staff record")
        owner = q("SELECT id, staff_id FROM scheduling.users WHERE username=%s", (username,), one=True)
        if owner and owner.get("staff_id") != staff["id"]:
            raise HTTPException(409, "That username is taken — please choose another")
        existing = q("SELECT id FROM scheduling.users WHERE staff_id=%s", (staff["id"],), one=True)
        try:
            if existing:
                urow = q("""UPDATE scheduling.users SET username=%s, password=%s, role='staff', branch_id=%s, email=%s
                            WHERE id=%s RETURNING id, username, role, branch_id, staff_id,
                                                  COALESCE(token_epoch,0) AS token_epoch""",
                         (username, pw_hash, branch_id, email, existing["id"]), one=True)
            else:
                urow = q("""INSERT INTO scheduling.users (username,password,role,branch_id,staff_id,email)
                            VALUES (%s,%s,'staff',%s,%s,%s)
                            RETURNING id, username, role, branch_id, staff_id, COALESCE(token_epoch,0) AS token_epoch""",
                         (username, pw_hash, branch_id, staff["id"], email), one=True)
        except psycopg2.errors.UniqueViolation:
            raise HTTPException(409, "That username is taken — please choose another")
        if _nafath_enabled() and nafath_rid:
            q("UPDATE scheduling.nafath_verifications SET consumed=true, updated_at=NOW() WHERE request_id=%s",
              (nafath_rid,), exec_only=True)
        # History row (self-activated → already approved).
        q("""INSERT INTO scheduling.staff_registrations
                (name, branch_id, employee_id, email, phone, section, username, password, requested_role,
                 join_date, leave_balance, national_id, name_ar, status, staff_id, reviewed_at)
             VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'staff',%s,%s,%s,%s,'approved',%s,NOW())""",
          (name, branch_id, emp_id or None, email, phone, sec, username, pw_hash,
           join_date, leave_balance, national_id, name_ar, staff["id"]), exec_only=True)
        # Notifications: welcome the new staff; inform the branch lead + managers (FYI).
        bname = (q("SELECT name FROM scheduling.branches WHERE id=%s", (branch_id,), one=True) or {}).get("name", "")
        first = name.split()[0] if name else ""
        notify_staff_member(staff["id"], f"Welcome to Meena, {first}! Your account is active.",
                            link="home", ntype="activated")
        # FYI to the branch team lead only (managers don't need every new hire).
        info = f"New staff joined: {name}" + (f" — ID {emp_id}" if emp_id else "") + (f" · {bname}" if bname else "")
        for u in (q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s", (branch_id,)) or []):
            notify(u["id"], info, link="staff", ntype="info")
        if email:
            try:
                send_email(email, "Welcome to Meena Scheduling — your account is ready",
                           f"Hi {name},\n\nYour account has been created and is ready to use. You're signed in "
                           f"now, and can sign in any time with your username \"{username}\".\n\n— Meena Scheduling")
            except Exception as e:
                print(f"[register] welcome email to {email} failed: {e}", file=sys.stderr)
        # Auto-login: issue the session cookie exactly like /auth/login.
        payload = {"id": urow["id"], "username": urow["username"], "role": "staff",
                   "branch_id": urow.get("branch_id"), "branch_name": bname or None,
                   "staff_id": urow.get("staff_id"), "epoch": int(urow.get("token_epoch") or 0)}
        response.set_cookie("token", sign_token(payload), httponly=True, samesite="lax",
                            secure=os.environ.get("COOKIE_SECURE", "1") != "0",
                            max_age=JWT_DAYS * 86400)
        return {"ok": True, "auto_login": True, "user": payload,
                "message": "Welcome! Your account is ready and you're signed in."}

    # ── ADMIN / MANAGER: privileged roles still need a superadmin to activate ──
    q("""INSERT INTO scheduling.staff_registrations
           (name, branch_id, employee_id, email, phone, section, username, password,
            requested_role, join_date, leave_balance, national_id, name_ar)
         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
      (name, branch_id, emp_id or None, email, phone, section, username, pw_hash, role,
       join_date, leave_balance, national_id, name_ar), exec_only=True)
    if _nafath_enabled() and nafath_rid:
        q("UPDATE scheduling.nafath_verifications SET consumed=true, updated_at=NOW() WHERE request_id=%s",
          (nafath_rid,), exec_only=True)
    label = "team-lead" if role == "admin" else "manager"
    notify_roles(("superadmin",), f"New {label} registration to review: {name}", link="staff", ntype="info")
    if email:
        try:
            send_email(email, "Registration received — Meena Scheduling",
                       f"Hi {name},\n\nYour {label} registration was received and is awaiting activation by "
                       f"an administrator. You'll be able to sign in once it's approved.\n\nThank you.")
        except Exception as e:
            print(f"[register] confirmation email to {email} failed: {e}", file=sys.stderr)
    return {"ok": True, "emailed": bool(email),
            "message": "Thanks! Your registration was received and is awaiting an administrator's activation."}

@app.get("/api/registrations")
def list_registrations(request: Request, user=Depends(require_admin)):
    """Pending self-registrations, scoped to what the caller can approve:
    superadmin sees all (incl. team-lead/manager sign-ups); a manager sees staff
    sign-ups across branches; a team lead sees staff sign-ups for their branch."""
    if user["role"] == "superadmin":
        rows = q("""SELECT r.*, b.name AS branch_name FROM scheduling.staff_registrations r
                    LEFT JOIN scheduling.branches b ON b.id=r.branch_id
                    WHERE r.status='pending' ORDER BY r.created_at""")
    elif user["role"] == "manager":
        rows = q("""SELECT r.*, b.name AS branch_name FROM scheduling.staff_registrations r
                    LEFT JOIN scheduling.branches b ON b.id=r.branch_id
                    WHERE r.status='pending' AND COALESCE(r.requested_role,'staff')='staff'
                    ORDER BY r.created_at""")
    else:
        rows = q("""SELECT r.*, b.name AS branch_name FROM scheduling.staff_registrations r
                    LEFT JOIN scheduling.branches b ON b.id=r.branch_id
                    WHERE r.status='pending' AND COALESCE(r.requested_role,'staff')='staff'
                      AND r.branch_id=%s ORDER BY r.created_at""",
                 (user.get("branch_id"),))
    return rows

@app.post("/api/registrations/{rid}/approve")
async def approve_registration(rid: int, request: Request, user=Depends(require_admin)):
    """Approve a registration → create the account with its requested role.
    Staff sign-ups also create a rota staff record; team-lead/manager sign-ups
    create only the login and require SUPERADMIN approval (no privilege escalation)."""
    reg = q("SELECT * FROM scheduling.staff_registrations WHERE id=%s", (rid,), one=True)
    if not reg:
        raise HTTPException(404, "Registration not found")
    if reg["status"] != "pending":
        raise HTTPException(400, f"Already {reg['status']}")
    req_role = reg.get("requested_role") if reg.get("requested_role") in ("staff", "admin", "manager") else "staff"
    # Approval authority by requested role.
    if req_role == "staff":
        if not can_access_branch(user, reg["branch_id"]):
            raise HTTPException(403, "You can only approve registrations for your own branch")
    elif user["role"] != "superadmin":
        raise HTTPException(403, "Only a superadmin can approve a team-lead or manager account")

    staff = None
    account_created = False

    if req_role == "staff":
        sec = reg.get("section") if reg.get("section") in ("General", "US") else "General"
        try:
            staff = q("""INSERT INTO scheduling.staff (name, branch_id, employee_id, email, phone, speciality,
                                                        self_registered, join_date, leave_balance, leave_balance_date,
                                                        national_id, name_ar)
                         VALUES (%s,%s,%s,%s,%s,%s,true,%s,%s,CURRENT_DATE,%s,%s)
                         ON CONFLICT (employee_id) WHERE employee_id IS NOT NULL
                         DO UPDATE SET name=EXCLUDED.name, branch_id=EXCLUDED.branch_id,
                                       email=EXCLUDED.email, phone=EXCLUDED.phone,
                                       speciality=EXCLUDED.speciality, self_registered=true,
                                       join_date=EXCLUDED.join_date, leave_balance=EXCLUDED.leave_balance,
                                       leave_balance_date=CURRENT_DATE,
                                       national_id=EXCLUDED.national_id, name_ar=EXCLUDED.name_ar
                         RETURNING id, name""",
                      (reg["name"], reg["branch_id"], reg["employee_id"], reg["email"], reg["phone"], [sec],
                       reg.get("join_date"), reg.get("leave_balance") or 0,
                       reg.get("national_id"), reg.get("name_ar")),
                      one=True)
        except psycopg2.errors.UniqueViolation:
            raise HTTPException(409, "That Employee ID is already on a staff record")
        # Create / refresh the staff login linked to this record.
        if reg.get("username") and reg.get("password"):
            owner = q("SELECT id, staff_id FROM scheduling.users WHERE username=%s", (reg["username"],), one=True)
            if owner and owner.get("staff_id") != staff["id"]:
                raise HTTPException(409, "That username is already taken by another account")
            existing = q("SELECT id FROM scheduling.users WHERE staff_id=%s", (staff["id"],), one=True)
            try:
                if existing:
                    q("""UPDATE scheduling.users SET username=%s, password=%s, role='staff',
                         branch_id=%s, staff_id=%s, email=%s WHERE id=%s""",
                      (reg["username"], reg["password"], reg["branch_id"], staff["id"], reg["email"], existing["id"]),
                      exec_only=True)
                else:
                    q("""INSERT INTO scheduling.users (username,password,role,branch_id,staff_id,email)
                         VALUES (%s,%s,'staff',%s,%s,%s)""",
                      (reg["username"], reg["password"], reg["branch_id"], staff["id"], reg["email"]),
                      exec_only=True)
                account_created = True
            except psycopg2.errors.UniqueViolation:
                raise HTTPException(409, "That username is already taken by another account")
        staff_id_for_reg = staff["id"]
    else:
        # Team lead (branch-locked) or manager (all branches) — login only.
        if not (reg.get("username") and reg.get("password")):
            raise HTTPException(400, "This registration has no login to create")
        if q("SELECT 1 FROM scheduling.users WHERE username=%s", (reg["username"],), one=True):
            raise HTTPException(409, "That username is already taken by another account")
        branch_for = reg["branch_id"] if req_role == "admin" else None
        try:
            q("""INSERT INTO scheduling.users (username,password,role,branch_id,email)
                 VALUES (%s,%s,%s,%s,%s)""",
              (reg["username"], reg["password"], req_role, branch_for, reg["email"]), exec_only=True)
            account_created = True
        except psycopg2.errors.UniqueViolation:
            raise HTTPException(409, "That username is already taken by another account")
        staff_id_for_reg = None

    q("""UPDATE scheduling.staff_registrations
         SET status='approved', staff_id=%s, reviewed_by=%s, reviewed_at=NOW() WHERE id=%s""",
      (staff_id_for_reg, user["id"], rid), exec_only=True)
    insert_audit(user, "REGISTRATION_APPROVE", reg["name"], f"role:{req_role}")
    # Tell the new staff member their account is live (in-app + WhatsApp/email).
    if account_created and staff_id_for_reg:
        notify_staff_member(staff_id_for_reg,
                            f"Your Meena account is now active — sign in with your username \"{reg['username']}\".",
                            link="home", ntype="activated")
    if account_created and reg.get("email"):
        try:
            _deliver_email(reg["email"], "Your Meena Scheduling account is ready",
                           f"Hi {reg['name']},\n\nYour account has been approved. "
                           f"You can now sign in with your username \"{reg['username']}\".\n\n— Meena Scheduling")
        except Exception:
            pass
    return {"ok": True, "staff": staff, "role": req_role, "account_created": account_created}

@app.post("/api/registrations/{rid}/reject")
async def reject_registration(rid: int, request: Request, user=Depends(require_admin)):
    reg = q("SELECT * FROM scheduling.staff_registrations WHERE id=%s", (rid,), one=True)
    if not reg:
        raise HTTPException(404, "Registration not found")
    if not can_access_branch(user, reg["branch_id"]):
        raise HTTPException(403, "You can only review registrations for your own branch")
    q("""UPDATE scheduling.staff_registrations
         SET status='rejected', reviewed_by=%s, reviewed_at=NOW() WHERE id=%s""",
      (user["id"], rid), exec_only=True)
    insert_audit(user, "REGISTRATION_REJECT", reg["name"], f"emp:{reg['employee_id']}")
    return {"ok": True}

@app.get("/api/auth/me")
def me(response: Response, user=Depends(get_current_user)):
    # Sliding session: re-issue the cookie on each app load so an active user is
    # never silently logged out — the 30-day window keeps resetting while in use.
    # Mirror the login payload exactly (note: epoch comes from token_epoch) so the
    # epoch check in get_current_user keeps passing.
    try:
        payload = {k: user.get(k) for k in ("id", "username", "role", "branch_id", "branch_name", "staff_id")}
        payload["epoch"] = int(user.get("token_epoch") or 0)
        response.set_cookie("token", sign_token(payload), httponly=True, samesite="lax",
                            secure=os.environ.get("COOKIE_SECURE", "1") != "0",
                            max_age=JWT_DAYS * 86400)
    except Exception:
        pass
    # Effective permissions for the client's nav/route gating (mirrors the login payload).
    try:
        user = dict(user)
        user["perms"] = sorted(effective_perms(user))
    except Exception:
        pass
    return user

@app.get("/api/health")
def health():
    """Cheap liveness probe. The dashboard pings this on a timer to keep the
    (serverless) database warm, so the first real request after an idle spell
    isn't stuck waiting for a cold connection."""
    try:
        q("SELECT 1", one=True)
        return {"ok": True}
    except Exception:
        return {"ok": False}

# ── Branches ──────────────────────────────────────────────────────────────────

@app.get("/api/branches")
def list_branches(user=Depends(get_current_user)):
    return q("SELECT id,name,city,shares_staff,cover_need_per_day,siratech_site_id,created_at FROM scheduling.branches ORDER BY name")

@app.post("/api/branches")
async def create_branch(request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name: raise HTTPException(400, "Name required")
    try:
        row = q("INSERT INTO scheduling.branches (name) VALUES (%s) RETURNING id,name,created_at",
                (name,), one=True)
        insert_audit(user, "CREATE_BRANCH", name)
        return row
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(409, "Branch already exists")

@app.put("/api/branches/{bid}")
async def update_branch(bid: int, request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    cur = q("SELECT name,city,shares_staff,cover_need_per_day,siratech_site_id FROM scheduling.branches WHERE id=%s", (bid,), one=True)
    if not cur: raise HTTPException(404, "Not found")
    name = (body.get("name") or cur["name"]).strip()
    city = body.get("city") if "city" in body else cur["city"]
    if isinstance(city, str): city = city.strip() or None
    shares = bool(body["shares_staff"]) if "shares_staff" in body else cur["shares_staff"]
    need = max(0, int(body["cover_need_per_day"])) if "cover_need_per_day" in body else cur["cover_need_per_day"]
    # HIS site number that scopes this branch's radiology view (NULL = unmapped/no restriction).
    if "siratech_site_id" in body:
        sv = body.get("siratech_site_id")
        site_id = int(sv) if str(sv).strip() not in ("", "None", "null") else None
    else:
        site_id = cur["siratech_site_id"]
    row = q("""UPDATE scheduling.branches SET name=%s, city=%s, shares_staff=%s, cover_need_per_day=%s, siratech_site_id=%s
               WHERE id=%s RETURNING id,name,city,shares_staff,cover_need_per_day,siratech_site_id""",
            (name, city, shares, need, site_id, bid), one=True)
    insert_audit(user, "UPDATE_BRANCH", name, f"city={city or '-'} shares={shares} need={need}")
    return row

@app.delete("/api/branches/{bid}")
def delete_branch(bid: int, user=Depends(require_superadmin)):
    q("DELETE FROM scheduling.branches WHERE id=%s", (bid,), exec_only=True)
    return {"ok": True}

# ── Users ─────────────────────────────────────────────────────────────────────

@app.get("/api/users")
def list_users(user=Depends(require_superadmin)):
    rows = q("""SELECT u.id,u.username,u.role,u.branch_id,u.staff_id,u.created_at,
                       u.email, COALESCE(u.email_notifications,true) AS email_notifications,
                       COALESCE(u.can_file_radiology,false) AS can_file_radiology,
                       COALESCE(u.can_use_radiology,false) AS can_use_radiology,
                       COALESCE(u.permissions,'{}'::jsonb) AS permissions,
                       b.name AS branch_name, st.name AS staff_name
                FROM scheduling.users u
                LEFT JOIN scheduling.branches b ON b.id=u.branch_id
                LEFT JOIN scheduling.staff st ON st.id=u.staff_id
                ORDER BY u.created_at""") or []
    # Attach each user's EFFECTIVE permissions + the role defaults, so the Users page can
    # show the resolved state and which toggles are overrides vs role-given.
    for r in rows:
        r["perms"] = sorted(effective_perms(r))
        r["role_perms"] = sorted(ROLE_DEFAULT_PERMS.get(r.get("role") or "viewer", set()))
    return rows

@app.get("/api/permissions/catalog")
def permissions_catalog(user=Depends(require_superadmin)):
    """The full permission catalog (grouped) + per-role defaults, for the Users page."""
    return {
        "groups": [{"group": g, "items": [{"key": k, "label": lbl} for k, lbl in items]}
                   for g, items in PERMISSION_GROUPS],
        "roleDefaults": {role: sorted(perms) for role, perms in ROLE_DEFAULT_PERMS.items()},
    }

@app.post("/api/users")
async def create_user(request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    username = (body.get("username") or "").strip().lower()
    password = body.get("password") or ""
    role     = body.get("role") or ""
    branch_id = body.get("branch_id") or None
    staff_id  = body.get("staff_id") or None
    if not username or not password or not role:
        raise HTTPException(400, "Missing fields")
    if role not in ("viewer", "admin", "manager", "superadmin", "staff"):
        raise HTTPException(400, "Invalid role")
    if len(password) < 6:
        raise HTTPException(400, "Password min 6 chars")
    # A staff account must be linked to a staff record; its branch follows that record.
    if role == "staff":
        if not staff_id:
            raise HTTPException(400, "A staff account must be linked to a staff member")
        st = q("SELECT branch_id FROM scheduling.staff WHERE id=%s", (staff_id,), one=True)
        if not st:
            raise HTTPException(404, "Staff member not found")
        branch_id = st["branch_id"]
    else:
        staff_id = None
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    email = (body.get("email") or "").strip() or None
    try:
        row = q("""INSERT INTO scheduling.users (username,password,role,branch_id,staff_id,email)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   RETURNING id,username,role,branch_id,staff_id,email,created_at""",
                (username, hashed, role, branch_id, staff_id, email), one=True)
        insert_audit(user, "CREATE_USER", username)
        return row
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(409, "Username already exists")

@app.put("/api/users/{uid}")
async def update_user(uid: int, request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    password = body.get("password")
    if password:
        if len(password) < 6: raise HTTPException(400, "Password min 6 chars")
        hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        # Bump the session epoch so any existing tokens for this user stop working.
        q("UPDATE scheduling.users SET password=%s, token_epoch=COALESCE(token_epoch,0)+1 WHERE id=%s",
          (hashed, uid), exec_only=True)
    sets, params = [], []
    if body.get("username") is not None: sets.append("username=%s"); params.append((body["username"] or "").strip().lower())
    if body.get("role")     is not None: sets.append("role=%s");     params.append(body["role"])
    if "email" in body: sets.append("email=%s"); params.append((body.get("email") or "").strip() or None)
    if "email_notifications" in body: sets.append("email_notifications=%s"); params.append(bool(body["email_notifications"]))
    # Radiology filing privilege (elevates a staff member from view-only to able to
    # file results into the HIS). Takes effect on their next request — get_current_user
    # reads the live row, so no re-login is needed.
    if "can_file_radiology" in body: sets.append("can_file_radiology=%s"); params.append(bool(body["can_file_radiology"]))
    if "can_use_radiology" in body: sets.append("can_use_radiology=%s"); params.append(bool(body["can_use_radiology"]))
    # Per-user permission OVERRIDES ({permKey: true|false}), sanitised to known keys.
    # No epoch bump needed — get_current_user reads the LIVE row, so enforcement is
    # immediate on the user's next request; their client picks up the new nav on reload.
    if "permissions" in body:
        ov = body.get("permissions") or {}
        clean = {k: bool(v) for k, v in ov.items() if k in PERMISSION_KEYS} if isinstance(ov, dict) else {}
        sets.append("permissions=%s"); params.append(json.dumps(clean))
    # A staff account stays pinned to its staff member's branch.
    if body.get("role") == "staff" and body.get("staff_id"):
        st = q("SELECT branch_id FROM scheduling.staff WHERE id=%s", (body["staff_id"],), one=True)
        sets.append("staff_id=%s"); params.append(body["staff_id"])
        sets.append("branch_id=%s"); params.append(st["branch_id"] if st else None)
    elif body.get("role") and body.get("role") != "staff":
        sets.append("staff_id=%s"); params.append(None)
        if "branch_id" in body: sets.append("branch_id=%s"); params.append(body["branch_id"] or None)
    elif "branch_id" in body:
        sets.append("branch_id=%s"); params.append(body["branch_id"] or None)
    if sets:
        params.append(uid)
        q(f"UPDATE scheduling.users SET {','.join(sets)} WHERE id=%s", params, exec_only=True)
    return q("""SELECT u.id,u.username,u.role,u.branch_id,u.staff_id,u.created_at,
                       u.email, COALESCE(u.email_notifications,true) AS email_notifications,
                       COALESCE(u.can_file_radiology,false) AS can_file_radiology,
                       COALESCE(u.can_use_radiology,false) AS can_use_radiology,
                       b.name AS branch_name, st.name AS staff_name
                FROM scheduling.users u
                LEFT JOIN scheduling.branches b ON b.id=u.branch_id
                LEFT JOIN scheduling.staff st ON st.id=u.staff_id
                WHERE u.id=%s""", (uid,), one=True)

@app.delete("/api/users/{uid}")
def delete_user(uid: int, user=Depends(require_superadmin)):
    if uid == user.get("id"):
        raise HTTPException(400, "Can't delete yourself")
    q("DELETE FROM scheduling.users WHERE id=%s", (uid,), exec_only=True)
    return {"ok": True}

# ── Staff ─────────────────────────────────────────────────────────────────────

@app.get("/api/staff")
def list_staff(request: Request, user=Depends(get_current_user)):
    branch_id = request.query_params.get("branch_id")
    # Cross-branch roles (superadmin, manager) can query any/all branches;
    # everyone else is pinned to their own branch — and if they have none
    # (e.g. a viewer with no branch), they get nothing, not the whole list.
    if user["role"] not in ("superadmin", "manager"):
        branch_id = user.get("branch_id")
        if not branch_id:
            raise HTTPException(403, "No branch assigned to this account")
    # Guard against UI bugs passing "undefined"/"null" as strings.
    if isinstance(branch_id, str) and branch_id.strip().lower() in ("", "undefined", "null"):
        branch_id = None
    if branch_id is not None:
        try:
            branch_id = int(branch_id)
        except Exception:
            raise HTTPException(400, "branch_id must be an integer")
    if branch_id:
        rows = q("""SELECT s.*,b.name AS branch_name FROM scheduling.staff s
                    LEFT JOIN scheduling.branches b ON b.id=s.branch_id
                    WHERE s.branch_id=%s ORDER BY b.name,s.name""", (branch_id,))
    else:
        rows = q("""SELECT s.*,b.name AS branch_name FROM scheduling.staff s
                    LEFT JOIN scheduling.branches b ON b.id=s.branch_id
                    ORDER BY b.name,s.name""")
    return rows

@app.get("/api/staff/search")
def search_staff(request: Request, user=Depends(require_admin)):
    """Quick lookup by name or employee ID → the person's details plus their
    current-month coverage (shifts worked, leave taken, today's shift). Powers the
    manager home search. Branch-locked roles only see their own branch."""
    term = (request.query_params.get("q") or "").strip()
    if len(term) < 2:
        return {"results": []}
    from datetime import date as _d
    today = _d.today()
    y, m = today.year, today.month
    today_str = today.isoformat()
    like = f"%{term}%"
    conds = ["s.active=true", "(s.name ILIKE %s OR s.employee_id ILIKE %s)"]
    vals = [like, like]
    # A branch-locked role (team lead/viewer) only searches its own branch.
    if user["role"] not in ("superadmin", "manager"):
        if not user.get("branch_id"):
            raise HTTPException(403, "No branch assigned to this account")
        conds.append("s.branch_id=%s"); vals.append(user["branch_id"])
    rows = q(f"""
        SELECT s.id, s.name, s.employee_id, s.phone, s.email, s.speciality,
               TO_CHAR(s.join_date,'YYYY-MM-DD') AS join_date, s.leave_balance, s.leave_balance_date,
               s.national_id, s.name_ar,
               s.branch_id, b.name AS branch_name,
               (SELECT COUNT(*) FROM scheduling.schedule_entries e
                  JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                 WHERE e.staff_id=s.id AND sc.year=%s AND sc.month=%s
                   AND e.shift_code NOT IN ('O','AL','SL','TB')) AS shifts_month,
               (SELECT COUNT(*) FROM scheduling.schedule_entries e
                  JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                 WHERE e.staff_id=s.id AND sc.year=%s AND sc.month=%s
                   AND e.shift_code IN ('AL','SL','TB')) AS leave_days_month,
               (SELECT e.shift_code FROM scheduling.schedule_entries e
                  JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                 WHERE e.staff_id=s.id AND e.date=%s LIMIT 1) AS today_shift
        FROM scheduling.staff s
        LEFT JOIN scheduling.branches b ON b.id=s.branch_id
        WHERE {' AND '.join(conds)}
        ORDER BY s.name LIMIT 25
    """, (y, m, y, m, today_str, *vals))
    for r in rows:
        r["section"] = _section_of(r.get("speciality"))
        r["leave_balance"] = _live_leave_balance(r["id"], r.get("leave_balance"), r.get("leave_balance_date"))
        r.pop("leave_balance_date", None)
    return {"results": rows}

@app.post("/api/staff")
async def create_staff(request: Request, user=Depends(require_admin)):
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name: raise HTTPException(400, "Name required")
    branch_id = _int_or_400(body.get("branch_id"), "branch_id")
    if not q("SELECT 1 FROM scheduling.branches WHERE id=%s", (branch_id,), one=True):
        raise HTTPException(400, "Unknown branch")
    if not can_access_branch(user, branch_id): raise HTTPException(403, "Forbidden")
    try:
        row = q("""INSERT INTO scheduling.staff (name,phone,branch_id,speciality,is_cross_branch,can_report,employee_id,email)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                (name, body.get("phone"), branch_id,
                 body.get("speciality", ["General"]), body.get("is_cross_branch", False),
                 bool(body.get("can_report", False)),
                 (body.get("employee_id") or "").strip() or None,
                 (body.get("email") or "").strip() or None),
                one=True)
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(409, "That Employee ID is already on another staff record")
    insert_audit(user, "CREATE_STAFF", name)
    return row

@app.put("/api/staff/{sid}")
async def update_staff(sid: int, request: Request, user=Depends(require_admin)):
    body = await request.json()
    existing = q("SELECT * FROM scheduling.staff WHERE id=%s", (sid,), one=True)
    if not existing: raise HTTPException(404, "Not found")
    if not can_access_branch(user, existing["branch_id"]): raise HTTPException(403, "Forbidden")
    # Moving the staff member to another branch needs access to that branch too.
    if "branch_id" in body and body["branch_id"] and not can_access_branch(user, body["branch_id"]):
        raise HTTPException(403, "You can't move staff to a branch you don't manage")
    sets, params = [], []
    for field in ("name","phone","branch_id","speciality","is_cross_branch","active","phase","min_shifts","max_shifts","can_report","employee_id","email","join_date","leave_balance"):
        if field in body:
            sets.append(f"{field}=%s")
            params.append(body[field] if body[field] != "" else None)
    # Re-anchor accrual whenever the balance is (re)set manually.
    if "leave_balance" in body:
        sets.append("leave_balance_date=CURRENT_DATE")
    if not sets: return existing
    params.append(sid)
    try:
        return q(f"UPDATE scheduling.staff SET {','.join(sets)} WHERE id=%s RETURNING *",
                 params, one=True)
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(409, "That Employee ID is already on another staff record")

@app.delete("/api/staff/{sid}")
def delete_staff(sid: int, user=Depends(require_admin)):
    existing = q("SELECT * FROM scheduling.staff WHERE id=%s", (sid,), one=True)
    if not existing: raise HTTPException(404, "Not found")
    if not can_access_branch(user, existing["branch_id"]): raise HTTPException(403, "Forbidden")
    q("DELETE FROM scheduling.staff WHERE id=%s", (sid,), exec_only=True)
    return {"ok": True}

# ── Branch Settings ───────────────────────────────────────────────────────────

@app.get("/api/branch-settings/{bid}")
def get_branch_settings(bid: int, user=Depends(get_current_user)):
    if not can_access_branch(user, bid): raise HTTPException(403, "Forbidden")
    row = q("SELECT * FROM scheduling.branch_settings WHERE branch_id=%s", (bid,), one=True)
    if not row:
        return {"branch_id": bid, "max_consecutive": 4, "min_shifts_default": 17}
    return row

@app.put("/api/branch-settings/{bid}")
async def update_branch_settings(bid: int, request: Request, user=Depends(require_admin)):
    if not can_access_branch(user, bid): raise HTTPException(403, "Forbidden")
    body = await request.json()
    existing = q("SELECT * FROM scheduling.branch_settings WHERE branch_id=%s", (bid,), one=True) or {}
    max_consecutive = int(body.get("max_consecutive", existing.get("max_consecutive", 4)))
    min_shifts_default = int(body.get("min_shifts_default", existing.get("min_shifts_default", 17)))
    if min_shifts_default < 0 or min_shifts_default > 31:
        raise HTTPException(400, "min_shifts_default must be between 0 and 31")
    row = q("""INSERT INTO scheduling.branch_settings (branch_id, max_consecutive, min_shifts_default)
               VALUES (%s, %s, %s)
               ON CONFLICT (branch_id) DO UPDATE
               SET max_consecutive=%s, min_shifts_default=%s, updated_at=NOW()
               RETURNING *""",
            (bid, max_consecutive, min_shifts_default, max_consecutive, min_shifts_default),
            one=True)
    return row

# ── Staff Month Settings ──────────────────────────────────────────────────────

@app.get("/api/staff-month-settings")
def get_staff_month_settings(request: Request, user=Depends(get_current_user)):
    """Get per-month min/max settings for all staff in a branch/year/month.
    Falls back to staff.min_shifts / staff.max_shifts (default 17) if no override."""
    branch_id = request.query_params.get("branch_id")
    year      = request.query_params.get("year")
    month     = request.query_params.get("month")
    if not branch_id or not year or not month:
        raise HTTPException(400, "branch_id, year, month required")
    if not can_access_branch(user, branch_id): raise HTTPException(403, "Forbidden")
    bs = q("SELECT min_shifts_default FROM scheduling.branch_settings WHERE branch_id=%s", (int(branch_id),), one=True) or {}
    rows = q("""
        SELECT s.id AS staff_id,
               COALESCE(sms.min_shifts, s.min_shifts, 0)   AS min_shifts,
               COALESCE(sms.max_shifts, s.max_shifts, 17)  AS max_shifts,
               COALESCE(sms.max_consecutive, 4)             AS max_consecutive
        FROM scheduling.staff s
        LEFT JOIN scheduling.staff_month_settings sms
          ON sms.staff_id=s.id AND sms.year=%s AND sms.month=%s
        WHERE s.branch_id=%s AND s.active=true
    """, (int(year), int(month), int(branch_id)))
    # Show the actual stored values. The solver computes the real hour-based
    # target at generation time; these are just the editable ceilings/floors,
    # so we don't force them up to a branch default here.
    return {r["staff_id"]: {
        "min_shifts": r["min_shifts"],
        "max_shifts": max(r["min_shifts"], r["max_shifts"]),
        "max_consecutive": r["max_consecutive"]
    } for r in rows}

@app.put("/api/staff-month-settings/{staff_id}")
async def upsert_staff_month_settings(staff_id: int, request: Request, user=Depends(require_admin)):
    body    = await request.json()
    year    = int(body.get("year"))
    month   = int(body.get("month"))
    min_s   = int(body.get("min_shifts", 0))
    max_s   = int(body.get("max_shifts", 17))
    max_con = int(body.get("max_consecutive", 4))
    staff = q("SELECT branch_id FROM scheduling.staff WHERE id=%s", (staff_id,), one=True)
    if not staff: raise HTTPException(404, "Staff not found")
    if not can_access_branch(user, staff["branch_id"]): raise HTTPException(403, "Forbidden")
    bs = q("SELECT min_shifts_default FROM scheduling.branch_settings WHERE branch_id=%s", (int(staff["branch_id"]),), one=True) or {}
    branch_min = int(bs.get("min_shifts_default", 17) or 17)
    min_s = max(branch_min, min_s)
    if max_s < min_s:
        raise HTTPException(400, "max_shifts cannot be less than min_shifts")
    row = q("""INSERT INTO scheduling.staff_month_settings
                 (staff_id, year, month, min_shifts, max_shifts, max_consecutive)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (staff_id, year, month) DO UPDATE
               SET min_shifts=%s, max_shifts=%s, max_consecutive=%s, updated_at=NOW()
               RETURNING *""",
            (staff_id, year, month, min_s, max_s, max_con,
             min_s, max_s, max_con), one=True)
    return row

# ── Section Month Settings ────────────────────────────────────────────────────

@app.get("/api/section-month-settings")
def get_section_month_settings(request: Request, user=Depends(require_admin)):
    """Get per-month M/N limits for all sections in a nest (branch), for a given year/month."""
    branch_id = request.query_params.get("branch_id")
    year      = request.query_params.get("year")
    month     = request.query_params.get("month")
    if not branch_id or not year or not month:
        raise HTTPException(400, "branch_id, year, month required")
    if not can_access_branch(user, branch_id):
        raise HTTPException(403, "You can only view settings for your own branch")
    branch = q("SELECT name FROM scheduling.branches WHERE id=%s", (int(branch_id),), one=True)
    if not branch: raise HTTPException(404, "Branch not found")
    nest_name = branch_to_nest(branch["name"]) or f"BRANCH_{int(branch_id)}"
    rows = q("""
        SELECT ns.id AS section_id, ns.section_name,
               COALESCE(sms.min_m,1) AS min_m, COALESCE(sms.max_m,2) AS max_m,
               COALESCE(sms.min_n,1) AS min_n, COALESCE(sms.max_n,2) AS max_n,
               COALESCE(sms.max_consecutive,4) AS max_consecutive,
               COALESCE(sms.min_o_block,2) AS min_o_block,
               COALESCE(sms.max_o_block,0) AS max_o_block
        FROM scheduling.nest_sections ns
        LEFT JOIN scheduling.section_month_settings sms
          ON sms.section_id=ns.id AND sms.year=%s AND sms.month=%s
        WHERE ns.nest_key=%s ORDER BY ns.sort_order,ns.section_name
    """, (int(year), int(month), nest_name))
    # New/unmapped branches have no nest_sections row yet. Surface a virtual
    # "General" section (id=0) so the user still sees and can read defaults.
    # Saving is only possible once a real section exists, but at least the
    # tab is no longer blank.
    if not rows:
        return {0: {
            "section_name": "General",
            "min_m": 1, "max_m": 2,
            "min_n": 1, "max_n": 2,
            "max_consecutive": 4, "min_o_block": 2, "max_o_block": 0,
            "virtual": True,
        }}
    return {r["section_id"]: {
        "section_name": r["section_name"],
        "min_m": r["min_m"], "max_m": r["max_m"],
        "min_n": r["min_n"], "max_n": r["max_n"],
        "max_consecutive": r["max_consecutive"],
        "min_o_block": r["min_o_block"],
        "max_o_block": r["max_o_block"],
    } for r in rows}

@app.put("/api/section-month-settings/{section_id}")
async def upsert_section_month_settings(section_id: int, request: Request, user=Depends(require_admin)):
    body  = await request.json()
    year  = int(body.get("year"))
    month = int(body.get("month"))
    min_m = int(body.get("min_m", 1))
    max_m = int(body.get("max_m", 2))
    min_n = int(body.get("min_n", 1))
    max_n = int(body.get("max_n", 2))
    max_consecutive = int(body.get("max_consecutive", 4))
    min_o_block = int(body.get("min_o_block", 2))
    max_o_block = int(body.get("max_o_block", 0))
    if min_m > max_m: raise HTTPException(400, "min_m cannot exceed max_m")
    if min_n > max_n: raise HTTPException(400, "min_n cannot exceed max_n")
    if max_consecutive < 1 or max_consecutive > 14:
        raise HTTPException(400, "max_consecutive must be between 1 and 14")
    if min_o_block < 1 or min_o_block > 14:
        raise HTTPException(400, "min_o_block must be between 1 and 14")
    if max_o_block < 0 or max_o_block > 31:
        raise HTTPException(400, "max_o_block must be between 0 (off) and 31")
    if max_o_block and max_o_block < min_o_block:
        raise HTTPException(400, "max_o_block cannot be less than min_o_block")

    # section_id 0 is the virtual "General" we surface for branches that have no
    # nest_sections rows yet. On first save, create a real section so the values
    # persist. The frontend sends branch_id alongside so we know where to attach it.
    if int(section_id) == 0:
        branch_id = body.get("branch_id")
        if not branch_id:
            raise HTTPException(400, "branch_id required to create a section")
        if not can_access_branch(user, branch_id):
            raise HTTPException(403, "You can only create sections in your own branch")
        branch = q("SELECT name FROM scheduling.branches WHERE id=%s", (int(branch_id),), one=True)
        if not branch:
            raise HTTPException(404, "Branch not found")
        nest_name = branch_to_nest(branch["name"]) or f"BRANCH_{int(branch_id)}"
        # Reuse an existing General section for this nest if one already exists,
        # otherwise create it.
        existing = q("""SELECT id FROM scheduling.nest_sections
                        WHERE nest_key=%s AND section_name='General'""",
                     (nest_name,), one=True)
        if existing:
            section_id = existing["id"]
        else:
            created = q("""INSERT INTO scheduling.nest_sections
                             (nest_key, section_name, sort_order, staff, staff_db_names,
                              allowed_shifts, coverage, exact_coverage)
                           VALUES (%s,'General',0,'{}','{}'::jsonb,
                                   '{}','{}'::jsonb,'{}'::jsonb)
                           RETURNING id""",
                        (nest_name,), one=True)
            section_id = created["id"]

    sec = q("SELECT id, nest_key FROM scheduling.nest_sections WHERE id=%s", (section_id,), one=True)
    if not sec: raise HTTPException(404, "Section not found")
    # Branch isolation: a team lead may only touch sections of their own branch.
    if user["role"] not in ("superadmin", "manager"):
        owner = _branch_id_for_nest(sec["nest_key"])
        if owner is None or not can_access_branch(user, owner):
            raise HTTPException(403, "You can only change sections in your own branch")
    row = q("""INSERT INTO scheduling.section_month_settings
                 (section_id, year, month, min_m, max_m, min_n, max_n, max_consecutive, min_o_block, max_o_block)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (section_id, year, month) DO UPDATE
               SET min_m=%s, max_m=%s, min_n=%s, max_n=%s, max_consecutive=%s, min_o_block=%s, max_o_block=%s, updated_at=NOW()
               RETURNING *""",
            (section_id, year, month, min_m, max_m, min_n, max_n, max_consecutive, min_o_block, max_o_block,
             min_m, max_m, min_n, max_n, max_consecutive, min_o_block, max_o_block), one=True)
    return row

# ── Shift Types ───────────────────────────────────────────────────────────────

@app.get("/api/shift-types")
def get_shift_types(request: Request, user=Depends(get_current_user)):
    # Shift types are global across all branches.
    rows = q("""SELECT id,branch_id,code,label,start_time,end_time,
                       color,is_off,is_leave,is_oncall,sort_order
                FROM scheduling.shift_types
                WHERE branch_id IS NULL
                ORDER BY sort_order, code""")
    return rows

@app.get("/api/shift-types/all")
def get_all_shift_types(user=Depends(get_current_user)):
    # Backwards-compatible endpoint: same as /shift-types now.
    return q("""SELECT id,branch_id,code,label,start_time,end_time,
                       color,is_off,is_leave,is_oncall,sort_order
                FROM scheduling.shift_types
                WHERE branch_id IS NULL
                ORDER BY sort_order, code""")

@app.post("/api/shift-types")
async def upsert_shift_type(request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    code = body.get("code")
    existing = q("SELECT id FROM scheduling.shift_types WHERE branch_id IS NULL AND code=%s", (code,), one=True)
    if existing:
        return q("""UPDATE scheduling.shift_types
                    SET label=%s,start_time=%s,end_time=%s,color=%s,
                        is_off=%s,is_leave=%s,is_oncall=%s,sort_order=%s
                    WHERE id=%s RETURNING *""",
                 (body.get("label"), body.get("start_time"), body.get("end_time"),
                  body.get("color","#6B4EFF"), body.get("is_off",False),
                  body.get("is_leave",False), body.get("is_oncall",False),
                  body.get("sort_order",0), existing["id"]), one=True)
    return q("""INSERT INTO scheduling.shift_types
                (branch_id,code,label,start_time,end_time,color,is_off,is_leave,is_oncall,sort_order)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
             (None, code, body.get("label"), body.get("start_time"), body.get("end_time"),
              body.get("color","#6B4EFF"), body.get("is_off",False),
              body.get("is_leave",False), body.get("is_oncall",False),
              body.get("sort_order",0)), one=True)

@app.put("/api/shift-types/{stid}")
async def update_shift_type(stid: int, request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    sets, params = [], []
    for f in ("label","start_time","end_time","color","is_off","is_leave","is_oncall","sort_order"):
        if f in body: sets.append(f"{f}=%s"); params.append(body[f])
    if not sets: raise HTTPException(400, "Nothing to update")
    params.append(stid)
    row = q(f"UPDATE scheduling.shift_types SET {','.join(sets)} WHERE id=%s RETURNING *",
            params, one=True)
    if not row: raise HTTPException(404, "Not found")
    return row

@app.delete("/api/shift-types/{stid}")
def delete_shift_type(stid: int, user=Depends(require_superadmin)):
    q("DELETE FROM scheduling.shift_types WHERE id=%s", (stid,), exec_only=True)
    return {"ok": True}

# ── Schedules ─────────────────────────────────────────────────────────────────

@app.get("/api/schedules")
def list_schedules(request: Request, user=Depends(get_current_user)):
    # Cross-branch roles (superadmin, manager) can query any/all branches;
    # everyone else is pinned to their own branch — and if they have none
    # (e.g. a viewer/admin with no branch), they get a 403, not the whole list.
    if user["role"] in ("superadmin", "manager"):
        branch_id = request.query_params.get("branch_id")
    else:
        branch_id = user.get("branch_id")
        if not branch_id:
            raise HTTPException(403, "No branch assigned to this account")
    if branch_id:
        rows = q("""SELECT s.id,s.branch_id,s.year,s.month,s.status,s.created_at,s.updated_at,
                           b.name AS branch_name
                    FROM scheduling.schedules s JOIN scheduling.branches b ON b.id=s.branch_id
                    WHERE s.branch_id=%s ORDER BY s.year DESC,s.month DESC""", (branch_id,))
    else:
        rows = q("""SELECT s.id,s.branch_id,s.year,s.month,s.status,s.created_at,s.updated_at,
                           b.name AS branch_name
                    FROM scheduling.schedules s JOIN scheduling.branches b ON b.id=s.branch_id
                    ORDER BY s.year DESC,s.month DESC""")
    return rows

@app.get("/api/schedules/review-overview")
def review_overview(request: Request, user=Depends(require_reviewer)):
    """Manager view: every branch and its schedule status for a given month.
    Branches with no schedule row yet are surfaced as 'not_submitted' so the
    manager can see who is late, not just who submitted."""
    year  = request.query_params.get("year")
    month = request.query_params.get("month")
    if not year or not month:
        raise HTTPException(400, "year and month required")
    rows = q("""
        SELECT b.id AS branch_id, b.name AS branch_name,
               s.id AS schedule_id,
               COALESCE(s.status, 'not_submitted') AS status,
               s.is_locked, s.updated_at, s.reviewed_at, s.approved_at,
               cu.username AS created_by_name,
               (SELECT COUNT(*) FROM scheduling.staff st WHERE st.branch_id=b.id AND st.active=true) AS staff_count,
               (SELECT COUNT(*) FROM scheduling.schedule_entries e
                  WHERE e.schedule_id=s.id AND e.shift_code NOT IN ('O','AL','SL','TB')) AS shift_count
        FROM scheduling.branches b
        LEFT JOIN scheduling.schedules s
          ON s.branch_id=b.id AND s.year=%s AND s.month=%s
        LEFT JOIN scheduling.users cu ON cu.id=s.created_by
        ORDER BY
          CASE COALESCE(s.status,'not_submitted')
            WHEN 'submitted' THEN 0
            WHEN 'reviewed'  THEN 1
            WHEN 'not_submitted' THEN 2
            WHEN 'draft'     THEN 3
            WHEN 'approved'  THEN 4
            ELSE 5 END,
          b.name
    """, (int(year), int(month)))
    # Summary counts for the KPI cards
    summary = {"pending": 0, "not_submitted": 0, "approved": 0, "draft": 0, "total": len(rows)}
    for r in rows:
        st = r["status"]
        if st in ("submitted", "reviewed"): summary["pending"] += 1
        elif st == "approved": summary["approved"] += 1
        elif st == "not_submitted": summary["not_submitted"] += 1
        elif st == "draft": summary["draft"] += 1
    return {"branches": rows, "summary": summary}

@app.post("/api/schedules/open")
async def open_schedule(request: Request, user=Depends(require_admin)):
    body = await request.json()
    branch_id = _int_or_400(body.get("branch_id"), "branch_id")
    year = _int_or_400(body.get("year"), "year")
    month = _int_or_400(body.get("month"), "month")
    if not (2000 <= year <= 2100 and 1 <= month <= 12):
        raise HTTPException(400, "Invalid year/month")
    if not can_access_branch(user, branch_id): raise HTTPException(403, "Forbidden")
    schedule = q("""INSERT INTO scheduling.schedules (branch_id,year,month,status,created_by)
                    VALUES (%s,%s,%s,'draft',%s)
                    ON CONFLICT (branch_id,year,month) DO UPDATE SET updated_at=NOW()
                    RETURNING *""",
                 (branch_id, year, month, user["id"]), one=True)
    # Enrich with who prepared / reviewed / approved it (for the printed roster).
    names = q("""SELECT cu.username AS created_by_name, ru.username AS reviewed_by_name,
                        au.username AS approved_by_name,
                        TO_CHAR(s.approved_at,'YYYY-MM-DD') AS approved_at_date
                 FROM scheduling.schedules s
                 LEFT JOIN scheduling.users cu ON cu.id=s.created_by
                 LEFT JOIN scheduling.users ru ON ru.id=s.reviewed_by
                 LEFT JOIN scheduling.users au ON au.id=s.approved_by
                 WHERE s.id=%s""", (schedule["id"],), one=True) or {}
    schedule.update({k: v for k, v in names.items() if v is not None})
    entries = get_entries(schedule["id"])
    return {"schedule": schedule, "entries": entries}

@app.get("/api/schedules/lookup")
def lookup_schedule(request: Request, user=Depends(require_admin)):
    """Read-only: return the existing schedule for a branch/month (with entries),
    or schedule=null if none exists — WITHOUT creating a draft. Browsing a branch
    must never silently spawn an empty schedule; creation is an explicit action."""
    p = request.query_params
    branch_id, year, month = p.get("branch_id"), p.get("year"), p.get("month")
    if not can_access_branch(user, branch_id): raise HTTPException(403, "Forbidden")
    schedule = q("""SELECT s.*, cu.username AS created_by_name, ru.username AS reviewed_by_name,
                           au.username AS approved_by_name,
                           TO_CHAR(s.approved_at,'YYYY-MM-DD') AS approved_at_date
                    FROM scheduling.schedules s
                    LEFT JOIN scheduling.users cu ON cu.id=s.created_by
                    LEFT JOIN scheduling.users ru ON ru.id=s.reviewed_by
                    LEFT JOIN scheduling.users au ON au.id=s.approved_by
                    WHERE s.branch_id=%s AND s.year=%s AND s.month=%s""",
                 (branch_id, year, month), one=True)
    if not schedule:
        return {"schedule": None, "entries": []}
    return {"schedule": schedule, "entries": get_entries(schedule["id"])}

@app.get("/api/schedules/{sid}/entries")
def list_entries(sid: int, user=Depends(get_current_user)):
    # A staff member sees only their own row, via /api/my-schedule — not the
    # whole team's entries.
    if user.get("role") == "staff":
        raise HTTPException(403, "Use /api/my-schedule")
    assert_schedule_access(user, sid)
    return get_entries(sid)

def _get_or_create_schedule_id(branch_id, year, month, created_by=None):
    """Resolve a branch+month to its schedule id, creating a draft if missing."""
    row = q("""INSERT INTO scheduling.schedules (branch_id,year,month,status,created_by)
               VALUES (%s,%s,%s,'draft',%s)
               ON CONFLICT (branch_id,year,month) DO UPDATE SET updated_at=NOW()
               RETURNING id""", (branch_id, year, month, created_by), one=True)
    return row["id"]

def get_entries(schedule_id):
    own = q("""SELECT e.id,e.schedule_id,e.staff_id,
                       TO_CHAR(e.date,'YYYY-MM-DD') AS date,
                       e.shift_code,e.cross_branch_id,e.is_oncall,e.note,
                       COALESCE(e.is_manual,false) AS is_manual,
                       s.name AS staff_name,s.speciality,s.is_cross_branch,
                       b.name AS cross_branch_name, NULL AS home_branch_name
                FROM scheduling.schedule_entries e
                JOIN scheduling.staff s ON s.id=e.staff_id
                LEFT JOIN scheduling.branches b ON b.id=e.cross_branch_id
                WHERE e.schedule_id=%s ORDER BY s.name,e.date""", (schedule_id,))
    # Inbound cross-branch cover: staff from OTHER branches whose own rota places
    # them at THIS branch (their entry carries cross_branch_id = this branch).
    # Surface them so the host rota shows who's covering it.
    sc = q("SELECT branch_id,year,month FROM scheduling.schedules WHERE id=%s", (schedule_id,), one=True)
    inbound = []
    if sc:
        inbound = q("""SELECT e.id, %s AS schedule_id, e.staff_id,
                              TO_CHAR(e.date,'YYYY-MM-DD') AS date,
                              e.shift_code, e.cross_branch_id, e.is_oncall, e.note,
                              s.name AS staff_name, s.speciality, s.is_cross_branch,
                              hb.name AS cross_branch_name, ownb.name AS home_branch_name
                       FROM scheduling.schedule_entries e
                       JOIN scheduling.schedules ssc ON ssc.id=e.schedule_id
                       JOIN scheduling.staff s ON s.id=e.staff_id
                       LEFT JOIN scheduling.branches hb ON hb.id=e.cross_branch_id
                       LEFT JOIN scheduling.branches ownb ON ownb.id=ssc.branch_id
                       WHERE e.cross_branch_id=%s AND ssc.year=%s AND ssc.month=%s
                         AND ssc.branch_id<>%s
                       ORDER BY s.name,e.date""",
                    (schedule_id, sc["branch_id"], sc["year"], sc["month"], sc["branch_id"]))
    return own + inbound

@app.put("/api/schedules/{sid}/entries")
async def save_entry(sid: int, request: Request, user=Depends(require_admin)):
    body = await request.json()
    # Right branch, and not locked (unless the editor is a reviewer).
    sched = assert_can_edit_schedule(user, sid)
    sids, codes = schedule_validation_sets(sched)
    check_entry(sched, sids, codes, body.get("staff_id"), body.get("date"), body.get("shift_code", "O"))
    # Don't silently overwrite an APPROVED leave with a working shift (a person can't
    # be on approved leave AND working the same day). Overridable with confirm:true.
    if (_is_working_code(body.get("shift_code", "O")) and not body.get("confirm")
            and has_approved_leave(body.get("staff_id"), body.get("date"))):
        raise HTTPException(409, {"error": "This staff member has APPROVED leave on this day — assigning a shift conflicts with their leave. Assign anyway?",
                                  "confirm_required": "leave_conflict"})
    row = q("""INSERT INTO scheduling.schedule_entries
               (schedule_id,staff_id,date,shift_code,cross_branch_id,is_oncall,note,is_manual)
               VALUES (%s,%s,%s,%s,%s,%s,%s,true)
               ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET
               shift_code=%s,cross_branch_id=%s,is_oncall=%s,note=%s,is_manual=true
               RETURNING id,schedule_id,staff_id,
                         TO_CHAR(date,'YYYY-MM-DD') AS date,
                         shift_code,cross_branch_id,is_oncall,note,is_manual""",
            (sid, body.get("staff_id"), body.get("date"),
             body.get("shift_code","O"), body.get("cross_branch_id"),
             body.get("is_oncall",False), body.get("note"),
             body.get("shift_code","O"), body.get("cross_branch_id"),
             body.get("is_oncall",False), body.get("note")),
            one=True)
    return row

@app.put("/api/schedules/{sid}/entries/bulk")
async def bulk_save_entries(sid: int, request: Request, user=Depends(require_admin)):
    body = await request.json()
    # Same guard as the single-cell save.
    sched = assert_can_edit_schedule(user, sid)
    entries = body.get("entries", [])
    if not isinstance(entries, list): raise HTTPException(400, "entries must be array")
    sids, codes = schedule_validation_sets(sched)
    for e in entries:
        check_entry(sched, sids, codes, e.get("staff_id"), e.get("date"), e.get("shift_code", "O"))
    # Block (unless confirm) any working shift landing on an APPROVED-leave day.
    if not body.get("confirm"):
        clash = [e for e in entries if _is_working_code(e.get("shift_code", "O"))
                 and has_approved_leave(e.get("staff_id"), e.get("date"))]
        if clash:
            names = q("""SELECT id, name FROM scheduling.staff WHERE id = ANY(%s)""",
                      ([e.get("staff_id") for e in clash],))
            nm = {r["id"]: r["name"] for r in names}
            shown = "; ".join(f"{nm.get(e.get('staff_id'), e.get('staff_id'))} {e.get('date')}" for e in clash[:5])
            more = f" +{len(clash)-5} more" if len(clash) > 5 else ""
            raise HTTPException(409, {"error": f"These assignments fall on APPROVED leave days: {shown}{more}. Assign anyway?",
                                      "confirm_required": "leave_conflict"})
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            for e in entries:
                cur.execute("""INSERT INTO scheduling.schedule_entries
                               (schedule_id,staff_id,date,shift_code,cross_branch_id,is_oncall,note,is_manual)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,true)
                               ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET
                               shift_code=%s,cross_branch_id=%s,is_oncall=%s,note=%s,is_manual=true""",
                            (sid, e.get("staff_id"), e.get("date"),
                             e.get("shift_code","O"), e.get("cross_branch_id"),
                             e.get("is_oncall",False), e.get("note"),
                             e.get("shift_code","O"), e.get("cross_branch_id"),
                             e.get("is_oncall",False), e.get("note")))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)
    insert_audit(user, "BULK_SAVE", f"schedule:{sid}", f"{len(entries)} entries")
    return {"ok": True, "count": len(entries)}

@app.delete("/api/schedules/{sid}/entries")
def clear_entries(sid: int, user=Depends(require_admin)):
    assert_can_edit_schedule(user, sid)
    q("DELETE FROM scheduling.schedule_entries WHERE schedule_id=%s", (sid,), exec_only=True)
    return {"ok": True}

@app.delete("/api/schedules/{sid}/entries/cell")
async def delete_entry_cell(sid: int, request: Request, user=Depends(require_admin)):
    """Delete a single cell entry (makes it blank on the grid)."""
    body = await request.json()
    assert_can_edit_schedule(user, sid)
    staff_id = body.get("staff_id")
    date     = body.get("date")
    if not staff_id or not date:
        raise HTTPException(400, "staff_id and date required")
    q("""DELETE FROM scheduling.schedule_entries
         WHERE schedule_id=%s AND staff_id=%s AND date=%s""",
      (sid, staff_id, date), exec_only=True)
    insert_audit(user, "CLEAR_CELL", f"schedule:{sid}", f"staff={staff_id} date={date}")
    return {"ok": True}

@app.put("/api/schedules/{sid}/lock")
async def toggle_schedule_lock(sid: int, request: Request, user=Depends(require_editor)):
    """Lock or unlock an entire schedule (branch+month). Locked schedules block all edits."""
    sched = assert_schedule_access(user, sid)
    body   = await request.json()
    locked = body.get("locked", True)
    # Once a schedule is in the review pipeline, a team lead can't quietly unlock
    # it to edit/delete — only a reviewer can reopen it (via Return).
    if not locked and sched.get("status") in ("submitted", "reviewed", "approved") \
       and user["role"] not in ("manager", "superadmin"):
        raise HTTPException(403, "This schedule is in review — ask a manager to return it.")
    row = q("""UPDATE scheduling.schedules SET is_locked=%s, updated_at=NOW()
               WHERE id=%s RETURNING *""", (locked, sid), one=True)
    if not row:
        raise HTTPException(404, "Schedule not found")
    action = "LOCK_SCHEDULE" if locked else "UNLOCK_SCHEDULE"
    insert_audit(user, action, f"schedule:{sid}")
    return row

@app.put("/api/schedules/{sid}/status")
async def update_schedule_status(sid: int, request: Request, user=Depends(require_admin)):
    current = assert_schedule_access(user, sid)
    body = await request.json()
    status = body.get("status")
    note   = body.get("note")
    if status not in ("draft","submitted","reviewed","approved","returned"):
        raise HTTPException(400, "Invalid status")
    # Team leads (admin) submit/withdraw their own branch; managers (and full
    # admins) review/approve/return. Keep the two roles from doing each other's job.
    is_reviewer = user["role"] in ("superadmin", "manager")
    if status in ("reviewed","approved","returned") and not is_reviewer:
        raise HTTPException(403, "Only a manager can review, approve, or return")
    if status in ("submitted","draft") and user["role"] == "manager":
        raise HTTPException(403, "Managers don't submit schedules; that's the team lead's step")
    # Once the manager has reviewed or approved, a team lead can no longer pull
    # the schedule back (withdraw → draft, or re-submit). Only a manager can
    # reopen it via "return". This keeps the manager's sign-off meaningful.
    if not is_reviewer and status in ("draft","submitted") and current.get("status") in ("reviewed","approved"):
        raise HTTPException(403, "The manager has already reviewed this schedule. Ask the manager to return it before editing.")

    # (review_note column is created in init_schema at startup — no per-request DDL.)

    sets = "status=%s, updated_at=NOW()"
    params = [status]
    # Lock when submitted or approved; unlock when returned to draft/returned.
    if status in ("submitted","reviewed","approved"):
        sets += ", is_locked=true"
    elif status in ("draft","returned"):
        sets += ", is_locked=false"
    if status == "reviewed":
        sets += ", reviewed_by=%s, reviewed_at=NOW()"; params.append(user["id"])
    if status == "approved":
        sets += ", approved_by=%s, approved_at=NOW()"; params.append(user["id"])
    if status in ("returned","approved","reviewed"):
        sets += ", review_note=%s"; params.append(note or None)
    params.append(sid)
    row = q(f"UPDATE scheduling.schedules SET {sets} WHERE id=%s RETURNING *", params, one=True)
    insert_audit(user, f"SCHEDULE_{status.upper()}", f"schedule:{sid}")

    # ── Notify the other side of the review hand-off ──────────────────────────
    bname = (q("SELECT name FROM scheduling.branches WHERE id=%s", (row["branch_id"],), one=True) or {}).get("name", "")
    period = f"{row['year']}-{str(row['month']).zfill(2)}"
    if status == "submitted":
        notify_roles(("manager", "superadmin"),
                     f"{bname} {period} schedule submitted for review",
                     link="review", ntype="review", exclude_user=user["id"])
    elif status in ("reviewed", "approved", "returned") and row.get("created_by"):
        # Don't ping the creator about an action they performed on their own schedule.
        if row["created_by"] != user["id"]:
            verb = {"reviewed": "reviewed", "approved": "approved", "returned": "returned for edits"}[status]
            notify(row["created_by"], f"{bname} {period} schedule was {verb}", link="schedule", ntype=status)
    return row

@app.delete("/api/schedules/{sid}")
def delete_schedule(sid: int, user=Depends(require_editor)):
    sched = assert_schedule_access(user, sid)
    if sched.get("status") in ("submitted", "reviewed", "approved") \
       and user["role"] not in ("manager", "superadmin"):
        raise HTTPException(403, "Can't delete a schedule that's in review/approved.")
    q("DELETE FROM scheduling.schedules WHERE id=%s", (sid,), exec_only=True)
    return {"ok": True}

# ── Leaves ────────────────────────────────────────────────────────────────────

@app.get("/api/leaves")
def list_leaves(request: Request, user=Depends(get_current_user)):
    params = request.query_params
    conds, vals = ["1=1"], []
    if user["role"] == "staff":
        # A staff member only ever sees their own leave.
        conds.append("l.staff_id=%s"); vals.append(user.get("staff_id"))
    elif user["role"] in ("superadmin", "manager"):
        branch_id = params.get("branch_id")
        if branch_id: conds.append("s.branch_id=%s"); vals.append(branch_id)
    else:
        # A branch-bound role (team lead, viewer) only ever sees its own branch —
        # and a branchless account gets nothing rather than every branch.
        branch_id = user.get("branch_id")
        if not branch_id:
            raise HTTPException(403, "No branch assigned to this account")
        conds.append("s.branch_id=%s"); vals.append(branch_id)
    year  = params.get("year")
    month = params.get("month")
    if year:      conds.append("EXTRACT(YEAR FROM l.date)=%s");  vals.append(year)
    if month:     conds.append("EXTRACT(MONTH FROM l.date)=%s"); vals.append(month)
    return q(f"""SELECT l.id,l.staff_id,TO_CHAR(l.date,'YYYY-MM-DD') AS date,
                        l.leave_type,l.status,l.note,l.created_by,l.created_at,
                        s.name AS staff_name,s.branch_id,b.name AS branch_name
                 FROM scheduling.leave_requests l
                 JOIN scheduling.staff s ON s.id=l.staff_id
                 LEFT JOIN scheduling.branches b ON b.id=s.branch_id
                 WHERE {' AND '.join(conds)} ORDER BY l.date""", vals)

@app.post("/api/leaves")
async def create_leave(request: Request, user=Depends(get_current_user)):
    body = await request.json()
    staff_id  = body.get("staff_id")
    date_from = body.get("date_from")
    date_to   = body.get("date_to") or date_from
    leave_type = body.get("leave_type", "AL")
    note = body.get("note")
    # A staff member can only request leave for themselves; everyone else needs
    # editor rights. Viewers can't create leave at all.
    if user["role"] == "staff":
        staff_id = user.get("staff_id")
    elif user["role"] not in ("admin", "manager", "superadmin"):
        raise HTTPException(403, "Forbidden")
    if not staff_id or not date_from:
        raise HTTPException(400, "staff_id and date_from required")
    staff = q("SELECT * FROM scheduling.staff WHERE id=%s", (staff_id,), one=True)
    if not staff: raise HTTPException(404, "Staff not found")
    if user["role"] != "staff" and not can_access_branch(user, staff["branch_id"]):
        raise HTTPException(403, "Forbidden")
    if date_to < date_from: raise HTTPException(400, '"To" date must be on or after "From" date')

    # Cutoff: staff and team leads must submit next-month (and later) leave before
    # the cutoff day of the prior month. Sick leave is an emergency notification,
    # so it has no cutoff. Managers/superadmins may override too.
    if user["role"] in ("staff", "admin") and leave_type != "SL":
        cutoff = get_leave_cutoff_day()
        for chk in {date_from, date_to}:
            ok, why = leave_window_open(chk, cutoff)
            if not ok:
                raise HTTPException(400, why)

    # Sick leave is NOT an approval workflow — it just informs us and lands on the
    # rota immediately (then we surface cover suggestions). Annual/other leave goes
    # through the two-stage chain: staff -> team lead -> manager.
    if leave_type == "SL":
        new_status = "approved"
    elif user["role"] in ("superadmin", "manager"):
        new_status = "approved"
    elif user["role"] == "admin":
        new_status = LEAVE_AWAIT_MANAGER
    else:
        new_status = LEAVE_AWAIT_LEAD

    # Expand date range
    from datetime import date as _date, timedelta as _td
    try:
        cur = _date(*map(int, date_from.split('-')))
        end = _date(*map(int, date_to.split('-')))
    except (ValueError, TypeError):
        raise HTTPException(400, "Dates must be valid YYYY-MM-DD")
    dates, leaves, failed = [], [], []
    while cur <= end and len(dates) < 365:
        dates.append(str(cur)); cur += _td(days=1)

    for d in dates:
        try:
            # For sick leave, remember the shift it replaces so we can suggest cover.
            covered = _current_rota_shift(staff_id, d) if leave_type == "SL" else None
            # Never let a fresh submission silently overwrite an already-APPROVED
            # leave: the ON CONFLICT UPDATE would reset its status back to
            # pending/awaiting without clearing the rota, leaving the AL cell on
            # the board while the DB says pending (and dropping the leave-conflict
            # guards). The WHERE skips those rows; we then treat the existing
            # approved leave as already-saved rather than a failure.
            row = q("""INSERT INTO scheduling.leave_requests
                       (staff_id,date,leave_type,status,note,created_by,covered_shift)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (staff_id,date) DO UPDATE
                       SET leave_type=EXCLUDED.leave_type,note=EXCLUDED.note,
                           status=EXCLUDED.status,created_by=EXCLUDED.created_by,
                           covered_shift=EXCLUDED.covered_shift
                       WHERE scheduling.leave_requests.status <> 'approved'
                       RETURNING id,staff_id,TO_CHAR(date,'YYYY-MM-DD') AS date,
                                 leave_type,status,note,created_by,created_at,covered_shift""",
                    (staff_id, d, leave_type, new_status, note, user["id"], covered), one=True)
            if row:
                leaves.append(row)
                # Approved leave (reviewer entry or sick leave) goes straight on the rota.
                if new_status == "approved":
                    apply_leave_to_schedule(staff_id, d, leave_type)
            else:
                # No row back: either the conflict target is already approved
                # (keep it — it's on the rota) or the insert genuinely failed.
                existing = q("""SELECT id,staff_id,TO_CHAR(date,'YYYY-MM-DD') AS date,
                                       leave_type,status,note,created_by,created_at,covered_shift
                                FROM scheduling.leave_requests
                                WHERE staff_id=%s AND date=%s""", (staff_id, d), one=True)
                if existing and existing["status"] == "approved":
                    leaves.append(existing)
                else:
                    failed.append(d)
        except Exception as e:
            # Don't silently drop a day — record it so the caller can surface
            # "saved 3 of 5" instead of pretending everything went through.
            print(f"[leave] save failed for staff {staff_id} on {d}: {e}", file=sys.stderr)
            failed.append(d)

    # If the whole request failed, that's an error, not a silent no-op.
    if dates and not leaves:
        raise HTTPException(400, "Couldn't save the leave — please try again.")

    if leaves and leave_type == "SL":
        # Sick leave: tell the branch lead + managers and point them at cover.
        leads = q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s", (staff["branch_id"],))
        msg = f"{staff['name']} reported sick — {len(leaves)} day(s). Tap to find cover."
        for u in (leads or []):
            notify(u["id"], msg, link="leaves", ntype="leave")
        notify_roles(("manager", "superadmin"), msg, link="leaves", ntype="leave")
    elif leaves and new_status == LEAVE_AWAIT_LEAD:
        # Stage 1: the branch team lead approves first (managers as fallback if
        # the branch has no lead).
        leads = q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s",
                  (staff["branch_id"],))
        msg = f"{staff['name']}: {len(leaves)} day(s) {leave_type} leave awaiting your approval"
        if leads:
            for u in leads:
                notify(u["id"], msg, link="leaves", ntype="leave")
        else:
            notify_roles(("manager", "superadmin"), msg, link="leaves", ntype="leave")
    elif leaves and new_status == LEAVE_AWAIT_MANAGER:
        notify_roles(("manager", "superadmin"),
                     f"{staff['name']}: {len(leaves)} day(s) {leave_type} leave awaiting your final approval",
                     link="leaves", ntype="leave")
    return {"inserted": len(leaves), "requested": len(dates), "failed": len(failed),
            "failed_dates": failed, "leaves": leaves, "status": new_status}

@app.delete("/api/leaves/{lid}")
def delete_leave(lid: int, user=Depends(get_current_user)):
    lv = q("""SELECT s.branch_id, l.staff_id, TO_CHAR(l.date,'YYYY-MM-DD') AS date,
                     l.leave_type, l.status
              FROM scheduling.leave_requests l
              JOIN scheduling.staff s ON s.id=l.staff_id WHERE l.id=%s""",
           (lid,), one=True)
    if not lv:
        raise HTTPException(404, "Leave not found")
    if user["role"] == "staff":
        # A staff member may withdraw only their OWN request, and only while it's
        # still pending — cancelling an already-approved leave is on the rota, so
        # it goes back through a manager.
        if lv["staff_id"] != user.get("staff_id"):
            raise HTTPException(403, "Forbidden")
        if lv["status"] != "pending":
            raise HTTPException(400, "Only a pending request can be withdrawn — ask a manager to change approved leave")
    elif user["role"] in ("admin", "manager", "superadmin"):
        # A team lead may only delete leaves for their own branch's staff.
        if not can_access_branch(user, lv["branch_id"]):
            raise HTTPException(403, "Forbidden")
    else:
        raise HTTPException(403, "Forbidden")
    q("DELETE FROM scheduling.leave_requests WHERE id=%s", (lid,), exec_only=True)
    # If it had been placed on the rota, take it back off.
    if lv["status"] == "approved":
        clear_leave_from_schedule(lv["staff_id"], lv["date"], lv["leave_type"])
    return {"ok": True}

@app.put("/api/leaves/{lid}/status")
async def update_leave_status(lid: int, request: Request, user=Depends(require_admin)):
    """Two-stage approval: a team lead clears stage 1 ('lead_approved'), a manager
    gives final approval ('approved', which lands it on the rota). Either rejects."""
    body = await request.json()
    requested = body.get("status")
    lv = q("""SELECT l.created_by, l.staff_id, l.leave_type, l.status,
                     TO_CHAR(l.date,'YYYY-MM-DD') AS date,
                     s.name AS staff_name, s.branch_id
              FROM scheduling.leave_requests l
              JOIN scheduling.staff s ON s.id=l.staff_id WHERE l.id=%s""", (lid,), one=True)
    if not lv:
        raise HTTPException(404, "Leave not found")
    if not can_access_branch(user, lv["branch_id"]):
        raise HTTPException(403, "Forbidden")
    new_status = _leave_decide(user, lv["status"], requested)
    # Coverage guard only at FINAL approval: if it leaves a shift uncovered, warn
    # the approver first (unless they confirm), then alert the branch lead.
    gap_code = None
    if new_status == "approved":
        gap_code = leave_coverage_gap(lv["staff_id"], lv["date"])
        if gap_code and not body.get("confirm"):
            raise HTTPException(409, {
                "error": f"{lv['staff_name']} is the only one on shift {gap_code} on {lv['date']}. "
                         f"Approving leaves that shift uncovered — approve anyway?",
                "confirm_required": "coverage_gap",
            })
    # Atomic on the CURRENT status so two concurrent approvals can't both apply
    # (double audit / double notify). Only the winner proceeds.
    row = q("""UPDATE scheduling.leave_requests SET status=%s WHERE id=%s AND status=%s
               RETURNING id,staff_id,TO_CHAR(date,'YYYY-MM-DD') AS date,leave_type,status,note""",
            (new_status, lid, lv["status"]), one=True)
    if not row:
        raise HTTPException(409, "This leave was just actioned by someone else")
    insert_audit(user, f"LEAVE_{new_status.upper()}", f"leave:{lid}", f"{lv['staff_name']} {lv['date']}")
    if new_status == "approved":
        apply_leave_to_schedule(lv["staff_id"], lv["date"], lv["leave_type"])
        if gap_code:
            notify_branch_leads(lv["branch_id"],
                                f"Coverage gap: {lv['staff_name']} on leave {lv['date']} leaves shift "
                                f"{gap_code} uncovered — please reassign or regenerate",
                                link="schedule", ntype="leave")
    elif new_status == "rejected":
        clear_leave_from_schedule(lv["staff_id"], lv["date"], lv["leave_type"])
    _notify_leave_progress(lv, new_status, user)
    return row

@app.put("/api/leaves/status")
async def update_leaves_status_batch(request: Request, user=Depends(require_admin)):
    """Approve/reject a whole range of leave days in one call (two-stage: team
    lead → manager). One summary notification instead of a ping per day."""
    body = await request.json()
    requested = body.get("status")
    ids = body.get("ids")
    if requested not in ("approved", "rejected"):
        raise HTTPException(400, "status must be 'approved' or 'rejected'")
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "ids must be a non-empty list")
    ids = [int(i) for i in ids]
    rows = q("""SELECT l.id, l.created_by, l.staff_id, l.leave_type, l.status,
                       TO_CHAR(l.date,'YYYY-MM-DD') AS date,
                       s.name AS staff_name, s.branch_id
                FROM scheduling.leave_requests l
                JOIN scheduling.staff s ON s.id=l.staff_id
                WHERE l.id = ANY(%s) ORDER BY l.date""", (ids,))
    if not rows:
        raise HTTPException(404, "No leaves found")
    # Branch access: a team lead/manager may only act on their own branch's staff.
    for lv in rows:
        if not can_access_branch(user, lv["branch_id"]):
            raise HTTPException(403, "Forbidden")
    # Only act on rows that share the stage of the earliest row — a batch must not
    # blanket-force mixed states (which would resurrect a rejected day or downgrade
    # an already-approved one). Rows in a different status are ignored.
    current = rows[0]["status"]
    rows = [lv for lv in rows if lv["status"] == current]
    act_ids = [lv["id"] for lv in rows]
    new_status = _leave_decide(user, current, requested)
    # Coverage gaps only matter at FINAL approval; check BEFORE applying. The whole
    # batch is leaving, so each gap check excludes the OTHER batch members on that day
    # (else two people on the same shift each mask the other → a hidden zero-coverage).
    gaps = []
    if new_status == "approved":
        from collections import defaultdict
        leaving_by_date = defaultdict(set)
        for lv in rows:
            leaving_by_date[lv["date"]].add(lv["staff_id"])
        for lv in rows:
            gc = leave_coverage_gap(lv["staff_id"], lv["date"],
                                    exclude_staff=leaving_by_date[lv["date"]] - {lv["staff_id"]})
            if gc:
                gaps.append((lv, gc))
        if gaps and not body.get("confirm"):
            shown = "; ".join(f"{g[0]['staff_name']} {g[0]['date']} (shift {g[1]})" for g in gaps[:5])
            more = f" +{len(gaps)-5} more" if len(gaps) > 5 else ""
            raise HTTPException(409, {
                "error": f"These approvals leave shifts uncovered: {shown}{more}. Approve anyway?",
                "confirm_required": "coverage_gap",
            })
    # Atomic per-stage transition: only rows still in `current` move (guards against a
    # concurrent double-approve). Only the rows we actually flipped get rota-synced.
    moved = q("""UPDATE scheduling.leave_requests SET status=%s
                 WHERE id = ANY(%s) AND status=%s RETURNING id""",
              (new_status, act_ids, current))
    moved_ids = {r["id"] for r in (moved or [])}
    rows = [lv for lv in rows if lv["id"] in moved_ids]
    if not rows:
        raise HTTPException(409, "These leaves were already actioned")
    for lv in rows:
        _leave_rota_sync(lv, new_status)
    insert_audit(user, f"LEAVE_{new_status.upper()}_BATCH",
                 f"leaves:{len(rows)}", f"{rows[0]['staff_name']} … {len(rows)} day(s)")
    from collections import defaultdict
    gap_by_branch = defaultdict(list)
    for lv, gc in gaps:
        gap_by_branch[lv["branch_id"]].append(f"{lv['staff_name']} {lv['date']} (shift {gc})")
    for bid, items in gap_by_branch.items():
        notify_branch_leads(bid, f"Coverage gap on approval: {'; '.join(items)} — please reassign or regenerate",
                            link="schedule", ntype="leave")
    if new_status == LEAVE_AWAIT_MANAGER:
        # Stage 1 cleared in bulk → ping the managers once (staff hear at the
        # final decision, not at this intermediate step).
        names = ", ".join(sorted({lv["staff_name"] for lv in rows}))
        notify_roles(("manager", "superadmin"),
                     f"{names}: {len(rows)} leave day(s) cleared by the team lead — awaiting your final approval",
                     link="leaves", ntype="leave")
    else:
        # Final approved/rejected → one summary per requester + each staff member.
        by_creator = defaultdict(list)
        for lv in rows:
            if lv.get("created_by"):
                by_creator[lv["created_by"]].append(lv)
        for creator, items in by_creator.items():
            if creator == user["id"]:
                continue
            names = ", ".join(sorted({i["staff_name"] for i in items}))
            n = len(items)
            notify(creator, f"{names}: {n} leave day{'s' if n != 1 else ''} {new_status}",
                   link="leaves", ntype=new_status)
        for sid in {lv["staff_id"] for lv in rows}:
            notify_staff_member(sid, f"Your leave was {new_status}", link="leaves", ntype=new_status)
    return {"updated": len(rows), "status": new_status}

# ── Sick-leave cover suggestions ──────────────────────────────────────────────

def _largest_remainder_share(caps: dict, total: int) -> dict:
    """Split `total` whole units across keys proportionally to their capacity,
    using the largest-remainder method (so the parts always sum to `total`).
    Keys with more capacity get the leftover units; zero-capacity keys get 0."""
    keys = list(caps.keys())
    tot_cap = sum(max(0.0, float(caps[k])) for k in keys)
    if total <= 0 or tot_cap <= 0:
        return {k: 0 for k in keys}
    raw  = {k: total * max(0.0, float(caps[k])) / tot_cap for k in keys}
    base = {k: int(raw[k]) for k in keys}
    rem  = total - sum(base.values())
    # Hand the remaining units to the biggest fractional parts (ties → bigger cap).
    order = sorted(keys, key=lambda k: (raw[k] - base[k], caps[k]), reverse=True)
    for k in order[:max(0, rem)]:
        base[k] += 1
    return base

def _cross_cover_export_share(branch_id, branch_city, shares_staff, year, month):
    """How many EXTRA General staff/day this donor branch should field so the
    city's cross-branch target(s) (e.g. Y3) get covered. The city's total per-day
    need is split equally across sharing branches, weighted by each branch's
    leave-adjusted General capacity — a branch with staff on leave carries less."""
    if not shares_staff or not branch_city:
        return 0
    tgt = q("""SELECT COALESCE(SUM(cover_need_per_day),0) AS need FROM scheduling.branches
               WHERE city IS NOT DISTINCT FROM %s AND COALESCE(cover_need_per_day,0)>0""",
            (branch_city,), one=True)
    total_need = int((tgt or {}).get("need") or 0)
    if total_need <= 0:
        return 0
    donors = q("""SELECT id FROM scheduling.branches
                  WHERE shares_staff=true AND city IS NOT DISTINCT FROM %s""", (branch_city,))
    dids = [d["id"] for d in donors]
    if branch_id not in dids:
        return 0
    ndays = _cal.monthrange(year, month)[1]
    rows = q("""SELECT s.branch_id, s.speciality,
                  (SELECT COUNT(*) FROM scheduling.leave_requests l
                     WHERE l.staff_id=s.id AND l.status='approved'
                       AND EXTRACT(YEAR FROM l.date)=%s AND EXTRACT(MONTH FROM l.date)=%s) AS leave_days
                FROM scheduling.staff s WHERE s.active=true AND s.branch_id = ANY(%s)""",
             (year, month, dids))
    caps = {d: 0.0 for d in dids}
    for r in rows:
        if _section_of(r["speciality"]) != "General":
            continue
        caps[r["branch_id"]] += max(0.0, 1.0 - int(r["leave_days"] or 0) / ndays)
    return _largest_remainder_share(caps, total_need).get(branch_id, 0)

ANNUAL_LEAVE_DAYS = 22   # each staff accrues this many AL days per year

def _live_leave_balance(staff_id, recorded, anchor):
    """Current annual-leave balance: the recorded balance plus accrual (22 days/yr
    from the date it was recorded) minus any approved AL taken since then. Returns
    the live number rounded to 1 decimal; falls back to the recorded value if no
    anchor date is set."""
    base = float(recorded or 0)
    if not anchor:
        return round(base, 1)
    from datetime import date as _d
    today = _d.today()
    anchor_d = anchor if hasattr(anchor, "year") else _d(*map(int, str(anchor)[:10].split("-")))
    days = max(0, (today - anchor_d).days)
    accrued = ANNUAL_LEAVE_DAYS * days / 365.25
    taken = q("""SELECT COUNT(*) AS n FROM scheduling.leave_requests
                 WHERE staff_id=%s AND status='approved' AND leave_type='AL'
                   AND date > %s AND date <= %s""",
              (staff_id, anchor_d.isoformat(), today.isoformat()), one=True)
    return round(base + accrued - int((taken or {}).get("n") or 0), 1)

def _section_of(speciality):
    """Classify a staff member's section as 'US' or 'General'."""
    spec = [str(x).lower() for x in (speciality or [])]
    if any(x == "us" or "ultrasound" in x for x in spec):
        return "US"
    return "General"

def _cover_leave(lid):
    return q("""SELECT l.id,l.staff_id,TO_CHAR(l.date,'YYYY-MM-DD') AS date,l.covered_shift,
                       l.leave_type, s.name AS staff_name, s.branch_id, s.speciality,
                       b.name AS branch_name
                FROM scheduling.leave_requests l
                JOIN scheduling.staff s ON s.id=l.staff_id
                LEFT JOIN scheduling.branches b ON b.id=s.branch_id
                WHERE l.id=%s""", (lid,), one=True)

def _can_see_cover(user, lv):
    if user["role"] in ("manager", "superadmin"):
        return True
    if user["role"] == "admin":
        return can_access_branch(user, lv["branch_id"])
    if user["role"] == "staff":
        return user.get("staff_id") == lv["staff_id"]
    return False

@app.get("/api/leaves/{lid}/cover-suggestions")
def cover_suggestions(lid: int, user=Depends(get_current_user)):
    """Who could cover an absent staffer's shift: same section, free that day,
    from ALL branches, ranked (same branch first, then lightest load)."""
    lv = _cover_leave(lid)
    if not lv:
        raise HTTPException(404, "Leave not found")
    if not _can_see_cover(user, lv):
        raise HTTPException(403, "Forbidden")
    date = lv["date"]; want = _section_of(lv["speciality"])
    y, m = int(date[:4]), int(date[5:7])
    rows = q("""
        SELECT s.id, s.name, s.branch_id, s.speciality, b.name AS branch_name,
               e.shift_code AS shift_today,
               (SELECT COUNT(*) FROM scheduling.schedule_entries e2
                  JOIN scheduling.schedules sc2 ON sc2.id=e2.schedule_id
                 WHERE e2.staff_id=s.id AND sc2.year=%s AND sc2.month=%s
                   AND e2.shift_code NOT IN ('O','AL','SL','TB')) AS shifts_month
        FROM scheduling.staff s
        LEFT JOIN scheduling.branches b ON b.id=s.branch_id
        LEFT JOIN scheduling.schedules sc ON sc.branch_id=s.branch_id AND sc.year=%s AND sc.month=%s
        LEFT JOIN scheduling.schedule_entries e ON e.schedule_id=sc.id AND e.staff_id=s.id AND e.date=%s
        WHERE s.active=true AND s.id<>%s
    """, (y, m, y, m, date, lv["staff_id"]))
    cands = []
    for r in rows:
        if _section_of(r["speciality"]) != want:
            continue
        shift = r["shift_today"]
        if shift in ("AL", "SL", "TB"):     # already off / on leave
            continue
        if shift is not None and shift != "O":  # working a shift that day → not free
            continue
        cands.append({
            "staff_id": r["id"], "name": r["name"], "branch_name": r["branch_name"],
            "section": want, "shifts_month": int(r["shifts_month"] or 0),
            "same_branch": r["branch_id"] == lv["branch_id"],
        })
    cands.sort(key=lambda c: (not c["same_branch"], c["shifts_month"], c["name"]))
    return {"date": date, "gap_shift": lv["covered_shift"], "section": want,
            "absent": lv["staff_name"], "branch_name": lv["branch_name"], "candidates": cands}

@app.post("/api/leaves/{lid}/request-cover")
async def request_cover(lid: int, request: Request, user=Depends(get_current_user)):
    """Assign a candidate to cover the absent staffer's shift: put the SAME shift
    (morning/night) on the covering person's own rota — across branches when
    needed — and notify them. Falls back to a notification only if the assigner
    can't edit the covering person's branch."""
    body = await request.json()
    lv = _cover_leave(lid)
    if not lv:
        raise HTTPException(404, "Leave not found")
    if not _can_see_cover(user, lv):
        raise HTTPException(403, "Forbidden")
    cand = q("SELECT id, name, branch_id FROM scheduling.staff WHERE id=%s", (body.get("staff_id"),), one=True)
    if not cand:
        raise HTTPException(404, "Staff not found")
    code = lv.get("covered_shift")             # the M/N shift being covered
    date = lv["date"]
    y, m = int(date[:4]), int(date[5:7])
    placed = False
    # Place the shift on the covering person's sheet when we have a real shift and
    # the assigner can edit that branch (reviewers can edit any branch).
    if code and code not in ("O", "AL", "SL", "TB") and can_access_branch(user, cand["branch_id"]):
        # Don't silently overwrite the covering person's own shift (would leave THEIR
        # branch short) or an approved-leave day. Overridable with confirm:true.
        if not body.get("confirm"):
            cur = _current_rota_shift(cand["id"], date)   # their working shift, or None
            if cur or has_approved_leave(cand["id"], date):
                raise HTTPException(409, {
                    "error": f"{cand['name']} already has {'a shift (' + cur + ')' if cur else 'approved leave'} on {date} — covering would overwrite it. Assign anyway?",
                    "confirm_required": "cover_conflict"})
        cross = lv["branch_id"] if cand["branch_id"] != lv["branch_id"] else None
        home_sid = _get_or_create_schedule_id(cand["branch_id"], y, m, user["id"])
        q("""INSERT INTO scheduling.schedule_entries
             (schedule_id,staff_id,date,shift_code,cross_branch_id,is_oncall,note)
             VALUES (%s,%s,%s,%s,%s,false,%s)
             ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET
             shift_code=EXCLUDED.shift_code, cross_branch_id=EXCLUDED.cross_branch_id,
             note=EXCLUDED.note""",
          (home_sid, cand["id"], date, code, cross,
           f"covering {lv['staff_name']} (SL)"), exec_only=True)
        placed = True
    shift = code or "shift"
    msg = (f"You're covering the {shift} shift at {lv['branch_name']} on {date} — "
           f"{lv['staff_name']} is on sick leave." if placed else
           f"Cover request: please cover the {shift} shift at {lv['branch_name']} on "
           f"{date} — {lv['staff_name']} is on sick leave.")
    notify_staff_member(cand["id"], msg, link="myschedule", ntype="info")
    insert_audit(user, "COVER_REQUEST", lv["staff_name"],
                 f"{'assigned' if placed else 'asked'} {cand['name']} ({shift}) for {date}")
    return {"ok": True, "asked": cand["name"], "assigned": placed, "shift": code}

# ── Cross-branch cover (manager assigns a floater from another branch) ─────────
@app.get("/api/cover-candidates")
def cover_candidates_for_branch(request: Request, user=Depends(require_reviewer)):
    """Free staff from OTHER branches who could cover a day at `branch_id`.
    Manager/superadmin only. Ranked by lightest monthly load. Optional `section`
    ('General'/'US') filters to the matching section."""
    qp = request.query_params
    try:
        branch_id = int(qp.get("branch_id"))
    except (TypeError, ValueError):
        raise HTTPException(400, "branch_id required")
    date = qp.get("date") or ""
    if not _valid_iso_date(date):
        raise HTTPException(400, "date required (YYYY-MM-DD)")
    want = _section_of([qp.get("section")]) if qp.get("section") else None
    y, m = int(date[:4]), int(date[5:7])
    rows = q("""
        SELECT s.id, s.name, s.branch_id, s.speciality, b.name AS branch_name,
               e.shift_code AS shift_today,
               (SELECT COUNT(*) FROM scheduling.schedule_entries e2
                  JOIN scheduling.schedules sc2 ON sc2.id=e2.schedule_id
                 WHERE e2.staff_id=s.id AND sc2.year=%s AND sc2.month=%s
                   AND e2.shift_code NOT IN ('O','AL','SL','TB')) AS shifts_month
        FROM scheduling.staff s
        LEFT JOIN scheduling.branches b ON b.id=s.branch_id
        LEFT JOIN scheduling.schedules sc ON sc.branch_id=s.branch_id AND sc.year=%s AND sc.month=%s
        LEFT JOIN scheduling.schedule_entries e ON e.schedule_id=sc.id AND e.staff_id=s.id AND e.date=%s
        WHERE s.active=true AND s.branch_id<>%s
    """, (y, m, y, m, date, branch_id))
    cands = []
    for r in rows:
        if want and _section_of(r["speciality"]) != want:
            continue
        shift = r["shift_today"]
        if shift in ("AL", "SL", "TB"):           # already off / on leave
            continue
        if shift is not None and shift != "O":     # already working a shift that day
            continue
        cands.append({
            "staff_id": r["id"], "name": r["name"], "branch_name": r["branch_name"],
            "section": _section_of(r["speciality"]),
            "shifts_month": int(r["shifts_month"] or 0),
        })
    cands.sort(key=lambda c: (c["shifts_month"], c["name"]))
    return {"date": date, "section": want, "candidates": cands}

@app.post("/api/schedules/{sid}/cover")
async def add_cross_branch_cover(sid: int, request: Request, user=Depends(require_reviewer)):
    """Cover a day at THIS branch with a staff member from ANOTHER branch.
    Manager/superadmin only. The cover shift is written on the VISITOR'S OWN rota
    (their home schedule) with cross_branch_id pointing here — so their home
    sheet shows e.g. 'Y3' that day, and this host rota shows them as a visitor.
    One entry, so the person's shift count never double-counts."""
    body = await request.json()
    sched = assert_schedule_access(user, sid)
    staff_id = body.get("staff_id")
    date = body.get("date") or ""
    code = body.get("shift_code") or "M"
    visitor = q("SELECT id, name, branch_id FROM scheduling.staff WHERE id=%s AND active=true",
                (staff_id,), one=True)
    if not visitor:
        raise HTTPException(404, "Staff member not found")
    if visitor["branch_id"] == sched["branch_id"]:
        raise HTTPException(400, "That staff member already belongs to this branch")
    try:
        y, m = int(date[:4]), int(date[5:7])
    except Exception:
        raise HTTPException(400, "Invalid date")
    if y != sched["year"] or m != sched["month"]:
        raise HTTPException(400, "Date is outside this schedule's month")
    codes = {r["code"] for r in q("SELECT code FROM scheduling.shift_types")}
    codes.add("O")
    if code not in codes:
        raise HTTPException(400, f"Unknown shift code: {code}")
    home_sid = _get_or_create_schedule_id(visitor["branch_id"], y, m, user["id"])
    row = q("""INSERT INTO scheduling.schedule_entries
               (schedule_id,staff_id,date,shift_code,cross_branch_id,is_oncall,note)
               VALUES (%s,%s,%s,%s,%s,false,%s)
               ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET
               shift_code=EXCLUDED.shift_code, cross_branch_id=EXCLUDED.cross_branch_id
               RETURNING id,schedule_id,staff_id,TO_CHAR(date,'YYYY-MM-DD') AS date,
                         shift_code,cross_branch_id,is_oncall,note""",
            (home_sid, visitor["id"], date, code, sched["branch_id"], "cover"), one=True)
    # Let the visitor know they're covering elsewhere.
    host = q("SELECT name FROM scheduling.branches WHERE id=%s", (sched["branch_id"],), one=True) or {}
    host_name = host.get("name", "another branch")
    notify_staff_member(visitor["id"],
                        f"You're scheduled to cover the {code} shift at {host_name} on {date}.",
                        link="myschedule", ntype="info")
    insert_audit(user, "CROSS_BRANCH_COVER", visitor["name"], f"{code} @ {host_name} on {date}")
    return row

@app.delete("/api/schedules/{sid}/cover")
def remove_cross_branch_cover(sid: int, staff_id: int, date: str, user=Depends(require_reviewer)):
    """Remove a cross-branch cover (manager/superadmin only). The cover lives on
    the visitor's own rota pointing here, so clear it there."""
    sched = assert_schedule_access(user, sid)
    q("""DELETE FROM scheduling.schedule_entries e
         USING scheduling.schedules sc
         WHERE e.schedule_id=sc.id AND e.staff_id=%s AND e.date=%s
           AND e.cross_branch_id=%s""",
      (staff_id, date, sched["branch_id"]), exec_only=True)
    insert_audit(user, "CROSS_BRANCH_COVER_REMOVE", str(staff_id), f"branch {sched['branch_id']} on {date}")
    return {"ok": True}

_OFF_CODES = {"O", "AL", "SL", "TB"}   # not a worked shift

def _is_work_code(c):
    return bool(c) and c not in _OFF_CODES and c != "OC"

@app.post("/api/schedules/{sid}/autofill-cross-cover")
async def autofill_cross_cover(sid: int, request: Request, user=Depends(require_reviewer)):
    """Fill a branch's rota by RELOCATING surplus ("overlap") staff from same-city
    sharing branches. We only move someone who is already WORKING that day at a
    branch that has more staff than its minimum coverage — so we never touch a
    rest day and never drop a donor branch below its minimum. The relocated shift
    moves to this branch (the person's total shift count is unchanged)."""
    body = await request.json()
    sched = assert_can_edit_schedule(user, sid)   # reviewer may edit even if locked
    y, m = sched["year"], sched["month"]
    target = q("SELECT id,name,city FROM scheduling.branches WHERE id=%s", (sched["branch_id"],), one=True)
    shift_code = (body.get("shift_code") or "Y3").strip()
    per_day  = max(1, int(body.get("per_day") or 1))
    skip_fri = body.get("skip_fridays", True)
    want_section = body.get("section") or None
    do_lock = bool(body.get("lock", False))

    codes = {r["code"] for r in q("SELECT code FROM scheduling.shift_types")}; codes.add("O")
    if shift_code not in codes:
        raise HTTPException(400, f"Unknown shift code: {shift_code}")

    # Donor branches: opted into sharing, same city (when the target has one), not self.
    donors = q("""SELECT id,name FROM scheduling.branches
                  WHERE shares_staff=true AND id<>%s
                    AND (%s::text IS NULL OR city IS NOT DISTINCT FROM %s)""",
               (target["id"], target.get("city"), target.get("city")))
    if not donors:
        return {"filled": 0, "assigned": [], "shortfalls": [],
                "detail": "No same-city branches are sharing staff."}
    donor_ids = [d["id"] for d in donors]

    dstaff = q("""SELECT id,name,branch_id,speciality FROM scheduling.staff
                  WHERE active=true AND branch_id = ANY(%s)""", (donor_ids,))
    sec_of = {s["id"]: _section_of(s["speciality"]) for s in dstaff}
    name_of = {s["id"]: s["name"] for s in dstaff}

    # Donor entries this month — used to find each person's shift per day and to
    # count how many are working each section/day (to detect surplus).
    dent = q("""SELECT e.id, e.staff_id, sc.branch_id,
                       TO_CHAR(e.date,'YYYY-MM-DD') AS date, e.shift_code, e.cross_branch_id
                FROM scheduling.schedule_entries e
                JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                WHERE sc.branch_id = ANY(%s) AND sc.year=%s AND sc.month=%s""", (donor_ids, y, m))
    shift_at = {}            # (staff_id, date) -> entry row
    work_mn = {}             # (branch_id, section, date, 'M'|'N') -> count of own workers
    already_lent = set()     # (staff_id, date) already covering elsewhere
    for e in dent:
        shift_at[(e["staff_id"], e["date"])] = e
        if e["cross_branch_id"]:
            already_lent.add((e["staff_id"], e["date"]))
        elif e["shift_code"] in ("M", "N"):
            sec = sec_of.get(e["staff_id"], "General")
            k = (e["branch_id"], sec, e["date"], e["shift_code"])
            work_mn[k] = work_mn.get(k, 0) + 1

    # Minimum coverage PER SHIFT (min_m / min_n) per donor branch + section, so we
    # never pull the last morning (or night) and leave that shift uncovered.
    minM, minN = {}, {}
    for d in donors:
        nest = branch_to_nest(d["name"])
        if not nest:
            continue
        for r in q("""SELECT ns.section_name,
                             COALESCE(sms.min_m,1) AS mm, COALESCE(sms.min_n,1) AS mn
                      FROM scheduling.nest_sections ns
                      LEFT JOIN scheduling.section_month_settings sms
                             ON sms.section_id=ns.id AND sms.year=%s AND sms.month=%s
                      WHERE ns.nest_key=%s""", (y, m, nest)):
            sec2 = _section_of([r["section_name"]])
            minM[(d["id"], sec2)] = int(r["mm"])
            minN[(d["id"], sec2)] = int(r["mn"])

    def shift_surplus(bid_s, sec, date, code):
        """How many of this person's shift the donor has to SPARE that day.
        A non-M/N work code doesn't count toward M/N coverage, so it's always
        spare. M/N must stay at or above their own minimum."""
        if code == "M":
            return work_mn.get((bid_s, sec, date, "M"), 0) - minM.get((bid_s, sec), 1)
        if code == "N":
            return work_mn.get((bid_s, sec, date, "N"), 0) - minN.get((bid_s, sec), 1)
        return 99   # other work shift — removing it can't break morning/night cover

    # How many workers the target already has each day: its own staff PLUS staff
    # from other branches already covering here (so a re-run doesn't double-fill).
    y3_count = {}
    for e in q("SELECT TO_CHAR(date,'YYYY-MM-DD') AS date, shift_code FROM scheduling.schedule_entries WHERE schedule_id=%s", (sid,)):
        if _is_work_code(e["shift_code"]):
            y3_count[e["date"]] = y3_count.get(e["date"], 0) + 1
    for e in q("""SELECT TO_CHAR(e.date,'YYYY-MM-DD') AS date, e.shift_code
                  FROM scheduling.schedule_entries e
                  JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                  WHERE e.cross_branch_id=%s AND sc.year=%s AND sc.month=%s""", (target["id"], y, m)):
        if _is_work_code(e["shift_code"]):
            y3_count[e["date"]] = y3_count.get(e["date"], 0) + 1

    borrow_load = {}   # staff_id -> times borrowed this run (spread it around)
    n_days = _cal.monthrange(y, m)[1]
    assigned, shortfalls = [], []

    for day in range(1, n_days + 1):
        if skip_fri and _cal.weekday(y, m, day) == 4:    # Friday: branch closed
            continue
        date = f"{y}-{m:02d}-{day:02d}"
        need = per_day - y3_count.get(date, 0)
        if need <= 0:
            continue
        # Surplus workers available to lend on this day.
        pool = []
        for s in dstaff:
            sd, bid_s = s["id"], s["branch_id"]
            sec = sec_of[sd]
            if want_section and sec != want_section:
                continue
            if (sd, date) in already_lent:
                continue
            ent = shift_at.get((sd, date))
            if not ent or not _is_work_code(ent["shift_code"]):   # resting / unscheduled
                continue
            # Only lend if THIS person's specific shift (M/N) is over its own
            # minimum — so taking a morning never leaves the donor without one.
            surplus = shift_surplus(bid_s, sec, date, ent["shift_code"])
            if surplus <= 0:
                continue
            pool.append((borrow_load.get(sd, 0), -surplus, s["name"], sd, bid_s, sec, ent))
        pool.sort()
        for _, _, _, sd, bid_s, sec, ent in pool:
            if need <= 0:
                break
            if shift_surplus(bid_s, sec, date, ent["shift_code"]) <= 0:
                continue   # this shift's surplus got used up earlier this day
            # Relocate IN PLACE: rewrite the donor's own cell to the cover shift
            # pointing at the target. Their home sheet now shows e.g. 'Y3' that
            # day; the target rota shows them as a visitor. One entry, so their
            # total shift count is unchanged.
            q("""UPDATE scheduling.schedule_entries
                 SET shift_code=%s, cross_branch_id=%s, note=%s WHERE id=%s""",
              (shift_code, target["id"], f"cover (was {ent['shift_code']} @ home)", ent["id"]),
              exec_only=True)
            if ent["shift_code"] in ("M", "N"):   # that shift now has one fewer
                k = (bid_s, sec, date, ent["shift_code"])
                work_mn[k] = work_mn.get(k, 0) - 1
            already_lent.add((sd, date))
            borrow_load[sd] = borrow_load.get(sd, 0) + 1
            assigned.append({"staff": name_of.get(sd, sd), "date": date})
            need -= 1
        if need > 0:
            shortfalls.append({"date": date, "missing": need})

    if do_lock and assigned:
        q("UPDATE scheduling.schedules SET is_locked=true WHERE id=%s", (sid,), exec_only=True)
    insert_audit(user, "AUTOFILL_CROSS_COVER", target["name"],
                 f"{len(assigned)} placed, {len(shortfalls)} short days")
    return {"filled": len(assigned), "assigned": assigned, "shortfalls": shortfalls,
            "donors": [d["name"] for d in donors]}

# ── Time-back / compensation claims ───────────────────────────────────────────
_TB_REASONS = ("covered", "offday", "extra", "oncall")

def _tb_balance(staff_id):
    cr = q("SELECT COALESCE(SUM(days),0) AS c FROM scheduling.timeback_claims WHERE staff_id=%s AND status='approved'",
           (staff_id,), one=True)
    db = q("SELECT COUNT(*) AS c FROM scheduling.leave_requests WHERE staff_id=%s AND leave_type='TB' AND status='approved'",
           (staff_id,), one=True)
    return float(cr["c"] or 0) - float(db["c"] or 0)

@app.get("/api/timeback")
def list_timeback(request: Request, user=Depends(get_current_user)):
    """Time-back claims, scoped: staff see their own, a team lead their branch,
    a reviewer all."""
    conds, vals = ["1=1"], []
    if user["role"] == "staff":
        conds.append("t.staff_id=%s"); vals.append(user.get("staff_id"))
    elif user["role"] == "admin":
        bid = user.get("branch_id")
        if not bid: raise HTTPException(403, "No branch assigned to this account")
        conds.append("s.branch_id=%s"); vals.append(bid)
    elif user["role"] not in ("manager", "superadmin"):
        raise HTTPException(403, "Forbidden")
    rows = q(f"""SELECT t.id,t.staff_id,TO_CHAR(t.date,'YYYY-MM-DD') AS date,t.reason,t.days,
                        t.note,t.status,t.created_at, s.name AS staff_name,
                        s.branch_id, b.name AS branch_name
                 FROM scheduling.timeback_claims t
                 JOIN scheduling.staff s ON s.id=t.staff_id
                 LEFT JOIN scheduling.branches b ON b.id=s.branch_id
                 WHERE {' AND '.join(conds)} ORDER BY t.created_at DESC""", vals)
    return rows

@app.get("/api/timeback/balance")
def timeback_balance(request: Request, user=Depends(get_current_user)):
    sid = request.query_params.get("staff_id") or user.get("staff_id")
    if not sid:
        raise HTTPException(400, "staff_id required")
    sid = _int_or_400(sid)
    st = q("SELECT branch_id FROM scheduling.staff WHERE id=%s", (sid,), one=True)
    if not st:
        raise HTTPException(404, "Staff not found")
    # Default-deny: staff may only see their own; every other role must have
    # access to the target's branch. Previously only "staff" and "admin" were
    # checked, so a branch-locked "viewer" could read any staffer's balance.
    if user["role"] == "staff":
        if user.get("staff_id") != sid:
            raise HTTPException(403, "Forbidden")
    elif not can_access_branch(user, st["branch_id"]):
        raise HTTPException(403, "Forbidden")
    return {"staff_id": sid, "balance": _tb_balance(sid)}

@app.post("/api/timeback")
async def create_timeback(request: Request, user=Depends(get_current_user)):
    body = await request.json()
    staff_id = user.get("staff_id") if user["role"] == "staff" else body.get("staff_id")
    date = body.get("date")
    reason = body.get("reason") if body.get("reason") in _TB_REASONS else "covered"
    note = body.get("note")
    if user["role"] == "viewer" or (user["role"] != "staff" and not staff_id):
        raise HTTPException(403 if user["role"] == "viewer" else 400, "staff_id required")
    if not staff_id or not date:
        raise HTTPException(400, "staff_id and date are required")
    st = q("SELECT branch_id, name FROM scheduling.staff WHERE id=%s", (staff_id,), one=True)
    if not st:
        raise HTTPException(404, "Staff not found")
    if user["role"] != "staff" and not can_access_branch(user, st["branch_id"]):
        raise HTTPException(403, "Forbidden")
    # Same two-stage chain as leave: staff -> lead -> manager.
    if user["role"] in ("superadmin", "manager"):
        status = "approved"
    elif user["role"] == "admin":
        status = LEAVE_AWAIT_MANAGER
    else:
        status = LEAVE_AWAIT_LEAD
    row = q("""INSERT INTO scheduling.timeback_claims (staff_id,date,reason,note,status,created_by)
               VALUES (%s,%s,%s,%s,%s,%s)
               RETURNING id,staff_id,TO_CHAR(date,'YYYY-MM-DD') AS date,reason,days,note,status""",
            (staff_id, date, reason, note, status, user["id"]), one=True)
    if status == LEAVE_AWAIT_LEAD:
        leads = q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s", (st["branch_id"],))
        msg = f"{st['name']}: time-back claim awaiting your approval"
        for u in (leads or []):
            notify(u["id"], msg, link="leaves", ntype="info")
        if not leads:
            notify_roles(("manager", "superadmin"), msg, link="leaves", ntype="info")
    elif status == LEAVE_AWAIT_MANAGER:
        notify_roles(("manager", "superadmin"), f"{st['name']}: time-back claim awaiting final approval",
                     link="leaves", ntype="info")
    return row

@app.put("/api/timeback/{tid}/status")
async def update_timeback_status(tid: int, request: Request, user=Depends(require_admin)):
    """Two-stage approval (team lead -> manager), same rules as leave."""
    body = await request.json()
    requested = body.get("status")
    t = q("""SELECT t.created_by, t.staff_id, t.status, TO_CHAR(t.date,'YYYY-MM-DD') AS date,
                    s.name AS staff_name, s.branch_id
             FROM scheduling.timeback_claims t JOIN scheduling.staff s ON s.id=t.staff_id
             WHERE t.id=%s""", (tid,), one=True)
    if not t:
        raise HTTPException(404, "Claim not found")
    if not can_access_branch(user, t["branch_id"]):
        raise HTTPException(403, "Forbidden")
    new_status = _leave_decide(user, t["status"], requested)
    # Guard on the status we just read so two concurrent reviewers can't both
    # apply a transition (double audit rows / double notifications).
    row = q("""UPDATE scheduling.timeback_claims SET status=%s, reviewed_by=%s, reviewed_at=NOW()
               WHERE id=%s AND status=%s RETURNING id,status""",
            (new_status, user["id"], tid, t["status"]), one=True)
    if not row:
        raise HTTPException(409, "Claim was already updated by someone else")
    insert_audit(user, f"TIMEBACK_{new_status.upper()}", f"claim:{tid}", t["staff_name"])
    notify_staff_member(t["staff_id"], f"Your time-back claim ({t['date']}) was {new_status.replace('_',' ')}",
                        link="leaves", ntype=new_status if new_status in ("approved", "rejected") else "info")
    return row

@app.delete("/api/timeback/{tid}")
def delete_timeback(tid: int, user=Depends(get_current_user)):
    t = q("""SELECT t.staff_id, t.status, s.branch_id FROM scheduling.timeback_claims t
             JOIN scheduling.staff s ON s.id=t.staff_id WHERE t.id=%s""", (tid,), one=True)
    if not t:
        raise HTTPException(404, "Claim not found")
    if user["role"] == "staff":
        if t["staff_id"] != user.get("staff_id") or t["status"] != "pending":
            raise HTTPException(403, "Only your own pending claim can be withdrawn")
    elif user["role"] in ("admin", "manager", "superadmin"):
        if not can_access_branch(user, t["branch_id"]):
            raise HTTPException(403, "Forbidden")
    else:
        raise HTTPException(403, "Forbidden")
    q("DELETE FROM scheduling.timeback_claims WHERE id=%s", (tid,), exec_only=True)
    return {"ok": True}

# ── Support tickets ───────────────────────────────────────────────────────────
# A staff member raises a ticket (issue / fault / request); a team lead or manager
# picks it up, escalates it, and marks the action taken. The creator is notified
# on every status change, and either side can post replies on the ticket thread.

_TICKET_CATEGORIES = ("device_fault", "pacs", "ovr", "report_blocked", "stock",
                      "request", "issue", "fault", "other")
_TICKET_PRIORITIES = ("low", "normal", "high")
_TICKET_STATUSES   = ("open", "escalated", "in_progress", "resolved", "closed")
_TICKET_ACTIVE     = ("open", "escalated", "in_progress")   # still needs attention

def _ticket_can_manage(user, branch_id):
    """Who can change a ticket's status: a reviewer (any branch) or the team lead
    of the ticket's branch."""
    if user["role"] in ("manager", "superadmin"):
        return True
    if user["role"] == "admin":
        return can_access_branch(user, branch_id)
    return False

def _ticket_can_view(user, t):
    if user["role"] in ("manager", "superadmin"):
        return True
    if t["created_by"] == user["id"]:
        return True
    if user["role"] == "admin":
        return can_access_branch(user, t.get("branch_id"))
    return False

def _notify_ticket_managers(branch_id, message):
    """Alert the people who can act on a ticket: its branch lead(s) + reviewers."""
    notified = set()
    if branch_id:
        for u in q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s", (branch_id,)):
            notify(u["id"], message, link="tickets", ntype="ticket"); notified.add(u["id"])
    for u in q("SELECT id FROM scheduling.users WHERE role = ANY(%s)", (["manager", "superadmin"],)):
        if u["id"] not in notified:
            notify(u["id"], message, link="tickets", ntype="ticket")

@app.get("/api/tickets")
def list_tickets(request: Request, user=Depends(get_current_user)):
    """Tickets, scoped: a staff member sees their own; a team lead their branch
    (plus any they raised); a reviewer sees all. Optional ?status=active|<status>."""
    p = request.query_params
    conds, vals = ["1=1"], []
    role = user["role"]
    if role in ("manager", "superadmin"):
        pass
    elif role == "admin":
        conds.append("(t.branch_id=%s OR t.created_by=%s)"); vals += [user.get("branch_id"), user["id"]]
    else:
        conds.append("t.created_by=%s"); vals.append(user["id"])
    status = (p.get("status") or "").strip()
    if status == "active":
        conds.append("t.status = ANY(%s)"); vals.append(list(_TICKET_ACTIVE))
    elif status in _TICKET_STATUSES:
        conds.append("t.status=%s"); vals.append(status)
    category = (p.get("category") or "").strip()
    if category in _TICKET_CATEGORIES:
        conds.append("t.category=%s"); vals.append(category)
    rows = q(f"""SELECT t.id,t.category,t.priority,t.subject,t.status,t.branch_id,
                        TO_CHAR(t.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
                        TO_CHAR(t.updated_at,'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at,
                        b.name AS branch_name, cu.username AS created_by_name,
                        COALESCE(s.name, cu.username) AS staff_name,
                        (SELECT COUNT(*) FROM scheduling.ticket_updates tu WHERE tu.ticket_id=t.id) AS updates
                 FROM scheduling.tickets t
                 LEFT JOIN scheduling.branches b ON b.id=t.branch_id
                 LEFT JOIN scheduling.users cu ON cu.id=t.created_by
                 LEFT JOIN scheduling.staff s ON s.id=t.staff_id
                 WHERE {' AND '.join(conds)}
                 ORDER BY (t.status = ANY(%s)) DESC, t.updated_at DESC""",
             vals + [list(_TICKET_ACTIVE)])
    return rows

@app.get("/api/tickets/{tid}")
def get_ticket(tid: int, user=Depends(get_current_user)):
    t = q("""SELECT t.id,t.created_by,t.staff_id,t.branch_id,t.category,t.priority,
                    t.subject,t.description,t.status,t.handled_by,t.resolution,
                    TO_CHAR(t.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
                    TO_CHAR(t.updated_at,'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at,
                    b.name AS branch_name, cu.username AS created_by_name,
                    hu.username AS handled_by_name,
                    COALESCE(s.name, cu.username) AS staff_name
             FROM scheduling.tickets t
             LEFT JOIN scheduling.branches b ON b.id=t.branch_id
             LEFT JOIN scheduling.users cu ON cu.id=t.created_by
             LEFT JOIN scheduling.users hu ON hu.id=t.handled_by
             LEFT JOIN scheduling.staff s ON s.id=t.staff_id
             WHERE t.id=%s""", (tid,), one=True)
    if not t:
        raise HTTPException(404, "Ticket not found")
    if not _ticket_can_view(user, t):
        raise HTTPException(403, "Forbidden")
    t["updates"] = q("""SELECT tu.id, tu.body, tu.is_status_change, u.username AS author,
                               TO_CHAR(tu.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
                        FROM scheduling.ticket_updates tu
                        LEFT JOIN scheduling.users u ON u.id=tu.user_id
                        WHERE tu.ticket_id=%s ORDER BY tu.created_at ASC""", (tid,))
    t["can_manage"] = _ticket_can_manage(user, t.get("branch_id"))
    return t

@app.post("/api/tickets")
async def create_ticket(request: Request, user=Depends(get_current_user)):
    body = await request.json()
    subject = (body.get("subject") or "").strip()
    if not subject:
        raise HTTPException(400, "A subject is required")
    subject = subject[:200]
    description = (body.get("description") or "").strip()[:4000] or None
    category = body.get("category") if body.get("category") in _TICKET_CATEGORIES else "issue"
    priority = body.get("priority") if body.get("priority") in _TICKET_PRIORITIES else "normal"
    staff_id = user.get("staff_id")
    branch_id = None
    if staff_id:
        st = q("SELECT branch_id FROM scheduling.staff WHERE id=%s", (staff_id,), one=True)
        branch_id = st["branch_id"] if st else None
    if branch_id is None:
        branch_id = user.get("branch_id")
    row = q("""INSERT INTO scheduling.tickets
                  (created_by,staff_id,branch_id,category,priority,subject,description)
               VALUES (%s,%s,%s,%s,%s,%s,%s)
               RETURNING id,status,subject,category,priority""",
            (user["id"], staff_id, branch_id, category, priority, subject, description), one=True)
    insert_audit(user, "TICKET_CREATE", f"ticket:{row['id']}", subject)
    _notify_ticket_managers(branch_id, f"New {category} ticket from {user.get('username') or 'a staff member'}: {subject}")
    return row

@app.put("/api/tickets/{tid}/status")
async def update_ticket_status(tid: int, request: Request, user=Depends(get_current_user)):
    body = await request.json()
    new_status = body.get("status")
    if new_status not in _TICKET_STATUSES:
        raise HTTPException(400, "Invalid status")
    t = q("SELECT id,created_by,branch_id,subject,status FROM scheduling.tickets WHERE id=%s", (tid,), one=True)
    if not t:
        raise HTTPException(404, "Ticket not found")
    if not _ticket_can_manage(user, t.get("branch_id")):
        raise HTTPException(403, "Only a team lead or manager can update a ticket")
    note = (body.get("note") or "").strip() or None
    resolution = (body.get("resolution") or "").strip() or None
    if new_status in ("resolved", "closed") and not resolution:
        resolution = note   # a closing note doubles as the resolution
    q("""UPDATE scheduling.tickets
            SET status=%s, handled_by=%s, resolution=COALESCE(%s, resolution), updated_at=NOW()
          WHERE id=%s""", (new_status, user["id"], resolution, tid), exec_only=True)
    label = new_status.replace("_", " ")
    thread = f"Status changed to “{label}”" + (f" — {note}" if note else "")
    q("""INSERT INTO scheduling.ticket_updates (ticket_id,user_id,body,is_status_change)
         VALUES (%s,%s,%s,true)""", (tid, user["id"], thread), exec_only=True)
    insert_audit(user, f"TICKET_{new_status.upper()}", f"ticket:{tid}", t["subject"])
    tail = f": {resolution}" if resolution and new_status in ("resolved", "closed") else ""
    notify(t["created_by"], f"Your ticket “{t['subject']}” is now {label}{tail}",
           link="tickets", ntype="ticket")
    return {"id": tid, "status": new_status}

@app.post("/api/tickets/{tid}/updates")
async def add_ticket_update(tid: int, request: Request, user=Depends(get_current_user)):
    body = await request.json()
    text = (body.get("body") or "").strip()
    if not text:
        raise HTTPException(400, "Message is required")
    text = text[:2000]
    t = q("SELECT id,created_by,branch_id,subject FROM scheduling.tickets WHERE id=%s", (tid,), one=True)
    if not t:
        raise HTTPException(404, "Ticket not found")
    can_manage = _ticket_can_manage(user, t.get("branch_id"))
    is_creator = (t["created_by"] == user["id"])
    if not (can_manage or is_creator):
        raise HTTPException(403, "Forbidden")
    q("INSERT INTO scheduling.ticket_updates (ticket_id,user_id,body) VALUES (%s,%s,%s)",
      (tid, user["id"], text), exec_only=True)
    q("UPDATE scheduling.tickets SET updated_at=NOW() WHERE id=%s", (tid,), exec_only=True)
    who = user.get("username") or "Someone"
    if is_creator and not can_manage:
        _notify_ticket_managers(t.get("branch_id"), f"New reply on ticket “{t['subject']}” from {who}")
    elif t["created_by"] != user["id"]:
        notify(t["created_by"], f"New reply on your ticket “{t['subject']}” from {who}",
               link="tickets", ntype="ticket")
    return {"ok": True}

@app.delete("/api/tickets/{tid}")
def delete_ticket(tid: int, user=Depends(get_current_user)):
    t = q("SELECT id,created_by,branch_id,status,subject FROM scheduling.tickets WHERE id=%s", (tid,), one=True)
    if not t:
        raise HTTPException(404, "Ticket not found")
    if user["role"] in ("manager", "superadmin"):
        pass
    elif user["role"] == "admin" and can_access_branch(user, t.get("branch_id")):
        pass
    elif t["created_by"] == user["id"] and t["status"] == "open":
        pass   # the creator can withdraw only while it's still untouched
    else:
        raise HTTPException(403, "You can't delete this ticket")
    q("DELETE FROM scheduling.tickets WHERE id=%s", (tid,), exec_only=True)
    insert_audit(user, "TICKET_DELETE", f"ticket:{tid}", t.get("subject"))
    return {"ok": True}

# ── Announcements / circulars ─────────────────────────────────────────────────
# A manager (or a team lead for their branch) posts a bulletin / circular. An
# "action_required" one asks staff to acknowledge it. Optionally broadcast over
# WhatsApp + email to every targeted staff member.

_ANN_KINDS = ("announcement", "action_required")

def _ann_can_post(user, audience, branch_id):
    if user["role"] in ("manager", "superadmin"):
        return True
    if user["role"] == "admin":   # a team lead posts to their own branch only
        return audience == "branch" and can_access_branch(user, branch_id)
    return False

def _ann_visible(user):
    """SQL condition + params limiting announcements to those targeting this user."""
    if user["role"] in ("manager", "superadmin"):
        return "1=1", []
    return "(a.audience='all' OR a.branch_id=%s)", [user.get("branch_id")]

@app.get("/api/announcements")
def list_announcements(user=Depends(get_current_user)):
    cond, vals = _ann_visible(user)
    rows = q(f"""SELECT a.id,a.title,a.body,a.kind,a.audience,a.branch_id,a.pinned,
                        TO_CHAR(a.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
                        b.name AS branch_name, cu.username AS created_by_name,
                        EXISTS(SELECT 1 FROM scheduling.announcement_acks k
                               WHERE k.announcement_id=a.id AND k.user_id=%s) AS acked,
                        (SELECT COUNT(*) FROM scheduling.announcement_acks k
                         WHERE k.announcement_id=a.id) AS ack_count
                 FROM scheduling.announcements a
                 LEFT JOIN scheduling.branches b ON b.id=a.branch_id
                 LEFT JOIN scheduling.users cu ON cu.id=a.created_by
                 WHERE {cond}
                 ORDER BY a.pinned DESC, a.created_at DESC""", [user["id"]] + vals)
    return rows

@app.post("/api/announcements")
async def create_announcement(request: Request, user=Depends(get_current_user)):
    body = await request.json()
    title = (body.get("title") or "").strip()[:200]
    text = (body.get("body") or "").strip()[:8000]
    if not title or not text:
        raise HTTPException(400, "Title and body are required")
    kind = body.get("kind") if body.get("kind") in _ANN_KINDS else "announcement"
    audience = "branch" if body.get("audience") == "branch" else "all"
    branch_id = None
    if audience == "branch":
        branch_id = _int_or_400(body.get("branch_id"), "branch_id") if body.get("branch_id") else user.get("branch_id")
        if not branch_id:
            raise HTTPException(400, "branch_id is required for a branch announcement")
    if not _ann_can_post(user, audience, branch_id):
        raise HTTPException(403, "You can't post this announcement")
    row = q("""INSERT INTO scheduling.announcements (title,body,kind,audience,branch_id,pinned,created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (title, text, kind, audience, branch_id, bool(body.get("pinned")), user["id"]), one=True)
    insert_audit(user, "ANNOUNCEMENT_CREATE", f"ann:{row['id']}", title)
    delivered = 0
    if body.get("broadcast"):
        tag = "Action required" if kind == "action_required" else "Announcement"
        msg = f"[{tag}] {title}\n\n{text}"
        staff = (q("SELECT id,name,phone,email FROM scheduling.staff WHERE branch_id=%s AND COALESCE(active,true)=true", (branch_id,))
                 if audience == "branch"
                 else q("SELECT id,name,phone,email FROM scheduling.staff WHERE COALESCE(active,true)=true"))
        delivered = _broadcast_to_staff(staff, msg, "announcements", "announcement")
    return {"id": row["id"], "broadcast": bool(body.get("broadcast")), "delivered": delivered}

@app.post("/api/announcements/{aid}/ack")
def ack_announcement(aid: int, user=Depends(get_current_user)):
    if not q("SELECT id FROM scheduling.announcements WHERE id=%s", (aid,), one=True):
        raise HTTPException(404, "Announcement not found")
    q("""INSERT INTO scheduling.announcement_acks (announcement_id,user_id) VALUES (%s,%s)
         ON CONFLICT DO NOTHING""", (aid, user["id"]), exec_only=True)
    return {"ok": True}

@app.get("/api/announcements/{aid}/acks")
def announcement_acks(aid: int, user=Depends(require_admin)):
    a = q("SELECT created_by,branch_id,audience FROM scheduling.announcements WHERE id=%s", (aid,), one=True)
    if not a:
        raise HTTPException(404, "Announcement not found")
    if user["role"] == "admin" and not (a["created_by"] == user["id"] or can_access_branch(user, a.get("branch_id"))):
        raise HTTPException(403, "Forbidden")
    acked = q("""SELECT u.id, u.username, TO_CHAR(k.acked_at,'YYYY-MM-DD"T"HH24:MI:SS') AS acked_at
                 FROM scheduling.announcement_acks k JOIN scheduling.users u ON u.id=k.user_id
                 WHERE k.announcement_id=%s ORDER BY k.acked_at""", (aid,))
    acked_ids = {r["id"] for r in acked}
    targets = _announcement_targets(a["audience"], a.get("branch_id"))
    pending = [{"username": t["username"]} for t in targets if t["id"] not in acked_ids]
    return {"acked": [{"username": r["username"], "acked_at": r["acked_at"]} for r in acked],
            "pending": pending, "ack_count": len(acked), "target_count": len(targets)}

def _announcement_targets(audience, branch_id):
    """Staff-role accounts expected to acknowledge a circular (its audience)."""
    if audience == "branch" and branch_id:
        return q("""SELECT u.id, u.username FROM scheduling.users u
                    JOIN scheduling.staff s ON s.id=u.staff_id
                    WHERE u.role='staff' AND s.branch_id=%s AND COALESCE(s.active,true)=true""", (branch_id,))
    return q("""SELECT u.id, u.username FROM scheduling.users u
                JOIN scheduling.staff s ON s.id=u.staff_id
                WHERE u.role='staff' AND COALESCE(s.active,true)=true""")

@app.post("/api/announcements/{aid}/remind")
def remind_announcement(aid: int, user=Depends(require_admin)):
    """Nudge the people who still haven't acknowledged an action-required circular."""
    a = q("SELECT id,title,branch_id,audience,created_by FROM scheduling.announcements WHERE id=%s", (aid,), one=True)
    if not a:
        raise HTTPException(404, "Announcement not found")
    if user["role"] == "admin" and not (a["created_by"] == user["id"] or can_access_branch(user, a.get("branch_id"))):
        raise HTTPException(403, "Forbidden")
    acked_ids = {r["user_id"] for r in q("SELECT user_id FROM scheduling.announcement_acks WHERE announcement_id=%s", (aid,))}
    n = 0
    for t in _announcement_targets(a["audience"], a.get("branch_id")):
        if t["id"] not in acked_ids:
            notify(t["id"], f"Reminder — please acknowledge: {a['title']}", link="announcements", ntype="reminder")
            n += 1
    return {"reminded": n}

@app.delete("/api/announcements/{aid}")
def delete_announcement(aid: int, user=Depends(get_current_user)):
    a = q("SELECT id,created_by,branch_id,title FROM scheduling.announcements WHERE id=%s", (aid,), one=True)
    if not a:
        raise HTTPException(404, "Announcement not found")
    allowed = (user["role"] in ("manager", "superadmin")
               or a["created_by"] == user["id"]
               or (user["role"] == "admin" and can_access_branch(user, a.get("branch_id"))))
    if not allowed:
        raise HTTPException(403, "Forbidden")
    q("DELETE FROM scheduling.announcements WHERE id=%s", (aid,), exec_only=True)
    insert_audit(user, "ANNOUNCEMENT_DELETE", f"ann:{aid}", a.get("title"))
    return {"ok": True}

# ── Employee of the month ─────────────────────────────────────────────────────
@app.get("/api/employee-of-month")
def get_eotm(user=Depends(get_current_user)):
    sid = get_setting("eotm_staff_id")
    st = None
    if sid and str(sid).isdigit():
        st = q("""SELECT s.id,s.name,s.name_ar,b.name AS branch_name
                  FROM scheduling.staff s LEFT JOIN scheduling.branches b ON b.id=s.branch_id
                  WHERE s.id=%s""", (int(sid),), one=True)
    return {"staff": st, "note": get_setting("eotm_note"), "period": get_setting("eotm_period")}

@app.put("/api/employee-of-month")
async def set_eotm(request: Request, user=Depends(require_reviewer)):
    body = await request.json()
    sid = body.get("staff_id")
    if sid in (None, "", 0, "0"):
        q("""DELETE FROM scheduling.app_settings
             WHERE key IN ('eotm_staff_id','eotm_note','eotm_period')""", exec_only=True)
        insert_audit(user, "EOTM_CLEAR")
        return {"ok": True, "staff": None}
    sid = _int_or_400(sid, "staff_id")
    st = q("SELECT id,name FROM scheduling.staff WHERE id=%s", (sid,), one=True)
    if not st:
        raise HTTPException(404, "Staff not found")
    def _set(k, v):
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES (%s,%s)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (k, v), exec_only=True)
    _set("eotm_staff_id", str(sid))
    _set("eotm_note", (body.get("note") or "").strip()[:300])
    _set("eotm_period", (body.get("period") or "").strip()[:20])
    insert_audit(user, "EOTM_SET", f"staff:{sid}", st["name"])
    return {"ok": True, "staff_id": sid}

# ── Per-shift equipment check ─────────────────────────────────────────────────
# Twice a day the staff on shift confirm the equipment check was done — once at
# the start of the morning shift (M) and once at the start of the night shift (N).
# The first person on a shift to confirm clears it for everyone else on that
# shift, and a reminder goes out if it isn't confirmed within 30 min of the start.

_SHIFT_CHECK_SHIFTS = ("M", "N")
_SHIFT_CHECK_LABELS = {"M": "Morning", "N": "Night"}

def _shift_check_start_hour(shift):
    key = "shift_check_m_hour" if shift == "M" else "shift_check_n_hour"
    try:
        return int(get_setting(key, "8" if shift == "M" else "20"))
    except (TypeError, ValueError):
        return 8 if shift == "M" else 20

def _shift_check_active_date(shift):
    """The date whose shift is currently 'live' in KSA. A night shift starts at
    20:00 and runs past midnight, so before 08:00 it still belongs to yesterday."""
    from datetime import datetime, timezone, timedelta
    ksa = datetime.now(timezone.utc) + timedelta(hours=3)
    if shift == "N" and ksa.hour < 8:
        ksa -= timedelta(days=1)
    return ksa.strftime("%Y-%m-%d")

def _on_shift(branch_id, staff_id, date, shift):
    return bool(q("""SELECT 1 FROM scheduling.schedule_entries e
                     JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                     WHERE sc.branch_id=%s AND e.staff_id=%s AND e.date=%s AND e.shift_code=%s""",
                  (branch_id, staff_id, date, shift), one=True))

def _can_confirm_shift_check(user, branch_id, date, shift):
    """A reviewer/team lead (their branch), or a staff member scheduled on that
    shift that day (or flagged can_report) may confirm the check."""
    role = user["role"]
    if role in ("superadmin", "manager"):
        return True
    if not can_access_branch(user, branch_id):
        return False
    if role == "admin":
        return True
    if role == "staff":
        sid = user.get("staff_id")
        st = q("SELECT can_report FROM scheduling.staff WHERE id=%s", (sid,), one=True)
        if st and st.get("can_report"):
            return True
        return _on_shift(branch_id, sid, date, shift)
    return False

def _shift_check_row(branch_id, date, shift):
    return q("""SELECT k.shift, TO_CHAR(k.confirmed_at,'YYYY-MM-DD"T"HH24:MI:SS') AS confirmed_at,
                       COALESCE(s.name, u.username) AS confirmed_by_name
                FROM scheduling.shift_checks k
                LEFT JOIN scheduling.users u ON u.id=k.confirmed_by
                LEFT JOIN scheduling.staff s ON s.id=k.confirmed_by_staff
                WHERE k.branch_id=%s AND k.date=%s AND k.shift=%s""",
             (branch_id, date, shift), one=True)

@app.get("/api/shift-checks")
def get_shift_checks(request: Request, user=Depends(get_current_user)):
    p = request.query_params
    branch_id = p.get("branch_id") or user.get("branch_id")
    date = p.get("date")
    if not branch_id or not date:
        raise HTTPException(400, "branch_id and date required")
    branch_id = _int_or_400(branch_id)
    if not can_access_branch(user, branch_id):
        raise HTTPException(403, "Forbidden")
    out = []
    for sh in _SHIFT_CHECK_SHIFTS:
        r = _shift_check_row(branch_id, date, sh)
        out.append({"shift": sh, "label": _SHIFT_CHECK_LABELS[sh], "done": bool(r),
                    "confirmed_by_name": r["confirmed_by_name"] if r else None,
                    "confirmed_at": r["confirmed_at"] if r else None,
                    "start_hour": _shift_check_start_hour(sh),
                    "can_confirm": _can_confirm_shift_check(user, branch_id, date, sh)})
    return {"branch_id": branch_id, "date": date, "checks": out}

@app.get("/api/shift-checks/mine")
def my_shift_checks(user=Depends(get_current_user)):
    """The check(s) the logged-in staff member is on the hook for right now."""
    sid = user.get("staff_id")
    if not sid:
        return {"checks": []}
    st = q("SELECT branch_id FROM scheduling.staff WHERE id=%s", (sid,), one=True)
    if not st or not st.get("branch_id"):
        return {"checks": []}
    branch_id = st["branch_id"]
    out = []
    for sh in _SHIFT_CHECK_SHIFTS:
        date = _shift_check_active_date(sh)
        if not _on_shift(branch_id, sid, date, sh):
            continue
        r = _shift_check_row(branch_id, date, sh)
        out.append({"shift": sh, "label": _SHIFT_CHECK_LABELS[sh], "date": date,
                    "branch_id": branch_id, "done": bool(r),
                    "confirmed_by_name": r["confirmed_by_name"] if r else None,
                    "confirmed_at": r["confirmed_at"] if r else None})
    return {"checks": out}

@app.get("/api/shift-checks/overview")
def shift_checks_overview(request: Request, user=Depends(get_current_user)):
    date = request.query_params.get("date")
    if not date:
        raise HTTPException(400, "date required")
    if user["role"] in ("superadmin", "manager"):
        branches = q("SELECT id,name FROM scheduling.branches ORDER BY name")
    else:
        branches = q("SELECT id,name FROM scheduling.branches WHERE id=%s", (user.get("branch_id"),))
    # One query for every confirmation on this date, then map in memory (avoids a
    # per-branch/per-shift round-trip).
    rows = q("""SELECT k.branch_id, k.shift,
                       TO_CHAR(k.confirmed_at,'YYYY-MM-DD"T"HH24:MI:SS') AS confirmed_at,
                       COALESCE(s.name, u.username) AS confirmed_by_name
                FROM scheduling.shift_checks k
                LEFT JOIN scheduling.users u ON u.id=k.confirmed_by
                LEFT JOIN scheduling.staff s ON s.id=k.confirmed_by_staff
                WHERE k.date=%s""", (date,))
    by = {(r["branch_id"], r["shift"]): r for r in rows}
    out = []
    for b in branches:
        checks = []
        for sh in _SHIFT_CHECK_SHIFTS:
            r = by.get((b["id"], sh))
            checks.append({"shift": sh, "label": _SHIFT_CHECK_LABELS[sh], "done": bool(r),
                           "confirmed_by_name": r["confirmed_by_name"] if r else None,
                           "confirmed_at": r["confirmed_at"] if r else None})
        out.append({"branch_id": b["id"], "branch_name": b["name"], "checks": checks})
    return {"date": date, "branches": out}

@app.post("/api/shift-checks")
async def confirm_shift_check(request: Request, user=Depends(get_current_user)):
    body = await request.json()
    branch_id = body.get("branch_id") or user.get("branch_id")
    date = body.get("date")
    shift = body.get("shift")
    if not branch_id or not date or shift not in _SHIFT_CHECK_SHIFTS:
        raise HTTPException(400, "branch_id, date and a valid shift are required")
    branch_id = _int_or_400(branch_id)
    if not _can_confirm_shift_check(user, branch_id, date, shift):
        raise HTTPException(403, "You're not on this shift")
    note = (body.get("note") or "").strip()[:300] or None
    # Idempotent: the first confirmer wins; a second tap is a no-op (still "done").
    created = q("""INSERT INTO scheduling.shift_checks
                      (branch_id,date,shift,confirmed_by,confirmed_by_staff,note)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (branch_id,date,shift) DO NOTHING
                   RETURNING id""",
                (branch_id, date, shift, user["id"], user.get("staff_id"), note), one=True)
    if created:
        insert_audit(user, "SHIFT_CHECK_CONFIRM", f"branch:{branch_id}", f"{date} {shift}")
        notify_branch_leads(branch_id,
                            f"{_SHIFT_CHECK_LABELS[shift]} equipment check confirmed by {user.get('username') or 'staff'}",
                            link="cases", ntype="info")
    r = _shift_check_row(branch_id, date, shift)
    return {"ok": True, "shift": shift, "done": True,
            "confirmed_by_name": r["confirmed_by_name"] if r else user.get("username"),
            "confirmed_at": r["confirmed_at"] if r else None}

@app.put("/api/shift-checks/reopen")
async def reopen_shift_check(request: Request, user=Depends(get_current_user)):
    body = await request.json()
    branch_id, date, shift = body.get("branch_id"), body.get("date"), body.get("shift")
    if not branch_id or not date or shift not in _SHIFT_CHECK_SHIFTS:
        raise HTTPException(400, "branch_id, date and a valid shift are required")
    branch_id = _int_or_400(branch_id)
    # A reviewer (any branch) or the team lead of this branch can reopen.
    if user["role"] not in ("admin", "manager", "superadmin") or not can_access_branch(user, branch_id):
        raise HTTPException(403, "Forbidden")
    q("DELETE FROM scheduling.shift_checks WHERE branch_id=%s AND date=%s AND shift=%s",
      (branch_id, date, shift), exec_only=True)
    insert_audit(user, "SHIFT_CHECK_REOPEN", f"branch:{branch_id}", f"{date} {shift}")
    return {"ok": True}

def _shift_check_targets(branch_id, date, shift):
    """Logged-in staff on that shift + the branch lead(s)."""
    ids = set()
    for r in q("""SELECT u.id FROM scheduling.users u
                  JOIN scheduling.schedule_entries e ON e.staff_id=u.staff_id
                  JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                  WHERE u.role='staff' AND sc.branch_id=%s AND e.date=%s AND e.shift_code=%s""",
               (branch_id, date, shift)):
        ids.add(r["id"])
    for r in q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s", (branch_id,)):
        ids.add(r["id"])
    return ids

def _send_shift_check_reminders(date, shift):
    """Remind the staff on every branch that has someone on this shift but no
    confirmation yet. Returns the branch names reminded."""
    pending = q("""SELECT DISTINCT sc.branch_id AS branch_id, b.name AS name
                   FROM scheduling.schedule_entries e
                   JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                   JOIN scheduling.branches b ON b.id=sc.branch_id
                   WHERE e.date=%s AND e.shift_code=%s
                     AND NOT EXISTS (SELECT 1 FROM scheduling.shift_checks k
                                     WHERE k.branch_id=sc.branch_id AND k.date=%s AND k.shift=%s)""",
                (date, shift, date, shift))
    reminded = []
    for b in pending:
        targets = _shift_check_targets(b["branch_id"], date, shift)
        if not targets:
            continue
        label = _SHIFT_CHECK_LABELS[shift].lower()
        msg = (f"Reminder: please confirm the {label} equipment check for {b['name']} — "
               f"open the app and tap ✓ Done.")
        for uid in targets:
            notify(uid, msg, link="myschedule", ntype="reminder")
        reminded.append(b["name"])
    return reminded

def _shift_check_reminder_loop():
    """Once per shift, ~30 min after it starts, remind branches that still haven't
    confirmed the equipment check. Each (date,shift) is claimed atomically so
    exactly one worker sends."""
    import time
    from datetime import datetime, timezone, timedelta
    while True:
        try:
            ksa = datetime.now(timezone.utc) + timedelta(hours=3)
            for shift in _SHIFT_CHECK_SHIFTS:
                start = _shift_check_start_hour(shift)
                mins = (ksa.hour - start) * 60 + ksa.minute
                if 30 <= mins < 60:   # the half-hour grace window after the shift start
                    date = ksa.strftime("%Y-%m-%d")
                    claimed = q("""INSERT INTO scheduling.app_settings (key,value)
                                   VALUES (%s,%s) ON CONFLICT (key) DO NOTHING RETURNING key""",
                                (f"shiftchk_remind:{date}:{shift}", ksa.isoformat()), one=True)
                    if claimed:
                        names = _send_shift_check_reminders(date, shift)
                        if names:
                            print(f"[shift-check] {shift} reminded {len(names)} branch(es) for {date}")
        except Exception as e:
            print(f"[shift-check] {e}")
        time.sleep(300)

# ── Staff self-service portal ─────────────────────────────────────────────────

@app.get("/api/my-schedule")
def my_schedule(request: Request, user=Depends(get_current_user)):
    """The logged-in staff member's own row for a month (read-only)."""
    staff_id = user.get("staff_id")
    if not staff_id:
        raise HTTPException(403, "This account isn't linked to a staff member")
    from datetime import date as _date
    today = _date.today()
    p = request.query_params
    year  = int(p.get("year")  or today.year)
    month = int(p.get("month") or today.month)
    staff = q("""SELECT s.id,s.name,s.branch_id,b.name AS branch_name, s.leave_balance,
                        s.leave_balance_date,
                        TO_CHAR(s.join_date,'YYYY-MM-DD') AS join_date
                 FROM scheduling.staff s LEFT JOIN scheduling.branches b ON b.id=s.branch_id
                 WHERE s.id=%s""", (staff_id,), one=True)
    if not staff:
        raise HTTPException(404, "Staff record not found")
    # Live, accrued balance (22/yr) for display.
    staff["leave_balance"] = _live_leave_balance(staff_id, staff.get("leave_balance"), staff.get("leave_balance_date"))
    staff.pop("leave_balance_date", None)
    # Next approved leave (on/after today) so the portal can show a countdown.
    nxt = q("""SELECT TO_CHAR(MIN(date),'YYYY-MM-DD') AS d FROM scheduling.leave_requests
               WHERE staff_id=%s AND status='approved' AND leave_type IN ('AL','TB')
                 AND date >= %s""", (staff_id, today.isoformat()), one=True)
    upcoming = None
    if nxt and nxt.get("d"):
        from datetime import date as _d2
        d = _d2(*map(int, nxt["d"].split("-")))
        upcoming = {"date": nxt["d"], "days_until": (d - today).days}
    sched = q("""SELECT id,status,is_locked FROM scheduling.schedules
                 WHERE branch_id=%s AND year=%s AND month=%s""",
              (staff["branch_id"], year, month), one=True)
    entries = []
    if sched:
        entries = q("""SELECT TO_CHAR(e.date,'YYYY-MM-DD') AS date, e.shift_code, e.is_oncall,
                              b.name AS cross_branch_name
                       FROM scheduling.schedule_entries e
                       LEFT JOIN scheduling.branches b ON b.id=e.cross_branch_id
                       WHERE e.schedule_id=%s AND e.staff_id=%s ORDER BY e.date""",
                    (sched["id"], staff_id))
    # Cross-branch cover: days this person was placed onto ANOTHER branch's rota.
    # Surface them on their own calendar so they see where they're working.
    cover = q("""SELECT TO_CHAR(e.date,'YYYY-MM-DD') AS date, e.shift_code, e.is_oncall,
                        hb.name AS cover_at_branch
                 FROM scheduling.schedule_entries e
                 JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                 JOIN scheduling.branches hb ON hb.id=sc.branch_id
                 WHERE e.staff_id=%s AND sc.year=%s AND sc.month=%s AND sc.branch_id<>%s
                 ORDER BY e.date""",
              (staff_id, year, month, staff["branch_id"]))
    # A draft/returned rota isn't final yet — the UI flags that for the staff member.
    finalised = bool(sched) and sched.get("status") in ("submitted","reviewed","approved")
    return {"staff": staff, "year": year, "month": month,
            "status": (sched or {}).get("status"),
            "finalised": finalised, "entries": entries, "cover": cover,
            "upcoming_leave": upcoming, "leave_balance": staff.get("leave_balance")}

# ── Notifications ─────────────────────────────────────────────────────────────

@app.get("/api/notifications")
def list_notifications(user=Depends(get_current_user)):
    rows = q("""SELECT id,type,message,link,is_read,
                       TO_CHAR(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
                FROM scheduling.notifications WHERE user_id=%s
                ORDER BY created_at DESC LIMIT 50""", (user["id"],))
    unread = sum(1 for r in rows if not r["is_read"])
    return {"notifications": rows, "unread": unread}

@app.put("/api/notifications/{nid}/read")
def mark_notification_read(nid: int, user=Depends(get_current_user)):
    q("UPDATE scheduling.notifications SET is_read=true WHERE id=%s AND user_id=%s",
      (nid, user["id"]), exec_only=True)
    return {"ok": True}

@app.put("/api/notifications/read-all")
def mark_all_notifications_read(user=Depends(get_current_user)):
    q("UPDATE scheduling.notifications SET is_read=true WHERE user_id=%s AND is_read=false",
      (user["id"],), exec_only=True)
    return {"ok": True}

# ── Shift swaps (multi-stage approval) ────────────────────────────────────────
# Flow: pending_peer → pending_lead → pending_manager → approved.
#   1. A staff member requests a swap with a colleague.
#   2. The colleague (peer) accepts.
#   3. The team lead approves.
#   4. The manager gives final approval → the two cells are exchanged.
# A reject at any stage ends it. A superadmin can push through any stage.

SWAP_STAGES = ("pending_peer", "pending_lead", "pending_manager", "approved", "rejected")

def _swap_with_names(extra_where="", vals=()):
    return q(f"""SELECT sw.*,
                        TO_CHAR(sw.date_a,'YYYY-MM-DD') AS date_a,
                        TO_CHAR(sw.date_b,'YYYY-MM-DD') AS date_b,
                        TO_CHAR(sw.peer_at,'YYYY-MM-DD"T"HH24:MI:SS') AS peer_at,
                        TO_CHAR(sw.lead_at,'YYYY-MM-DD"T"HH24:MI:SS') AS lead_at,
                        TO_CHAR(sw.mgr_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS mgr_at,
                        TO_CHAR(sw.reject_at,'YYYY-MM-DD"T"HH24:MI:SS') AS reject_at,
                        sa.name AS staff_a_name, sb.name AS staff_b_name,
                        b.name AS branch_name,
                        ul.username AS lead_name, um.username AS mgr_name, ur.username AS reject_name
                 FROM scheduling.shift_swaps sw
                 JOIN scheduling.staff sa ON sa.id=sw.staff_a
                 JOIN scheduling.staff sb ON sb.id=sw.staff_b
                 LEFT JOIN scheduling.branches b ON b.id=sw.branch_id
                 LEFT JOIN scheduling.users ul ON ul.id=sw.lead_by
                 LEFT JOIN scheduling.users um ON um.id=sw.mgr_by
                 LEFT JOIN scheduling.users ur ON ur.id=sw.reject_by
                 {extra_where} ORDER BY sw.created_at DESC LIMIT 200""", vals)

def _swap_label(sw):
    sa = q("SELECT name FROM scheduling.staff WHERE id=%s", (sw["staff_a"],), one=True) or {}
    sb = q("SELECT name FROM scheduling.staff WHERE id=%s", (sw["staff_b"],), one=True) or {}
    return f"{sa.get('name','?')} ({sw['date_a']}) ↔ {sb.get('name','?')} ({sw['date_b']})"

def _swap_leave_conflict(sw):
    """Message describing how applying this swap would clash with APPROVED leave
    (a working shift landing on a leave day, or a leave code being moved between
    people and orphaning its leave record). None if the swap is safe to apply."""
    sched = q("""SELECT id FROM scheduling.schedules WHERE branch_id=%s AND year=%s AND month=%s""",
              (sw["branch_id"], sw["year"], sw["month"]), one=True)
    if not sched:
        return None
    def code(staff, d):
        r = q("""SELECT shift_code FROM scheduling.schedule_entries
                 WHERE schedule_id=%s AND staff_id=%s AND date=%s""", (sched["id"], staff, d), one=True)
        return (r and r["shift_code"]) or "O"
    ca, cb = code(sw["staff_a"], sw["date_a"]), code(sw["staff_b"], sw["date_b"])
    probs = []
    # After the swap staff_a receives cb on date_a, staff_b receives ca on date_b.
    if _is_working_code(cb) and has_approved_leave(sw["staff_a"], sw["date_a"]):
        probs.append("the requester is on approved leave that day")
    if _is_working_code(ca) and has_approved_leave(sw["staff_b"], sw["date_b"]):
        probs.append("the colleague is on approved leave that day")
    if ca in ("AL", "SL", "TB") or cb in ("AL", "SL", "TB"):
        probs.append("one side is a leave day and can't be swapped")
    return "; ".join(probs) if probs else None

def _apply_swap(sw):
    """Exchange the two cells on the month's schedule (missing cell = Off)."""
    sched = q("""SELECT id FROM scheduling.schedules
                 WHERE branch_id=%s AND year=%s AND month=%s""",
              (sw["branch_id"], sw["year"], sw["month"]), one=True)
    if not sched:
        raise HTTPException(409, "No schedule exists for this month to apply the swap")
    sid = sched["id"]
    def cell(staff_id, d):
        r = q("""SELECT shift_code,is_oncall,cross_branch_id FROM scheduling.schedule_entries
                 WHERE schedule_id=%s AND staff_id=%s AND date=%s""", (sid, staff_id, d), one=True)
        return r or {"shift_code": "O", "is_oncall": False, "cross_branch_id": None}
    a = cell(sw["staff_a"], sw["date_a"])
    b = cell(sw["staff_b"], sw["date_b"])
    def put(staff_id, d, c):
        # Mark the swapped cells is_manual so a later regenerate PRESERVES them — an
        # approved swap is a deliberate manager decision and must not be silently
        # overwritten by the solver (regenerate only keeps is_manual cells).
        q("""INSERT INTO scheduling.schedule_entries
             (schedule_id,staff_id,date,shift_code,is_oncall,cross_branch_id,is_manual)
             VALUES (%s,%s,%s,%s,%s,%s,true)
             ON CONFLICT (schedule_id,staff_id,date) DO UPDATE
             SET shift_code=EXCLUDED.shift_code,is_oncall=EXCLUDED.is_oncall,
                 cross_branch_id=EXCLUDED.cross_branch_id,is_manual=true""",
          (sid, staff_id, d, c["shift_code"], c["is_oncall"], c["cross_branch_id"]), exec_only=True)
    put(sw["staff_a"], sw["date_a"], b)
    put(sw["staff_b"], sw["date_b"], a)

@app.get("/api/swaps")
def list_swaps(request: Request, user=Depends(get_current_user)):
    p = request.query_params
    conds, vals = [], []
    role = user["role"]
    if role == "staff":
        # A staff member sees swaps they're part of (as requester or peer).
        conds.append("(sw.staff_a=%s OR sw.staff_b=%s)")
        vals += [user.get("staff_id"), user.get("staff_id")]
    elif role in ("superadmin", "manager"):
        if p.get("branch_id"): conds.append("sw.branch_id=%s"); vals.append(p["branch_id"])
    else:  # team lead
        conds.append("sw.branch_id=%s"); vals.append(user.get("branch_id"))
    if p.get("status"): conds.append("sw.status=%s"); vals.append(p["status"])
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    return _swap_with_names(where, vals)

@app.post("/api/swaps")
async def create_swap(request: Request, user=Depends(get_current_user)):
    role = user["role"]
    if role not in ("staff", "admin", "manager", "superadmin"):
        raise HTTPException(403, "Forbidden")
    body = await request.json()
    date_a, date_b = body.get("date_a"), body.get("date_b")
    staff_a, staff_b = body.get("staff_a"), body.get("staff_b")
    note = body.get("note")
    # A staff member always requests on their own behalf.
    if role == "staff":
        staff_a = user.get("staff_id")
    if not all([staff_a, date_a, staff_b, date_b]):
        raise HTTPException(400, "staff_a, date_a, staff_b, date_b are required")
    if str(staff_a) == str(staff_b):
        raise HTTPException(400, "Pick a different colleague to swap with")
    sa = q("SELECT branch_id,name FROM scheduling.staff WHERE id=%s", (staff_a,), one=True)
    sb = q("SELECT branch_id,name FROM scheduling.staff WHERE id=%s", (staff_b,), one=True)
    if not sa or not sb:
        raise HTTPException(404, "Staff not found")
    if sa["branch_id"] != sb["branch_id"]:
        raise HTTPException(400, "Both staff must be in the same branch")
    if date_a[:7] != date_b[:7]:
        raise HTTPException(400, "Both dates must be in the same month")
    if role != "staff" and not can_access_branch(user, sa["branch_id"]):
        raise HTTPException(403, "Forbidden")
    try:
        year, month = int(date_a[:4]), int(date_a[5:7])
    except (ValueError, IndexError):
        raise HTTPException(400, "date_a must be YYYY-MM-DD")
    # Don't let two open swaps fight over the same cell — reject if either of
    # these two shifts is already tied up in a pending swap.
    dup = q("""SELECT 1 FROM scheduling.shift_swaps
               WHERE status IN ('pending_peer','pending_lead','pending_manager')
                 AND ((staff_a=%s AND date_a=%s) OR (staff_b=%s AND date_b=%s)
                   OR (staff_a=%s AND date_a=%s) OR (staff_b=%s AND date_b=%s))""",
            (staff_a, date_a, staff_a, date_a, staff_b, date_b, staff_b, date_b), one=True)
    if dup:
        raise HTTPException(409, "One of these shifts is already part of a pending swap")
    row = q("""INSERT INTO scheduling.shift_swaps
               (branch_id,year,month,staff_a,date_a,staff_b,date_b,note,created_by,status)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending_peer') RETURNING id""",
            (sa["branch_id"], year, month, staff_a, date_a, staff_b, date_b, note, user["id"]), one=True)
    insert_audit(user, "SWAP_REQUEST", f"swap:{row['id']}", f"{sa['name']} {date_a} ↔ {sb['name']} {date_b}")
    # The colleague must accept first.
    notify_staff_member(staff_b,
                        f"{sa['name']} asked to swap shifts with you ({date_a} ↔ {date_b}) — please accept or decline",
                        link="swaps", ntype="swap")
    return {"id": row["id"], "ok": True}

@app.put("/api/swaps/{swid}/action")
async def act_on_swap(swid: int, request: Request, user=Depends(get_current_user)):
    """Advance (accept/approve) or reject a swap, depending on the caller's role
    and the swap's current stage."""
    body = await request.json()
    action = (body.get("action") or "").lower()
    note   = body.get("note")
    if action not in ("accept", "approve", "reject"):
        raise HTTPException(400, "action must be accept, approve or reject")
    sw = q("SELECT * FROM scheduling.shift_swaps WHERE id=%s", (swid,), one=True)
    if not sw:
        raise HTTPException(404, "Swap not found")
    st = sw["status"]
    if st in ("approved", "rejected"):
        raise HTTPException(400, f"Swap already {st}")

    role = user["role"]
    sid = user.get("staff_id")
    is_super     = role == "superadmin"
    is_peer      = role == "staff" and sid == sw["staff_b"]
    is_requester = role == "staff" and sid == sw["staff_a"]
    has_branch   = role in ("admin", "manager", "superadmin") and can_access_branch(user, sw["branch_id"])
    is_reviewer  = role in ("manager", "superadmin")
    label = _swap_label(sw)

    if action == "reject":
        # The peer, the requester (cancel), the branch lead/manager, or a superadmin.
        if not (is_super or is_peer or is_requester or has_branch):
            raise HTTPException(403, "You can't reject this swap")
        # Atomic: only reject if it's still open (guards against a concurrent approve).
        claimed = q("""UPDATE scheduling.shift_swaps
             SET status='rejected', reject_by=%s, reject_role=%s, reject_at=NOW(), reject_note=%s
             WHERE id=%s AND status NOT IN ('approved','rejected') RETURNING id""",
             (user["id"], role, note, swid), one=True)
        if not claimed:
            raise HTTPException(409, "Swap was already completed")
        insert_audit(user, "SWAP_REJECTED", f"swap:{swid}", label)
        # Tell both parties — but not the staff member who just declined it.
        for target in (sw["staff_a"], sw["staff_b"]):
            if role == "staff" and target == sid:
                continue
            notify_staff_member(target, f"Shift swap declined: {label}", link="swaps", ntype="rejected")
        return {"ok": True, "status": "rejected"}

    # accept / approve → advance exactly one stage. Each transition is an atomic
    # UPDATE guarded on the current status, so a double-click / concurrent action
    # is a no-op (RETURNING gives no row) rather than advancing or applying twice.
    if st == "pending_peer":
        # The peer accepts. If the colleague has no user account to act with, a
        # branch lead / manager / superadmin may accept on their behalf.
        peer_unlinked = not q("SELECT 1 FROM scheduling.users WHERE staff_id=%s", (sw["staff_b"],), one=True)
        if not (is_peer or is_super or (peer_unlinked and has_branch)):
            raise HTTPException(403, "Only the colleague being swapped with can accept this")
        claimed = q("""UPDATE scheduling.shift_swaps SET status='pending_lead', peer_at=NOW()
                       WHERE id=%s AND status='pending_peer' RETURNING id""", (swid,), one=True)
        if not claimed:
            raise HTTPException(409, "Swap already moved to the next step")
        insert_audit(user, "SWAP_PEER_OK", f"swap:{swid}", label)
        notify_branch_leads(sw["branch_id"], f"Shift swap awaiting your approval: {label}", link="swaps", ntype="swap")
        return {"ok": True, "status": "pending_lead"}

    if st == "pending_lead":
        if not (has_branch or is_super):
            raise HTTPException(403, "Only the team lead or a manager can approve at this step")
        claimed = q("""UPDATE scheduling.shift_swaps SET status='pending_manager', lead_by=%s, lead_at=NOW()
                       WHERE id=%s AND status='pending_lead' RETURNING id""", (user["id"], swid), one=True)
        if not claimed:
            raise HTTPException(409, "Swap already moved to the next step")
        insert_audit(user, "SWAP_LEAD_OK", f"swap:{swid}", label)
        notify_roles(("manager", "superadmin"),
                     f"Shift swap approved by team lead — needs final approval: {label}",
                     link="swaps", ntype="swap")
        return {"ok": True, "status": "pending_manager"}

    if st == "pending_manager":
        if not is_reviewer:
            raise HTTPException(403, "Only a manager can give final approval")
        # Make sure the rota exists *before* we mark approved, so we never end up
        # "approved" without the cells actually being exchanged.
        sched = q("""SELECT id FROM scheduling.schedules
                     WHERE branch_id=%s AND year=%s AND month=%s""",
                  (sw["branch_id"], sw["year"], sw["month"]), one=True)
        if not sched:
            raise HTTPException(409, "No schedule exists for this month to apply the swap")
        # A swap approved days later may now clash with leave approved in the interim.
        # Validate BEFORE marking approved, so we never leave it approved-but-unapplied.
        if not body.get("confirm"):
            lc = _swap_leave_conflict(sw)
            if lc:
                raise HTTPException(409, {"error": f"This swap now conflicts with approved leave: {lc}. Apply anyway?",
                                          "confirm_required": "leave_conflict"})
        # Claim the final approval atomically; only the winner applies the swap.
        claimed = q("""UPDATE scheduling.shift_swaps SET status='approved', mgr_by=%s, mgr_at=NOW()
                       WHERE id=%s AND status='pending_manager' RETURNING id""", (user["id"], swid), one=True)
        if not claimed:
            raise HTTPException(409, "Swap was already finalised")
        _apply_swap(sw)
        insert_audit(user, "SWAP_APPROVED", f"swap:{swid}", label)
        notify_staff_member(sw["staff_a"], f"Your shift swap was approved and applied: {label}", link="swaps", ntype="approved")
        notify_staff_member(sw["staff_b"], f"Shift swap approved and applied: {label}", link="swaps", ntype="approved")
        return {"ok": True, "status": "approved"}

    raise HTTPException(400, f"Unexpected swap status {st}")

# ── Public holidays ───────────────────────────────────────────────────────────

@app.get("/api/holidays")
def list_holidays(request: Request, user=Depends(get_current_user)):
    p = request.query_params
    conds, vals = [], []
    if p.get("year"):  conds.append("EXTRACT(YEAR FROM date)=%s");  vals.append(p["year"])
    if p.get("month"): conds.append("EXTRACT(MONTH FROM date)=%s"); vals.append(p["month"])
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    return q(f"""SELECT id,TO_CHAR(date,'YYYY-MM-DD') AS date,name
                 FROM scheduling.holidays {where} ORDER BY date""", vals)

@app.post("/api/holidays")
async def create_holiday(request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    date, name = body.get("date"), (body.get("name") or "").strip()
    if not date or not name:
        raise HTTPException(400, "date and name are required")
    row = q("""INSERT INTO scheduling.holidays (date,name,created_by) VALUES (%s,%s,%s)
               ON CONFLICT (date) DO UPDATE SET name=EXCLUDED.name
               RETURNING id,TO_CHAR(date,'YYYY-MM-DD') AS date,name""",
            (date, name, user["id"]), one=True)
    insert_audit(user, "HOLIDAY_ADD", f"holiday:{row['id']}", f"{date} {name}")
    return row

@app.delete("/api/holidays/{hid}")
def delete_holiday(hid: int, user=Depends(require_superadmin)):
    q("DELETE FROM scheduling.holidays WHERE id=%s", (hid,), exec_only=True)
    return {"ok": True}

# ── App settings ──────────────────────────────────────────────────────────────

@app.get("/api/settings")
def read_settings(user=Depends(get_current_user)):
    out = {"leave_cutoff_day": get_leave_cutoff_day(),
           "cases_remind_hour": get_setting("cases_remind_hour", "0"),
           "shift_check_m_hour": get_setting("shift_check_m_hour", "8"),
           "shift_check_n_hour": get_setting("shift_check_n_hour", "20")}
    # Only a superadmin sees the registration links/code + email setup.
    if user["role"] == "superadmin":
        wb = _email_webhook_url()
        out["email_webhook_set"] = bool(wb)
        out["email_webhook_via_env"] = bool(os.environ.get("EMAIL_WEBHOOK_URL"))
        # Show only the host, never the secret signature in the URL.
        if wb:
            try:
                from urllib.parse import urlparse
                out["email_webhook_host"] = urlparse(wb).netloc
            except Exception:
                out["email_webhook_host"] = None
        is_open = _registration_open()
        code = _registration_code()
        app_url = os.environ.get("APP_URL", "").strip().rstrip("/")
        out["registration_open"] = is_open
        base = (app_url if app_url else "")
        marker = code or "open"   # registration is code-less now; marker just opens the form
        def _link(role):
            if not is_open:
                return None
            suffix = "" if role == "staff" else f"&as={role}"
            return f"{base}/?register={marker}{suffix}"
        out["registration_link"] = _link("staff")          # back-compat
        out["registration_links"] = {
            "staff":   _link("staff"),
            "admin":   _link("admin"),
            "manager": _link("manager"),
        } if is_open else None
    return out

@app.put("/api/settings")
async def write_settings(request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    if "leave_cutoff_day" in body:
        try:
            d = int(body["leave_cutoff_day"])
        except (TypeError, ValueError):
            raise HTTPException(400, "leave_cutoff_day must be a number")
        if not (1 <= d <= 28):
            raise HTTPException(400, "leave_cutoff_day must be between 1 and 28")
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('leave_cutoff_day',%s)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (str(d),), exec_only=True)
        insert_audit(user, "SET_LEAVE_CUTOFF", f"day:{d}")
    if "cases_remind_hour" in body:
        raw = body["cases_remind_hour"]
        # "off" (or any non-0–23 value) disables the automatic reminder.
        val = "off"
        try:
            h = int(raw)
            if 0 <= h <= 23:
                val = str(h)
        except (TypeError, ValueError):
            val = "off"
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('cases_remind_hour',%s)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (val,), exec_only=True)
        insert_audit(user, "SET_CASES_REMIND_HOUR", val)
    for _sk in ("shift_check_m_hour", "shift_check_n_hour"):
        if _sk in body:
            try:
                hv = int(body[_sk])
            except (TypeError, ValueError):
                raise HTTPException(400, f"{_sk} must be an hour 0–23")
            if not (0 <= hv <= 23):
                raise HTTPException(400, f"{_sk} must be an hour 0–23")
            q("""INSERT INTO scheduling.app_settings (key,value) VALUES (%s,%s)
                 ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (_sk, str(hv)), exec_only=True)
            insert_audit(user, "SET_" + _sk.upper(), str(hv))
    if "email_webhook_url" in body:
        raw = (body.get("email_webhook_url") or "").strip()
        if raw and not raw.lower().startswith("https://"):
            raise HTTPException(400, "The email webhook URL must start with https://")
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('email_webhook_url',%s)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (raw,), exec_only=True)
        insert_audit(user, "SET_EMAIL_WEBHOOK", "set" if raw else "cleared")
    if "registration" in body:
        # "on" → open onboarding (no code needed), "off" → close it.
        action = body["registration"]
        open_val = "off" if action == "off" else "on"
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('registration_open',%s)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (open_val,), exec_only=True)
        # Keep a code around for shareable links (optional; not required to register).
        code_val = "off" if action == "off" else (_registration_code() or __import__("secrets").token_urlsafe(9))
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('registration_code',%s)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (code_val,), exec_only=True)
        insert_audit(user, "SET_REGISTRATION", open_val)
    return read_settings(user)

@app.get("/api/email-config")
def email_config(user=Depends(require_superadmin)):
    """Diagnostics for the email setup (no secrets leaked) so a misconfiguration
    is visible from the UI."""
    provider = ("power automate" if _email_webhook_url()
                else "resend" if os.environ.get("RESEND_API_KEY")
                else "smtp" if os.environ.get("SMTP_HOST") else "none")
    return {
        "provider": provider,
        "resend_api_key_set": bool(os.environ.get("RESEND_API_KEY")),
        "from": _email_from(),
        "reply_to": _sig_email(),
        "app_url_set": bool(os.environ.get("APP_URL", "").strip()),
    }

@app.get("/api/nafath-config")
def nafath_config(user=Depends(require_superadmin)):
    """Diagnostics for the Nafath (Sadq) setup (no secrets leaked) so a
    misconfiguration is visible before testing on the live form."""
    return {
        "enabled": _nafath_enabled(),
        "mock": _sadq_mock(),
        "base_url": _sadq_base(),
        "account_id_set": bool(_sadq_account_id()),
        "thumbprint_set": bool(_sadq_thumbprint()),
        "app_url_set": bool(os.environ.get("APP_URL", "").strip()),
        "webhook_url": _nafath_webhook_url() or None,
        # Ready to receive the push + the webhook callback end-to-end.
        "ready": bool((_sadq_configured() or _sadq_mock()) and _nafath_webhook_url()),
    }

@app.post("/api/nafath-test")
async def nafath_test(request: Request, user=Depends(require_superadmin)):
    """Fire a real Nafath auth for a National ID and return Sadq's RAW response,
    so the exact field shape (and whether a `random` number is returned) is
    visible. This triggers a real push to that ID's Nafath app."""
    body = await request.json()
    nid = (body.get("national_id") or "").strip()
    if not _valid_national_id(nid):
        raise HTTPException(400, "Pass a valid 10-digit National ID: {\"national_id\":\"1xxxxxxxxx\"}")
    if not (_sadq_configured() or _sadq_mock()):
        raise HTTPException(503, "Nafath isn't configured (set SADQ_ACCOUNT_ID + SADQ_THUMBPRINT).")
    request_id = str(uuid.uuid4())
    webhook = _nafath_webhook_url()
    try:
        results = _sadq_nafath_auth([nid], request_id, webhook)
    except Exception as e:
        raise HTTPException(502, f"Couldn't reach Nafath: {e}")
    r0 = (results or [{}])[0] or {}
    return {
        "ok": True, "request_id": request_id, "webhook_url": webhook or None,
        "parsed_random": str(_ci_get(r0, "random", "randomNumber", "code", "otp") or "") or None,
        "parsed_error": _ci_get(r0, "error", "errorMessage", "message"),
        "raw": results,                 # the exact Sadq response
    }

@app.post("/api/email-test")
async def email_test(request: Request, user=Depends(require_superadmin)):
    """Send a test email synchronously and return the real provider error (e.g.
    an unverified From domain) instead of swallowing it in a background thread."""
    body = await request.json()
    to = (body.get("to") or user.get("email") or _sig_email() or "").strip()
    if not to:
        raise HTTPException(400, "No recipient — pass {\"to\": \"you@example.com\"}")
    if not (_email_webhook_url() or os.environ.get("RESEND_API_KEY") or os.environ.get("SMTP_HOST")
            or os.environ.get("SMTP_CAPTURE")):
        raise HTTPException(400, "No email provider configured. Paste a Power Automate URL above, or set RESEND_API_KEY.")
    try:
        _deliver_email(to, "Meena Scheduling — test email",
                       "This is a test message confirming email delivery is working.")
    except Exception as e:
        # 502 + the provider's own message → shows up directly in the UI.
        raise HTTPException(502, f"Send failed: {e}")
    insert_audit(user, "EMAIL_TEST", to)
    # Report the source truthfully: a webhook (Power Automate) sends from the
    # work mailbox and ignores _email_from(), so don't show the Resend address.
    if _email_webhook_url():
        return {"ok": True, "sent_to": to, "from": "your work mailbox (Power Automate)",
                "via": "power automate"}
    return {"ok": True, "sent_to": to, "from": _email_from(), "via": "resend"}

@app.get("/api/whatsapp-config")
def whatsapp_config(user=Depends(require_superadmin)):
    """Diagnostics for the WhatsApp bridge (no secrets leaked). Optionally pings
    the bridge's /health so a misconfiguration is visible before testing."""
    url = (os.environ.get("WHATSAPP_NOTIFY_URL") or "").strip()
    raw_types = (os.environ.get("WHATSAPP_ONLY_TYPES") or "").strip()
    out = {
        "enabled": bool(url),
        "notify_url_set": bool(url),
        "token_set": bool((os.environ.get("WHATSAPP_NOTIFY_TOKEN") or "").strip()),
        "only_types": [x.strip() for x in raw_types.split(",") if x.strip()],
        "default_country": os.environ.get("WHATSAPP_DEFAULT_COUNTRY", "966"),
        "bridge_health": None,
    }
    # Best-effort reachability + readiness check against the bridge.
    if url:
        try:
            import urllib.request, urllib.parse
            base = url.rsplit("/", 1)[0] if url.rstrip("/").endswith("/send") else url.rstrip("/")
            health_url = base.rstrip("/") + "/health"
            req = urllib.request.Request(health_url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                out["bridge_health"] = json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:
            out["bridge_health"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    out["ready"] = bool(out["bridge_health"] and out["bridge_health"].get("ready"))
    return out

@app.post("/api/whatsapp-test")
async def whatsapp_test(request: Request, user=Depends(require_superadmin)):
    """Send a test WhatsApp message synchronously through the bridge and return
    the bridge's real response/error — the safest way to test from inside Meena."""
    body = await request.json()
    url = (os.environ.get("WHATSAPP_NOTIFY_URL") or "").strip()
    if not url:
        raise HTTPException(400, "WhatsApp isn't configured. Set WHATSAPP_NOTIFY_URL in the environment.")
    # Default to the caller's own staff phone if no number is passed.
    to = (body.get("to") or "").strip()
    if not to and user.get("staff_id"):
        row = q("SELECT phone FROM scheduling.staff WHERE id=%s", (user["staff_id"],), one=True)
        to = (row or {}).get("phone") or ""
    to = _normalize_whatsapp_number(to)
    if not to:
        raise HTTPException(400, "No valid recipient — pass {\"to\": \"05xxxxxxxx\"}")
    message = (body.get("message") or "Meena Scheduling — test WhatsApp message ✅").strip()
    token = (os.environ.get("WHATSAPP_NOTIFY_TOKEN") or "").strip()
    try:
        import urllib.request, urllib.error
        data = json.dumps({"to": to, "message": message, "type": "info"}).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(url, data=data, method="POST", headers=headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            res = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise HTTPException(502, f"Bridge {e.code}: {detail}")
    except Exception as e:
        raise HTTPException(502, f"Couldn't reach the WhatsApp bridge: {e}")
    insert_audit(user, "WHATSAPP_TEST", to)
    return {"ok": True, "sent_to": to, "bridge": res}

# ── Home dashboard ────────────────────────────────────────────────────────────

@app.get("/api/dashboard")
def dashboard_summary(user=Depends(get_current_user)):
    """At-a-glance counts for the home page, scoped to what the user can act on."""
    def c(sql, params=()):
        return (q(sql, params, one=True) or {}).get("c", 0)
    role = user["role"]
    is_reviewer = role in ("manager", "superadmin")
    bid = user.get("branch_id")
    sid = user.get("staff_id")

    # Schedules awaiting review (reviewers only).
    pending_reviews = c("SELECT COUNT(*) AS c FROM scheduling.schedules WHERE status='submitted'") if is_reviewer else 0

    # Leave awaiting THIS user's action: a manager sees everything not yet final
    # (stage 1 with no lead + stage 2); a team lead sees their branch's stage-1
    # queue ('pending') — what they can actually approve now.
    if is_reviewer:
        pending_leaves = c("SELECT COUNT(*) AS c FROM scheduling.leave_requests WHERE status IN ('pending','lead_approved')")
    elif role == "admin":
        pending_leaves = c("""SELECT COUNT(*) AS c FROM scheduling.leave_requests l
                              JOIN scheduling.staff s ON s.id=l.staff_id
                              WHERE l.status='pending' AND s.branch_id=%s""", (bid,))
    else:
        pending_leaves = 0

    # Swaps waiting on THIS user's action at their stage.
    if is_reviewer:
        pending_swaps = c("SELECT COUNT(*) AS c FROM scheduling.shift_swaps WHERE status='pending_manager'")
    elif role == "admin":
        pending_swaps = c("SELECT COUNT(*) AS c FROM scheduling.shift_swaps WHERE status='pending_lead' AND branch_id=%s", (bid,))
    elif role == "staff":
        pending_swaps = c("SELECT COUNT(*) AS c FROM scheduling.shift_swaps WHERE status='pending_peer' AND staff_b=%s", (sid,))
    else:
        pending_swaps = 0

    # Self-registrations awaiting approval (team lead: own branch; reviewer: all).
    if is_reviewer:
        pending_registrations = c("SELECT COUNT(*) AS c FROM scheduling.staff_registrations WHERE status='pending'")
    elif role == "admin":
        pending_registrations = c("SELECT COUNT(*) AS c FROM scheduling.staff_registrations WHERE status='pending' AND branch_id=%s", (bid,))
    else:
        pending_registrations = 0

    # Open support tickets needing attention (reviewer: all; team lead: own branch).
    if is_reviewer:
        open_tickets = c("SELECT COUNT(*) AS c FROM scheduling.tickets WHERE status = ANY(%s)",
                         (list(_TICKET_ACTIVE),))
    elif role == "admin":
        open_tickets = c("""SELECT COUNT(*) AS c FROM scheduling.tickets
                            WHERE status = ANY(%s) AND branch_id=%s""", (list(_TICKET_ACTIVE), bid))
    else:
        open_tickets = 0

    # Action-required circulars this user hasn't acknowledged yet (nav badge).
    if user["role"] in ("manager", "superadmin"):
        ann_cond, ann_vals = "1=1", []
    else:
        ann_cond, ann_vals = "(a.audience='all' OR a.branch_id=%s)", [bid]
    announcements_todo = c(f"""SELECT COUNT(*) AS c FROM scheduling.announcements a
                               WHERE a.kind='action_required' AND {ann_cond}
                                 AND NOT EXISTS (SELECT 1 FROM scheduling.announcement_acks k
                                                 WHERE k.announcement_id=a.id AND k.user_id=%s)""",
                            tuple(ann_vals) + (user["id"],))

    # Today's daily-cases submission progress.
    date = _operational_date_server()
    if is_reviewer:
        total_branches = c("SELECT COUNT(*) AS c FROM scheduling.branches")
        submitted = c("SELECT COUNT(*) AS c FROM scheduling.daily_cases WHERE date=%s AND locked=true", (date,))
    elif bid:
        total_branches = 1
        submitted = c("SELECT COUNT(*) AS c FROM scheduling.daily_cases WHERE date=%s AND locked=true AND branch_id=%s", (date, bid))
    else:
        total_branches, submitted = 0, 0

    return {
        "pending_reviews": pending_reviews,
        "pending_leaves": pending_leaves,
        "pending_swaps": pending_swaps,
        "pending_registrations": pending_registrations,
        "open_tickets": open_tickets,
        "announcements_todo": announcements_todo,
        "cases_today": {"submitted": submitted, "total": total_branches, "date": date},
        "role": role,
    }

@app.get("/api/on-duty")
def on_duty(request: Request, user=Depends(get_current_user)):
    """Who's on shift on a given day (default today, KSA), with their contact info —
    a manager sees every branch; a team lead sees their own."""
    from datetime import datetime, timezone, timedelta
    date = request.query_params.get("date")
    if not date:
        date = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%Y-%m-%d")
    role = user["role"]
    cond, vals = ["e.date=%s", "e.shift_code NOT IN ('O','AL','SL','TB','OC')"], [date]
    if role not in ("superadmin", "manager"):
        bid = user.get("branch_id")
        if not bid:
            return {"date": date, "branches": []}
        cond.append("sc.branch_id=%s"); vals.append(bid)
    rows = q(f"""SELECT sc.branch_id, b.name AS branch_name, s.id AS staff_id, s.name,
                        s.phone, s.email, s.speciality, e.shift_code, e.is_oncall,
                        e.cross_branch_id, cb.name AS cross_branch_name
                 FROM scheduling.schedule_entries e
                 JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                 JOIN scheduling.staff s ON s.id=e.staff_id
                 JOIN scheduling.branches b ON b.id=sc.branch_id
                 LEFT JOIN scheduling.branches cb ON cb.id=e.cross_branch_id
                 WHERE {' AND '.join(cond)}
                 ORDER BY b.name, e.shift_code, s.name""", vals)
    by_branch = {}
    for r in rows:
        g = by_branch.setdefault(r["branch_id"], {"branch_id": r["branch_id"],
                                                  "branch_name": r["branch_name"], "staff": []})
        g["staff"].append({
            "staff_id": r["staff_id"], "name": r["name"],
            "phone": r.get("phone"), "email": r.get("email"),
            "shift_code": r["shift_code"], "section": _section_of(r.get("speciality")),
            "is_oncall": bool(r.get("is_oncall")),
            "covering_at": r.get("cross_branch_name") if r.get("cross_branch_id") else None,
        })
    return {"date": date, "branches": list(by_branch.values())}

# ── Reports (manager: any branch; team lead: their own) ───────────────────────
def _report_branch_scope(user, requested_branch_id):
    """Branch id(s) this user may report on. Returns (branch_id_or_None_for_all,
    list_of_ids). A team lead is pinned to their branch; a reviewer may pick one
    branch or see all."""
    if user["role"] in ("superadmin", "manager"):
        if requested_branch_id:
            return _int_or_400(requested_branch_id), [_int_or_400(requested_branch_id)]
        ids = [b["id"] for b in q("SELECT id FROM scheduling.branches")]
        return None, ids
    # admin / others → their own branch only
    bid = user.get("branch_id")
    if not bid:
        raise HTTPException(403, "No branch assigned to this account")
    return bid, [bid]

@app.get("/api/reports/fairness")
def report_fairness(request: Request, user=Depends(require_admin)):
    """Per-staff distribution for a branch/month — shifts, nights, mornings,
    weekends, on-call — so a lead/manager can balance the load."""
    p = request.query_params
    branch_id = p.get("branch_id") or user.get("branch_id")
    if not branch_id:
        raise HTTPException(400, "branch_id required")
    branch_id = _int_or_400(branch_id)
    if not can_access_branch(user, branch_id):
        raise HTTPException(403, "Forbidden")
    year = _int_or_400(p.get("year"), "year"); month = _int_or_400(p.get("month"), "month")
    rows = q("""SELECT s.id, s.name, s.speciality,
                   COUNT(*) FILTER (WHERE e.shift_code NOT IN ('O','AL','SL','TB','OC')) AS shifts,
                   COUNT(*) FILTER (WHERE e.shift_code='N') AS nights,
                   COUNT(*) FILTER (WHERE e.shift_code='M') AS mornings,
                   COUNT(*) FILTER (WHERE e.shift_code NOT IN ('O','AL','SL','TB','OC')
                                    AND EXTRACT(DOW FROM e.date) IN (5,6)) AS weekends,
                   COUNT(*) FILTER (WHERE COALESCE(e.is_oncall,false)) AS oncall,
                   COUNT(*) FILTER (WHERE e.shift_code IN ('AL','SL')) AS leave_days
                FROM scheduling.staff s
                LEFT JOIN scheduling.schedule_entries e
                  ON e.staff_id=s.id AND e.schedule_id IN (
                       SELECT id FROM scheduling.schedules
                       WHERE branch_id=%s AND year=%s AND month=%s)
                WHERE s.branch_id=%s AND s.active=true
                GROUP BY s.id, s.name, s.speciality
                ORDER BY nights DESC, shifts DESC, s.name""",
             (branch_id, year, month, branch_id))
    out = [{**{k: r[k] for k in ("id", "name", "shifts", "nights", "mornings", "weekends", "oncall", "leave_days")},
            "section": _section_of(r.get("speciality"))} for r in rows]
    return {"branch_id": branch_id, "year": year, "month": month, "staff": out}

@app.get("/api/reports/cases")
def report_cases(request: Request, user=Depends(require_admin)):
    """Daily-cases totals + per-day series over a date range. Manager: all branches
    or one; team lead: their own."""
    p = request.query_params
    date_from = p.get("from"); date_to = p.get("to")
    if not date_from or not date_to:
        raise HTTPException(400, "from and to dates required")
    _, branch_ids = _report_branch_scope(user, p.get("branch_id"))
    rows = q("""SELECT TO_CHAR(date,'YYYY-MM-DD') AS date, branch_id,
                       xray,ct,us,mamo,bmd,insert_cd,total_pt,bmd_not_done,mamo_not_done
                FROM scheduling.daily_cases
                WHERE date BETWEEN %s AND %s AND branch_id = ANY(%s)
                ORDER BY date""", (date_from, date_to, branch_ids))
    mods = ("xray", "ct", "us", "mamo", "bmd", "insert_cd")
    totals = {m: 0 for m in mods}
    totals.update({"total_pt": 0, "bmd_not_done": 0, "mamo_not_done": 0, "total_cases": 0})
    series = {}
    for r in rows:
        for m in mods:
            totals[m] += int(r.get(m) or 0)
        tc = sum(int(r.get(m) or 0) for m in mods)
        totals["total_cases"] += tc
        for f in ("total_pt", "bmd_not_done", "mamo_not_done"):
            totals[f] += int(r.get(f) or 0)
        s = series.setdefault(r["date"], {"date": r["date"], "total_cases": 0, "total_pt": 0})
        s["total_cases"] += tc; s["total_pt"] += int(r.get("total_pt") or 0)
    return {"from": date_from, "to": date_to, "totals": totals,
            "series": sorted(series.values(), key=lambda x: x["date"]), "rows": len(rows)}

@app.get("/api/reports/qc-log")
def report_qc_log(request: Request, user=Depends(require_admin)):
    """Equipment-check confirmation log over a date range (for accreditation)."""
    p = request.query_params
    date_from = p.get("from"); date_to = p.get("to")
    if not date_from or not date_to:
        raise HTTPException(400, "from and to dates required")
    _, branch_ids = _report_branch_scope(user, p.get("branch_id"))
    rows = q("""SELECT TO_CHAR(k.date,'YYYY-MM-DD') AS date, k.shift, b.name AS branch_name,
                       TO_CHAR(k.confirmed_at,'YYYY-MM-DD"T"HH24:MI:SS') AS confirmed_at,
                       COALESCE(s.name, u.username) AS confirmed_by, k.note
                FROM scheduling.shift_checks k
                JOIN scheduling.branches b ON b.id=k.branch_id
                LEFT JOIN scheduling.users u ON u.id=k.confirmed_by
                LEFT JOIN scheduling.staff s ON s.id=k.confirmed_by_staff
                WHERE k.date BETWEEN %s AND %s AND k.branch_id = ANY(%s)
                ORDER BY k.date DESC, k.shift""", (date_from, date_to, branch_ids))
    for r in rows:
        r["shift_label"] = _SHIFT_CHECK_LABELS.get(r["shift"], r["shift"])
    return {"from": date_from, "to": date_to, "log": rows}

# ── Staff credentials / employee-file documents ───────────────────────────────
# The employee file (CBAHI RD.1.2 / SCFHS): one slot per document type. Some carry
# an expiry that drives reminders; the rest (CV, transcript, diploma) are one-off.
_CREDENTIAL_KINDS = ("cv", "moh_license", "scfhs", "classification", "transcript",
                     "diploma", "bls", "acls", "national_id", "iqama", "passport",
                     "malpractice", "other")
_EXPIRING_KINDS = {"moh_license", "scfhs", "classification", "bls", "acls",
                   "national_id", "iqama", "passport", "malpractice"}

def _valid_iso_date(s):
    """Return a YYYY-MM-DD string if valid, else None — guards the DB from a
    malformed date raising a 500 at INSERT time."""
    s = (s or "").strip()
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return s
    except (ValueError, TypeError):
        return None

def _can_manage_staff(user, staff_id):
    st = q("SELECT branch_id FROM scheduling.staff WHERE id=%s", (staff_id,), one=True)
    if not st:
        return False   # unknown staff → never manageable (avoids a FK 500 on insert)
    if user["role"] in ("manager", "superadmin"):
        return True
    if user["role"] == "admin":
        return can_access_branch(user, st["branch_id"])
    return False

@app.get("/api/credentials")
def list_credentials(request: Request, user=Depends(require_admin)):
    """All staff credentials in scope (team lead: own branch; manager: any/all)."""
    _, branch_ids = _report_branch_scope(user, request.query_params.get("branch_id"))
    rows = q("""SELECT c.id, c.staff_id, c.kind, c.label, c.number,
                       TO_CHAR(c.issue_date,'YYYY-MM-DD')  AS issue_date,
                       TO_CHAR(c.expiry_date,'YYYY-MM-DD') AS expiry_date,
                       (c.expiry_date - CURRENT_DATE) AS days_left,
                       s.name AS staff_name, s.branch_id, b.name AS branch_name
                FROM scheduling.staff_credentials c
                JOIN scheduling.staff s ON s.id=c.staff_id
                LEFT JOIN scheduling.branches b ON b.id=s.branch_id
                WHERE s.branch_id = ANY(%s) AND COALESCE(s.active,true)=true
                ORDER BY c.expiry_date NULLS LAST""", (branch_ids,))
    return rows

@app.get("/api/credentials/expiring")
def expiring_credentials(request: Request, user=Depends(require_admin)):
    days = request.query_params.get("days") or "60"
    try: days = max(1, min(365, int(days)))
    except (TypeError, ValueError): days = 60
    _, branch_ids = _report_branch_scope(user, request.query_params.get("branch_id"))
    rows = q("""SELECT c.id, c.kind, c.label,
                       TO_CHAR(c.expiry_date,'YYYY-MM-DD') AS expiry_date,
                       (c.expiry_date - CURRENT_DATE) AS days_left,
                       s.name AS staff_name, b.name AS branch_name
                FROM scheduling.staff_credentials c
                JOIN scheduling.staff s ON s.id=c.staff_id
                LEFT JOIN scheduling.branches b ON b.id=s.branch_id
                WHERE s.branch_id = ANY(%s) AND COALESCE(s.active,true)=true
                  AND c.expiry_date <= CURRENT_DATE + %s
                ORDER BY c.expiry_date""", (branch_ids, days))
    return {"days": days, "items": rows}

@app.get("/api/staff/{sid}/credentials")
def staff_credentials(sid: int, user=Depends(get_current_user)):
    # A staff member may view their own; a lead/manager their branch.
    if user["role"] == "staff":
        if user.get("staff_id") != sid:
            raise HTTPException(403, "Forbidden")
    elif not _can_manage_staff(user, sid):
        raise HTTPException(403, "Forbidden")
    return q("""SELECT id, kind, label, number,
                       TO_CHAR(issue_date,'YYYY-MM-DD')  AS issue_date,
                       TO_CHAR(expiry_date,'YYYY-MM-DD') AS expiry_date,
                       (expiry_date - CURRENT_DATE) AS days_left
                FROM scheduling.staff_credentials WHERE staff_id=%s ORDER BY kind""", (sid,))

@app.post("/api/credentials")
async def create_credential(request: Request, user=Depends(require_admin)):
    body = await request.json()
    sid = _int_or_400(body.get("staff_id"), "staff_id")
    if not _can_manage_staff(user, sid):
        raise HTTPException(403, "Forbidden")
    kind = body.get("kind") if body.get("kind") in _CREDENTIAL_KINDS else "other"
    issue = _valid_iso_date(body.get("issue_date"))
    expiry = _valid_iso_date(body.get("expiry_date"))
    if kind in _EXPIRING_KINDS and not expiry:
        raise HTTPException(400, "This document needs a valid expiry_date (YYYY-MM-DD)")
    row = q("""INSERT INTO scheduling.staff_credentials (staff_id,kind,label,number,issue_date,expiry_date,created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s)
               RETURNING id, TO_CHAR(expiry_date,'YYYY-MM-DD') AS expiry_date""",
            (sid, kind, (body.get("label") or "").strip()[:80] or None,
             (body.get("number") or "").strip()[:60] or None, issue, expiry, user["id"]), one=True)
    insert_audit(user, "CREDENTIAL_ADD", f"staff:{sid}", f"{kind} {expiry or '—'}")
    return row

@app.put("/api/credentials/{cid}")
async def update_credential(cid: int, request: Request, user=Depends(require_admin)):
    c = q("SELECT staff_id FROM scheduling.staff_credentials WHERE id=%s", (cid,), one=True)
    if not c:
        raise HTTPException(404, "Not found")
    if not _can_manage_staff(user, c["staff_id"]):
        raise HTTPException(403, "Forbidden")
    body = await request.json()
    kind = body.get("kind") if body.get("kind") in _CREDENTIAL_KINDS else "other"
    issue = _valid_iso_date(body.get("issue_date"))
    expiry = _valid_iso_date(body.get("expiry_date"))
    if kind in _EXPIRING_KINDS and not expiry:
        raise HTTPException(400, "This document needs a valid expiry_date (YYYY-MM-DD)")
    q("""UPDATE scheduling.staff_credentials SET kind=%s,label=%s,number=%s,issue_date=%s,expiry_date=%s WHERE id=%s""",
      (kind, (body.get("label") or "").strip()[:80] or None,
       (body.get("number") or "").strip()[:60] or None, issue, expiry, cid), exec_only=True)
    return {"ok": True}

@app.delete("/api/credentials/{cid}")
def delete_credential(cid: int, user=Depends(require_admin)):
    c = q("SELECT staff_id FROM scheduling.staff_credentials WHERE id=%s", (cid,), one=True)
    if not c:
        raise HTTPException(404, "Not found")
    if not _can_manage_staff(user, c["staff_id"]):
        raise HTTPException(403, "Forbidden")
    q("DELETE FROM scheduling.staff_credentials WHERE id=%s", (cid,), exec_only=True)
    return {"ok": True}

# ── Staff self-service: fill your own employee-file document dates ─────────────
@app.get("/api/my-credentials")
def my_credentials(user=Depends(get_current_user)):
    """The signed-in staff member's own document slots (for the employee file)."""
    sid = user.get("staff_id")
    if not sid:
        return []
    return q("""SELECT id, kind, label, number,
                       TO_CHAR(issue_date,'YYYY-MM-DD')  AS issue_date,
                       TO_CHAR(expiry_date,'YYYY-MM-DD') AS expiry_date,
                       (expiry_date - CURRENT_DATE) AS days_left
                FROM scheduling.staff_credentials WHERE staff_id=%s ORDER BY kind""", (sid,))

@app.put("/api/my-credentials")
async def upsert_my_credential(request: Request, user=Depends(get_current_user)):
    """Staff fills the dates/number of one of their own file documents. One slot
    per document type — upserts by (staff_id, kind)."""
    sid = user.get("staff_id")
    if not sid:
        raise HTTPException(400, "Your account isn't linked to a staff profile.")
    body = await request.json()
    kind = body.get("kind") if body.get("kind") in _CREDENTIAL_KINDS else None
    if not kind:
        raise HTTPException(400, "Unknown document type")
    issue = _valid_iso_date(body.get("issue_date"))
    expiry = _valid_iso_date(body.get("expiry_date"))
    if kind in _EXPIRING_KINDS and not expiry:
        raise HTTPException(400, "This document needs an expiry date (YYYY-MM-DD)")
    number = (body.get("number") or "").strip()[:60] or None
    existing = q("SELECT id FROM scheduling.staff_credentials WHERE staff_id=%s AND kind=%s ORDER BY id LIMIT 1",
                 (sid, kind), one=True)
    if existing:
        q("UPDATE scheduling.staff_credentials SET number=%s, issue_date=%s, expiry_date=%s WHERE id=%s",
          (number, issue, expiry, existing["id"]), exec_only=True)
        cid = existing["id"]
    else:
        row = q("""INSERT INTO scheduling.staff_credentials (staff_id,kind,number,issue_date,expiry_date,created_by)
                   VALUES (%s,%s,%s,%s,%s,%s) RETURNING id""",
                (sid, kind, number, issue, expiry, user["id"]), one=True)
        cid = row["id"]
    return {"ok": True, "id": cid}

@app.delete("/api/my-credentials/{kind}")
def delete_my_credential(kind: str, user=Depends(get_current_user)):
    """Staff clears one of their own document slots."""
    sid = user.get("staff_id")
    if not sid:
        raise HTTPException(400, "Your account isn't linked to a staff profile.")
    q("DELETE FROM scheduling.staff_credentials WHERE staff_id=%s AND kind=%s", (sid, kind), exec_only=True)
    return {"ok": True}

# ── Elite / Butterfly (DePACS) radiology reports ──────────────────────────────
# Pull this clinic's own radiology reports from the DePACS "Butterfly" portal so
# staff can search by patient file number and view/download the report inside
# Meena. Contract discovered from the portal's own API:
#   POST /auth/signin {identifier,password,device_id,platform} -> {access_token}
#   GET  /study/get_studies?...&patient_id=<file>        -> studies list
#   GET  /report/get_study_report_info/<study_id>        -> report_content (HTML)
#   GET  /report/open_report_pdf/<study_id>?style=<1|2>  -> PDF
_ELITE_API_DEFAULT = "https://test-api.diagnosticselite.net:10443/api/v1"
_elite_token_cache = {"token": None, "exp": 0.0}

def _elite_cfg():
    return {"base": (get_setting("elite_api_base") or _ELITE_API_DEFAULT).rstrip("/"),
            "username": get_setting("elite_username") or "",
            "password": get_setting("elite_password") or ""}

def _elite_ssl_ctx():
    # The vendor API serves a self-signed cert on a non-standard port; skip
    # verification for these calls only (mirrors the browser / curl -k needed).
    import ssl
    c = ssl.create_default_context(); c.check_hostname = False; c.verify_mode = ssl.CERT_NONE
    return c

# Optional DePACS cert pinning: set ELITE_CERT_SHA256 to the server cert's SHA-256
# fingerprint (hex, colons/spaces ignored) to defend against MITM even though the
# cert is self-signed. Empty → no pinning, identical to the plain path. Get it with:
#   echo | openssl s_client -connect <host>:<port> 2>/dev/null \
#     | openssl x509 -fingerprint -sha256 -noout
_ELITE_PIN = re.sub(r"[^0-9a-f]", "", (os.environ.get("ELITE_CERT_SHA256") or "").lower())

def _elite_opener():
    """urllib opener that (when ELITE_CERT_SHA256 is set) verifies the DePACS server
    certificate's SHA-256 fingerprint on the actual request socket, then behaves like
    urlopen. Off by default so a deploy can never break the connection."""
    import urllib.request, http.client, ssl, hashlib
    ctx = _elite_ssl_ctx()
    pin = _ELITE_PIN
    class _PinnedConn(http.client.HTTPSConnection):
        def connect(self):
            super().connect()
            if pin:
                der = self.sock.getpeercert(binary_form=True) or b""
                if hashlib.sha256(der).hexdigest() != pin:
                    self.close()
                    raise ssl.SSLError("DePACS certificate fingerprint mismatch (pin)")
    class _PinnedHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(_PinnedConn, req, context=ctx)
    return urllib.request.build_opener(_PinnedHandler)

def _elite_request(method, path, token=None, body=None, form=None, want="json", timeout=30):
    import urllib.request, urllib.error
    url = _elite_cfg()["base"] + path
    headers = {"Accept": "*/*"}
    if form is not None:
        # Some Butterfly endpoints (e.g. study/update_study_stats) take multipart
        # form-data, not JSON. Build the body by hand so we don't add a dependency.
        import uuid
        boundary = "----MeenaBoundary" + uuid.uuid4().hex
        parts = []
        for k, v in form.items():
            if v is None:
                continue
            parts.append("--" + boundary)
            parts.append(f'Content-Disposition: form-data; name="{k}"')
            parts.append("")
            parts.append(str(v))
        parts.append("--" + boundary + "--")
        parts.append("")
        data = "\r\n".join(parts).encode("utf-8")
        headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
    else:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        if body is not None: headers["Content-Type"] = "application/json"
    if token: headers["Authorization"] = "Token " + token
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with _elite_opener().open(req, timeout=timeout) as resp:
            raw = resp.read()
            if want == "raw":
                return (resp.getheader("Content-Type", ""), raw)
            txt = raw.decode("utf-8", "replace").strip()
            # A 2xx with an empty body (some PUTs) is a success, not a parse error.
            return json.loads(txt) if txt else {"success": True}
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"Reports service {e.code}: {e.read().decode('utf-8','replace')[:200]}")
    except Exception as e:
        raise HTTPException(502, f"Couldn't reach the reports service: {e}")

def _elite_login():
    import time
    c = _elite_cfg()
    if not (c["username"] and c["password"]):
        raise HTTPException(400, "Reports lookup isn't set up. Add the Butterfly account in Settings.")
    r = _elite_request("POST", "/auth/signin", body={
        "identifier": c["username"], "password": c["password"],
        "device_id": f"{c['username']}_meena", "platform": "web"})
    tok = (r.get("body") or {}).get("access_token") if isinstance(r, dict) else None
    if not (isinstance(r, dict) and r.get("success") and tok):
        raise HTTPException(502, f"Reports login failed: {(isinstance(r, dict) and r.get('error')) or 'check the username/password'}")
    _elite_token_cache.update(token=tok, exp=time.time() + 3 * 3600)
    return tok

def _elite_token():
    import time
    if _elite_token_cache["token"] and _elite_token_cache["exp"] > time.time() + 60:
        return _elite_token_cache["token"]
    return _elite_login()

def _elite_get(path, want="json"):
    try:
        return _elite_request("GET", path, token=_elite_token(), want=want)
    except HTTPException as e:
        if getattr(e, "status_code", 0) == 502 and ("401" in str(e.detail) or "403" in str(e.detail)):
            _elite_token_cache["token"] = None
            return _elite_request("GET", path, token=_elite_login(), want=want)
        raise

def _elite_name(n):
    return (n or "").replace("^", " ").replace("  ", " ").strip()

def _elite_file_candidates(file_no):
    """Some Siratech orders carry the file/MRN with a 'SIRA' prefix (e.g.
    'SIRA26339429') while DePACS may store the study under the bare number — or the
    reverse. A single search by one form silently misses the other, so try BOTH:
    the value as entered, the same value with any leading 'SIRA' stripped, and the
    bare-digit value with 'SIRA' added. De-duplicated, order preserved."""
    import re
    s = (file_no or "").strip()
    out = []
    def add(x):
        x = (x or "").strip()
        if x and x not in out:
            out.append(x)
    add(s)
    m = re.match(r"(?i)^sira[\s\-_:]*(.+)$", s)   # strip a leading SIRA (+ separators)
    bare = m.group(1).strip() if m else s
    add(bare)
    if re.fullmatch(r"\d+", bare):                # a plain file number → also try SIRA-prefixed
        add("SIRA" + bare)
    return out

def _elite_bare_id(x):
    """Normalise a patient identifier to a comparable core: drop a leading 'SIRA'
    (+ separators) and surrounding whitespace, uppercase. 'SIRA26339429' → '26339429'."""
    m = re.match(r"(?i)^sira[\s\-_:]*(.+)$", str(x or "").strip())
    core = m.group(1) if m else str(x or "")
    return re.sub(r"\s", "", core).strip().upper()

def _elite_same_patient(pat_id, file_no):
    """True when a DePACS study's pat_id refers to the SAME patient as the Siratech
    file_no — tolerant of the SIRA-prefix mismatch (SIRA26339429 == 26339429). Used as
    a hard gate before any clinical-history write so a stray study_id can never land a
    write on another patient's chart. Empty/unknown pat_id → False (fail closed)."""
    p = _elite_bare_id(pat_id)
    return bool(p) and any(_elite_bare_id(c) == p for c in _elite_file_candidates(file_no))

def _elite_is_real_accession(acc):
    """A REAL DICOM accession on this DePACS instance is a compact token — no
    whitespace, carries digits (e.g. 'SIRA1661'). The field is overloaded and may
    instead hold a body-part stub ('T SPINE') which is NOT an accession."""
    a = str(acc or "").strip()
    return bool(a) and (not re.search(r"\s", a)) and bool(re.search(r"\d", a))

# Upper date bound for study lookups. It must be well in the FUTURE, not "today":
# DePACS timestamps a study in its own (KSA, UTC+3) day, so a scan taken at
# 00:15 KSA is dated "tomorrow" relative to the server's UTC today — capping at
# today silently dropped those (and any recent) studies from the reports lookup.
_ELITE_STUDY_END_DATE = "2035-12-31"

def _elite_body(resp):
    """The 'body' dict from an elite/DePACS response, tolerating non-dict payloads.
    Some vendor error paths return a JSON list/string/None instead of an object;
    calling .get('body') on those raises AttributeError → unhandled 500. Always
    hand back a dict so callers can .get() safely."""
    b = resp.get("body") if isinstance(resp, dict) else None
    return b if isinstance(b, dict) else {}

def _elite_studies_for_file(file_no, end_date=_ELITE_STUDY_END_DATE):
    """DePACS studies for a file number across EVERY SIRA/bare candidate, merged and
    de-duplicated by study_id. We must query all forms (not stop at the first with
    hits): the same patient can have some studies filed under the bare number and
    others under the SIRA-prefixed one, so stopping early would drop half of them.
    end_date defaults to a far-future bound so timezone-skewed / recent studies are
    never excluded (the "some results missing" bug)."""
    import urllib.parse
    seen, rows = set(), []
    for pid in _elite_file_candidates(file_no):
        r = _elite_get(f"/study/get_studies?start_date=2015-01-01&end_date={end_date}"
                       f"&page_size=50&current_page=1&patient_id={urllib.parse.quote(pid)}")
        for s in (_elite_body(r).get("data")) or []:
            sid = s.get("study_id")
            if sid in seen:
                continue
            seen.add(sid)
            rows.append(s)
    return rows

@app.get("/api/reports/config")
def reports_config(user=Depends(require_superadmin)):
    c = _elite_cfg()
    return {"configured": bool(c["username"] and c["password"]), "base": c["base"], "username": c["username"]}

@app.put("/api/reports/config")
async def reports_config_save(request: Request, user=Depends(require_superadmin)):
    b = await request.json()
    if not isinstance(b, dict):
        raise HTTPException(400, "Invalid request body")
    def _save(col, val):
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES (%s,%s)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (col, val), exec_only=True)
    if "base" in b:     _save("elite_api_base", (b.get("base") or "").strip() or _ELITE_API_DEFAULT)
    # Username/password are only written when non-blank — a blank field means "leave
    # it as-is", so saving just the base can't silently wipe the stored credentials
    # (which would flip `configured` to false and break every reports/handoff lookup).
    if (b.get("username") or "").strip(): _save("elite_username", b["username"].strip())
    if (b.get("password") or "").strip(): _save("elite_password", b["password"].strip())
    _elite_token_cache["token"] = None
    insert_audit(user, "REPORTS_CONFIG", "butterfly")
    return {"ok": True}

@app.get("/api/reports/search")
def reports_search(request: Request, user=Depends(require_admin)):
    file_no = (request.query_params.get("file_no") or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    rows = _elite_studies_for_file(file_no)
    return {"file_no": file_no, "count": len(rows), "studies": [{
        "study_id": s.get("study_id"), "pat_id": s.get("pat_id"),
        "pat_name": _elite_name(s.get("pat_name")), "pat_sex": s.get("pat_sex"),
        "modality": s.get("modality"), "study_date": s.get("study_date"),
        "status": s.get("study_status"), "history": s.get("clinical_history"),
        "category": s.get("category"),
        "study_desc": s.get("study_description") or s.get("study_desc"),
        "accession_number": s.get("accession_number"),
    } for s in rows]}

@app.get("/api/reports/study/{study_id}")
def reports_study(study_id: int, user=Depends(require_admin)):
    b = _elite_body(_elite_get(f"/report/get_study_report_info/{study_id}"))
    return {"study_id": b.get("study_id"), "report_id": b.get("report_id"),
            "pat_name": _elite_name(b.get("pat_name")), "pat_id": b.get("pat_id"),
            "pat_age": b.get("pat_age"), "pat_sex": b.get("pat_sex"),
            "modality": b.get("modality"), "study_date": b.get("study_date"),
            "history": b.get("history_symptoms"), "report_html": b.get("report_content") or ""}

@app.get("/api/reports/study/{study_id}/pdf")
def reports_study_pdf(study_id: int, request: Request, user=Depends(require_admin)):
    from fastapi import Response
    try: style = max(1, min(3, int(request.query_params.get("style") or "2")))
    except (TypeError, ValueError): style = 2
    ct, data = _elite_get(f"/report/open_report_pdf/{study_id}?style={style}", want="raw")
    if "pdf" not in (ct or "").lower():
        raise HTTPException(404, "No PDF report is available for this study yet")
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="report_{study_id}.pdf"'})

# ── Radiology handoff ─────────────────────────────────────────────────────────
# One screen that (1) reads a patient's radiology order(s) from Siratech HIS,
# (2) writes the clinical history into the DePACS (Butterfly) study so the
# radiologist sees it, and (3) prepares a ready-to-paste WhatsApp message that
# staff copy into the radiology group themselves.
#
# HIS is Cloudflare/geo-locked to KSA, so we reach it through the Siratech
# connector that runs next to whatsapp-bridge on the Saudi VPS. We proxy through
# the bridge's already-open port (…/his/*) so no new firewall hole is needed —
# the bridge URL/token are the existing WHATSAPP_NOTIFY_* env vars.

def _bridge_base():
    url = (os.environ.get("WHATSAPP_NOTIFY_URL") or "").strip()
    if not url:
        return ""
    return url[:-5] if url.rstrip("/").endswith("/send") else url.rstrip("/")

def _bridge_token():
    return (os.environ.get("WHATSAPP_NOTIFY_TOKEN") or "").strip()

def _bridge_request(path, method="GET", body=None, timeout=60):
    base = _bridge_base()
    if not base:
        raise HTTPException(400, "Radiology lookup isn't configured (WhatsApp bridge URL missing).")
    import urllib.request, urllib.error
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json", "Authorization": "Bearer " + _bridge_token()}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"Connector {e.code}: {e.read().decode('utf-8', 'replace')[:200]}")
    except Exception as e:
        raise HTTPException(502, f"Couldn't reach the radiology connector: {e}")

@app.get("/api/radiology/lookup/{file_no}")
def radiology_lookup(file_no: str, user=Depends(require_radiology)):
    """Radiology orders + patient for a file (MRN) number, live from Siratech HIS."""
    import urllib.parse
    file_no = (file_no or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    return _bridge_request("/his/patient/" + urllib.parse.quote(file_no), timeout=90)

@app.get("/api/radiology/patient/{file_no}/clinical")
def radiology_patient_clinical(file_no: str, user=Depends(require_radiology)):
    """Patient clinical context for the lookup card — problem list (ICD diagnoses),
    allergies / clinical warnings, and any recorded vital signs — live from Siratech
    EMR. Read-only; loaded after the card paints so it never slows the first render."""
    import urllib.parse
    file_no = (file_no or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    return _bridge_request("/his/patient/" + urllib.parse.quote(file_no) + "/clinical", timeout=90)

@app.get("/api/radiology/patient/{file_no}/visits")
def radiology_patient_visits(file_no: str, user=Depends(require_radiology)):
    """The patient's recent clinic encounters (date · OP/ER · provider · branch),
    live from Siratech — a browse-the-history view for the lookup card. Read-only."""
    import urllib.parse
    file_no = (file_no or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    return _bridge_request("/his/patient/" + urllib.parse.quote(file_no) + "/visits", timeout=90)

@app.get("/api/radiology/patient/{file_no}/radiology-orders")
def radiology_patient_radiology_orders(file_no: str, user=Depends(require_radiology)):
    """EVERY radiology order the doctor placed for this patient — including the ones that
    never reach the worklist (billed/unbilled, not yet performed), with payment status.
    This is the only way to see unpaid/pending orders (Siratech has no branch-wide list).
    Read-only."""
    import urllib.parse
    file_no = (file_no or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    return _bridge_request("/his/patient/" + urllib.parse.quote(file_no) + "/radiology-orders", timeout=120)

@app.get("/api/radiology/his-user/{user_id}/privileges")
def radiology_his_user_privileges(user_id: str, request: Request, user=Depends(require_superadmin)):
    """Read a Siratech HIS user's privileges / modules / menu (counts + shape) — superadmin
    only, READ-ONLY. Siratech exposes no privilege-WRITE API, so this is view/audit only."""
    import urllib.parse
    user_id = (user_id or "").strip()
    if not user_id:
        raise HTTPException(400, "Enter a HIS user id")
    hosp = (request.query_params.get("hospitalId") or "0").strip()
    raw = "&raw=1" if request.query_params.get("raw") else ""
    return _bridge_request("/his/user/" + urllib.parse.quote(user_id)
                           + "/privileges?hospitalId=" + urllib.parse.quote(hosp) + raw, timeout=90)

@app.get("/api/radiology/his-user/{user_id}/umgr-probe")
def radiology_his_user_umgr_probe(user_id: str, user=Depends(require_superadmin)):
    """READ-ONLY reachability check for the user-management privilege API (superadmin)."""
    import urllib.parse
    user_id = (user_id or "").strip()
    if not user_id:
        raise HTTPException(400, "Enter a HIS user id")
    return _bridge_request("/his/user/" + urllib.parse.quote(user_id) + "/umgr-probe", timeout=90)


@app.get("/api/radiology/patient/{file_no}/labs")
def radiology_patient_labs(file_no: str, user=Depends(require_radiology)):
    """The patient's lab results — test · value · reference range · normal/abnormal,
    live from Siratech (Clinicalreport/ClinicalServiceData). Read-only."""
    import urllib.parse
    file_no = (file_no or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    return _bridge_request("/his/patient/" + urllib.parse.quote(file_no) + "/labs", timeout=90)

@app.get("/api/radiology/patient/{file_no}/appointments")
def radiology_patient_appointments(file_no: str, user=Depends(require_radiology)):
    """The patient's appointment history (date · speciality · doctor · status),
    live from Siratech. Read-only."""
    import urllib.parse
    file_no = (file_no or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    return _bridge_request("/his/patient/" + urllib.parse.quote(file_no) + "/appointments", timeout=90)

@app.get("/api/radiology/patient/{file_no}/visit-note")
def radiology_patient_visit_note(file_no: str, request: Request, user=Depends(require_radiology)):
    """The doctor's clinical note(s) for one encounter, live from Siratech. Read-only."""
    import urllib.parse
    file_no = (file_no or "").strip()
    enc = (request.query_params.get("encounterId") or "").strip()
    if not file_no or not enc:
        raise HTTPException(400, "file and encounterId are required")
    return _bridge_request("/his/patient/" + urllib.parse.quote(file_no)
                           + "/visit-note?encounterId=" + urllib.parse.quote(enc), timeout=90)

@app.get("/api/radiology/find")
def radiology_find(request: Request, user=Depends(require_radiology)):
    """Unified patient lookup: search Siratech by file/MRN, national ID, or phone
    (the HIS Patient/Search term matches across those) and return the matching
    patient rows. The caller then opens one to aggregate all their exams via
    /api/radiology/lookup. Read-only."""
    import urllib.parse
    q = (request.query_params.get("q") or "").strip()
    if not q:
        raise HTTPException(400, "Enter a file number, national ID, or phone")
    if len(q) > 60:
        raise HTTPException(400, "Search term is too long")
    # debug=1 asks the connector to report which HIS search field matched (or the
    # per-field attempts when nothing hit) — used to pin the phone/ID field name.
    dbg = "&debug=1" if (request.query_params.get("debug") or "").strip() == "1" else ""
    return _bridge_request("/his/search?q=" + urllib.parse.quote(q) + dbg, timeout=60)

@app.api_route("/api/_conn/{path:path}", methods=["GET", "POST"])
async def radiology_conn_passthrough(path: str, request: Request, user=Depends(require_superadmin)):
    """Superadmin autonomy tunnel: proxy a call to the Saudi VPS connector (the only
    host that can reach Siratech) so integration work can be driven and verified from
    the app without a new backend route per feature. The connector side only exposes
    read-only, non-billed HIS reads (its /admin/his guard), so this cannot write to
    the EMR or fire a billed government call."""
    body = None
    if request.method == "POST":
        try:
            body = await request.json()
        except Exception:
            body = None
    # _bridge_request does a BLOCKING urllib call (up to 150s). This route is `async def`
    # (needed for `await request.json()`), so calling it directly would freeze the whole
    # event loop — run it on the threadpool instead, like the sync routes get for free.
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(
        lambda: _bridge_request("/his/" + path, method=request.method, body=body, timeout=150))

@app.get("/api/radiology/study")
def radiology_study_native(request: Request, user=Depends(require_radiology)):
    """Native Siratech report text + cloud image-viewer URL + status for one exam,
    keyed by mrno (+ accession or invPatTestResultId). Everything from Siratech — no
    DePACS. Read-only. Powers the board's Report / Images buttons."""
    import urllib.parse
    mrno = (request.query_params.get("mrno") or "").strip()
    if not mrno:
        raise HTTPException(400, "A patient file number (mrno) is required")
    qs = "?mrno=" + urllib.parse.quote(mrno)
    for k in ("accession", "invPatTestResultId"):
        v = (request.query_params.get(k) or "").strip()
        if v:
            qs += f"&{k}=" + urllib.parse.quote(v)
    return _bridge_request("/his/radiology/study" + qs, timeout=90)


@app.get("/api/radiology/report-pdf")
def radiology_report_pdf(request: Request, user=Depends(require_radiology)):
    """The OFFICIAL signed report PDF (PACS-rendered, with the letterhead/logo) for one
    exam, keyed by mrno (+ accession or invPatTestResultId). Returned as base64 JSON so
    the client can open/print it. Falls back client-side to a plain print when there's
    no verified study/PDF yet. Read-only."""
    import urllib.parse
    mrno = (request.query_params.get("mrno") or "").strip()
    if not mrno:
        raise HTTPException(400, "A patient file number (mrno) is required")
    qs = "?mrno=" + urllib.parse.quote(mrno)
    for k in ("accession", "invPatTestResultId"):
        v = (request.query_params.get(k) or "").strip()
        if v:
            qs += f"&{k}=" + urllib.parse.quote(v)
    return _bridge_request("/his/radiology/report-pdf" + qs, timeout=120)

@app.get("/api/radiology/discover")
def radiology_discover(user=Depends(require_superadmin)):
    """READ-ONLY diagnostic: enumerate every Siratech API endpoint (from its Angular
    bundles) and highlight any insurance / eligibility / Nphies path. Answers "does
    Siratech expose a Nphies eligibility API we could use?" without shelling into the
    VPS. Superadmin-only; the connector launches a headless browser, so this is slow
    (~40-90s) — never calls an eligibility/claim endpoint. Returns insuranceEndpoints
    (empty = no Nphies module exposed to the app)."""
    return _bridge_request("/his/discover/endpoints", timeout=180)

def _rad_scope_site(user):
    """Branch isolation for radiology ("كل فرع لفرعه"). Returns the HIS site id a
    branch-locked team lead is confined to, or None for organisation-wide access.

    · superadmin / manager  → None (see every branch — they run the whole group)
    · everyone else (admin team lead) → their branch's siratech_site_id, IF mapped.
      If the branch has no site id yet (owner hasn't confirmed the number), we can't
      safely narrow them, so return None rather than lock them out of everything —
      the restriction switches on per branch the moment its site id is set."""
    role = (user or {}).get("role")
    if role in ("superadmin", "manager"):
        return None
    bid = (user or {}).get("branch_id")
    if not bid:
        return None
    row = q("SELECT siratech_site_id FROM scheduling.branches WHERE id=%s", (bid,), one=True)
    sid = row and row.get("siratech_site_id")
    return int(sid) if sid else None

@app.get("/api/radiology/stats")
def radiology_stats(
    from_: str = Query("", alias="from"),
    to: str = Query(""),
    sites: str = Query(""),
    modality: str = Query(""),
    financial: str = Query(""),
    full: str = Query(""),
    list_: str = Query("", alias="list"),
    nocache: str = Query(""),
    user=Depends(require_admin),
):
    """Live hospital-wide radiology-request statistics for managers, from Siratech
    HIS via the connector. Read-only. Sliced by branch, ordering department,
    ordering doctor, priority, pending-age and daily trend. `modality=1` adds an
    exact (bounded, sampled) modality mix via per-order detail calls. `list=1` adds
    the individual request rows (patient + exam) behind the counts, for drill-down."""
    import urllib.parse
    q = {}
    if (list_ or "").strip() == "1":
        q["list"] = "1"
    if (from_ or "").strip():
        q["from"] = from_.strip()
    if (to or "").strip():
        q["to"] = to.strip()
    # Branch isolation: a branch-locked team lead is confined to their own HIS site —
    # override whatever `sites` the client asked for so they can't read another
    # branch's requests. superadmin/manager (scope None) keep the client's picker.
    scope = _rad_scope_site(user)
    if scope is not None:
        q["sites"] = str(scope)
    elif (sites or "").strip():
        q["sites"] = sites.strip()
    if (modality or "").strip() == "1":
        q["modality"] = "1"
    if (financial or "").strip() == "1":
        q["financial"] = "1"
    if (full or "").strip() == "1":
        q["full"] = "1"
    if (nocache or "").strip() == "1":
        q["nocache"] = "1"
    qs = ("?" + urllib.parse.urlencode(q)) if q else ""
    # Enrichment (modality/financial/full) fans out per-order bill reads, so allow more time.
    heavy = q.get("modality") or q.get("financial") or q.get("full")
    return _bridge_request("/his/stats/radiology" + qs, timeout=240 if heavy else 150)

@app.get("/api/radiology/branches")
def radiology_branches(user=Depends(require_radiology)):
    """The real list of branches (id + name) the connector's HIS user can see —
    used to populate the branch picker so all branches show by name."""
    return _bridge_request("/his/stats/branches", timeout=90)

# ── RIS Phase 2 — order lifecycle state store + durable study binding ──────────
def _rad_ts(s):
    """Parse a HIS/worklist timestamp → aware UTC datetime or None. The HIS billDate is
    a KSA (Asia/Riyadh, +03:00) wall-clock with no offset; treat a naive value as KSA
    and convert to UTC so it lands correctly in the TIMESTAMPTZ column (else TAT is off
    by 3h and can go negative)."""
    if not s:
        return None
    raw = str(s).strip().replace(" ", "T").replace("Z", "+00:00")
    for cand in (raw, raw[:26], raw[:19]):
        try:
            dt = datetime.fromisoformat(cand)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone(timedelta(hours=3)))   # HIS billDate is KSA
            return dt.astimezone(timezone.utc)
        except Exception:
            continue
    return None

def _rad_upsert_orders(items):
    """Persist/refresh order lifecycle from a worklist payload (one row per
    gen_pat_billing_id): stamp ordered_at on first sight, promote to 'reported' when a
    verified report is ready, never downgrade a 'filed' order. One batched upsert (not
    N round-trips) so it never slows the worklist response. Best-effort — a failure is
    swallowed, never breaks the request."""
    if not isinstance(items, list) or not items:
        return 0
    dedup = {}   # last-wins per gen_pat_billing_id (a single batch can't touch a row twice)
    for it in items:
        try:
            gpb = it.get("genPatBillingId")
            if not gpb:
                continue
            gpb = int(gpb)
        except Exception:
            continue
        ready = it.get("readyToFile") is True
        # Only stamp imaged_at from an AUTHORITATIVE signal: a ready/verified report or the
        # hard `scanned` exam-timestamp. The fast pass's `stage` is the PRELIMINARY HIS
        # status text, which must never be treated as PACS-confirmed imaging — otherwise a
        # later read-back of imaged_at would be untrustworthy.
        imaged = ready or bool(it.get("scanned"))
        acc = str(it.get("accession") or "").strip() or None
        dedup[gpb] = (it.get("site"), str(it.get("mrno") or ""), it.get("billNo"), gpb,
                      it.get("patientName"), it.get("department"), it.get("doctorName"),
                      bool(it.get("emergency")), _rad_ts(it.get("orderedDate")),
                      "reported" if ready else "ordered",
                      (datetime.now(timezone.utc) if ready else None),
                      (it.get("modality") or None),
                      (datetime.now(timezone.utc) if imaged else None),
                      acc, (str(it.get("accessionSource") or "").strip() or None) if acc else None)
    rows = list(dedup.values())
    if not rows:
        return 0
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, """
                INSERT INTO scheduling.radiology_orders
                    (site, mrno, bill_no, gen_pat_billing_id, patient_name, department, doctor,
                     emergency, ordered_at, state, reported_at, modality, imaged_at,
                     accession, accession_source)
                VALUES %s
                ON CONFLICT (gen_pat_billing_id) DO UPDATE SET
                    site=EXCLUDED.site, mrno=EXCLUDED.mrno, bill_no=EXCLUDED.bill_no,
                    patient_name=EXCLUDED.patient_name, department=EXCLUDED.department, doctor=EXCLUDED.doctor,
                    emergency=EXCLUDED.emergency,
                    ordered_at=COALESCE(scheduling.radiology_orders.ordered_at, EXCLUDED.ordered_at),
                    state=CASE WHEN scheduling.radiology_orders.state='filed' THEN 'filed'
                               WHEN EXCLUDED.state='reported' THEN 'reported'
                               ELSE scheduling.radiology_orders.state END,
                    reported_at=COALESCE(scheduling.radiology_orders.reported_at, EXCLUDED.reported_at),
                    modality=COALESCE(EXCLUDED.modality, scheduling.radiology_orders.modality),
                    imaged_at=COALESCE(scheduling.radiology_orders.imaged_at, EXCLUDED.imaged_at),
                    -- surface the board's deterministic accession on the Orders page too,
                    -- without waiting for filing (COALESCE keeps a filed accession intact)
                    accession=COALESCE(scheduling.radiology_orders.accession, EXCLUDED.accession),
                    accession_source=COALESCE(scheduling.radiology_orders.accession_source, EXCLUDED.accession_source),
                    updated_at=NOW()""", rows)
        conn.commit()
        pool.putconn(conn)
        return len(rows)
    except Exception:
        try: conn.rollback()
        except Exception: pass
        try: pool.putconn(conn, close=True)   # don't return a poisoned connection to the pool
        except Exception:
            try: conn.close()
            except Exception: pass
        return 0

def _rad_upsert_exam_state(items):
    """Per-EXAM companion to _rad_upsert_orders (#9): one row per (bill, service_id) into
    scheduling.radiology_exam_state, so a bundled bill's sibling exams keep independent
    stage/report/study/accession instead of collapsing last-wins in the per-bill store.
    Denormalises the display fields so the Orders history / orphan reads can come straight
    from here. Best-effort — a failure is swallowed and never affects the parent upsert."""
    if not isinstance(items, list) or not items:
        return 0
    dedup = {}   # last-wins per (gpb, service_id) within a batch
    for it in items:
        try:
            gpb = it.get("genPatBillingId")
            if not gpb:
                continue
            gpb = int(gpb)
        except Exception:
            continue
        svc = str(it.get("svcId") if it.get("svcId") is not None else "").strip()
        ready = it.get("readyToFile") is True
        imaged = ready or bool(it.get("scanned"))
        acc = str(it.get("accession") or "").strip() or None
        dedup[(gpb, svc)] = (gpb, svc, it.get("site"), str(it.get("mrno") or ""), it.get("billNo"),
                             it.get("patientName"), it.get("department"), it.get("doctorName"),
                             bool(it.get("emergency")), (it.get("modality") or None),
                             "reported" if ready else "ordered", _rad_ts(it.get("orderedDate")),
                             (datetime.now(timezone.utc) if ready else None),
                             (datetime.now(timezone.utc) if imaged else None),
                             acc, (str(it.get("accessionSource") or "").strip() or None) if acc else None)
    rows = list(dedup.values())
    if not rows:
        return 0
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, """
                INSERT INTO scheduling.radiology_exam_state
                    (gen_pat_billing_id, service_id, site, mrno, bill_no, patient_name, department, doctor,
                     emergency, modality, state, ordered_at, reported_at, imaged_at, accession, accession_source)
                VALUES %s
                ON CONFLICT (gen_pat_billing_id, service_id) DO UPDATE SET
                    site=EXCLUDED.site, mrno=EXCLUDED.mrno, bill_no=EXCLUDED.bill_no,
                    patient_name=EXCLUDED.patient_name, department=EXCLUDED.department, doctor=EXCLUDED.doctor,
                    emergency=EXCLUDED.emergency,
                    modality=COALESCE(EXCLUDED.modality, scheduling.radiology_exam_state.modality),
                    ordered_at=COALESCE(scheduling.radiology_exam_state.ordered_at, EXCLUDED.ordered_at),
                    state=CASE WHEN scheduling.radiology_exam_state.state='filed' THEN 'filed'
                               WHEN EXCLUDED.state='reported' THEN 'reported'
                               ELSE scheduling.radiology_exam_state.state END,
                    reported_at=COALESCE(scheduling.radiology_exam_state.reported_at, EXCLUDED.reported_at),
                    imaged_at=COALESCE(scheduling.radiology_exam_state.imaged_at, EXCLUDED.imaged_at),
                    accession=COALESCE(scheduling.radiology_exam_state.accession, EXCLUDED.accession),
                    accession_source=COALESCE(scheduling.radiology_exam_state.accession_source, EXCLUDED.accession_source),
                    updated_at=NOW()""", rows)
        conn.commit()
        pool.putconn(conn)
        return len(rows)
    except Exception:
        try: conn.rollback()
        except Exception: pass
        try: pool.putconn(conn, close=True)
        except Exception:
            try: conn.close()
            except Exception: pass
        return 0

def _rad_mark_filed(gen_pat_billing_id, study_id, service_id, user_id,
                    mrno=None, site=None, bill_no=None, patient_name=None,
                    accession=None, accession_source=None, pacs_id=None, cpacs_url=None,
                    reported_at=None):
    """Record the durable binding (order ↔ DePACS study) + 'filed' state when Meena files
    a report into Siratech. The bound study_id is the deterministic link going forward.
    An UPSERT (not UPDATE-only): if the board never persisted this order first (e.g. it
    was filed the instant it appeared), we still record the filing instead of silently
    losing it — which used to leave some filed reports invisible on the Orders page.
    filed_source='meena' marks it as a real Meena turnaround (feeds the TAT averages)."""
    if not gen_pat_billing_id:
        return
    try:
        gpb = int(gen_pat_billing_id)
    except Exception:
        return
    svc = str(service_id) if service_id is not None else None
    try:
        # mrno is NOT NULL on the table; fall back to the order key as a last resort so a
        # first-sight filing can still insert rather than error out.
        mr = str(mrno) if mrno else str(gpb)
        try:
            st = int(site) if site is not None and str(site).strip() != "" else None
        except Exception:
            st = None
        acc = (str(accession).strip() or None) if accession is not None and str(accession).strip() != "" else None
        acc_src = (str(accession_source).strip() or None) if accession_source else None
        pid = (str(pacs_id).strip() or None) if pacs_id is not None and str(pacs_id).strip() != "" else None
        curl = (str(cpacs_url).strip() or None) if cpacs_url is not None and str(cpacs_url).strip() != "" else None
        # TAT truth: prefer the report's REAL signing time (from DePACS / Siratech EMR)
        # over "when Meena first saw it ready". Guarded so a bad/absent value never wins:
        # only accept a parsed timestamp that is at/after the order time and not in the
        # future; else fall back to whatever's stored, then NOW().
        rep_real = _rad_ts(reported_at) if reported_at else None
        if rep_real is not None and rep_real > datetime.now(timezone.utc) + timedelta(minutes=5):
            rep_real = None   # a report can't be signed in the future — reject the parse
        q("""INSERT INTO scheduling.radiology_orders
                 (site, mrno, bill_no, gen_pat_billing_id, patient_name,
                  state, study_id, service_id, ordered_at, reported_at, filed_at, filed_by, filed_source,
                  accession, accession_source, pacs_id, cpacs_url)
             VALUES (%s,%s,%s,%s,%s,'filed',%s,%s,NOW(),GREATEST(COALESCE(%s::timestamptz, NOW()), NOW()),NOW(),%s,'meena',%s,%s,%s,%s)
             ON CONFLICT (gen_pat_billing_id) DO UPDATE SET
                 state='filed', filed_at=NOW(), filed_by=EXCLUDED.filed_by,
                 filed_source='meena',
                 study_id=COALESCE(EXCLUDED.study_id, scheduling.radiology_orders.study_id),
                 service_id=COALESCE(EXCLUDED.service_id, scheduling.radiology_orders.service_id),
                 site=COALESCE(scheduling.radiology_orders.site, EXCLUDED.site),
                 bill_no=COALESCE(scheduling.radiology_orders.bill_no, EXCLUDED.bill_no),
                 patient_name=COALESCE(scheduling.radiology_orders.patient_name, EXCLUDED.patient_name),
                 -- the real report date, when we have it, is the truth — it overrides the
                 -- board's earlier "seen ready" guess; else keep what's stored, then NOW().
                 -- Never let it fall before ordered_at, which would yield a negative TAT.
                 reported_at=GREATEST(
                     COALESCE(%s::timestamptz, scheduling.radiology_orders.reported_at, NOW()),
                     scheduling.radiology_orders.ordered_at),
                 accession=COALESCE(scheduling.radiology_orders.accession, EXCLUDED.accession),
                 accession_source=COALESCE(scheduling.radiology_orders.accession_source, EXCLUDED.accession_source),
                 pacs_id=COALESCE(scheduling.radiology_orders.pacs_id, EXCLUDED.pacs_id),
                 cpacs_url=COALESCE(scheduling.radiology_orders.cpacs_url, EXCLUDED.cpacs_url),
                 updated_at=NOW()""",
          (st, mr, (str(bill_no) if bill_no is not None else None), gpb, patient_name,
           study_id, svc, (rep_real.isoformat() if rep_real else None), user_id, acc, acc_src, pid, curl,
           (rep_real.isoformat() if rep_real else None)),
          exec_only=True)
        # Mirror the filing onto the per-exam companion (#9), keyed by THIS exam's service so
        # a bundled bill's other exams keep their own state (the per-bill row above can only
        # hold one exam's study/accession). service_id '' when unknown.
        q("""INSERT INTO scheduling.radiology_exam_state
                 (gen_pat_billing_id, service_id, site, mrno, bill_no, patient_name,
                  state, study_id, ordered_at, reported_at, filed_at, filed_by, filed_source,
                  accession, accession_source, pacs_id, cpacs_url)
             VALUES (%s,%s,%s,%s,%s,%s,'filed',%s,NOW(),GREATEST(COALESCE(%s::timestamptz, NOW()), NOW()),NOW(),%s,'meena',%s,%s,%s,%s)
             ON CONFLICT (gen_pat_billing_id, service_id) DO UPDATE SET
                 state='filed', filed_at=NOW(), filed_by=EXCLUDED.filed_by, filed_source='meena',
                 study_id=COALESCE(EXCLUDED.study_id, scheduling.radiology_exam_state.study_id),
                 site=COALESCE(scheduling.radiology_exam_state.site, EXCLUDED.site),
                 bill_no=COALESCE(scheduling.radiology_exam_state.bill_no, EXCLUDED.bill_no),
                 patient_name=COALESCE(scheduling.radiology_exam_state.patient_name, EXCLUDED.patient_name),
                 reported_at=GREATEST(
                     COALESCE(%s::timestamptz, scheduling.radiology_exam_state.reported_at, NOW()),
                     COALESCE(scheduling.radiology_exam_state.ordered_at, NOW())),
                 accession=COALESCE(scheduling.radiology_exam_state.accession, EXCLUDED.accession),
                 accession_source=COALESCE(scheduling.radiology_exam_state.accession_source, EXCLUDED.accession_source),
                 pacs_id=COALESCE(scheduling.radiology_exam_state.pacs_id, EXCLUDED.pacs_id),
                 cpacs_url=COALESCE(scheduling.radiology_exam_state.cpacs_url, EXCLUDED.cpacs_url),
                 updated_at=NOW()""",
          (gpb, (svc or ''), st, mr, (str(bill_no) if bill_no is not None else None), patient_name,
           study_id, (rep_real.isoformat() if rep_real else None), user_id, acc, acc_src, pid, curl,
           (rep_real.isoformat() if rep_real else None)),
          exec_only=True)
    except Exception:
        pass

def _rad_reconcile_resolved(items):
    """Close orders that have left the live Siratech board — filed or resolved OUTSIDE
    Meena — so the Orders page stops crying wolf. Every stored 'ordered'/'reported' row
    first entered the store via the worklist, so while an order is genuinely pending the
    board keeps returning it and the upsert (which runs just before this) re-stamps its
    updated_at=NOW(). A row whose updated_at has gone stale (>5 min) has therefore dropped
    off the board → it's done. We only reconcile SITES that returned >=1 pending item in
    this very response, so a transient empty/failed fetch can never mass-close a branch.
    Reconciled rows get filed_source='external' → their (unknown) turnaround never poisons
    the Meena TAT averages. History-only: this never touches the live worklist or the HIS.
    Best-effort — a DB hiccup is swallowed."""
    if not isinstance(items, list) or not items:
        return 0
    sites = set()
    for it in items:
        s = it.get("site")
        if s is None:
            continue
        try:
            sites.add(int(s))
        except Exception:
            pass
    if not sites:
        return 0
    try:
        # Close ONLY orders the board was actively tracking that just dropped off:
        #   • stale >5 min (not on the last few boards) AND
        #   • still recently tracked (updated within 24h) AND
        #   • a report was actually seen (reported_at IS NOT NULL).
        # The reported_at guard fixes the KSA-midnight false-close: an order that is still
        # genuinely awaiting imaging (state='ordered', reported_at NULL) drops off "today's"
        # board at the date rollover for a NON-resolution reason (the client queries today
        # only), yet its updated_at is minutes-fresh — squarely inside the 5min–24h window.
        # Auto-closing it would silently vanish a pending (even STAT) order with no orphan
        # flag. "Left the board == filed elsewhere" is only a safe inference once a report
        # exists; a reported order closed here still surfaces on the orphan tab for review.
        q("""UPDATE scheduling.radiology_orders
                SET state='filed', filed_source='external',
                    filed_at=COALESCE(filed_at, NOW()), updated_at=NOW()
              WHERE site = ANY(%s) AND state IN ('ordered','reported')
                AND reported_at IS NOT NULL
                AND updated_at < NOW() - INTERVAL '5 minutes'
                AND updated_at > NOW() - INTERVAL '24 hours'""",
          (list(sites),), exec_only=True)
        # Same reconciliation on the per-exam companion (#9) so per-exam orphan detection
        # sees the same "left the board == filed elsewhere" transition.
        q("""UPDATE scheduling.radiology_exam_state
                SET state='filed', filed_source='external',
                    filed_at=COALESCE(filed_at, NOW()), updated_at=NOW()
              WHERE site = ANY(%s) AND state IN ('ordered','reported')
                AND reported_at IS NOT NULL
                AND updated_at < NOW() - INTERVAL '5 minutes'
                AND updated_at > NOW() - INTERVAL '24 hours'""",
          (list(sites),), exec_only=True)
    except Exception:
        pass
    return 0

# A verified report was seen ready (reported_at) but Meena never filed it (study_id NULL)
# and it has left the board (reconciled filed-elsewhere) — so we cannot confirm the report
# actually reached the patient file. One place, used by both the list filter and the count.
_RAD_ORPHAN_PREDICATE = ("state='filed' AND filed_source='external' "
                         "AND reported_at IS NOT NULL AND study_id IS NULL")

@app.get("/api/radiology/orders")
def radiology_orders(request: Request, user=Depends(require_radiology)):
    """RIS Phase 2 — the persisted order lifecycle store with turnaround (TAT) in
    hours. Filter by state / site / mrno. Team leads are scoped to their branch.
    Gated the same as the worklist (require_radiology) so a privileged staff member
    who can see the live board can also see its history."""
    p = request.query_params
    clauses, params = [], []
    scope = _rad_scope_site(user)
    site_scope_sql, site_scope_params = None, []
    if scope is not None:
        site_scope_sql = "site=%s"; site_scope_params = [scope]
    elif (p.get("site") or "").strip().isdigit():
        site_scope_sql = "site=%s"; site_scope_params = [int(p.get("site"))]
    if site_scope_sql:
        clauses.append(site_scope_sql); params.extend(site_scope_params)
    st = (p.get("state") or "").strip()
    if st == "orphan":
        # Orphan reports: a verified report was seen ready (reported_at set), the order
        # then left the live board and was reconciled as filed-elsewhere (filed_source
        # 'external'), yet Meena never bound/filed a study to it (study_id NULL). So a
        # report existed but we can't confirm it reached the patient file — a human must
        # verify. This is the reliable, ledger-only half of the durable-ledger fix; the
        # deterministic version (matching every report to its study) needs the vendor
        # accession feed.
        clauses.append(_RAD_ORPHAN_PREDICATE)
    elif st in ("ordered", "reported", "filed"):
        clauses.append("state=%s"); params.append(st)
    mr = (p.get("mrno") or "").strip()
    if mr:
        clauses.append("mrno=%s"); params.append(mr)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = q(f"""SELECT gen_pat_billing_id, site, mrno, bill_no, patient_name, department, doctor,
                        emergency, state, study_id, service_id, modality, filed_source, imaged_at,
                        accession, accession_source, pacs_id, cpacs_url,
                        ordered_at, reported_at, filed_at, updated_at,
                        EXTRACT(EPOCH FROM (COALESCE(reported_at, NOW()) - ordered_at))/3600 AS tat_report_h,
                        EXTRACT(EPOCH FROM (filed_at - reported_at))/3600 AS tat_file_h,
                        EXTRACT(EPOCH FROM (COALESCE(filed_at, NOW()) - ordered_at))/3600 AS tat_total_h
                 FROM scheduling.radiology_exam_state{where}
                 ORDER BY (state='filed') ASC, emergency DESC, ordered_at DESC NULLS LAST
                 LIMIT 500""", tuple(params))
    def _iso(v):
        return v.isoformat() if v is not None else None
    def _r1(v):
        return round(float(v), 1) if v is not None else None
    orders = [{
        "genPatBillingId": r["gen_pat_billing_id"], "site": r["site"], "mrno": r["mrno"],
        "billNo": r["bill_no"], "patientName": r["patient_name"], "department": r["department"],
        "doctor": r["doctor"], "emergency": r["emergency"], "state": r["state"],
        "studyId": r["study_id"], "serviceId": r["service_id"], "modality": r["modality"],
        "filedSource": r["filed_source"], "imagedAt": _iso(r["imaged_at"]),
        "accession": r["accession"], "accessionSource": r["accession_source"],
        "pacsId": r["pacs_id"], "cpacsUrl": r["cpacs_url"],
        "orderedAt": _iso(r["ordered_at"]), "reportedAt": _iso(r["reported_at"]), "filedAt": _iso(r["filed_at"]),
        "tatReportH": _r1(r["tat_report_h"]), "tatFileH": _r1(r["tat_file_h"]), "tatTotalH": _r1(r["tat_total_h"]),
    } for r in rows]
    by_state = {}
    for r in rows:
        by_state[r["state"]] = by_state.get(r["state"], 0) + 1
    # Always surface the orphan count (scope-aware) so the tab badge shows from any tab.
    ocl = [_RAD_ORPHAN_PREDICATE]
    oparams = []
    if site_scope_sql:
        ocl.append(site_scope_sql); oparams.extend(site_scope_params)
    try:
        oc = q("SELECT COUNT(*) AS n FROM scheduling.radiology_exam_state WHERE " + " AND ".join(ocl),
               tuple(oparams), one=True)
        orphan_count = int(oc["n"]) if oc and oc.get("n") is not None else 0
    except Exception:
        orphan_count = 0
    return _conditional_json(request, {"ok": True, "count": len(orders), "byState": by_state,
            "orphanCount": orphan_count, "orders": orders})

@app.get("/api/radiology/throughput")
def radiology_throughput(
    from_: str = Query("", alias="from"),
    to: str = Query(""),
    sites: str = Query(""),
    user=Depends(require_admin),
):
    """Daily imaging throughput (منجز vs ما جا) for the Statistics page, aggregated
    from the local order ledger (scheduling.radiology_orders). Read-only.

    · "imaged" is bucketed by the IMAGING date (KSA calendar day, UTC+3), NOT the
      order date — patients often arrive days after the order was placed. The
      done-signal is imaged_at; rows persisted before imaged_at existed (or filed
      without an imaging stamp) fall back to reported_at, counted in
      `fallbackReported` and noted in `basis`.
    · "noShow" = orders whose ORDER date (KSA day) falls in the range and that never
      reached imaging (imaged_at IS NULL, no report, state still 'ordered').
    Access mirrors /api/radiology/stats: require_admin, and a branch-locked team
    lead is confined to their own HIS site regardless of the `sites` param."""
    def _day(s, default):
        s = (s or "").strip()
        return s if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else default
    ksa_today = datetime.now(timezone(timedelta(hours=3))).strftime("%Y-%m-%d")
    d_to = _day(to, ksa_today)
    d_from = _day(from_, d_to[:8] + "01")
    if d_from > d_to:
        d_from, d_to = d_to, d_from
    # Cap the window at ~3 months. The UI only ever asks for one month; a hand-crafted
    # ?from=2016-01-01 would otherwise aggregate the whole ledger in one request.
    try:
        if (date.fromisoformat(d_to) - date.fromisoformat(d_from)).days > 92:
            d_from = (date.fromisoformat(d_to) - timedelta(days=92)).isoformat()
    except ValueError:                     # regex-valid but non-calendar (e.g. 2026-02-31)
        d_from = d_to
    # Branch isolation — same rule as /api/radiology/stats (_rad_scope_site).
    scope = _rad_scope_site(user)
    if scope is not None:
        site_ids = [int(scope)]
    else:
        site_ids = [int(x) for x in (sites or "").split(",") if x.strip().isdigit()]
    site_sql, site_params = "", []
    if site_ids:
        site_sql = " AND site = ANY(%s)"
        site_params = [site_ids]

    ksa = "AT TIME ZONE 'Asia/Riyadh'"
    done_rows = q(f"""
        SELECT to_char(COALESCE(imaged_at, reported_at) {ksa}, 'YYYY-MM-DD') AS day,
               modality, mrno, patient_name, bill_no, department,
               ordered_at, imaged_at, reported_at,
               (imaged_at IS NULL) AS used_reported
          FROM scheduling.radiology_exam_state
         WHERE COALESCE(imaged_at, reported_at) IS NOT NULL
           AND to_char(COALESCE(imaged_at, reported_at) {ksa}, 'YYYY-MM-DD') BETWEEN %s AND %s{site_sql}
         ORDER BY COALESCE(imaged_at, reported_at) ASC
         LIMIT 5000""", tuple([d_from, d_to] + site_params))
    noshow_rows = q(f"""
        SELECT to_char(ordered_at {ksa}, 'YYYY-MM-DD') AS day, modality
          FROM scheduling.radiology_exam_state
         WHERE ordered_at IS NOT NULL
           AND imaged_at IS NULL AND reported_at IS NULL AND state = 'ordered'
           AND to_char(ordered_at {ksa}, 'YYYY-MM-DD') BETWEEN %s AND %s{site_sql}
         LIMIT 5000""", tuple([d_from, d_to] + site_params))

    def _mods(m):
        toks = [t.strip().upper() for t in str(m or "").split(",") if t.strip()]
        return toks or ["?"]
    def _iso(v):
        return v.isoformat() if v is not None else None

    days, items, tot_by_mod, fallback = {}, [], {}, 0
    for r in done_rows:
        d = r["day"]
        bucket = days.setdefault(d, {"date": d, "imaged": 0, "byModality": {}})
        bucket["imaged"] += 1
        if r.get("used_reported"):
            fallback += 1
        for mo in _mods(r.get("modality")):
            bucket["byModality"][mo] = bucket["byModality"].get(mo, 0) + 1
            tot_by_mod[mo] = tot_by_mod.get(mo, 0) + 1
        items.append({
            "date": d, "mrno": r.get("mrno"), "patientName": r.get("patient_name"),
            "modality": r.get("modality"), "exam": None,   # exam name isn't persisted in the ledger
            "billNo": r.get("bill_no"), "department": r.get("department"),
            "orderedAt": _iso(r.get("ordered_at")),
            "imagedAt": _iso(r.get("imaged_at") or r.get("reported_at")),
            "basisReported": bool(r.get("used_reported")),
        })
    noshow = {}
    for r in noshow_rows:
        d = r["day"]
        bucket = noshow.setdefault(d, {"date": d, "count": 0, "byModality": {}})
        bucket["count"] += 1
        for mo in _mods(r.get("modality")):
            bucket["byModality"][mo] = bucket["byModality"].get(mo, 0) + 1
    return {
        "ok": True,
        "range": {"from": d_from, "to": d_to},
        "basis": ("imaged_at" if not fallback
                  else f"imaged_at (reported_at fallback for {fallback} row(s) without an imaging stamp)"),
        "fallbackReported": fallback,
        "days": [days[d] for d in sorted(days)],
        "noShow": [noshow[d] for d in sorted(noshow)],
        "totals": {"imaged": len(done_rows), "noShow": len(noshow_rows), "byModality": tot_by_mod},
        "items": items,
    }

@app.post("/api/radiology/mwl/push")
async def radiology_mwl_push(request: Request, user=Depends(require_admin)):
    """Ingest DICOM Modality Worklist entries from the on-site MWL agent (a small
    watcher on a hospital-LAN PC — the cloud can't speak DICOM to the broker). Upserts
    by accession; last_seen refreshes on every sighting so we can tell what's still on
    the broker. The accession is the deterministic order↔study↔report key that the HIS
    REST API withholds."""
    b = await request.json()
    items = b.get("items") if isinstance(b, dict) else None
    if not isinstance(items, list):
        raise HTTPException(400, "Body must be {items: [...]}")
    saved = 0
    for it in items[:200]:                     # sanity cap per push
        if not isinstance(it, dict):
            continue
        acc = str(it.get("accession") or "").strip()
        if not acc:
            continue                           # accession is the whole point — skip blanks
        try:
            q("""INSERT INTO scheduling.radiology_mwl
                     (accession, mrno, patient_name, proc_id, proc_desc, modality, station, sps_date, raw)
                 VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                 ON CONFLICT (accession) DO UPDATE SET
                     mrno=COALESCE(NULLIF(EXCLUDED.mrno,''), scheduling.radiology_mwl.mrno),
                     patient_name=COALESCE(NULLIF(EXCLUDED.patient_name,''), scheduling.radiology_mwl.patient_name),
                     proc_id=COALESCE(NULLIF(EXCLUDED.proc_id,''), scheduling.radiology_mwl.proc_id),
                     proc_desc=COALESCE(NULLIF(EXCLUDED.proc_desc,''), scheduling.radiology_mwl.proc_desc),
                     modality=COALESCE(NULLIF(EXCLUDED.modality,''), scheduling.radiology_mwl.modality),
                     station=COALESCE(NULLIF(EXCLUDED.station,''), scheduling.radiology_mwl.station),
                     sps_date=COALESCE(NULLIF(EXCLUDED.sps_date,''), scheduling.radiology_mwl.sps_date),
                     raw=COALESCE(EXCLUDED.raw, scheduling.radiology_mwl.raw),
                     last_seen=NOW()""",
              (acc, str(it.get("patientId") or "").strip(), str(it.get("patientName") or "").strip(),
               str(it.get("procId") or "").strip(), str(it.get("procDesc") or "").strip(),
               str(it.get("modality") or "").strip().upper(), str(it.get("station") or "").strip(),
               str(it.get("date") or "").strip(), json.dumps(it)[:4000]),
              exec_only=True)
            saved += 1
        except Exception:
            pass                               # one bad row never sinks the batch
    if saved:
        insert_audit(user, "RADIOLOGY_MWL_PUSH", None, json.dumps({"received": len(items), "saved": saved}))
    return {"ok": True, "received": len(items), "saved": saved}

@app.get("/api/radiology/mwl/recent")
def radiology_mwl_recent(user=Depends(require_radiology)):
    """The MWL entries we've captured, newest first — visibility while the feed is
    young: confirms what the broker actually sends (field semantics, accession shape)."""
    rows = q("""SELECT accession, mrno, patient_name, proc_id, proc_desc, modality, station,
                       sps_date, first_seen, last_seen
                FROM scheduling.radiology_mwl ORDER BY last_seen DESC LIMIT 50""") or []
    out = [{"accession": r["accession"], "mrno": r["mrno"], "patientName": r["patient_name"],
            "procId": r["proc_id"], "procDesc": r["proc_desc"], "modality": r["modality"],
            "station": r["station"], "spsDate": r["sps_date"],
            "firstSeen": r["first_seen"].isoformat() if r["first_seen"] else None,
            "lastSeen": r["last_seen"].isoformat() if r["last_seen"] else None} for r in rows]
    return {"ok": True, "count": len(out), "entries": out}

@app.get("/api/radiology/labs/pregnancy")
def radiology_labs_pregnancy(request: Request, user=Depends(require_radiology)):
    """Radiation-safety decision support: has this patient had a recent pregnancy /
    β-hCG lab, and what did it say? Read-only, best-effort — surfaces what Siratech's
    own lab module already knows so the tech/radiologist can decide before imaging.
    Never a hard block. Returns {found, verdict, resultText, testName, orderDate}."""
    import urllib.parse
    p = request.query_params
    mrno = (p.get("mrno") or "").strip()
    if not mrno:
        raise HTTPException(400, "mrno is required")
    qs = {"mrno": mrno}
    if (p.get("site") or "").strip().isdigit():
        qs["site"] = p.get("site")
    return _bridge_request("/his/labs/pregnancy?" + urllib.parse.urlencode(qs), timeout=90)

@app.get("/api/radiology/autofile/config")
def radiology_autofile_get(user=Depends(require_admin)):
    """Auto-file status: is the background worker filing verified reports into
    Siratech by itself, how often, and (best-effort) when it last filed one."""
    last = q("""SELECT target, detail, created_at FROM scheduling.audit_log
                WHERE action='RADIOLOGY_AUTOFILE' AND detail LIKE '%%\"wrote\": true%%'
                ORDER BY created_at DESC LIMIT 1""", one=True)
    return {"ok": True,
            "enabled": (get_setting("rad_autofile_enabled", "0") or "0").strip() == "1",
            "everySec": _RAD_AUTOFILE_EVERY_SEC,
            "sites": (get_setting("rad_autofile_sites", "") or "").strip(),
            "lastFiledAt": last["created_at"].isoformat() if last and last.get("created_at") else None,
            "lastFiledFile": last["target"] if last else None}

@app.post("/api/radiology/autofile/config")
async def radiology_autofile_set(request: Request, user=Depends(require_superadmin)):
    """Turn auto-file on/off (and optionally pin the branches). Superadmin only —
    this controls automatic writes into the live hospital HIS. Audited."""
    b = await request.json()
    if not isinstance(b, dict):
        raise HTTPException(400, "Invalid body")
    if "enabled" in b:
        set_setting("rad_autofile_enabled", "1" if b.get("enabled") else "0")
    if "sites" in b:
        sites = re.sub(r"[^0-9,]", "", str(b.get("sites") or ""))
        set_setting("rad_autofile_sites", sites)
    insert_audit(user, "RADIOLOGY_AUTOFILE_CONFIG", None,
                 json.dumps({"enabled": (get_setting("rad_autofile_enabled", "0") == "1"),
                             "sites": get_setting("rad_autofile_sites", "")}))
    return radiology_autofile_get(user=user)

@app.get("/api/radiology/autostamp/config")
def radiology_autostamp_get(user=Depends(require_admin)):
    """Auto-stamp status: does the background worker write the clinical indication +
    ordering doctor + priority (Others) into a DePACS study the moment its images
    arrive, for which branches, and when it last stamped one."""
    last = q("""SELECT target, detail, created_at FROM scheduling.audit_log
                WHERE action='RADIOLOGY_AUTOSTAMP' ORDER BY created_at DESC LIMIT 1""", one=True)
    return {"ok": True,
            "enabled": (get_setting("rad_autostamp_enabled", "1") or "1").strip() == "1",
            "everySec": _RAD_AUTOSTAMP_EVERY_SEC,
            "sites": (get_setting("rad_autostamp_sites", "3") or "").strip(),
            "lastStampedAt": last["created_at"].isoformat() if last and last.get("created_at") else None,
            "lastStampedFile": last["target"] if last else None}

@app.post("/api/radiology/autostamp/config")
async def radiology_autostamp_set(request: Request, user=Depends(require_superadmin)):
    """Turn auto-stamp on/off and pin the branches (default N3 / siteId 3). Superadmin
    only — this controls automatic writes into DePACS. Audited."""
    b = await request.json()
    if not isinstance(b, dict):
        raise HTTPException(400, "Invalid body")
    if "enabled" in b:
        set_setting("rad_autostamp_enabled", "1" if b.get("enabled") else "0")
    if "sites" in b:
        set_setting("rad_autostamp_sites", re.sub(r"[^0-9,]", "", str(b.get("sites") or "")))
    insert_audit(user, "RADIOLOGY_AUTOSTAMP_CONFIG", None,
                 json.dumps({"enabled": (get_setting("rad_autostamp_enabled", "1") == "1"),
                             "sites": get_setting("rad_autostamp_sites", "3")}))
    return radiology_autostamp_get(user=user)

@app.get("/api/radiology/autostamp/diagnose")
def radiology_autostamp_diagnose(request: Request, user=Depends(require_superadmin)):
    """READ-ONLY dry run of the auto-stamp matcher over the live board. Writes NOTHING —
    it replicates exactly what the sweep would decide (per study: already-has-history,
    would-stamp, or would-block + why) so the operator can see the feature is matching
    studies to orders. Superadmin-only. `limit` caps how many patients to inspect."""
    limit = max(1, min(60, int(request.query_params.get("limit") or 30)))
    data = _bridge_request("/his/worklist", timeout=90)
    if not isinstance(data, dict):
        raise HTTPException(502, "worklist unreachable")
    # Optional read-only scope override (dry run only — never touches the live setting)
    # so the operator can preview matching against a branch that has traffic right now.
    sites_override = re.sub(r"[^0-9,]", "", request.query_params.get("sites") or "")
    sites_raw = sites_override.strip() if sites_override.strip() else (get_setting("rad_autostamp_sites", "3") or "").strip()
    site_set = set(s.strip() for s in sites_raw.split(",") if s.strip()) if sites_raw else None
    n3_stations_raw = (get_setting("rad_autostamp_n3_stations", "") or "").strip()
    n3_stations = set(x.strip().upper() for x in n3_stations_raw.split(",") if x.strip())
    by_mrn = {}
    for it in (data.get("items") or []):
        if site_set is not None and str(it.get("site") or "").strip() not in site_set:
            continue
        m = str(it.get("mrno") or "").strip()
        if m:
            by_mrn.setdefault(m, []).append(it)
    ksa_now = datetime.now(timezone.utc) + timedelta(hours=3)
    fresh_days = {ksa_now.strftime("%Y%m%d"), (ksa_now - timedelta(days=1)).strftime("%Y%m%d")}
    counts = {"patients": 0, "fresh_studies": 0, "already_history": 0,
              "would_stamp": 0, "would_block": 0, "no_order_match": 0}
    block_reasons, samples = {}, []
    for mrno, orders in list(by_mrn.items())[:limit]:
        counts["patients"] += 1
        try:
            studies = _elite_studies_for_file(mrno)
        except Exception:
            continue
        fresh = [s for s in studies
                 if re.sub(r"\D", "", str(s.get("study_date") or ""))[:8] in fresh_days]
        fresh_mod_count = {}
        for _s in fresh:
            _fm = _AUTOSTAMP_MOD.get(str(_s.get("modality") or "").strip().upper())
            if _fm:
                fresh_mod_count[_fm] = fresh_mod_count.get(_fm, 0) + 1
        for s in fresh:
            counts["fresh_studies"] += 1
            smod = _AUTOSTAMP_MOD.get(str(s.get("modality") or "").strip().upper())
            s_acc = str(s.get("accession_number") or "").strip()
            acc_cand = ([o for o in orders
                         if _autostamp_order_acc(o)
                         and _elite_bare_id(_autostamp_order_acc(o)) == _elite_bare_id(s_acc)]
                        if _elite_is_real_accession(s_acc) else [])
            cand = [o for o in orders
                    if smod and _AUTOSTAMP_MOD.get(str(o.get("modality") or "").strip().upper()) == smod]
            cur_hist = str(s.get("clinical_history") or "").strip()
            n3_confirmed = (len(acc_cand) == 1
                            or (_elite_is_real_accession(s_acc) and bool(n3_stations)
                                and (_autostamp_study_station(s) or "").strip().upper() in n3_stations))
            branch_ok = (site_set is None) or n3_confirmed
            chosen = (acc_cand[0] if len(acc_cand) == 1
                      else (cand[0] if smod and fresh_mod_count.get(smod, 0) == 1 and len(cand) == 1 else None))
            verdict, reason = None, None
            if cur_hist:
                counts["already_history"] += 1; verdict = "already_history"
            elif chosen is None:
                counts["no_order_match"] += 1; verdict = "no_order_match"
            elif not branch_ok:
                counts["would_block"] += 1; verdict = "would_block"; reason = "branch_unconfirmed"
                block_reasons[reason] = block_reasons.get(reason, 0) + 1
            else:
                counts["would_stamp"] += 1; verdict = "would_stamp"
            if len(samples) < 25:
                samples.append({"mrno": mrno, "studyId": s.get("study_id"), "modality": s.get("modality"),
                                "studyAccession": s_acc, "matchedBy": ("accession" if len(acc_cand) == 1
                                else ("modality1:1" if chosen is not None else None)),
                                "verdict": verdict, "reason": reason})
    return {"ok": True, "scope_sites": sites_raw or "ALL", "counts": counts,
            "block_reasons": block_reasons, "samples": samples}

# Default worklist look-back (days) when the client picks no date. A worklist is a
# work queue: it must keep TODAY's orders AND every still-pending order from recent
# days (a pending order must not vanish at midnight just because the date rolled).
# So the default is a rolling multi-day window; the dashboard day-picker is an opt-in
# drill-down to a single day, not the default view.
_RAD_WORKLIST_DAYS_BACK = int(os.environ.get("RAD_WORKLIST_DAYS_BACK") or 1)

# ── Deferred worklist persistence ─────────────────────────────────────────────
# The worklist endpoint used to run three persist-only DB writes (upsert orders,
# upsert exam-state, reconcile resolved) INLINE before returning — so every poll
# made the operator wait on writes they never see. We hand those writes to this
# background queue instead and return the board immediately; a daemon worker drains
# it. The writes are idempotent upserts, so if the queue overflows we simply drop
# the payload — the next poll (seconds later) re-enqueues the same rows.
import queue as _queue
_rad_persist_q = _queue.Queue(maxsize=200)
_rad_persist_started = False   # True once the drain worker is running (see start_scheduler)

def _rad_persist_writes(items):
    """The three persist-only worklist writes, in order. Best-effort."""
    try:
        _rad_upsert_orders(items)
        _rad_upsert_exam_state(items)
        _rad_reconcile_resolved(items)
    except Exception:
        pass

def _rad_persist_worker():
    """Drain the deferred-write queue: persist order + exam-state, reconcile resolved.
    Best-effort — a DB hiccup on one payload never wedges the worker or the board."""
    global _rad_persist_started
    _rad_persist_started = True
    while True:
        items = _rad_persist_q.get()
        try:
            if items:
                _rad_persist_writes(items)
        finally:
            _rad_persist_q.task_done()

def _rad_persist_async(items):
    """Hand the worklist rows to the background writer so the response returns without
    waiting on persistence. If the drain worker isn't running (scheduler disabled / test
    harness), fall back to writing INLINE so the lifecycle store never silently stops.
    Drops on overflow — the writes are idempotent and re-enqueued by the next poll."""
    if not items:
        return
    if not _rad_persist_started:
        _rad_persist_writes(items)
        return
    try:
        _rad_persist_q.put_nowait(items)
    except _queue.Full:
        pass

def _rad_seed_confirmed_stages(items):
    """Fast-pass cold-open seed: flag rows that already have a DePACS-CONFIRMED verified
    report in our lifecycle store, so a brand-new browser open shows them as Final
    immediately instead of parking them in Waiting until the slow ready pass runs. Only
    state='reported' is trusted — it's written exclusively on the DePACS ready pass, so
    it's authoritative; we never seed 'imaged' (that column isn't DePACS-grounded). One
    query for the whole board. Best-effort — never breaks the worklist."""
    if not isinstance(items, list) or not items:
        return
    ids = []
    for it in items:
        try:
            g = it.get("genPatBillingId")
            if g:
                ids.append(int(g))
        except Exception:
            pass
    if not ids:
        return
    try:
        # Read PER-EXAM from the companion store (#9), so each exam of a bundled bill is
        # seeded from its OWN verified report — no more collapsing one exam's 'reported' onto
        # its siblings. Still honour the reported-vs-overlay recency guard (#19): don't seed
        # 'reported' when the operator acted on the bill AFTER the report was recorded
        # (the operator overlay's local_updated_at lives on the per-bill parent).
        rows = q("""SELECT e.gen_pat_billing_id AS gpb, e.service_id AS svc
                    FROM scheduling.radiology_exam_state e
                    LEFT JOIN scheduling.radiology_orders o
                           ON o.gen_pat_billing_id = e.gen_pat_billing_id
                    WHERE e.gen_pat_billing_id = ANY(%s) AND e.state='reported'
                      AND NOT (o.local_updated_at IS NOT NULL AND e.reported_at IS NOT NULL
                               AND o.local_updated_at > e.reported_at)""", (ids,)) or []
        reported = {(r["gpb"], r["svc"] or "") for r in rows}
        if not reported:
            return
        for it in items:
            try:
                g = int(it.get("genPatBillingId")) if it.get("genPatBillingId") else None
            except Exception:
                g = None
            if g is None:
                continue
            svc = str(it.get("svcId") if it.get("svcId") is not None else "").strip()
            if (g, svc) in reported:
                it["stageConfirmed"] = "reported"
    except Exception:
        pass

# ── Worklist response cache ───────────────────────────────────────────────────
# Short server-side cache keyed by (scope, date range, pass kind). The Node connector
# already caches the HIS fetch, but every worklist request also re-runs the DB annotate
# reads (seed/consent/overlay); with many tabs/operators polling the same branch that's
# repeated DB work for an identical board. Caching the FINAL annotated payload for a few
# seconds collapses that to one build per window. Bypassed by ?nocache=1 (the client
# forces it right after an action and periodically), so an operator's own change is never
# served stale to themselves. Keyed by the scoped sites, so a branch-locked team lead can
# only ever hit their own branch's entry — no cross-branch leak.
_wl_cache = {}   # key -> (monotonic_ts, data)
_WL_CACHE_TTL_FAST = float(os.environ.get("WL_CACHE_TTL_FAST") or 10.0)
_WL_CACHE_TTL_HEAVY = float(os.environ.get("WL_CACHE_TTL_HEAVY") or 60.0)

# Fields that change every response even when the CONTENT is identical — excluded from the
# ETag so an unchanged board/list still matches and returns a tiny 304.
_ETAG_VOLATILE = ("generatedAt", "fetchedAt", "builtAt", "at", "_timings", "mirror")

def _conditional_json(request: Request, payload):
    """Serve `payload` as JSON with a content ETag. When the client's If-None-Match matches
    (nothing changed since its last poll) return a ~0-byte 304 instead of resending the whole
    body — a real bandwidth cut on a board that polls every 10-30s. The app keeps its no-store
    policy (no PHI on the workstation disk); the client holds the last body in memory and
    reuses it on 304. Any failure falls back to a normal 200 so ETag can never break a page."""
    try:
        src = {k: v for k, v in payload.items() if k not in _ETAG_VOLATILE} if isinstance(payload, dict) else payload
        raw = json.dumps(src, default=str, sort_keys=True, separators=(",", ":")).encode()
        etag = 'W/"' + hashlib.md5(raw).hexdigest() + '"'
    except Exception:
        return JSONResponse(payload)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-store"})
    return JSONResponse(payload, headers={"ETag": etag, "Cache-Control": "no-store"})

# ── Live worklist MIRROR ──────────────────────────────────────────────────────
# A background loop copies the default all-branches fast board out of Siratech into
# scheduling.worklist_mirror every few seconds. The endpoint below then serves that DB row
# (~a few ms) for the common request instead of proxying to the 2 GB HIS box, with the live
# proxy as the fallback whenever the mirror is cold/stale. Our OWN fast-changing state
# (consent-filed, the received/started/completed overlay, confirmed stages) is applied fresh
# at SERVE time, not stored in the mirror, so a tech's own action still reflects instantly.
# GENTLE + self-throttling: rides the connector's existing cache (never forces a fresh HIS
# fan-out — that's what overloaded the box before) and a circuit-breaker loop backs off the
# instant the box is slow. Safe to leave ON.
_MIRROR_ENABLED = (os.environ.get("WORKLIST_MIRROR", "1") == "1")
_MIRROR_INTERVAL = float(os.environ.get("WORKLIST_MIRROR_INTERVAL") or 30.0)        # base seconds between refreshes
_MIRROR_MAX_INTERVAL = float(os.environ.get("WORKLIST_MIRROR_MAX_INTERVAL") or 240.0)  # backoff ceiling when the box is slow
_MIRROR_SLOW_SECS = float(os.environ.get("WORKLIST_MIRROR_SLOW_SECS") or 6.0)       # a tick slower than this = box strained → back off
_MIRROR_MAX_AGE = float(os.environ.get("WORKLIST_MIRROR_MAX_AGE") or 300.0)         # older than this → serve live instead (must exceed _MIRROR_MAX_INTERVAL so a backed-off-but-healthy mirror still serves)

def _wl_default_from():
    ksa_today = (datetime.now(timezone.utc) + timedelta(hours=3)).date()
    return (ksa_today - timedelta(days=_RAD_WORKLIST_DAYS_BACK)).isoformat()

def _wl_mirror_key(frm, to):
    return f"{frm or ''}|{to or ''}"

def _worklist_mirror_tick():
    """One GENTLE refresh: read the board the way an operator would — WITHOUT forcing fresh —
    so it rides the connector's existing cache (near-zero HIS load when the board is already
    warm from operator polls / the connector's own warmer; the earlier version forced a fresh
    fan-out every tick, which is what overloaded the box). Returns True if it actually reached
    the connector (so the loop can time the box's health), False if it skipped."""
    frm = _wl_default_from()
    mkey = _wl_mirror_key(frm, "")
    try:
        row = q("SELECT fetched_at FROM scheduling.worklist_mirror WHERE scope_key=%s", (mkey,), one=True)
        if row and row.get("fetched_at"):
            age = (datetime.now(timezone.utc) - row["fetched_at"]).total_seconds()
            if age < _MIRROR_INTERVAL * 0.7:
                return False  # a sibling worker just refreshed it — don't pile on
    except Exception:
        pass
    import urllib.parse
    # NO nocache — copying what's already computed is the whole point of "gentle".
    query = "?" + urllib.parse.urlencode({"from": frm})
    data = _bridge_request("/his/worklist" + query, timeout=60)
    if not isinstance(data, dict) or data.get("items") is None:
        return True  # reached the connector but nothing usable — keep the last good mirror row
    try:
        _rad_persist_async(data.get("items"))   # keep the lifecycle store advancing off the board
    except Exception:
        pass
    q("""INSERT INTO scheduling.worklist_mirror (scope_key, payload, fetched_at)
         VALUES (%s, %s::jsonb, NOW())
         ON CONFLICT (scope_key) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=NOW()""",
      (mkey, json.dumps(data)), exec_only=True)
    return True

def _worklist_mirror_loop():
    """Adaptive/circuit-breaker cadence: base ~30s when the box is healthy, but the moment a
    tick runs slow (or errors) it backs off exponentially up to a ceiling, then eases back as
    the box recovers. Slow-start + jitter so it never herds or slams a recovering box."""
    import time as _t, random as _r
    _t.sleep(12)                                          # let the app boot / caches warm first
    cur = min(_MIRROR_INTERVAL * 2, _MIRROR_MAX_INTERVAL)  # slow start — ramp up only as it proves healthy
    while True:
        t0 = _t.monotonic()
        try:
            hit = _worklist_mirror_tick()
            dur = _t.monotonic() - t0
            if hit and dur > _MIRROR_SLOW_SECS:
                cur = min(cur * 2, _MIRROR_MAX_INTERVAL)   # box strained → back off (circuit breaker)
                try: print(f"[mirror] slow tick {dur:.1f}s → backing off to {cur:.0f}s", flush=True)
                except Exception: pass
            else:
                cur = max(_MIRROR_INTERVAL, cur * 0.7)     # healthy → ease back toward base cadence
        except Exception as e:
            cur = min(max(cur, _MIRROR_INTERVAL) * 2, _MIRROR_MAX_INTERVAL)   # error → back off hard
            try: print("[mirror] tick failed → backing off to", round(cur), "s:", str(e)[:160], flush=True)
            except Exception: pass
        _t.sleep(cur * (0.8 + 0.4 * _r.random()))          # ±20% jitter

def _start_worklist_mirror():
    if not _MIRROR_ENABLED:
        return
    threading.Thread(target=_worklist_mirror_loop, daemon=True, name="worklist-mirror").start()

def _serve_worklist_from_mirror(request: Request, mkey: str, scope):
    """Return a _conditional_json Response from the mirror row for `mkey`, or None to signal
    the caller to fall through to the live proxy (mirror missing / stale / disabled). `scope`
    is a team lead's site (None for org-wide) — the mirror holds every branch, so we filter."""
    if not _MIRROR_ENABLED:
        return None
    try:
        row = q("SELECT payload, fetched_at FROM scheduling.worklist_mirror WHERE scope_key=%s", (mkey,), one=True)
    except Exception:
        return None
    if not row or not row.get("payload") or not row.get("fetched_at"):
        return None
    if (datetime.now(timezone.utc) - row["fetched_at"]).total_seconds() > _MIRROR_MAX_AGE:
        return None
    data = row["payload"]
    if isinstance(data, str):                     # some psycopg2 configs return jsonb as text
        try:
            data = json.loads(data)
        except Exception:
            return None
    if not isinstance(data, dict):
        return None
    items = data.get("items")
    # Apply our always-fresh local state now (not at mirror time) so own actions are instant.
    try:
        _rad_seed_confirmed_stages(items)
        _annotate_worklist_consent(items)
        _annotate_worklist_overlay(items)
    except Exception:
        pass
    if scope is not None and isinstance(items, list):
        filtered = [it for it in items if str(it.get("site")) == str(scope)]
        data = {**data, "items": filtered, "count": len(filtered)}
    data["mirror"] = True   # so the client/debug can tell this was served from the mirror
    return _conditional_json(request, data)

@app.get("/api/radiology/worklist")
def radiology_worklist(request: Request, user=Depends(require_radiology)):
    """Live RIS worklist — every radiology order awaiting a result across the
    requested branches (emergency first, oldest first, with TAT age). ?ready=1
    also flags which orders have a VERIFIED DePACS report ready to file (slower).
    Team leads are scoped to their own branch."""
    import urllib.parse
    p = request.query_params
    qs = {}
    # Branch isolation: a branch-locked team lead is confined to their own HIS site;
    # superadmin/manager (scope None) keep the client's picker.
    scope = _rad_scope_site(user)
    if scope is not None:
        qs["sites"] = str(scope)
    elif (p.get("sites") or "").strip():
        qs["sites"] = p.get("sites").strip()
    for k in ("from", "to", "ready", "readyLimit", "modality", "pay", "nocache", "src"):
        if (p.get(k) or "").strip():
            qs[k] = p.get(k).strip()
    # A worklist is "what's pending NOW", not a 2-week archive. If the client didn't
    # pick a range, default the look-back to a short operational window (KSA date) so
    # the board is fast and free of stale old orders. Widen with ?from=/?to=.
    if "from" not in qs:
        ksa_today = (datetime.now(timezone.utc) + timedelta(hours=3)).date()
        qs["from"] = (ksa_today - timedelta(days=_RAD_WORKLIST_DAYS_BACK)).isoformat()
    query = ("?" + urllib.parse.urlencode(qs)) if qs else ""
    # ready=1 (per-patient match) and modality=1 (per-order RadiologyDetails) both do
    # heavy per-order HIS work — give them the long timeout.
    heavy = p.get("ready") == "1" or p.get("modality") == "1" or p.get("pay") == "1"
    # ── LIVE MIRROR fast-path ─────────────────────────────────────────────────────
    # The default fast board is kept warm in our DB by the mirror loop. For that scope
    # (fast pass, and the client isn't forcing fresh) serve it from the DB in a few ms
    # instead of proxying to HIS. Team leads are served the same board filtered to their
    # site. Any miss/staleness returns None → we fall straight through to the live path.
    # The mirror holds the DEFAULT board (now the fast RIS-panel board — the connector's
    # WORKLIST_SOURCE default). A client that leaves src unset, or explicitly asks for the
    # RIS board, gets the warm mirror; only a non-default source (e.g. src=search, the legacy
    # slow board escape hatch) bypasses it so it isn't served the wrong board.
    _src = (qs.get("src") or "").lower()
    if not heavy and qs.get("nocache") != "1" and _src in ("", "ris"):
        _mkey = _wl_mirror_key(qs.get("from", ""), qs.get("to", ""))
        _mret = _serve_worklist_from_mirror(request, _mkey, scope)
        if _mret is not None:
            return _mret
    # 130s fast-pass ceiling: comfortably above the worst-case headless HIS-login refresh
    # (~90-100s, once per ~55min token lapse) so a token refresh racing a poll shows the
    # board, not the retry card. Steady polls return from the 60s worklist cache anyway.
    import time as _time
    # Serve an identical board from the short cache (unless the client asked for fresh).
    nocache = qs.get("nocache") == "1"
    ck = (qs.get("sites", ""), qs.get("from", ""), qs.get("to", ""),
          qs.get("ready", ""), qs.get("modality", ""), qs.get("pay", ""), _src)
    ttl = _WL_CACHE_TTL_HEAVY if heavy else _WL_CACHE_TTL_FAST
    if not nocache:
        hit = _wl_cache.get(ck)
        if hit and (_time.monotonic() - hit[0]) < ttl:
            return _conditional_json(request, hit[1])
    _t_bridge = _time.perf_counter()
    data = _bridge_request("/his/worklist" + query, timeout=240 if heavy else 130)
    _bridge_ms = int((_time.perf_counter() - _t_bridge) * 1000)
    # RIS Phase 2: persist the lifecycle store off the live board. Best-effort — a DB
    # hiccup never breaks the worklist view. On a ?ready=1 pass readyToFile is known,
    # so orders promote ordered → reported here.
    _t_post = _time.perf_counter()
    try:
        if isinstance(data, dict):
            # Fast pass only: seed DePACS-confirmed Final from the store so cold opens paint
            # reported rows correctly without waiting on the ready pass. The heavy ready pass
            # already carries authoritative stage, so it doesn't need (or want) the seed.
            if not heavy:
                _rad_seed_confirmed_stages(data.get("items"))
            # RESPONSE-MUTATING READS stay inline (the client needs them on this paint):
            # consent-on-file flags and the Meena-local overlay (received/started/completed).
            _annotate_worklist_consent(data.get("items"))
            _annotate_worklist_overlay(data.get("items"))
            # PERSIST-ONLY WRITES go to the background queue so the operator never waits on
            # them. Idempotent upserts, so a continuously-polled board self-heals; seed/overlay
            # above therefore reflect the PREVIOUS poll's write (acceptable — a brand-new order
            # has no local overlay/Final to seed yet).
            _rad_persist_async(data.get("items"))
    except Exception:
        pass
    _post_ms = int((_time.perf_counter() - _t_post) * 1000)
    # Perf baseline: log slow worklist responses split into bridge (HIS/connector) vs
    # in-process post-work, so we can tell WHERE the time goes.
    if _bridge_ms + _post_ms > 1500:
        try:
            kind = "ready" if p.get("ready") == "1" else "modality" if p.get("modality") == "1" else "fast"
            n = len(data.get("items") or []) if isinstance(data, dict) else 0
            print(f"[worklist] {kind} bridge={_bridge_ms}ms post={_post_ms}ms rows={n}", flush=True)
        except Exception:
            pass
    # Cache the fully-annotated board for the next few seconds of pollers on this scope.
    if isinstance(data, dict):
        _wl_cache[ck] = (_time.monotonic(), data)
        if len(_wl_cache) > 128:                       # bound memory: drop the oldest entry
            try:
                del _wl_cache[min(_wl_cache, key=lambda k: _wl_cache[k][0])]
            except (ValueError, KeyError):
                pass
    return _conditional_json(request, data)

@app.get("/api/radiology/diag/board-timing")
def diag_board_timing(request: Request, user=Depends(require_admin)):
    """Definitive 'where does the time go' probe for the worklist. Measures each layer of the
    real request path once and returns a plain-ms breakdown, so we can PROVE whether the delay
    is the network hop, the connector, the Siratech fan-out, or our own processing. Forces one
    fresh (nocache) build — run it on demand, not in a loop."""
    import time as _t, urllib.parse
    out = {"ok": True, "layers_ms": {}, "connector_build_ms": {}, "notes": {}}
    # ?src=ris tests the FAST RIS-panel board; default tests the current search board.
    src = (request.query_params.get("src") or "").strip().lower()

    # 1) Pure network round-trip to the connector (cheap /health — no HIS work).
    t = _t.perf_counter()
    try:
        h = _bridge_request("/his/health", timeout=15)
        out["layers_ms"]["network_ping_to_connector"] = round((_t.perf_counter() - t) * 1000)
        out["notes"]["connector_loggedIn"] = bool(isinstance(h, dict) and h.get("loggedIn"))
    except Exception as e:
        out["layers_ms"]["network_ping_to_connector"] = None
        out["notes"]["ping_error"] = str(e)[:200]

    # 2) One FRESH worklist build (nocache) — the whole fast board, end to end.
    frm = _wl_default_from()
    _qs = {"from": frm, "nocache": "1"}
    if src:
        _qs["src"] = src
    # ?ready=1 also runs the heavy DePACS "imaged/reported" enrichment (the background pass the
    # board fires after first paint) so we can verify server-side how many rows PACS marks imaged.
    _ready = (request.query_params.get("ready") or "").strip() == "1"
    if _ready:
        _qs["ready"] = "1"
    out["notes"]["source"] = src or "search"
    out["notes"]["ready"] = _ready
    t = _t.perf_counter()
    try:
        data = _bridge_request("/his/worklist?" + urllib.parse.urlencode(_qs), timeout=180)
    except Exception as e:
        out["ok"] = False
        out["error"] = f"worklist build failed: {str(e)[:200]}"
        return out
    bridge_ms = round((_t.perf_counter() - t) * 1000)
    out["layers_ms"]["bridge_roundtrip_total"] = bridge_ms
    # A few sample rows (real data — admin only) so the RIS board's contents can be eyeballed.
    try:
        _items = (data.get("items") or []) if isinstance(data, dict) else []
        out["sample_rows"] = [{
            "mrno": it.get("mrno"), "patientName": it.get("patientName"), "exam": it.get("exam"),
            "modality": it.get("modality"), "doctorName": it.get("doctorName"),
            "hisStatus": it.get("hisStatus"), "stage": it.get("stage"), "billingStatus": it.get("billingStatus"),
            "billNo": it.get("billNo"), "orderKey": it.get("genPatBillingId"),
            "orderedDate": it.get("orderedDate"),
            "technicianName": it.get("technicianName"), "radiologistName": it.get("radiologistName"),
            "emergency": it.get("emergency"), "branch": it.get("branch"),
            "scanned": it.get("scanned"), "_raw": it.get("_raw"),
        } for it in _items[:5]]
        out["notes"]["total_rows"] = len(_items)
        # Stage/lane distribution — how many rows are ordered vs imaged (Pending Report) vs
        # reported after this build. With ready=1 this shows whether the DePACS pass moved any
        # non-reported exam into 'imaged'. `scanned`/`readyToFile` counts help spot a PACS miss.
        _stage_counts, _scanned_n, _ready_n = {}, 0, 0
        for it in _items:
            st = str(it.get("stage") or "none")
            _stage_counts[st] = _stage_counts.get(st, 0) + 1
            if it.get("scanned"):
                _scanned_n += 1
            if it.get("readyToFile"):
                _ready_n += 1
        out["stage_counts"] = _stage_counts
        out["notes"]["readyChecked"] = (data.get("readyChecked") if isinstance(data, dict) else None)
        out["notes"]["scanned_rows"] = _scanned_n
        out["notes"]["readyToFile_rows"] = _ready_n
        _tmg = (data.get("_timings") or {}) if isinstance(data, dict) else {}
        if _tmg.get("statusHistogram"):
            out["status_histogram"] = _tmg.get("statusHistogram")
        # Also surface a few rows that ARE further along (arrived/scanned/has-radiologist), so we
        # see their status codes directly even if the top-5 are all freshly ordered.
        _adv = [it for it in _items if it.get("scanned") or it.get("radiologistName")
                or (it.get("_raw") or {}).get("arrivalDate")][:5]
        if _adv:
            out["sample_advanced_rows"] = [{
                "mrno": it.get("mrno"), "exam": it.get("exam"), "stage": it.get("stage"),
                "hisStatus": it.get("hisStatus"), "radiologistName": it.get("radiologistName"),
                "scanned": it.get("scanned"), "_raw": it.get("_raw"),
            } for it in _adv]
    except Exception:
        pass

    conn = (data.get("_timings") or {}) if isinstance(data, dict) else {}
    out["connector_build_ms"] = {
        "siratech_bulk_fanout": conn.get("bulkMs"),      # RadiologySearch + RIS-panel across all branches
        "modality_pass": conn.get("modalityMs"),
        "ready_depacs_pass": conn.get("readyMs"),
        "pay_pass": conn.get("payMs"),
        "connector_total": conn.get("totalMs"),
    }
    # Per-call Siratech latency — the key to separating "Siratech answers slowly" from
    # "the connector box can't run the calls in parallel".
    out["per_siratech_call_ms"] = {
        "concurrency": conn.get("concurrency"),
        "radiology_search": conn.get("searchCall"),   # {n, avg, max, min, sum}
        "ris_panel": conn.get("panelCall"),
    }
    out["notes"]["rows"] = conn.get("rows")
    out["notes"]["branches_queried"] = conn.get("sites")
    # Field NAMES of each Siratech source (no patient data) — to judge whether the FAST
    # FetchRISPanel could replace the SLOW RadiologySearch as the board's row source.
    out["source_fields"] = {
        "radiology_search_SLOW": conn.get("searchFields"),
        "ris_panel_FAST": conn.get("panelFields"),
    }
    conn_total = conn.get("totalMs")
    if conn_total is not None:
        # bridge round-trip minus the connector's own build time ≈ the network/transport hop.
        out["layers_ms"]["network_hop_app_to_connector"] = max(0, bridge_ms - conn_total)

    # 3) Our own local post-processing (the DB annotate reads we add on every serve).
    items = data.get("items") if isinstance(data, dict) else None
    t = _t.perf_counter()
    try:
        _rad_seed_confirmed_stages(items)
        _annotate_worklist_consent(items)
        _annotate_worklist_overlay(items)
    except Exception:
        pass
    out["layers_ms"]["our_local_processing"] = round((_t.perf_counter() - t) * 1000)

    # 4) Plain-English verdict: the single biggest contributor.
    contributors = {
        "Siratech HIS fan-out": conn.get("bulkMs") or 0,
        "Siratech modality pass": conn.get("modalityMs") or 0,
        "Siratech DePACS pass": conn.get("readyMs") or 0,
        "Network to Saudi VPS": out["layers_ms"].get("network_hop_app_to_connector") or 0,
        "Our processing": out["layers_ms"].get("our_local_processing") or 0,
    }
    worst = max(contributors, key=contributors.get)
    # Diagnose the CAUSE inside the fan-out: is each Siratech call slow, or is the connector
    # box failing to parallelise them?
    sc = conn.get("searchCall") or {}
    pc = conn.get("panelCall") or {}
    per_call_avg = max(sc.get("avg") or 0, pc.get("avg") or 0)
    bulk = conn.get("bulkMs") or 0
    conc = conn.get("concurrency") or 1
    n_calls = (sc.get("n") or 0) + (pc.get("n") or 0)
    ideal = (((sc.get("sum") or 0) + (pc.get("sum") or 0)) / conc) if conc else bulk   # if perfectly parallel
    cause = None
    if bulk:
        if per_call_avg >= 1500:
            cause = (f"SIRATECH is slow ANSWERING each call (avg ~{per_call_avg} ms per branch call). "
                     f"A bigger/faster Siratech server would fix this.")
        elif ideal and bulk > ideal * 1.8:
            cause = (f"The CONNECTOR box isn't running the calls in parallel — each call averages only "
                     f"~{per_call_avg} ms, but they queued up ({n_calls} calls, concurrency {conc}, "
                     f"ideal ~{round(ideal)} ms vs actual {bulk} ms). A stronger connector box (CPU) or higher "
                     f"concurrency would fix this.")
        else:
            cause = (f"Spread across {n_calls} Siratech calls (avg ~{per_call_avg} ms each, concurrency {conc}).")
    out["verdict"] = {
        "biggest_delay": worst,
        "biggest_delay_ms": contributors[worst],
        "root_cause": cause,
        "summary": f"The worklist took ~{bridge_ms} ms end-to-end; the largest single cost is '{worst}' "
                   f"(~{contributors[worst]} ms). Our own processing was ~{out['layers_ms'].get('our_local_processing')} ms.",
    }
    return out

def _annotate_worklist_consent(items):
    """Flag which worklist patients already have a SIGNED consent on file, so the board
    can prompt for a female patient's non-pregnancy consent BEFORE imaging. One query
    for the whole board."""
    if not isinstance(items, list) or not items:
        return
    files = list({str(it.get("mrno")) for it in items if it.get("mrno")})
    if not files:
        return
    try:
        # A non-pregnancy consent is per-exam / per-visit (pregnancy status changes over
        # time), so ANY-signed-consent-ever must NOT suppress the prompt for a later exam.
        # Treat the prompt as satisfied only when THIS exam's bill already has a signed
        # consent, or a consent was signed very recently (same visit / 3-day window).
        rows = q("""SELECT file_no, bill_no,
                           (signed_at > NOW() - INTERVAL '3 days') AS recent,
                           COALESCE(filed_siratech,false) AS filed
                    FROM scheduling.consents
                    WHERE file_no = ANY(%s) AND status='signed' AND pdf IS NOT NULL""",
                 (files,)) or []
        bills_by_file, recent_files = {}, set()
        filed_bills_by_file, filed_recent = {}, set()   # only the ones CONFIRMED on the Siratech file
        for r in rows:
            fn = r["file_no"]
            bn = str(r.get("bill_no") or "").strip()
            if bn:
                bills_by_file.setdefault(fn, set()).add(bn)
                if r.get("filed"):
                    filed_bills_by_file.setdefault(fn, set()).add(bn)
            if r.get("recent"):
                recent_files.add(fn)
                if r.get("filed"):
                    filed_recent.add(fn)
        for it in items:
            fn = str(it.get("mrno"))
            bill = str(it.get("billNo") or "").strip()
            it["consentOnFile"] = (fn in recent_files) or bool(bill and bill in bills_by_file.get(fn, set()))
            # consentFiled = confirmed ON the Siratech record (not just signed in Meena),
            # so the board can show "on file ✓" vs "signed, filing…".
            it["consentFiled"] = (fn in filed_recent) or bool(bill and bill in filed_bills_by_file.get(fn, set()))
    except Exception:
        pass

# ── RIS Phase 2: operator workflow overlay ────────────────────────────────────
def _annotate_worklist_overlay(items):
    """Merge Meena's local workflow overlay (receive / start / complete / assign tech /
    note / cancel) onto the live board by genPatBillingId — one query for the whole
    board. These operator-driven fields are Meena-owned and layered on the read-only HIS
    mirror; they are never written back to Siratech."""
    if not isinstance(items, list) or not items:
        return
    ids = []
    for it in items:
        try:
            g = it.get("genPatBillingId")
            if g:
                ids.append(int(g))
        except Exception:
            pass
    if not ids:
        return
    try:
        rows = q("""SELECT gen_pat_billing_id, local_status, received_at, started_at,
                           completed_at, assigned_tech_id, assigned_tech_name, note,
                           cancel_reason, local_updated_at
                    FROM scheduling.radiology_orders
                    WHERE gen_pat_billing_id = ANY(%s)""", (ids,)) or []
        by = {r["gen_pat_billing_id"]: r for r in rows}
        def _iso(v):
            return v.isoformat() if v else None
        for it in items:
            try:
                g = int(it.get("genPatBillingId")) if it.get("genPatBillingId") else None
            except Exception:
                g = None
            r = by.get(g)
            if not r:
                continue
            it["localStatus"]      = r.get("local_status")
            it["receivedAt"]       = _iso(r.get("received_at"))
            it["startedAt"]        = _iso(r.get("started_at"))
            it["completedAt"]      = _iso(r.get("completed_at"))
            it["assignedTechId"]   = r.get("assigned_tech_id")
            it["assignedTechName"] = r.get("assigned_tech_name")
            it["note"]             = r.get("note")
            it["cancelReason"]     = r.get("cancel_reason")
            it["localUpdatedAt"]   = _iso(r.get("local_updated_at"))
    except Exception:
        pass

def _rad_assert_order_scope(gpb, user, body_site=None):
    """Branch isolation for the workflow WRITE endpoints (كل فرع لفرعه). The read paths
    all scope by _rad_scope_site; the overlay writes address an order purely by its
    gen_pat_billing_id, so without this a branch-locked operator could mutate/cancel an
    order in another branch just by supplying its gpb. Org-wide roles (scope None) are
    unrestricted. For a branch-locked caller we fail CLOSED: the order must already be
    known to belong to their site (the board persists every order it shows, with its
    site), otherwise we refuse rather than trust the client-supplied site."""
    scope = _rad_scope_site(user)
    if scope is None:
        return
    row = q("SELECT site FROM scheduling.radiology_orders WHERE gen_pat_billing_id=%s", (int(gpb),), one=True)
    order_site = row.get("site") if row else None
    try:
        ok = order_site is not None and int(order_site) == int(scope)
    except Exception:
        ok = False
    if not ok:
        raise HTTPException(403, "This order belongs to another branch")

def _rad_overlay_apply(gpb, user, set_sql, set_params=(), mrno=None, site=None, patient_name=None,
                       block_if_cancelled=False):
    """UPSERT the local workflow overlay for ONE order (keyed by gen_pat_billing_id).
    Inserts a minimal row first if the board never persisted this order yet (mrno is
    NOT NULL, so fall back to the order key), then applies the operator's field change.
    local_by + local_updated_at are always stamped. `set_sql` is a fixed per-route
    literal (never user input) so it carries no injection risk; values ride `set_params`.
    `block_if_cancelled` makes a progress action refuse to silently resurrect a Not-Done
    order (see the receive/start/complete routes)."""
    gpb = int(gpb)
    # Enforce branch isolation before any write (see _rad_assert_order_scope).
    _rad_assert_order_scope(gpb, user, body_site=site)
    if block_if_cancelled:
        cur = q("SELECT local_status FROM scheduling.radiology_orders WHERE gen_pat_billing_id=%s",
                (gpb,), one=True)
        if cur and cur.get("local_status") == "cancelled":
            raise HTTPException(409, "This order is marked Not Done. Reopen it before changing its status.")
    mr = str(mrno) if mrno else str(gpb)
    try:
        st = int(site) if site is not None and str(site).strip() != "" else None
    except Exception:
        st = None
    q("""INSERT INTO scheduling.radiology_orders (mrno, gen_pat_billing_id, site, patient_name, state)
         VALUES (%s,%s,%s,%s,'ordered')
         ON CONFLICT (gen_pat_billing_id) DO NOTHING""",
      (mr, gpb, st, patient_name), exec_only=True)
    q(f"""UPDATE scheduling.radiology_orders
             SET {set_sql}, local_by=%s, local_updated_at=NOW(), updated_at=NOW()
           WHERE gen_pat_billing_id=%s""",
      (*set_params, user.get("id"), gpb), exec_only=True)

async def _rad_body(request):
    try:
        b = await request.json()
        return b if isinstance(b, dict) else {}
    except Exception:
        return {}

@app.post("/api/radiology/orders/{gpb}/receive")
async def radiology_order_receive(gpb: int, request: Request, user=Depends(require_radiology)):
    """Mark the patient as received/arrived at the department (Meena overlay)."""
    b = await _rad_body(request)
    _rad_overlay_apply(gpb, user,
        "received_at=COALESCE(received_at, NOW()), local_status='received'",
        (), mrno=b.get("mrno"), site=b.get("site"), patient_name=b.get("patientName"),
        block_if_cancelled=True)
    insert_audit(user, "RADIOLOGY_RECEIVE", str(b.get("mrno") or gpb), json.dumps({"gpb": gpb}))
    return {"ok": True}

@app.post("/api/radiology/orders/{gpb}/start")
async def radiology_order_start(gpb: int, request: Request, user=Depends(require_radiology)):
    """Mark the exam started / in progress (Meena overlay)."""
    b = await _rad_body(request)
    _rad_overlay_apply(gpb, user,
        "started_at=COALESCE(started_at, NOW()), received_at=COALESCE(received_at, NOW()), local_status='in_progress'",
        (), mrno=b.get("mrno"), site=b.get("site"), patient_name=b.get("patientName"),
        block_if_cancelled=True)
    insert_audit(user, "RADIOLOGY_START", str(b.get("mrno") or gpb), json.dumps({"gpb": gpb}))
    return {"ok": True}

@app.post("/api/radiology/orders/{gpb}/complete")
async def radiology_order_complete(gpb: int, request: Request, user=Depends(require_radiology)):
    """Mark the exam completed / imaged (Meena overlay). Does NOT file the report — that
    stays the auto-file / results-file path into Siratech."""
    b = await _rad_body(request)
    _rad_overlay_apply(gpb, user,
        "completed_at=COALESCE(completed_at, NOW()), local_status='completed'",
        (), mrno=b.get("mrno"), site=b.get("site"), patient_name=b.get("patientName"),
        block_if_cancelled=True)
    insert_audit(user, "RADIOLOGY_COMPLETE", str(b.get("mrno") or gpb), json.dumps({"gpb": gpb}))
    return {"ok": True}

@app.post("/api/radiology/orders/{gpb}/assign")
async def radiology_order_assign(gpb: int, request: Request, user=Depends(require_radiology)):
    """Assign (or clear) the technologist for this order (Meena overlay). The frontend
    sends the picked staff's id + display name; passing neither clears the assignment."""
    b = await _rad_body(request)
    tech_id = b.get("staff_id")
    try:
        tech_id = int(tech_id) if tech_id not in (None, "") else None
    except Exception:
        tech_id = None
    tech_name = (str(b.get("tech_name") or "").strip() or None)
    _rad_overlay_apply(gpb, user,
        "assigned_tech_id=%s, assigned_tech_name=%s", (tech_id, tech_name),
        mrno=b.get("mrno"), site=b.get("site"), patient_name=b.get("patientName"))
    insert_audit(user, "RADIOLOGY_ASSIGN", str(b.get("mrno") or gpb),
                 json.dumps({"gpb": gpb, "staff_id": tech_id, "tech_name": tech_name}))
    return {"ok": True}

@app.post("/api/radiology/orders/{gpb}/note")
async def radiology_order_note(gpb: int, request: Request, user=Depends(require_radiology)):
    """Attach a free-text operational note to this order (Meena overlay — stored locally,
    NOT written into the DePACS study; that stays the handoff write-history path)."""
    b = await _rad_body(request)
    note = str(b.get("note") or "").strip()
    if not note:
        raise HTTPException(400, "A note is required")
    _rad_overlay_apply(gpb, user, "note=%s", (note[:2000],),
        mrno=b.get("mrno"), site=b.get("site"), patient_name=b.get("patientName"))
    insert_audit(user, "RADIOLOGY_NOTE", str(b.get("mrno") or gpb), json.dumps({"gpb": gpb}))
    return {"ok": True}

@app.post("/api/radiology/orders/{gpb}/cancel")
async def radiology_order_cancel(gpb: int, request: Request, user=Depends(require_radiology_write)):
    """Mark the order Not Done with a reason (Meena overlay ONLY — this is never written
    back to Siratech). Auto-file / reconcile skip a locally-cancelled order, so this has a
    filing consequence and is a privileged write (require_radiology_write, not view-only)."""
    b = await _rad_body(request)
    reason = str(b.get("reason") or "").strip()
    if not reason:
        raise HTTPException(400, "A reason is required to mark an order not done")
    _rad_overlay_apply(gpb, user, "local_status='cancelled', cancel_reason=%s", (reason[:500],),
        mrno=b.get("mrno"), site=b.get("site"), patient_name=b.get("patientName"))
    insert_audit(user, "RADIOLOGY_CANCEL", str(b.get("mrno") or gpb),
                 json.dumps({"gpb": gpb, "reason": reason}))
    return {"ok": True}

@app.post("/api/radiology/orders/{gpb}/reopen")
async def radiology_order_reopen(gpb: int, request: Request, user=Depends(require_radiology_write)):
    """Reopen a Not-Done (cancelled) order — the ONLY way to undo a cancel now that the
    progress actions refuse to silently resurrect one. Clears the cancel so the normal
    workflow and auto-file resume. Privileged, same as cancel."""
    b = await _rad_body(request)
    _rad_overlay_apply(gpb, user, "local_status=NULL, cancel_reason=NULL", (),
        mrno=b.get("mrno"), site=b.get("site"), patient_name=b.get("patientName"))
    insert_audit(user, "RADIOLOGY_REOPEN", str(b.get("mrno") or gpb), json.dumps({"gpb": gpb}))
    return {"ok": True}

# ── Critical / urgent result closed-loop communication (Meena-owned) ────────────
# Flag a critical finding → the reading team is notified → the loop stays OPEN until
# someone documents that the result was communicated to (and read back by) the
# referring team. Accreditation-grade; never written back to Siratech.
def _critical_row(r):
    """Shape a critical_results DB row for the client, with a computed overdue flag.
    Open criticals unacknowledged past their SLA (critical 30 min, urgent 60 min)
    are surfaced as overdue so the panel can escalate them visually."""
    import datetime as _dt
    out = dict(r)
    fa = r.get("flagged_at")
    mins = None
    if fa:
        try:
            mins = (_dt.datetime.now(_dt.timezone.utc) - fa).total_seconds() / 60.0
        except Exception:
            mins = None
    sla = 30 if (r.get("severity") or "critical") == "critical" else 60
    out["age_minutes"] = round(mins) if mins is not None else None
    out["overdue"] = bool(r.get("status") == "open" and mins is not None and mins > sla)
    for k in ("flagged_at", "acked_at", "created_at"):
        if out.get(k) is not None:
            try: out[k] = out[k].isoformat()
            except Exception: out[k] = str(out[k])
    return out

@app.get("/api/radiology/critical")
def radiology_critical_list(status: str = Query("open"), user=Depends(require_radiology)):
    """List critical results. status=open (default) | acknowledged | all. Branch-locked
    team leads see only their own site."""
    site = _rad_scope_site(user)
    where, params = [], []
    if status in ("open", "acknowledged"):
        where.append("status=%s"); params.append(status)
    if site is not None:
        where.append("(site=%s OR site IS NULL)"); params.append(site)
    sql = "SELECT * FROM scheduling.critical_results"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY (status='open') DESC, flagged_at DESC LIMIT 500"
    rows = q(sql, tuple(params)) or []
    items = [_critical_row(r) for r in rows]
    open_count = sum(1 for r in items if r["status"] == "open")
    overdue_count = sum(1 for r in items if r.get("overdue"))
    return {"ok": True, "items": items, "openCount": open_count, "overdueCount": overdue_count}

@app.get("/api/radiology/critical/count")
def radiology_critical_count(user=Depends(require_radiology)):
    """Cheap badge count of OPEN critical results in the user's scope."""
    site = _rad_scope_site(user)
    if site is not None:
        row = q("""SELECT COUNT(*) AS n, COUNT(*) FILTER (
                     WHERE flagged_at < NOW() - (CASE WHEN severity='critical' THEN INTERVAL '30 min' ELSE INTERVAL '60 min' END)
                   ) AS overdue
                   FROM scheduling.critical_results
                   WHERE status='open' AND (site=%s OR site IS NULL)""", (site,), one=True)
    else:
        row = q("""SELECT COUNT(*) AS n, COUNT(*) FILTER (
                     WHERE flagged_at < NOW() - (CASE WHEN severity='critical' THEN INTERVAL '30 min' ELSE INTERVAL '60 min' END)
                   ) AS overdue
                   FROM scheduling.critical_results WHERE status='open'""", (), one=True)
    return {"open": (row and row.get("n")) or 0, "overdue": (row and row.get("overdue")) or 0}

@app.post("/api/radiology/critical")
async def radiology_critical_flag(request: Request, user=Depends(require_radiology)):
    """Flag a critical/urgent result. Records it OPEN and notifies the radiology
    reading/management team so the communication loop starts."""
    b = await _rad_body(request)
    mrno = str(b.get("mrno") or "").strip()
    finding = str(b.get("finding") or "").strip()
    if not mrno:
        raise HTTPException(400, "Patient MRN is required")
    if not finding:
        raise HTTPException(400, "The critical finding is required")
    severity = "urgent" if str(b.get("severity") or "").lower() == "urgent" else "critical"
    # Branch isolation: a branch-locked user's flag is ALWAYS attributed to their own site —
    # never trust a client-supplied site (would let them mis-file to another branch). Only
    # org-wide users (scope None) may specify the site.
    scope = _rad_scope_site(user)
    if scope is not None:
        site = scope
    else:
        try: site = int(b.get("site")) if b.get("site") not in (None, "") else None
        except Exception: site = None
    gpb = b.get("gpb")
    try: gpb = int(gpb) if gpb not in (None, "") else None
    except Exception: gpb = None
    row = q("""INSERT INTO scheduling.critical_results
                 (site, mrno, gen_pat_billing_id, accession, patient_name, exam, severity,
                  finding, flagged_by, flagged_by_name, notify_to)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               RETURNING *""",
            (site, mrno, gpb, (str(b.get("accession") or "").strip() or None),
             (str(b.get("patientName") or "").strip() or None),
             (str(b.get("exam") or "").strip() or None), severity, finding[:2000],
             user.get("id"), user.get("username"),
             (str(b.get("notifyTo") or "").strip() or None)), one=True)
    # Notify the reading/management team so the loop is picked up. Best-effort.
    try:
        pname = row.get("patient_name") or mrno
        msg = f"🚨 {'CRITICAL' if severity=='critical' else 'Urgent'} result flagged: {pname} — {finding[:120]}. Needs acknowledgement."
        targets = q("""SELECT id FROM scheduling.users
                       WHERE role IN ('superadmin','manager','admin')
                          OR COALESCE(can_use_radiology,false)
                          OR COALESCE(can_file_radiology,false)""", ()) or []
        for t in targets:
            if t.get("id") and t["id"] != user.get("id"):
                notify(t["id"], msg, link="#/critical", ntype="alert")
    except Exception:
        pass
    insert_audit(user, "RADIOLOGY_CRITICAL_FLAG", mrno,
                 json.dumps({"id": row.get("id"), "severity": severity, "gpb": gpb}))
    return {"ok": True, "item": _critical_row(row)}

@app.post("/api/radiology/critical/{cid}/ack")
async def radiology_critical_ack(cid: int, request: Request, user=Depends(require_radiology)):
    """Close the loop: document that the critical result was communicated to and read
    back by the referring team (who + how). Requires a note."""
    b = await _rad_body(request)
    note = str(b.get("note") or "").strip()
    if not note:
        raise HTTPException(400, "Document how the result was communicated (who was told + read-back)")
    notify_to = str(b.get("notifyTo") or "").strip() or None
    # Only close a loop that is still OPEN (don't overwrite who/when on an already-acked one),
    # and a branch-locked user can only close criticals for their own site.
    scope = _rad_scope_site(user)
    where = "id=%s AND status='open'"
    params = [user.get("id"), user.get("username"), note[:2000], notify_to, cid]
    if scope is not None:
        where += " AND (site=%s OR site IS NULL)"
        params.append(scope)
    row = q(f"""UPDATE scheduling.critical_results
               SET status='acknowledged', acked_by=%s, acked_by_name=%s, acked_at=NOW(),
                   ack_note=%s, notify_to=COALESCE(%s, notify_to)
               WHERE {where} RETURNING *""",
            tuple(params), one=True)
    if not row:
        exists = q("SELECT status FROM scheduling.critical_results WHERE id=%s", (cid,), one=True)
        if not exists:
            raise HTTPException(404, "Critical result not found")
        if exists.get("status") != "open":
            raise HTTPException(409, "This critical result is already acknowledged")
        raise HTTPException(403, "This critical result belongs to another branch")
    insert_audit(user, "RADIOLOGY_CRITICAL_ACK", str(row.get("mrno") or cid),
                 json.dumps({"id": cid}))
    return {"ok": True, "item": _critical_row(row)}

# ── Peer review (radiology QA, RADPEER-style) ─────────────────────────────────
# A second radiologist scores agreement with a colleague's report. Discrepancy
# rate (score ≥ 2) and significant-discrepancy rate (score ≥ 3 or flagged) per
# reader and overall are the accreditation quality metric. Meena-owned.
_PEER_SCORE_LABEL = {
    1: "Concur",
    2: "Discrepancy — not ordinarily expected",
    3: "Discrepancy — should be made most of the time",
    4: "Discrepancy — misinterpretation",
}

def _peer_row(r):
    out = dict(r)
    sc = int(out.get("score") or 1)
    out["score"] = sc
    out["score_label"] = _PEER_SCORE_LABEL.get(sc, str(sc))
    out["discrepancy"] = sc >= 2
    out["significant"] = bool(sc >= 3 or out.get("clinically_significant"))
    if out.get("created_at") is not None:
        try: out["created_at"] = out["created_at"].isoformat()
        except Exception: out["created_at"] = str(out["created_at"])
    return out

@app.get("/api/radiology/peer-review")
def radiology_peer_list(reader: str = Query(""), days: int = Query(90), user=Depends(require_radiology)):
    """List peer reviews, most recent first. Optional reader filter and lookback
    window. Branch-locked leads see only their own site."""
    site = _rad_scope_site(user)
    where, params = [], []
    try: days = max(1, min(int(days), 730))
    except Exception: days = 90
    where.append("created_at >= NOW() - (%s || ' days')::interval"); params.append(str(days))
    reader = (reader or "").strip()
    if reader:
        where.append("original_reader = %s"); params.append(reader)
    if site is not None:
        where.append("(site=%s OR site IS NULL)"); params.append(site)
    sql = "SELECT * FROM scheduling.peer_reviews"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT 500"
    rows = q(sql, tuple(params)) or []
    return {"ok": True, "items": [_peer_row(r) for r in rows]}

@app.get("/api/radiology/peer-review/summary")
def radiology_peer_summary(days: int = Query(90), user=Depends(require_radiology)):
    """QA rollup: total reviews, discrepancy rate and significant-discrepancy rate,
    overall and per reader. The ACR benchmark discrepancy rate is roughly 3%."""
    site = _rad_scope_site(user)
    try: days = max(1, min(int(days), 730))
    except Exception: days = 90
    where = ["created_at >= NOW() - (%s || ' days')::interval"]
    params = [str(days)]
    if site is not None:
        where.append("(site=%s OR site IS NULL)"); params.append(site)
    wsql = " WHERE " + " AND ".join(where)
    tot = q(f"""SELECT COUNT(*) AS reviews,
                   COUNT(*) FILTER (WHERE score >= 2) AS discrepancies,
                   COUNT(*) FILTER (WHERE score >= 3 OR clinically_significant) AS significant
                FROM scheduling.peer_reviews{wsql}""", tuple(params), one=True) or {}
    per = q(f"""SELECT COALESCE(NULLIF(TRIM(original_reader),''),'—') AS reader,
                   COUNT(*) AS reviews,
                   COUNT(*) FILTER (WHERE score >= 2) AS discrepancies,
                   COUNT(*) FILTER (WHERE score >= 3 OR clinically_significant) AS significant
                FROM scheduling.peer_reviews{wsql}
                GROUP BY 1 ORDER BY reviews DESC, reader LIMIT 100""", tuple(params)) or []
    reviews = int(tot.get("reviews") or 0)
    disc = int(tot.get("discrepancies") or 0)
    sig = int(tot.get("significant") or 0)
    pct = lambda n, d: (round(n * 1000.0 / d) / 10.0) if d else 0.0
    return {
        "ok": True, "days": days,
        "reviews": reviews, "discrepancies": disc, "significant": sig,
        "discrepancyRate": pct(disc, reviews), "significantRate": pct(sig, reviews),
        "byReader": [{
            "reader": r.get("reader"), "reviews": int(r.get("reviews") or 0),
            "discrepancies": int(r.get("discrepancies") or 0),
            "significant": int(r.get("significant") or 0),
            "discrepancyRate": pct(int(r.get("discrepancies") or 0), int(r.get("reviews") or 0)),
        } for r in per],
    }

@app.post("/api/radiology/peer-review")
async def radiology_peer_create(request: Request, user=Depends(require_radiology)):
    """Record a peer review of a colleague's report. Score is RADPEER 1–4."""
    b = await _rad_body(request)
    mrno = str(b.get("mrno") or "").strip()
    if not mrno:
        raise HTTPException(400, "Patient MRN is required")
    try: score = int(b.get("score"))
    except Exception: score = 0
    if score < 1 or score > 4:
        raise HTTPException(400, "Score must be 1–4 (RADPEER scale)")
    reader = str(b.get("originalReader") or "").strip()
    # Don't let a reviewer score their own report — peer review must be a second reader.
    if reader and reader.lower() == str(user.get("username") or "").lower():
        raise HTTPException(400, "A peer review must be by a different radiologist")
    scope = _rad_scope_site(user)
    if scope is not None:
        site = scope
    else:
        try: site = int(b.get("site")) if b.get("site") not in (None, "") else None
        except Exception: site = None
    sig = bool(b.get("clinicallySignificant")) or score >= 3
    row = q("""INSERT INTO scheduling.peer_reviews
                 (site, mrno, accession, patient_name, exam, modality, original_reader,
                  reviewer_id, reviewer_name, score, clinically_significant, note)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               RETURNING *""",
            (site, mrno, (str(b.get("accession") or "").strip() or None),
             (str(b.get("patientName") or "").strip() or None),
             (str(b.get("exam") or "").strip() or None),
             (str(b.get("modality") or "").strip() or None),
             (reader or None), user.get("id"), user.get("username"),
             score, sig, (str(b.get("note") or "").strip() or None)), one=True)
    insert_audit(user, "RADIOLOGY_PEER_REVIEW", mrno,
                 json.dumps({"id": row.get("id"), "score": score, "reader": reader}))
    return {"ok": True, "item": _peer_row(row)}

@app.get("/api/radiology/technologists")
def radiology_technologists(user=Depends(require_radiology)):
    """Active staff for the worklist's technologist picker (assign action). Org-wide
    roles (manager / superadmin) see everyone; a branch operator sees their own branch."""
    bid = user.get("branch_id")
    if user.get("role") in ("manager", "superadmin") or not bid:
        rows = q("SELECT id, name FROM scheduling.staff WHERE active ORDER BY name") or []
    else:
        rows = q("SELECT id, name FROM scheduling.staff WHERE active AND branch_id=%s ORDER BY name", (bid,)) or []
    return {"technologists": [{"id": r["id"], "name": r["name"]} for r in rows]}

@app.get("/api/radiology/stats/history")
def radiology_stats_history(
    from_: str = Query("", alias="from"),
    to: str = Query(""),
    user=Depends(require_admin),
):
    """Stored daily radiology snapshots for month/quarter comparison. Returns the
    daily rows in range plus a monthly roll-up. History is built by the daily
    snapshot job (and any manual /snapshot calls)."""
    clauses, params = [], []
    f, t = (from_ or "").strip(), (to or "").strip()
    for label, val in (("from", f), ("to", t)):
        if val and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", val):
            raise HTTPException(400, f"{label} must be YYYY-MM-DD")
    if f:
        clauses.append("stat_date >= %s"); params.append(f)
    if t:
        clauses.append("stat_date <= %s"); params.append(t)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = q(f"""SELECT stat_date, total, emergency, routine, source, captured_at
                 FROM scheduling.radiology_stats_daily{where} ORDER BY stat_date""",
             tuple(params), many=True) or []
    days, months = [], {}
    for r in rows:
        d = r["stat_date"].isoformat()
        days.append({"date": d, "total": r["total"], "emergency": r["emergency"],
                     "routine": r["routine"], "source": r["source"]})
        mk = d[:7]
        m = months.setdefault(mk, {"month": mk, "total": 0, "emergency": 0, "routine": 0, "days": 0})
        m["total"] += r["total"]; m["emergency"] += r["emergency"]; m["routine"] += r["routine"]; m["days"] += 1
    return {"ok": True, "days": days,
            "months": [months[k] for k in sorted(months)],
            "count": len(days)}

@app.post("/api/radiology/stats/snapshot")
def radiology_stats_snapshot(date: str = Query(...), user=Depends(require_admin)):
    """Manually capture (or refresh) one day's snapshot — used to back-fill or to
    seed history immediately instead of waiting for the nightly job."""
    date = (date or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(400, "date must be YYYY-MM-DD")
    try:
        total = _capture_radiology_day(date, source_label="manual")
    except Exception as e:
        raise HTTPException(502, f"Snapshot failed: {e}")
    return {"ok": True, "date": date, "total": total}

@app.get("/api/radiology/reconcile/latest")
def radiology_reconcile_latest(user=Depends(require_admin)):
    """The latest end-of-day billed-vs-performed reconciliation snapshot (counts + the
    aged 'billed but not performed' follow-up list). Read-only. Management-only — the
    payload carries org-wide patient names, so branch-locked leads are excluded."""
    if user.get("role") not in ("manager", "superadmin"):
        raise HTTPException(403, "Reconciliation is available to management only")
    row = q("""SELECT run_date, window_from, window_to, flag_days, ordered_total, performed,
                      not_performed, not_performed_aged, awaiting_report, reported, payload, captured_at
               FROM scheduling.radiology_reconcile_daily ORDER BY run_date DESC LIMIT 1""", one=True)
    if not row:
        return {"ok": True, "empty": True}
    return {"ok": True, **row}

@app.api_route("/api/radiology/reconcile/diagnose", methods=["GET", "POST"])
async def radiology_reconcile_diagnose(request: Request, user=Depends(require_superadmin)):
    """Root-cause WHY a branch reads low 'performed': for the not-performed orders in a window/
    branch, check DePACS to tell apart genuine no-shows / a different-PACS coverage gap
    (noStudyAtAll) from a matching gap (sameModMatch — a study exists but didn't link).
    Read-only; forwards to the connector's /diag/reconcile-branch. Params: site, from, to,
    sample, matchAfterH."""
    import urllib.parse as _up
    from starlette.concurrency import run_in_threadpool
    p = request.query_params
    q_ = {}
    for k in ("site", "from", "to", "sample", "matchAfterH"):
        v = (p.get(k) or "").strip()
        if v:
            q_[k] = v
    qs = ("?" + _up.urlencode(q_)) if q_ else ""
    return await run_in_threadpool(lambda: _bridge_request("/his/diag/reconcile-branch" + qs, timeout=240))

@app.api_route("/api/radiology/panel-dates", methods=["GET", "POST"])
async def radiology_panel_dates(request: Request, user=Depends(require_superadmin)):
    """Read-only probe: dump the RIS panel's raw date fields + our row count for one branch/window,
    so we can map the ORDER date field vs the BILL date and compare counts against Siratech's
    report. Forwards to the connector's /diag/panel-dates. Params: site, from, to, limit, mrno."""
    import urllib.parse as _up
    from starlette.concurrency import run_in_threadpool
    p = request.query_params
    q_ = {}
    for k in ("site", "from", "to", "limit", "mrno"):
        v = (p.get(k) or "").strip()
        if v:
            q_[k] = v
    qs = ("?" + _up.urlencode(q_)) if q_ else ""
    return await run_in_threadpool(lambda: _bridge_request("/his/diag/panel-dates" + qs, timeout=120))

@app.post("/api/radiology/reconcile/run")
def radiology_reconcile_run_now(request: Request, user=Depends(require_superadmin)):
    """Run the reconciliation on demand (testing / an immediate check instead of waiting for
    the nightly job). SLOW — it sweeps the trailing window from DePACS in weekly chunks, so the
    request can take a few minutes. `?notify=1` also pushes the summary to management."""
    p = request.query_params
    wd = (p.get("window_days") or "").strip()
    fd = (p.get("flag_days") or "").strip()
    try:
        summary = _rad_reconcile_run(window_days=int(wd) if wd else None,
                                     flag_days=int(fd) if fd else None)
    except Exception as e:
        raise HTTPException(502, f"Reconciliation failed: {e}")
    notified = _rad_reconcile_notify(summary) if (p.get("notify") == "1") else 0
    return {"ok": True, "notified": notified, **summary}

def _rad_live_done_day(date):
    """LIVE ordered/done for ONE day, straight from the connector's ready=1 board (DePACS-
    grounded) — so the current day isn't frozen at the last nightly snapshot. Returns the
    per-day dict {date, ordered, done, unverifiable, by_modality}. Blocking (bridge call)."""
    import urllib.parse as _up
    match_after_h = min(720, max(96, RAD_RECON_FLAG_DAYS * 24))
    qs = _up.urlencode({"from": date, "to": date, "ready": "1", "matchAfterH": match_after_h})
    data = _bridge_request("/his/worklist?" + qs, timeout=240)
    items = (data or {}).get("items") or []
    gpbs = []
    for it in items:
        try:
            gpbs.append(int(it.get("genPatBillingId")))
        except Exception:
            pass
    manual_done = set()
    if gpbs:
        for r in (q("""SELECT gen_pat_billing_id FROM scheduling.radiology_orders
                        WHERE gen_pat_billing_id = ANY(%s)
                          AND (completed_at IS NOT NULL OR local_status='completed')""", (gpbs,)) or []):
            try:
                manual_done.add(int(r["gen_pat_billing_id"]))
            except Exception:
                pass
    ordered = done = unverifiable = 0
    mods = {}
    for it in items:
        stage = (it.get("stage") or "").lower()
        try:
            gpb = int(it.get("genPatBillingId"))
        except Exception:
            gpb = None
        mod = (it.get("modality") or "Other").strip().upper() or "Other"
        mm = mods.setdefault(mod, {"ordered": 0, "done": 0})
        ordered += 1; mm["ordered"] += 1
        if stage in ("imaged", "draft", "reported") or (gpb in manual_done):
            done += 1; mm["done"] += 1
        elif _RAD_NON_PACS_MOD_RE.search(f"{it.get('exam') or ''} {it.get('modality') or ''}"):
            unverifiable += 1
    return {"date": date, "ordered": ordered, "done": done, "unverifiable": unverifiable, "by_modality": mods}

@app.get("/api/radiology/stats/done-history")
def radiology_done_history(request: Request, user=Depends(require_admin)):
    """Daily + monthly ORDERED vs DONE, attributed to the order date. TODAY is computed LIVE
    from the board on each load; prior days come from the accumulated snapshot, which the
    nightly job self-corrects for late exams. Org-wide, management-only."""
    if user.get("role") not in ("manager", "superadmin"):
        raise HTTPException(403, "Available to management only")
    p = request.query_params
    try:
        days = max(7, min(120, int(p.get("days") or "45")))
        months = max(1, min(24, int(p.get("months") or "6")))
    except Exception:
        days, months = 45, 6
    # Refresh TODAY live (unless ?live=0), then the queries below read the fresh value — so the
    # current day + this-month total track the live board instead of the last nightly snapshot.
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    ksa_today = (_dt.now(_tz.utc) + _td(hours=3)).strftime("%Y-%m-%d")
    if (p.get("live") or "1") != "0":
        try:
            lv = _rad_live_done_day(ksa_today)
            q("""INSERT INTO scheduling.radiology_done_daily (stat_date, ordered, done, unverifiable, by_modality, updated_at)
                 VALUES (%s,%s,%s,%s,%s, NOW())
                 ON CONFLICT (stat_date) DO UPDATE SET ordered=EXCLUDED.ordered, done=EXCLUDED.done,
                     unverifiable=EXCLUDED.unverifiable, by_modality=EXCLUDED.by_modality, updated_at=NOW()""",
              (lv["date"], lv["ordered"], lv["done"], lv["unverifiable"], json.dumps(lv["by_modality"])),
              exec_only=True)
        except Exception:
            pass
    daily = q("""SELECT stat_date::text AS date, ordered, done, unverifiable, by_modality, updated_at
                 FROM scheduling.radiology_done_daily
                 WHERE stat_date >= (CURRENT_DATE - %s::int)
                 ORDER BY stat_date DESC""", (days,)) or []
    monthly = q("""SELECT to_char(stat_date,'YYYY-MM') AS month,
                          SUM(ordered)::int AS ordered, SUM(done)::int AS done,
                          SUM(unverifiable)::int AS unverifiable
                   FROM scheduling.radiology_done_daily
                   WHERE stat_date >= (CURRENT_DATE - (%s * 31)::int)
                   GROUP BY 1 ORDER BY 1 DESC""", (months,)) or []
    # Exam-type (modality) breakdown for the CURRENT KSA month, summed from the daily JSON.
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    ksa_month = (_dt.now(_tz.utc) + _td(hours=3)).strftime("%Y-%m")
    mods = {}
    for r in daily:
        if not str(r.get("date", "")).startswith(ksa_month):
            continue
        for mod, v in (r.get("by_modality") or {}).items():
            m = mods.setdefault(mod, {"ordered": 0, "done": 0})
            m["ordered"] += (v or {}).get("ordered", 0)
            m["done"] += (v or {}).get("done", 0)
    by_modality = [{"modality": k, **v} for k, v in sorted(mods.items(), key=lambda kv: -kv[1]["ordered"])]
    return {"ok": True, "daily": daily, "monthly": monthly, "byModality": by_modality, "currentMonth": ksa_month}

@app.get("/api/radiology/stats/done-day")
async def radiology_done_day(request: Request, user=Depends(require_admin)):
    """The order-level list behind one day's ordered/done — patient (MRN) + exam + done flag.
    On-demand (sweeps DePACS for that day with the wide late-exam window). Management-only
    because it carries patient identifiers."""
    if user.get("role") not in ("manager", "superadmin"):
        raise HTTPException(403, "Management only")
    date = (request.query_params.get("date") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(400, "date must be YYYY-MM-DD")
    import urllib.parse as _up
    from starlette.concurrency import run_in_threadpool
    match_after_h = min(720, max(96, RAD_RECON_FLAG_DAYS * 24))
    qs = _up.urlencode({"from": date, "to": date, "ready": "1", "matchAfterH": match_after_h})
    data = await run_in_threadpool(lambda: _bridge_request("/his/worklist?" + qs, timeout=240))
    items = (data or {}).get("items") or []
    gpbs = []
    for it in items:
        try:
            gpbs.append(int(it.get("genPatBillingId")))
        except Exception:
            pass
    manual_done = set()
    if gpbs:
        for r in (q("""SELECT gen_pat_billing_id FROM scheduling.radiology_orders
                        WHERE gen_pat_billing_id = ANY(%s)
                          AND (completed_at IS NOT NULL OR local_status = 'completed')""", (gpbs,)) or []):
            try:
                manual_done.add(int(r["gen_pat_billing_id"]))
            except Exception:
                pass
    orders = []
    done = 0
    for it in items:
        stage = (it.get("stage") or "").lower()
        try:
            gpb = int(it.get("genPatBillingId"))
        except Exception:
            gpb = None
        is_done = stage in ("imaged", "draft", "reported") or (gpb in manual_done)
        if is_done:
            done += 1
        orders.append({
            "mrno": str(it.get("mrno") or ""), "name": (it.get("patientName") or "").strip(),
            "exam": it.get("exam") or "", "modality": it.get("modality") or "",
            "branch": it.get("branch") or "", "orderedDate": it.get("orderedDate"),
            "done": is_done, "stage": stage or "ordered",
            "reported": stage == "reported",
        })
    orders.sort(key=lambda o: (o["done"], o["modality"]))
    return {"ok": True, "date": date, "ordered": len(orders), "done": done, "orders": orders}

@app.get("/api/radiology/results/match/{file_no}")
def radiology_results_match(file_no: str, request: Request, user=Depends(require_radiology)):
    """Reverse handoff: match a patient's radiology order(s)/test(s) to the
    VERIFIED DePACS study that holds the report — the strict, no-guess gate.
    Read-only (never writes). Each test resolves to `unique` / `none` /
    `ambiguous`; an order is auto-fileable only when every test is `unique`.
    `site` scopes the (per-branch) result-entry worklist to the patient's branch —
    without it the search hits a default branch and finds nothing."""
    import urllib.parse
    file_no = (file_no or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    site = (request.query_params.get("site") or "").strip()
    qs = ("?site=" + urllib.parse.quote(site)) if site else ""
    return _bridge_request("/his/results/match/" + urllib.parse.quote(file_no) + qs, timeout=120)

@app.post("/api/radiology/results/file")
async def radiology_results_file(request: Request, user=Depends(require_radiology_write)):
    """File a VERIFIED DePACS report PDF back into Siratech's Result Entry and
    (unless authorize=false) authorize it. DRY-RUN by default: nothing is written
    unless confirm=true is sent AND the target test resolves to exactly one study.
    A real write is audited."""
    b = await request.json()
    if not isinstance(b, dict) or not str(b.get("file") or "").strip():
        raise HTTPException(400, "A patient file number is required")
    # Deterministic key injection: if the on-site MWL agent captured this patient's
    # accession from the modality worklist, hand it to the connector so the study match
    # is exact instead of fuzzy. CONSERVATIVE: inject only when we can attribute the
    # accession to THIS order unambiguously — either the patient has exactly one MWL
    # entry today AND exactly one order in our ledger today (no cross-order confusion),
    # OR exactly one MWL entry today matches this order's MODALITY. Otherwise skip and
    # let the connector's own strict matcher decide (never bind a guessed accession).
    if not b.get("accession"):
        try:
            ksa_today = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%Y%m%d")
            file_no = str(b.get("file")).strip()
            mrows = q("""SELECT accession, modality FROM scheduling.radiology_mwl
                         WHERE mrno=%s AND sps_date=%s""", (file_no, ksa_today)) or []
            acc = None
            if len(mrows) == 1 and mrows[0].get("accession"):
                # the order's modality, from our ledger (or the request), to confirm fit
                gpb = b.get("genPatBillingId")
                ord_mod = None
                if gpb:
                    orow = q("SELECT modality FROM scheduling.radiology_orders WHERE gen_pat_billing_id=%s",
                             (int(gpb),), one=True) if str(gpb).strip().isdigit() else None
                    ord_mod = (orow or {}).get("modality")
                # count the patient's orders today — 1 order + 1 accession = unambiguous
                cnt = q("""SELECT COUNT(*) AS n FROM scheduling.radiology_orders
                           WHERE mrno=%s AND ordered_at >= (NOW() AT TIME ZONE 'UTC' - INTERVAL '1 day')""",
                        (file_no,), one=True)
                one_order = cnt and int(cnt.get("n") or 0) <= 1
                mwl_mod = str(mrows[0].get("modality") or "").strip().upper()
                mod_ok = ord_mod and mwl_mod and _mod_bucket(ord_mod) == _mod_bucket(mwl_mod)
                if one_order or mod_ok:
                    acc = mrows[0]["accession"]
            if acc:
                b["accession"] = acc
        except Exception:
            pass
    # Ride the patient's signed non-pregnancy consent along with the report so BOTH
    # land on her Siratech file in one filing (the connector attaches it as a second
    # genFileAttachments entry, named on its own). Only on a real write (confirm).
    consent_id = None
    if b.get("confirm"):
        try:
            _fno = str(b.get("file")).strip()
            # Is a signed consent ALREADY on the patient's Siratech file on its own
            # (filed at signing)? Tell the connector so its idempotency guard lets the
            # report append alongside the consent instead of reading it as "already filed".
            _cf = q("""SELECT COUNT(*) AS n FROM scheduling.consents
                        WHERE file_no=%s AND status='signed' AND filed_siratech=true""",
                    (_fno,), one=True)
            _cf_n = int((_cf or {}).get("n") or 0)
            if _cf_n:
                b["consentAlreadyFiled"] = True
                # Count so the connector can tell "only the consent(s)" from "a report was
                # added" even when the HIS echoes attachments without names.
                b["consentFiledCount"] = _cf_n
            # Otherwise ride the newest signed-but-UNfiled consent along with the report,
            # so it still reaches the file even if standalone filing was unavailable.
            if not b.get("consentPdf"):
                crow = q("""SELECT id, pdf, patient_name, created_at FROM scheduling.consents
                            WHERE file_no=%s AND status='signed' AND pdf IS NOT NULL
                              AND filed_siratech=false
                            ORDER BY created_at DESC LIMIT 1""",
                         (_fno,), one=True)
                if crow and crow.get("pdf"):
                    import base64 as _b64
                    b["consentPdf"] = _b64.b64encode(bytes(crow["pdf"])).decode("ascii")
                    _cdt = crow["created_at"].strftime("%Y-%m-%d") if crow.get("created_at") else ""
                    _parts = [p for p in ["Consent Non Pregnancy", (crow.get("patient_name") or "").strip(), _cdt] if p]
                    b["consentName"] = " - ".join(_parts) + ".pdf"
                    consent_id = crow["id"]
        except Exception:
            consent_id = None
    # H3 — idempotency: if THIS order was already filed by Meena (a page reload, or a
    # second operator opening the same patient), don't re-file and re-authorize it. The
    # in-memory client guard is gone after a reload, so gate on the durable ledger here.
    if b.get("confirm"):
        _gpb = b.get("genPatBillingId")
        if _gpb and str(_gpb).strip().isdigit():
            _ex = q("SELECT state, study_id FROM scheduling.radiology_orders WHERE gen_pat_billing_id=%s",
                    (int(_gpb),), one=True)
            if _ex and str(_ex.get("state") or "") == "filed":
                return {"ok": True, "already_filed": True, "wrote": False, "authorized": False,
                        "plan": {"study": {"studyId": _ex.get("study_id")}},
                        "message": "This report was already filed for this order — not re-filing."}
    out = _bridge_request("/his/results/file", method="POST", body=b, timeout=180)
    if b.get("confirm"):
        wrote = isinstance(out, dict) and out.get("wrote")
        # Record which study was filed to which test, so the write is reconstructable.
        plan = (out.get("plan") or {}) if isinstance(out, dict) else {}
        study = (plan.get("study") or {}) if isinstance(plan, dict) else {}
        # RIS Phase 2: the connector surfaces the order key (genPatBillingId) on the plan;
        # accept it from the request too. Stamp the durable order ↔ study binding on a
        # real write.
        gpb = b.get("genPatBillingId") or plan.get("genPatBillingId") or study.get("genPatBillingId")
        insert_audit(user, "RADIOLOGY_RESULT_FILE", str(b.get("file")),
                     json.dumps({"billNo": b.get("billNo"), "serviceId": b.get("serviceId"),
                                 "genPatBillingId": gpb,
                                 "studyId": study.get("studyId"),
                                 "authorize": b.get("authorize") is not False,
                                 "wrote": bool(wrote),
                                 "authorized": bool(isinstance(out, dict) and out.get("authorized"))}))
        if wrote and gpb:
            try:
                # Prefer the deterministic accession the connector actually matched on
                # (plan.accession) so the durable order↔study↔images link is exact.
                _rad_mark_filed(gpb, study.get("studyId"), b.get("serviceId"), user["id"],
                                mrno=b.get("file"), site=b.get("site"), bill_no=b.get("billNo"),
                                accession=(plan.get("accession") or b.get("accession")
                                           or (study.get("accession") if isinstance(study, dict) else None)),
                                accession_source=plan.get("accessionSource"),
                                pacs_id=plan.get("pacsId"), cpacs_url=plan.get("cpacsUrl"),
                                reported_at=((plan.get("report") or {}).get("reportDate")
                                             if isinstance(plan.get("report"), dict) else None))
            except Exception:
                pass
        if wrote and consent_id:
            try:
                q("UPDATE scheduling.consents SET filed_siratech=true WHERE id=%s",
                  (consent_id,), exec_only=True)
            except Exception:
                pass
    return out

# ---- Butterfly (DePACS) write clinical history into a study ------------------
def _elite_put(path, body):
    try:
        return _elite_request("PUT", path, token=_elite_token(), body=body)
    except HTTPException as e:
        if getattr(e, "status_code", 0) == 502 and ("401" in str(e.detail) or "403" in str(e.detail)):
            _elite_token_cache["token"] = None
            return _elite_request("PUT", path, token=_elite_login(), body=body)
        raise

def _elite_put_form(path, form):
    try:
        return _elite_request("PUT", path, token=_elite_token(), form=form)
    except HTTPException as e:
        if getattr(e, "status_code", 0) == 502 and ("401" in str(e.detail) or "403" in str(e.detail)):
            _elite_token_cache["token"] = None
            return _elite_request("PUT", path, token=_elite_login(), form=form)
        raise

def _elite_fix_date(d):
    s = str(d or "")
    if re.fullmatch(r"\d{8}", s):      # 19590110 -> 1959-01-10 (API wants YYYY-MM-DD)
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return s[:10]

# The handoff is the EMERGENCY radiology flow, so every study we write into is
# flagged Emergency = ✓ and filed under Category "Others". Confirmed live from the
# Butterfly UI's own request: PUT study/update_study_stats/{id} (multipart) with
# emergency_status=1 and study_category_id=3 (↔ "Others"). Overridable via env.
_ELITE_EMERGENCY_CATEGORY_ID = int(os.environ.get("ELITE_EMERGENCY_CATEGORY_ID") or 3)
_ELITE_EMERGENCY_CATEGORY_NAME = (os.environ.get("ELITE_EMERGENCY_CATEGORY_NAME") or "Others").strip()

def _elite_write_history(study_id, history, set_emergency=True, preserve_emergency=True):
    """Write `history` into a study's clinical_history via the same endpoint the
    Butterfly UI uses — PUT study/update_study_stats/{id} (multipart form-data).
    ALWAYS files the study under Category "Others" (study_category_id=3) — a routine
    study must be bucketed too, not left uncategorised — and flags Emergency ✓
    (emergency_status=1) only for the ER/emergency hand-off. Unlike the old
    edit_study_info call, this endpoint only touches these fields — it never requires
    (or risks blanking) the patient demographics.

    SAFETY (preserve_emergency, default on): this endpoint always SENDS emergency_status,
    so a routine write would CLEAR an emergency flag already on the study (set by MWL, a
    prior write, or a human). That is dangerous for a background auto-stamp merely filling
    history. So when this write is routine we first read the study's current flag and NEVER
    downgrade an existing emergency — we only ever raise it, never lower it."""
    eff_emergency = bool(set_emergency)
    if not eff_emergency and preserve_emergency:
        try:
            chk = _elite_get(f"/study_management/get_study_info/{study_id}")
            cb = (chk.get("body") or {}) if isinstance(chk, dict) else {}
            es = cb.get("emergency_status")
            if (es is True) or (str(es).strip().lower() in ("true", "1", "yes")):
                eff_emergency = True   # already emergency → keep it; a routine write must not clear it
        except Exception:
            pass   # readback failed — fall through and write the requested (routine) value
    form = {"clinical_history": history or "",
            "study_category_id": _ELITE_EMERGENCY_CATEGORY_ID,   # "Others" for routine AND ER
            "emergency_status": 1 if eff_emergency else 0}       # ER = 1, routine = 0 (never downgrades)
    res = _elite_put_form(f"/study/update_study_stats/{study_id}", form)
    # _elite_put_form raises on any non-2xx, so reaching here means the PUT was
    # accepted. Only treat it as a failure if the body carries an explicit error
    # (the success-envelope key varies between Butterfly endpoints).
    if isinstance(res, dict) and (res.get("success") is False or res.get("error")):
        detail = res.get("error") or res.get("message") or "update rejected"
        raise HTTPException(502, f"Butterfly write failed: {detail}")
    # Read the study back and confirm the flag actually stuck, so the UI can show a
    # truthful state rather than trusting success=true.
    emerg_ok = None
    if eff_emergency:
        try:
            chk = _elite_get(f"/study_management/get_study_info/{study_id}")
            cb = (chk.get("body") or {}) if isinstance(chk, dict) else {}
            es = cb.get("emergency_status")
            emerg_ok = (es is True) or (str(es).strip().lower() in ("true", "1", "yes"))
        except Exception:
            emerg_ok = None  # readback failed — leave unknown rather than claim success
    return {"ok": True, "study_id": study_id,
            "emergency": bool(eff_emergency),
            "emergency_confirmed": emerg_ok,
            "category": _ELITE_EMERGENCY_CATEGORY_NAME}   # always set now (routine + ER)

def _elite_stamp_accession(study_id, accession):
    """Stamp the Siratech order's accession number onto the Butterfly study so the
    REVERSE flow (result filing, integrations/siratech-connector) can bind the finished
    report to the order by its deterministic PRIMARY key (accession) instead of falling
    back to the fuzzy modality+body-part+time matcher that flags multi-fit studies as
    ambiguous and kicks them to manual review.

    This is done at handoff — a human has just confirmed which DePACS study belongs to
    this order — which is exactly the moment we can safely assert the link.

    Butterfly only exposes accession via `study_management/edit_study_info`, which is a
    FULL replace of the study's patient/description fields. So we read the study back
    first and echo EVERY other field verbatim, changing ONLY accession_number — never
    blanking demographics. Best-effort: never raises (the history write is the primary
    action). Returns a small status dict describing what happened.

    Field names verified against the Butterfly bundle: get_study_info body carries
    snake_case pat_id / pat_name / pat_sex / pat_birthdate / study_desc /
    clinical_history / accession_number; edit_study_info expects patient_name /
    patient_id / patient_sex / patient_birthdate / study_desc / clinical_history /
    accession_number."""
    acc = str(accession or "").strip()
    if not acc:
        return {"stamped": False, "reason": "no accession on the order"}
    try:
        info = _elite_get(f"/study_management/get_study_info/{study_id}")
        b = (info.get("body") or {}) if isinstance(info, dict) else {}
    except Exception as e:
        return {"stamped": False, "reason": f"couldn't read study info: {str(e)[:120]}"}
    cur_acc = str(b.get("accession_number") or "").strip()
    cur_desc = str(b.get("study_desc") or "").strip()
    # Idempotent: the study already carries this accession → nothing to write.
    if cur_acc == acc:
        return {"stamped": True, "changed": False, "reason": "already set", "accession": acc}
    # Distinguish what's currently parked in accession_number. On this DePACS instance
    # the field is overloaded: it's EITHER a real DICOM accession ("SIRA1661" — a compact
    # token, no spaces, carries digits) OR, when study_desc is blank, the exam-description
    # stub ("X L.SPNE", "T SPINE" — has whitespace / no digits). We must protect the
    # former and may relocate the latter.
    cur_is_real_acc = bool(cur_acc) and (not re.search(r"\s", cur_acc)) and bool(re.search(r"\d", cur_acc))
    # Never clobber a REAL pre-existing accession that differs from ours — that would
    # risk mis-linking the study. Refuse and let the fuzzy matcher handle it.
    if cur_is_real_acc:
        return {"stamped": False, "reason": f"study already has a different accession ({cur_acc})"}
    # edit_study_info is a full replace; refuse unless we can echo the core demographics
    # back verbatim. A blank patient_id/patient_name would corrupt the medical record,
    # so a missing read-back aborts the stamp rather than risking a destructive write.
    pat_id = b.get("pat_id"); pat_name = b.get("pat_name")
    if not (str(pat_id or "").strip() and str(pat_name or "").strip()):
        return {"stamped": False, "reason": "study demographics unreadable — refused to edit"}
    # If accession_number was holding the exam-description stub (study_desc blank),
    # promote it into its proper field before we overwrite accession with the real key —
    # no worklist regression, and the description lands where the radiologist reads it.
    study_desc = cur_desc
    if not study_desc and cur_acc:
        study_desc = cur_acc
    edit = {
        "patient_name": pat_name,
        "patient_id": pat_id,
        "patient_sex": b.get("pat_sex") or "",
        "patient_birthdate": _elite_fix_date(b.get("pat_birthdate")),
        "study_desc": study_desc,
        "clinical_history": b.get("clinical_history") or "",
        "accession_number": acc,
    }
    try:
        res = _elite_put(f"/study_management/edit_study_info/{study_id}", edit)
    except HTTPException as e:
        return {"stamped": False, "reason": str(getattr(e, "detail", e))[:200]}
    if isinstance(res, dict) and (res.get("success") is False or res.get("error")):
        return {"stamped": False, "reason": (res.get("error") or "edit rejected")}
    return {"stamped": True, "changed": True, "reason": "accession written", "accession": acc}

@app.get("/api/handoff/config")
def handoff_config(user=Depends(require_radiology)):
    c = _elite_cfg()
    return {"siratech_enabled": bool(_bridge_base()),
            "butterfly_configured": bool(c["username"] and c["password"])}

@app.post("/api/handoff/write-history")
async def handoff_write_history(request: Request, user=Depends(require_radiology_write)):
    """Write the clinical history into a DePACS (Butterfly) study. The WhatsApp
    message is prepared client-side for the staff to copy into the group."""
    b = await request.json()
    study_id = b.get("study_id")
    history = (b.get("history") or "").strip()
    if not study_id:
        raise HTTPException(400, "Pick a DePACS study to write into")
    if not history:
        raise HTTPException(400, "Add the clinical history first")
    sid = _int_or_400(study_id, "study_id")
    file_no = (b.get("file_no") or "").strip()
    order_acc = str(b.get("accession") or "").strip()
    # ── SAFETY GATE: the write must land on THIS patient and THIS exam ──────────
    # A clinical-history write is destructive and clinical. Before touching DePACS,
    # read the target study back and assert (1) it belongs to the handoff's patient
    # and (2) it is the exam the selected order refers to. Fail closed. This is the
    # single chokepoint every manual write passes through, so one extra read on a
    # rare, deliberate action is cheap insurance against writing onto the wrong chart
    # (another patient) or the wrong study (a second exam of the same patient — the
    # "two exams, one history written on both" bug).
    if not file_no:
        raise HTTPException(400, "Missing patient file number — can't verify the study belongs to this patient")
    try:
        _sinfo = _elite_get(f"/study_management/get_study_info/{sid}")
        _sb = (_sinfo.get("body") or {}) if isinstance(_sinfo, dict) else {}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Couldn't read the study to verify the patient before writing: {str(e)[:120]}")
    s_patid = str(_sb.get("pat_id") or "").strip()
    if not _elite_same_patient(s_patid, file_no):
        insert_audit(user, "HANDOFF_WRITE_BLOCKED", str(sid),
                     json.dumps({"reason": "patient_mismatch", "file_no": file_no,
                                 "study_pat_id": s_patid}))
        raise HTTPException(409, "This study belongs to a different patient — refused to write. "
                                 "Re-open the correct patient and pick their study.")
    s_acc = str(_sb.get("accession_number") or "").strip()
    acc_confirmed = bool(order_acc and _elite_is_real_accession(s_acc)
                         and _elite_bare_id(s_acc) == _elite_bare_id(order_acc))
    if order_acc and _elite_is_real_accession(s_acc) and _elite_bare_id(s_acc) != _elite_bare_id(order_acc):
        insert_audit(user, "HANDOFF_WRITE_BLOCKED", str(sid),
                     json.dumps({"reason": "accession_mismatch", "file_no": file_no,
                                 "order_accession": order_acc, "study_accession": s_acc}))
        raise HTTPException(409, f"This study is a different exam (accession {s_acc}) than the selected "
                                 f"order (accession {order_acc}). Pick the study that matches this order "
                                 f"before writing — its indication must not go on another exam.")
    # H1 — when the accession did NOT positively confirm the exam (the common case: no
    # accessions on this HIS), the patient check alone would let one order's indication
    # land on a DIFFERENT same-patient exam picked by mistake. Gate on modality + body part
    # (mirrors the client hoStudyMatchesOrder). Blocks only a CONFIRMED conflict, so a blank
    # study_desc / missing order info can't wrongly refuse a legitimate write.
    if not acc_confirmed:
        order_service = (b.get("order_service") or "").strip()
        order_mod = _mod_bucket(b.get("order_modality") or order_service)
        study_mod = _mod_bucket(_sb.get("modality") or _sb.get("study_desc"))
        if order_mod and study_mod and order_mod != study_mod:
            insert_audit(user, "HANDOFF_WRITE_BLOCKED", str(sid),
                         json.dumps({"reason": "modality_mismatch", "file_no": file_no,
                                     "study_modality": study_mod, "order_modality": order_mod}))
            raise HTTPException(409, f"This study is {study_mod} but the selected order is {order_mod}. "
                                     f"Pick the study that matches this order before writing.")
        if order_service and _autostamp_body_conflict(_sb, order_service):
            insert_audit(user, "HANDOFF_WRITE_BLOCKED", str(sid),
                         json.dumps({"reason": "bodypart_mismatch", "file_no": file_no,
                                     "study_desc": _sb.get("study_desc"), "order": order_service}))
            raise HTTPException(409, "This study's body part doesn't match the selected order. "
                                     "Pick the study that matches this order before writing — its "
                                     "indication must not go on another exam.")
    # The handoff IS the emergency radiology hand-off, so flag Emergency ✓ + Category
    # "Others" by default. Only skip when the staff explicitly marked the study Routine
    # (priority == 'routine' with no emergency override) — a deliberate downgrade, not
    # the default. This is why "Emergency wasn't ticked": a normal order defaults to
    # priority='routine', which previously suppressed the flag.
    prio = str(b.get("priority") or "").lower()
    emergency = (b.get("emergency") is True) or (prio != "routine")
    # Stamp the order's accession onto the study FIRST (via edit_study_info) so a later
    # emergency-flag read-back in _elite_write_history stays authoritative. The stamp is
    # best-effort and never raises — a failure here must not block writing the history,
    # which is the primary action. accession comes from the Siratech order the staff
    # selected in the handoff UI; blank is fine (older orders aren't billed/accessioned
    # yet) and simply skips the stamp, leaving the fuzzy matcher as the fallback.
    acc_result = _elite_stamp_accession(sid, b.get("accession"))
    out = _elite_write_history(sid, history, set_emergency=emergency)
    out["accession_stamped"] = acc_result
    insert_audit(user, "HANDOFF_WRITE_HISTORY", str(study_id),
                 json.dumps({"file_no": (b.get("file_no") or "").strip(),
                             "emergency": bool(emergency),
                             "category": _ELITE_EMERGENCY_CATEGORY_NAME,
                             "accession": (str(b.get("accession") or "").strip() or None),
                             "accession_stamped": bool(acc_result.get("stamped"))}))
    return out

@app.get("/api/handoff/study-info-debug/{study_id}")
def handoff_study_info_debug(study_id: int, user=Depends(require_admin)):
    """TEMP read-only diagnostic: reveal which fields the Butterfly study-info body
    carries for Emergency status and Category, so the handoff write can set them by
    their real names on THIS build. Returns the full key list, plus the values of any
    field whose name hints at emergency/category/status/priority — PHI values (name,
    birthdate, id) are NOT echoed. Read-only; never writes."""
    info = _elite_get(f"/study_management/get_study_info/{study_id}")
    b = (info.get("body") or {}) if isinstance(info, dict) else {}
    hint = re.compile(r"emerg|categ|priorit|urgen|amala|stat\b|flag|stat_", re.I)
    interesting = {k: b.get(k) for k in b.keys()
                   if hint.search(k) and not isinstance(b.get(k), (dict, list))}
    return {"study_id": study_id, "all_keys": sorted(b.keys()), "emergency_category_fields": interesting}

# ---- Radiology consent (Declaration of Non-Pregnancy) ------------------------
_CONSENT_TYPES = ("outpatient", "er")
_CONSENT_REASONS = ("not_married", "lmp", "iud")

def _consent_signer(user):
    """Display name + employee id of the logged-in specialist (the radiology
    technologist who witnesses the signing), resolved from their linked staff row."""
    sid = user.get("staff_id")
    if sid:
        r = q("SELECT name, employee_id FROM scheduling.staff WHERE id=%s", (sid,), one=True)
        if r and r.get("name"):
            return r["name"] + (f" ({r['employee_id']})" if r.get("employee_id") else "")
    return user.get("username") or "Radiology Specialist"

def _ksa_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Asia/Riyadh"))
    except Exception:
        # No tzdata → KSA is a fixed UTC+3 (no DST), so add 3h rather than stamp UTC
        # (a UTC stamp near midnight would print the wrong calendar date on the form).
        return datetime.now(timezone.utc) + timedelta(hours=3)

def _coerce_site(v):
    """Site id as an int, accepting an int OR a numeric string. The connector serialises
    siteId as a string on some paths (the worklist wraps it in Number() for exactly this),
    but the patient-card consent/upload paths pass it straight through — an isinstance(int)
    check there silently dropped the site to NULL, so auto-file could bind to the wrong
    branch/order. Coerce centrally instead."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str) and v.strip().lstrip("-").isdigit():
        return int(v.strip())
    return None

def _signature_has_ink(png_bytes):
    """True only if the signature PNG carries actual strokes — not a blank/transparent
    or all-white canvas. The browser's HAS_INK / length>200 guard is client-side and the
    public sign endpoint is token-only (no login, directly scriptable), so a blank but
    syntactically valid PNG would otherwise be filed to the live HIS as a legally-binding
    signed radiation-safety consent. We re-check pixels server-side and FAIL CLOSED: an
    image we cannot decode counts as no ink (reject), never accept an unverifiable sig."""
    try:
        import fitz
        pix = fitz.Pixmap(png_bytes)
        s = pix.samples
        n = pix.n                      # components per pixel (includes alpha if present)
        has_a = bool(pix.alpha)
        total = pix.width * pix.height
        if total <= 0:
            return False
        step = max(1, total // 20000)  # sample up to ~20k pixels for speed
        ink = 0
        i = 0
        while i < total:
            base = i * n
            a = s[base + n - 1] if has_a else 255
            if a > 24:                 # visibly opaque
                r = s[base]
                g = s[base + 1] if n >= 3 else r
                bl = s[base + 2] if n >= 3 else r
                if r < 220 or g < 220 or bl < 220:   # not near-white → real ink
                    ink += 1
                    if ink >= 12:      # a genuine stroke has far more; blank has none
                        return True
            i += step
        return False
    except Exception:
        return False

@app.post("/api/consent")
async def create_consent(request: Request, user=Depends(require_radiology)):
    """Generate the signed Declaration of Non-Pregnancy PDF from the captured form
    + signature, store it against the patient file, and return its id. The completed
    PDF can then be viewed/downloaded and filed into the patient's record."""
    import base64
    from consent_pdf import generate_consent_pdf
    b = await request.json()
    if not isinstance(b, dict):
        raise HTTPException(400, "Bad request")
    file_no = str(b.get("file_no") or "").strip()
    if not file_no:
        raise HTTPException(400, "A patient file number is required")
    name = (b.get("name") or "").strip()
    patient_type = (b.get("patient_type") or "").strip().lower()
    if patient_type and patient_type not in _CONSENT_TYPES:
        raise HTTPException(400, "Invalid patient type")
    reason = (b.get("reason") or "").strip().lower()
    if reason and reason not in _CONSENT_REASONS:
        raise HTTPException(400, "Invalid reason")
    lmp = (b.get("lmp_date") or "").strip()
    if reason == "lmp" and not lmp:
        raise HTTPException(400, "Enter the date of the last menstrual period")
    if reason != "lmp":
        lmp = ""   # never stamp an LMP date next to a different ticked reason
    sig = b.get("signature") or ""
    png = None
    if isinstance(sig, str) and sig.startswith("data:image"):
        try:
            png = base64.b64decode(sig.split(",", 1)[1])
        except Exception:
            png = None
    if not png:
        raise HTTPException(400, "The patient signature is required")
    if not _signature_has_ink(png):
        raise HTTPException(400, "The signature looks blank — please capture the patient's actual signature")
    now = _ksa_now()
    tech = _consent_signer(user)
    # The PDF overlay font (Helvetica) can't render Arabic, so the printed name uses the
    # ENGLISH name; the Arabic display name is kept on screen + stored as patient_name.
    pdf_name = (b.get("name_en") or "").strip() or name
    data = {
        "name": pdf_name, "mrn": (b.get("mrn") or file_no).strip(),
        "dob": (b.get("dob") or "").strip(), "procedure": (b.get("procedure") or "").strip(),
        "weight": (b.get("weight") or "").strip(), "height": (b.get("height") or "").strip(),
        "hcg": (b.get("hcg") or "").strip(), "patient_type": patient_type,
        "reason": reason, "lmp_date": lmp, "undersigned": pdf_name,
        "physician": (b.get("physician") or "").strip(), "technologist": tech,
        "date": now.strftime("%Y-%m-%d"), "time": now.strftime("%H:%M"),
    }
    try:
        pdf = generate_consent_pdf(data, png)
    except Exception as e:
        raise HTTPException(500, f"Could not generate the consent PDF: {e}")
    row = q("""INSERT INTO scheduling.consents
                 (kind, file_no, mrn, patient_name, patient_name_en, procedure, patient_type, reason, lmp_date,
                  physician, technologist, bill_no, site, pdf, created_by, created_by_name)
               VALUES ('non_pregnancy',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               RETURNING id, created_at""",
            (file_no, data["mrn"], name, ((b.get("name_en") or "").strip() or name),
             data["procedure"], patient_type or None, reason or None,
             lmp or None, data["physician"] or None, tech,
             (b.get("bill_no") or None), _coerce_site(b.get("site")),
             psycopg2.Binary(pdf), user["id"], tech), one=True)
    insert_audit(user, "CONSENT_CREATE", file_no,
                 json.dumps({"id": row["id"], "kind": "non_pregnancy", "procedure": data["procedure"]}))
    # File the consent to the patient's Siratech record NOW (at signing) — independent
    # of any report — so it's on the file before imaging. Best-effort: a failure never
    # breaks signing, and an un-filed consent still rides the report later as a fallback.
    filed = False
    try:
        filed = _file_consent_to_siratech(row["id"])
    except Exception:
        filed = False
    return {"ok": True, "id": row["id"], "created_at": str(row["created_at"]), "filed": bool(filed)}

def _consent_file_name(rec):
    """Descriptive attachment name — 'Consent Non Pregnancy - Name - date.pdf'."""
    cdt = ""
    try:
        cdt = rec["created_at"].strftime("%Y-%m-%d") if rec.get("created_at") else ""
    except Exception:
        cdt = ""
    parts = [p for p in ["Consent Non Pregnancy", (rec.get("patient_name") or "").strip(), cdt] if p]
    return " - ".join(parts) + ".pdf"

def _file_consent_to_siratech(consent_id):
    """Attach a signed consent to the patient's Siratech file on its own, via the
    connector's /his/consent/file (same attachment mechanism as the report, consent-only,
    never authorized). Returns True only on a confirmed write. Marks filed_siratech=true
    so the report path won't re-attach it. Safe to call repeatedly (idempotent by flag)."""
    rec = q("""SELECT id, file_no, mrn, patient_name, patient_name_en, bill_no, site, pdf, filed_siratech
               FROM scheduling.consents WHERE id=%s""", (consent_id,), one=True)
    if not rec or not rec.get("pdf"):
        return False
    if rec.get("filed_siratech"):
        return True
    # Atomically CLAIM the filing BEFORE the slow (~40s) bridge call. Otherwise a concurrent
    # report-ride (file_results) would read filed_siratech=false during this window and attach
    # the SAME consent PDF a second time — two identical genFileAttachments on the file. Only
    # the claimer proceeds; if the write fails we RELEASE the claim so the report ride (or a
    # later manual/auto attempt) can still file it — never leaving it marked-filed-but-unfiled.
    claimed = q("""UPDATE scheduling.consents SET filed_siratech=true
                   WHERE id=%s AND filed_siratech=false RETURNING id""", (consent_id,), one=True)
    if not claimed:
        return True   # another path already claimed/filed it
    import base64 as _b64
    body = {
        "file": str(rec["file_no"]).strip(),
        "billNo": (str(rec["bill_no"]).strip() if rec.get("bill_no") else None),
        "site": (rec.get("site") if isinstance(rec.get("site"), int) else None),
        "consentPdf": _b64.b64encode(bytes(rec["pdf"])).decode("ascii"),
        "consentName": _consent_file_name(rec),
        # Match against Siratech's (English) row name; the display name may be Arabic.
        "expectName": (rec.get("patient_name_en") or rec.get("patient_name") or "").strip() or None,
        "confirm": True,
    }
    wrote = False
    try:
        # Bounded so signing stays responsive — a slow/unreachable HIS just falls back to
        # riding the report later (the claim is released below).
        out = _bridge_request("/his/consent/file", method="POST", body=body, timeout=60)
        wrote = isinstance(out, dict) and out.get("wrote")
    except Exception:
        wrote = False
    if not wrote:
        try:
            q("UPDATE scheduling.consents SET filed_siratech=false WHERE id=%s",
              (consent_id,), exec_only=True)
        except Exception:
            pass
    return bool(wrote)

@app.post("/api/consent/{consent_id}/file")
def file_consent(consent_id: int, request: Request, user=Depends(require_radiology)):
    """Manually push a signed consent onto the patient's Siratech file (used when the
    automatic filing at signing wasn't possible yet — e.g. the order hadn't reached
    Result Entry). Bound to the patient file so an id alone can't reach another patient."""
    rec = q("SELECT id, file_no, pdf, filed_siratech FROM scheduling.consents WHERE id=%s",
            (consent_id,), one=True)
    if not rec:
        raise HTTPException(404, "Consent not found")
    file_no = (request.query_params.get("file") or "").strip()
    if not file_no or file_no != str(rec.get("file_no")):
        raise HTTPException(403, "Provide the matching patient file number to file this consent")
    if not rec.get("pdf"):
        raise HTTPException(409, "This consent has not been signed yet")
    if rec.get("filed_siratech"):
        return {"ok": True, "wrote": True, "already": True,
                "note": "Consent is already on the patient's file."}
    filed = False
    try:
        filed = _file_consent_to_siratech(consent_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Could not file the consent: {e}")
    if filed:
        insert_audit(user, "CONSENT_FILE", str(rec["file_no"]), json.dumps({"id": consent_id}))
    return {"ok": True, "wrote": bool(filed),
            "note": ("Consent filed to the patient's record." if filed
                     else "Could not attach yet — no reachable radiology order for this patient. It will ride the report when filed.")}

@app.get("/api/consent")
def list_consents(request: Request, user=Depends(require_radiology)):
    """List the signed consents on a patient file (newest first)."""
    file_no = (request.query_params.get("file_no") or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    # Only SIGNED consents (a pending QR link that was never signed has no PDF and
    # isn't a real consent — it must not appear in the patient's list).
    rows = q("""SELECT id, kind, procedure, patient_type, reason, created_by_name, created_at,
                       filed_siratech
                FROM scheduling.consents
                WHERE file_no=%s AND status='signed' AND pdf IS NOT NULL
                ORDER BY created_at DESC""", (file_no,))
    return {"file_no": file_no, "count": len(rows), "consents": rows}

@app.get("/api/consent/{consent_id}/pdf")
def consent_pdf(consent_id: int, request: Request, user=Depends(require_radiology)):
    """Download a signed consent PDF. Bound to the file number so a sequential id
    alone can't enumerate other patients' consents (must know the patient file)."""
    row = q("SELECT file_no, pdf FROM scheduling.consents WHERE id=%s", (consent_id,), one=True)
    if not row or row.get("pdf") is None:
        raise HTTPException(404, "Consent not found")
    file_q = (request.query_params.get("file") or "").strip()
    if not file_q or file_q != (row.get("file_no") or ""):
        raise HTTPException(403, "Provide the matching patient file number to view this consent")
    data = bytes(row["pdf"])
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="consent_{consent_id}.pdf"'})

# ---- QR / remote signing: patient signs on her own phone ---------------------
@app.post("/api/consent/link")
async def create_consent_link(request: Request, user=Depends(require_radiology)):
    """Create a pending consent + a one-time link/QR the patient opens on her own
    phone to read & sign. Her data is pre-registered now; the PDF is filled when she
    signs. Returns the URL and an inline-SVG QR."""
    import secrets
    b = await request.json()
    if not isinstance(b, dict):
        raise HTTPException(400, "Bad request")
    file_no = str(b.get("file_no") or "").strip()
    if not file_no:
        raise HTTPException(400, "A patient file number is required")
    patient_type = (b.get("patient_type") or "").strip().lower()
    if patient_type and patient_type not in _CONSENT_TYPES:
        patient_type = ""
    token = secrets.token_urlsafe(24)
    tech = _consent_signer(user)
    _lnk_name = (b.get("name") or "").strip()
    row = q("""INSERT INTO scheduling.consents
                 (kind, file_no, mrn, patient_name, patient_name_en, procedure, patient_type, physician, technologist,
                  bill_no, site, dob, branch, weight, height, token, status, created_by, created_by_name, expires_at)
               VALUES ('non_pregnancy',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending',%s,%s, NOW() + interval '12 hours')
               RETURNING id""",
            (file_no, (b.get("mrn") or file_no).strip(), _lnk_name, ((b.get("name_en") or "").strip() or _lnk_name),
             (b.get("procedure") or "").strip(), patient_type or None, (b.get("physician") or "").strip() or None,
             tech, (b.get("bill_no") or None), _coerce_site(b.get("site")),
             (b.get("dob") or "").strip() or None, (b.get("branch") or "").strip() or None,
             (b.get("weight") or "").strip() or None, (b.get("height") or "").strip() or None,
             token, user["id"], tech), one=True)
    base = str(request.base_url).rstrip("/")
    # Honour the forwarded host so the link is the public https URL, not the internal one.
    xf_host = request.headers.get("x-forwarded-host")
    xf_proto = request.headers.get("x-forwarded-proto") or "https"
    if xf_host:
        base = f"{xf_proto}://{xf_host}"
    url = f"{base}/consent-sign?t={token}"
    qr = ""
    try:
        import segno
        qr = segno.make(url, error="m").svg_data_uri(scale=5, border=2, dark="#12103a")
    except Exception:
        qr = ""
    insert_audit(user, "CONSENT_LINK", file_no, json.dumps({"id": row["id"]}))
    return {"ok": True, "id": row["id"], "url": url, "qr": qr}

@app.post("/api/consent/send-sms")
async def consent_send_sms(request: Request, user=Depends(require_radiology)):
    """Text the patient the consent link via the configured SMS gateway (alternative to
    the on-screen QR). The link is created by /api/consent/link; this sends it."""
    b = await request.json()
    phone = str((b or {}).get("phone") or "").strip()
    url = str((b or {}).get("url") or "").strip()
    if not phone:
        raise HTTPException(400, "Enter the patient's mobile number")
    if not url:
        raise HTTPException(400, "Missing consent link — create it first")
    if not _sms_configured():
        raise HTTPException(503, "The SMS gateway isn't set up yet. Ask a superadmin to configure it in Settings.")
    msg = f"Meena Radiology · مينا للأشعة\nPlease review & sign your consent form / يرجى مراجعة وتوقيع نموذج الموافقة:\n{url}"
    res = send_sms(phone, msg, sync=True)
    insert_audit(user, "CONSENT_SMS", phone, json.dumps({"ok": bool(res and res.get('ok'))}))
    if not (res and res.get("ok")):
        raise HTTPException(502, f"SMS failed: {(res or {}).get('detail') or 'unknown error'}")
    return {"ok": True}

# ── SMS gateway config (superadmin) ────────────────────────────────────────────
@app.get("/api/sms/config")
def sms_config_get(user=Depends(require_superadmin)):
    c = _sms_config()
    return {"ok": True, "enabled": c["enabled"], "url": c["url"], "method": c["method"],
            "content_type": c["content_type"], "headers": c["headers"], "body": c["body"],
            "sender": c["sender"], "configured": _sms_configured()}

@app.put("/api/sms/config")
async def sms_config_set(request: Request, user=Depends(require_superadmin)):
    b = await request.json()
    if not isinstance(b, dict):
        raise HTTPException(400, "Bad request")
    if "enabled" in b:
        set_setting("sms_enabled", "1" if b.get("enabled") else "0")
    for short, key in (("url", "sms_url"), ("method", "sms_method"), ("content_type", "sms_content_type"),
                       ("headers", "sms_headers"), ("body", "sms_body"), ("sender", "sms_sender")):
        if short in b:
            set_setting(key, str(b.get(short) or ""))
    insert_audit(user, "SMS_CONFIG", None, None)
    return {"ok": True}

@app.post("/api/sms/test")
async def sms_config_test(request: Request, user=Depends(require_superadmin)):
    b = await request.json()
    to = str((b or {}).get("phone") or "").strip()
    if not to:
        raise HTTPException(400, "Enter a phone number to test")
    res = send_sms(to, "Meena test SMS ✓ — your gateway is working.", sync=True)
    return res or {"ok": False, "detail": "no result"}

@app.get("/api/consent/status/{consent_id}")
def consent_status(consent_id: int, user=Depends(require_radiology)):
    """Poll whether a QR consent has been signed yet."""
    r = q("SELECT status, signed_at FROM scheduling.consents WHERE id=%s", (consent_id,), one=True)
    if not r:
        raise HTTPException(404, "Consent not found")
    return {"id": consent_id, "status": r["status"] or "signed",
            "signed_at": str(r["signed_at"]) if r.get("signed_at") else None}

@app.get("/consent-sign")
def serve_consent_sign():
    """Public, login-free consent-signing page opened from the QR on the patient's phone."""
    return FileResponse(os.path.join(DASHBOARD, "consent-sign.html"), media_type="text/html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})

def _consent_by_token(token):
    token = (token or "").strip()
    if not token:
        raise HTTPException(400, "Invalid link")
    r = q("SELECT * FROM scheduling.consents WHERE token=%s", (token,), one=True)
    if not r:
        raise HTTPException(404, "This link is not valid.")
    exp = r.get("expires_at")
    if exp is not None and exp < datetime.now(timezone.utc):
        raise HTTPException(410, "This link has expired. Ask the specialist for a new one.")
    return r

# ── QR document upload ────────────────────────────────────────────────────────
# One-click flow: the tech clicks "Upload document" on the patient card, a QR
# appears, they scan it with a phone, snap/pick a document (outside report,
# referral, external lab), and it's filed onto the patient's Siratech record via
# the SAME proven attachment path used for consents/reports (option B: attached to
# a radiology order). Read-only until the explicit, patient-scoped write.
def _docupload_by_token(token):
    token = (token or "").strip()
    if not token:
        raise HTTPException(400, "Invalid link")
    r = q("SELECT * FROM scheduling.doc_uploads WHERE token=%s", (token,), one=True)
    if not r:
        raise HTTPException(404, "This link is not valid.")
    exp = r.get("expires_at")
    if exp is not None and exp < datetime.now(timezone.utc):
        raise HTTPException(410, "This link has expired. Ask the technologist for a new one.")
    return r

def _doc_to_pdf(raw: bytes, mime: str) -> bytes:
    """Normalise an upload to a PDF: pass a real PDF through, wrap an image (phone
    photo) into a single A4 page with PyMuPDF. Siratech stores the attachment as a PDF."""
    m = (mime or "").lower()
    if "pdf" in m and raw[:5] == b"%PDF-":
        return raw
    import fitz
    ftype = m.split("/")[-1] if "/" in m else "jpeg"
    if ftype in ("jpg", "jpeg", "png", "gif", "bmp", "tiff", "webp"):
        doc = fitz.open(stream=raw, filetype=ftype)
        return doc.convert_to_pdf()
    # Unknown → try as image, else reject.
    try:
        doc = fitz.open(stream=raw, filetype="jpeg")
        return doc.convert_to_pdf()
    except Exception:
        raise HTTPException(400, "Only a PDF or a photo (JPG/PNG) can be uploaded")

def _file_document_to_siratech(doc_id):
    """File an uploaded document onto the patient's Siratech record via the connector's
    /his/consent/file (the proven genFileAttachments attachment mechanism — attached to
    a radiology order, never authorized). Idempotent by filed_siratech."""
    rec = q("""SELECT id, file_no, mrn, patient_name, bill_no, site, pdf, doc_name, filed_siratech
               FROM scheduling.doc_uploads WHERE id=%s""", (doc_id,), one=True)
    if not rec or not rec.get("pdf") or rec.get("filed_siratech"):
        return bool(rec and rec.get("filed_siratech"))
    import base64 as _b64
    body = {
        "file": str(rec["file_no"]).strip(),
        "billNo": (str(rec["bill_no"]).strip() if rec.get("bill_no") else None),
        "site": (rec.get("site") if isinstance(rec.get("site"), int) else None),
        "consentPdf": _b64.b64encode(bytes(rec["pdf"])).decode("ascii"),
        "consentName": (rec.get("doc_name") or "Uploaded document.pdf"),
        "expectName": (rec.get("patient_name") or "").strip() or None,
        "confirm": True,
    }
    out = _bridge_request("/his/consent/file", method="POST", body=body, timeout=60)
    wrote = isinstance(out, dict) and out.get("wrote")
    q("UPDATE scheduling.doc_uploads SET status=%s, filed_siratech=%s WHERE id=%s",
      ("filed" if wrote else "uploaded", bool(wrote), doc_id), exec_only=True)
    return bool(wrote)

@app.post("/api/docupload/link")
async def create_docupload_link(request: Request, user=Depends(require_radiology)):
    """Create a one-time QR the tech opens on a phone to upload a document for this file."""
    import secrets
    b = await request.json()
    if not isinstance(b, dict):
        raise HTTPException(400, "Bad request")
    file_no = str(b.get("file_no") or "").strip()
    if not file_no:
        raise HTTPException(400, "A patient file number is required")
    token = secrets.token_urlsafe(24)
    tech = _consent_signer(user)
    row = q("""INSERT INTO scheduling.doc_uploads
                 (file_no, mrn, patient_name, bill_no, site, token, status, created_by, created_by_name, expires_at)
               VALUES (%s,%s,%s,%s,%s,%s,'pending',%s,%s, NOW() + interval '6 hours') RETURNING id""",
            (file_no, (b.get("mrn") or file_no).strip(), (b.get("name") or "").strip(),
             (b.get("bill_no") or None), _coerce_site(b.get("site")),
             token, user["id"], tech), one=True)
    base = str(request.base_url).rstrip("/")
    xf_host = request.headers.get("x-forwarded-host")
    xf_proto = request.headers.get("x-forwarded-proto") or "https"
    if xf_host:
        base = f"{xf_proto}://{xf_host}"
    url = f"{base}/doc-upload?t={token}"
    qr = ""
    try:
        import segno
        qr = segno.make(url, error="m").svg_data_uri(scale=5, border=2, dark="#12103a")
    except Exception:
        qr = ""
    insert_audit(user, "DOCUPLOAD_LINK", file_no, json.dumps({"id": row["id"]}))
    return {"ok": True, "id": row["id"], "url": url, "qr": qr}

@app.get("/api/docupload/status/{doc_id}")
def docupload_status(doc_id: int, user=Depends(require_radiology)):
    """Poll whether a QR document upload has landed / been filed yet."""
    r = q("SELECT status, filed_siratech, doc_name FROM scheduling.doc_uploads WHERE id=%s",
          (doc_id,), one=True)
    if not r:
        raise HTTPException(404, "Upload not found")
    return {"id": doc_id, "status": r["status"], "filed": bool(r.get("filed_siratech")),
            "docName": r.get("doc_name")}

@app.get("/api/docupload/list")
def docupload_list(request: Request, user=Depends(require_radiology)):
    """The documents already uploaded for a patient file (for the card)."""
    file_no = (request.query_params.get("file") or "").strip()
    if not file_no:
        return {"ok": True, "documents": []}
    rows = q("""SELECT id, doc_name, status, filed_siratech, created_at, created_by_name
                FROM scheduling.doc_uploads
                WHERE file_no=%s AND status IN ('uploaded','filed')
                ORDER BY created_at DESC LIMIT 20""", (file_no,)) or []
    return {"ok": True, "documents": rows}

@app.get("/doc-upload")
def serve_doc_upload():
    """Public, login-free document-upload page opened from the QR on the phone."""
    return FileResponse(os.path.join(DASHBOARD, "doc-upload.html"), media_type="text/html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})

@app.get("/api/doc/info")
def doc_info(request: Request):
    """Public: the patient name for the upload page to show, by one-time token."""
    r = _docupload_by_token(request.query_params.get("t"))
    return {"ok": True, "patientName": r.get("patient_name") or "", "file": r.get("file_no"),
            "status": r.get("status"), "done": r.get("status") in ("uploaded", "filed")}

@app.post("/api/doc/submit")
async def doc_submit(request: Request):
    """Public: receive the uploaded document (data-URL), store it, and file it to the
    patient's Siratech record. No login — the one-time token authorises this file only."""
    b = await request.json()
    if not isinstance(b, dict):
        raise HTTPException(400, "Bad request")
    r = _docupload_by_token(b.get("t"))
    if r.get("status") in ("uploaded", "filed"):
        return {"ok": True, "already": True, "filed": bool(r.get("filed_siratech"))}
    data_url = str(b.get("file") or "")
    m = re.match(r"data:([^;]+);base64,(.+)$", data_url, re.S)
    if not m:
        raise HTTPException(400, "No file was received")
    mime, b64 = m.group(1), m.group(2)
    try:
        import base64 as _b64
        raw = _b64.b64decode(b64)
    except Exception:
        raise HTTPException(400, "The file could not be read")
    if len(raw) < 100:
        raise HTTPException(400, "The file is empty")
    if len(raw) > 15_000_000:
        raise HTTPException(413, "The file is too large (max ~15 MB)")
    pdf_bytes = _doc_to_pdf(raw, mime)
    label = (str(b.get("name") or "Document").strip() or "Document")[:60]
    ksa = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%Y-%m-%d")
    doc_name = f"{label} - {ksa}.pdf"
    q("""UPDATE scheduling.doc_uploads SET pdf=%s, doc_name=%s, status='uploaded', uploaded_at=NOW()
         WHERE id=%s""", (psycopg2.Binary(pdf_bytes), doc_name, r["id"]), exec_only=True)
    filed = False
    try:
        filed = _file_document_to_siratech(r["id"])
    except Exception:
        filed = False
    return {"ok": True, "filed": bool(filed)}

@app.get("/api/public/consent/{token}")
def public_consent_get(token: str):
    """Prefill data for the patient's phone page (gated by the unguessable token)."""
    r = _consent_by_token(token)
    if (r.get("status") or "") == "signed":
        return {"signed": True}
    return {"signed": False, "name": r.get("patient_name") or "", "file_no": r.get("file_no") or "",
            "mrn": r.get("mrn") or "", "dob": r.get("dob") or "", "procedure": r.get("procedure") or "",
            "patient_type": r.get("patient_type") or "", "branch": r.get("branch") or "",
            "weight": r.get("weight") or "", "height": r.get("height") or ""}

@app.get("/api/public/consent-selftest")
def public_consent_selftest():
    """No-PHI health check for the consent form renderer: renders the official form
    with dummy data so we can confirm PyMuPDF works on THIS server (the patient's
    form.png is broken when this fails). Returns the byte size on success or the
    real error on failure. Safe to expose — no patient data involved."""
    try:
        from consent_pdf import render_consent_png
        png = render_consent_png({"name": "TEST", "mrn": "0", "dob": "", "procedure": "TEST",
                                  "weight": "", "height": "", "patient_type": "", "physician": "",
                                  "technologist": ""})
        return {"ok": True, "png_bytes": len(png)}
    except Exception as e:
        import traceback
        return {"ok": False, "error": f"{type(e).__name__}: {e}",
                "trace": traceback.format_exc()[-800:]}

@app.get("/api/public/consent/{token}/form.png")
def public_consent_form_image(token: str):
    """Render the OFFICIAL Meena form pre-filled with the patient's data as an image,
    so she reads the real document on her phone before signing (token-gated)."""
    from consent_pdf import render_consent_png
    r = _consent_by_token(token)
    # Once signed, the token must stop revealing the patient's data (it may live on in
    # a QR photo / browser history / proxy logs for the rest of its TTL).
    if (r.get("status") or "") == "signed":
        raise HTTPException(410, "This consent has already been signed.")
    # The renderer's font (Helvetica) can't shape Arabic, so use the English name for the
    # printed form — same as the final signed PDF — else the name column renders blank.
    _form_name = (r.get("patient_name_en") or "").strip() or (r.get("patient_name") or "")
    data = {
        "name": _form_name, "mrn": r.get("mrn") or r.get("file_no") or "",
        "dob": r.get("dob") or "", "procedure": r.get("procedure") or "",
        "weight": r.get("weight") or "", "height": r.get("height") or "",
        "patient_type": r.get("patient_type") or "", "physician": r.get("physician") or "",
        "technologist": r.get("technologist") or "",
    }
    try:
        png = render_consent_png(data)
    except Exception as e:
        raise HTTPException(500, f"Could not render the form: {e}")
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "no-store"})

@app.post("/api/public/consent/{token}/sign")
async def public_consent_sign(token: str, request: Request):
    """The patient submits her signed consent from her phone. One-time: the token is
    burned once signed. No login — the unguessable token is the authorization."""
    import base64
    from consent_pdf import generate_consent_pdf
    r = _consent_by_token(token)
    if (r.get("status") or "") == "signed":
        raise HTTPException(409, "This consent has already been signed.")
    b = await request.json()
    if not isinstance(b, dict):
        raise HTTPException(400, "Bad request")
    reason = (b.get("reason") or "").strip().lower()
    if reason and reason not in _CONSENT_REASONS:
        raise HTTPException(400, "Invalid reason")
    lmp = (b.get("lmp_date") or "").strip()
    if reason == "lmp" and not lmp:
        raise HTTPException(400, "Enter the date of the last menstrual period")
    if reason != "lmp":
        lmp = ""   # never stamp an LMP date next to a different ticked reason
    sig = b.get("signature") or ""
    if not isinstance(sig, str) or len(sig) > 3_000_000:   # ~2MB PNG ceiling
        raise HTTPException(400, "Signature is missing or too large")
    png = None
    if sig.startswith("data:image"):
        try:
            png = base64.b64decode(sig.split(",", 1)[1])
        except Exception:
            png = None
    if not png:
        raise HTTPException(400, "Signature is required")
    if not _signature_has_ink(png):
        raise HTTPException(400, "The signature looks blank — please sign before submitting")
    now = _ksa_now()
    weight = (b.get("weight") or r.get("weight") or "").strip()
    height = (b.get("height") or r.get("height") or "").strip()
    hcg = (b.get("hcg") or "").strip()
    # PDF font (Helvetica) can't render Arabic → print the English name; the Arabic display
    # name stays on the record (patient_name) for the on-screen views.
    _pdf_name = (r.get("patient_name_en") or "").strip() or (r.get("patient_name") or "")
    data = {
        "name": _pdf_name, "mrn": r.get("mrn") or r.get("file_no") or "",
        "dob": r.get("dob") or "", "procedure": r.get("procedure") or "",
        "weight": weight, "height": height, "hcg": hcg, "patient_type": r.get("patient_type") or "",
        "reason": reason, "lmp_date": lmp, "undersigned": _pdf_name,
        "physician": r.get("physician") or "", "technologist": r.get("technologist") or "",
        "date": now.strftime("%Y-%m-%d"), "time": now.strftime("%H:%M"),
    }
    try:
        pdf = generate_consent_pdf(data, png)
    except Exception as e:
        raise HTTPException(500, f"Could not generate the consent PDF: {e}")
    # Atomic one-time burn: only the first submission wins (guards a concurrent
    # double-sign from overwriting the stored PDF).
    done = q("""UPDATE scheduling.consents
                  SET pdf=%s, reason=%s, lmp_date=%s, weight=%s, height=%s, hcg=%s,
                      status='signed', signed_at=NOW()
                WHERE id=%s AND status <> 'signed' RETURNING id""",
             (psycopg2.Binary(pdf), reason or None, lmp or None, weight or None, height or None, hcg or None, r["id"]),
             one=True)
    if not done:
        raise HTTPException(409, "This consent has already been signed.")
    # File it to the patient's Siratech record now (best-effort; rides the report as a
    # fallback if unavailable). The signer is the patient's phone, so run it here.
    try:
        _file_consent_to_siratech(done["id"])
    except Exception:
        pass
    return {"ok": True}

_PREF_KINDS = ("off", "unavailable")

@app.get("/api/preferences")
def list_preferences(request: Request, user=Depends(get_current_user)):
    """Shift preferences for a month. Staff sees their own; a team lead/manager
    sees everyone in scope (own branch / all)."""
    p = request.query_params
    year = _int_or_400(p.get("year"), "year")
    month = _int_or_400(p.get("month"), "month")
    if user["role"] == "staff":
        sid = user.get("staff_id")
        if not sid:
            return {"year": year, "month": month, "preferences": []}
        rows = q("""SELECT id, staff_id, day, kind, note FROM scheduling.shift_preferences
                    WHERE staff_id=%s AND year=%s AND month=%s ORDER BY day""", (sid, year, month))
        return {"year": year, "month": month, "preferences": rows}
    if user["role"] not in ("admin", "manager", "superadmin"):
        raise HTTPException(403, "Forbidden")
    _, branch_ids = _report_branch_scope(user, p.get("branch_id"))
    rows = q("""SELECT pr.id, pr.staff_id, pr.day, pr.kind, pr.note, s.name AS staff_name, s.branch_id
                FROM scheduling.shift_preferences pr
                JOIN scheduling.staff s ON s.id=pr.staff_id
                WHERE pr.year=%s AND pr.month=%s AND s.branch_id = ANY(%s)
                  AND COALESCE(s.active,true)=true
                ORDER BY s.name, pr.day""", (year, month, branch_ids))
    return {"year": year, "month": month, "preferences": rows}

@app.put("/api/preferences")
async def set_preference(request: Request, user=Depends(get_current_user)):
    """Set or clear one day's preference. Staff edit their own; a lead/manager
    may edit any staff in scope. kind 'none' clears the day."""
    body = await request.json()
    year = _int_or_400(body.get("year"), "year")
    month = _int_or_400(body.get("month"), "month")
    day = _int_or_400(body.get("day"), "day")
    import calendar as _cal
    if month < 1 or month > 12 or day < 1 or day > _cal.monthrange(year, month)[1]:
        raise HTTPException(400, "Invalid day for that month")
    # Resolve the target staff and authorize.
    if user["role"] == "staff":
        sid = user.get("staff_id")
        if not sid:
            raise HTTPException(400, "No staff record linked to your account")
        if body.get("staff_id") and int(body["staff_id"]) != int(sid):
            raise HTTPException(403, "Forbidden")
    else:
        sid = _int_or_400(body.get("staff_id"), "staff_id")
        if not _can_manage_staff(user, sid):
            raise HTTPException(403, "Forbidden")
    kind = (body.get("kind") or "off").strip().lower()
    if kind in ("none", "clear", ""):
        q("DELETE FROM scheduling.shift_preferences WHERE staff_id=%s AND year=%s AND month=%s AND day=%s",
          (sid, year, month, day), exec_only=True)
        return {"ok": True, "cleared": True}
    if kind not in _PREF_KINDS:
        raise HTTPException(400, "kind must be 'off', 'unavailable' or 'none'")
    note = (body.get("note") or "").strip()[:200] or None
    q("""INSERT INTO scheduling.shift_preferences (staff_id,year,month,day,kind,note)
         VALUES (%s,%s,%s,%s,%s,%s)
         ON CONFLICT (staff_id,year,month,day)
         DO UPDATE SET kind=EXCLUDED.kind, note=EXCLUDED.note""",
      (sid, year, month, day, kind, note), exec_only=True)
    return {"ok": True, "kind": kind}

# ── Downtime registration (system-down patient log + Accession Number) ─────────
_DOWNTIME_MODALITIES = ("X-Ray", "CT", "US", "MAMO", "BMD", "Other")

def _branch_code(name):
    """Short branch code for the accession, e.g. 'NEST 3' → 'N3'. Capped at 3
    chars so the whole accession stays within DICOM's 16-char SH limit."""
    s = (name or "").upper()
    letters = "".join(c for c in s if c.isalpha())
    digits  = "".join(c for c in s if c.isdigit())
    return ((letters[:1] or "B") + digits)[:3] or "B"

def _next_accession(code, ymd):
    """Atomic per-(code, day) running number → a unique, DICOM-safe accession.
    The counter upsert serialises on the row, so concurrent registrations from
    two staff never get the same number."""
    row = q("""INSERT INTO scheduling.downtime_counters (code, ymd, n) VALUES (%s,%s,1)
               ON CONFLICT (code, ymd) DO UPDATE SET n = scheduling.downtime_counters.n + 1
               RETURNING n""", (code, ymd), one=True)
    n = int(row["n"])
    acc = f"DT{code}-{ymd}-{n:03d}"           # e.g. DTN3-260625-012
    if len(acc) > 16:                          # DICOM SH cap — drop separators if a
        acc = f"DT{code}{ymd}{n}"              # huge same-day count would overflow
    return acc

def _downtime_message(row, branch_name):
    """The ready-to-forward text the staff sends to the reporting company."""
    exam = row["modality"] + (f" / {row['procedure_name']}" if row.get("procedure_name") else "")
    lines = [
        "Meena Radiology — Downtime study",
        f"Patient: {row['patient_name']}",
        f"ID: {row['patient_id']}",
        f"Exam: {exam}",
        f"Accession: {row['accession']}",
    ]
    if row.get("indication"):
        lines.append(f"Indication: {row['indication']}")
    if row.get("specialist_id"):
        lines.append(f"Specialist ID: {row['specialist_id']}")
    lines.append(f"Branch: {branch_name}")
    return "\n".join(lines)

@app.post("/api/downtime")
async def create_downtime(request: Request, user=Depends(get_current_user)):
    """Log a patient while the radiology system is down and mint a unique
    Accession Number. Any logged-in staff member may register for their branch."""
    body = await request.json()
    branch_id = user.get("branch_id") if user["role"] == "staff" else (body.get("branch_id") or user.get("branch_id"))
    branch_id = _int_or_400(branch_id, "branch_id")
    if not can_access_branch(user, branch_id):
        raise HTTPException(403, "Forbidden")
    name = (body.get("patient_name") or "").strip()[:120]
    pid  = (body.get("patient_id") or "").strip()[:40]
    modality = (body.get("modality") or "").strip()
    if not name or not pid or not modality:
        raise HTTPException(400, "patient_name, patient_id and modality are required")
    branch = q("SELECT name FROM scheduling.branches WHERE id=%s", (branch_id,), one=True)
    if not branch:
        raise HTTPException(404, "Branch not found")
    from datetime import datetime, timezone, timedelta
    ymd = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%y%m%d")
    accession = _next_accession(_branch_code(branch["name"]), ymd)
    row = q("""INSERT INTO scheduling.downtime_studies
               (branch_id, accession, patient_name, patient_id, modality, procedure_name,
                indication, ward, created_by, created_by_staff)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               RETURNING id, accession, patient_name, patient_id, modality, procedure_name,
                         indication, ward, status,
                         TO_CHAR(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at""",
            (branch_id, accession, name, pid, modality[:40],
             (body.get("procedure") or "").strip()[:120] or None,
             (body.get("indication") or "").strip()[:200] or None,
             (body.get("ward") or "").strip()[:80] or None,
             user["id"], user.get("staff_id")), one=True)
    insert_audit(user, "DOWNTIME_ADD", f"branch:{branch_id}", accession)
    msg = _downtime_message(row, branch["name"])
    # Best-effort: WhatsApp the message to the registering staff so they can forward
    # it to the reporting company. force=True so it isn't dropped by the type filter.
    try:
        if user.get("staff_id"):
            st = q("SELECT phone FROM scheduling.staff WHERE id=%s", (user["staff_id"],), one=True)
            if st and st.get("phone"):
                send_whatsapp(st["phone"], msg, ntype="downtime", link="downtime", force=True)
    except Exception:
        pass
    return {"study": row, "message": msg, "branch_name": branch["name"]}

@app.get("/api/downtime")
def list_downtime(request: Request, user=Depends(get_current_user)):
    """Downtime log. Staff see their own branch; a lead/manager their scope."""
    p = request.query_params
    if user["role"] == "staff":
        if not user.get("branch_id"):
            return {"studies": []}
        branch_ids = [user["branch_id"]]
    else:
        _, branch_ids = _report_branch_scope(user, p.get("branch_id"))
    cond, vals = ["d.branch_id = ANY(%s)"], [branch_ids]
    if _valid_iso_date(p.get("from")):   # ignore malformed dates instead of 500-ing
        cond.append("d.created_at >= %s"); vals.append(p.get("from"))
    if _valid_iso_date(p.get("to")):
        cond.append("d.created_at < (%s::date + 1)"); vals.append(p.get("to"))
    rows = q(f"""SELECT d.id, d.accession, d.patient_name, d.patient_id, d.modality, d.procedure_name,
                       d.indication, d.ward, d.status, d.branch_id, b.name AS branch_name,
                       d.specialist_id, d.source, d.created_by AS created_by_uid,
                       COALESCE(s.name, u.username,
                                CASE WHEN d.specialist_id IS NOT NULL THEN 'Public · ' || d.specialist_id END) AS created_by_name,
                       TO_CHAR(d.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
                FROM scheduling.downtime_studies d
                JOIN scheduling.branches b ON b.id=d.branch_id
                LEFT JOIN scheduling.users u ON u.id=d.created_by
                LEFT JOIN scheduling.staff s ON s.id=d.created_by_staff
                WHERE {' AND '.join(cond)}
                ORDER BY d.created_at DESC LIMIT 500""", tuple(vals))
    # A lead/manager may delete any entry in scope; a staff member only their own.
    is_admin = user["role"] in ("admin", "manager", "superadmin")
    for r in rows:
        r["can_delete"] = bool(is_admin or (r.get("created_by_uid") and r["created_by_uid"] == user.get("id")))
        r.pop("created_by_uid", None)
    return {"studies": rows, "modalities": list(_DOWNTIME_MODALITIES)}

@app.put("/api/downtime/{did}/status")
async def downtime_status(did: int, request: Request, user=Depends(require_admin)):
    """Mark a downtime study reconciled (entered into the main system) — lead/manager."""
    body = await request.json()
    status = (body.get("status") or "").strip()
    if status not in ("pending", "reconciled"):
        raise HTTPException(400, "status must be 'pending' or 'reconciled'")
    d = q("SELECT branch_id FROM scheduling.downtime_studies WHERE id=%s", (did,), one=True)
    if not d:
        raise HTTPException(404, "Not found")
    if not can_access_branch(user, d["branch_id"]):
        raise HTTPException(403, "Forbidden")
    if status == "reconciled":
        q("""UPDATE scheduling.downtime_studies SET status='reconciled',
              reconciled_by=%s, reconciled_at=NOW() WHERE id=%s""", (user["id"], did), exec_only=True)
    else:
        q("""UPDATE scheduling.downtime_studies SET status='pending',
              reconciled_by=NULL, reconciled_at=NULL WHERE id=%s""", (did,), exec_only=True)
    return {"ok": True, "status": status}

@app.delete("/api/downtime/{did}")
def delete_downtime(did: int, user=Depends(get_current_user)):
    """Remove a mistaken downtime entry. A lead/manager may delete any entry in
    their branch scope; a staff member may delete only their OWN entry. (The
    minted accession number is simply retired — gaps in the sequence are fine.)"""
    d = q("SELECT branch_id, created_by, accession FROM scheduling.downtime_studies WHERE id=%s", (did,), one=True)
    if not d:
        raise HTTPException(404, "Not found")
    is_admin = user["role"] in ("admin", "manager", "superadmin")
    if is_admin:
        if not can_access_branch(user, d["branch_id"]):
            raise HTTPException(403, "Forbidden")
    elif user["role"] == "staff":
        # Staff can only delete an entry they created, in their own branch.
        if d.get("created_by") != user.get("id") or not can_access_branch(user, d["branch_id"]):
            raise HTTPException(403, "You can only delete your own entry — ask your team lead.")
    else:
        raise HTTPException(403, "Forbidden")
    q("DELETE FROM scheduling.downtime_studies WHERE id=%s", (did,), exec_only=True)
    insert_audit(user, "DOWNTIME_DELETE", f"branch:{d['branch_id']}", d.get("accession"))
    return {"ok": True}

# ── Public downtime link (no login) ───────────────────────────────────────────
# A shareable, unguessable link (sent in a staff WhatsApp group) lets someone who
# has NO platform account log a downtime patient: they pick the branch, fill the
# data, type the specialist's ID, and get the Accession + message. The secret
# token in the link is the gate — only people who have the link can use it.
def _downtime_token():
    import secrets
    t = get_setting("downtime_public_token")
    if not t:
        t = secrets.token_urlsafe(24)
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('downtime_public_token',%s)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (t,), exec_only=True)
    return t

def _downtime_public_url():
    base = (os.environ.get("APP_URL", "").strip().rstrip("/"))
    return f"{base}/dt?t={_downtime_token()}"

# Light global throttle so a leaked link can't be used to flood the table.
_downtime_pub_hits: list = []
def _downtime_throttle():
    import time as _t
    now = _t.time()
    _downtime_pub_hits[:] = [h for h in _downtime_pub_hits if now - h < 60]
    if len(_downtime_pub_hits) >= 60:        # max 60 public submissions / minute
        raise HTTPException(429, "Too many submissions, please wait a moment.")
    _downtime_pub_hits.append(now)

def _check_downtime_token(token):
    import secrets
    # Compare as bytes: compare_digest raises TypeError on non-ASCII str operands,
    # and the token comes straight from a client query param (scanners/mangled links
    # send arbitrary bytes) — that must be a clean 403, not a 500.
    if not token or not secrets.compare_digest(str(token).encode(), str(_downtime_token()).encode()):
        raise HTTPException(403, "Invalid or expired link. Ask your team lead for a new one.")

@app.get("/api/public/downtime/info")
def public_downtime_info(request: Request):
    """Branch list for the public form. Gated by the link token (no login)."""
    _check_downtime_token(request.query_params.get("token") or request.query_params.get("t"))
    branches = q("SELECT id, name FROM scheduling.branches ORDER BY name")
    return {"ok": True, "branches": branches, "modalities": list(_DOWNTIME_MODALITIES)}

@app.post("/api/public/downtime")
async def public_create_downtime(request: Request):
    """Create a downtime study from the public link — no account needed. The
    performer is captured as a free-text specialist ID instead of a user id."""
    _check_downtime_token(request.query_params.get("token") or request.query_params.get("t"))
    _downtime_throttle()
    body = await request.json()
    branch_id = _int_or_400(body.get("branch_id"), "branch_id")
    branch = q("SELECT name FROM scheduling.branches WHERE id=%s", (branch_id,), one=True)
    if not branch:
        raise HTTPException(404, "Branch not found")
    name = (body.get("patient_name") or "").strip()[:120]
    pid  = (body.get("patient_id") or "").strip()[:40]
    modality = (body.get("modality") or "").strip()
    specialist = (body.get("specialist_id") or "").strip()[:40]
    if not name or not pid or not modality:
        raise HTTPException(400, "patient_name, patient_id and modality are required")
    if not specialist:
        raise HTTPException(400, "specialist_id is required")
    from datetime import datetime, timezone, timedelta
    ymd = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%y%m%d")
    accession = _next_accession(_branch_code(branch["name"]), ymd)
    row = q("""INSERT INTO scheduling.downtime_studies
               (branch_id, accession, patient_name, patient_id, modality, procedure_name,
                indication, ward, specialist_id, source)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'public')
               RETURNING id, accession, patient_name, patient_id, modality, procedure_name,
                         indication, ward, specialist_id, status,
                         TO_CHAR(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at""",
            (branch_id, accession, name, pid, modality[:40],
             (body.get("procedure") or "").strip()[:120] or None,
             (body.get("indication") or "").strip()[:200] or None,
             (body.get("ward") or "").strip()[:80] or None,
             specialist), one=True)
    insert_audit({"id": None, "username": f"public-link:{specialist}", "role": "public",
                  "branch_name": branch["name"]}, "DOWNTIME_ADD_PUBLIC", f"branch:{branch_id}", accession)
    return {"study": row, "message": _downtime_message(row, branch["name"]), "branch_name": branch["name"]}

@app.get("/api/downtime/public-link")
def get_downtime_link(user=Depends(require_reviewer)):
    """The shareable public link (manager/superadmin)."""
    return {"url": _downtime_public_url(), "token": _downtime_token()}

@app.post("/api/downtime/public-link/regenerate")
def regen_downtime_link(user=Depends(require_reviewer)):
    """Rotate the token — old links stop working immediately."""
    import secrets
    t = secrets.token_urlsafe(24)
    q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('downtime_public_token',%s)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (t,), exec_only=True)
    insert_audit(user, "DOWNTIME_LINK_REGEN")
    return {"url": _downtime_public_url(), "token": t}

# ── Secure radiology-CD transfer ──────────────────────────────────────────────
# A branch employee opens a token link and uploads a full CD image (ISO or ZIP);
# an authorised user downloads it to import into PACS ("Import from CD"). Files
# are streamed to disk in chunks (handles ~CD-sized 4 GB uploads with progress),
# validated (ISO/ZIP only, size cap, magic-byte sniff, best-effort DICOMDIR check
# for ZIPs), auto-deleted after a short TTL, and never modified/transcoded.
import tempfile as _tempfile

CDXFER_DIR = os.environ.get("CDXFER_DIR", os.path.join(_tempfile.gettempdir(), "meena_cdxfer"))
CDXFER_MAX_BYTES = int(os.environ.get("CDXFER_MAX_BYTES", str(4 * 1024**3)))   # 4 GB
CDXFER_MAX_FILES = int(os.environ.get("CDXFER_MAX_FILES", "30000"))           # folder-upload guard
CDXFER_TTL_HOURS = int(os.environ.get("CDXFER_TTL_HOURS", "48"))
CDXFER_CHUNK = 8 * 1024 * 1024                                                 # 8 MB advisory
_CDXFER_ALLOWED_EXT = {".iso", ".zip"}
# Belt-and-braces: even though only .iso/.zip are accepted, name the executable
# types we must never accept so the intent is explicit and testable.
_CDXFER_BLOCKED_EXT = {".exe", ".bat", ".cmd", ".msi", ".com", ".scr", ".ps1", ".vbs", ".js", ".jar", ".dll"}

def _cdxfer_dir():
    os.makedirs(CDXFER_DIR, exist_ok=True)
    return CDXFER_DIR

def _cdxfer_token():
    import secrets
    t = get_setting("cdxfer_public_token")
    if not t:
        t = secrets.token_urlsafe(24)
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('cdxfer_public_token',%s)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (t,), exec_only=True)
    return t

def _cdxfer_public_url():
    base = (os.environ.get("APP_URL", "").strip().rstrip("/"))
    return f"{base}/cdupload?t={_cdxfer_token()}"

def _check_cdxfer_token(token):
    import secrets
    if not token or not secrets.compare_digest(str(token).encode(), str(_cdxfer_token()).encode()):
        raise HTTPException(403, "Invalid or expired link. Ask the radiology team for a new one.")

_cdxfer_hits: list = []
def _cdxfer_throttle():
    # Throttle uploads STARTED per minute (not per chunk — a 4 GB upload is many
    # chunks and must not trip this).
    import time as _t
    now = _t.time()
    _cdxfer_hits[:] = [h for h in _cdxfer_hits if now - h < 60]
    if len(_cdxfer_hits) >= 20:
        raise HTTPException(429, "Too many uploads just now — please wait a moment.")
    _cdxfer_hits.append(now)

def _req_ip(request: Request):
    xff = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return xff or (request.client.host if request.client else "")

def _cdxfer_ext(name):
    m = re.search(r"(\.[A-Za-z0-9]+)$", (name or "").strip())
    return (m.group(1).lower() if m else "")

def _cdxfer_sniff(path, kind):
    """Best-effort content check that the stored file really is what it claims —
    without modifying it. Returns (ok, note)."""
    try:
        with open(path, "rb") as f:
            head = f.read(8)
            if kind == "zip":
                if head[:4] not in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
                    return False, "Not a valid ZIP file (bad signature)."
                # Best-effort: does it contain DICOMDIR or .dcm entries?
                try:
                    import zipfile
                    with zipfile.ZipFile(path) as z:
                        names = z.namelist()
                    has_dicomdir = any(n.upper().rstrip("/").endswith("DICOMDIR") for n in names)
                    has_dcm = any(n.lower().endswith(".dcm") for n in names)
                    if has_dicomdir:
                        return True, "ZIP contains DICOMDIR."
                    if has_dcm:
                        return True, "ZIP contains DICOM (.dcm) files, no DICOMDIR."
                    return True, "ZIP OK, but no DICOMDIR/.dcm detected — verify contents."
                except Exception:
                    return True, "ZIP signature OK (couldn't inspect entries)."
            else:  # iso
                f.seek(32769)                       # ISO9660 primary volume descriptor
                if f.read(5) == b"CD001":
                    return True, "ISO9660 signature present."
                return True, "Saved as-is (no ISO9660 signature found — verify it mounts)."
    except Exception as e:
        return True, f"Saved (sniff skipped: {e})"

def _cdxfer_safe_relpath(rel):
    """Sanitise a client-supplied relative path (folder upload) so it can never
    escape the transfer directory — drop drive letters, '', '.', '..' segments."""
    rel = (rel or "").replace("\\", "/").replace("\x00", "")   # NUL would ValueError->500 in open()
    parts = []
    for p in rel.split("/"):
        p = p.strip()
        if not p or p in (".", "..") or (len(p) == 2 and p[1] == ":"):
            continue
        parts.append(p)
    return "/".join(parts)

def _cdxfer_pack_folder(base, zip_path):
    """Walk an uploaded folder and pack it into a STORED (uncompressed, byte-exact)
    ZIP. Blocking + potentially large, so callers run it off the event loop."""
    import zipfile
    files = [(os.path.join(r, fn), os.path.relpath(os.path.join(r, fn), base))
             for r, _d, fs in os.walk(base) for fn in fs]
    if not files:
        return 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        for full, arc in files:
            z.write(full, arc)
    return len(files)

def _cdxfer_remove(stored_name):
    """Remove a stored artifact — a single file OR a folder-upload directory."""
    if not stored_name:
        return
    p = os.path.join(_cdxfer_dir(), stored_name)
    try:
        if os.path.isdir(p):
            import shutil
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.exists(p):
            os.remove(p)
    except OSError:
        pass

@app.post("/api/public/cdxfer/init")
async def cdxfer_init(request: Request):
    """Start an upload from the branch link: validate the metadata + declared file,
    create the record, and return a ref + upload_id the chunks are posted with."""
    _check_cdxfer_token(request.query_params.get("t") or request.query_params.get("token"))
    _cdxfer_throttle()
    b = await request.json()
    if not isinstance(b, dict):
        raise HTTPException(400, "Invalid request body")
    import secrets, uuid
    from datetime import datetime, timezone, timedelta
    mode = (b.get("mode") or "").strip().lower()
    filename = (b.get("filename") or "").strip()
    try:
        size = int(b.get("size") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid file size")
    if size <= 0:
        raise HTTPException(400, "The upload looks empty.")
    if size > CDXFER_MAX_BYTES:
        raise HTTPException(400, f"Too large — the limit is {CDXFER_MAX_BYTES // (1024**3)} GB.")
    file_no = (b.get("file_no") or "").strip()[:40]
    uploader = (b.get("uploader") or "").strip()[:80]
    if not file_no or not uploader:
        raise HTTPException(400, "Medical file number and your name are required.")
    ref = "CDX-" + secrets.token_hex(4).upper()
    upload_id = secrets.token_urlsafe(18)
    expires = datetime.now(timezone.utc) + timedelta(hours=CDXFER_TTL_HOURS)
    if mode == "folder":
        # Whole-CD (directory) upload: files stream in individually, then finish
        # packs them into one byte-exact ZIP. stored_name is a working directory.
        kind = "folder"
        stored = uuid.uuid4().hex
        os.makedirs(os.path.join(_cdxfer_dir(), stored), exist_ok=True)
    else:
        ext = _cdxfer_ext(filename)
        if ext in _CDXFER_BLOCKED_EXT or ext not in _CDXFER_ALLOWED_EXT:
            raise HTTPException(400, "Only ISO or ZIP CD images are allowed.")
        kind = "iso" if ext == ".iso" else "zip"
        stored = uuid.uuid4().hex + ext
        open(os.path.join(_cdxfer_dir(), stored), "wb").close()
    q("""INSERT INTO scheduling.cd_transfers
           (ref, upload_id, file_no, branch, exam_type, exam_date, uploader,
            patient_initials, note, orig_name, stored_name, kind, size_bytes,
            status, upload_ip, expires_at)
         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,0,'uploading',%s,%s)""",
      (ref, upload_id, file_no, (b.get("branch") or "").strip()[:80],
       (b.get("exam_type") or "").strip()[:80], (b.get("exam_date") or "").strip()[:20],
       uploader, (b.get("patient_initials") or "").strip()[:12] or None,
       (b.get("note") or "").strip()[:500] or None, filename[:200], stored, kind,
       _req_ip(request), expires), exec_only=True)
    return {"ok": True, "ref": ref, "upload_id": upload_id, "chunk_size": CDXFER_CHUNK}

@app.post("/api/public/cdxfer/chunk")
async def cdxfer_chunk(request: Request):
    """Append one raw chunk to the in-progress upload (ordered by index)."""
    _check_cdxfer_token(request.query_params.get("t") or request.query_params.get("token"))
    upload_id = (request.query_params.get("upload_id") or "").strip()
    row = q("SELECT id, stored_name, size_bytes, status FROM scheduling.cd_transfers WHERE upload_id=%s",
            (upload_id,), one=True)
    if not row or row["status"] != "uploading":
        raise HTTPException(404, "Upload session not found or already finished.")
    path = os.path.join(_cdxfer_dir(), row["stored_name"])
    if not os.path.exists(path):
        raise HTTPException(410, "Upload session expired — please start again.")
    # Stream the body to disk incrementally instead of await request.body() (which
    # would buffer the WHOLE chunk in RAM before any check — a token-holder could
    # OOM the server with one oversized chunk). Enforce a hard per-request ceiling
    # and the running total cap as bytes arrive.
    HARD_CHUNK = 32 * 1024 * 1024   # generous headroom over the 8 MB advisory chunk
    clen = request.headers.get("content-length")
    if clen and clen.isdigit() and int(clen) > HARD_CHUNK:
        raise HTTPException(413, "Chunk too large.")
    def _abort():
        try: os.remove(path)
        except OSError: pass
        q("UPDATE scheduling.cd_transfers SET status='failed' WHERE id=%s", (row["id"],), exec_only=True)
    written, total = 0, row["size_bytes"]
    with open(path, "ab") as f:
        async for part in request.stream():
            if not part:
                continue
            written += len(part)
            total += len(part)
            if written > HARD_CHUNK:
                _abort()
                raise HTTPException(413, "Chunk too large.")
            if total > CDXFER_MAX_BYTES:
                _abort()
                raise HTTPException(413, "File exceeds the size limit.")
            f.write(part)
    q("UPDATE scheduling.cd_transfers SET size_bytes=%s WHERE id=%s", (total, row["id"]), exec_only=True)
    return {"ok": True, "received": total}

@app.post("/api/public/cdxfer/file")
async def cdxfer_file(request: Request):
    """One file of a whole-CD (folder) upload, streamed to its place in the working
    directory. The relative path (within the chosen folder) comes in X-Rel-Path."""
    _check_cdxfer_token(request.query_params.get("t") or request.query_params.get("token"))
    import urllib.parse
    upload_id = (request.query_params.get("upload_id") or "").strip()
    row = q("SELECT id, stored_name, size_bytes, status, kind, file_count FROM scheduling.cd_transfers WHERE upload_id=%s",
            (upload_id,), one=True)
    if not row or row["status"] != "uploading" or row["kind"] != "folder":
        raise HTTPException(404, "Upload session not found or already finished.")
    # Cap the file COUNT (empty files add 0 bytes, so the size cap alone can't stop
    # an unbounded flood of tiny/empty files exhausting inodes). Every file counts.
    if (row["file_count"] or 0) >= CDXFER_MAX_FILES:
        _cdxfer_remove(row["stored_name"])
        q("UPDATE scheduling.cd_transfers SET status='failed' WHERE id=%s", (row["id"],), exec_only=True)
        raise HTTPException(413, "Too many files in this upload.")
    base = os.path.join(_cdxfer_dir(), row["stored_name"])
    if not os.path.isdir(base):
        raise HTTPException(410, "Upload session expired — please start again.")
    rel = _cdxfer_safe_relpath(urllib.parse.unquote(
        request.headers.get("x-rel-path") or request.query_params.get("path") or ""))
    if not rel:
        raise HTTPException(400, "Missing file path.")
    dest = os.path.join(base, *rel.split("/"))
    base_real = os.path.realpath(base)
    if not (os.path.realpath(dest) == base_real or os.path.realpath(dest).startswith(base_real + os.sep)):
        raise HTTPException(400, "Bad file path.")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    total = row["size_bytes"]
    with open(dest, "wb") as f:
        async for part in request.stream():
            if not part:
                continue
            total += len(part)
            if total > CDXFER_MAX_BYTES:
                _cdxfer_remove(row["stored_name"])
                q("UPDATE scheduling.cd_transfers SET status='failed' WHERE id=%s", (row["id"],), exec_only=True)
                raise HTTPException(413, "Total upload exceeds the size limit.")
            f.write(part)
    # Atomic increment so concurrent files can't undercount past the cap.
    q("UPDATE scheduling.cd_transfers SET size_bytes=%s, file_count=file_count+1 WHERE id=%s",
      (total, row["id"]), exec_only=True)
    return {"ok": True, "received": total}

@app.post("/api/public/cdxfer/finish")
async def cdxfer_finish(request: Request):
    """Finalise the upload: verify the file, run the DICOMDIR sniff, mark ready.
    A folder upload is packed here into ONE byte-exact (stored, uncompressed) ZIP so
    everything downstream (download/list/delete) treats it like a normal ZIP."""
    _check_cdxfer_token(request.query_params.get("t") or request.query_params.get("token"))
    upload_id = (request.query_params.get("upload_id") or "").strip()
    row = q("""SELECT id, ref, stored_name, kind, size_bytes, file_no, branch, uploader
               FROM scheduling.cd_transfers WHERE upload_id=%s""", (upload_id,), one=True)
    if not row:
        raise HTTPException(404, "Upload session not found.")
    from datetime import datetime, timezone
    base = os.path.join(_cdxfer_dir(), row["stored_name"])
    if row["kind"] == "folder":
        # Pack the uploaded directory into a stored (no-compression, byte-exact) ZIP.
        # The walk+zip can copy up to 4 GB, so run it OFF the event loop or it would
        # block every other request while packing.
        from starlette.concurrency import run_in_threadpool
        if not os.path.isdir(base):
            q("UPDATE scheduling.cd_transfers SET status='failed' WHERE id=%s", (row["id"],), exec_only=True)
            raise HTTPException(400, "No files were received.")
        zip_stored = row["stored_name"] + ".zip"
        zip_path = os.path.join(_cdxfer_dir(), zip_stored)
        n_files = await run_in_threadpool(_cdxfer_pack_folder, base, zip_path)
        if not n_files:
            _cdxfer_remove(row["stored_name"])
            _cdxfer_remove(zip_stored)
            q("UPDATE scheduling.cd_transfers SET status='failed' WHERE id=%s", (row["id"],), exec_only=True)
            raise HTTPException(400, "The folder had no files.")
        _cdxfer_remove(row["stored_name"])          # drop the loose files, keep the ZIP
        actual = os.path.getsize(zip_path)
        ok, note = _cdxfer_sniff(zip_path, "zip")
        note = f"{note} ({n_files} files from folder)"
        q("""UPDATE scheduling.cd_transfers
               SET status='ready', kind='zip', stored_name=%s, size_bytes=%s,
                   uploaded_at=%s, dicom_check=%s WHERE id=%s""",
          (zip_stored, actual, datetime.now(timezone.utc), note, row["id"]), exec_only=True)
        insert_audit({"id": None, "username": f"cd-upload:{row['uploader']}", "role": "public",
                      "branch_name": row["branch"]}, "CDXFER_UPLOAD", row["ref"],
                     json.dumps({"file_no": row["file_no"], "kind": "folder", "files": n_files, "bytes": actual}))
        return {"ok": True, "ref": row["ref"], "dicom_check": note}
    # Single ISO/ZIP file.
    path = base
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        q("UPDATE scheduling.cd_transfers SET status='failed' WHERE id=%s", (row["id"],), exec_only=True)
        raise HTTPException(400, "No data was received.")
    ok, note = _cdxfer_sniff(path, row["kind"])
    if not ok:
        _cdxfer_remove(row["stored_name"])
        q("UPDATE scheduling.cd_transfers SET status='failed', dicom_check=%s WHERE id=%s",
          (note, row["id"]), exec_only=True)
        raise HTTPException(400, note)
    actual = os.path.getsize(path)
    q("""UPDATE scheduling.cd_transfers
           SET status='ready', size_bytes=%s, uploaded_at=%s, dicom_check=%s WHERE id=%s""",
      (actual, datetime.now(timezone.utc), note, row["id"]), exec_only=True)
    insert_audit({"id": None, "username": f"cd-upload:{row['uploader']}", "role": "public",
                  "branch_name": row["branch"]}, "CDXFER_UPLOAD", row["ref"],
                 json.dumps({"file_no": row["file_no"], "kind": row["kind"], "bytes": actual}))
    return {"ok": True, "ref": row["ref"], "dicom_check": note}

def _cdxfer_public(row):
    return {k: row.get(k) for k in (
        "ref", "file_no", "branch", "exam_type", "exam_date", "uploader",
        "patient_initials", "note", "orig_name", "kind", "size_bytes", "status",
        "dicom_check", "upload_ip", "download_ip", "created_at", "uploaded_at",
        "downloaded_at", "expires_at")}

@app.get("/api/cdxfer/list")
def cdxfer_list(user=Depends(require_admin)):
    """All CD transfers, newest first (authorised staff only)."""
    rows = q("""SELECT ref, file_no, branch, exam_type, exam_date, uploader, patient_initials,
                       note, orig_name, kind, size_bytes, status, dicom_check, upload_ip, download_ip,
                       TO_CHAR(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
                       TO_CHAR(uploaded_at,'YYYY-MM-DD"T"HH24:MI:SS') AS uploaded_at,
                       TO_CHAR(downloaded_at,'YYYY-MM-DD"T"HH24:MI:SS') AS downloaded_at,
                       TO_CHAR(expires_at,'YYYY-MM-DD"T"HH24:MI:SS') AS expires_at
                FROM scheduling.cd_transfers ORDER BY created_at DESC LIMIT 500""") or []
    return {"ok": True, "transfers": [_cdxfer_public(r) for r in rows], "ttl_hours": CDXFER_TTL_HOURS}

@app.get("/api/cdxfer/{ref}/download")
def cdxfer_download(ref: str, request: Request, user=Depends(require_admin)):
    """Stream the stored CD image to the authorised user (never to a public link)."""
    row = q("SELECT * FROM scheduling.cd_transfers WHERE ref=%s", (ref,), one=True)
    if not row or row["status"] in ("deleted", "expired", "failed"):
        raise HTTPException(404, "File not available.")
    path = os.path.join(_cdxfer_dir(), row["stored_name"] or "")
    if not row["stored_name"] or not os.path.exists(path):
        raise HTTPException(404, "File is no longer on the server.")
    from datetime import datetime, timezone
    q("""UPDATE scheduling.cd_transfers SET status='downloaded', downloaded_at=%s, download_ip=%s
         WHERE id=%s""", (datetime.now(timezone.utc), _req_ip(request), row["id"]), exec_only=True)
    insert_audit(user, "CDXFER_DOWNLOAD", ref, json.dumps({"file_no": row["file_no"], "bytes": row["size_bytes"]}))
    # Download name uses the ref + file number only — never the patient's name.
    dl_name = f"{ref}_{(row['file_no'] or 'cd')}{'.iso' if row['kind'] == 'iso' else '.zip'}"
    media = "application/x-iso9660-image" if row["kind"] == "iso" else "application/zip"
    return FileResponse(path, media_type=media, filename=dl_name)

@app.delete("/api/cdxfer/{ref}")
def cdxfer_delete(ref: str, user=Depends(require_admin)):
    """Delete the stored file now (the log row is kept, marked deleted)."""
    row = q("SELECT id, stored_name, file_no FROM scheduling.cd_transfers WHERE ref=%s", (ref,), one=True)
    if not row:
        raise HTTPException(404, "Not found")
    _cdxfer_remove(row["stored_name"])
    q("UPDATE scheduling.cd_transfers SET status='deleted' WHERE id=%s", (row["id"],), exec_only=True)
    insert_audit(user, "CDXFER_DELETE", ref, json.dumps({"file_no": row["file_no"]}))
    return {"ok": True}

@app.get("/api/cdxfer/public-link")
def cdxfer_get_link(user=Depends(require_admin)):
    """The shareable branch upload link (authorised staff)."""
    return {"url": _cdxfer_public_url(), "token": _cdxfer_token(), "ttl_hours": CDXFER_TTL_HOURS,
            "max_gb": CDXFER_MAX_BYTES // (1024**3)}

@app.post("/api/cdxfer/public-link/regenerate")
def cdxfer_regen_link(user=Depends(require_admin)):
    """Rotate the token — old branch links stop working immediately."""
    import secrets
    t = secrets.token_urlsafe(24)
    q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('cdxfer_public_token',%s)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (t,), exec_only=True)
    insert_audit(user, "CDXFER_LINK_REGEN")
    return {"url": _cdxfer_public_url(), "token": t}

def _cdxfer_cleanup_loop():
    """Delete expired CD files (past their TTL) and stalled uploads. The DB row is
    kept as the operations log; only the on-disk file is removed."""
    import time
    from datetime import datetime, timezone, timedelta
    while True:
        try:
            now = datetime.now(timezone.utc)
            # Expired, still-present files.
            for r in (q("""SELECT id, stored_name FROM scheduling.cd_transfers
                           WHERE expires_at < %s AND status NOT IN ('deleted','expired')""",
                        (now,)) or []):
                _cdxfer_remove(r["stored_name"])
                q("UPDATE scheduling.cd_transfers SET status='expired' WHERE id=%s", (r["id"],), exec_only=True)
            # Stalled 'uploading' sessions older than 6h.
            stale = now - timedelta(hours=6)
            for r in (q("""SELECT id, stored_name FROM scheduling.cd_transfers
                           WHERE status='uploading' AND created_at < %s""", (stale,)) or []):
                _cdxfer_remove(r["stored_name"])
                q("UPDATE scheduling.cd_transfers SET status='failed' WHERE id=%s", (r["id"],), exec_only=True)
        except Exception as e:
            print(f"[cdxfer] cleanup error: {e}")
        time.sleep(1800)   # every 30 min

# ── Public radiology report lookup (shareable link for doctors) ───────────────
# A temporary, login-free way for a doctor to pull a patient's finished radiology
# report by file number — until result write-back into the HIS is automated. It
# reads straight from DePACS (no HIS/connector dependency). Gated by an
# unguessable link token that is shared privately with doctors.
# PRIVACY: anyone holding the link can read reports by file number. Rotate the
# token if it leaks, and move to real doctor accounts when possible.
def _reports_token():
    import secrets
    t = get_setting("reports_public_token")
    if not t:
        t = secrets.token_urlsafe(24)
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('reports_public_token',%s)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (t,), exec_only=True)
    return t

def _reports_public_url():
    base = (os.environ.get("APP_URL", "").strip().rstrip("/"))
    return f"{base}/reports?t={_reports_token()}"

_reports_pub_hits: list = []
def _reports_throttle():
    import time as _t
    now = _t.time()
    _reports_pub_hits[:] = [h for h in _reports_pub_hits if now - h < 60]
    if len(_reports_pub_hits) >= 120:        # max 120 public lookups / minute
        raise HTTPException(429, "Too many lookups, please wait a moment.")
    _reports_pub_hits.append(now)

def _check_reports_token(token):
    import secrets
    # Compare as bytes — compare_digest raises TypeError on non-ASCII str operands,
    # and this token is a raw client query param; a bad token must 403, not 500.
    if not token or not secrets.compare_digest(str(token).encode(), str(_reports_token()).encode()):
        raise HTTPException(403, "Invalid or expired link. Ask the radiology team for a new one.")

def _study_is_reported(status):
    # One readiness predicate shared by the internal and public report views, so a
    # signed/reviewed/addended report never reads "ready" in one place and "not
    # verified" in another. Mirrors the connector's isReported: reject any draft /
    # interim / negated state FIRST (NOT VERIFIED, NON-VERIFIED, TO BE VERIFIED,
    # PARTIALLY VERIFIED, PENDING FINAL, UNSIGNED, …) — a bare \b whitelist match on
    # the positive word alone false-positives on "NOT VERIFIED"/"PENDING FINAL".
    s = str(status or "").upper()
    if re.search(r"\bNOT\b|\bNON[\s-]?(VERIFIED|SIGNED|APPROVED|REPORTED|REVIEWED|COMPLETE)|\bTO\s+BE\b|"
                 r"\bPARTIAL|\bPENDING\b|\bPRELIM|\bDRAFT\b|\bAWAIT|\bINCOMPLETE\b|IN[\s-]?PROGRESS|"
                 r"UN-?(VERIFIED|SIGNED|APPROVED|REVIEWED|COMPLETED)", s):
        return False
    return bool(re.search(r"\b(VERIFIED|APPROVED|SIGNED|COMPLETED|REVIEWED|ADDENDUM|FINAL)\b", s))

def _public_study_belongs_to_file(study_id, file_no):
    """Guard for the login-free link: a study is only readable through the public
    endpoints if it is one of the studies on the file number the caller looked up.
    Without this a link-holder could enumerate study_id 1,2,3… and pull every
    patient's report (IDOR)."""
    want = str(study_id)
    for s in _elite_studies_for_file(file_no):
        if str(s.get("study_id")) == want:
            return True
    return False

def _public_reports_unavailable():
    # The public doctor link is unauthenticated — never surface internal config
    # hints ("Add the Butterfly account in Settings…") or raw vendor error bodies
    # to it. Collapse any upstream/elite-layer failure to one neutral message.
    return HTTPException(502, "The reports service is temporarily unavailable. Please try again in a moment.")

def _report_html_to_text(html):
    import re as _re
    t = _re.sub(r"<\s*(br|/p|/div|/tr|/h[1-6]|/li)\s*/?>", "\n", html or "", flags=_re.I)
    t = _re.sub(r"<[^>]+>", " ", t)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&#39;", "'"), ("&quot;", '"')):
        t = t.replace(a, b)
    t = _re.sub(r"[ \t]+", " ", t)
    t = _re.sub(r"\n[ \t]+", "\n", t)
    t = _re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()

@app.get("/api/public/reports/lookup")
def public_reports_lookup(request: Request):
    """List a patient's DePACS studies (newest first) for the public link."""
    _check_reports_token(request.query_params.get("t") or request.query_params.get("token"))
    _reports_throttle()
    file_no = (request.query_params.get("file") or request.query_params.get("file_no") or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    try:
        rows = _elite_studies_for_file(file_no)
    except HTTPException:
        raise _public_reports_unavailable()
    studies = [{
        "study_id": s.get("study_id"),
        "pat_name": _elite_name(s.get("pat_name")),
        "pat_id": s.get("pat_id"), "pat_sex": s.get("pat_sex"),
        "pat_birthdate": s.get("pat_birthdate"),
        "modality": s.get("modality"),
        "study_date": s.get("study_date"),
        "status": s.get("study_status"),
        "study_desc": s.get("study_description") or s.get("study_desc"),
        "reported": _study_is_reported(s.get("study_status")),
    } for s in rows]
    studies.sort(key=lambda x: str(x.get("study_date") or ""), reverse=True)
    return {"file_no": file_no, "count": len(studies), "studies": studies}

@app.get("/api/public/reports/study/{study_id}")
def public_reports_study(study_id: int, request: Request):
    """Full report text for one study (public link)."""
    _check_reports_token(request.query_params.get("t") or request.query_params.get("token"))
    _reports_throttle()
    file_no = (request.query_params.get("file") or request.query_params.get("file_no") or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    try:
        belongs = _public_study_belongs_to_file(study_id, file_no)
    except HTTPException:
        raise _public_reports_unavailable()
    if not belongs:
        raise HTTPException(403, "This report isn't available on this file number.")
    try:
        b = _elite_body(_elite_get(f"/report/get_study_report_info/{study_id}"))
    except HTTPException:
        raise _public_reports_unavailable()
    return {"study_id": b.get("study_id"),
            "pat_name": _elite_name(b.get("pat_name")),
            "pat_id": b.get("pat_id"), "pat_age": b.get("pat_age"), "pat_sex": b.get("pat_sex"),
            "modality": b.get("modality"), "study_date": b.get("study_date"),
            "study_desc": b.get("study_desc"),
            "report_text": _report_html_to_text(b.get("report_content") or ""),
            "report_date": b.get("report_date") or b.get("verification_date"),
            "reviewer": _elite_name(b.get("reviewer_name"))}

@app.get("/api/public/reports/study/{study_id}/pdf")
def public_reports_pdf(study_id: int, request: Request):
    from fastapi import Response
    _check_reports_token(request.query_params.get("t") or request.query_params.get("token"))
    _reports_throttle()
    file_no = (request.query_params.get("file") or request.query_params.get("file_no") or "").strip()
    if not file_no:
        raise HTTPException(400, "Enter a patient file number")
    try:
        belongs = _public_study_belongs_to_file(study_id, file_no)
    except HTTPException:
        raise _public_reports_unavailable()
    if not belongs:
        raise HTTPException(403, "This report isn't available on this file number.")
    try: style = max(1, min(3, int(request.query_params.get("style") or "2")))
    except (TypeError, ValueError): style = 2
    try:
        ct, data = _elite_get(f"/report/open_report_pdf/{study_id}?style={style}", want="raw")
    except HTTPException:
        raise _public_reports_unavailable()
    if "pdf" not in (ct or "").lower():
        raise HTTPException(404, "No PDF report available for this study yet")
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="report_{study_id}.pdf"'})

@app.get("/api/reports/public-link")
def get_reports_link(user=Depends(require_admin)):
    """The shareable public report-lookup link (admin)."""
    return {"url": _reports_public_url(), "token": _reports_token()}

@app.post("/api/reports/public-link/regenerate")
def regen_reports_link(user=Depends(require_admin)):
    """Rotate the token — old links stop working immediately."""
    import secrets
    t = secrets.token_urlsafe(24)
    q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('reports_public_token',%s)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""", (t,), exec_only=True)
    insert_audit(user, "REPORTS_LINK_REGEN")
    return {"url": _reports_public_url(), "token": t}

# ── Consumables inventory ─────────────────────────────────────────────────────
def _inv_num(v, name, default=None):
    """Parse a non-negative number (qty can be fractional, e.g. 2.5 boxes)."""
    if v is None or v == "":
        if default is not None:
            return default
        raise HTTPException(400, f"{name} is required")
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise HTTPException(400, f"Invalid {name}")
    if n < 0:
        raise HTTPException(400, f"{name} can't be negative")
    return n

def _inv_decorate(rows, user):
    is_admin = user["role"] in ("admin", "manager", "superadmin")
    for r in rows:
        full = float(r.get("full_qty") or 0)
        qty = float(r.get("qty") or 0)
        r["qty"] = round(qty, 2)
        r["full_qty"] = round(full, 2)
        r["reorder_level"] = round(float(r.get("reorder_level") or 0), 2)
        r["pct"] = round((qty / full) * 100) if full > 0 else 0
        r["low"] = bool(qty <= r["reorder_level"])
        r["can_manage"] = is_admin
    return rows

@app.get("/api/inventory")
def list_inventory(request: Request, user=Depends(get_current_user)):
    """Stock items in scope. Staff: own branch; lead/manager: their scope."""
    p = request.query_params
    if user["role"] == "staff":
        if not user.get("branch_id"):
            return {"items": []}
        branch_ids = [user["branch_id"]]
    else:
        _, branch_ids = _report_branch_scope(user, p.get("branch_id"))
    rows = q("""SELECT i.id, i.branch_id, b.name AS branch_name, i.name, i.unit,
                       i.full_qty, i.qty, i.reorder_level
                FROM scheduling.inventory_items i
                JOIN scheduling.branches b ON b.id=i.branch_id
                WHERE i.branch_id = ANY(%s) AND COALESCE(i.active,true)=true
                ORDER BY (i.qty <= i.reorder_level) DESC, i.name""", (branch_ids,))
    return {"items": _inv_decorate(rows, user)}

@app.post("/api/inventory")
async def create_inventory_item(request: Request, user=Depends(require_admin)):
    """Add a stock item (team lead / manager). reorder_level defaults to half."""
    body = await request.json()
    branch_id = body.get("branch_id") or user.get("branch_id")
    branch_id = _int_or_400(branch_id, "branch_id")
    if not can_access_branch(user, branch_id):
        raise HTTPException(403, "Forbidden")
    name = (body.get("name") or "").strip()[:120]
    if not name:
        raise HTTPException(400, "name is required")
    full = _inv_num(body.get("full_qty") if body.get("full_qty") not in (None, "") else body.get("qty"), "full_qty")
    qty = _inv_num(body.get("qty"), "qty", default=full)
    reorder = _inv_num(body.get("reorder_level"), "reorder_level", default=round(full / 2, 2))
    row = q("""INSERT INTO scheduling.inventory_items (branch_id,name,unit,full_qty,qty,reorder_level,created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (branch_id, name, (body.get("unit") or "").strip()[:20] or None, full, qty, reorder, user["id"]), one=True)
    insert_audit(user, "INVENTORY_ADD", f"branch:{branch_id}", name)
    return q("""SELECT i.id, i.branch_id, i.name, i.unit, i.full_qty, i.qty, i.reorder_level
                FROM scheduling.inventory_items i WHERE i.id=%s""", (row["id"],), one=True)

@app.put("/api/inventory/{iid}")
async def update_inventory_item(iid: int, request: Request, user=Depends(require_admin)):
    it = q("SELECT branch_id FROM scheduling.inventory_items WHERE id=%s", (iid,), one=True)
    if not it:
        raise HTTPException(404, "Not found")
    if not can_access_branch(user, it["branch_id"]):
        raise HTTPException(403, "Forbidden")
    body = await request.json()
    name = (body.get("name") or "").strip()[:120]
    if not name:
        raise HTTPException(400, "name is required")
    full = _inv_num(body.get("full_qty"), "full_qty")
    reorder = _inv_num(body.get("reorder_level"), "reorder_level", default=round(full / 2, 2))
    q("""UPDATE scheduling.inventory_items SET name=%s, unit=%s, full_qty=%s, reorder_level=%s, updated_at=NOW()
         WHERE id=%s""", (name, (body.get("unit") or "").strip()[:20] or None, full, reorder, iid), exec_only=True)
    return {"ok": True}

@app.delete("/api/inventory/{iid}")
def delete_inventory_item(iid: int, user=Depends(require_admin)):
    it = q("SELECT branch_id, name FROM scheduling.inventory_items WHERE id=%s", (iid,), one=True)
    if not it:
        raise HTTPException(404, "Not found")
    if not can_access_branch(user, it["branch_id"]):
        raise HTTPException(403, "Forbidden")
    q("DELETE FROM scheduling.inventory_items WHERE id=%s", (iid,), exec_only=True)
    insert_audit(user, "INVENTORY_DELETE", f"branch:{it['branch_id']}", it["name"])
    return {"ok": True}

def _inventory_apply(iid, delta, reason, user):
    """Apply a stock movement atomically; alert the lead when it crosses low."""
    it = q("""UPDATE scheduling.inventory_items
              SET qty = GREATEST(0, qty + %s), updated_at=NOW()
              WHERE id=%s RETURNING id, branch_id, name, unit, qty, full_qty, reorder_level, low_notified""",
           (delta, iid), one=True)
    if not it:
        raise HTTPException(404, "Not found")
    q("""INSERT INTO scheduling.inventory_movements (item_id,delta,reason,by_user,by_staff)
         VALUES (%s,%s,%s,%s,%s)""",
      (iid, delta, (reason or "").strip()[:120] or None, user.get("id"), user.get("staff_id")), exec_only=True)
    qty = float(it["qty"]); reorder = float(it["reorder_level"])
    if qty <= reorder and not it["low_notified"]:
        msg = (f"Low stock: {it['name']} at {branch_name_of(it['branch_id'])} is down to "
               f"{_fmt_qty(qty)}{(' ' + it['unit']) if it['unit'] else ''} — time to reorder.")
        for u in q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s", (it["branch_id"],)):
            notify(u["id"], msg, link="inventory", ntype="reminder")
        q("UPDATE scheduling.inventory_items SET low_notified=true WHERE id=%s", (iid,), exec_only=True)
    elif qty > reorder and it["low_notified"]:
        q("UPDATE scheduling.inventory_items SET low_notified=false WHERE id=%s", (iid,), exec_only=True)
    return it

def _fmt_qty(n):
    n = float(n)
    return str(int(n)) if n == int(n) else f"{n:.2f}".rstrip("0").rstrip(".")

def branch_name_of(bid):
    r = q("SELECT name FROM scheduling.branches WHERE id=%s", (bid,), one=True)
    return r["name"] if r else f"Branch {bid}"

@app.post("/api/inventory/{iid}/take")
async def take_inventory(iid: int, request: Request, user=Depends(get_current_user)):
    """A staff member records taking some quantity → stock drops. Any branch staff."""
    it = q("SELECT branch_id FROM scheduling.inventory_items WHERE id=%s", (iid,), one=True)
    if not it:
        raise HTTPException(404, "Not found")
    if not can_access_branch(user, it["branch_id"]):
        raise HTTPException(403, "Forbidden")
    body = await request.json()
    amount = _inv_num(body.get("amount"), "amount")
    if amount <= 0:
        raise HTTPException(400, "amount must be greater than 0")
    res = _inventory_apply(iid, -amount, body.get("reason"), user)
    return {"ok": True, "qty": round(float(res["qty"]), 2)}

@app.post("/api/inventory/{iid}/restock")
async def restock_inventory(iid: int, request: Request, user=Depends(require_admin)):
    """Reorder arrived — add quantity back (team lead / manager)."""
    it = q("SELECT branch_id FROM scheduling.inventory_items WHERE id=%s", (iid,), one=True)
    if not it:
        raise HTTPException(404, "Not found")
    if not can_access_branch(user, it["branch_id"]):
        raise HTTPException(403, "Forbidden")
    body = await request.json()
    amount = _inv_num(body.get("amount"), "amount")
    if amount <= 0:
        raise HTTPException(400, "amount must be greater than 0")
    res = _inventory_apply(iid, amount, "restock", user)
    return {"ok": True, "qty": round(float(res["qty"]), 2)}

@app.get("/api/inventory/{iid}/movements")
def inventory_movements(iid: int, user=Depends(require_admin)):
    it = q("SELECT branch_id FROM scheduling.inventory_items WHERE id=%s", (iid,), one=True)
    if not it:
        raise HTTPException(404, "Not found")
    if not can_access_branch(user, it["branch_id"]):
        raise HTTPException(403, "Forbidden")
    rows = q("""SELECT m.delta, m.reason, COALESCE(s.name,u.username) AS by_name,
                       TO_CHAR(m.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
                FROM scheduling.inventory_movements m
                LEFT JOIN scheduling.users u ON u.id=m.by_user
                LEFT JOIN scheduling.staff s ON s.id=m.by_staff
                WHERE m.item_id=%s ORDER BY m.created_at DESC LIMIT 100""", (iid,))
    return {"movements": rows}

# ── Equipment maintenance ─────────────────────────────────────────────────────
_MAINT_KINDS = ("preventive", "corrective", "calibration", "inspection", "other")

@app.get("/api/equipment")
def list_equipment(request: Request, user=Depends(get_current_user)):
    """Devices in scope with the next preventive-maintenance due date + days left."""
    p = request.query_params
    if user["role"] == "staff":
        if not user.get("branch_id"):
            return {"equipment": []}
        branch_ids = [user["branch_id"]]
    else:
        _, branch_ids = _report_branch_scope(user, p.get("branch_id"))
    rows = q("""SELECT e.id, e.branch_id, b.name AS branch_name, e.name, e.model, e.serial, e.vendor,
                       TO_CHAR(e.next_pm_date,'YYYY-MM-DD') AS next_pm_date,
                       (e.next_pm_date - CURRENT_DATE) AS days_left
                FROM scheduling.equipment e
                JOIN scheduling.branches b ON b.id=e.branch_id
                WHERE e.branch_id = ANY(%s) AND COALESCE(e.active,true)=true
                ORDER BY e.next_pm_date NULLS LAST, e.name""", (branch_ids,))
    is_admin = user["role"] in ("admin", "manager", "superadmin")
    for r in rows:
        r["can_manage"] = is_admin
    return {"equipment": rows, "kinds": list(_MAINT_KINDS)}

@app.post("/api/equipment")
async def create_equipment(request: Request, user=Depends(require_admin)):
    body = await request.json()
    branch_id = body.get("branch_id") or user.get("branch_id")
    branch_id = _int_or_400(branch_id, "branch_id")
    if not can_access_branch(user, branch_id):
        raise HTTPException(403, "Forbidden")
    name = (body.get("name") or "").strip()[:120]
    if not name:
        raise HTTPException(400, "name is required")
    next_pm = _valid_iso_date(body.get("next_pm_date")) if body.get("next_pm_date") else None
    row = q("""INSERT INTO scheduling.equipment (branch_id,name,model,serial,vendor,next_pm_date,created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (branch_id, name, (body.get("model") or "").strip()[:80] or None,
             (body.get("serial") or "").strip()[:80] or None,
             (body.get("vendor") or "").strip()[:80] or None, next_pm, user["id"]), one=True)
    insert_audit(user, "EQUIPMENT_ADD", f"branch:{branch_id}", name)
    return {"id": row["id"]}

@app.put("/api/equipment/{eid}")
async def update_equipment(eid: int, request: Request, user=Depends(require_admin)):
    e = q("SELECT branch_id FROM scheduling.equipment WHERE id=%s", (eid,), one=True)
    if not e:
        raise HTTPException(404, "Not found")
    if not can_access_branch(user, e["branch_id"]):
        raise HTTPException(403, "Forbidden")
    body = await request.json()
    name = (body.get("name") or "").strip()[:120]
    if not name:
        raise HTTPException(400, "name is required")
    next_pm = _valid_iso_date(body.get("next_pm_date")) if body.get("next_pm_date") else None
    q("""UPDATE scheduling.equipment SET name=%s, model=%s, serial=%s, vendor=%s, next_pm_date=%s,
         pm_notified=NULL WHERE id=%s""",
      (name, (body.get("model") or "").strip()[:80] or None, (body.get("serial") or "").strip()[:80] or None,
       (body.get("vendor") or "").strip()[:80] or None, next_pm, eid), exec_only=True)
    return {"ok": True}

@app.delete("/api/equipment/{eid}")
def delete_equipment(eid: int, user=Depends(require_admin)):
    e = q("SELECT branch_id, name FROM scheduling.equipment WHERE id=%s", (eid,), one=True)
    if not e:
        raise HTTPException(404, "Not found")
    if not can_access_branch(user, e["branch_id"]):
        raise HTTPException(403, "Forbidden")
    q("DELETE FROM scheduling.equipment WHERE id=%s", (eid,), exec_only=True)
    insert_audit(user, "EQUIPMENT_DELETE", f"branch:{e['branch_id']}", e["name"])
    return {"ok": True}

@app.get("/api/equipment/{eid}/maintenance")
def list_maintenance(eid: int, user=Depends(get_current_user)):
    e = q("SELECT branch_id FROM scheduling.equipment WHERE id=%s", (eid,), one=True)
    if not e:
        raise HTTPException(404, "Not found")
    if not can_access_branch(user, e["branch_id"]):
        raise HTTPException(403, "Forbidden")
    rows = q("""SELECT m.id, m.kind, TO_CHAR(m.service_date,'YYYY-MM-DD') AS service_date,
                       TO_CHAR(m.next_due,'YYYY-MM-DD') AS next_due, m.vendor, m.cost, m.note,
                       u.username AS by_name
                FROM scheduling.maintenance_records m
                LEFT JOIN scheduling.users u ON u.id=m.created_by
                WHERE m.equipment_id=%s ORDER BY m.service_date DESC LIMIT 100""", (eid,))
    return {"records": rows}

@app.post("/api/equipment/{eid}/maintenance")
async def log_maintenance(eid: int, request: Request, user=Depends(require_admin)):
    """Log a service event; if a next-due date is given it becomes the device's
    next preventive-maintenance reminder."""
    e = q("SELECT branch_id FROM scheduling.equipment WHERE id=%s", (eid,), one=True)
    if not e:
        raise HTTPException(404, "Not found")
    if not can_access_branch(user, e["branch_id"]):
        raise HTTPException(403, "Forbidden")
    body = await request.json()
    kind = body.get("kind") if body.get("kind") in _MAINT_KINDS else "preventive"
    service_date = _valid_iso_date(body.get("service_date"))
    if not service_date:
        raise HTTPException(400, "A valid service_date (YYYY-MM-DD) is required")
    next_due = _valid_iso_date(body.get("next_due")) if body.get("next_due") else None
    cost = None
    if body.get("cost") not in (None, ""):
        try: cost = float(body.get("cost"))
        except (TypeError, ValueError): raise HTTPException(400, "Invalid cost")
    q("""INSERT INTO scheduling.maintenance_records (equipment_id,kind,service_date,next_due,vendor,cost,note,created_by)
         VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
      (eid, kind, service_date, next_due, (body.get("vendor") or "").strip()[:80] or None,
       cost, (body.get("note") or "").strip()[:200] or None, user["id"]), exec_only=True)
    if next_due:
        q("UPDATE scheduling.equipment SET next_pm_date=%s, pm_notified=NULL WHERE id=%s", (next_due, eid), exec_only=True)
    insert_audit(user, "MAINTENANCE_LOG", f"equip:{eid}", f"{kind} {service_date}")
    return {"ok": True}

def _send_maintenance_reminders():
    """Remind branch leads about preventive maintenance due soon (or overdue),
    once per device per threshold (overdue / 7d / 30d)."""
    rows = q("""SELECT e.id, e.branch_id, e.name, e.pm_notified,
                       (e.next_pm_date - CURRENT_DATE) AS days_left
                FROM scheduling.equipment e
                WHERE COALESCE(e.active,true)=true AND e.next_pm_date IS NOT NULL
                  AND e.next_pm_date <= CURRENT_DATE + 30""")
    for r in rows:
        d = r["days_left"]
        bucket = "overdue" if d < 0 else ("7" if d <= 7 else "30")
        if r["pm_notified"] == bucket:
            continue
        when = (f"is overdue by {abs(d)} day(s)" if d < 0 else
                ("is due today" if d == 0 else f"is due in {d} day(s)"))
        msg = f"Preventive maintenance: {r['name']} {when}. Please schedule the service."
        for u in q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s", (r["branch_id"],)):
            notify(u["id"], msg, link="equipment", ntype="reminder")
        for u in q("SELECT id FROM scheduling.users WHERE role IN ('manager','superadmin')"):
            notify(u["id"], msg, link="equipment", ntype="reminder", whatsapp=False)
        q("UPDATE scheduling.equipment SET pm_notified=%s WHERE id=%s", (bucket, r["id"]), exec_only=True)
    return len(rows)

def _maintenance_reminder_loop():
    import time
    from datetime import datetime, timezone, timedelta
    while True:
        try:
            ksa = datetime.now(timezone.utc) + timedelta(hours=3)
            claimed = q("""INSERT INTO scheduling.app_settings (key,value)
                           VALUES (%s,%s) ON CONFLICT (key) DO NOTHING RETURNING key""",
                        (f"maint_sweep:{ksa.strftime('%Y-%m-%d')}", ksa.isoformat()), one=True)
            if claimed:
                _send_maintenance_reminders()
        except Exception as e:
            print(f"[maintenance] {e}")
        time.sleep(3600)

# ── Web Push (browser notifications, incl. when the app is closed) ────────────
_webpush_outbox = []          # populated when WEBPUSH_CAPTURE is set (tests)
_vapid_cache = None           # (private_b64, public_b64) once resolved

def _vapid_keys():
    """Resolve the VAPID keypair: env override first, else generate once and
    persist in app_settings so every worker shares the same identity."""
    global _vapid_cache
    if _vapid_cache:
        return _vapid_cache
    env_priv = (os.environ.get("VAPID_PRIVATE_KEY") or "").strip()
    env_pub = (os.environ.get("VAPID_PUBLIC_KEY") or "").strip()
    if env_priv and env_pub:
        _vapid_cache = (env_priv, env_pub)
        return _vapid_cache
    priv = get_setting("vapid_private")
    pub = get_setting("vapid_public")
    if not (priv and pub):
        priv, pub = _webpush.generate_vapid_keys()
        # Race-safe: first writer wins, then re-read the stored pair.
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('vapid_private',%s)
             ON CONFLICT (key) DO NOTHING""", (priv,), exec_only=True)
        q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('vapid_public',%s)
             ON CONFLICT (key) DO NOTHING""", (pub,), exec_only=True)
        priv = get_setting("vapid_private"); pub = get_setting("vapid_public")
    _vapid_cache = (priv, pub)
    return _vapid_cache

def _vapid_subject():
    return (os.environ.get("VAPID_SUBJECT") or "mailto:notifications@meena-health.com").strip()

def send_web_push_to_user(user_id, message, link=None, title="Meena Health", sync=False):
    """Fan a browser push out to all of a user's registered devices. Best-effort:
    prunes subscriptions the push service reports as gone (404/410).

    Default (sync=False): fire in a background thread, return the number of
    devices targeted. sync=True: send inline and return a dict
    {targeted, delivered, results:[{status|error}]} — used by the interactive
    message-send so the real per-device outcome can be shown to the sender."""
    if not user_id:
        return {"targeted": 0, "delivered": 0, "results": []} if sync else 0
    try:
        subs = q("""SELECT id, endpoint, p256dh, auth FROM scheduling.push_subscriptions
                    WHERE user_id=%s""", (user_id,))
    except Exception:
        return {"targeted": 0, "delivered": 0, "results": []} if sync else 0
    if not subs:
        return {"targeted": 0, "delivered": 0, "results": []} if sync else 0
    payload = {"title": title, "body": message, "link": link or "home"}
    if os.environ.get("WEBPUSH_CAPTURE"):
        for s in subs:
            _webpush_outbox.append({"user_id": user_id, "endpoint": s["endpoint"], **payload})
        return {"targeted": len(subs), "delivered": len(subs),
                "results": [{"status": 201} for _ in subs]} if sync else len(subs)
    priv, pub = _vapid_keys()
    subj = _vapid_subject()

    def _send_one(s):
        try:
            code = _webpush.send(s, payload, vapid_private=priv, vapid_public=pub, subject=subj)
            if code in (404, 410):
                q("DELETE FROM scheduling.push_subscriptions WHERE id=%s", (s["id"],), exec_only=True)
            return {"status": code}
        except Exception as e:
            print(f"[webpush] {s['endpoint'][:40]}…: {e}")
            return {"error": str(e)[:200]}

    if sync:
        results = [_send_one(s) for s in subs]
        delivered = sum(1 for r in results if r.get("status") in (200, 201))
        return {"targeted": len(subs), "delivered": delivered, "results": results}

    threading.Thread(target=lambda: [_send_one(s) for s in subs], daemon=True).start()
    return len(subs)

@app.get("/api/push/vapid")
def push_vapid(user=Depends(get_current_user)):
    """Public VAPID key the browser needs to create a subscription."""
    try:
        _, pub = _vapid_keys()
        return {"public_key": pub}
    except Exception:
        raise HTTPException(503, "Push not available")

@app.post("/api/push/subscribe")
async def push_subscribe(request: Request, user=Depends(get_current_user)):
    body = await request.json()
    endpoint = (body.get("endpoint") or "").strip()
    keys = body.get("keys") or {}
    p256dh = (keys.get("p256dh") or body.get("p256dh") or "").strip()
    auth = (keys.get("auth") or body.get("auth") or "").strip()
    if not (endpoint and p256dh and auth):
        raise HTTPException(400, "Invalid subscription")
    ua = (request.headers.get("user-agent") or "")[:300]
    q("""INSERT INTO scheduling.push_subscriptions (user_id,endpoint,p256dh,auth,user_agent)
         VALUES (%s,%s,%s,%s,%s)
         ON CONFLICT (endpoint) DO UPDATE
           SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh,
               auth=EXCLUDED.auth, user_agent=EXCLUDED.user_agent""",
      (user["id"], endpoint, p256dh, auth, ua), exec_only=True)
    return {"ok": True}

@app.post("/api/push/unsubscribe")
async def push_unsubscribe(request: Request, user=Depends(get_current_user)):
    body = await request.json()
    endpoint = (body.get("endpoint") or "").strip()
    if endpoint:
        q("""DELETE FROM scheduling.push_subscriptions
             WHERE endpoint=%s AND user_id=%s""", (endpoint, user["id"]), exec_only=True)
    return {"ok": True}

@app.post("/api/push/test")
def push_test(user=Depends(get_current_user)):
    """Send a test push to the caller's own devices, synchronously, and report
    the real per-device result so delivery problems can be diagnosed."""
    subs = q("""SELECT id, endpoint, p256dh, auth FROM scheduling.push_subscriptions
                WHERE user_id=%s""", (user["id"],))
    if not subs:
        return {"count": 0, "results": [],
                "hint": "No device is registered. Tap Enable in the bell panel first."}
    # Also drop an in-app notification so the bell reflects the test.
    try:
        q("""INSERT INTO scheduling.notifications (user_id,message,link,type)
             VALUES (%s,%s,%s,%s)""",
          (user["id"], "Test notification — push is working ✅", "home", "info"), exec_only=True)
    except Exception:
        pass
    payload = {"title": "Meena Health", "body": "Test notification — push is working ✅", "link": "home"}
    if os.environ.get("WEBPUSH_CAPTURE"):
        for s in subs:
            _webpush_outbox.append({"user_id": user["id"], "endpoint": s["endpoint"], **payload})
        return {"count": len(subs), "results": [{"status": 201} for _ in subs]}
    priv, pub = _vapid_keys()
    subj = _vapid_subject()
    results = []
    for s in subs:
        host = (s["endpoint"].split("/")[2] if "/" in s["endpoint"] else s["endpoint"])[:40]
        try:
            code = _webpush.send(s, payload, vapid_private=priv, vapid_public=pub, subject=subj)
            if code in (404, 410):
                q("DELETE FROM scheduling.push_subscriptions WHERE id=%s", (s["id"],), exec_only=True)
            results.append({"host": host, "status": code})
        except Exception as e:
            results.append({"host": host, "status": "error", "detail": str(e)[:200]})
    ok = sum(1 for r in results if r.get("status") in (200, 201))
    return {"count": len(subs), "ok": ok, "results": results}

@app.get("/api/whatsapp/diagnose")
def whatsapp_diagnose(user=Depends(require_admin)):
    """Check whether THIS SERVER can reach the WhatsApp bridge — independent of
    whatever the bridge's own status page shows in the admin's browser. Reports
    DNS, TCP connect, and (best-effort) an HTTP response, with latencies."""
    import socket, time as _t
    from urllib.parse import urlparse
    url = (os.environ.get("WHATSAPP_NOTIFY_URL") or "").strip()
    if not url:
        return {"configured": False, "message": "WHATSAPP_NOTIFY_URL is not set on the server."}
    u = urlparse(url)
    host = u.hostname or ""
    port = u.port or (443 if u.scheme == "https" else 80)
    out = {"configured": True, "url_host": host, "port": port,
           "dns": None, "tcp_connect": None, "http_status": None,
           "latency_ms": None, "error": None}
    # Private/loopback host the hosted server can never reach from the cloud.
    def _is_private_host(h: str) -> bool:
        if h in ("localhost", "127.0.0.1", "::1") or h.startswith(("10.", "192.168.")):
            return True
        # 172.16.0.0/12 spans 172.16.x.x through 172.31.x.x
        parts = h.split(".")
        if len(parts) == 4 and parts[0] == "172":
            try:
                return 16 <= int(parts[1]) <= 31
            except ValueError:
                return False
        return False
    if _is_private_host(host):
        out["error"] = (f"The bridge URL points to a private/local address ({host}). "
                        "A hosted server can't reach that — the bridge must be on a public URL.")
    try:
        ip = socket.gethostbyname(host); out["dns"] = ip
    except Exception as e:
        out["error"] = f"DNS lookup failed for {host}: {e}"; return out
    t0 = _t.time()
    try:
        with socket.create_connection((host, port), timeout=6):
            out["tcp_connect"] = True
    except Exception as e:
        out["tcp_connect"] = False
        out["latency_ms"] = round((_t.time() - t0) * 1000)
        out["error"] = out["error"] or f"Can't open a connection to {host}:{port} — {e}. The bridge is unreachable from the server (down, wrong port, or blocked by a firewall)."
        return out
    # TCP is open; try a quick HTTP GET on the base URL to confirm it answers.
    import urllib.request, urllib.error
    try:
        base = f"{u.scheme}://{u.netloc}/"
        req = urllib.request.Request(base, method="GET", headers={"User-Agent": "MeenaScheduling/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            out["http_status"] = resp.status
    except urllib.error.HTTPError as e:
        out["http_status"] = e.code           # answered (even 404 means it's alive)
    except Exception as e:
        out["error"] = (f"Connected to {host}:{port} but it never sent an HTTP reply ({e}). "
                        "The bridge process is hung or not serving HTTP on this port.")
    out["latency_ms"] = round((_t.time() - t0) * 1000)
    if not out["error"]:
        out["message"] = "The server can reach the bridge. If sends still time out, the bridge accepts connections but its send handler hangs (often an unregistered number or a stuck WhatsApp session)."
    return out

# ── Direct messaging (custom WhatsApp / email to chosen staff) ────────────────
_MSG_CHANNELS = ("app", "whatsapp", "email")

@app.get("/api/messages/recipients")
def message_recipients(request: Request, user=Depends(require_admin)):
    """Selectable staff in scope, with which channels each can receive."""
    _, branch_ids = _report_branch_scope(user, request.query_params.get("branch_id"))
    rows = q("""SELECT s.id, s.name, s.speciality, s.branch_id, b.name AS branch_name,
                       (s.phone IS NOT NULL AND s.phone <> '') AS has_phone,
                       (s.email IS NOT NULL AND s.email <> '') AS has_email,
                       EXISTS(SELECT 1 FROM scheduling.users u WHERE u.staff_id=s.id) AS has_login,
                       EXISTS(SELECT 1 FROM scheduling.push_subscriptions ps
                              JOIN scheduling.users u2 ON u2.id=ps.user_id
                              WHERE u2.staff_id=s.id) AS has_push
                FROM scheduling.staff s
                JOIN scheduling.branches b ON b.id=s.branch_id
                WHERE s.branch_id = ANY(%s) AND COALESCE(s.active,true)=true
                ORDER BY s.name""", (branch_ids,))
    for r in rows:
        vals = [str(x or "").strip().upper() for x in (r.get("speciality") or [])]
        r["section"] = "US" if ("US" in vals or "ULTRASOUND" in vals) else "General"
        r.pop("speciality", None)
    return {"recipients": rows}

def _send_custom(staff_rows, message, subject, channels):
    want_app = "app" in channels
    want_wa = "whatsapp" in channels
    want_em = "email" in channels
    # Small interactive sends push synchronously so the sender sees real delivery;
    # bulk sends stay non-blocking (fire-and-forget) to avoid stalling the worker.
    sync_push = len(staff_rows) <= 10
    out = {"delivered": 0, "whatsapp": 0, "email": 0, "app": 0,
           "push": 0, "push_targeted": 0, "no_login": 0, "push_error": None,
           "wa_attempted": 0, "wa_error": None}
    for st in staff_rows:
        msg = _personalize(message, st.get("name"))
        reached = False
        if want_app:
            u = q("SELECT id FROM scheduling.users WHERE staff_id=%s", (st["id"],), one=True)
            if u:
                try:
                    q("""INSERT INTO scheduling.notifications (user_id,message,link,type)
                         VALUES (%s,%s,%s,%s)""", (u["id"], msg, "home", "message"), exec_only=True)
                    try:
                        pr = send_web_push_to_user(u["id"], msg, link="home", sync=sync_push)
                        if sync_push:
                            out["push"] += pr["delivered"]
                            out["push_targeted"] += pr["targeted"]
                            for r in pr["results"]:
                                if r.get("error") and not out["push_error"]:
                                    out["push_error"] = r["error"]
                        else:
                            out["push_targeted"] += (pr or 0)
                    except Exception:
                        pass
                    out["app"] += 1; reached = True
                except Exception:
                    pass
            else:
                out["no_login"] += 1   # staff has no account → no in-app/push possible
        if want_wa and st.get("phone"):
            out["wa_attempted"] = out.get("wa_attempted", 0) + 1
            if sync_push:
                res = send_whatsapp(st["phone"], msg, ntype="message", force=True, sync=True)
                if res and res.get("ok"):
                    out["whatsapp"] += 1; reached = True
                elif res and not out.get("wa_error"):
                    out["wa_error"] = res.get("detail")
            else:
                send_whatsapp(st["phone"], msg, ntype="message", force=True)
                out["whatsapp"] += 1; reached = True
        if want_em and st.get("email"):
            send_email(st["email"], subject or "Meena Health", msg); out["email"] += 1; reached = True
        if reached:
            out["delivered"] += 1
    return out

@app.post("/api/messages/send")
async def send_custom_message(request: Request, user=Depends(require_admin)):
    """Send a custom message to one or more chosen staff over the selected
    channels (in-app / WhatsApp / email). {name} is personalised per recipient."""
    body = await request.json()
    message = (body.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "message is required")
    channels = [c for c in (body.get("channels") or []) if c in _MSG_CHANNELS]
    if not channels:
        raise HTTPException(400, "pick at least one channel")
    subject = (body.get("subject") or "Meena Health").strip()[:120]
    ids = body.get("staff_ids")
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "pick at least one recipient")
    try:
        ids = [int(x) for x in ids][:500]
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid staff_ids")
    rows = q("""SELECT id, name, phone, email, branch_id FROM scheduling.staff
                WHERE id = ANY(%s) AND COALESCE(active,true)=true""", (ids,))
    rows = [r for r in rows if can_access_branch(user, r["branch_id"])]
    if not rows:
        raise HTTPException(400, "No reachable recipients in your scope")
    res = _send_custom(rows, message, subject, channels)
    insert_audit(user, "MESSAGE_SEND", f"{len(rows)} staff", ",".join(channels))
    return res

def _send_credential_reminders():
    """Notify staff + their branch lead(s) + reviewers about credentials expiring
    within 30 days (or already expired), once per credential per threshold."""
    rows = q("""SELECT c.id, c.kind, c.label, c.staff_id, s.branch_id,
                       TO_CHAR(c.expiry_date,'YYYY-MM-DD') AS expiry_date,
                       (c.expiry_date - CURRENT_DATE) AS days_left, s.name AS staff_name
                FROM scheduling.staff_credentials c
                JOIN scheduling.staff s ON s.id=c.staff_id
                WHERE COALESCE(s.active,true)=true AND c.expiry_date <= CURRENT_DATE + 30""")
    for r in rows:
        dleft = r["days_left"]
        bucket = "expired" if dleft < 0 else ("7" if dleft <= 7 else "30")
        key = f"cred_remind:{r['id']}:{bucket}"
        claimed = q("""INSERT INTO scheduling.app_settings (key,value) VALUES (%s,'1')
                       ON CONFLICT (key) DO NOTHING RETURNING key""", (key,), one=True)
        if not claimed:
            continue
        label = (r["label"] or r["kind"].upper())
        when = "has expired" if dleft < 0 else f"expires in {dleft} day(s) ({r['expiry_date']})"
        msg = f"{r['staff_name']}'s {label} {when}."
        notify_staff_member(r["staff_id"], msg, link="myschedule", ntype="reminder")
        notify_branch_leads(r["branch_id"], msg, link="reports", ntype="reminder")
        notify_roles(("manager", "superadmin"), msg, link="reports", ntype="reminder")

# ── Daily radiology cases report ──────────────────────────────────────────────

_CASE_FIELDS = ("xray", "ct", "us", "mamo", "bmd", "insert_cd",
                "total_pt", "bmd_not_done", "mamo_not_done")

def _can_submit_cases(user, branch_id, date_str):
    """Who may file/edit a branch's daily report: a reviewer (any branch), the
    branch team lead, or a staff member of that branch who is either flagged
    can_report or scheduled on Night (N) that day."""
    role = user["role"]
    if role in ("superadmin", "manager"):
        return True
    if not can_access_branch(user, branch_id):
        return False
    if role == "admin":
        return True
    if role == "staff":
        sid = user.get("staff_id")
        st = q("SELECT can_report FROM scheduling.staff WHERE id=%s", (sid,), one=True)
        if st and st.get("can_report"):
            return True
        on_night = q("""SELECT 1 FROM scheduling.schedule_entries e
                        JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                        WHERE sc.branch_id=%s AND e.staff_id=%s AND e.date=%s AND e.shift_code='N'""",
                     (branch_id, sid, date_str), one=True)
        return bool(on_night)
    return False

def _case_row(row):
    if not row:
        return None
    row = dict(row)
    row["total_cases"] = sum(int(row.get(f) or 0) for f in ("xray","ct","us","mamo","bmd","insert_cd"))
    return row

def _operational_date_server():
    """The reporting day, KSA time (UTC+3, no DST). A night shift filed after
    midnight still belongs to the day it covered, so before 08:00 it's yesterday."""
    from datetime import datetime, timezone, timedelta
    ksa = datetime.now(timezone.utc) + timedelta(hours=3)
    if ksa.hour < 8:
        ksa -= timedelta(days=1)
    return ksa.strftime("%Y-%m-%d")

def _cases_remind_targets(branch_id, date):
    """Who to nudge about a branch's daily report on THIS day, split by channel:

      push  → in-app + WhatsApp: the branch lead(s) and staff who are on the NIGHT
              shift (i.e. actually on duty when this night reminder fires).
      inapp → in-app only (NO WhatsApp): can_report staff who worked that day but
              are NOT on the night shift — the morning/day crew already went home,
              so we leave them a silent in-app nudge instead of buzzing their phone
              at night.

    Returns (push:set, inapp:set), with push winning any overlap."""
    push, inapp = set(), set()
    # Branch lead(s) — responsible for the report; they get the full ping.
    for r in q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s", (branch_id,)):
        push.add(r["id"])
    # Staff on the night shift that day → on duty now → full ping.
    for r in q("""SELECT u.id FROM scheduling.users u
                  JOIN scheduling.schedule_entries e ON e.staff_id=u.staff_id
                  JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                  WHERE u.role='staff' AND sc.branch_id=%s AND e.date=%s AND e.shift_code='N'""",
               (branch_id, date)):
        push.add(r["id"])
    # can_report staff who worked that day on a non-night shift → in-app only.
    for r in q("""SELECT DISTINCT u.id FROM scheduling.users u
                  JOIN scheduling.staff s ON s.id=u.staff_id
                  JOIN scheduling.schedule_entries e ON e.staff_id=s.id
                  JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                  WHERE u.role='staff' AND s.branch_id=%s AND COALESCE(s.active,true)=true
                    AND COALESCE(s.can_report,false)=true
                    AND sc.branch_id=%s AND e.date=%s
                    AND e.shift_code NOT IN ('O','AL','SL','TB','OC')""",
               (branch_id, branch_id, date)):
        if r["id"] not in push:
            inapp.add(r["id"])
    return push, inapp

@app.get("/api/daily-cases")
def get_daily_case(request: Request, user=Depends(get_current_user)):
    p = request.query_params
    branch_id = p.get("branch_id") or user.get("branch_id")
    date = p.get("date")
    if not branch_id or not date:
        raise HTTPException(400, "branch_id and date required")
    branch_id = _int_or_400(branch_id)
    if not can_access_branch(user, branch_id):
        raise HTTPException(403, "Forbidden")
    row = q("""SELECT dc.*, TO_CHAR(dc.date,'YYYY-MM-DD') AS date,
                      TO_CHAR(dc.submitted_at,'YYYY-MM-DD"T"HH24:MI:SS') AS submitted_at,
                      u.username AS submitted_by_name
               FROM scheduling.daily_cases dc
               LEFT JOIN scheduling.users u ON u.id=dc.submitted_by
               WHERE dc.branch_id=%s AND dc.date=%s""", (branch_id, date), one=True)
    return {"case": _case_row(row), "can_edit": _can_submit_cases(user, branch_id, date)}

@app.get("/api/daily-cases/overview")
def daily_cases_overview(request: Request, user=Depends(get_current_user)):
    date = request.query_params.get("date")
    if not date:
        raise HTTPException(400, "date required")
    # Branches the user can see.
    if user["role"] in ("superadmin", "manager"):
        branches = q("SELECT id,name FROM scheduling.branches ORDER BY name")
    else:
        branches = q("SELECT id,name FROM scheduling.branches WHERE id=%s", (user.get("branch_id"),))
    rows = q("""SELECT dc.*, TO_CHAR(dc.date,'YYYY-MM-DD') AS date,
                       TO_CHAR(dc.submitted_at,'YYYY-MM-DD"T"HH24:MI:SS') AS submitted_at,
                       u.username AS submitted_by_name
                FROM scheduling.daily_cases dc
                LEFT JOIN scheduling.users u ON u.id=dc.submitted_by
                WHERE dc.date=%s""", (date,))
    by_branch = {r["branch_id"]: _case_row(r) for r in rows}
    out, summary = [], {"branches": len(branches), "submitted": 0,
                        "total_cases": 0, "total_pt": 0, "bmd_not_done": 0, "mamo_not_done": 0}
    for b in branches:
        c = by_branch.get(b["id"])
        out.append({"branch_id": b["id"], "branch_name": b["name"], "case": c,
                    "can_edit": _can_submit_cases(user, b["id"], date)})
        if c and c.get("locked"):
            summary["submitted"] += 1
        if c:
            summary["total_cases"]  += c["total_cases"]
            summary["total_pt"]     += int(c.get("total_pt") or 0)
            summary["bmd_not_done"] += int(c.get("bmd_not_done") or 0)
            summary["mamo_not_done"]+= int(c.get("mamo_not_done") or 0)
    return {"date": date, "branches": out, "summary": summary}

@app.post("/api/daily-cases")
async def save_daily_case(request: Request, user=Depends(get_current_user)):
    body = await request.json()
    branch_id = body.get("branch_id") or user.get("branch_id")
    date = body.get("date")
    if not branch_id or not date:
        raise HTTPException(400, "branch_id and date required")
    branch_id = _int_or_400(branch_id)
    if not _can_submit_cases(user, branch_id, date):
        raise HTTPException(403, "You can't file the cases report for this branch/day")
    existing = q("SELECT locked FROM scheduling.daily_cases WHERE branch_id=%s AND date=%s",
                 (branch_id, date), one=True)
    if existing and existing.get("locked") and user["role"] not in ("superadmin", "manager"):
        raise HTTPException(403, "This report is submitted/locked. Ask a manager to reopen it.")
    submit = bool(body.get("submit"))
    # Validate every count is a whole, non-negative number — don't 500 on a typo
    # and don't silently clamp a negative (which would hide the mistake).
    field_vals = []
    for f in _CASE_FIELDS:
        raw = body.get(f, 0)
        if raw in (None, ""):
            raw = 0
        try:
            v = int(raw)
        except (TypeError, ValueError):
            raise HTTPException(400, f"'{f}' must be a whole number")
        if v < 0:
            raise HTTPException(400, f"'{f}' can't be negative")
        field_vals.append(v)
    vals_by_field = dict(zip(_CASE_FIELDS, field_vals))
    total_cases = sum(vals_by_field[f] for f in ("xray", "ct", "us", "mamo", "bmd", "insert_cd"))
    # Soft sanity warning (doesn't block the save): procedures logged but the
    # patient count left at zero is almost always a missed field.
    warning = None
    if total_cases > 0 and vals_by_field["total_pt"] == 0:
        warning = "You logged cases but the total patients is 0 — please double-check."
    cols = ",".join(_CASE_FIELDS)
    ph   = ",".join(["%s"] * len(_CASE_FIELDS))
    upd  = ",".join(f"{f}=EXCLUDED.{f}" for f in _CASE_FIELDS)
    sa   = "NOW()" if submit else "NULL"   # submitted_at literal (not user input)
    # Set locked/submitted in BOTH the insert and the conflict-update so a brand
    # new row gets locked on submit (the DO UPDATE only fires on a conflict).
    # A plain Save (submit=false) must NOT touch the lock/submission state —
    # otherwise a reviewer editing an already-submitted report would silently
    # unlock it and wipe who submitted it. Only an actual Submit changes them.
    row = q(f"""INSERT INTO scheduling.daily_cases
                (branch_id,date,{cols},locked,submitted_by,submitted_at)
                VALUES (%s,%s,{ph},%s,%s,{sa})
                ON CONFLICT (branch_id,date) DO UPDATE SET
                  {upd},
                  locked       = CASE WHEN %s THEN true ELSE scheduling.daily_cases.locked END,
                  submitted_by = CASE WHEN %s THEN %s  ELSE scheduling.daily_cases.submitted_by END,
                  submitted_at = CASE WHEN %s THEN NOW() ELSE scheduling.daily_cases.submitted_at END,
                  updated_at=NOW()
                RETURNING *, TO_CHAR(date,'YYYY-MM-DD') AS date""",
            [branch_id, date, *field_vals,
             submit, (user["id"] if submit else None),
             submit, submit, user["id"], submit],
            one=True)
    insert_audit(user, "DAILY_CASES_" + ("SUBMIT" if submit else "SAVE"),
                 f"branch:{branch_id}", date)
    out = _case_row(row)
    if warning:
        out["warning"] = warning
    return out

def _send_cases_reminders(date):
    """Notify the fillers of every branch with no locked report for `date`.
    Returns the list of branch names reminded."""
    pending = q("""SELECT b.id, b.name FROM scheduling.branches b
                   WHERE NOT EXISTS (SELECT 1 FROM scheduling.daily_cases dc
                                     WHERE dc.branch_id=b.id AND dc.date=%s AND dc.locked=true)
                   ORDER BY b.name""", (date,))
    reminded = []
    for b in pending:
        push, inapp = _cases_remind_targets(b["id"], date)
        if not push and not inapp:
            continue
        msg = (f"Reminder: please enter {b['name']}'s daily case numbers in the platform "
               f"now (Daily Cases page). The numbers for {date} will be finalized in "
               f"20 minutes — please complete your entry before then.")
        for uid in push:
            notify(uid, msg, link="cases", ntype="reminder")               # in-app + WhatsApp
        for uid in inapp:
            notify(uid, msg, link="cases", ntype="reminder", whatsapp=False)  # in-app only (off-shift)
        reminded.append(b["name"])
    return reminded

@app.post("/api/daily-cases/remind")
async def remind_daily_cases(request: Request):
    """Remind branches that haven't submitted their daily report yet. Auth: a
    logged-in superadmin, OR an external scheduler passing the X-Cron-Token
    header matching env CRON_SECRET. Deduped to once per 6h per day (?force=1
    overrides)."""
    secret = os.environ.get("CRON_SECRET")
    token  = request.headers.get("X-Cron-Token")
    if not (secret and token and token == secret):
        user = get_current_user(request)
        if user["role"] != "superadmin":
            raise HTTPException(403, "Forbidden")
    p = request.query_params
    date = p.get("date") or _operational_date_server()
    force = p.get("force") == "1"
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    key = f"cases_remind:{date}"
    last = get_setting(key)
    if last and not force:
        try:
            if (now - datetime.fromisoformat(last)).total_seconds() < 6 * 3600:
                return {"date": date, "reminded": [], "skipped": "reminded within the last 6h"}
        except Exception:
            pass
    reminded = _send_cases_reminders(date)
    q("""INSERT INTO scheduling.app_settings (key,value) VALUES (%s,%s)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""",
      (key, now.isoformat()), exec_only=True)
    return {"date": date, "reminded": reminded}

# Daily-cases reminders repeat every 30 minutes from the configured start hour
# until the branch submits (or the window closes), so a missed report keeps
# nudging. The window is bounded so it can't run past the 08:00 operational-date
# rollover (which would start nagging about the next, empty day).
_CASES_REMIND_EVERY_MIN = 30
_CASES_REMIND_WINDOW_HOURS = 6

def _cases_reminder_loop():
    """Built-in scheduler: starting at the configured KSA hour (cases_remind_hour),
    re-remind every 30 minutes the branches that still haven't submitted, until
    they do or the reminder window closes. _send_cases_reminders only targets
    branches with no locked report, so a branch stops getting reminders the moment
    it submits. Each 30-minute slot is claimed atomically (INSERT … ON CONFLICT DO
    NOTHING) so with multiple workers exactly one sends per slot. Disabled when
    cases_remind_hour isn't a valid 0–23 hour."""
    import time
    from datetime import datetime, timezone, timedelta
    while True:
        try:
            raw = get_setting("cases_remind_hour", "0")
            hour = int(raw)
            if 0 <= hour <= 23:
                ksa = datetime.now(timezone.utc) + timedelta(hours=3)
                mins_since_start = (ksa.hour - hour) * 60 + ksa.minute
                # Stop at the 08:00 operational-date rollover so we don't start
                # nagging about the next, freshly-started (empty) day. A window
                # that begins before 08:00 must not run past it.
                crossed_rollover = hour < 8 <= ksa.hour
                if 0 <= mins_since_start < _CASES_REMIND_WINDOW_HOURS * 60 and not crossed_rollover:
                    date = _operational_date_server()
                    slot = mins_since_start // _CASES_REMIND_EVERY_MIN
                    claimed = q("""INSERT INTO scheduling.app_settings (key,value)
                                   VALUES (%s,%s) ON CONFLICT (key) DO NOTHING RETURNING key""",
                                (f"cases_remind_auto:{date}:{slot}", ksa.isoformat()), one=True)
                    if claimed:
                        names = _send_cases_reminders(date)
                        if names:
                            print(f"[cases-reminder] slot {slot}: reminded {len(names)} branch(es) for {date}")
        except Exception as e:
            print(f"[cases-reminder] {e}")
        time.sleep(300)   # re-check every 5 minutes (slots are 30 minutes apart)

# ── RIS auto-file: file verified reports into Siratech with no human in the loop ──
_RAD_AUTOFILE_EVERY_SEC = int(os.environ.get("RAD_AUTOFILE_EVERY_SEC") or 180)
_RAD_AUTOFILE_USER = {"id": None, "username": "system:autofile", "role": "system", "branch_name": None}

def _radiology_autofile_sweep():
    """One auto-file pass: ask the connector for the tests that are SAFE to file with
    no human (report VERIFIED in DePACS + exactly one matching study), then file each
    (result + PDF + authorize) into Siratech and record the order↔study binding. The
    connector re-matches on the write path and refuses anything ambiguous, so a race
    or a changed study can only cause a skip, never a wrong file. Returns #filed."""
    import urllib.parse
    sites = (get_setting("rad_autofile_sites", "") or "").strip()
    qs = {"limit": "40"}
    if sites:
        qs["sites"] = sites
    data = _bridge_request("/his/autofile/candidates?" + urllib.parse.urlencode(qs), timeout=240)
    if not isinstance(data, dict) or not data.get("ok"):
        return 0
    filed = 0
    cands = data.get("candidates") or []
    # Skip any order an operator marked Not Done (local overlay) — a cancelled order must
    # never be auto-filed even if a stray verified study matches it.
    cancelled = set()
    try:
        gpbs = [int(c.get("genPatBillingId")) for c in cands if c.get("genPatBillingId")]
        if gpbs:
            rows = q("""SELECT gen_pat_billing_id FROM scheduling.radiology_orders
                        WHERE gen_pat_billing_id = ANY(%s) AND local_status='cancelled'""", (gpbs,)) or []
            cancelled = {r["gen_pat_billing_id"] for r in rows}
    except Exception:
        pass
    for c in cands:
        try:
            try:
                _cg = int(c.get("genPatBillingId")) if c.get("genPatBillingId") else None
            except Exception:
                _cg = None
            if _cg is not None and _cg in cancelled:
                continue   # operator marked this order Not Done — never auto-file it
            body = {
                "file": c.get("file"), "site": c.get("site"), "billNo": c.get("billNo"),
                "serviceId": c.get("serviceId"), "expectStudyId": c.get("studyId"),
                "genPatBillingId": c.get("genPatBillingId"),
                "confirm": True, "authorize": True,
            }
            out = _bridge_request("/his/results/file", method="POST", body=body, timeout=180)
            wrote = isinstance(out, dict) and out.get("wrote")
            plan = (out.get("plan") or {}) if isinstance(out, dict) else {}
            study = (plan.get("study") or {}) if isinstance(plan, dict) else {}
            gpb = c.get("genPatBillingId") or plan.get("genPatBillingId")
            insert_audit(_RAD_AUTOFILE_USER, "RADIOLOGY_AUTOFILE", str(c.get("file")),
                         json.dumps({"billNo": c.get("billNo"), "serviceId": c.get("serviceId"),
                                     "genPatBillingId": gpb, "studyId": c.get("studyId"),
                                     "serviceName": c.get("serviceName"),
                                     "wrote": bool(wrote),
                                     "authorized": bool(isinstance(out, dict) and out.get("authorized")),
                                     "note": None if wrote else (out.get("note") or out.get("reason") if isinstance(out, dict) else None)}))
            if wrote and gpb:
                _rad_mark_filed(gpb, study.get("studyId") or c.get("studyId"), c.get("serviceId"), None,
                                mrno=c.get("file"), site=c.get("site"), bill_no=c.get("billNo"),
                                accession=(plan.get("accession") or (study.get("accession") if isinstance(study, dict) else None)),
                                accession_source=plan.get("accessionSource"),
                                pacs_id=plan.get("pacsId"), cpacs_url=plan.get("cpacsUrl"),
                                reported_at=((plan.get("report") or {}).get("reportDate")
                                             if isinstance(plan.get("report"), dict) else None))
                filed += 1
        except Exception as e:
            print(f"[rad-autofile] file {c.get('file')}: {e}")
    if filed:
        print(f"[rad-autofile] filed {filed} report(s) into Siratech")
    return filed

_RAD_AUTOSTAMP_EVERY_SEC = int(os.environ.get("RAD_AUTOSTAMP_EVERY_SEC") or 90)
_RAD_AUTOSTAMP_USER = {"id": None, "username": "system:autostamp", "role": "system", "branch_name": None}
_RAD_STAGE_SWEEP_EVERY_SEC = int(os.environ.get("RAD_STAGE_SWEEP_EVERY_SEC") or 120)

def _radiology_stage_sweep():
    """One background pipeline-stage pass: fetch the ready=1 worklist (DePACS-grounded
    stage + readyToFile for the whole org) and persist it to the lifecycle store. This is
    what keeps state='reported'/reported_at, TAT, and orphan detection advancing even when
    NOBODY has the board open — previously the store only moved forward when an operator's
    live ?ready=1 poll happened to run. It also keeps the cold-open Final seed
    (_rad_seed_confirmed_stages) fresh within one sweep window. Read-only vs the HIS; the
    board's own live ready pass is unchanged, so this never drives what an operator sees."""
    import urllib.parse
    ksa_today = (datetime.now(timezone.utc) + timedelta(hours=3)).date()
    qs = {"ready": "1",
          "from": (ksa_today - timedelta(days=_RAD_WORKLIST_DAYS_BACK)).isoformat()}
    data = _bridge_request("/his/worklist?" + urllib.parse.urlencode(qs), timeout=240)
    if isinstance(data, dict):
        items = data.get("items")
        _rad_persist_writes(items)      # upsert orders + exam-state + reconcile resolved
        return len(items or [])
    return 0

def _radiology_stage_sweep_loop():
    """Background stage worker — same claim pattern as auto-file/auto-stamp so exactly one
    sweep runs per window across gunicorn workers. Gated by rad_stage_sweep_enabled (flip
    to '0' to stop)."""
    import time
    time.sleep(50)   # stagger away from the autofile(20s)/autostamp(35s) boot sweeps
    while True:
        try:
            if (get_setting("rad_stage_sweep_enabled", "1") or "1").strip() == "1":
                if _claim_sweep_lock("stage_sweep", 600):
                    try: _radiology_stage_sweep()
                    finally: _release_sweep_lock("stage_sweep")
        except Exception as e:
            print(f"[rad-stage] {e}")
        time.sleep(_RAD_STAGE_SWEEP_EVERY_SEC)
# DICOM modality → the worklist's coarse modality bucket, for matching a DePACS study
# to the right pending order when a patient has several.
_AUTOSTAMP_MOD = {"CT": "CT", "MR": "MR", "US": "US", "MG": "MG",
                  "XR": "XR", "CR": "XR", "DX": "XR", "DR": "XR", "RF": "XR"}

def _mod_bucket(m):
    """Coarse modality bucket (CT/MR/US/XR/MG) from a DICOM code, our normMod output,
    or a service label — used to confirm an MWL accession fits the order it's bound to."""
    s = str(m or "").strip().upper()
    if s in _AUTOSTAMP_MOD:
        return _AUTOSTAMP_MOD[s]
    if re.search(r"X-?RAY|RADIOGRAPH|\bDX\b|\bCR\b|\bDR\b", s): return "XR"
    if re.search(r"ULTRA\s?SOUND|SONOGRAM|\bUS\b", s): return "US"
    if re.search(r"\bCT\b|COMPUTED", s): return "CT"
    if re.search(r"\bMRI?\b|MAGNETIC", s): return "MR"
    if re.search(r"MAMMOG|\bMG\b", s): return "MG"
    return s or None

# Body-part tokens (mirror of handoff.js hoBodyTokens / the connector's bodyTokens): drop
# modality/view/laterality filler, keep anatomy words — so a CHEST study is told apart
# from a KNEE study of the same modality.
_AS_BODY_STOP = {"XR", "CT", "MR", "MRI", "US", "THE", "AND", "VIEW", "VIEWS", "AP", "PA",
    "LAT", "LATERAL", "OBLIQUE", "OBLIQUES", "LT", "RT", "LEFT", "RIGHT", "BILATERAL",
    "BILAT", "BOTH", "WITH", "WITHOUT", "CONTRAST", "SERIES", "STUDY", "SCAN", "PLAIN",
    "ROUTINE", "PORTABLE", "STANDING", "ERECT", "SUPINE", "ONE", "TWO", "THREE"}
def _as_body_tokens(s):
    t = " " + re.sub(r"\s+", " ", re.sub(r"[^A-Z]", " ", str(s or "").upper())) + " "
    t = re.sub(r"\bLUMBO\s?SACRAL\b", " LUMBAR SPINE ", t)
    t = re.sub(r"\bABDO?\b", " ABDOMEN ", t).replace(" CXR ", " CHEST ")
    return {w for w in t.split() if len(w) > 2 and w not in _AS_BODY_STOP}
def _autostamp_body_conflict(study, order_service):
    """True ONLY on a CONFIRMED body-part mismatch: both the study description and the
    order name carry recognisable anatomy AND they don't overlap. When either side has no
    anatomy (this DePACS instance frequently leaves study_desc blank), we CANNOT confirm a
    conflict, so we return False — never blocking a stamp on missing data (fail open on
    absence, fail closed on a real conflict)."""
    a = _as_body_tokens((study or {}).get("study_desc") or (study or {}).get("desc")
                        or (study or {}).get("accession_number") or "")
    b = _as_body_tokens(order_service or "")
    if not a or not b:
        return False
    return not (a & b)

_autostamp_acc_done = set()   # study ids whose accession stamp already ran this process
_autostamp_hist_done = set()  # study ids whose clinical-history stamp already ran this process
_autostamp_branch_blocked = set()  # study ids skipped as not-the-scoped-branch (audit once)
_autostamp_keys_logged = False     # one-time dump of a DePACS study's field names
_autostamp_cursor = 0              # rotating start offset so every patient on the board is swept

def _autostamp_study_station(s):
    """A DePACS study's originating station / institution / source-AE — whatever the
    PACS exposes. DePACS is shared across branches and a study carries no branch id, so
    this (matched against rad_autostamp_n3_stations) is how a study is confirmed to
    belong to the scoped branch before any write. Probes several likely field spellings;
    None when the PACS surfaces none of them."""
    for k in ("station_name", "station", "institution_name", "institution",
              "source_ae", "source_ae_title", "source_aet", "calling_ae",
              "calling_ae_title", "aet", "ae_title", "performed_station",
              "performing_station", "scanner", "modality_station"):
        v = s.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()
    return None

def _claim_sweep_lock(name, ttl_sec):
    """Cross-worker single-flight for a background sweep. Claims the lock only if it's
    free (released) or the holder is older than ttl (a crashed/overrunning sweep) —
    so a sweep that runs longer than its interval can NEVER overlap a second sweep on
    another gunicorn worker (which could double-write). Returns True if claimed."""
    try:
        row = q("""INSERT INTO scheduling.app_settings (key, value)
                   VALUES (%s, EXTRACT(EPOCH FROM NOW())::bigint::text)
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                   WHERE COALESCE(NULLIF(scheduling.app_settings.value,''),'0')::bigint
                         < EXTRACT(EPOCH FROM NOW())::bigint - %s
                   RETURNING key""",
                (f"sweep_lock:{name}", int(ttl_sec)), one=True)
        return bool(row)
    except Exception:
        return False

def _release_sweep_lock(name):
    """Mark the lock free so the NEXT interval can claim immediately after a fast sweep
    (a crashed sweep instead just expires via the ttl above)."""
    try:
        q("UPDATE scheduling.app_settings SET value='0' WHERE key=%s", (f"sweep_lock:{name}",), exec_only=True)
    except Exception:
        pass

def _autostamp_enrich(mrno, chosen, cache, study_acc=None):
    """The clinical indication + ER flag for THIS SPECIFIC exam, for the auto-stamp
    history. Reuses /patient (FetchRISPanel + GetEmrOrderDetails), cached once per
    patient per sweep. Best-effort — returns {} on any hiccup.

    Resolve the patient's order PER EXAM, not per bill: a bill often covers several
    exams, so matching by billNo alone returns the first order and every exam inherits
    the same indication (the owner's "same indication on more than one exam"). Prefer
    the exact accession key; else billNo + service; when a multi-exam bill can't be
    disambiguated, return {} (the caller falls back to the exam name — never a wrong
    indication)."""
    key = str(mrno)
    if key not in cache:
        try:
            import urllib.parse
            cache[key] = _bridge_request("/his/patient/" + urllib.parse.quote(str(mrno)), timeout=30)
        except Exception:
            cache[key] = {}
    d = cache.get(key) or {}
    orders = d.get("orders") if isinstance(d, dict) else None
    orders = orders or []
    bill_no = chosen.get("billNo") if isinstance(chosen, dict) else None
    exam = str((chosen.get("exam") or chosen.get("service") or "") if isinstance(chosen, dict) else "").strip().lower()
    acc = str(study_acc or "").strip()
    o = None
    # 1) exact per-exam accession key — the study's own accession names its order.
    if _elite_is_real_accession(acc):
        o = next((x for x in orders
                  if _elite_bare_id(x.get("accessionNumber")) == _elite_bare_id(acc)), None)
    # 2) billNo + service. One order on the bill → use it; several → match this exam's
    #    service; no service match → leave None (no wrong indication).
    if o is None and bill_no is not None:
        bill_orders = [x for x in orders if str(x.get("billNo")) == str(bill_no)]
        if len(bill_orders) == 1:
            o = bill_orders[0]
        elif exam:
            o = next((x for x in bill_orders
                      if str(x.get("service") or x.get("serviceName") or "").strip().lower() == exam), None)
    o = o or {}
    return {"indication": o.get("clinicalIndication") or o.get("reasonForOrder"),
            "provider": o.get("provider"), "providerId": o.get("providerId"),
            "isER": bool(o.get("isER")), "matched": bool(o)}

def _autostamp_order_acc(o):
    """The native Siratech DICOM accession an order carries (e.g. 'SIRA2552'). The
    worklist feed puts it in `accession` (set once the study is matched); the older
    order-detail shape used `accessionNumber`. Read BOTH so accession matching works
    on the live worklist rows — returns '' when neither holds a real accession."""
    for k in ("accession", "accessionNumber"):
        v = str((o or {}).get(k) or "").strip()
        if _elite_is_real_accession(v):
            return v
    return ""

def _radiology_autostamp_sweep():
    """The moment a patient's images land in DePACS, stamp what the radiologist needs
    to START READING with zero delay — the clinical indication (from the order), the
    category ("Others") and the emergency flag — plus the order's accession when the
    MWL feed knows it unambiguously (so the finished report later files by exact key).
    Replaces waiting for a human handoff; a later handoff simply overwrites with the
    staff's richer text. Idempotent: a study already carrying history+category is
    skipped, and the accession stamp has its own no-clobber guards."""
    global _autostamp_keys_logged, _autostamp_cursor
    data = _bridge_request("/his/worklist", timeout=90)
    if not isinstance(data, dict):
        return 0
    # Scope: only stamp orders from the configured branch(es). Default N3 (Al Rawdah,
    # siteId 3) — the pilot branch. Blank setting → every branch.
    sites_raw = (get_setting("rad_autostamp_sites", "3") or "").strip()
    site_set = set(s.strip() for s in sites_raw.split(",") if s.strip()) if sites_raw else None
    # Shared-PACS branch guard (see the per-study check below): the DePACS station /
    # institution values that identify the scoped branch. Comma-separated, case-insensitive.
    n3_stations_raw = (get_setting("rad_autostamp_n3_stations", "") or "").strip()
    n3_stations = set(x.strip().upper() for x in n3_stations_raw.split(",") if x.strip())
    by_mrn = {}
    for it in (data.get("items") or []):
        if site_set is not None and str(it.get("site") or "").strip() not in site_set:
            continue
        m = str(it.get("mrno") or "").strip()
        if m:
            by_mrn.setdefault(m, []).append(it)
    if not by_mrn:
        return 0
    pat_cache = {}   # mrno -> /patient enrichment (clinical indication + ordering doctor), once per sweep
    ksa_now = datetime.now(timezone.utc) + timedelta(hours=3)
    fresh_days = {ksa_now.strftime("%Y%m%d"), (ksa_now - timedelta(days=1)).strftime("%Y%m%d")}
    stamped = 0
    # Rotate the per-pass window so EVERY patient on the board is eventually swept —
    # not just the first 25. The board sorts emergency-first then oldest-first, so a
    # brand-new routine order (or a manually-added patient) lands at the BOTTOM; a
    # fixed [:25] would never reach it and its images would never get auto-stamped.
    # The cursor advances by the window each pass and wraps, covering the whole board
    # in ceil(N/25) passes (~90s each). Studies already stamped are cheap no-ops.
    mrns = list(by_mrn.items())
    _PASS = 25
    if mrns:
        start = _autostamp_cursor % len(mrns)
        window = (mrns + mrns)[start:start + _PASS]          # wrap-around slice
        _autostamp_cursor = (start + _PASS) % len(mrns)
    else:
        window = []
    for mrno, orders in window:                          # bounded per pass, rotating
        try:
            studies = _elite_studies_for_file(mrno)
        except Exception:
            continue
        fresh = [s for s in studies
                 if re.sub(r"\D", "", str(s.get("study_date") or ""))[:8] in fresh_days]
        if not fresh:
            continue
        # How many fresh studies of each modality — we only stamp when a modality has
        # EXACTLY ONE fresh study (a clean 1:1 with its one order). Two fresh CT studies +
        # one CT order would otherwise BOTH inherit that order's indication + emergency
        # flag, writing the wrong clinical history (and a wrong EMERGENCY) into one of them.
        fresh_mod_count = {}
        for _s in fresh:
            _fm = _AUTOSTAMP_MOD.get(str(_s.get("modality") or "").strip().upper())
            if _fm:
                fresh_mod_count[_fm] = fresh_mod_count.get(_fm, 0) + 1
        try:
            mwl = q("""SELECT accession, modality FROM scheduling.radiology_mwl
                       WHERE mrno=%s AND sps_date = ANY(%s)""",
                    (mrno, list(fresh_days))) or []
        except Exception:
            mwl = []
        # Accessions the scoped branch's MWL agent pushed for this patient — a positive,
        # branch-specific signal (the agent runs at N3, so any accession here is N3).
        mwl_accs = set(_elite_bare_id(r.get("accession")) for r in mwl
                       if _elite_is_real_accession(r.get("accession")))
        for s in fresh:
            sid = s.get("study_id")
            if not sid:
                continue
            smod = _AUTOSTAMP_MOD.get(str(s.get("modality") or "").strip().upper())
            # ONLY attribute this study to an order we can match by modality. If the study
            # can't be tied to EXACTLY ONE order of its own modality, we must NOT stamp —
            # otherwise a routine US study would inherit an unrelated EMERGENCY CT order's
            # flag and indication. When unsure, leave it for the human handoff.
            cand = [o for o in orders
                    if smod and _AUTOSTAMP_MOD.get(str(o.get("modality") or "").strip().upper()) == smod]
            # Accession-first (deterministic per-exam key): if the STUDY already carries a
            # real accession that resolves to exactly one order, THAT order owns this study —
            # even when the patient has two same-modality exams. This is what lets two CT
            # exams each receive THEIR OWN indication instead of one being written onto both.
            s_acc = str(s.get("accession_number") or "").strip()
            acc_cand = ([o for o in orders
                         if _autostamp_order_acc(o)
                         and _elite_bare_id(_autostamp_order_acc(o)) == _elite_bare_id(s_acc)]
                        if _elite_is_real_accession(s_acc) else [])
            cur_hist = str(s.get("clinical_history") or "").strip()
            # One-time: dump a study's field names so the DePACS branch/station field can
            # be pinned from a live response (to configure rad_autostamp_n3_stations).
            if not _autostamp_keys_logged:
                _autostamp_keys_logged = True
                try:
                    print("[rad-autostamp] study keys:", ",".join(sorted(str(k) for k in s.keys())))
                    print("[rad-autostamp] station/accession sample:",
                          repr(_autostamp_study_station(s)), repr(s_acc))
                except Exception:
                    pass
            # SHARED-PACS BRANCH GUARD. DePACS holds EVERY branch's studies but the
            # auto-stamp is scoped (rad_autostamp_sites, default N3). A study carries no
            # branch id, so it must be POSITIVELY confirmed as the scoped branch before
            # any write — otherwise a same-patient study scanned at another branch could
            # inherit an N3 order's indication (a wrong cross-branch write). Positive
            # signals: the study's accession is in the branch MWL feed, OR its DePACS
            # station/institution matches rad_autostamp_n3_stations. Unscoped (blank
            # sites) → write everywhere, as configured. Unconfirmed under a scope → skip.
            _station = _autostamp_study_station(s)
            # Accession = the strongest, self-contained branch signal. The `orders` here
            # were already filtered to the scoped branch(es) (site_set, at the feed step),
            # AND a Siratech accession is unique to the exact order that produced it. So if
            # the study's accession resolves to exactly one scoped-branch order, that single
            # match confirms BOTH the exam and the branch — no MWL agent / station config
            # needed. This is what makes auto-stamp work for the common case (accession-
            # carrying study) without any per-branch station setup.
            n3_confirmed = (
                (bool(n3_stations) and _station is not None and _station.strip().upper() in n3_stations)
                or (_elite_is_real_accession(s_acc) and _elite_bare_id(s_acc) in mwl_accs)
                or (len(acc_cand) == 1)
            )
            branch_ok = (site_set is None) or n3_confirmed
            # Write the moment images arrive (empty history). Guards, in order:
            #   • a definitive accession key resolves to exactly one order → stamp THAT one.
            #     If the study declares an accession but it matches no order, DO NOT fall
            #     back to the fuzzy modality guess — leave it for the human handoff;
            #   • else, exactly ONE fresh study of this modality AND exactly one matching
            #     order → a clean 1:1 (never stamp when it's ambiguous which study↔order);
            #   • history is empty → never clobber a prior stamp or a human's richer note;
            #   • not already stamped this process → never re-write the same study every
            #     sweep (belt-and-suspenders if the list endpoint under-reports history).
            # The empty-history gate is checked BEFORE the expensive /patient enrichment,
            # so a steady board (studies already stamped) costs no extra HIS calls.
            # ADDITIVE resolution: prefer the exact accession key when it resolves to one
            # order, but ALWAYS fall back to the unambiguous modality 1:1 guard otherwise —
            # never SKIP a stamp just because the study carries an accession the (accession-
            # less) worklist feed can't echo. Two-exam safety is still held by fresh_mod_count.
            chosen = None
            if len(acc_cand) == 1:
                chosen = acc_cand[0]                              # exact per-exam key (best)
            elif smod and fresh_mod_count.get(smod, 0) == 1 and len(cand) == 1:
                # Modality 1:1 fallback. Guard against the SAME conflict the manual
                # write-history gate blocks (line ~7666): if the STUDY carries a real
                # accession AND the single candidate order carries a real accession that
                # DIFFERS, they are DIFFERENT exams — the study's own accession key names
                # another order, so this order's indication must NOT be stamped onto it.
                # (An accession MATCH would already have fired the acc_cand branch above,
                #  so reaching here with both real means they differ.) An accession-less
                # order — the common case for this feed — has no real accession to
                # conflict, so the clean 1:1 still stamps. Fail closed + audit.
                _cand_acc = _autostamp_order_acc(cand[0])
                if (_elite_is_real_accession(s_acc) and _elite_is_real_accession(_cand_acc)
                        and _elite_bare_id(s_acc) != _elite_bare_id(_cand_acc)):
                    insert_audit(_RAD_AUTOSTAMP_USER, "RADIOLOGY_AUTOSTAMP_BLOCKED", str(mrno),
                                 json.dumps({"studyId": sid, "reason": "accession_mismatch",
                                             "study_accession": s_acc, "order_accession": _cand_acc}))
                # BODY-PART GATE (AS3): the modality-1:1 fallback matches on modality ALONE,
                # so a CT-head study could take a CT-abdomen order's indication. Block on a
                # CONFIRMED body-part mismatch (both anatomy known and non-overlapping). Blank
                # study_desc → no conflict detectable → still stamps (common on this HIS).
                elif _autostamp_body_conflict(s, cand[0].get("exam") or cand[0].get("service")):
                    insert_audit(_RAD_AUTOSTAMP_USER, "RADIOLOGY_AUTOSTAMP_BLOCKED", str(mrno),
                                 json.dumps({"studyId": sid, "reason": "bodypart_mismatch",
                                             "study_desc": s.get("study_desc") or s.get("desc"),
                                             "order": cand[0].get("exam") or cand[0].get("service")}))
                else:
                    chosen = cand[0]                              # unambiguous modality 1:1 (fallback)
            if (chosen is not None and not branch_ok
                    and not cur_hist and sid not in _autostamp_hist_done):
                # Would have stamped, but the study isn't confirmed as the scoped branch.
                if sid not in _autostamp_branch_blocked:
                    _autostamp_branch_blocked.add(sid)
                    insert_audit(_RAD_AUTOSTAMP_USER, "RADIOLOGY_AUTOSTAMP_BLOCKED", str(mrno),
                                 json.dumps({"studyId": sid, "reason": "branch_unconfirmed",
                                             "station": _station, "study_accession": s_acc}))
            elif (chosen is not None and branch_ok
                    and not cur_hist and sid not in _autostamp_hist_done):
                o = chosen
                # HARD PATIENT GATE (defence in depth): never write onto a study whose
                # patient doesn't match the file we're processing — even though the study
                # came from _elite_studies_for_file(mrno). pat_id is already on the study
                # object (from get_studies), so this costs no extra call. Fail closed.
                if not _elite_same_patient(s.get("pat_id"), mrno):
                    insert_audit(_RAD_AUTOSTAMP_USER, "RADIOLOGY_AUTOSTAMP_BLOCKED", str(mrno),
                                 json.dumps({"studyId": sid, "study_pat_id": s.get("pat_id"),
                                             "reason": "patient_mismatch"}))
                    continue
                emergency = bool(o.get("emergency"))
                # Enrich with THIS exam's real clinical indication — resolved per exam
                # (accession, else billNo+service), so two exams on one bill don't share
                # one indication. Pass the study's own accession + the chosen order.
                enr = _autostamp_enrich(mrno, o, pat_cache, s.get("accession_number"))
                if enr.get("isER"):
                    emergency = True
                indication = str(enr.get("indication") or "").strip()
                # Clinical history text is the INDICATION ONLY (owner: "الاندكيشن بس") —
                # no doctor name/number, no EMERGENCY/ROUTINE word. Emergency is still
                # written as a real flag on the study via set_emergency below.
                text = indication or str(o.get("exam") or "").strip()
                if text:
                    try:
                        _elite_write_history(sid, text, set_emergency=emergency)
                        _autostamp_hist_done.add(sid)   # don't re-stamp this study this process
                        stamped += 1
                        insert_audit(_RAD_AUTOSTAMP_USER, "RADIOLOGY_AUTOSTAMP", str(mrno),
                                     json.dumps({"studyId": sid, "emergency": bool(emergency),
                                                 "history": text[:160], "site": o.get("site")}))
                    except Exception as e:
                        print(f"[rad-autostamp] history {mrno}/{sid}: {e}")
            # accession: deterministic key from the MWL feed — only on a true modality 1:1.
            # SAFETY: a single MWL accession must NEVER be stamped onto more than one study
            # (it would make two DePACS studies share an accession and poison the reverse-
            # file deterministic key). So we require EXACTLY ONE fresh study of this modality
            # AND exactly one MWL entry of the same modality before stamping — mirroring the
            # history gate. The old "len(mwl)==1 → stamp every fresh study" fallback did the
            # opposite and is removed (fail closed: unmatched accessions wait for a human).
            # Same branch guard: never stamp the scoped branch's accession onto a study that
            # isn't confirmed to be that branch's.
            if branch_ok and sid not in _autostamp_acc_done:
                acc = None
                if smod and fresh_mod_count.get(smod, 0) == 1:
                    hits = [r for r in mwl
                            if _AUTOSTAMP_MOD.get(str(r.get("modality") or "").strip().upper()) == smod]
                    if len(hits) == 1:
                        acc = hits[0].get("accession")
                if acc:
                    try:
                        res = _elite_stamp_accession(sid, acc)
                        _autostamp_acc_done.add(sid)
                        if res.get("stamped") and res.get("changed"):
                            insert_audit(_RAD_AUTOSTAMP_USER, "RADIOLOGY_AUTOSTAMP_ACC", str(mrno),
                                         json.dumps({"studyId": sid, "accession": acc}))
                    except Exception as e:
                        print(f"[rad-autostamp] accession {mrno}/{sid}: {e}")
    if stamped:
        print(f"[rad-autostamp] stamped {stamped} stud(ies)")
    return stamped

def _radiology_autostamp_loop():
    """Background auto-stamp worker — same claim pattern as auto-file so exactly one
    sweep runs per window across gunicorn workers. Gated by rad_autostamp_enabled."""
    import time
    from datetime import datetime, timezone
    time.sleep(35)   # stagger away from the autofile worker's boot sweep
    while True:
        try:
            # Default ON (scoped to N3 via rad_autostamp_sites) — the operator asked for
            # it to run now on Al Rawdah. Flip rad_autostamp_enabled to '0' to stop.
            if (get_setting("rad_autostamp_enabled", "1") or "1").strip() == "1":
                # 900s TTL (>> the worst-case sweep time) so a slow sweep can never let a
                # second gunicorn worker start a concurrent sweep and double-write.
                if _claim_sweep_lock("autostamp", 900):
                    try: _radiology_autostamp_sweep()
                    finally: _release_sweep_lock("autostamp")
        except Exception as e:
            print(f"[rad-autostamp] {e}")
        time.sleep(_RAD_AUTOSTAMP_EVERY_SEC)

_CONSENT_REFILE_EVERY_SEC = int(os.environ.get("CONSENT_REFILE_EVERY_SEC") or 180)
def _consent_refile_sweep():
    """Retry filing SIGNED consents that aren't on the Siratech file yet (filed_siratech
    false) — the common case is a consent signed BEFORE its order reached Result Entry,
    where filing-at-signing couldn't find a row to attach to. _file_consent_to_siratech is
    idempotent + claim-guarded, so this only fills the real gaps and never double-attaches.
    Bounded per sweep so it's light on the HIS. This is what GUARANTEES a signed consent
    eventually lands on the patient's Siratech record even if no Meena report is filed."""
    rows = q("""SELECT id FROM scheduling.consents
                WHERE status='signed' AND pdf IS NOT NULL AND filed_siratech=false
                  AND signed_at > NOW() - INTERVAL '14 days'
                ORDER BY signed_at DESC LIMIT 40""") or []
    filed = 0
    for r in rows:
        try:
            if _file_consent_to_siratech(r["id"]):
                filed += 1
        except Exception:
            pass
    if filed:
        print(f"[consent-refile] filed {filed} pending consent(s) to Siratech")
    return filed

def _consent_refile_loop():
    """Background worker that keeps retrying un-filed signed consents until they're on the
    Siratech file. Single-flight across workers via the sweep lock."""
    import time
    time.sleep(30)
    while True:
        try:
            if _claim_sweep_lock("consent_refile", 300):
                try: _consent_refile_sweep()
                finally: _release_sweep_lock("consent_refile")
        except Exception as e:
            print(f"[consent-refile] {e}")
        time.sleep(_CONSENT_REFILE_EVERY_SEC)

def _radiology_autofile_loop():
    """Background auto-file worker. Runs only when the `rad_autofile_enabled` setting
    is '1' (flip it off from the worklist to stop instantly). Each cycle is claimed
    atomically so with multiple gunicorn workers exactly one sweep runs per window."""
    import time
    from datetime import datetime, timezone
    # Small stagger so the sweep never collides with the snapshot job on boot.
    time.sleep(20)
    while True:
        try:
            if (get_setting("rad_autofile_enabled", "0") or "0").strip() == "1":
                # TTL lock (not a per-window bucket): a filing sweep that runs longer than
                # the interval can never overlap a second sweep on another worker, which
                # could race two writes to the same order.
                if _claim_sweep_lock("autofile", 600):
                    try: _radiology_autofile_sweep()
                    finally: _release_sweep_lock("autofile")
        except Exception as e:
            print(f"[rad-autofile] {e}")
        time.sleep(_RAD_AUTOFILE_EVERY_SEC)

def start_scheduler():
    # Skip under the test harness; otherwise one daemon thread per worker is fine
    # (the atomic per-day claim keeps the actual send single).
    if os.environ.get("SMTP_CAPTURE") or os.environ.get("DISABLE_SCHEDULER"):
        return
    # Auto-file runs by itself and hidden (owner's directive): the moment a report is
    # VERIFIED it's filed into Siratech and the patient drops off the worklist — no
    # human, no UI. Turn it on ONCE (idempotent) rather than forcing it every boot, so
    # it stays controllable via the superadmin API afterwards without being re-forced.
    try:
        if get_setting("rad_autofile_forced_on") != "1":
            set_setting("rad_autofile_enabled", "1")
            set_setting("rad_autofile_forced_on", "1")
        # Auto-stamp (owner's directive): the moment images land in DePACS, the
        # indication + category + ER flag are written so the radiologist starts with
        # zero delay. Same once-only force pattern as auto-file.
        if get_setting("rad_autostamp_forced_on") != "1":
            set_setting("rad_autostamp_enabled", "1")
            set_setting("rad_autostamp_forced_on", "1")
    except Exception:
        pass
    import threading
    threading.Thread(target=_rad_persist_worker, daemon=True).start()   # drains deferred worklist writes
    threading.Thread(target=_cases_reminder_loop, daemon=True).start()
    threading.Thread(target=_shift_check_reminder_loop, daemon=True).start()
    threading.Thread(target=_credential_reminder_loop, daemon=True).start()
    threading.Thread(target=_maintenance_reminder_loop, daemon=True).start()
    threading.Thread(target=_radiology_snapshot_loop, daemon=True).start()
    threading.Thread(target=_rad_reconcile_loop, daemon=True).start()   # nightly billed-vs-performed reconciliation
    threading.Thread(target=_radiology_autofile_loop, daemon=True).start()
    threading.Thread(target=_radiology_autostamp_loop, daemon=True).start()
    threading.Thread(target=_radiology_stage_sweep_loop, daemon=True).start()   # keeps store stage/ledger warm viewer-independently
    threading.Thread(target=_consent_refile_loop, daemon=True).start()          # retries un-filed consents onto the Siratech file
    threading.Thread(target=_cdxfer_cleanup_loop, daemon=True).start()

def _capture_radiology_day(day_str, source_label="worklist"):
    """Pull the radiology stats for a single day from the connector and store an
    immutable daily snapshot (idempotent on stat_date — a re-run refreshes it)."""
    import urllib.parse
    qs = urllib.parse.urlencode({"from": day_str, "to": day_str})
    data = _bridge_request("/his/stats/radiology?" + qs, timeout=150)
    if not data or not data.get("ok"):
        raise RuntimeError(f"connector returned {data.get('error') if isinstance(data, dict) else 'no data'}")
    pr = data.get("priority") or {}
    q("""INSERT INTO scheduling.radiology_stats_daily
             (stat_date, total, emergency, routine, by_branch, by_department, by_doctor, payload, source, captured_at)
         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s, NOW())
         ON CONFLICT (stat_date) DO UPDATE SET
             total=EXCLUDED.total, emergency=EXCLUDED.emergency, routine=EXCLUDED.routine,
             by_branch=EXCLUDED.by_branch, by_department=EXCLUDED.by_department, by_doctor=EXCLUDED.by_doctor,
             payload=EXCLUDED.payload, source=EXCLUDED.source, captured_at=NOW()""",
      (day_str, data.get("total", 0), pr.get("emergency", 0), pr.get("routine", 0),
       json.dumps(data.get("byBranch") or []), json.dumps(data.get("byDepartment") or []),
       json.dumps(data.get("byDoctor") or []), json.dumps(data), source_label),
      exec_only=True)
    return data.get("total", 0)

def _radiology_snapshot_loop():
    """Once a day, store a snapshot of the *previous* KSA day's radiology stats so
    the month/quarter comparisons have history. We capture yesterday (fully
    settled) rather than today, and back-fill up to 7 recent missing days so a
    weekend restart doesn't leave gaps. The per-day row check + PK make it run once
    even across gunicorn workers."""
    import time
    from datetime import datetime, timezone, timedelta
    while True:
        try:
            if not _bridge_base():
                time.sleep(3600); continue
            ksa = datetime.now(timezone.utc) + timedelta(hours=3)
            for back in range(1, 8):                       # yesterday .. 7 days ago
                day = (ksa - timedelta(days=back)).strftime('%Y-%m-%d')
                # Gate on the actual snapshot ROW, not a separate claim key. The old
                # claim-before-capture pattern orphaned a day forever if the worker
                # was killed mid-capture (claim persisted, row never written). The
                # daily-row PK is the honest idempotency gate; a rare concurrent
                # double-capture is harmless because the upsert is idempotent.
                exists = q("SELECT 1 FROM scheduling.radiology_stats_daily WHERE stat_date=%s",
                           (day,), one=True)
                if exists:
                    continue
                try:
                    n = _capture_radiology_day(day)
                    print(f"[radstats] snapshot {day}: {n} requests")
                except Exception as e:
                    print(f"[radstats] snapshot {day} failed: {e}")
        except Exception as e:
            print(f"[radstats] loop error: {e}")
        time.sleep(3600)

RAD_RECON_WINDOW_DAYS = int(os.environ.get("RAD_RECON_WINDOW_DAYS", "30"))
RAD_RECON_FLAG_DAYS    = int(os.environ.get("RAD_RECON_FLAG_DAYS", "14"))
# Auto-notification KILL SWITCH. Default OFF: the reconciliation still runs nightly to populate
# the dashboard tables, but it sends NO email / in-app notification to anyone. This exists because
# the report was reaching managers' inboxes with numbers that aren't validated yet. Nothing goes
# out until this is deliberately turned back on (set RAD_RECON_NOTIFY=1). Enforced in one place —
# _rad_reconcile_notify — so it also blocks any manual reconcile/run?notify=1 call.
RAD_RECON_NOTIFY_ENABLED = os.environ.get("RAD_RECON_NOTIFY", "0") == "1"
# Modalities that do NOT push a DICOM study to PACS (DEXA / bone densitometry), so PACS can
# never confirm them "performed" — they must not be counted as "not performed". Verified live:
# the /diag/reconcile-branch probe showed the "Digital" branch's low rate was ~all DEXA orders
# with zero PACS studies (no matching gap). These land in their own PACS-unverifiable bucket;
# "performed" for them still comes from a filed report (stage='reported') or a manual complete.
_RAD_NON_PACS_MOD_RE = re.compile(r"dexa|\bbmd\b|bone\s*densit|densitom", re.I)

def _rad_reconcile_run(window_days=None, flag_days=None):
    """End-of-day BILLED vs ACTUALLY-PERFORMED reconciliation.

    Sweeps the trailing window's orders via the ready=1 worklist (whose `stage` is
    DePACS-CONFIRMED — a real PACS study = the exam was physically performed) and buckets
    each order:
      • performed        — stage imaged/draft/reported (a PACS study exists)
      • awaiting_report  — imaged/draft but not yet reported
      • not_performed    — stage 'ordered' (no PACS study)
      • aged             — not_performed AND ordered >= flag_days ago → the follow-up list

    A patient who legitimately comes in a few days later is NOT flagged (only orders past
    flag_days). Stores a daily snapshot and returns the summary. Read-only w.r.t. HIS."""
    import urllib.parse
    from datetime import datetime, timezone, timedelta
    window_days = int(window_days or RAD_RECON_WINDOW_DAYS)
    flag_days = int(flag_days or RAD_RECON_FLAG_DAYS)
    now = datetime.now(timezone.utc)
    ksa = now + timedelta(hours=3)
    to_d = ksa.date()
    from_d = to_d - timedelta(days=window_days)
    # Fetch the DePACS-confirmed board in WEEKLY chunks so each connector call stays under its
    # ready-pass ceiling (a single 30-day ready=1 sweep would blow the timeout).
    # matchAfterH: count a PACS study as this order's exam up to `flag_days` AFTER the order,
    # so a study performed MANUALLY / LATE (days after the order, when the modality worklist
    # never showed it) still links instead of reading as "not performed". Bounded to the
    # connector's 720h (30-day) ceiling.
    match_after_h = min(720, max(96, flag_days * 24))
    by_key = {}
    chunk_start = from_d
    while chunk_start <= to_d:
        chunk_end = min(chunk_start + timedelta(days=6), to_d)
        qs = urllib.parse.urlencode({"from": chunk_start.isoformat(), "to": chunk_end.isoformat(),
                                     "ready": "1", "matchAfterH": match_after_h})
        try:
            data = _bridge_request("/his/worklist?" + qs, timeout=240)
        except Exception as e:
            print(f"[reconcile] chunk {chunk_start}..{chunk_end} failed: {e}")
            data = None
        for it in ((data or {}).get("items") or []):
            gpb = it.get("genPatBillingId")
            key = str(gpb) if gpb else f"{it.get('mrno')}|{it.get('exam')}|{it.get('orderedDate')}"
            by_key[key] = it   # last-wins; chunks don't overlap, this just de-dupes edge cases
        chunk_start = chunk_end + timedelta(days=1)
    items = list(by_key.values())
    # Staff can mark an order "performed" on the board (local_status='completed' / completed_at)
    # for exams the PACS auto-match can never catch — e.g. a study filed under a blank/wrong ID
    # at the modality. Honor that HUMAN signal: a manually-completed order counts as performed
    # even with no PACS match. (This is the "Mark completed" button that already exists.)
    gpbs = []
    for it in items:
        try:
            gpbs.append(int(it.get("genPatBillingId")))
        except Exception:
            pass
    manual_done = set()
    if gpbs:
        for r in (q("""SELECT gen_pat_billing_id FROM scheduling.radiology_orders
                        WHERE gen_pat_billing_id = ANY(%s)
                          AND (completed_at IS NOT NULL OR local_status = 'completed')""",
                    (gpbs,)) or []):
            try:
                manual_done.add(int(r["gen_pat_billing_id"]))
            except Exception:
                pass
    performed = not_performed = awaiting = reported = aged = performed_manual = unverifiable = 0
    aged_list = []
    by_branch = {}
    by_day = {}   # ORDER-date → {ordered, done, unverifiable, mods:{mod:{ordered,done}}}
    for it in items:
        stage = (it.get("stage") or "").lower()
        site = it.get("site")
        try:
            gpb = int(it.get("genPatBillingId"))
        except Exception:
            gpb = None
        bname = it.get("branchName") or it.get("siteName") or it.get("branch") or (f"Branch {site}" if site is not None else "—")
        b = by_branch.setdefault(str(site), {"site": site, "name": bname, "ordered": 0, "performed": 0, "notPerformed": 0, "aged": 0, "unverifiable": 0})
        b["ordered"] += 1
        # Attribute this order to the DAY IT WAS ORDERED (KSA), so a late exam corrects that
        # original day's `done` on a future re-run — not the day it was finally imaged.
        od = _rad_ts(it.get("orderedDate"))
        dkey = (od + timedelta(hours=3)).date().isoformat() if od else None
        mod = (it.get("modality") or "Other").strip().upper() or "Other"
        dd = by_day.setdefault(dkey, {"ordered": 0, "done": 0, "unverifiable": 0, "mods": {}}) if dkey else None
        mm = dd["mods"].setdefault(mod, {"ordered": 0, "done": 0}) if dd else None
        if dd:
            dd["ordered"] += 1; mm["ordered"] += 1
        pacs_perf = stage in ("imaged", "draft", "reported")
        manual_perf = gpb in manual_done
        if pacs_perf or manual_perf:
            performed += 1; b["performed"] += 1
            if dd:
                dd["done"] += 1; mm["done"] += 1
            if stage == "reported":
                reported += 1
            elif pacs_perf:
                awaiting += 1
            else:
                performed_manual += 1   # no PACS study, but staff confirmed it was done
        elif _RAD_NON_PACS_MOD_RE.search(f"{it.get('exam') or ''} {it.get('modality') or ''}"):
            # DEXA / bone-density: never lands in PACS, so "not performed" here is meaningless —
            # bucket separately (confirm via report or the manual button, not PACS).
            unverifiable += 1; b["unverifiable"] += 1
            if dd:
                dd["unverifiable"] += 1
        else:
            not_performed += 1; b["notPerformed"] += 1
            days_waiting = int((now - od).total_seconds() // 86400) if od else None
            if days_waiting is not None and days_waiting >= flag_days:
                aged += 1; b["aged"] += 1
                aged_list.append({
                    "mrno": str(it.get("mrno") or ""), "name": (it.get("patientName") or "").strip(),
                    "exam": it.get("exam") or it.get("modality") or "", "branch": bname,
                    "department": it.get("department") or "", "orderedDate": it.get("orderedDate"),
                    "daysWaiting": days_waiting, "modality": it.get("modality") or "",
                })
    # Upsert the per-DAY ordered/done so the "daily & monthly" view self-corrects for late exams.
    for dkey, dv in by_day.items():
        try:
            q("""INSERT INTO scheduling.radiology_done_daily (stat_date, ordered, done, unverifiable, by_modality, updated_at)
                 VALUES (%s,%s,%s,%s,%s, NOW())
                 ON CONFLICT (stat_date) DO UPDATE SET
                     ordered=EXCLUDED.ordered, done=EXCLUDED.done, unverifiable=EXCLUDED.unverifiable,
                     by_modality=EXCLUDED.by_modality, updated_at=NOW()""",
              (dkey, dv["ordered"], dv["done"], dv["unverifiable"], json.dumps(dv["mods"])),
              exec_only=True)
        except Exception:
            pass
    aged_list.sort(key=lambda x: x.get("daysWaiting") or 0, reverse=True)
    aged_list = aged_list[:300]
    ordered_total = len(items)
    # Today + this-month ordered/done totals (from the per-day tally) for the report headline.
    ksa_month = to_d.strftime("%Y-%m")
    month_ordered = sum(d["ordered"] for k, d in by_day.items() if k and k.startswith(ksa_month))
    month_done = sum(d["done"] for k, d in by_day.items() if k and k.startswith(ksa_month))
    today_dv = by_day.get(to_d.isoformat()) or {"ordered": 0, "done": 0}
    payload = {
        "windowFrom": from_d.isoformat(), "windowTo": to_d.isoformat(), "flagDays": flag_days,
        "performedManual": performed_manual, "unverifiable": unverifiable,
        "byBranch": sorted(by_branch.values(), key=lambda x: x["ordered"], reverse=True),
        "aged": aged_list, "generatedAt": now.isoformat(),
    }
    run_date = to_d.isoformat()
    q("""INSERT INTO scheduling.radiology_reconcile_daily
             (run_date, window_from, window_to, flag_days, ordered_total, performed,
              not_performed, not_performed_aged, awaiting_report, reported, payload, captured_at)
         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, NOW())
         ON CONFLICT (run_date) DO UPDATE SET
             window_from=EXCLUDED.window_from, window_to=EXCLUDED.window_to, flag_days=EXCLUDED.flag_days,
             ordered_total=EXCLUDED.ordered_total, performed=EXCLUDED.performed,
             not_performed=EXCLUDED.not_performed, not_performed_aged=EXCLUDED.not_performed_aged,
             awaiting_report=EXCLUDED.awaiting_report, reported=EXCLUDED.reported,
             payload=EXCLUDED.payload, captured_at=NOW()""",
      (run_date, from_d.isoformat(), to_d.isoformat(), flag_days, ordered_total, performed,
       not_performed, aged, awaiting, reported, json.dumps(payload)),
      exec_only=True)
    return {"runDate": run_date, "windowFrom": from_d.isoformat(), "windowTo": to_d.isoformat(),
            "flagDays": flag_days, "orderedTotal": ordered_total, "performed": performed,
            "performedManual": performed_manual, "unverifiable": unverifiable,
            "notPerformed": not_performed, "notPerformedAged": aged, "awaitingReport": awaiting,
            "reported": reported, "byBranch": payload["byBranch"], "agedList": aged_list,
            "todayOrdered": today_dv.get("ordered", 0), "todayDone": today_dv.get("done", 0),
            "monthOrdered": month_ordered, "monthDone": month_done, "month": ksa_month}

def _rad_reconcile_notify(summary):
    """Push the end-of-day reconciliation summary (+ top follow-up patients) to management.
    In-app + email (no WhatsApp — the list is long). Best-effort per recipient."""
    # KILL SWITCH — default OFF. While validating the numbers, this report must reach NO ONE
    # (managers were getting emails with unvalidated figures). Return without sending. Flip
    # RAD_RECON_NOTIFY=1 to re-enable once the data is trusted.
    if not RAD_RECON_NOTIFY_ENABLED:
        print("[reconcile] notify suppressed (RAD_RECON_NOTIFY off) — no email/notification sent")
        return 0
    aged = summary.get("agedList") or []
    manual = summary.get("performedManual") or 0
    unverifiable = summary.get("unverifiable") or 0
    _pct = lambda done, ordered: (round(done / ordered * 100) if ordered else 0)
    t_ord, t_done = summary.get("todayOrdered", 0), summary.get("todayDone", 0)
    m_ord, m_done = summary.get("monthOrdered", 0), summary.get("monthDone", 0)
    lines = [
        f"🩻 Radiology — ordered vs done",
        f"📅 Today: {t_done}/{t_ord} done ({_pct(t_done, t_ord)}%)",
        f"🗓️ This month ({summary.get('month','')}): {m_done}/{m_ord} done ({_pct(m_done, m_ord)}%)",
        "",
        f"— reconciliation window {summary['windowFrom']} → {summary['windowTo']} —",
        f"✅ Performed: {summary['performed']}" + (f" (incl. {manual} marked manually)" if manual else ""),
        f"⚠️ Billed but NOT performed >{summary['flagDays']}d: {summary['notPerformedAged']} — needs follow-up",
        f"🕓 Performed, not reported: {summary['awaitingReport']}",
    ]
    if unverifiable:
        lines.append(f"➖ DEXA/non-PACS (can't confirm via PACS): {unverifiable}")
    lines.append(f"Ordered total (window): {summary['orderedTotal']}")
    # Per-branch performed rate (worst first) so a low outlier — a branch whose imaging may be
    # on a different PACS, or a matching gap — jumps out instead of hiding in the org-wide 77%.
    # Denominator EXCLUDES the DEXA/non-PACS orders so a DEXA-heavy branch (e.g. "Digital")
    # isn't unfairly low for exams PACS can never confirm.
    branches = summary.get("byBranch") or []
    rated = []
    for b in branches:
        unv = b.get("unverifiable") or 0
        denom = (b.get("ordered") or 0) - unv
        if denom <= 0:
            continue
        pct = round((b.get("performed") or 0) / denom * 100)
        rated.append((pct, denom, b.get("name") or f"Branch {b.get('site')}", b.get("performed") or 0, unv))
    if rated:
        rated.sort(key=lambda x: (x[0], -x[1]))   # lowest rate first; ties → busier branch first
        lines.append("")
        lines.append("By branch (performed rate, excl. DEXA):")
        for pct, denom, name, perf, unv in rated[:10]:
            flag = " ⚠️" if (pct < 60 and denom >= 5) else ""
            tail = f" (+{unv} DEXA)" if unv else ""
            lines.append(f"• {name}: {perf}/{denom} ({pct}%){tail}{flag}")
    if aged:
        lines.append("")
        lines.append("Top not-performed (days waiting):")
        for a in aged[:15]:
            nm = a.get("name") or a.get("mrno") or "—"
            lines.append(f"• {nm} · {a.get('exam') or a.get('modality') or ''} · {a.get('branch') or ''} · {a.get('daysWaiting')}d")
        if len(aged) > 15:
            lines.append(f"…and {len(aged) - 15} more")
    msg = "\n".join(lines)
    recips = q("SELECT id FROM scheduling.users WHERE role = ANY(%s)", (["manager", "superadmin"],)) or []
    for u in recips:
        try:
            notify(u["id"], msg, link=None, ntype="radiology", whatsapp=False)
        except Exception:
            pass
    return len(recips)

def _rad_reconcile_loop():
    """Once a day at end-of-day (>=22:00 KSA), run the billed-vs-performed reconciliation.
    Claim-gated on app_settings so it fires exactly once across gunicorn workers."""
    import time
    from datetime import datetime, timezone, timedelta
    while True:
        try:
            if _bridge_base():
                ksa = datetime.now(timezone.utc) + timedelta(hours=3)
                if ksa.hour >= 22:
                    claimed = q("""INSERT INTO scheduling.app_settings (key, value) VALUES (%s, %s)
                                   ON CONFLICT (key) DO NOTHING RETURNING key""",
                                (f"rad_reconcile:{ksa.strftime('%Y-%m-%d')}", ksa.isoformat()), one=True)
                    if claimed:
                        try:
                            s = _rad_reconcile_run()
                            n = _rad_reconcile_notify(s)
                            print(f"[reconcile] {s['runDate']}: performed={s['performed']} "
                                  f"not-performed>{s['flagDays']}d={s['notPerformedAged']} → {n} managers")
                        except Exception as e:
                            print(f"[reconcile] run failed: {e}")
        except Exception as e:
            print(f"[reconcile] loop error: {e}")
        time.sleep(3600)

def _credential_reminder_loop():
    """Once a day, sweep for credentials expiring within 30 days and alert."""
    import time
    from datetime import datetime, timezone, timedelta
    while True:
        try:
            ksa = datetime.now(timezone.utc) + timedelta(hours=3)
            claimed = q("""INSERT INTO scheduling.app_settings (key,value) VALUES (%s,%s)
                           ON CONFLICT (key) DO NOTHING RETURNING key""",
                        (f"cred_sweep:{ksa.strftime('%Y-%m-%d')}", ksa.isoformat()), one=True)
            if claimed:
                _send_credential_reminders()
        except Exception as e:
            print(f"[cred-reminder] {e}")
        time.sleep(3600)

@app.put("/api/daily-cases/reopen")
async def reopen_daily_case(request: Request, user=Depends(require_reviewer)):
    body = await request.json()
    branch_id, date = body.get("branch_id"), body.get("date")
    if not branch_id or not date:
        raise HTTPException(400, "branch_id and date required")
    branch_id = _int_or_400(branch_id)
    q("UPDATE scheduling.daily_cases SET locked=false WHERE branch_id=%s AND date=%s",
      (branch_id, date), exec_only=True)
    insert_audit(user, "DAILY_CASES_REOPEN", f"branch:{branch_id}", date)
    return {"ok": True}

# ── Audit ─────────────────────────────────────────────────────────────────────

@app.get("/api/audit")
def get_audit(user=Depends(require_superadmin)):
    return q("""SELECT id,username,role,branch,action,target,detail,created_at
                FROM scheduling.audit_log ORDER BY created_at DESC LIMIT 500""")

# ── Danger zone: clear test/operational data for a clean production start ──────
# Wipes the records you build day-to-day (staff, schedules, leave, swaps, cases,
# sign-ups, notifications) and every NON-superadmin login, while KEEPING the
# structure you set up — branches, shift types, nest sections, holidays, org
# settings — and all superadmin accounts. Superadmin-only, and the request must
# carry the exact "RESET" confirmation token.
# Operational/test data wiped by the superadmin "Clear test data" action.
# NOTE: section_month_settings / staff_month_settings are CONFIGURATION (the
# tuned per-month limits like max-consecutive, min/max off, M/N coverage), not
# test data — wiping them silently reset everyone's carefully-set constraints.
# They're tied to nest_sections (which we keep), so they're preserved here.
_RESET_TABLES = [
    "schedule_entries", "schedules", "leave_requests", "shift_swaps",
    "daily_cases", "staff_registrations", "notifications", "password_resets",
    "audit_log", "staff",
]

@app.post("/api/admin/reset-data")
async def reset_data(request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    if body.get("confirm") != "RESET":
        raise HTTPException(400, "Confirmation token required")
    deleted = {}
    for t in _RESET_TABLES:
        row = q(f"WITH d AS (DELETE FROM scheduling.{t} RETURNING 1) SELECT COUNT(*) AS c FROM d", one=True)
        deleted[t] = (row or {}).get("c", 0)
    # Remove every non-superadmin login (test accounts); keep the owners.
    row = q("WITH d AS (DELETE FROM scheduling.users WHERE role <> 'superadmin' RETURNING 1) "
            "SELECT COUNT(*) AS c FROM d", one=True)
    deleted["users (non-superadmin)"] = (row or {}).get("c", 0)
    # Leave a single trace of the reset itself (audit_log was just cleared).
    insert_audit(user, "RESET_DATA", "operational data", json.dumps(deleted))
    return {"ok": True, "deleted": deleted}

def insert_audit(user, action, target=None, detail=None):
    try:
        q("""INSERT INTO scheduling.audit_log
             (user_id,username,role,branch,action,target,detail)
             VALUES (%s,%s,%s,%s,%s,%s,%s)""",
          (user.get("id"), user.get("username"), user.get("role"),
           user.get("branch_name"), action, target, detail), exec_only=True)
    except Exception: pass

# ── Nest Config ───────────────────────────────────────────────────────────────

@app.get("/api/nest-config")
def list_nest_configs(user=Depends(require_superadmin)):
    rows = q("""SELECT id,nest_key,section_name,staff,staff_db_names,
                       allowed_shifts,coverage,exact_coverage,sort_order,updated_at
                FROM scheduling.nest_sections ORDER BY nest_key,sort_order,section_name""")
    # Shift types are global now; hide per-section allowed_shifts noise.
    for r in rows:
        r.pop("allowed_shifts", None)
    grouped = {}
    for row in rows:
        grouped.setdefault(row["nest_key"], []).append(row)
    return {"nests": grouped}

@app.get("/api/nest-config/{nest_key}")
def get_nest_config(nest_key: str, user=Depends(require_superadmin)):
    return {"sections": get_nest_sections(nest_key.upper())}

@app.put("/api/nest-config/{nest_key}/{section_name}")
async def upsert_nest_section(nest_key: str, section_name: str,
                               request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    nest_key = nest_key.upper()
    staff          = body.get("staff", [])
    staff_db_names = body.get("staff_db_names", {})
    coverage       = body.get("coverage", {})
    exact_coverage = body.get("exact_coverage", {})
    sort_order     = body.get("sort_order", 0)

    if not isinstance(staff, list): raise HTTPException(400, "staff must be array")

    row = q("""INSERT INTO scheduling.nest_sections
               (nest_key,section_name,staff,staff_db_names,allowed_shifts,
                coverage,exact_coverage,sort_order,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,NOW())
               ON CONFLICT (nest_key,section_name) DO UPDATE SET
               staff=%s,staff_db_names=%s,allowed_shifts=%s,
               coverage=%s,exact_coverage=%s,sort_order=%s,updated_at=NOW()
               RETURNING *""",
            # allowed_shifts no longer used; store empty list
            (nest_key, section_name, staff, json.dumps(staff_db_names), [],
             json.dumps(coverage), json.dumps(exact_coverage), sort_order,
             # DO UPDATE
             staff, json.dumps(staff_db_names), [],
             json.dumps(coverage), json.dumps(exact_coverage), sort_order),
            one=True)
    insert_audit(user, "UPDATE_NEST_CONFIG", f"{nest_key}/{section_name}",
                 f"staff={len(staff)}")
    row.pop("allowed_shifts", None)
    return {"section": row}

@app.delete("/api/nest-config/{nsid}")
def delete_nest_section(nsid: int, user=Depends(require_superadmin)):
    q("DELETE FROM scheduling.nest_sections WHERE id=%s", (nsid,), exec_only=True)
    insert_audit(user, "DELETE_NEST_SECTION", str(nsid))
    return {"ok": True}

# ── Generate ──────────────────────────────────────────────────────────────────

@app.get("/api/generate/allowed-shifts")
def allowed_shifts(request: Request, user=Depends(require_admin)):
    branch_id = request.query_params.get("branch_id")
    if not branch_id: raise HTTPException(400, "branch_id required")
    if not can_access_branch(user, branch_id):
        raise HTTPException(403, "You can only view your own branch")
    branch = q("SELECT id,name FROM scheduling.branches WHERE id=%s", (branch_id,), one=True)
    nest_name = branch_to_nest(branch["name"]) if branch else None
    if not nest_name: return {"sections": {}, "staff_allowed": {}}

    sections = get_nest_sections(nest_name)
    result = {s["section_name"]: {"allowed_shifts": s["allowed_shifts"],
                                   "staff_db_names": s["staff_db_names"]} for s in sections}

    db_name_to_sec = {}
    sec_allowed    = {}
    for sec_name, sec_data in result.items():
        sec_allowed[sec_name] = sec_data["allowed_shifts"]
        for db_name in sec_data["staff_db_names"].values():
            db_name_to_sec[db_name.lower().strip()] = sec_name

    staff_list = q("""SELECT s.* FROM scheduling.staff s WHERE s.branch_id=%s""", (branch_id,))
    staff_allowed = {}
    for s in staff_list:
        sec = db_name_to_sec.get(s["name"].lower().strip())
        if sec:
            staff_allowed[s["id"]] = sec_allowed.get(sec, [])

    return {"nest": nest_name, "sections": result, "staff_allowed": staff_allowed}


@app.post("/api/generate")
async def generate_schedule(request: Request, user=Depends(require_editor)):
    body = await request.json()
    branch_id = body.get("branch_id")
    year      = body.get("year")
    month     = body.get("month")
    # Optional: generate just ONE section (e.g. "General" or "US") and leave the
    # other section's rota untouched. Empty/absent = generate every section.
    only_section = (body.get("section") or "").strip()

    def _section_requested(name):
        if not only_section:
            return True
        a, b = only_section.upper(), str(name).upper()
        if a == b:
            return True
        # Treat US / Ultrasound as the same section.
        us = {"US", "ULTRASOUND"}
        return a in us and b in us

    if not can_access_branch(user, branch_id):
        raise HTTPException(403, "Forbidden")

    # Protect schedules that are submitted/approved (locked): regenerating would
    # wipe work that's under review. The team lead must withdraw first.
    locked_row = q("""SELECT is_locked, status FROM scheduling.schedules
                      WHERE branch_id=%s AND year=%s AND month=%s""",
                   (branch_id, year, month), one=True)
    if locked_row and locked_row.get("is_locked"):
        # Tailor the remedy to *why* it's locked. A schedule can be locked either
        # because it's in the review pipeline (status submitted/reviewed/approved)
        # or because someone hit the manual 🔒 toggle while it was still a draft.
        # Telling a draft user to "Withdraw" is misleading — there's no Withdraw
        # button in that state; they need to Unlock instead.
        st = (locked_row.get("status") or "draft")
        if st == "submitted":
            raise HTTPException(403, "Schedule is locked (submitted for review). Withdraw it first to regenerate.")
        if st in ("reviewed", "approved"):
            raise HTTPException(403, "The manager has reviewed/approved this schedule. Ask the manager to return it before regenerating.")
        raise HTTPException(403, "Schedule is locked. Unlock it (the 🔒 toggle) before regenerating.")

    # Nudge: if leave requests for this month are still pending, the generator
    # won't account for them (it only honours approved leave). Warn once, but
    # let the user proceed if they confirm.
    pend = q("""SELECT COUNT(*) AS n FROM scheduling.leave_requests l
                JOIN scheduling.staff s ON s.id=l.staff_id
                WHERE s.branch_id=%s AND l.status='pending'
                  AND EXTRACT(YEAR FROM l.date)=%s AND EXTRACT(MONTH FROM l.date)=%s""",
             (branch_id, year, month), one=True)
    if pend and pend["n"] and not body.get("confirm"):
        raise HTTPException(409, {
            "error": f"There are {pend['n']} pending leave request(s) for this month that the "
                     f"generator won't include. Approve or decline them first, or generate anyway.",
            "confirm_required": "pending_leaves",
        })

    # Heavy solver import only after the cheap guards have passed.
    import sys as _sys
    _sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scheduler'))
    from generator import generate_schedule as solver_generate, NESTS as _NESTS_DEFAULT

    # "Fresh generate" escape hatch: ignore the pinned hand-edited (manual) cells
    # so a stale/conflicting manual edit can't make the section infeasible. The
    # solver then rebuilds those cells too.
    ignore_manual = bool(body.get("ignore_manual"))

    # Load data
    prev_month = 12 if month == 1 else month - 1
    prev_year  = year - 1 if month == 1 else year

    staff_list = q("""SELECT s.*,b.name AS branch_name FROM scheduling.staff s
                      LEFT JOIN scheduling.branches b ON b.id=s.branch_id
                      WHERE s.branch_id=%s""", (branch_id,))
    leaves     = q("""SELECT l.id,l.staff_id,TO_CHAR(l.date,'YYYY-MM-DD') AS date,
                              l.leave_type FROM scheduling.leave_requests l
                       JOIN scheduling.staff s ON s.id=l.staff_id
                       WHERE s.branch_id=%s
                         AND l.status='approved'
                         AND EXTRACT(YEAR FROM l.date)=%s
                         AND EXTRACT(MONTH FROM l.date)=%s""", (branch_id, year, month))
    branch     = q("SELECT id,name,city,shares_staff FROM scheduling.branches WHERE id=%s", (branch_id,), one=True)
    prev_tail  = q("""SELECT e.staff_id,TO_CHAR(e.date,'YYYY-MM-DD') AS date,
                              e.shift_code,s.name AS staff_name
                       FROM scheduling.schedule_entries e
                       JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                       JOIN scheduling.staff s ON s.id=e.staff_id
                       WHERE sc.branch_id=%s AND sc.year=%s AND sc.month=%s
                         AND e.date >= (DATE_TRUNC('month',MAKE_DATE(%s,%s,1))
                             + INTERVAL '1 month' - INTERVAL '3 days')
                       ORDER BY s.name,e.date""",
                   (branch_id, prev_year, prev_month, prev_year, prev_month))

    active_staff = [s for s in staff_list if s.get("active")]
    if not active_staff:
        raise HTTPException(400, "No active staff for this branch")
    # Optional: build the rota on a CHOSEN subset only. Staff not selected are left
    # OFF for the whole month (kept on the grid, just not assigned any shift).
    excluded_ids = set()
    for x in (body.get("exclude_staff_ids") or []):
        try: excluded_ids.add(int(x))
        except (TypeError, ValueError): pass
    excluded_staff = [s for s in active_staff if int(s["id"]) in excluded_ids]
    if excluded_ids:
        active_staff = [s for s in active_staff if int(s["id"]) not in excluded_ids]
        if not active_staff:
            raise HTTPException(400, "Select at least one staff member to include in the schedule")

    nest_name = branch_to_nest(branch["name"]) if branch else None
    # New branches whose names don't match a known nest still need to generate.
    # Fall back to a synthetic per-branch nest key so they get a default section.
    if not nest_name:
        nest_name = f"BRANCH_{branch_id}"

    # Branch-level solver defaults (used as fallbacks)
    bs = q("""SELECT max_consecutive, min_shifts_default
              FROM scheduling.branch_settings WHERE branch_id=%s""",
           (branch_id,), one=True) or {}
    branch_max_consecutive = int(bs.get("max_consecutive", 4) or 4)
    branch_min_shifts_default = int(bs.get("min_shifts_default", 17) or 17)

    # Load section definitions from DB
    nest_sections = get_nest_sections(nest_name, year=year, month=month)

    # If this branch/nest has no sections defined yet (e.g. a freshly added
    # branch), synthesise a default "General" section so the solver can run.
    # M and N each need at least 1 person per day for 24h coverage.
    if not nest_sections:
        nest_sections = [{
            "id": None,
            "nest_key": nest_name,
            "section_name": "General",
            "staff": [],
            "staff_db_names": [],
            "allowed_shifts": None,
            "coverage": None,
            "exact_coverage": None,
            "sort_order": 0,
            "updated_at": None,
            "min_m": 1, "max_m": 2,
            "min_n": 1, "max_n": 2,
            "max_consecutive": branch_max_consecutive,
            "min_o_block": 2,
        }]
        # Attach the global shift codes like get_nest_sections does
        global_codes = [r["code"] for r in q("""SELECT code FROM scheduling.shift_types
                                                 WHERE branch_id IS NULL
                                                 ORDER BY sort_order, code""")]
        if not global_codes:
            global_codes = ["M","N","O","AL","SL","OC","TB","D","D1","EV","A","B","C","N6","Y3","D_US","R","R1"]
        for r in nest_sections:
            r["allowed_shifts"] = global_codes

    import calendar as _cal
    n_days_in_month = _cal.monthrange(year, month)[1]

    # Build stable solver keys from staff_id (so we don't depend on names or nest config)
    staff_by_id = {int(s["id"]): s for s in active_staff}
    solver_key_by_staff_id = {sid: f"S{sid}" for sid in staff_by_id.keys()}
    staff_id_by_solver_key = {sk: sid for sid, sk in solver_key_by_staff_id.items()}

    # AL args
    al_schedule = {}
    for lv in leaves:
        sid = int(lv["staff_id"])
        sk = solver_key_by_staff_id.get(sid)
        if not sk:
            continue
        day = int(lv["date"].split("-")[2])
        al_schedule.setdefault(sk, []).append(day)
    for sk in list(al_schedule.keys()):
        al_schedule[sk] = sorted(set(al_schedule[sk]))

    # Staff shift preferences for this month: 'unavailable' → forced Off (hard),
    # 'off' → preferred Off (soft). The team lead can drop them with ignore_prefs.
    unavailable_by_solver = {}
    pref_off_by_solver = {}
    if not bool(body.get("ignore_prefs")):
        pref_rows = q("""SELECT staff_id, day, kind FROM scheduling.shift_preferences
                         WHERE year=%s AND month=%s AND staff_id = ANY(%s)""",
                      (year, month, list(staff_by_id.keys())))
        for pr in pref_rows:
            sk = solver_key_by_staff_id.get(int(pr["staff_id"]))
            if not sk:
                continue
            if pr["kind"] == "unavailable":
                unavailable_by_solver.setdefault(sk, []).append(int(pr["day"]))
            elif pr["kind"] == "off":
                pref_off_by_solver.setdefault(sk, []).append(int(pr["day"]))

    # "Fill blanks only": keep the manager's hand-entered cells and let the solver
    # build the rest of the month around them. We pin every existing non-blank
    # cell (work shifts and explicit O), except leave codes — those are already
    # forced via al_schedule.
    fixed_by_solver = {}
    # Always pin hand-entered (manual) cells so a regenerate keeps them — the
    # solver builds the rest of the month around them, and they're never deleted
    # or overwritten when persisting (see manual_cells below).
    manual_cells = set()
    manual_rows = [] if ignore_manual else q(
                    """SELECT e.staff_id, TO_CHAR(e.date,'YYYY-MM-DD') AS date, e.shift_code
                       FROM scheduling.schedule_entries e
                       JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                       WHERE sc.branch_id=%s AND sc.year=%s AND sc.month=%s
                         AND COALESCE(e.is_manual,false)=true""",
                    (branch_id, year, month))
    for e in manual_rows:
        sid = int(e["staff_id"])
        sk = solver_key_by_staff_id.get(sid)
        day = int(e["date"][8:10])
        code = e["shift_code"]
        # If approved leave now covers this day, the leave wins: don't pin OR
        # protect the stale manual cell (otherwise pinning a work shift on a forced
        # AL day makes the section infeasible). Let the solver's AL overwrite it.
        if sk and day in al_schedule.get(sk, []):
            continue
        manual_cells.add((sid, e["date"]))
        # Leave codes are already forced via al_schedule; pin the rest for the solver.
        if code and code not in ("AL", "SL", "TB") and sk:
            fixed_by_solver.setdefault(sk, {})[day] = code
    if body.get("preserve_existing"):
        existing = q("""SELECT e.staff_id, TO_CHAR(e.date,'YYYY-MM-DD') AS date, e.shift_code
                        FROM scheduling.schedule_entries e
                        JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                        WHERE sc.branch_id=%s AND sc.year=%s AND sc.month=%s""",
                     (branch_id, year, month))
        for e in existing:
            code = e["shift_code"]
            if not code or code in ("AL", "SL", "TB"):
                continue
            sk = solver_key_by_staff_id.get(int(e["staff_id"]))
            if not sk:
                continue
            fixed_by_solver.setdefault(sk, {})[int(e["date"][8:10])] = code

    # Build nest config dict for solver (after al_schedule is populated)
    nest_cfg_for_solver = {"sections": {}}
    section_limits_for_solver = {}
    # Build section → staff mapping from Staff.page "Section" (stored as speciality[0])
    # This replaces the old nest-config staff lists.
    staff_ids_by_section = {}
    section_names = [sec["section_name"] for sec in nest_sections]
    # If the branch only has the single default section (no US split configured),
    # every active staff member belongs to it — don't drop US staff.
    single_default_section = (len(nest_sections) == 1 and nest_sections[0].get("id") is None)
    def _normalize_section(specs):
        vals = [str(x or "").strip().upper() for x in (specs or [])]
        if "US" in vals or "ULTRASOUND" in vals:
            return "US"
        return "General"
    for s in active_staff:
        if single_default_section:
            sec = section_names[0]
        else:
            sec = _normalize_section(s.get("speciality"))
            if sec not in section_names:
                continue
        staff_ids_by_section.setdefault(sec, []).append(int(s["id"]))

    for sec in nest_sections:
        min_m = int(sec.get("min_m", 1) or 1)
        max_m = int(sec.get("max_m", 2) or 2)
        min_n = int(sec.get("min_n", 1) or 1)
        max_n = int(sec.get("max_n", 2) or 2)
        sec_max_consecutive = int(sec.get("max_consecutive", branch_max_consecutive) or branch_max_consecutive)
        sec_min_o_block = int(sec.get("min_o_block", 2) or 2)
        sec_max_o_block = int(sec.get("max_o_block", 0) or 0)
        if min_m > max_m:
            min_m = max_m
        if min_n > max_n:
            min_n = max_n
        sec_staff_ids = staff_ids_by_section.get(sec["section_name"], [])
        sec_solver_keys = [solver_key_by_staff_id[sid] for sid in sec_staff_ids if sid in solver_key_by_staff_id]
        nest_cfg_for_solver["sections"][sec["section_name"]] = {
            "staff":          sec_solver_keys,
            "allowed_shifts": sec["allowed_shifts"],
            # App goal: auto-generate M/N only. Daily M/N requirements come from
            # per-month section settings (min_m/max_m/min_n/max_n), not the nest
            # config coverage/exact JSON.
            "coverage":       {},
            "exact":          {},
            "min_m":          min_m,
            "max_m":          max_m,
            "min_n":          min_n,
            "max_n":          max_n,
            "min_o_block":    sec_min_o_block,
            "max_o_block":    sec_max_o_block,
        }
        section_limits_for_solver[sec["section_name"]] = {"max_consecutive": sec_max_consecutive}
        print(f"[Generate] section={sec['section_name']} min_m={min_m} max_m={max_m} min_n={min_n} max_n={max_n} max_consecutive={sec_max_consecutive} min_o_block={sec_min_o_block} max_o_block={sec_max_o_block}")

    # Cross-branch awareness: if this branch lends staff to a same-city target
    # (e.g. Y3), reserve its fair share by raising General morning coverage so the
    # surplus is guaranteed (not opportunistic). General only — never Ultrasound.
    export_share = _cross_cover_export_share(branch_id, (branch or {}).get("city"),
                                             (branch or {}).get("shares_staff"), year, month)
    if export_share > 0 and "General" in nest_cfg_for_solver["sections"]:
        g = nest_cfg_for_solver["sections"]["General"]
        g["min_m"] += export_share
        if g["max_m"] < g["min_m"]:
            g["max_m"] = g["min_m"]
        print(f"[Generate] cross-branch export: reserving +{export_share} General M/day → min_m={g['min_m']} max_m={g['max_m']}")

    # Prev tail
    prev_tail_by_solver = {}
    for row in prev_tail:
        sid = int(row["staff_id"])
        solver_key = solver_key_by_staff_id.get(sid)
        if not solver_key:
            continue
        prev_tail_by_solver.setdefault(solver_key, []).append(row["shift_code"])
    print(f"[Generate] prev-month tail loaded for {len(prev_tail_by_solver)} staff "
          f"(if 0, the previous month has no saved rota → no cross-month rest rules); "
          f"manual cells pinned: {len(manual_cells)}")

    # Load per-month settings per staff (min/max used as constraints; max_shifts acts as ceiling)
    month_settings_rows = q("""
        SELECT s.id, s.name,
               COALESCE(sms.min_shifts, s.min_shifts, 0)  AS min_shifts,
               COALESCE(sms.max_consecutive, %s)  AS max_consecutive,
               COALESCE(sms.max_shifts, s.max_shifts, 17) AS max_shifts,
               COALESCE(s.phase, 0) AS phase
        FROM scheduling.staff s
        LEFT JOIN scheduling.staff_month_settings sms
          ON sms.staff_id=s.id AND sms.year=%s AND sms.month=%s
        WHERE s.branch_id=%s AND s.active=true
    """, (branch_max_consecutive, year, month, branch_id))
    month_settings = {int(r["id"]): r for r in month_settings_rows}

    # Auto-calculate fair min/max shifts per staff based on section capacity.
    # The DB max_shifts (per-staff or per-month override) acts as the hard ceiling —
    # auto-calc will never exceed it.
    import math as _math_staff
    sk_to_mn = {}
    for sec in nest_sections:
        mn = nest_cfg_for_solver["sections"].get(sec["section_name"], {})
        slots_per_day = mn.get("min_m", 1) + mn.get("min_n", 1)
        max_slots_per_day = mn.get("max_m", 2) + mn.get("max_n", 2)
        staff_keys = mn.get("staff") or []
        staff_count   = len(staff_keys)
        for sk in staff_keys:
            sk_to_mn[sk] = {"slots_per_day": slots_per_day,
                            "max_slots_per_day": max_slots_per_day,
                            "staff_count": staff_count}

    def calc_staff_limits(solver_key, max_consec, db_min_shifts, db_max_shifts):
        # ── Hours-based target ────────────────────────────────────────────────
        # Saudi labour: 48 working hours/week. Monthly target hours scale with
        # the number of days in the month:
        #     target_hours = (n_days / 7) * 48
        # Each annual-leave (AL) day is counted as a normal 8-hour working day,
        # so it consumes 8 hours from the target. The remaining hours are then
        # converted to 12-hour M/N shifts:
        #     shifts = round((target_hours - leave_days * 8) / 12)
        #
        # Example (Wafa, 30-day month, 10 AL days):
        #     target  = (30/7)*48 = 205.7h
        #     remain  = 205.7 - 80 = 125.7h
        #     shifts  = round(125.7 / 12) = 10
        WEEKLY_HOURS   = 48
        LEAVE_DAY_HRS  = 8     # an AL/leave day = one normal 8-hour working day
        SHIFT_HOURS    = 12    # M and N are 12-hour shifts

        al_days_set = set(al_schedule.get(solver_key, []))
        leave_days  = len(al_days_set)
        available   = max(0, n_days_in_month - leave_days)

        target_hours    = (n_days_in_month / 7.0) * WEEKLY_HOURS
        remaining_hours = max(0.0, target_hours - leave_days * LEAVE_DAY_HRS)
        target_shifts   = round(remaining_hours / SHIFT_HOURS)

        # ── Physical feasibility cap (k-on / 2-off rest rule) ─────────────────
        # The most work days achievable, given AL gaps and the "k on, 2 off" rule.
        def _block_max_work(L: int, k: int) -> int:
            if L <= 0:
                return 0
            if not k or k <= 0:
                return L
            full = L // (k + 2)
            rem  = L %  (k + 2)
            return full * k + min(k, rem)

        max_work_feasible = 0
        if max_consec and max_consec > 0:
            block_len = 0
            for day in range(1, n_days_in_month + 1):
                if day in al_days_set:
                    if block_len:
                        max_work_feasible += _block_max_work(block_len, max_consec)
                        block_len = 0
                else:
                    block_len += 1
            if block_len:
                max_work_feasible += _block_max_work(block_len, max_consec)
        else:
            max_work_feasible = available

        # ── Apply ceilings ────────────────────────────────────────────────────
        # The configured per-staff/per-month max_shifts is a hard ceiling, and
        # the schedule can never demand more than what's physically feasible.
        ceiling = min(int(db_max_shifts), int(max_work_feasible))

        # Target (from hours) is what we aim for, but never above the ceiling.
        eff_target = min(target_shifts, ceiling)

        # Leave-adjust the per-staff MIN floor. A configured min (e.g. 17) is a
        # FULL-month figure; if it isn't scaled down for leave, max(min, target)
        # drags a person who took leave back UP to the physical maximum — e.g.
        # 10 AL days but still forced to ~15 shifts instead of ~12. Scale the
        # floor by availability so leave actually lightens the month.
        floor = int(db_min_shifts or 0)
        if leave_days > 0 and n_days_in_month > 0:
            floor = round(floor * available / n_days_in_month)

        # If an explicit DB min is set, honour it but keep it within the ceiling.
        eff_min = min(max(floor, eff_target), ceiling)
        eff_min = max(0, eff_min)

        # Section-capacity cap: a small section only offers so many slots a month
        # (n_days × (max_m+max_n)) shared among its staff. If we force each person
        # to a full-month target (~17) but the section can only give ~12 each, the
        # floors sum past the available slots and the section is INFEASIBLE. Cap the
        # forced minimum at the section's per-person share so generation succeeds
        # (people simply work fewer shifts in a thin section).
        _mn = sk_to_mn.get(solver_key) or {}
        _sc = int(_mn.get("staff_count") or 0)
        _maxslots = int(_mn.get("max_slots_per_day") or 0)
        if _sc > 0 and _maxslots > 0:
            section_share = (n_days_in_month * _maxslots) // _sc
            if section_share >= 1:
                eff_min = min(eff_min, section_share)

        # Give the solver a small upward tolerance (+1) so it can balance fairness
        # and coverage, but never exceed the ceiling. NOT for someone who took
        # leave: their month should actually be lighter, so cap them at the
        # leave-adjusted target instead of letting coverage creep them back up
        # (e.g. 3 AL days → exactly 16 shifts, not 17).
        upward = 0 if leave_days > 0 else 1
        eff_max = min(ceiling, max(eff_min, eff_target + upward))

        return {
            "min_shifts": eff_min,
            "max_shifts": eff_max,
            "max_consecutive": max_consec,
            "target_shifts": target_shifts,
        }

    # Build per-solver-key limits
    staff_limits = {}
    for sid, sk in solver_key_by_staff_id.items():
        ms = month_settings.get(int(sid))
        max_consec    = int(ms.get("max_consecutive", branch_max_consecutive)) if ms else branch_max_consecutive
        db_min_shifts = int(ms.get("min_shifts", 0))                           if ms else 0
        db_max_shifts = int(ms.get("max_shifts", 17))                          if ms else 17
        staff_limits[sk] = calc_staff_limits(sk, max_consec, db_min_shifts, db_max_shifts)
        print(f"[Generate] staff_limit {sk}: leaves={len(al_schedule.get(sk,[]))} db_max={db_max_shifts} target_shifts={staff_limits[sk].get('target_shifts')} → min={staff_limits[sk]['min_shifts']} max={staff_limits[sk]['max_shifts']} max_consec={staff_limits[sk]['max_consecutive']}")

    # Branch-level fallback for max_consecutive. Per-staff values live in
    # staff_limits and per-section values in section_limits; the solver reads
    # those directly. This is only the default when neither is set.
    max_consecutive = branch_max_consecutive

    # Config is passed per-section to the solver (nest_cfg=...), so there's no
    # need to mutate the shared generator.NESTS global anymore.
    print(f"[Generate] nest={nest_name} year={year} month={month}")
    print(f"[Generate] active_staff ({len(active_staff)}): {[s['name'] for s in active_staff]}")
    print(f"[Generate] al_schedule: {al_schedule}")
    print(f"[Generate] max_consecutive={max_consecutive}")
    print(f"[Generate] staff_limits={staff_limits}")
    for sn, sc in nest_cfg_for_solver["sections"].items():
        print(f"[Generate] SECTION '{sn}': staff={sc['staff']} | exact={sc['exact']} | coverage={sc['coverage']} | min_m={sc['min_m']} max_m={sc['max_m']} min_n={sc['min_n']} max_n={sc['max_n']} | allowed={sc['allowed_shifts']}")

    # (Generation happens per-section further below.)

    print(f"[Generate] solver_key_to_staff_id={staff_id_by_solver_key}")

    import calendar as _calendar
    days_in_month = _calendar.monthrange(year, month)[1]
    from datetime import date as _date

    def section_diagnostics(section_name: str, sec_cfg: dict, staff_keys: list[str]) -> dict:
        """Best-effort explanation when a section is infeasible."""
        import calendar as _cal2
        import math as _m2
        n_days = _cal2.monthrange(year, month)[1]
        min_m = int(sec_cfg.get("min_m", 1) or 1)
        max_m = int(sec_cfg.get("max_m", 2) or 2)
        min_n = int(sec_cfg.get("min_n", 1) or 1)
        max_n = int(sec_cfg.get("max_n", 2) or 2)
        k = int(sec_cfg.get("max_consecutive", 4) or 4)
        max_slots_per_day = max_m + max_n
        cap_month = n_days * max_slots_per_day
        required_month = sum(int(staff_limits.get(sk, {}).get("min_shifts", 0) or 0) for sk in staff_keys)

        # Daily availability check (AL only)
        daily_shortages = []
        for day in range(1, n_days + 1):
            avail = sum(1 for sk in staff_keys if day not in set(al_schedule.get(sk, [])))
            need = min_m + min_n
            if avail < need:
                daily_shortages.append({"day": day, "available_staff": avail, "required_staff": need})

        msgs = []
        # The precise, common cause: the daily MINIMUM coverage over the month needs
        # more shifts than the whole team can physically work — no arrangement can
        # cover it. e.g. General Min M=2,Min N=1 over 31 days = 93 shifts, but 5 staff
        # at 17 each supply only 85.
        total_max_capacity = sum(int(staff_limits.get(sk, {}).get("max_shifts", 0) or 0) for sk in staff_keys)
        min_coverage_demand = n_days * (min_m + min_n)
        if total_max_capacity and min_coverage_demand > total_max_capacity:
            short = min_coverage_demand - total_max_capacity
            msgs.append(
                f"This section needs at least {min_coverage_demand} shifts/month "
                f"({min_m}×Morning + {min_n}×Night × {n_days} days) but its {len(staff_keys)} "
                f"staff can work at most {total_max_capacity} together — short by {short}. "
                f"Add a staff member, or lower Min M / Min N.")
        if required_month > cap_month:
            msgs.append(f"Monthly minimum demand ({required_month}) exceeds capacity ({cap_month}) given max M/N per day.")
        if daily_shortages:
            msgs.append(f"Some days have fewer available staff than required coverage (min M+N).")
        # 4-on/2-off feasibility heuristic: each staff works at most k/(k+2) of days long-run.
        # Staff needed per day ≈ ceil(need / (k/(k+2))) = ceil(need * (k+2)/k)
        min_o_blk = int(sec_cfg.get("min_o_block", 2) or 2)
        # How many staff are actually free to work most of the month?
        avail_staff = sum(1 for sk in staff_keys if len(al_schedule.get(sk, [])) < n_days / 2)
        if k > 0:
            need_per_day = min_m + min_n
            min_staff_for_coverage = int(_m2.ceil(need_per_day * (k + 2) / k))
            if len(staff_keys) < min_staff_for_coverage:
                msgs.append(
                    f"Not enough staff for daily coverage under the {k}-on/2-off rule: need ~{min_staff_for_coverage} active staff, have {len(staff_keys)}."
                )
        # The classic "few people, heavy daily coverage" case: a tiny available
        # team can hit the daily requirement only if off-days may be single
        # (Min Off Block = 1). With 2-day off blocks required it's impossible.
        # Phrase it per the section's ACTUAL need — General runs nights (24h),
        # Ultrasound is often daytime only (min_n = 0).
        if avail_staff <= 3 and (min_m + min_n) >= 2 and min_o_blk >= 2:
            need_txt = (f"{min_m}×M + {min_n}×N (24h)" if min_n >= 1
                        else f"{min_m}×M every day")
            rotate_txt = ("rotate Morning→Night→Off and cover 24h" if min_n >= 1
                          else "rotate through the mornings without idle 2-day gaps")
            msgs.append(
                f"Only {avail_staff} staff are free this month but the section needs "
                f"{need_txt}. Set this section's Min Off Block to 1 (allow single "
                f"off-days) so the {avail_staff} can {rotate_txt}."
            )

        return {
            "section": section_name,
            "staff_count": len(staff_keys),
            "min_m": min_m, "max_m": max_m, "min_n": min_n, "max_n": max_n,
            "max_consecutive": k,
            "required_month_min_shifts": required_month,
            "capacity_month_max_mn": cap_month,
            "min_coverage_demand": min_coverage_demand,
            "total_max_capacity": total_max_capacity,
            "daily_shortages": daily_shortages[:10],
            "messages": msgs,
        }

    # If a specific section was asked for, make sure it actually exists for this
    # branch — otherwise we'd silently generate nothing and look like a failure.
    if only_section and not any(_section_requested(s) for s in nest_cfg_for_solver["sections"]):
        raise HTTPException(400, f"Section '{only_section}' not found for this branch")

    def probe_relaxations(sec_name, sec_cfg, sec_al, sec_prev_tail, sec_staff_limits, sec_fixed=None, sec_unavail=None):
        """When a section is infeasible, find WHICH setting is to blame by
        re-solving with one setting relaxed at a time (short time limit). Each
        relaxation that turns the section solvable is reported back as a concrete
        'change this setting' fix, so the user isn't left guessing."""
        sec_cur_k = int((section_limits_for_solver.get(sec_name) or {}).get("max_consecutive", 4) or 4)
        cur_min_o = int(sec_cfg.get("min_o_block", 2) or 2)
        cur_min_n = int(sec_cfg.get("min_n", 1) or 0)
        cur_min_m = int(sec_cfg.get("min_m", 1) or 0)
        cur_max_o = int(sec_cfg.get("max_o_block", 0) or 0)
        # (label, human change, section-cfg overrides, new max_consecutive or None)
        candidates = []
        if cur_min_o >= 2:
            candidates.append(("Min Off Block", f"{cur_min_o} → 1", {"min_o_block": 1}, None))
        if cur_max_o >= 1:
            candidates.append(("Max Off Block", f"{cur_max_o} → 0 (off)", {"max_o_block": 0}, None))
        if cur_min_n >= 1:
            candidates.append(("Min N (nights per day)", f"{cur_min_n} → 0", {"min_n": 0}, None))
        if cur_min_m >= 1:
            candidates.append(("Min M (mornings per day)", f"{cur_min_m} → 0", {"min_m": 0}, None))
        candidates.append(("Max Consecutive", f"{sec_cur_k} → {sec_cur_k + 2}", None, sec_cur_k + 2))

        fixes = []
        for label, change, sec_over, new_k in candidates:
            sec2 = dict(sec_cfg)
            if sec_over:
                sec2.update(sec_over)
            seclim2 = {sec_name: dict(section_limits_for_solver.get(sec_name) or {})}
            if new_k:
                seclim2[sec_name]["max_consecutive"] = new_k
            try:
                res = solver_generate(
                    nest_name=nest_name, year=year, month=month,
                    al_schedule=sec_al, prev_tail=sec_prev_tail, time_limit=15,
                    max_consecutive=(new_k or max_consecutive),
                    staff_limits=sec_staff_limits,
                    section_limits=seclim2,
                    nest_cfg={"sections": {sec_name: sec2}},
                    fixed_schedule=sec_fixed,
                    unavailable=sec_unavail,
                )
            except Exception:
                continue
            if res.get("status") in ("OPTIMAL", "FEASIBLE") and res.get("schedule"):
                fixes.append({"setting": label, "change": change})

        # Beyond UI settings — isolate a NON-setting blocker by dropping one input
        # at a time: the cross-month rest carry-over, the pinned manual cells, and
        # the per-staff minimum. Whichever one unlocks it points at the real cause
        # (a conflicting last-month tail, a stale manual edit, or a too-high floor).
        floor0 = {k: {**(v or {}), "min_shifts": 0} for k, v in (sec_staff_limits or {}).items()}
        extras = [
            ("Previous-month rest carry-over", "regenerate last month or ignore its tail", dict(prev_tail={})),
            ("Locked manual cells", "clear the pinned hand-edited cells for this month", dict(fixed={})),
            ("Per-staff minimum shifts", "the forced ~full-month minimum is too tight — lower it", dict(staff=floor0)),
        ]
        if sec_unavail:
            extras.append(("Staff unavailable days", "too many staff marked the same days off — regenerate ignoring preferences", dict(unavail={})))
        for label, change, ov in extras:
            try:
                res = solver_generate(
                    nest_name=nest_name, year=year, month=month,
                    al_schedule=sec_al,
                    prev_tail=ov.get("prev_tail", sec_prev_tail),
                    time_limit=15, max_consecutive=max_consecutive,
                    staff_limits=ov.get("staff", sec_staff_limits),
                    section_limits={sec_name: dict(section_limits_for_solver.get(sec_name) or {})},
                    nest_cfg={"sections": {sec_name: dict(sec_cfg)}},
                    fixed_schedule=ov.get("fixed", sec_fixed),
                    unavailable=ov.get("unavail", sec_unavail),
                )
            except Exception:
                continue
            if res.get("status") in ("OPTIMAL", "FEASIBLE") and res.get("schedule"):
                fixes.append({"setting": label, "change": change})
        return fixes

    flat_entries = []
    summary      = []
    total_work   = 0
    section_results = {}

    # Generate per section independently so one failing section doesn't block others.
    for sec_name, sec_cfg in nest_cfg_for_solver["sections"].items():
        # When a single section was requested, skip the others entirely — their
        # existing rota is left exactly as-is (we never touch their staff below).
        if not _section_requested(sec_name):
            continue
        staff_keys = list(sec_cfg.get("staff") or [])
        if not staff_keys:
            section_results[sec_name] = {"status": "SKIPPED", "error": "No staff in section"}
            continue

        # Note: AL validation is not enforced here.

        sec_al = {sk: al_schedule.get(sk, []) for sk in staff_keys if sk in al_schedule}
        sec_prev_tail = {sk: prev_tail_by_solver.get(sk, []) for sk in staff_keys if sk in prev_tail_by_solver}
        sec_staff_limits = {sk: staff_limits.get(sk, {}) for sk in staff_keys}
        sec_fixed = {sk: fixed_by_solver[sk] for sk in staff_keys if sk in fixed_by_solver}
        sec_unavail = {sk: unavailable_by_solver[sk] for sk in staff_keys if sk in unavailable_by_solver}
        sec_pref_off = {sk: pref_off_by_solver[sk] for sk in staff_keys if sk in pref_off_by_solver}
        sec_limits = {sec_name: section_limits_for_solver.get(sec_name, {})}

        # Pass this section's config straight to the solver (no global mutation).
        sec_nest_cfg = {"sections": {sec_name: sec_cfg}}
        sec_result = solver_generate(
            nest_name=nest_name, year=year, month=month,
            al_schedule=sec_al, prev_tail=sec_prev_tail,
            time_limit=120,
            max_consecutive=max_consecutive,
            staff_limits=sec_staff_limits,
            section_limits=sec_limits,
            nest_cfg=sec_nest_cfg,
            fixed_schedule=sec_fixed,
            unavailable=sec_unavail,
            pref_off=sec_pref_off,
        )

        if sec_result["status"] == "INFEASIBLE" or not sec_result.get("schedule"):
            diag = section_diagnostics(sec_name, sec_cfg, staff_keys)
            # Pinpoint the exact setting(s) at fault by trying them one at a time.
            try:
                diag["fixes"] = probe_relaxations(sec_name, sec_cfg, sec_al, sec_prev_tail, sec_staff_limits, sec_fixed, sec_unavail)
            except Exception as _pe:
                print(f"[Generate] relaxation probe failed for {sec_name}: {_pe}")
            section_results[sec_name] = {
                "status": sec_result.get("status"),
                "error": "Section infeasible",
                "diagnostics": diag,
            }
            continue

        section_results[sec_name] = {
            "status": sec_result["status"],
            "elapsed": sec_result.get("elapsed"),
            "staff": staff_keys,
        }

        # Safety net: run the validator on the solved section before saving.
        # The solver enforces the hard rules, so this should be clean — any
        # surfaced error means a regression. Guarded so it never blocks saving.
        try:
            from validator import validate_schedule as _validate
            vres = _validate(sec_result.get("schedule") or {}, nest_name, year, month,
                             al_schedule=sec_al, nest_cfg=sec_nest_cfg)
            if vres.get("errors"):
                section_results[sec_name]["validation_errors"] = vres["errors"][:10]
                print(f"[Generate] validator flagged {sec_name}: {vres['errors'][:3]}")
        except Exception as _ve:
            print(f"[Generate] validator skipped for {sec_name}: {_ve}")

        # Add entries from this section only
        for solver_key, row in (sec_result.get("schedule") or {}).items():
            sid = staff_id_by_solver_key.get(solver_key)
            staff = staff_by_id.get(int(sid)) if sid is not None else None
            if not staff:
                continue
            work_count = 0
            for i in range(days_in_month):
                d    = _date(year, month, i + 1)
                code = row[i] if i < len(row) else "O"
                if code not in ("O","AL","SL"):
                    work_count += 1
                flat_entries.append({
                    "staff_id": staff["id"],
                    "date":     str(d),
                    "shift_code": code,
                    "cross_branch_id": None,
                    "is_oncall": False,
                    "note": None,
                })
            total_work += work_count
            summary.append({"staff_id": staff["id"], "staff_name": staff["name"], "shifts": work_count})

    ok_sections = [k for k, v in section_results.items() if v.get("status") in ("OPTIMAL", "FEASIBLE")]
    if not ok_sections:
        raise HTTPException(422, detail={
            "error": "Could not generate a schedule for any section with the current settings.",
            "sections": section_results,
        })

    # Excluded staff: leave them OFF for the month (keep approved leave visible).
    if excluded_staff:
        leave_by_staff = {}
        for lv in leaves:
            leave_by_staff.setdefault(int(lv["staff_id"]), {})[lv["date"]] = lv["leave_type"]
        for s in excluded_staff:
            lvmap = leave_by_staff.get(int(s["id"]), {})
            for i in range(days_in_month):
                d = str(_date(year, month, i + 1))
                flat_entries.append({"staff_id": s["id"], "date": d,
                                     "shift_code": lvmap.get(d, "O"),
                                     "cross_branch_id": None, "is_oncall": False, "note": None})

    # Persist
    schedule = q("""INSERT INTO scheduling.schedules (branch_id,year,month,status,created_by)
                    VALUES (%s,%s,%s,'draft',%s)
                    ON CONFLICT (branch_id,year,month) DO UPDATE SET updated_at=NOW()
                    RETURNING *""",
                 (branch_id, year, month, user["id"]), one=True)

    # Persist atomically. Only refresh the staff we actually (re)generated — a
    # section that came back infeasible keeps its existing rota instead of being
    # wiped. Delete + insert happen in ONE transaction so a failure can't leave
    # the schedule half-empty.
    ok_staff_ids = sorted({e["staff_id"] for e in flat_entries})
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            # Serialize generations for THIS schedule: two managers hitting Generate at
            # once for the same branch/month would otherwise interleave delete/insert
            # and clobber each other. The lock is held to commit, so the second waits
            # and then writes cleanly on top rather than mid-transaction.
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (int(schedule["id"]),))
            if ok_staff_ids:
                # Keep manual cells (only solver-owned cells are cleared) — unless
                # this is a "fresh generate" that deliberately ignores manual edits.
                _keep_manual = "" if ignore_manual else "AND COALESCE(is_manual,false)=false"
                cur.execute(f"""DELETE FROM scheduling.schedule_entries
                                WHERE schedule_id=%s AND staff_id = ANY(%s) {_keep_manual}""",
                            (schedule["id"], ok_staff_ids))
            # Bulk upsert all generated cells in one round-trip instead of one
            # INSERT per cell (a 31-day month × N staff was hundreds of queries).
            # Manual cells are skipped — the solver pinned them, so the value
            # already matches and we must not clear their is_manual flag.
            rows = [(schedule["id"], e["staff_id"], e["date"], e["shift_code"],
                     e["cross_branch_id"], e["is_oncall"], e["note"])
                    for e in flat_entries if (e["staff_id"], e["date"]) not in manual_cells]
            if rows:
                psycopg2.extras.execute_values(cur, """
                    INSERT INTO scheduling.schedule_entries
                        (schedule_id,staff_id,date,shift_code,cross_branch_id,is_oncall,note)
                    VALUES %s
                    ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET
                        shift_code=EXCLUDED.shift_code,
                        cross_branch_id=EXCLUDED.cross_branch_id,
                        is_oncall=EXCLUDED.is_oncall,
                        note=EXCLUDED.note""", rows)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)

    insert_audit(user, "GENERATE_SCHEDULE",
                 f"{year}-{month:02d}",
                 f"{len(summary)} staff · nest={nest_name} · sections_ok={len(ok_sections)}/{len(section_results)}")

    avg = round(total_work / len(summary)) if summary else 0
    return {
        "schedule":      schedule,
        "entry_count":   len(flat_entries),
        "solver_status": "PARTIAL" if len(ok_sections) != len(section_results) else "OK",
        "sections":      section_results,
        "summary":       summary,
        "avg_shifts":    avg,
    }

# ── Catch-all: serve React/SPA frontend (must be LAST) ───────────────────────
@app.get("/")
@app.get("/{full_path:path}")
def serve_index(full_path: str = ""):
    # Stamp every asset URL (?v=…) with the per-deploy build id and serve the HTML
    # no-cache, so a new deploy always reaches the browser with fresh JS/CSS — no
    # hand-bumped versions, no "stuck on old cache".
    if _INDEX_HTML is not None:
        return HTMLResponse(_INDEX_HTML, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return FileResponse(os.path.join(DASHBOARD, "index.html"))
