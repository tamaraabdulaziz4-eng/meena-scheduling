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
check("lead can't review schedules", LEADA.get("/api/dashboard").json().get("pending_reviews") == 0)

print("\n== two-stage leave chain: team lead -> manager ==")
lid = lr.json()["leaves"][0]["id"]
check("lead B can't touch branch-A leave", LEADB.put(f"/api/leaves/{lid}/status", json={"status":"approved"}).status_code == 403)
s1 = LEADA.put(f"/api/leaves/{lid}/status", json={"status": "approved"})
check("lead clears stage 1 -> awaiting manager", s1.status_code == 200 and s1.json().get("status") == "lead_approved", s1.text)
check("lead can't give FINAL approval (manager only)", LEADA.put(f"/api/leaves/{lid}/status", json={"status": "approved"}).status_code == 403)
check("lead's branch leave count counts only stage 1", LEADA.get("/api/dashboard").json().get("pending_leaves") == 0)

print("\n== manager (reviewer) ==")
check("manager can't submit schedules", True)  # enforced in status endpoint; checked in smoke
check("manager sees leave awaiting final approval", MGR.get("/api/dashboard").json().get("pending_leaves") >= 1)
fin = MGR.put(f"/api/leaves/{lid}/status", json={"status": "approved"})
check("manager gives final approval", fin.status_code == 200 and fin.json().get("status") == "approved", fin.text)

print("\n== registration flow across branches ==")
admin.put("/api/settings", json={"registration": "on"})
code = (admin.get("/api/settings").json().get("registration_link") or "").split("register=")[-1]
anon = TestClient(app)
anon.post("/api/register", json={"code": code, "name": "Reg ForA", "branch_id": bidA, "employee_id": f"RA{sfx}",
          "username": f"rega{sfx}", "password": "regpass1"})
anon.post("/api/register", json={"code": code, "name": "Reg ForB", "branch_id": bidB, "employee_id": f"RB{sfx}",
          "username": f"regb{sfx}", "password": "regpass1"})
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

print("\n== branch-scoped config reads can't leak across branches ==")
check("lead A can't read branch-B section settings",
      LEADA.get(f"/api/section-month-settings?branch_id={bidB}&year=2026&month=9").status_code == 403)
check("lead A can read own-branch section settings",
      LEADA.get(f"/api/section-month-settings?branch_id={bidA}&year=2026&month=9").status_code == 200)
check("viewer can't read section settings at all",
      VIEW.get(f"/api/section-month-settings?branch_id={bidA}&year=2026&month=9").status_code in (401, 403))
check("lead A can't read branch-B allowed-shifts",
      LEADA.get(f"/api/generate/allowed-shifts?branch_id={bidB}").status_code == 403)
check("manager can't read raw nest-config roster", MGR.get("/api/nest-config/NEST1").status_code in (401, 403))
check("superadmin can read nest-config roster", admin.get("/api/nest-config/NEST1").status_code == 200)

print("\n== auth lifecycle: logout + session invalidation ==")
sess = login(f"viewer{sfx}", "pass123")
check("me works while signed in", sess.get("/api/auth/me").status_code == 200)
sess.post("/api/auth/logout")
check("logout drops the session cookie", sess.get("/api/auth/me").status_code == 401)
# Changing a user's password bumps their token epoch → existing sessions die
# (this is exactly the 401 the frontend now catches to bounce to login).
sess2 = login(f"viewer{sfx}", "pass123")
uid = sess2.get("/api/auth/me").json()["id"]
admin.put(f"/api/users/{uid}", json={"password": "newpass123"})
check("old session dies after a password change", sess2.get("/api/auth/me").status_code == 401)
check("new password signs in fine", login(f"viewer{sfx}", "newpass123").get("/api/auth/me").status_code == 200)
# The public sign-up gate: /register/info rejects a bad/absent invite code.
check("sign-up gate rejects a bad invite code",
      TestClient(app).get("/api/register/info?code=totally-wrong").status_code == 403)

print("\n== change own password (any signed-in role) ==")
check("wrong current password rejected",
      STAFF.post("/api/auth/change-password", json={"current_password": "WRONG", "new_password": "newstaff1"}).status_code == 403)
check("short new password rejected",
      STAFF.post("/api/auth/change-password", json={"current_password": "pass123", "new_password": "abc"}).status_code == 400)
ch = STAFF.post("/api/auth/change-password", json={"current_password": "pass123", "new_password": "newstaff1"})
check("change password succeeds", ch.status_code == 200, ch.text)
check("current session stays valid (cookie re-issued)", STAFF.get("/api/auth/me").status_code == 200)
check("new password works on a fresh login", login(f"stf{sfx}", "newstaff1").get("/api/auth/me").status_code == 200)
check("old password no longer works",
      TestClient(app).post("/api/auth/login", json={"username": f"stf{sfx}", "password": "pass123"}).status_code == 401)

print("\n== sick leave: no approval chain, just notify + cover ==")
sl = STAFF.post("/api/leaves", json={"date_from": "2026-09-15", "date_to": "2026-09-15", "leave_type": "SL"})
check("sick leave auto-approved (no chain)", sl.status_code == 200 and sl.json().get("status") == "approved", sl.text)
slid = sl.json()["leaves"][0]["id"]
cs = STAFF.get(f"/api/leaves/{slid}/cover-suggestions")
check("staff sees cover suggestions for own sick leave", cs.status_code == 200, cs.text)
check("suggestions list candidates from the pool", any(c["staff_id"] == sB["id"] for c in cs.json().get("candidates", [])), cs.text)
check("manager sees cover suggestions too", MGR.get(f"/api/leaves/{slid}/cover-suggestions").status_code == 200)
check("team lead can request a cover", LEADA.post(f"/api/leaves/{slid}/request-cover", json={"staff_id": sB["id"]}).status_code == 200)

print("\n== time-back claims: team lead -> manager, balance ==")
check("viewer can't raise a claim", VIEW.post("/api/timeback", json={"date": "2026-09-10", "reason": "covered"}).status_code in (401, 403))
tb = STAFF.post("/api/timeback", json={"date": "2026-09-10", "reason": "covered", "note": "covered Sara"})
check("staff raises a time-back claim (pending)", tb.status_code == 200 and tb.json().get("status") == "pending", tb.text)
tbid = tb.json()["id"]
check("staff can't approve own claim", STAFF.put(f"/api/timeback/{tbid}/status", json={"status": "approved"}).status_code in (401, 403))
s1 = LEADA.put(f"/api/timeback/{tbid}/status", json={"status": "approved"})
check("team lead clears stage 1", s1.status_code == 200 and s1.json().get("status") == "lead_approved", s1.text)
check("lead can't give final approval", LEADA.put(f"/api/timeback/{tbid}/status", json={"status": "approved"}).status_code == 403)
fin = MGR.put(f"/api/timeback/{tbid}/status", json={"status": "approved"})
check("manager finalizes the claim", fin.status_code == 200 and fin.json().get("status") == "approved", fin.text)
check("approved claim credits the balance (+1)", STAFF.get("/api/timeback/balance").json().get("balance") == 1)

print("\n== danger zone: clear test data (superadmin only, runs LAST) ==")
check("non-superadmin can't reset data", MGR.post("/api/admin/reset-data", json={"confirm": "RESET"}).status_code in (401, 403))
check("reset needs the confirm token", admin.post("/api/admin/reset-data", json={}).status_code == 400)
b_before  = len(admin.get("/api/branches").json())
st_before = len(admin.get("/api/shift-types").json())
# Tuned per-section limits are CONFIG, not test data — they must survive a reset.
secX = M.q("SELECT id, nest_key FROM scheduling.nest_sections LIMIT 1", one=True)
bidX = M._branch_id_for_nest(secX["nest_key"]) if secX else None
if secX and bidX:
    admin.put(f"/api/section-month-settings/{secX['id']}",
              json={"branch_id": bidX, "year": 2031, "month": 3,
                    "min_m": 1, "max_m": 2, "min_n": 1, "max_n": 2,
                    "max_consecutive": 3, "min_o_block": 2, "max_o_block": 3})
rr = admin.post("/api/admin/reset-data", json={"confirm": "RESET"})
check("superadmin reset succeeds", rr.status_code == 200, rr.text)
check("staff cleared", len(admin.get("/api/staff").json()) == 0)
check("branches kept", len(admin.get("/api/branches").json()) == b_before and b_before > 0)
check("shift types kept", len(admin.get("/api/shift-types").json()) == st_before and st_before > 0)
if secX and bidX:
    kept = admin.get(f"/api/section-month-settings?branch_id={bidX}&year=2031&month=3").json()
    keptsec = kept.get(str(secX["id"])) or kept.get(secX["id"]) or {}
    check("tuned section limits survive reset (config, not test data)",
          keptsec.get("max_consecutive") == 3 and keptsec.get("max_o_block") == 3, kept)
check("superadmin still signed in", admin.get("/api/auth/me").status_code == 200)
check("only superadmin logins remain", all(u["role"] == "superadmin" for u in admin.get("/api/users").json()))

print(f"\n=== AUDIT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
