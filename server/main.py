"""
Meena Health Radiology — FastAPI server
Replaces Node.js/Express. Same DB, same dashboard, same API paths.

Run:
    python -m uvicorn server.main:app --port 3002 --reload
"""

import os, json, math, calendar as _cal

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
            # For older DBs created before `min_shifts_default` existed.
            cur.execute("ALTER TABLE scheduling.branch_settings ADD COLUMN IF NOT EXISTS min_shifts_default INTEGER NOT NULL DEFAULT 17;")
            # For older DBs created before section max_consecutive existed.
            cur.execute("ALTER TABLE scheduling.section_month_settings ADD COLUMN IF NOT EXISTS max_consecutive INTEGER NOT NULL DEFAULT 4;")
            # For O (Off) block policy (per-section per-month). 1 disables.
            cur.execute("ALTER TABLE scheduling.section_month_settings ADD COLUMN IF NOT EXISTS min_o_block INTEGER NOT NULL DEFAULT 2;")
            # If the column already existed from a previous deploy, ensure new
            # rows default to 2 (no isolated Off days).
            cur.execute("ALTER TABLE scheduling.section_month_settings ALTER COLUMN min_o_block SET DEFAULT 2;")
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
             ON CONFLICT (nest_key,section_name) DO UPDATE SET
               staff=EXCLUDED.staff, staff_db_names=EXCLUDED.staff_db_names,
               allowed_shifts=EXCLUDED.allowed_shifts, coverage=EXCLUDED.coverage,
               exact_coverage=EXCLUDED.exact_coverage""",
          (n['nest_key'], n['section_name'], n['staff'],
           json.dumps(n['staff_db_names']), n['allowed_shifts'],
           json.dumps(n['coverage']), json.dumps(n['exact_coverage']), n['sort_order']),
          exec_only=True)
    print("Nest configs seeded (skipped if already exist).")


def seed_admin():
    pwd = bcrypt.hashpw(ADMIN_PASS.encode(), bcrypt.gensalt()).decode()
    existing = q("SELECT id FROM scheduling.users WHERE username=%s", (ADMIN_USER,), one=True)
    if existing:
        q("UPDATE scheduling.users SET password=%s, role='superadmin' WHERE username=%s",
          (pwd, ADMIN_USER), exec_only=True)
    else:
        q("INSERT INTO scheduling.users (username,password,role) VALUES (%s,%s,'superadmin')",
          (ADMIN_USER, pwd), exec_only=True)
    print(f'Admin user "{ADMIN_USER}" ready.')


# ── Auth helpers ──────────────────────────────────────────────────────────────

def sign_token(payload: dict) -> str:
    data = dict(payload)
    data["exp"] = datetime.now(timezone.utc) + timedelta(days=JWT_DAYS)
    return jwt.encode(data, JWT_SECRET, algorithm=JWT_ALG)

def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError:
        raise HTTPException(401, "Session expired")

def get_current_user(request: Request) -> dict:
    token = request.cookies.get("token") or \
            request.headers.get("authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "Not authenticated")
    return verify_token(token)

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
    # Schedule editing (cells, generate): team leads and full admins, NOT managers.
    if user.get("role") not in ("admin", "superadmin"):
        raise HTTPException(403, "Managers cannot edit schedules directly")
    return user

def can_access_branch(user: dict, branch_id) -> bool:
    # Managers and full admins can see every branch; team leads only their own.
    if user.get("role") in ("superadmin", "manager"):
        return True
    return str(user.get("branch_id")) == str(branch_id)

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

# ── Notifications ─────────────────────────────────────────────────────────────

def notify(user_id, message, link=None, ntype="info"):
    """Create one in-app notification. Best-effort: never break the caller."""
    if not user_id:
        return
    try:
        q("""INSERT INTO scheduling.notifications (user_id,message,link,type)
             VALUES (%s,%s,%s,%s)""", (user_id, message, link, ntype), exec_only=True)
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
                   COALESCE(sms.min_o_block,2) AS min_o_block
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
                           2 AS min_o_block
                    FROM scheduling.nest_sections WHERE nest_key=%s
                    ORDER BY sort_order,section_name""", (nest_key,))
    for r in rows:
        r["allowed_shifts"] = global_codes
    return rows

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Meena Scheduling")

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def startup():
    init_schema()
    seed_defaults()
    seed_nest_config()
    seed_admin()

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

@app.get("/logo.png")
def serve_logo2():
    p = os.path.join(DASHBOARD, "logo.png")
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

    user = q("""SELECT u.*, b.name AS branch_name FROM scheduling.users u
                LEFT JOIN scheduling.branches b ON b.id=u.branch_id
                WHERE u.username=%s""", (username,), one=True)
    if not user:
        raise HTTPException(401, "Invalid credentials")

    if not bcrypt.checkpw(password.encode(), user["password"].encode()):
        raise HTTPException(401, "Invalid credentials")

    payload = {k: user[k] for k in ("id","username","role","branch_id","branch_name")}
    token = sign_token(payload)
    response.set_cookie("token", token, httponly=True, samesite="lax",
                        max_age=JWT_DAYS * 86400)
    return payload

@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie("token")
    return {"ok": True}

@app.get("/api/auth/me")
def me(user=Depends(get_current_user)):
    return user

# ── Branches ──────────────────────────────────────────────────────────────────

@app.get("/api/branches")
def list_branches(user=Depends(get_current_user)):
    return q("SELECT id,name,created_at FROM scheduling.branches ORDER BY name")

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
    row = q("UPDATE scheduling.branches SET name=%s WHERE id=%s RETURNING id,name",
            ((body.get("name") or "").strip(), bid), one=True)
    if not row: raise HTTPException(404, "Not found")
    return row

@app.delete("/api/branches/{bid}")
def delete_branch(bid: int, user=Depends(require_superadmin)):
    q("DELETE FROM scheduling.branches WHERE id=%s", (bid,), exec_only=True)
    return {"ok": True}

# ── Users ─────────────────────────────────────────────────────────────────────

@app.get("/api/users")
def list_users(user=Depends(require_superadmin)):
    return q("""SELECT u.id,u.username,u.role,u.branch_id,u.created_at,b.name AS branch_name
                FROM scheduling.users u LEFT JOIN scheduling.branches b ON b.id=u.branch_id
                ORDER BY u.created_at""")

@app.post("/api/users")
async def create_user(request: Request, user=Depends(require_superadmin)):
    body = await request.json()
    username = (body.get("username") or "").strip().lower()
    password = body.get("password") or ""
    role     = body.get("role") or ""
    branch_id = body.get("branch_id") or None
    if not username or not password or not role:
        raise HTTPException(400, "Missing fields")
    if role not in ("viewer", "admin", "manager", "superadmin"):
        raise HTTPException(400, "Invalid role")
    if len(password) < 6:
        raise HTTPException(400, "Password min 6 chars")
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    try:
        row = q("""INSERT INTO scheduling.users (username,password,role,branch_id)
                   VALUES (%s,%s,%s,%s)
                   RETURNING id,username,role,branch_id,created_at""",
                (username, hashed, role, branch_id), one=True)
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
        q("UPDATE scheduling.users SET password=%s WHERE id=%s", (hashed, uid), exec_only=True)
    sets, params = [], []
    if body.get("username") is not None: sets.append("username=%s"); params.append(body["username"])
    if body.get("role")     is not None: sets.append("role=%s");     params.append(body["role"])
    if "branch_id" in body:              sets.append("branch_id=%s"); params.append(body["branch_id"] or None)
    if sets:
        params.append(uid)
        q(f"UPDATE scheduling.users SET {','.join(sets)} WHERE id=%s", params, exec_only=True)
    return q("""SELECT u.id,u.username,u.role,u.branch_id,u.created_at,b.name AS branch_name
                FROM scheduling.users u LEFT JOIN scheduling.branches b ON b.id=u.branch_id
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
    # a team lead is always pinned to their own branch.
    if user["role"] not in ("superadmin", "manager"):
        branch_id = user.get("branch_id")
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

@app.post("/api/staff")
async def create_staff(request: Request, user=Depends(require_admin)):
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name: raise HTTPException(400, "Name required")
    branch_id = body.get("branch_id")
    if not can_access_branch(user, branch_id): raise HTTPException(403, "Forbidden")
    row = q("""INSERT INTO scheduling.staff (name,phone,branch_id,speciality,is_cross_branch)
               VALUES (%s,%s,%s,%s,%s) RETURNING *""",
            (name, body.get("phone"), branch_id,
             body.get("speciality", ["General"]), body.get("is_cross_branch", False)),
            one=True)
    insert_audit(user, "CREATE_STAFF", name)
    return row

@app.put("/api/staff/{sid}")
async def update_staff(sid: int, request: Request, user=Depends(require_admin)):
    body = await request.json()
    existing = q("SELECT * FROM scheduling.staff WHERE id=%s", (sid,), one=True)
    if not existing: raise HTTPException(404, "Not found")
    if not can_access_branch(user, existing["branch_id"]): raise HTTPException(403, "Forbidden")
    sets, params = [], []
    for field in ("name","phone","branch_id","speciality","is_cross_branch","active","phase","min_shifts","max_shifts"):
        if field in body:
            sets.append(f"{field}=%s")
            params.append(body[field] if body[field] != "" else None)
    if not sets: return existing
    params.append(sid)
    return q(f"UPDATE scheduling.staff SET {','.join(sets)} WHERE id=%s RETURNING *",
             params, one=True)

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
def get_section_month_settings(request: Request, user=Depends(get_current_user)):
    """Get per-month M/N limits for all sections in a nest (branch), for a given year/month."""
    branch_id = request.query_params.get("branch_id")
    year      = request.query_params.get("year")
    month     = request.query_params.get("month")
    if not branch_id or not year or not month:
        raise HTTPException(400, "branch_id, year, month required")
    branch = q("SELECT name FROM scheduling.branches WHERE id=%s", (int(branch_id),), one=True)
    if not branch: raise HTTPException(404, "Branch not found")
    nest_name = branch_to_nest(branch["name"]) or f"BRANCH_{int(branch_id)}"
    rows = q("""
        SELECT ns.id AS section_id, ns.section_name,
               COALESCE(sms.min_m,1) AS min_m, COALESCE(sms.max_m,2) AS max_m,
               COALESCE(sms.min_n,1) AS min_n, COALESCE(sms.max_n,2) AS max_n,
               COALESCE(sms.max_consecutive,4) AS max_consecutive,
               COALESCE(sms.min_o_block,2) AS min_o_block
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
            "max_consecutive": 4, "min_o_block": 2,
            "virtual": True,
        }}
    return {r["section_id"]: {
        "section_name": r["section_name"],
        "min_m": r["min_m"], "max_m": r["max_m"],
        "min_n": r["min_n"], "max_n": r["max_n"],
        "max_consecutive": r["max_consecutive"],
        "min_o_block": r["min_o_block"],
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
    if min_m > max_m: raise HTTPException(400, "min_m cannot exceed max_m")
    if min_n > max_n: raise HTTPException(400, "min_n cannot exceed max_n")
    if max_consecutive < 1 or max_consecutive > 14:
        raise HTTPException(400, "max_consecutive must be between 1 and 14")
    if min_o_block < 1 or min_o_block > 14:
        raise HTTPException(400, "min_o_block must be between 1 and 14")

    # section_id 0 is the virtual "General" we surface for branches that have no
    # nest_sections rows yet. On first save, create a real section so the values
    # persist. The frontend sends branch_id alongside so we know where to attach it.
    if int(section_id) == 0:
        branch_id = body.get("branch_id")
        if not branch_id:
            raise HTTPException(400, "branch_id required to create a section")
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

    sec = q("SELECT id FROM scheduling.nest_sections WHERE id=%s", (section_id,), one=True)
    if not sec: raise HTTPException(404, "Section not found")
    row = q("""INSERT INTO scheduling.section_month_settings
                 (section_id, year, month, min_m, max_m, min_n, max_n, max_consecutive, min_o_block)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (section_id, year, month) DO UPDATE
               SET min_m=%s, max_m=%s, min_n=%s, max_n=%s, max_consecutive=%s, min_o_block=%s, updated_at=NOW()
               RETURNING *""",
            (section_id, year, month, min_m, max_m, min_n, max_n, max_consecutive, min_o_block,
             min_m, max_m, min_n, max_n, max_consecutive, min_o_block), one=True)
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
async def upsert_shift_type(request: Request, user=Depends(require_admin)):
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
async def update_shift_type(stid: int, request: Request, user=Depends(require_admin)):
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
def delete_shift_type(stid: int, user=Depends(require_admin)):
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
    entries = get_entries(schedule["id"])
    return {"schedule": schedule, "entries": entries}

@app.get("/api/schedules/{sid}/entries")
def list_entries(sid: int, user=Depends(get_current_user)):
    assert_schedule_access(user, sid)
    return get_entries(sid)

def get_entries(schedule_id):
    return q("""SELECT e.id,e.schedule_id,e.staff_id,
                       TO_CHAR(e.date,'YYYY-MM-DD') AS date,
                       e.shift_code,e.cross_branch_id,e.is_oncall,e.note,
                       s.name AS staff_name,s.speciality,s.is_cross_branch,
                       b.name AS cross_branch_name
                FROM scheduling.schedule_entries e
                JOIN scheduling.staff s ON s.id=e.staff_id
                LEFT JOIN scheduling.branches b ON b.id=e.cross_branch_id
                WHERE e.schedule_id=%s ORDER BY s.name,e.date""", (schedule_id,))

@app.put("/api/schedules/{sid}/entries")
async def save_entry(sid: int, request: Request, user=Depends(require_editor)):
    body = await request.json()
    # Block edits if schedule belongs to another branch or is locked.
    sched = assert_schedule_access(user, sid)
    if sched.get("is_locked"):
        raise HTTPException(403, "Schedule is locked. Unlock it first.")
    row = q("""INSERT INTO scheduling.schedule_entries
               (schedule_id,staff_id,date,shift_code,cross_branch_id,is_oncall,note)
               VALUES (%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET
               shift_code=%s,cross_branch_id=%s,is_oncall=%s,note=%s
               RETURNING id,schedule_id,staff_id,
                         TO_CHAR(date,'YYYY-MM-DD') AS date,
                         shift_code,cross_branch_id,is_oncall,note""",
            (sid, body.get("staff_id"), body.get("date"),
             body.get("shift_code","O"), body.get("cross_branch_id"),
             body.get("is_oncall",False), body.get("note"),
             body.get("shift_code","O"), body.get("cross_branch_id"),
             body.get("is_oncall",False), body.get("note")),
            one=True)
    return row

@app.put("/api/schedules/{sid}/entries/bulk")
async def bulk_save_entries(sid: int, request: Request, user=Depends(require_editor)):
    body = await request.json()
    # Same guard as the single-cell save: right branch, and not locked.
    sched = assert_schedule_access(user, sid)
    if sched.get("is_locked"):
        raise HTTPException(403, "Schedule is locked. Unlock it first.")
    entries = body.get("entries", [])
    if not isinstance(entries, list): raise HTTPException(400, "entries must be array")
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            for e in entries:
                cur.execute("""INSERT INTO scheduling.schedule_entries
                               (schedule_id,staff_id,date,shift_code,cross_branch_id,is_oncall,note)
                               VALUES (%s,%s,%s,%s,%s,%s,%s)
                               ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET
                               shift_code=%s,cross_branch_id=%s,is_oncall=%s,note=%s""",
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
def clear_entries(sid: int, user=Depends(require_editor)):
    sched = assert_schedule_access(user, sid)
    if sched.get("is_locked"):
        raise HTTPException(403, "Schedule is locked. Unlock it first.")
    q("DELETE FROM scheduling.schedule_entries WHERE schedule_id=%s", (sid,), exec_only=True)
    return {"ok": True}

@app.delete("/api/schedules/{sid}/entries/cell")
async def delete_entry_cell(sid: int, request: Request, user=Depends(require_editor)):
    """Delete a single cell entry (makes it blank on the grid)."""
    body = await request.json()
    sched = assert_schedule_access(user, sid)
    if sched.get("is_locked"):
        raise HTTPException(403, "Schedule is locked. Unlock it first.")
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
    assert_schedule_access(user, sid)
    body   = await request.json()
    locked = body.get("locked", True)
    row = q("""UPDATE scheduling.schedules SET is_locked=%s, updated_at=NOW()
               WHERE id=%s RETURNING *""", (locked, sid), one=True)
    if not row:
        raise HTTPException(404, "Schedule not found")
    action = "LOCK_SCHEDULE" if locked else "UNLOCK_SCHEDULE"
    insert_audit(user, action, f"schedule:{sid}")
    return row

@app.put("/api/schedules/{sid}/status")
async def update_schedule_status(sid: int, request: Request, user=Depends(require_admin)):
    assert_schedule_access(user, sid)
    body = await request.json()
    status = body.get("status")
    note   = body.get("note")
    if status not in ("draft","submitted","reviewed","approved","returned"):
        raise HTTPException(400, "Invalid status")
    # Team leads (admin) submit/withdraw their own branch; managers (and full
    # admins) review/approve/return. Keep the two roles from doing each other's job.
    if status in ("reviewed","approved","returned") and user["role"] not in ("superadmin","manager"):
        raise HTTPException(403, "Only a manager can review, approve, or return")
    if status in ("submitted","draft") and user["role"] == "manager":
        raise HTTPException(403, "Managers don't submit schedules; that's the team lead's step")

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
                     link="review", ntype="review")
    elif status in ("reviewed", "approved", "returned") and row.get("created_by"):
        verb = {"reviewed": "reviewed", "approved": "approved", "returned": "returned for edits"}[status]
        notify(row["created_by"], f"{bname} {period} schedule was {verb}", link="schedule", ntype=status)
    return row

@app.delete("/api/schedules/{sid}")
def delete_schedule(sid: int, user=Depends(require_editor)):
    assert_schedule_access(user, sid)
    q("DELETE FROM scheduling.schedules WHERE id=%s", (sid,), exec_only=True)
    return {"ok": True}

# ── Leaves ────────────────────────────────────────────────────────────────────

@app.get("/api/leaves")
def list_leaves(request: Request, user=Depends(get_current_user)):
    params = request.query_params
    branch_id = params.get("branch_id") if user["role"] in ("superadmin","manager") else user.get("branch_id")
    year  = params.get("year")
    month = params.get("month")
    conds, vals = ["1=1"], []
    if branch_id: conds.append("s.branch_id=%s"); vals.append(branch_id)
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
async def create_leave(request: Request, user=Depends(require_admin)):
    body = await request.json()
    staff_id  = body.get("staff_id")
    date_from = body.get("date_from")
    date_to   = body.get("date_to") or date_from
    leave_type = body.get("leave_type", "AL")
    note = body.get("note")
    if not staff_id or not date_from:
        raise HTTPException(400, "staff_id and date_from required")
    staff = q("SELECT * FROM scheduling.staff WHERE id=%s", (staff_id,), one=True)
    if not staff: raise HTTPException(404, "Staff not found")
    if not can_access_branch(user, staff["branch_id"]): raise HTTPException(403, "Forbidden")
    if date_to < date_from: raise HTTPException(400, '"To" date must be on or after "From" date')

    # Approval workflow: a manager/full-admin records leave as already approved;
    # a team lead's entry is a *request* that a reviewer must approve before the
    # generator will honour it. (Generation only counts approved leave.)
    new_status = "approved" if user["role"] in ("superadmin", "manager") else "pending"

    # Expand date range
    from datetime import date as _date, timedelta as _td
    try:
        cur = _date(*map(int, date_from.split('-')))
        end = _date(*map(int, date_to.split('-')))
    except (ValueError, TypeError):
        raise HTTPException(400, "Dates must be valid YYYY-MM-DD")
    dates, leaves = [], []
    while cur <= end and len(dates) < 365:
        dates.append(str(cur)); cur += _td(days=1)

    for d in dates:
        try:
            row = q("""INSERT INTO scheduling.leave_requests
                       (staff_id,date,leave_type,status,note,created_by)
                       VALUES (%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (staff_id,date) DO UPDATE
                       SET leave_type=EXCLUDED.leave_type,note=EXCLUDED.note,
                           status=EXCLUDED.status,created_by=EXCLUDED.created_by
                       RETURNING id,staff_id,TO_CHAR(date,'YYYY-MM-DD') AS date,
                                 leave_type,status,note,created_by,created_at""",
                    (staff_id, d, leave_type, new_status, note, user["id"]), one=True)
            if row: leaves.append(row)
        except Exception: pass

    if new_status == "pending" and leaves:
        notify_roles(("manager", "superadmin"),
                     f"{staff['name']}: {len(leaves)} day(s) {leave_type} leave awaiting approval",
                     link="leaves", ntype="leave")
    return {"inserted": len(leaves), "leaves": leaves, "status": new_status}

@app.delete("/api/leaves/{lid}")
def delete_leave(lid: int, user=Depends(require_admin)):
    # A team lead may only delete leaves for their own branch's staff.
    lv = q("""SELECT s.branch_id FROM scheduling.leave_requests l
              JOIN scheduling.staff s ON s.id=l.staff_id WHERE l.id=%s""",
           (lid,), one=True)
    if not lv:
        raise HTTPException(404, "Leave not found")
    if not can_access_branch(user, lv["branch_id"]):
        raise HTTPException(403, "Forbidden")
    q("DELETE FROM scheduling.leave_requests WHERE id=%s", (lid,), exec_only=True)
    return {"ok": True}

@app.put("/api/leaves/{lid}/status")
async def update_leave_status(lid: int, request: Request, user=Depends(require_reviewer)):
    """A reviewer (manager / full admin) approves or rejects a pending leave."""
    body = await request.json()
    status = body.get("status")
    if status not in ("approved", "rejected"):
        raise HTTPException(400, "status must be 'approved' or 'rejected'")
    lv = q("""SELECT l.created_by, l.leave_type, TO_CHAR(l.date,'YYYY-MM-DD') AS date,
                     s.name AS staff_name
              FROM scheduling.leave_requests l
              JOIN scheduling.staff s ON s.id=l.staff_id WHERE l.id=%s""", (lid,), one=True)
    if not lv:
        raise HTTPException(404, "Leave not found")
    row = q("""UPDATE scheduling.leave_requests SET status=%s WHERE id=%s
               RETURNING id,staff_id,TO_CHAR(date,'YYYY-MM-DD') AS date,leave_type,status,note""",
            (status, lid), one=True)
    insert_audit(user, f"LEAVE_{status.upper()}", f"leave:{lid}", f"{lv['staff_name']} {lv['date']}")
    if lv.get("created_by"):
        notify(lv["created_by"],
               f"{lv['staff_name']}'s {lv['leave_type']} leave on {lv['date']} was {status}",
               link="leaves", ntype=status)
    return row

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

# ── Shift swaps ───────────────────────────────────────────────────────────────

def _swap_with_names(extra_where="", vals=()):
    return q(f"""SELECT sw.*,
                        TO_CHAR(sw.date_a,'YYYY-MM-DD') AS date_a,
                        TO_CHAR(sw.date_b,'YYYY-MM-DD') AS date_b,
                        sa.name AS staff_a_name, sb.name AS staff_b_name,
                        b.name AS branch_name
                 FROM scheduling.shift_swaps sw
                 JOIN scheduling.staff sa ON sa.id=sw.staff_a
                 JOIN scheduling.staff sb ON sb.id=sw.staff_b
                 LEFT JOIN scheduling.branches b ON b.id=sw.branch_id
                 {extra_where} ORDER BY sw.created_at DESC LIMIT 200""", vals)

@app.get("/api/swaps")
def list_swaps(request: Request, user=Depends(get_current_user)):
    p = request.query_params
    conds, vals = [], []
    # Team leads only see their own branch; reviewers can filter by branch.
    if user["role"] in ("superadmin", "manager"):
        if p.get("branch_id"): conds.append("sw.branch_id=%s"); vals.append(p["branch_id"])
    else:
        conds.append("sw.branch_id=%s"); vals.append(user.get("branch_id"))
    if p.get("status"): conds.append("sw.status=%s"); vals.append(p["status"])
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    return _swap_with_names(where, vals)

@app.post("/api/swaps")
async def create_swap(request: Request, user=Depends(require_editor)):
    body = await request.json()
    staff_a, date_a = body.get("staff_a"), body.get("date_a")
    staff_b, date_b = body.get("staff_b"), body.get("date_b")
    note = body.get("note")
    if not all([staff_a, date_a, staff_b, date_b]):
        raise HTTPException(400, "staff_a, date_a, staff_b, date_b are required")
    sa = q("SELECT branch_id,name FROM scheduling.staff WHERE id=%s", (staff_a,), one=True)
    sb = q("SELECT branch_id,name FROM scheduling.staff WHERE id=%s", (staff_b,), one=True)
    if not sa or not sb:
        raise HTTPException(404, "Staff not found")
    if not can_access_branch(user, sa["branch_id"]):
        raise HTTPException(403, "Forbidden")
    try:
        year, month = int(date_a[:4]), int(date_a[5:7])
    except (ValueError, IndexError):
        raise HTTPException(400, "date_a must be YYYY-MM-DD")
    row = q("""INSERT INTO scheduling.shift_swaps
               (branch_id,year,month,staff_a,date_a,staff_b,date_b,note,created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (sa["branch_id"], year, month, staff_a, date_a, staff_b, date_b, note, user["id"]), one=True)
    insert_audit(user, "SWAP_REQUEST", f"swap:{row['id']}", f"{sa['name']} {date_a} ↔ {sb['name']} {date_b}")
    notify_roles(("manager", "superadmin"),
                 f"Swap request: {sa['name']} ({date_a}) ↔ {sb['name']} ({date_b})",
                 link="swaps", ntype="swap")
    return {"id": row["id"], "ok": True}

@app.put("/api/swaps/{swid}/status")
async def decide_swap(swid: int, request: Request, user=Depends(require_reviewer)):
    body = await request.json()
    status = body.get("status")
    if status not in ("approved", "rejected"):
        raise HTTPException(400, "status must be 'approved' or 'rejected'")
    sw = q("SELECT * FROM scheduling.shift_swaps WHERE id=%s", (swid,), one=True)
    if not sw:
        raise HTTPException(404, "Swap not found")
    if sw["status"] != "pending":
        raise HTTPException(400, f"Swap already {sw['status']}")

    if status == "approved":
        # Exchange the two cells on the relevant schedule. Missing cells count
        # as Off ('O') so a swap with an empty day still works.
        sched = q("""SELECT id FROM scheduling.schedules
                     WHERE branch_id=%s AND year=%s AND month=%s""",
                  (sw["branch_id"], sw["year"], sw["month"]), one=True)
        if not sched:
            raise HTTPException(409, "No schedule exists for this month to swap")
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

    q("""UPDATE scheduling.shift_swaps SET status=%s, decided_by=%s, decided_at=NOW()
         WHERE id=%s""", (status, user["id"], swid), exec_only=True)
    insert_audit(user, f"SWAP_{status.upper()}", f"swap:{swid}")
    if sw.get("created_by"):
        notify(sw["created_by"], f"Your shift swap request was {status}", link="swaps", ntype=status)
    return {"ok": True, "status": status}

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

# ── Audit ─────────────────────────────────────────────────────────────────────

@app.get("/api/audit")
def get_audit(user=Depends(require_admin)):
    return q("""SELECT id,username,role,branch,action,target,detail,created_at
                FROM scheduling.audit_log ORDER BY created_at DESC LIMIT 500""")

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
def get_nest_config(nest_key: str, user=Depends(get_current_user)):
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
def allowed_shifts(request: Request, user=Depends(get_current_user)):
    branch_id = request.query_params.get("branch_id")
    if not branch_id: raise HTTPException(400, "branch_id required")
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
    import sys as _sys
    _sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scheduler'))
    from generator import generate_schedule as solver_generate, NESTS as _NESTS_DEFAULT

    body = await request.json()
    branch_id = body.get("branch_id")
    year      = body.get("year")
    month     = body.get("month")

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
        if st in ("submitted", "reviewed"):
            raise HTTPException(403, "Schedule is locked (submitted for review). Withdraw it first to regenerate.")
        if st == "approved":
            raise HTTPException(403, "Schedule is approved and locked. Ask a manager to return it before regenerating.")
        raise HTTPException(403, "Schedule is locked. Unlock it (the 🔒 toggle) before regenerating.")

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
    branch     = q("SELECT id,name FROM scheduling.branches WHERE id=%s", (branch_id,), one=True)
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
        }
        section_limits_for_solver[sec["section_name"]] = {"max_consecutive": sec_max_consecutive}
        print(f"[Generate] section={sec['section_name']} min_m={min_m} max_m={max_m} min_n={min_n} max_n={max_n} max_consecutive={sec_max_consecutive}")

    # Prev tail
    prev_tail_by_solver = {}
    for row in prev_tail:
        sid = int(row["staff_id"])
        solver_key = solver_key_by_staff_id.get(sid)
        if not solver_key:
            continue
        prev_tail_by_solver.setdefault(solver_key, []).append(row["shift_code"])

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

        # If an explicit DB min is set, honour it but keep it within the ceiling.
        eff_min = min(max(int(db_min_shifts or 0), eff_target), ceiling)
        eff_min = max(0, eff_min)

        # Give the solver a small upward tolerance (+1) so it can balance fairness
        # and coverage, but never exceed the ceiling.
        eff_max = min(ceiling, max(eff_min, eff_target + 1))

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

    # Patch NESTS so the solver reads the DB-provided config.
    import generator as _gen
    original_nests = _gen.NESTS
    patched = dict(original_nests)
    patched[nest_name] = nest_cfg_for_solver
    _gen.NESTS = patched

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
        if k > 0:
            need_per_day = min_m + min_n
            min_staff_for_coverage = int(_m2.ceil(need_per_day * (k + 2) / k))
            if len(staff_keys) < min_staff_for_coverage:
                msgs.append(
                    f"Not enough staff for daily coverage under the {k}-on/2-off rule: need ~{min_staff_for_coverage} active staff, have {len(staff_keys)}."
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

    flat_entries = []
    summary      = []
    total_work   = 0
    section_results = {}

    # Generate per section independently so one failing section doesn't block others.
    for sec_name, sec_cfg in nest_cfg_for_solver["sections"].items():
        staff_keys = list(sec_cfg.get("staff") or [])
        if not staff_keys:
            section_results[sec_name] = {"status": "SKIPPED", "error": "No staff in section"}
            continue

        # Note: AL validation is not enforced here.

        sec_al = {sk: al_schedule.get(sk, []) for sk in staff_keys if sk in al_schedule}
        sec_prev_tail = {sk: prev_tail_by_solver.get(sk, []) for sk in staff_keys if sk in prev_tail_by_solver}
        sec_staff_limits = {sk: staff_limits.get(sk, {}) for sk in staff_keys}
        sec_limits = {sec_name: section_limits_for_solver.get(sec_name, {})}

        # Patch solver nests with only this section
        sec_nest_cfg = {"sections": {sec_name: sec_cfg}}
        _gen.NESTS = dict(original_nests)
        _gen.NESTS[nest_name] = sec_nest_cfg

        sec_result = solver_generate(
            nest_name=nest_name, year=year, month=month,
            al_schedule=sec_al, prev_tail=sec_prev_tail,
            time_limit=120,
            max_consecutive=max_consecutive,
            staff_limits=sec_staff_limits,
            section_limits=sec_limits,
        )

        if sec_result["status"] == "INFEASIBLE" or not sec_result.get("schedule"):
            section_results[sec_name] = {
                "status": sec_result.get("status"),
                "error": "Section infeasible",
                "diagnostics": section_diagnostics(sec_name, sec_cfg, staff_keys),
            }
            continue

        section_results[sec_name] = {
            "status": sec_result["status"],
            "elapsed": sec_result.get("elapsed"),
            "staff": staff_keys,
        }

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

    # restore nests
    _gen.NESTS = original_nests

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

    q("DELETE FROM scheduling.schedule_entries WHERE schedule_id=%s", (schedule["id"],), exec_only=True)

    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            for e in flat_entries:
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
