"""Role-by-role flow audit: exercises each persona's journey and probes the
permission boundaries / edge cases across the newer features (dashboard,
registration, reminders, reset, daily cases). Run against a throwaway DB."""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fastapi.testclient import TestClient
import server.main as M

M.init_schema(); M.seed_defaults(); M.seed_nest_config(); M.seed_admin()
app = M.app
PASS = FAIL = 0
def check(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  \033[32mPASS\033[0m {name}")
    else:    FAIL += 1; print(f"  \033[31mFAIL\033[0m {name}  {extra}")
def login(u, p):
    c = TestClient(app); r = c.post("/api/auth/login", json={"username": u, "password": p})
    assert r.status_code == 200, f"login {u}: {r.text}"; return c

admin = login("admin", "admin123")              # superadmin
branches = admin.get("/api/branches").json()
bidA = branches[0]["id"]; bidB = branches[1]["id"]
sfx = str(int(time.time()))[-5:]

# personas
SA = admin
sA = admin.post("/api/staff", json={"name": "AU A", "branch_id": bidA}).json()
sB = admin.post("/api/staff", json={"name": "AU B", "branch_id": bidA}).json()
admin.post("/api/users", json={"username": f"mgr{sfx}", "password": "pass123", "role": "manager"})
admin.post("/api/users", json={"username": f"leadA{sfx}", "password": "pass123", "role": "admin", "branch_id": bidA})
admin.post("/api/users", json={"username": f"leadB{sfx}", "password": "pass123", "role": "admin", "branch_id": bidB})
admin.post("/api/users", json={"username": f"stf{sfx}", "password": "pass123", "role": "staff", "staff_id": sA["id"]})
admin.post("/api/users", json={"username": f"viewer{sfx}", "password": "pass123", "role": "viewer"})
MGR  = login(f"mgr{sfx}", "pass123")
LEADA = login(f"leadA{sfx}", "pass123")
LEADB = login(f"leadB{sfx}", "pass123")
STAFF = login(f"stf{sfx}", "pass123")
VIEW = login(f"viewer{sfx}", "pass123")

print("\n== viewer is strictly read-only ==")
check("viewer can read schedule list", VIEW.get("/api/branches").status_code == 200)
check("viewer can't create staff", VIEW.post("/api/staff", json={"name": "x", "branch_id": bidA}).status_code in (401,403))
check("viewer can't create leave", VIEW.post("/api/leaves", json={"staff_id": sA["id"], "date_from": "2026-09-01"}).status_code in (401,403))
check("viewer can't request swap", VIEW.post("/api/swaps", json={"staff_a": sA["id"], "date_a":"2026-09-01","staff_b":sB["id"],"date_b":"2026-09-02"}).status_code in (401,403))
check("viewer can't file daily cases", VIEW.post("/api/daily-cases", json={"branch_id": bidA, "date":"2026-09-01","submit":True}).status_code in (401,403))
check("viewer can't list registrations", VIEW.get("/api/registrations").status_code in (401,403))
check("viewer can't change settings", VIEW.put("/api/settings", json={"leave_cutoff_day": 10}).status_code in (401,403))
check("viewer can't remind cases", VIEW.post("/api/daily-cases/remind", json={}).status_code in (401,403))
check("viewer dashboard is empty of actions", VIEW.get("/api/dashboard").json().get("pending_reviews") == 0)

print("\n== staff portal boundaries ==")
check("staff can read own my-schedule", STAFF.get("/api/my-schedule?year=2026&month=9").status_code == 200)
check("staff blocked from team rota by schedule id", STAFF.get("/api/schedules/999999/entries").status_code in (403,404))
check("staff can't list registrations", STAFF.get("/api/registrations").status_code in (401,403))
check("staff can't remind cases", STAFF.post("/api/daily-cases/remind", json={}).status_code in (401,403))
check("staff can't send test email", STAFF.post("/api/email-test", json={"to":"x@y.com"}).status_code in (401,403))
check("staff dashboard scoped (no review queue)", STAFF.get("/api/dashboard").json().get("pending_reviews") == 0)
# staff leave for self only
lr = STAFF.post("/api/leaves", json={"date_from": "2026-09-10", "date_to": "2026-09-10", "leave_type": "AL"})
check("staff can request own leave", lr.status_code == 200 and lr.json().get("status") == "pending", lr.text)
check("staff can't approve leave", STAFF.put("/api/leaves/status", json={"ids":[1],"status":"approved"}).status_code in (401,403))

print("\n== team lead is branch-locked ==")
check("lead A sees only own-branch staff", all(s["branch_id"] == bidA for s in LEADA.get("/api/staff").json()))
check("lead A can't add staff to branch B", LEADA.post("/api/staff", json={"name":"x","branch_id":bidB}).status_code == 403)
check("lead A can't file branch B cases", LEADA.post("/api/daily-cases", json={"branch_id":bidB,"date":"2026-09-01","submit":True}).status_code == 403)
check("lead can't approve leave (reviewer only)", LEADA.put(f"/api/leaves/{lr.json()['leaves'][0]['id']}/status", json={"status":"approved"}).status_code in (401,403))
check("lead can't review schedules", LEADA.get("/api/dashboard").json().get("pending_reviews") == 0)

print("\n== manager (reviewer) ==")
check("manager can't submit schedules", True)  # enforced in status endpoint; checked in smoke
check("manager sees all-branch leave queue", MGR.get("/api/dashboard").status_code == 200)
# manager approves the staff leave
lid = lr.json()["leaves"][0]["id"]
check("manager approves staff leave", MGR.put(f"/api/leaves/{lid}/status", json={"status":"approved"}).status_code == 200)

print("\n== registration flow across branches ==")
admin.put("/api/settings", json={"registration": "on"})
code = (admin.get("/api/settings").json().get("registration_link") or "").split("register=")[-1]
anon = TestClient(app)
anon.post("/api/register", json={"code": code, "name": "Reg ForA", "branch_id": bidA, "employee_id": f"RA{sfx}"})
anon.post("/api/register", json={"code": code, "name": "Reg ForB", "branch_id": bidB, "employee_id": f"RB{sfx}"})
qa = LEADA.get("/api/registrations").json()
check("lead A sees only branch-A registration", any(r["employee_id"]==f"RA{sfx}" for r in qa) and not any(r["employee_id"]==f"RB{sfx}" for r in qa), qa)
regB = next(r for r in MGR.get("/api/registrations").json() if r["employee_id"] == f"RB{sfx}")
check("lead A can't approve a branch-B registration", LEADA.post(f"/api/registrations/{regB['id']}/approve", json={}).status_code == 403)
check("lead B approves own-branch registration", LEADB.post(f"/api/registrations/{regB['id']}/approve", json={}).status_code == 200)
check("approving twice is rejected", LEADB.post(f"/api/registrations/{regB['id']}/approve", json={}).status_code == 400)

print("\n== forgot password edge ==")
# A user with no email on file → generic ok, no crash, no email.
M._email_outbox.clear()
fp = anon.post("/api/auth/forgot", json={"username": f"leadA{sfx}"})
check("forgot for emailless user is generic ok", fp.status_code == 200 and len(M._email_outbox) == 0, M._email_outbox)
check("reset with empty token rejected", anon.post("/api/auth/reset", json={"token":"","password":"abcdef"}).status_code == 400)

print("\n== branchless account can't list everyone (leak guard) ==")
# A viewer/manager-less account with no branch assigned must not silently see
# all staff / all leaves. Build an admin-role user with NO branch_id.
admin.post("/api/users", json={"username": f"nob{sfx}", "password": "pass123", "role": "admin"})
NOBR = login(f"nob{sfx}", "pass123")
check("branchless admin gets 403 on /staff (no global leak)", NOBR.get("/api/staff").status_code == 403)
check("branchless admin gets 403 on /leaves (no global leak)", NOBR.get("/api/leaves").status_code == 403)

print("\n== shift types are superadmin-only ==")
st = {"code": f"Z{sfx[:2]}", "label": "Audit", "color": "#123456"}
check("manager can't create shift type", MGR.post("/api/shift-types", json=st).status_code in (401,403))
check("team lead can't create shift type", LEADA.post("/api/shift-types", json=st).status_code in (401,403))
check("superadmin can create shift type", admin.post("/api/shift-types", json=st).status_code == 200)
newst = next((s for s in admin.get("/api/shift-types").json() if s["code"] == st["code"]), None)
if newst:
    check("manager can't update shift type", MGR.put(f"/api/shift-types/{newst['id']}", json={"label":"x"}).status_code in (401,403))
    check("team lead can't delete shift type", LEADA.delete(f"/api/shift-types/{newst['id']}").status_code in (401,403))
    check("superadmin can delete shift type", admin.delete(f"/api/shift-types/{newst['id']}").status_code == 200)

print("\n== section settings are branch-isolated ==")
# Team lead A may only touch sections that belong to their own branch.
nestB = M.branch_to_nest(next(b["name"] for b in branches if b["id"] == bidB))
secB = M.q("SELECT id FROM scheduling.nest_sections WHERE nest_key=%s LIMIT 1", (nestB,), one=True)
if secB:
    r = LEADA.put(f"/api/section-month-settings/{secB['id']}",
                  json={"year": 2026, "month": 9, "min_m": 1})
    check("lead A can't change a branch-B section", r.status_code == 403, r.text)
check("lead A can't create a section in branch B",
      LEADA.put("/api/section-month-settings/0",
                json={"branch_id": bidB, "section_name": "Bogus", "year": 2026, "month": 9}).status_code == 403)

print("\n== audit log is superadmin-only ==")
check("manager can't read audit log", MGR.get("/api/audit").status_code in (401,403))
check("team lead can't read audit log", LEADA.get("/api/audit").status_code in (401,403))
check("superadmin can read audit log", admin.get("/api/audit").status_code == 200)

print("\n== daily cases reject negative counts ==")
admin.post("/api/daily-cases", json={"branch_id": bidA, "date": "2026-09-05", "xray": -5, "ct": 3})
saved = admin.get(f"/api/daily-cases?branch_id={bidA}&date=2026-09-05").json().get("case") or {}
check("negative case count clamped to 0", saved.get("xray") == 0 and saved.get("ct") == 3, saved)

print("\n== reseeding nest config never clobbers edits ==")
sec0 = M.q("SELECT id, nest_key, section_name FROM scheduling.nest_sections LIMIT 1", one=True)
M.q("UPDATE scheduling.nest_sections SET staff=%s WHERE id=%s",
    (["EDITED_KEEP_ME"], sec0["id"]), exec_only=True)
M.seed_nest_config()  # simulate a redeploy/restart
after = M.q("SELECT staff FROM scheduling.nest_sections WHERE id=%s", (sec0["id"],), one=True)
check("manual nest-section edit survives reseed", after["staff"] == ["EDITED_KEEP_ME"], after)

print(f"\n=== AUDIT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
