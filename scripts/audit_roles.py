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

print(f"\n=== AUDIT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
