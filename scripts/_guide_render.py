"""Render REAL app screens (actual index.html + JS + CSS) for the manager guide
by serving the dashboard from disk and stubbing the API in Playwright — no live
server needed (the sandbox blocks network listeners)."""
import os, json, mimetypes
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DASH = os.path.join(ROOT, "dashboard")
OUT = os.path.join(ROOT, "docs", "guide_shots"); os.makedirs(OUT, exist_ok=True)
CHROME = "/opt/cft/chrome-linux64/chrome"
ORIGIN = "http://meena.local"

TODAY = "2026-06-22"
BR = [{"id": 1, "name": "NEST 1"}, {"id": 2, "name": "NEST 2"}, {"id": 3, "name": "NEST 3"},
      {"id": 4, "name": "NEST 4"}, {"id": 5, "name": "NEST 6"}, {"id": 6, "name": "Al-Jubail"}]
ME = {"id": 1, "username": "khalid", "role": "manager", "branch_id": None, "branch_name": None, "staff_id": None}

def staff(i, name, br, sec, emp, phone, bal, today=None, sh=18, lv=2):
    return {"id": i, "name": name, "employee_id": emp, "phone": phone,
            "email": name.split()[0].lower() + "@meena-health.com", "section": sec,
            "branch_id": br, "branch_name": next(b["name"] for b in BR if b["id"] == br),
            "join_date": "2024-03-01", "leave_balance": bal, "national_id": emp,
            "name_ar": "", "shifts_month": sh, "leave_days_month": lv, "today_shift": today}

SEARCH = [
    staff(1, "Abdulaziz Alanazi", 3, "General", "1014542233", "0581453234", 11.5, None, 16, 2),
    staff(2, "Sara Al-Harbi", 1, "General", "1022113344", "0551110099", 17.0, "M", 18, 0),
    staff(8, "Aisha Al-Zahrani", 1, "General", "1088990011", "0557778899", 13.0, "N", 17, 1),
]
LEAVES = [
    {"id": 11, "staff_id": 2, "staff_name": "Sara Al-Harbi", "branch_id": 1, "branch_name": "NEST 1",
     "leave_type": "AL", "status": "pending", "date_from": "2026-06-25", "date_to": "2026-06-29",
     "date": "2026-06-25", "day_count": 5, "ids": [11], "speciality": ["General"]},
    {"id": 12, "staff_id": 4, "staff_name": "Noura Al-Shehri", "branch_id": 3, "branch_name": "NEST 3",
     "leave_type": "AL", "status": "pending", "date_from": "2026-06-27", "date_to": "2026-06-27",
     "date": "2026-06-27", "day_count": 1, "ids": [12], "speciality": ["General"]},
    {"id": 13, "staff_id": 3, "staff_name": "Mohammed Al-Otaibi", "branch_id": 3, "branch_name": "NEST 3",
     "leave_type": "SL", "status": "approved", "date_from": TODAY, "date_to": TODAY,
     "date": TODAY, "day_count": 1, "ids": [13], "speciality": ["General"], "covered_shift": "M"},
]
DASHBOARD = {"role": "manager", "pending_reviews": 2, "pending_leaves": 3, "pending_swaps": 0,
             "pending_registrations": 1}
OV = {"summary": {"total_cases": 312, "total_pt": 228},
      "branches": [{"branch_id": b["id"], "branch_name": b["name"],
                    "case": ({"locked": True, "total_cases": 60 + b["id"] * 3, "total_pt": 40 + b["id"]} if b["id"] in (1, 2, 4, 6) else None)}
                   for b in BR]}
COVER = {"date": TODAY, "gap_shift": "M", "section": "General", "absent": "Mohammed Al-Otaibi",
         "branch_name": "NEST 3", "candidates": [
    {"staff_id": 5, "name": "Khalid Al-Qahtani", "branch_name": "NEST 3", "section": "General", "shifts_month": 12, "same_branch": True},
    {"staff_id": 1, "name": "Abdulaziz Alanazi", "branch_name": "NEST 3", "section": "General", "shifts_month": 16, "same_branch": True},
    {"staff_id": 2, "name": "Sara Al-Harbi", "branch_name": "NEST 1", "section": "General", "shifts_month": 14, "same_branch": False},
    {"staff_id": 8, "name": "Aisha Al-Zahrani", "branch_name": "NEST 1", "section": "General", "shifts_month": 17, "same_branch": False}]}

AUTHED = {"v": False}
STAFF_MODE = {"v": False}

SHIFT_TYPES = [
    {"id": 1, "branch_id": None, "code": "M", "label": "Morning (12h)", "start_time": "08:00", "end_time": "20:00", "color": "#2B9FFF", "is_off": False, "is_leave": False, "is_oncall": False, "sort_order": 1},
    {"id": 2, "branch_id": None, "code": "N", "label": "Night (12h)", "start_time": "20:00", "end_time": "08:00", "color": "#6B4EFF", "is_off": False, "is_leave": False, "is_oncall": False, "sort_order": 2},
    {"id": 11, "branch_id": None, "code": "O", "label": "Off", "start_time": None, "end_time": None, "color": "#E0E0E0", "is_off": True, "is_leave": False, "is_oncall": False, "sort_order": 11},
    {"id": 13, "branch_id": None, "code": "AL", "label": "Annual Leave", "start_time": None, "end_time": None, "color": "#FD79A8", "is_off": False, "is_leave": True, "is_oncall": False, "sort_order": 13},
    {"id": 14, "branch_id": None, "code": "SL", "label": "Sick Leave", "start_time": None, "end_time": None, "color": "#FAB1A0", "is_off": False, "is_leave": True, "is_oncall": False, "sort_order": 14},
]
REVIEW_OV = {"branches": [
    {"branch_id": 1, "branch_name": "NEST 1", "schedule_id": 1, "status": "approved", "created_by_name": "lead.n1", "staff_count": 6, "shift_count": 132},
    {"branch_id": 2, "branch_name": "NEST 2", "schedule_id": 2, "status": "submitted", "created_by_name": "lead.n2", "staff_count": 5, "shift_count": 110},
    {"branch_id": 3, "branch_name": "NEST 3", "schedule_id": 3, "status": "reviewed", "created_by_name": "lead.n3", "staff_count": 7, "shift_count": 150},
    {"branch_id": 4, "branch_name": "NEST 4", "schedule_id": None, "status": "not_submitted", "created_by_name": None, "staff_count": 4, "shift_count": 0},
    {"branch_id": 5, "branch_name": "NEST 6", "schedule_id": 5, "status": "draft", "created_by_name": "lead.n6", "staff_count": 5, "shift_count": 60},
    {"branch_id": 6, "branch_name": "Al-Jubail", "schedule_id": 6, "status": "approved", "created_by_name": "lead.jb", "staff_count": 4, "shift_count": 88}],
    "summary": {"pending": 2, "not_submitted": 1, "approved": 2, "draft": 1, "total": 6}}
STAFF_LIST = [staff(i, n, br, sec, emp, ph, bal) for i, (n, br, sec, emp, ph, bal) in enumerate([
    ("Abdulaziz Alanazi", 3, "General", "1014542233", "0581453234", 11.5),
    ("Sara Al-Harbi", 1, "General", "1022113344", "0551110099", 17.0),
    ("Mohammed Al-Otaibi", 3, "General", "1033442211", "0553334455", 14.0),
    ("Noura Al-Shehri", 3, "General", "1044556677", "0556667788", 9.5),
    ("Reem Al-Dosari", 3, "US", "1066778899", "0552223344", 6.0),
    ("Aisha Al-Zahrani", 1, "General", "1088990011", "0557778899", 13.0)], 1)]
for s in STAFF_LIST:
    s["active"] = True; s["speciality"] = [s["section"]]
REGS = [{"id": 1, "name": "Yousef Al-Harthy", "branch_name": "NEST 3", "branch_id": 3, "employee_id": "1099001122",
         "email": "yousef@meena-health.com", "phone": "0500001122", "section": "General",
         "requested_role": "admin", "national_id": "1099001122", "name_ar": "يوسف الحارثي"}]
SWAPS = [{"id": 1, "staff_a_name": "Sara Al-Harbi", "staff_b_name": "Aisha Al-Zahrani", "date_a": "2026-06-26",
          "date_b": "2026-06-28", "status": "pending_manager", "branch_id": 1, "branch_name": "NEST 1"},
         {"id": 2, "staff_a_name": "Mohammed Al-Otaibi", "staff_b_name": "Khalid Al-Qahtani", "date_a": "2026-06-24",
          "date_b": "2026-06-25", "status": "pending_lead", "branch_id": 3, "branch_name": "NEST 3"}]
ME_STAFF = {"id": 9, "username": "abdulaziz", "role": "staff", "branch_id": 3, "branch_name": "NEST 3", "staff_id": 1}
_ent = []
for day in range(1, 29):
    code = ["M", "M", "N", "N", "O", "O", "O"][day % 7]
    _ent.append({"date": f"2026-06-{day:02d}", "shift_code": code, "is_oncall": False, "note": None, "cross_branch_name": None})
MY_SCHED = {"staff": {"id": 1, "name": "Abdulaziz Alanazi", "branch_id": 3, "branch_name": "NEST 3", "leave_balance": 11.8},
            "year": 2026, "month": 6, "status": "approved", "finalised": True, "entries": _ent, "cover": [],
            "upcoming_leave": {"date": "2026-07-05", "days_until": 13}, "leave_balance": 11.8}

def api_stub(path, qs):
    if path == "register/info": return {"ok": True, "branches": BR, "nafath_enabled": True, "phone_verify_enabled": True}
    if path == "shift-types": return SHIFT_TYPES
    if path.startswith("schedules/review-overview"): return REVIEW_OV
    if path == "staff" or path.startswith("staff?"): return STAFF_LIST
    if path == "registrations": return REGS
    if path == "swaps" or path.startswith("swaps?"): return SWAPS
    if path.startswith("my-schedule"): return MY_SCHED
    if path == "register/nafath/start": return {"ok": True, "request_id": "demo-123", "random": "47"}
    if path == "register/nafath/status": return {"status": "verified", "name_en": "Saud Alharbi", "name_ar": "سعود الحربي", "national_id": "1098765432"}
    if path in ("register/send-phone-code", "register/check-phone-code", "register/send-code", "register/check-email-code"): return {"ok": True}
    if path == "dashboard": return DASHBOARD
    if path.startswith("daily-cases/overview"): return OV
    if path == "leaves": return LEAVES
    if path == "timeback": return []
    if path == "swaps": return []
    if path.startswith("staff/search"): return {"results": SEARCH}
    if path.startswith("leaves/13/cover-suggestions"): return COVER
    if path == "notifications": return {"notifications": []}
    if path == "branches": return BR
    if path == "health": return {"ok": True}
    return {}

def make_handler():
    def handler(route):
        try:
            req = route.request
            path = urlparse(req.url).path.lstrip("/")
            if path.startswith("api/"):
                sub = path[4:]
                if sub == "auth/me" and not AUTHED["v"]:
                    route.fulfill(status=401, content_type="application/json", body='{"detail":"Not authenticated"}')
                    return
                if sub == "auth/me":
                    who = ME_STAFF if STAFF_MODE["v"] else ME
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(who)); return
                if sub == "settings":
                    route.fulfill(status=200, content_type="application/json", body="{}"); return
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps(api_stub(sub, urlparse(req.url).query)))
                return
            fp = os.path.join(DASH, path or "index.html")
            if os.path.isfile(fp):
                ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
                with open(fp, "rb") as f:
                    route.fulfill(status=200, content_type=ctype, body=f.read())
            else:
                route.fulfill(status=200, content_type="text/html", body=b"")
        except Exception as e:
            try: route.fulfill(status=200, content_type="application/json", body="{}")
            except Exception: pass
    return handler

shots = []
def hide_loader(pg):
    pg.evaluate("var l=document.getElementById('page-loader'); if(l) l.style.display='none';")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME if os.path.exists(CHROME) else None,
                          args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1340, "height": 880}, device_scale_factor=2)
    pg.set_default_timeout(8000)
    pg.route("**/*", make_handler())

    def shot(name):
        try:
            hide_loader(pg); pg.wait_for_timeout(200)
            pg.screenshot(path=os.path.join(OUT, name)); shots.append(name); print("shot", name)
        except Exception as e: print("FAIL", name, e)

    # ── Phase 1: logged OUT — login + registration wizard ────────────────────
    pg.goto(ORIGIN + "/index.html", wait_until="domcontentloaded", timeout=15000)
    pg.wait_for_timeout(1500)
    pg.evaluate("var o=document.getElementById('login-overlay'); if(o) o.style.display='flex';")
    pg.wait_for_timeout(400); shot("01_login.png")
    def safe(fn, label):
        try: fn()
        except Exception as e: print("step-fail", label, str(e)[:80])
    safe(lambda: (pg.evaluate("startStaffSignup()"), pg.wait_for_timeout(1200), shot("02_nafath.png")), "nafath")
    safe(lambda: (pg.fill("#reg-nationalid", "1098765432"), pg.evaluate("startNafath()"),
                  pg.wait_for_timeout(3600), shot("03_nafath_verified.png")), "verified")
    safe(lambda: (pg.evaluate("regNext()"), pg.wait_for_timeout(700),
                  pg.fill("#reg-phone", "0581234567"), pg.fill("#reg-phonecode", "123456"),
                  shot("04_mobile_step.png")), "mobile")
    safe(lambda: (pg.evaluate("regNext()"), pg.wait_for_timeout(700),
                  pg.fill("#reg-email", "saud@meena-health.com"), pg.fill("#reg-emailcode", "654321"),
                  shot("05_email_step.png")), "email")
    safe(lambda: (pg.evaluate("regNext()"), pg.wait_for_timeout(700), shot("05b_details.png")), "details")

    # ── Phase 2: logged IN as manager — app screens ──────────────────────────
    AUTHED["v"] = True
    pg.goto(ORIGIN + "/index.html", wait_until="domcontentloaded", timeout=15000)
    pg.wait_for_timeout(2500)
    pg.evaluate("showPage('home')"); pg.wait_for_timeout(2200); shot("06_home.png")
    try:
        pg.fill("#hm-staff-q", "al"); pg.wait_for_timeout(1400); shot("07_home_search.png")
    except Exception as e: print("search", e)
    pg.evaluate("showPage('leaves')"); pg.wait_for_timeout(2000); shot("08_leaves.png")
    try:
        pg.evaluate("openCoverModal(13)"); pg.wait_for_timeout(1500); shot("09_cover.png")
        pg.evaluate("closeCoverModal()")
    except Exception as e: print("cover", e)
    pg.evaluate("showPage('cases')"); pg.wait_for_timeout(2000); shot("10_cases.png")
    safe(lambda: (pg.evaluate("showPage('swaps')"), pg.wait_for_timeout(2000), shot("11_swaps.png")), "swaps")
    safe(lambda: (pg.evaluate("showPage('review')"), pg.wait_for_timeout(2000), shot("12_review.png")), "review")
    safe(lambda: (pg.evaluate("showPage('staff')"), pg.wait_for_timeout(2000), shot("13_staff.png")), "staff")

    # ── Phase 3: staff portal (My Schedule) ──────────────────────────────────
    STAFF_MODE["v"] = True
    safe(lambda: (pg.goto(ORIGIN + "/index.html", wait_until="domcontentloaded", timeout=15000),
                  pg.wait_for_timeout(2500), pg.evaluate("showPage('myschedule')"),
                  pg.wait_for_timeout(2200), shot("14_myschedule.png")), "myschedule")
    b.close()
print("DONE", shots)
