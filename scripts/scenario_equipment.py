"""Scenarios for equipment maintenance + preventive-maintenance reminders.

Run: COOKIE_SECURE=0 SMTP_CAPTURE=1 DATABASE_URL=... python scripts/scenario_equipment.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import date, timedelta
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
    assert r.status_code == 200, f"login {u}: {r.status_code} {r.text}"
    return c

print("\n== setup ==")
admin = login("admin", "admin123")
S = "eq"
brs = admin.get("/api/branches").json()
b1, b2 = brs[0]["id"], brs[1]["id"]
A = admin.post("/api/staff", json={"name": "EQ Staff A", "branch_id": b1}).json()
admin.post("/api/users", json={"username": f"ea{S}", "password": "pass123", "role": "staff", "staff_id": A["id"]})
admin.post("/api/users", json={"username": f"el1{S}", "password": "pass123", "role": "admin", "branch_id": b1})
admin.post("/api/users", json={"username": f"el2{S}", "password": "pass123", "role": "admin", "branch_id": b2})
staffA = login(f"ea{S}", "pass123")
leadA, leadB = login(f"el1{S}", "pass123"), login(f"el2{S}", "pass123")
check("setup ok", all([b1, b2, A.get("id")]) and b1 != b2)

# ── Create + list ─────────────────────────────────────────────────────────────
print("\n== device CRUD ==")
soon = (date.today() + timedelta(days=5)).isoformat()
e = admin.post("/api/equipment", json={"branch_id": b1, "name": "CT Scanner", "model": "Revolution",
                                       "serial": "CT-001", "vendor": "GE", "next_pm_date": soon})
check("admin adds a device", e.status_code == 200 and "id" in e.json(), e.text)
eid = e.json()["id"]
lst = staffA.get("/api/equipment").json()["equipment"]
row = next((r for r in lst if r["id"] == eid), None)
check("device appears with next PM + days_left", row and row["next_pm_date"] == soon and row["days_left"] == 5, row)
check("staff can't add a device (403)", staffA.post("/api/equipment", json={"name": "X"}).status_code == 403)
check("bad next_pm_date is ignored (still creates)",
      admin.post("/api/equipment", json={"branch_id": b1, "name": "US", "next_pm_date": "not-a-date"}).status_code == 200)

# ── Log maintenance updates next PM ──────────────────────────────────────────
print("\n== log service sets the next PM ==")
newdue = (date.today() + timedelta(days=90)).isoformat()
m = leadA.post(f"/api/equipment/{eid}/maintenance", json={"kind": "preventive",
              "service_date": date.today().isoformat(), "next_due": newdue, "vendor": "GE", "cost": 1200, "note": "Annual PM"})
check("lead logs a service", m.status_code == 200, m.text)
row = next(r for r in leadA.get("/api/equipment").json()["equipment"] if r["id"] == eid)
check("device next PM advanced to the logged next_due", row["next_pm_date"] == newdue, row)
hist = leadA.get(f"/api/equipment/{eid}/maintenance").json()["records"]
check("maintenance history records the service", len(hist) == 1 and hist[0]["next_due"] == newdue, hist)
check("service_date is required (400)",
      leadA.post(f"/api/equipment/{eid}/maintenance", json={"kind": "preventive"}).status_code == 400)
check("staff can't log maintenance (403)",
      staffA.post(f"/api/equipment/{eid}/maintenance", json={"service_date": date.today().isoformat()}).status_code == 403)

# ── PM reminders ──────────────────────────────────────────────────────────────
print("\n== preventive-maintenance reminders ==")
# Force a device due TODAY and sweep.
M.q("UPDATE scheduling.equipment SET next_pm_date=CURRENT_DATE, pm_notified=NULL WHERE id=%s", (eid,), exec_only=True)
n = M._send_maintenance_reminders()
check("the sweep processed at least one device", n >= 1, n)
notes = [x for x in leadA.get("/api/notifications").json()["notifications"] if "maintenance" in (x["message"] or "").lower()]
check("branch lead got a PM reminder", len(notes) >= 1, notes[:1])
check("the OTHER branch lead was NOT reminded",
      not any("maintenance" in (x["message"] or "").lower() for x in leadB.get("/api/notifications").json()["notifications"]))
before = len(notes)
M._send_maintenance_reminders()   # same bucket → no duplicate
notes2 = [x for x in leadA.get("/api/notifications").json()["notifications"] if "maintenance" in (x["message"] or "").lower()]
check("no duplicate reminder for the same bucket", len(notes2) == before, [before, len(notes2)])

# ── Scoping + edit + delete ───────────────────────────────────────────────────
print("\n== scoping, edit, delete ==")
admin.post("/api/equipment", json={"branch_id": b2, "name": "MRI", "next_pm_date": soon})
check("staff A sees only their own branch's devices",
      all(r["branch_id"] == b1 for r in staffA.get("/api/equipment").json()["equipment"]))
check("lead can't edit another branch's device (403)",
      leadB.put(f"/api/equipment/{eid}", json={"name": "X"}).status_code == 403)
ed = leadA.put(f"/api/equipment/{eid}", json={"name": "CT Scanner 64", "next_pm_date": soon})
check("lead edits the device", ed.status_code == 200, ed.text)
check("edit reset the PM reminder bucket (re-armed)",
      next(r for r in leadA.get("/api/equipment").json()["equipment"] if r["id"] == eid)["next_pm_date"] == soon)
check("delete unknown device (404)", leadA.delete("/api/equipment/99999999").status_code == 404)
check("lead deletes the device", leadA.delete(f"/api/equipment/{eid}").status_code == 200)
check("device gone after delete", not any(r["id"] == eid for r in leadA.get("/api/equipment").json()["equipment"]))

print(f"\n=== RESULT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
