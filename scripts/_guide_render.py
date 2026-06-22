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

def api_stub(path, qs):
    if path == "register/info": return {"ok": True, "branches": BR, "nafath_enabled": True, "phone_verify_enabled": True}
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
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(ME)); return
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
    b.close()
print("DONE", shots)
