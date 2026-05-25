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

# ── DB ────────────────────────────────────────────────────────────────────────

def get_conn():
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)

def q(sql, params=(), *, one=False, many=False, exec_only=False):
    """Run a query. Returns row(s) as plain dict(s)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            if exec_only:
                conn.commit()
                return None
            conn.commit()
            if one:
                row = cur.fetchone()
                return dict(row) if row else None
            if many:
                return [dict(r) for r in cur.fetchall()]
            # default: return all rows
            return [dict(r) for r in cur.fetchall()]

# ── Schema init ───────────────────────────────────────────────────────────────

def init_schema():
    with get_conn() as conn:
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
            cur.execute("ALTER TABLE scheduling.staff ADD COLUMN IF NOT EXISTS phase INTEGER NOT NULL DEFAULT 0;")

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
    nests = [
        # NEST1
        dict(nest_key='NEST1', section_name='General', sort_order=0,
             staff=['WAFA','CHERYL','MUHANNED','ELHAM','AMINAH','MNAYER'],
             staff_db_names={'WAFA':'Wafa Assiri','CHERYL':'Cheryl','MUHANNED':'Muhanned',
                             'ELHAM':'Elham','AMINAH':'Aminah','MNAYER':'Mnayer'},
             allowed_shifts=['D','M','N','O','AL','SL'],
             coverage={'weekday':{'M':1,'N':1},'weekend':{'M':1,'N':1}},
             exact_coverage={'N':1}),
        dict(nest_key='NEST1', section_name='US', sort_order=1,
             staff=['RAWAN','ALANOOD','ALNOUD','TAGREED','SADEEM'],
             staff_db_names={'RAWAN':'Rawan','ALANOOD':'Alanood','ALNOUD':'Alnoud Alrashdi',
                             'TAGREED':'Tagreed','SADEEM':'Sadeem'},
             allowed_shifts=['M','N','O','AL','SL'],
             coverage={'weekday':{'M':1,'N':1},'weekend':{'M':1,'N':1}},
             exact_coverage={'N':1}),
        # NEST2
        dict(nest_key='NEST2', section_name='General', sort_order=0,
             staff=['BADRIH','DALAL','WEDAD','LAYAN','FATIN','NAIF','MOHAMMED_BATT'],
             staff_db_names={'BADRIH':'Badrih','DALAL':'Dalal','WEDAD':'Wedad','LAYAN':'Layan',
                             'FATIN':'Fatin','NAIF':'Naif','MOHAMMED_BATT':'Mohammed Batt'},
             allowed_shifts=['M','N','N6','D1','Y3','O','AL','SL','OC'],
             coverage={'weekday':{'M':1,'N':1},'weekend':{'M':1,'N':1}},
             exact_coverage={}),
        dict(nest_key='NEST2', section_name='US', sort_order=1,
             staff=['ALHANOUF_BIN_AMMAR','HAJER','JOY','ALHANOUF_ALAZMI'],
             staff_db_names={'ALHANOUF_BIN_AMMAR':'Alhanouf Bin Ammar','HAJER':'Hajer AL Mutiri',
                             'JOY':'Joy','ALHANOUF_ALAZMI':'Alhanouf Alazmi'},
             allowed_shifts=['D','D1','N6','O','AL','SL','OC'],
             coverage={'weekday':{'D':1,'N6':1},'weekend':{'D':1}},
             exact_coverage={}),
        # NEST3
        dict(nest_key='NEST3', section_name='General', sort_order=0,
             staff=['DUAA','RAWAN','NOURAH','ABDULAZIZ','BUSHRA'],
             staff_db_names={'DUAA':'Duaa','RAWAN':'Rawan Alharbi','NOURAH':'Nourah',
                             'ABDULAZIZ':'Abdulaziz Alanazi','BUSHRA':'Bushra Alqahani'},
             allowed_shifts=['M','N','A','O','AL','SL','OC'],
             coverage={'weekday':{'M':1,'N':1},'weekend':{'M':1,'N':1}},
             exact_coverage={}),
        dict(nest_key='NEST3', section_name='US', sort_order=1,
             staff=['ALMA','MANAR','QAMRAA','REEM'],
             staff_db_names={'ALMA':'Alma Tolentino','MANAR':'Manar',
                             'QAMRAA':'Qamraa','REEM':'Reem Alharbi'},
             allowed_shifts=['D','D1','EV','N','A','O','AL','SL','OC'],
             coverage={'weekday':{'D':1,'N':1},'weekend':{'D':1}},
             exact_coverage={}),
        # NEST4
        dict(nest_key='NEST4', section_name='General', sort_order=0,
             staff=['SARAH','AROB'],
             staff_db_names={'SARAH':'Sara Halawani','AROB':'Arob'},
             allowed_shifts=['D','EV','O','AL','SL','OC'],
             coverage={},
             exact_coverage={}),
        dict(nest_key='NEST4', section_name='US', sort_order=1,
             staff=['RANA','AESHAH','TAIF','ALAA'],
             staff_db_names={'RANA':'Rana','AESHAH':'Aeshah','TAIF':'Taif','ALAA':'Alaa'},
             allowed_shifts=['M','N','B','O','AL','SL','OC'],
             coverage={'weekday':{'M':1,'N':1},'weekend':{'M':1,'N':1}},
             exact_coverage={}),
        # NEST6
        dict(nest_key='NEST6', section_name='General', sort_order=0,
             staff=['MOHAMMED','NAIF_ALMUTARI','RUBA','SHAHAD','WEDAD','LAYAN','DALAL','NAIF'],
             staff_db_names={'MOHAMMED':'Mohammed','NAIF_ALMUTARI':'Naif Almutari','RUBA':'Ruba',
                             'SHAHAD':'Shahad','WEDAD':'Wedad N6','LAYAN':'Layan N6',
                             'DALAL':'Dalal N6','NAIF':'Naif'},
             allowed_shifts=['D','M','N','EV','Y3','O','AL','SL','OC'],
             coverage={'weekday':{'D':1,'M':1,'N':1},'weekend':{'M':1,'N':1}},
             exact_coverage={}),
        dict(nest_key='NEST6', section_name='US', sort_order=1,
             staff=['RANA','MEYAN','ALANOUD','HAJER','ALMA'],
             staff_db_names={'RANA':'Rana N6','MEYAN':'Meyan','ALANOUD':'Alanoud N6',
                             'HAJER':'Hajer N6','ALMA':'Alma N6'},
             allowed_shifts=['A','B','C','D','M','N','O','AL','SL','OC'],
             coverage={'weekday':{'A':1,'B':1,'N':1},'weekend':{'A':1,'B':1}},
             exact_coverage={}),
        # Y5
        dict(nest_key='Y5', section_name='General', sort_order=0,
             staff=['MANAL'],
             staff_db_names={'MANAL':'Manal Salem'},
             allowed_shifts=['A','O','OC','AL','SL'],
             coverage={},
             exact_coverage={}),
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
    if user.get("role") not in ("admin", "superadmin"):
        raise HTTPException(403, "Forbidden")
    return user

def require_superadmin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "superadmin":
        raise HTTPException(403, "Forbidden")
    return user

def can_access_branch(user: dict, branch_id) -> bool:
    if user.get("role") == "superadmin":
        return True
    return str(user.get("branch_id")) == str(branch_id)

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

def get_nest_sections(nest_key: str) -> list:
    rows = q("""SELECT id,nest_key,section_name,staff,staff_db_names,
                       allowed_shifts,coverage,exact_coverage,sort_order,updated_at
                FROM scheduling.nest_sections WHERE nest_key=%s
                ORDER BY sort_order,section_name""", (nest_key,))
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
    return FileResponse(os.path.join(DASHBOARD, "style.css"))

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
    if user["role"] != "superadmin":
        branch_id = user.get("branch_id")
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
    for field in ("name","phone","branch_id","speciality","is_cross_branch","active","phase"):
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

# ── Shift Types ───────────────────────────────────────────────────────────────

@app.get("/api/shift-types")
def get_shift_types(request: Request, user=Depends(get_current_user)):
    branch_id = request.query_params.get("branch_id") or user.get("branch_id") or 0
    rows = q("""SELECT DISTINCT ON (code) id,branch_id,code,label,start_time,end_time,
                       color,is_off,is_leave,is_oncall,sort_order
                FROM scheduling.shift_types
                WHERE branch_id IS NULL OR branch_id=%s
                ORDER BY code, branch_id DESC NULLS LAST, sort_order""", (branch_id,))
    return sorted(rows, key=lambda r: r["sort_order"])

@app.get("/api/shift-types/all")
def get_all_shift_types(user=Depends(get_current_user)):
    return q("""SELECT st.id,st.branch_id,st.code,st.label,st.start_time,st.end_time,
                       st.color,st.is_off,st.is_leave,st.is_oncall,st.sort_order,
                       b.name AS branch_name
                FROM scheduling.shift_types st
                LEFT JOIN scheduling.branches b ON b.id=st.branch_id
                ORDER BY st.code, st.branch_id NULLS FIRST, st.sort_order""")

@app.post("/api/shift-types")
async def upsert_shift_type(request: Request, user=Depends(require_admin)):
    body = await request.json()
    bid  = body.get("branch_id") or None
    code = body.get("code")
    existing = q("SELECT id FROM scheduling.shift_types WHERE branch_id IS NULL AND code=%s" if bid is None
                 else "SELECT id FROM scheduling.shift_types WHERE branch_id=%s AND code=%s",
                 (code,) if bid is None else (bid, code), one=True)
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
             (bid, code, body.get("label"), body.get("start_time"), body.get("end_time"),
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
    branch_id = request.query_params.get("branch_id") if user["role"]=="superadmin" else user.get("branch_id")
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
async def save_entry(sid: int, request: Request, user=Depends(require_admin)):
    body = await request.json()
    # Block edits if schedule is locked
    sched = q("SELECT is_locked FROM scheduling.schedules WHERE id=%s", (sid,), one=True)
    if sched and sched.get("is_locked"):
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
async def bulk_save_entries(sid: int, request: Request, user=Depends(require_admin)):
    body = await request.json()
    entries = body.get("entries", [])
    if not isinstance(entries, list): raise HTTPException(400, "entries must be array")
    with get_conn() as conn:
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
    insert_audit(user, "BULK_SAVE", f"schedule:{sid}", f"{len(entries)} entries")
    return {"ok": True, "count": len(entries)}

@app.delete("/api/schedules/{sid}/entries")
def clear_entries(sid: int, user=Depends(require_admin)):
    q("DELETE FROM scheduling.schedule_entries WHERE schedule_id=%s", (sid,), exec_only=True)
    return {"ok": True}

@app.delete("/api/schedules/{sid}/entries/cell")
async def delete_entry_cell(sid: int, request: Request, user=Depends(require_admin)):
    """Delete a single cell entry (makes it blank on the grid)."""
    body = await request.json()
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
async def toggle_schedule_lock(sid: int, request: Request, user=Depends(require_admin)):
    """Lock or unlock an entire schedule (branch+month). Locked schedules block all edits."""
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
    body = await request.json()
    status = body.get("status")
    if status not in ("draft","submitted","reviewed","approved"):
        raise HTTPException(400, "Invalid status")
    if status == "reviewed" and user["role"] == "admin":
        raise HTTPException(403, "Only supervisor/superadmin can review")
    if status == "approved" and user["role"] != "superadmin":
        raise HTTPException(403, "Only manager can approve")

    sets = "status=%s, updated_at=NOW()"
    params = [status]
    if status == "reviewed":
        sets += ", reviewed_by=%s, reviewed_at=NOW()"; params.append(user["id"])
    if status == "approved":
        sets += ", approved_by=%s, approved_at=NOW()"; params.append(user["id"])
    params.append(sid)
    row = q(f"UPDATE scheduling.schedules SET {sets} WHERE id=%s RETURNING *", params, one=True)
    insert_audit(user, f"SCHEDULE_{status.upper()}", f"schedule:{sid}")
    return row

@app.delete("/api/schedules/{sid}")
def delete_schedule(sid: int, user=Depends(require_admin)):
    q("DELETE FROM scheduling.schedules WHERE id=%s", (sid,), exec_only=True)
    return {"ok": True}

# ── Leaves ────────────────────────────────────────────────────────────────────

@app.get("/api/leaves")
def list_leaves(request: Request, user=Depends(get_current_user)):
    params = request.query_params
    branch_id = params.get("branch_id") if user["role"]=="superadmin" else user.get("branch_id")
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

    # Expand date range
    from datetime import date as _date, timedelta as _td
    cur = _date(*map(int, date_from.split('-')))
    end = _date(*map(int, date_to.split('-')))
    dates, leaves = [], []
    while cur <= end and len(dates) < 365:
        dates.append(str(cur)); cur += _td(days=1)

    for d in dates:
        try:
            row = q("""INSERT INTO scheduling.leave_requests
                       (staff_id,date,leave_type,status,note,created_by)
                       VALUES (%s,%s,%s,'approved',%s,%s)
                       ON CONFLICT (staff_id,date) DO UPDATE
                       SET leave_type=EXCLUDED.leave_type,note=EXCLUDED.note,created_by=EXCLUDED.created_by
                       RETURNING id,staff_id,TO_CHAR(date,'YYYY-MM-DD') AS date,
                                 leave_type,status,note,created_by,created_at""",
                    (staff_id, d, leave_type, note, user["id"]), one=True)
            if row: leaves.append(row)
        except Exception: pass
    return {"inserted": len(leaves), "leaves": leaves}

@app.delete("/api/leaves/{lid}")
def delete_leave(lid: int, user=Depends(require_admin)):
    q("DELETE FROM scheduling.leave_requests WHERE id=%s", (lid,), exec_only=True)
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
    allowed_shifts = body.get("allowed_shifts", [])
    coverage       = body.get("coverage", {})
    exact_coverage = body.get("exact_coverage", {})
    sort_order     = body.get("sort_order", 0)

    if not isinstance(staff, list): raise HTTPException(400, "staff must be array")
    if not isinstance(allowed_shifts, list): raise HTTPException(400, "allowed_shifts must be array")

    row = q("""INSERT INTO scheduling.nest_sections
               (nest_key,section_name,staff,staff_db_names,allowed_shifts,
                coverage,exact_coverage,sort_order,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,NOW())
               ON CONFLICT (nest_key,section_name) DO UPDATE SET
               staff=%s,staff_db_names=%s,allowed_shifts=%s,
               coverage=%s,exact_coverage=%s,sort_order=%s,updated_at=NOW()
               RETURNING *""",
            (nest_key, section_name, staff, json.dumps(staff_db_names), allowed_shifts,
             json.dumps(coverage), json.dumps(exact_coverage), sort_order,
             # DO UPDATE
             staff, json.dumps(staff_db_names), allowed_shifts,
             json.dumps(coverage), json.dumps(exact_coverage), sort_order),
            one=True)
    insert_audit(user, "UPDATE_NEST_CONFIG", f"{nest_key}/{section_name}",
                 f"staff={len(staff)} allowed_shifts={','.join(allowed_shifts)}")
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
async def generate_schedule(request: Request, user=Depends(require_admin)):
    import sys as _sys
    _sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scheduler'))
    from generator import generate_schedule as solver_generate, NESTS as _NESTS_DEFAULT

    body = await request.json()
    branch_id = body.get("branch_id")
    year      = body.get("year")
    month     = body.get("month")

    if not can_access_branch(user, branch_id):
        raise HTTPException(403, "Forbidden")

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
    if not nest_name:
        raise HTTPException(400, f'Branch "{branch["name"]}" not mapped to a nest')

    # Load nest config from DB
    nest_sections = get_nest_sections(nest_name)

    # Build nest config dict for solver
    nest_cfg_for_solver = {"sections": {}}
    for sec in nest_sections:
        nest_cfg_for_solver["sections"][sec["section_name"]] = {
            "staff":          sec["staff"],
            "staff_db_names": sec["staff_db_names"],
            "allowed_shifts": sec["allowed_shifts"],
            "coverage":       sec["coverage"],
            "exact":          sec["exact_coverage"],
        }

    # Build configJson: db_name_lower → solver_key
    config_json = {}
    for sec in nest_sections:
        for solver_key, db_name in (sec["staff_db_names"] or {}).items():
            config_json[db_name.lower().strip()] = solver_key

    # Build nameToStaff
    name_to_staff = {s["name"].lower().strip(): s for s in active_staff}

    # AL args
    al_by_staff = {}
    for lv in leaves:
        s = next((x for x in active_staff if x["id"] == lv["staff_id"]), None)
        if not s: continue
        day = int(lv["date"].split("-")[2])
        al_by_staff.setdefault(s["name"], []).append(day)

    al_schedule = {}
    for db_name, days in al_by_staff.items():
        solver_key = config_json.get(db_name.lower().strip())
        if solver_key:
            al_schedule[solver_key] = sorted(set(days))

    # Prev tail
    prev_tail_by_solver = {}
    for row in prev_tail:
        solver_key = config_json.get(row["staff_name"].lower().strip())
        if not solver_key: continue
        prev_tail_by_solver.setdefault(solver_key, []).append(row["shift_code"])

    # Patch NESTS with DB config and call solver directly (no subprocess)
    import generator as _gen
    original_nests = _gen.NESTS
    patched = dict(original_nests)          # start from the REAL current state
    patched[nest_name] = nest_cfg_for_solver
    _gen.NESTS = patched

    print(f"[Generate] nest={nest_name} sections={list(nest_cfg_for_solver['sections'].keys())}")
    print(f"[Generate] config_json keys={list(config_json.keys())}")
    print(f"[Generate] active_staff names={[s['name'] for s in active_staff]}")

    try:
        result = solver_generate(
            nest_name=nest_name, year=year, month=month,
            al_schedule=al_schedule, prev_tail=prev_tail_by_solver,
            dominant_shifts=None, time_limit=120,
        )
    finally:
        _gen.NESTS = original_nests  # restore

    print(f"[Generate] solver status={result['status']} schedule_keys={list(result.get('schedule',{}).keys())}")

    if result["status"] == "INFEASIBLE":
        raise HTTPException(422, detail={
            "error": "Solver could not find a valid schedule. Check staff count and AL dates.",
            "solver_status": result["status"]
        })

    if not result.get("schedule"):
        raise HTTPException(500, detail={
            "error": "Solver returned empty schedule",
            "solver_status": result["status"]
        })

    # Reverse map: solver_key → db_name_lower
    # config_json: db_name_lower → solver_key; if multiple db_names map to same solver_key,
    # the inversion keeps the last. Build a proper reverse map.
    solver_key_to_db = {}
    for db_name_l, sk in config_json.items():
        solver_key_to_db[sk] = db_name_l   # last one wins (same as before, but explicit)

    print(f"[Generate] solver_key_to_db={solver_key_to_db}")
    print(f"[Generate] name_to_staff keys={list(name_to_staff.keys())}")

    import calendar as _calendar
    days_in_month = _calendar.monthrange(year, month)[1]
    from datetime import date as _date

    flat_entries = []
    summary      = []
    total_work   = 0

    for solver_key, row in result["schedule"].items():
        db_name_l = solver_key_to_db.get(solver_key)
        staff     = name_to_staff.get(db_name_l) if db_name_l else None
        if not staff:
            print(f"[Generate] Solver key '{solver_key}' → '{db_name_l}' not matched — skipping")
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

    # Persist
    schedule = q("""INSERT INTO scheduling.schedules (branch_id,year,month,status,created_by)
                    VALUES (%s,%s,%s,'draft',%s)
                    ON CONFLICT (branch_id,year,month) DO UPDATE SET updated_at=NOW()
                    RETURNING *""",
                 (branch_id, year, month, user["id"]), one=True)

    q("DELETE FROM scheduling.schedule_entries WHERE schedule_id=%s", (schedule["id"],), exec_only=True)

    with get_conn() as conn:
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

    insert_audit(user, "GENERATE_SCHEDULE",
                 f"{year}-{month:02d}",
                 f"{len(summary)} staff · nest={nest_name} · solver={result['status']} · {result['elapsed']}s")

    avg = round(total_work / len(summary)) if summary else 0
    return {
        "schedule":      schedule,
        "entry_count":   len(flat_entries),
        "solver_status": result["status"],
        "solver_elapsed": result["elapsed"],
        "summary":       summary,
        "avg_shifts":    avg,
    }

# ── Catch-all: serve React/SPA frontend (must be LAST) ───────────────────────
@app.get("/")
@app.get("/{full_path:path}")
def serve_index(full_path: str = ""):
    return FileResponse(os.path.join(DASHBOARD, "index.html"))
