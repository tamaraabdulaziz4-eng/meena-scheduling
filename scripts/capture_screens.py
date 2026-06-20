"""Capture REAL screenshots of the running app (actual HTML/CSS) with
Chrome-for-Testing via Playwright, after seeding realistic demo data."""
import os, sys, time, subprocess, datetime, signal

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "docs", "screens")
os.makedirs(OUT, exist_ok=True)
CHROME = "/opt/cft/chrome-linux64/chrome"
PORT = 8099
BASE = f"http://127.0.0.1:{PORT}"

os.environ["DATABASE_URL"] = "postgresql://pgtest@/meena_guide?host=/var/run/postgresql"
os.environ["COOKIE_SECURE"] = "0"
os.environ["APP_URL"] = "https://schedule.meena.health"   # clean link text in Settings
os.environ["SMTP_CAPTURE"] = "1"
os.environ["DISABLE_SCHEDULER"] = "1"

import server.main as M

def seed():
    M.init_schema(); M.seed_defaults(); M.seed_nest_config(); M.seed_admin()
    q = M.q
    admin = q("SELECT id FROM scheduling.users WHERE username='admin'", one=True)["id"]
    branches = q("SELECT id,name FROM scheduling.branches ORDER BY id")
    b = branches[0]["id"]
    now = datetime.date.today(); Y, Mo = now.year, now.month
    names = ["Sara Al-Harbi", "Mohammed Al-Otaibi", "Khalid Al-Qahtani",
             "Aisha Al-Zahrani", "Noura Al-Shehri", "Reem Al-Dosari"]
    sids = []
    for i, nm in enumerate(names):
        r = q("""INSERT INTO scheduling.staff (name,branch_id,employee_id,speciality,active)
                 VALUES (%s,%s,%s,'{General}',true) RETURNING id""",
              (nm, b, f"10{4000+i}"), one=True)
        sids.append(r["id"])
    # a staff login (linked to the first staff) so we can shoot the staff portal
    pw = M.bcrypt.hashpw(b"staff123", M.bcrypt.gensalt()).decode()
    q("""INSERT INTO scheduling.users (username,password,role,branch_id,staff_id,email)
         VALUES ('sara.h',%s,'staff',%s,%s,'sara@example.com')
         ON CONFLICT (username) DO NOTHING""", (pw, b, sids[0]), exec_only=True)
    # manager (all branches) + team-lead (branch-locked) logins for role-accurate shots
    mpw = M.bcrypt.hashpw(b"manager123", M.bcrypt.gensalt()).decode()
    q("""INSERT INTO scheduling.users (username,password,role,email)
         VALUES ('khalid.m',%s,'manager','khalid@example.com')
         ON CONFLICT (username) DO NOTHING""", (mpw,), exec_only=True)
    tpw = M.bcrypt.hashpw(b"lead123", M.bcrypt.gensalt()).decode()
    q("""INSERT INTO scheduling.users (username,password,role,branch_id,email)
         VALUES ('noura.l',%s,'admin',%s,'noura@example.com')
         ON CONFLICT (username) DO NOTHING""", (tpw, b), exec_only=True)
    # schedule (approved) + entries for the current month
    sch = q("""INSERT INTO scheduling.schedules (branch_id,year,month,status,is_locked,created_by,approved_by,reviewed_by)
               VALUES (%s,%s,%s,'approved',true,%s,%s,%s)
               ON CONFLICT (branch_id,year,month) DO UPDATE SET status='approved' RETURNING id""",
            (b, Y, Mo, admin, admin, admin), one=True)["id"]
    codes = ["M", "M", "E", "N", "D", "O", "O", "AL"]
    import calendar
    ndays = calendar.monthrange(Y, Mo)[1]
    for r, sid in enumerate(sids):
        for d in range(1, ndays + 1):
            code = codes[(r + d) % len(codes)]
            q("""INSERT INTO scheduling.schedule_entries (schedule_id,staff_id,date,shift_code)
                 VALUES (%s,%s,%s,%s) ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET shift_code=EXCLUDED.shift_code""",
              (sch, sid, f"{Y}-{Mo:02d}-{min(d,ndays):02d}", code), exec_only=True)
    # leaves in various stages
    leave_rows = [(sids[0], 10, "AL", "pending"), (sids[1], 14, "AL", "lead_approved"),
                  (sids[2], 6, "SL", "approved"), (sids[3], 20, "AL", "rejected")]
    for sid, day, tp, st in leave_rows:
        q("""INSERT INTO scheduling.leave_requests (staff_id,date,leave_type,status,created_by)
             VALUES (%s,%s,%s,%s,%s) ON CONFLICT (staff_id,date) DO UPDATE SET status=EXCLUDED.status,leave_type=EXCLUDED.leave_type""",
          (sid, f"{Y}-{Mo:02d}-{min(day,ndays):02d}", tp, st, admin), exec_only=True)
    # swaps in various stages
    swaps = [(sids[0], 1, sids[1], 2, "pending_manager"),
             (sids[2], 5, sids[3], 7, "pending_lead"),
             (sids[4], 9, sids[5], 10, "approved")]
    for sa, da, sb, db, st in swaps:
        q("""INSERT INTO scheduling.shift_swaps (branch_id,year,month,staff_a,date_a,staff_b,date_b,status,created_by)
             VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
          (b, Y, Mo, sa, f"{Y}-{Mo:02d}-0{da}", sb, f"{Y}-{Mo:02d}-{db:02d}", st, admin), exec_only=True)
    # daily cases for the KSA reporting day across a few branches (submitted)
    today = M._operational_date_server()
    cases = [(branches[0]["id"], 18, 0, 18, 1, 1, 62), (branches[1]["id"], 7, 7, 15, 3, 0, 47),
             (branches[2]["id"], 18, 5, 10, 1, 1, 79)]
    for bid, xr, ct, us, mamo, bmd, pt in cases:
        q("""INSERT INTO scheduling.daily_cases (branch_id,date,xray,ct,us,mamo,bmd,total_pt,locked,submitted_by,submitted_at)
             VALUES (%s,%s,%s,%s,%s,%s,%s,%s,true,%s,NOW())
             ON CONFLICT (branch_id,date) DO UPDATE SET xray=EXCLUDED.xray,ct=EXCLUDED.ct,us=EXCLUDED.us,
               mamo=EXCLUDED.mamo,bmd=EXCLUDED.bmd,total_pt=EXCLUDED.total_pt,locked=true,submitted_by=EXCLUDED.submitted_by""",
          (bid, today, xr, ct, us, mamo, bmd, pt, admin), exec_only=True)
    # open registration so the links show
    q("""INSERT INTO scheduling.app_settings (key,value) VALUES ('registration_code','4821')
         ON CONFLICT (key) DO UPDATE SET value='4821'""", exec_only=True)
    print("seeded. branch", b, "month", Y, Mo, "cases-date", today)
    return "4821", b


def wait_up():
    import urllib.request
    for _ in range(60):
        try:
            urllib.request.urlopen(BASE + "/", timeout=2); return True
        except Exception:
            time.sleep(0.5)
    return False


def capture(code, bid):
    from playwright.sync_api import sync_playwright
    shots = [0]
    with sync_playwright() as p:
        br = p.chromium.launch(executable_path=CHROME, headless=True,
                               args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"])

        def snap(pg, name, el=None):
            try:
                (pg.locator(el) if el else pg).screenshot(path=os.path.join(OUT, name))
                shots[0] += 1; print("shot", name)
            except Exception as e:
                print("FAIL", name, e)

        def login_session(username, password):
            ctx = br.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
            pg = ctx.new_page()
            pg.goto(BASE + "/", wait_until="networkidle")
            pg.fill("#login-username", username); pg.fill("#login-password", password)
            pg.evaluate("doLogin()"); pg.wait_for_timeout(4500)
            try: pg.wait_for_selector("#sidebar-user", timeout=8000)
            except Exception: pass
            return ctx, pg

        def shoot(pg, route, name, wait=1800, before=None, el=None):
            pg.evaluate(f"window.showPage && showPage('{route}')")
            pg.wait_for_timeout(wait)
            try: pg.wait_for_load_state("networkidle")
            except Exception: pass
            if before:
                pg.evaluate(before); pg.wait_for_timeout(1800)
                try: pg.wait_for_load_state("networkidle")
                except Exception: pass
            snap(pg, name, el)

        # ── Pre-auth: login + sign-up (full form) ──
        ctx0 = br.new_context(viewport={"width": 1280, "height": 820}, device_scale_factor=2)
        pg0 = ctx0.new_page()
        pg0.goto(BASE + "/", wait_until="networkidle"); pg0.wait_for_timeout(900)
        snap(pg0, "login.png")
        pg0.set_viewport_size({"width": 1280, "height": 1180})
        pg0.goto(f"{BASE}/?register={code}", wait_until="networkidle"); pg0.wait_for_timeout(1400)
        try:
            pg0.fill("#reg-name", "Sara Al-Harbi")
            pg0.select_option("#reg-branch", index=1)
            pg0.fill("#reg-empid", "1043887"); pg0.fill("#reg-email", "sara@example.com")
            pg0.fill("#reg-username", "sara.h"); pg0.fill("#reg-password", "secret12")
            pg0.fill("#reg-password2", "secret12")
        except Exception as e: print("signup fill", e)
        pg0.wait_for_timeout(400); snap(pg0, "signup.png"); ctx0.close()

        BR_BEFORE = f"() => {{ const s=document.getElementById('sched-branch-select'); if(s){{ s.value='{bid}'; onBranchChange(); }} }}"

        # ── Super admin (Overview deck + neutral report/links) ──
        ctx, pg = login_session("admin", "admin123")
        shoot(pg, "home", "home.png", 2000)
        shoot(pg, "schedule", "schedule.png", 2400, before=BR_BEFORE)
        shoot(pg, "leaves", "leave.png")
        shoot(pg, "swaps", "swaps.png")
        shoot(pg, "review", "review.png")
        shoot(pg, "cases", "cases.png", 2200)
        try:  # real branded report (sidebar-less element → role-neutral)
            pg.evaluate("showPage('cases')"); pg.wait_for_timeout(2000)
            pg.evaluate("""() => { const r=document.getElementById('report-root');
                r.innerHTML = buildCasesReport(); r.style.display='block'; r.style.maxWidth='820px'; }""")
            pg.wait_for_timeout(800); snap(pg, "report.png", "#report-root")
            pg.evaluate("() => { document.getElementById('report-root').style.display='none'; }")
        except Exception as e: print("report", e)
        try:
            pg.evaluate("openHolidaysModal()"); pg.wait_for_timeout(1500); snap(pg, "links.png")
        except Exception as e: print("links", e)
        try:
            pg.evaluate("openChangePassword()"); pg.wait_for_timeout(700); snap(pg, "changepw.png")
        except Exception as e: print("changepw", e)
        ctx.close()

        # ── Manager session (no admin tools / no Branches-Shifts-Users-Audit) ──
        ctx, pg = login_session("khalid.m", "manager123")
        shoot(pg, "home", "mgr_home.png", 2000)
        shoot(pg, "review", "mgr_review.png")
        shoot(pg, "leaves", "mgr_leave.png")
        shoot(pg, "swaps", "mgr_swaps.png")
        shoot(pg, "cases", "mgr_cases.png", 2200)
        ctx.close()

        # ── Team-lead session (branch-locked, no Review/admin tools) ──
        ctx, pg = login_session("noura.l", "lead123")
        shoot(pg, "home", "tl_home.png", 2000)
        shoot(pg, "schedule", "tl_schedule.png", 2400)
        shoot(pg, "leaves", "tl_leave.png")
        shoot(pg, "swaps", "tl_swaps.png")
        shoot(pg, "cases", "tl_cases.png", 2200)
        ctx.close()

        # ── Staff portal session ──
        ctx, pg = login_session("sara.h", "staff123")
        pg.wait_for_timeout(1200); snap(pg, "myschedule.png")
        shoot(pg, "leaves", "staff_leave.png")
        shoot(pg, "swaps", "staff_swaps.png")
        shoot(pg, "cases", "staff_cases.png", 2200)
        try:
            pg.evaluate("openChangePassword()"); pg.wait_for_timeout(700); snap(pg, "staff_changepw.png")
        except Exception as e: print("staff changepw", e)
        ctx.close()
        br.close()
    print("captured", shots[0], "screens")


if __name__ == "__main__":
    # fresh db (this process already runs as the pgtest OS user)
    subprocess.run(["psql", "-h", "/var/run/postgresql", "-d", "postgres",
                    "-c", "DROP DATABASE IF EXISTS meena_guide"], check=False)
    subprocess.run(["psql", "-h", "/var/run/postgresql", "-d", "postgres",
                    "-c", "CREATE DATABASE meena_guide"], check=False)
    code, bid = seed()
    srv = subprocess.Popen([sys.executable, "-m", "uvicorn", "server.main:app",
                            "--host", "127.0.0.1", "--port", str(PORT), "--log-level", "warning"],
                           cwd=ROOT, env=os.environ.copy())
    try:
        if not wait_up():
            print("server did not start"); srv.terminate(); sys.exit(1)
        capture(code, bid)
    finally:
        srv.send_signal(signal.SIGINT); time.sleep(1); srv.terminate()
