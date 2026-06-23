"""
Meena Health Radiology — FastAPI server
Replaces Node.js/Express. Same DB, same dashboard, same API paths.

Run:
    python -m uvicorn server.main:app --port 3002 --reload
"""

import os, sys, json, math, re, uuid, calendar as _cal

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
from fastapi import FastAPI, Request, Response, HTTPException, Depends, Cookie
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

# ── Config ────────────────────────────────────────────────────────────────────

DATABASE_URL = os.environ.get("DATABASE_URL", "")
JWT_SECRET   = os.environ.get("JWT_SECRET", "scheduling_secret")
JWT_ALG      = "HS256"
JWT_DAYS     = 30
ADMIN_USER   = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASS   = os.environ.get("ADMIN_PASS", "admin123")

# ── DB connection pool ────────────────────────────────────────────────────────
# One pool per worker process — keeps 2 connections warm, up to 10 max.
# Eliminates the ~200ms SSL handshake cost on every request.

_pool: psycopg2.pool.ThreadedConnectionPool | None = None

def get_pool() -> psycopg2.pool.ThreadedConnectionPool:
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=2, maxconn=10,
            dsn=DATABASE_URL,
            cursor_factory=psycopg2.extras.RealDictCursor,
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
            # Quick liveness check — if the connection is broken this raises immediately
            conn.reset()
            with conn.cursor() as cur:
                cur.execute(sql, params)
                if exec_only:
                    conn.commit()
                    pool.putconn(conn)
                    return None
                conn.commit()
                if one:
                    row = cur.fetchone()
                    pool.putconn(conn)
                    return dict(row) if row else None
                rows = [dict(r) for r in cur.fetchall()]
                pool.putconn(conn)
                return rows
        except psycopg2.OperationalError:
            # Connection is dead — discard it and retry with a new one
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
            try:
                conn.rollback()
                pool.putconn(conn)
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
            cur.execute("UPDATE scheduling.staff SET max_shifts=17 WHERE max_shifts=0 OR max_shifts IS NULL;")
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
    pwd = bcrypt.hashpw(ADMIN_PASS.encode(), bcrypt.gensalt()).decode()
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
                      COALESCE(u.token_epoch,0) AS token_epoch, b.name AS branch_name
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

def _deliver_email(to, subject, body):
    """Actually send (raises on failure). Resend preferred, SMTP fallback."""
    if os.environ.get("SMTP_CAPTURE"):
        _email_outbox.append({"to": to, "subject": subject, "body": body,
                              "html": _email_html(body)})
        return
    if os.environ.get("RESEND_API_KEY"):
        _resend_send(to, subject, body)
    elif os.environ.get("SMTP_HOST"):
        _smtp_send(to, subject, body)
    else:
        raise RuntimeError("No email provider configured (set RESEND_API_KEY or SMTP_HOST)")

def send_email(to, subject, body):
    if not to:
        return
    if os.environ.get("SMTP_CAPTURE"):
        _email_outbox.append({"to": to, "subject": subject, "body": body,
                              "html": _email_html(body)})
        return
    if not (os.environ.get("RESEND_API_KEY") or os.environ.get("SMTP_HOST")):
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

def send_whatsapp(to, message, *, ntype="info", link=None, force=False):
    # force=True bypasses the WHATSAPP_ONLY_TYPES filter — used for manager
    # broadcasts / required-action circulars that must reach WhatsApp regardless.
    url = (os.environ.get("WHATSAPP_NOTIFY_URL") or "").strip()
    capture = os.environ.get("WHATSAPP_CAPTURE")
    if not (url or capture) or not to or not message:
        return
    if not force and not _whatsapp_notify_enabled_for(ntype):
        return
    to = _normalize_whatsapp_number(to)
    if not to:
        return
    if capture:
        _whatsapp_outbox.append({"to": to, "message": message, "type": ntype})
        return
    payload = {"to": to, "message": message, "type": ntype, "link": link}
    token = (os.environ.get("WHATSAPP_NOTIFY_TOKEN") or "").strip()
    def _worker():
        try:
            import urllib.request
            data = json.dumps(payload).encode("utf-8")
            headers = {"Content-Type": "application/json", "Accept": "application/json",
                       "User-Agent": "MeenaScheduling/1.0 (+https://meena-health.com)"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            req = urllib.request.Request(url, data=data, method="POST", headers=headers)
            with urllib.request.urlopen(req, timeout=40) as resp:
                resp.read()
        except Exception as e:
            print(f"[whatsapp] failed to {to}: {e}")
    import threading
    threading.Thread(target=_worker, daemon=True).start()

def notify(user_id, message, link=None, ntype="info"):
    """Create one in-app notification, and email/WhatsApp it when configured.
    Best-effort: never break the caller."""
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
        if u and u.get("staff_phone"):
            send_whatsapp(u["staff_phone"], message, ntype=ntype, link=link)
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

def leave_coverage_gap(staff_id, date):
    """If this staff member is scheduled a *working* shift that day and is the
    only one on it, return that shift code (a coverage gap); else None. Used to
    warn before an approved leave silently leaves a day uncovered."""
    sched = _schedule_for_leave(staff_id, date)
    if not sched:
        return None
    cur = q("""SELECT shift_code FROM scheduling.schedule_entries
               WHERE schedule_id=%s AND staff_id=%s AND date=%s""",
            (sched["id"], staff_id, date), one=True)
    code = cur and cur["shift_code"]
    if not code or code in ("O", "AL", "SL", "TB", "OC"):
        return None  # wasn't working that day → no gap
    others = q("""SELECT COUNT(*) AS n FROM scheduling.schedule_entries
                  WHERE schedule_id=%s AND date=%s AND shift_code=%s AND staff_id<>%s""",
               (sched["id"], date, code, staff_id), one=True)
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

@app.middleware("http")
async def _no_store_api(request: Request, call_next):
    """API data is dynamic — never let the browser or a CDN cache it, or a read
    right after an edit can serve a stale copy (the rota 'reverting' after a save).
    Static assets keep their own (versioned) caching."""
    resp = await call_next(request)
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
    return resp

@app.on_event("startup")
def startup():
    init_schema()
    seed_defaults()
    seed_nest_config()
    seed_admin()
    start_scheduler()

# ── Static dashboard ──────────────────────────────────────────────────────────

DASHBOARD = os.path.join(os.path.dirname(__file__), '..', 'dashboard')

app.mount("/js", StaticFiles(directory=os.path.join(DASHBOARD, "js")), name="js")

@app.get("/style.css")
def serve_css():
    return FileResponse(
        os.path.join(DASHBOARD, "style.css"),
        media_type="text/css",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )

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
    # Log the raw response so the real field shape is visible in the server logs.
    print(f"[nafath] start nid={nid} req={request_id} -> {json.dumps(results, ensure_ascii=False)}", file=sys.stderr)
    r0 = (results or [{}])[0] or {}
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
    if not _phone_verify_enabled():
        raise HTTPException(503, "WhatsApp verification isn't set up on the server yet. Ask your admin.")
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
    try:
        _whatsapp_send_now(to, f"Meena Scheduling verification code: {code}\n\n"
                               f"It expires in 10 minutes. Enter it on the sign-up form to confirm your mobile number.")
    except Exception as e:
        raise HTTPException(502, f"Couldn't send the WhatsApp code: {e}")
    return {"ok": True}

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
    if not (os.environ.get("SMTP_CAPTURE") or os.environ.get("RESEND_API_KEY") or os.environ.get("SMTP_HOST")):
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
        notify_staff_member(staff["id"], f"🎉 Welcome to Meena, {first}! Your account is active.",
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
                            f"✅ Your Meena account is now active — sign in with your username \"{reg['username']}\".",
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
    return q("SELECT id,name,city,shares_staff,cover_need_per_day,created_at FROM scheduling.branches ORDER BY name")

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
    cur = q("SELECT name,city,shares_staff,cover_need_per_day FROM scheduling.branches WHERE id=%s", (bid,), one=True)
    if not cur: raise HTTPException(404, "Not found")
    name = (body.get("name") or cur["name"]).strip()
    city = body.get("city") if "city" in body else cur["city"]
    if isinstance(city, str): city = city.strip() or None
    shares = bool(body["shares_staff"]) if "shares_staff" in body else cur["shares_staff"]
    need = max(0, int(body["cover_need_per_day"])) if "cover_need_per_day" in body else cur["cover_need_per_day"]
    row = q("""UPDATE scheduling.branches SET name=%s, city=%s, shares_staff=%s, cover_need_per_day=%s
               WHERE id=%s RETURNING id,name,city,shares_staff,cover_need_per_day""",
            (name, city, shares, need, bid), one=True)
    insert_audit(user, "UPDATE_BRANCH", name, f"city={city or '-'} shares={shares} need={need}")
    return row

@app.delete("/api/branches/{bid}")
def delete_branch(bid: int, user=Depends(require_superadmin)):
    q("DELETE FROM scheduling.branches WHERE id=%s", (bid,), exec_only=True)
    return {"ok": True}

# ── Users ─────────────────────────────────────────────────────────────────────

@app.get("/api/users")
def list_users(user=Depends(require_superadmin)):
    return q("""SELECT u.id,u.username,u.role,u.branch_id,u.staff_id,u.created_at,
                       u.email, COALESCE(u.email_notifications,true) AS email_notifications,
                       b.name AS branch_name, st.name AS staff_name
                FROM scheduling.users u
                LEFT JOIN scheduling.branches b ON b.id=u.branch_id
                LEFT JOIN scheduling.staff st ON st.id=u.staff_id
                ORDER BY u.created_at""")

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
    if body.get("username") is not None: sets.append("username=%s"); params.append(body["username"])
    if body.get("role")     is not None: sets.append("role=%s");     params.append(body["role"])
    if "email" in body: sets.append("email=%s"); params.append((body.get("email") or "").strip() or None)
    if "email_notifications" in body: sets.append("email_notifications=%s"); params.append(bool(body["email_notifications"]))
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
    branch_id = body.get("branch_id")
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
    branch_id = request.query_params.get("branch_id") if user["role"] in ("superadmin","manager") else user.get("branch_id")
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
    branch_id, year, month = body.get("branch_id"), body.get("year"), body.get("month")
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

    # Make sure the column for the manager's note exists (added lazily).
    q("ALTER TABLE scheduling.schedules ADD COLUMN IF NOT EXISTS review_note TEXT", exec_only=True)

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
            row = q("""INSERT INTO scheduling.leave_requests
                       (staff_id,date,leave_type,status,note,created_by,covered_shift)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (staff_id,date) DO UPDATE
                       SET leave_type=EXCLUDED.leave_type,note=EXCLUDED.note,
                           status=EXCLUDED.status,created_by=EXCLUDED.created_by,
                           covered_shift=EXCLUDED.covered_shift
                       RETURNING id,staff_id,TO_CHAR(date,'YYYY-MM-DD') AS date,
                                 leave_type,status,note,created_by,created_at,covered_shift""",
                    (staff_id, d, leave_type, new_status, note, user["id"], covered), one=True)
            if row:
                leaves.append(row)
                # Approved leave (reviewer entry or sick leave) goes straight on the rota.
                if new_status == "approved":
                    apply_leave_to_schedule(staff_id, d, leave_type)
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
        msg = f"🤒 {staff['name']} reported sick — {len(leaves)} day(s). Tap to find cover."
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
    row = q("""UPDATE scheduling.leave_requests SET status=%s WHERE id=%s
               RETURNING id,staff_id,TO_CHAR(date,'YYYY-MM-DD') AS date,leave_type,status,note""",
            (new_status, lid), one=True)
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
    # The grouped range shares one stage; decide the target from it (per-actor).
    current = rows[0]["status"]
    new_status = _leave_decide(user, current, requested)
    # Coverage gaps only matter at FINAL approval; check BEFORE applying.
    gaps = []
    if new_status == "approved":
        for lv in rows:
            gc = leave_coverage_gap(lv["staff_id"], lv["date"])
            if gc:
                gaps.append((lv, gc))
        if gaps and not body.get("confirm"):
            shown = "; ".join(f"{g[0]['staff_name']} {g[0]['date']} (shift {g[1]})" for g in gaps[:5])
            more = f" +{len(gaps)-5} more" if len(gaps) > 5 else ""
            raise HTTPException(409, {
                "error": f"These approvals leave shifts uncovered: {shown}{more}. Approve anyway?",
                "confirm_required": "coverage_gap",
            })
    q("UPDATE scheduling.leave_requests SET status=%s WHERE id = ANY(%s)",
      (new_status, ids), exec_only=True)
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
    if len(date) < 7:
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
    if user["role"] == "staff" and user.get("staff_id") != sid:
        raise HTTPException(403, "Forbidden")
    if user["role"] == "admin" and not can_access_branch(user, st["branch_id"]):
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
    row = q("""UPDATE scheduling.timeback_claims SET status=%s, reviewed_by=%s, reviewed_at=NOW()
               WHERE id=%s RETURNING id,status""", (new_status, user["id"], tid), one=True)
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
        staff = (q("SELECT id,name,phone,email FROM scheduling.staff WHERE branch_id=%s", (branch_id,))
                 if audience == "branch"
                 else q("SELECT id,name,phone,email FROM scheduling.staff"))
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
    a = q("SELECT created_by,branch_id FROM scheduling.announcements WHERE id=%s", (aid,), one=True)
    if not a:
        raise HTTPException(404, "Announcement not found")
    if user["role"] == "admin" and not (a["created_by"] == user["id"] or can_access_branch(user, a.get("branch_id"))):
        raise HTTPException(403, "Forbidden")
    return q("""SELECT u.username, TO_CHAR(k.acked_at,'YYYY-MM-DD"T"HH24:MI:SS') AS acked_at
                FROM scheduling.announcement_acks k JOIN scheduling.users u ON u.id=k.user_id
                WHERE k.announcement_id=%s ORDER BY k.acked_at""", (aid,))

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
    out = []
    for b in branches:
        checks = []
        for sh in _SHIFT_CHECK_SHIFTS:
            r = _shift_check_row(b["id"], date, sh)
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
async def reopen_shift_check(request: Request, user=Depends(require_reviewer)):
    body = await request.json()
    branch_id, date, shift = body.get("branch_id"), body.get("date"), body.get("shift")
    if not branch_id or not date or shift not in _SHIFT_CHECK_SHIFTS:
        raise HTTPException(400, "branch_id, date and a valid shift are required")
    branch_id = _int_or_400(branch_id)
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
        q("""INSERT INTO scheduling.schedule_entries
             (schedule_id,staff_id,date,shift_code,is_oncall,cross_branch_id)
             VALUES (%s,%s,%s,%s,%s,%s)
             ON CONFLICT (schedule_id,staff_id,date) DO UPDATE
             SET shift_code=EXCLUDED.shift_code,is_oncall=EXCLUDED.is_oncall,
                 cross_branch_id=EXCLUDED.cross_branch_id""",
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
    # Only a superadmin sees the registration links/code.
    if user["role"] == "superadmin":
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
    provider = ("resend" if os.environ.get("RESEND_API_KEY")
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
    if not (os.environ.get("RESEND_API_KEY") or os.environ.get("SMTP_HOST")
            or os.environ.get("SMTP_CAPTURE")):
        raise HTTPException(400, "No email provider configured. Set RESEND_API_KEY in your environment.")
    try:
        _deliver_email(to, "Meena Scheduling — test email",
                       "This is a test message confirming email delivery is working.")
    except Exception as e:
        # 502 + the provider's own message → shows up directly in the UI.
        raise HTTPException(502, f"Send failed: {e}")
    insert_audit(user, "EMAIL_TEST", to)
    return {"ok": True, "sent_to": to, "from": _email_from()}

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
    """User accounts that should fill a branch's daily report: its team lead(s),
    can_report staff, and anyone scheduled Night that day."""
    ids = set()
    for r in q("SELECT id FROM scheduling.users WHERE role='admin' AND branch_id=%s", (branch_id,)):
        ids.add(r["id"])
    for r in q("""SELECT u.id FROM scheduling.users u
                  JOIN scheduling.staff s ON s.id=u.staff_id
                  WHERE u.role='staff' AND s.branch_id=%s AND COALESCE(s.can_report,false)=true""",
               (branch_id,)):
        ids.add(r["id"])
    for r in q("""SELECT u.id FROM scheduling.users u
                  JOIN scheduling.schedule_entries e ON e.staff_id=u.staff_id
                  JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                  WHERE u.role='staff' AND sc.branch_id=%s AND e.date=%s AND e.shift_code='N'""",
               (branch_id, date)):
        ids.add(r["id"])
    return ids

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
        targets = _cases_remind_targets(b["id"], date)
        if not targets:
            continue
        msg = (f"Reminder: please enter {b['name']}'s daily case numbers in the platform "
               f"now (Daily Cases page). The numbers for {date} will be finalized in "
               f"20 minutes — please complete your entry before then.")
        for uid in targets:
            notify(uid, msg, link="cases", ntype="reminder")
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
                if 0 <= mins_since_start < _CASES_REMIND_WINDOW_HOURS * 60:
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

def start_scheduler():
    # Skip under the test harness; otherwise one daemon thread per worker is fine
    # (the atomic per-day claim keeps the actual send single).
    if os.environ.get("SMTP_CAPTURE") or os.environ.get("DISABLE_SCHEDULER"):
        return
    import threading
    threading.Thread(target=_cases_reminder_loop, daemon=True).start()
    threading.Thread(target=_shift_check_reminder_loop, daemon=True).start()

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

    # "Fill blanks only": keep the manager's hand-entered cells and let the solver
    # build the rest of the month around them. We pin every existing non-blank
    # cell (work shifts and explicit O), except leave codes — those are already
    # forced via al_schedule.
    fixed_by_solver = {}
    # Always pin hand-entered (manual) cells so a regenerate keeps them — the
    # solver builds the rest of the month around them, and they're never deleted
    # or overwritten when persisting (see manual_cells below).
    manual_cells = set()
    manual_rows = q("""SELECT e.staff_id, TO_CHAR(e.date,'YYYY-MM-DD') AS date, e.shift_code
                       FROM scheduling.schedule_entries e
                       JOIN scheduling.schedules sc ON sc.id=e.schedule_id
                       WHERE sc.branch_id=%s AND sc.year=%s AND sc.month=%s
                         AND COALESCE(e.is_manual,false)=true""",
                    (branch_id, year, month))
    for e in manual_rows:
        manual_cells.add((int(e["staff_id"]), e["date"]))
        code = e["shift_code"]
        # Leave codes are already forced via al_schedule; pin the rest for the solver.
        if code and code not in ("AL", "SL", "TB"):
            sk = solver_key_by_staff_id.get(int(e["staff_id"]))
            if sk:
                fixed_by_solver.setdefault(sk, {})[int(e["date"][8:10])] = code
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
        staff_keys = mn.get("staff") or []
        staff_count   = len(staff_keys)
        for sk in staff_keys:
            sk_to_mn[sk] = {"slots_per_day": slots_per_day, "staff_count": staff_count}

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
            "daily_shortages": daily_shortages[:10],
            "messages": msgs,
        }

    # If a specific section was asked for, make sure it actually exists for this
    # branch — otherwise we'd silently generate nothing and look like a failure.
    if only_section and not any(_section_requested(s) for s in nest_cfg_for_solver["sections"]):
        raise HTTPException(400, f"Section '{only_section}' not found for this branch")

    def probe_relaxations(sec_name, sec_cfg, sec_al, sec_prev_tail, sec_staff_limits, sec_fixed=None):
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
                    al_schedule=sec_al, prev_tail=sec_prev_tail, time_limit=8,
                    max_consecutive=(new_k or max_consecutive),
                    staff_limits=sec_staff_limits,
                    section_limits=seclim2,
                    nest_cfg={"sections": {sec_name: sec2}},
                    fixed_schedule=sec_fixed,
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
        )

        if sec_result["status"] == "INFEASIBLE" or not sec_result.get("schedule"):
            diag = section_diagnostics(sec_name, sec_cfg, staff_keys)
            # Pinpoint the exact setting(s) at fault by trying them one at a time.
            try:
                diag["fixes"] = probe_relaxations(sec_name, sec_cfg, sec_al, sec_prev_tail, sec_staff_limits, sec_fixed)
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
            if ok_staff_ids:
                # Keep manual cells — only the solver-owned (non-manual) cells are
                # cleared and rewritten.
                cur.execute("""DELETE FROM scheduling.schedule_entries
                               WHERE schedule_id=%s AND staff_id = ANY(%s)
                                 AND COALESCE(is_manual,false)=false""",
                            (schedule["id"], ok_staff_ids))
            for e in flat_entries:
                # Never overwrite a manual cell (the solver already pinned it, so
                # the value matches anyway — this just protects the is_manual flag).
                if (e["staff_id"], e["date"]) in manual_cells:
                    continue
                cur.execute("""INSERT INTO scheduling.schedule_entries
                               (schedule_id,staff_id,date,shift_code,cross_branch_id,is_oncall,note)
                               VALUES (%s,%s,%s,%s,%s,%s,%s)
                               ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET
                               shift_code=%s,cross_branch_id=%s,is_oncall=%s,note=%s""",
                            (schedule["id"], e["staff_id"], e["date"], e["shift_code"],
                             e["cross_branch_id"], e["is_oncall"], e["note"],
                             e["shift_code"], e["cross_branch_id"], e["is_oncall"], e["note"]))
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
    return FileResponse(os.path.join(DASHBOARD, "index.html"))
