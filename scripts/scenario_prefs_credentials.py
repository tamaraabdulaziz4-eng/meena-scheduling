"""Edge-case scenarios for the two features added this session:
  - Staff credentials / license expiry (CRUD, scoping, privacy, validation)
  - Staff shift preferences (CRUD, scoping, upsert, validation, generator)

Run against a throwaway Postgres:
  COOKIE_SECURE=0 SMTP_CAPTURE=1 DATABASE_URL=... python scripts/scenario_prefs_credentials.py
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
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": u, "password": p})
    assert r.status_code == 200, f"login {u}: {r.status_code} {r.text}"
    return c

print("\n== setup ==")
admin = login("admin", "admin123")          # superadmin (acts as manager)
S = "pc"
brs = admin.get("/api/branches").json()
b1, b2 = brs[0]["id"], brs[1]["id"]
A = admin.post("/api/staff", json={"name": "PC A", "branch_id": b1}).json()
B = admin.post("/api/staff", json={"name": "PC B", "branch_id": b1}).json()
C = admin.post("/api/staff", json={"name": "PC C", "branch_id": b2}).json()
for u, st in ((f"sa{S}", A), (f"sb{S}", B), (f"sc{S}", C)):
    admin.post("/api/users", json={"username": u, "password": "pass123", "role": "staff", "staff_id": st["id"]})
admin.post("/api/users", json={"username": f"l1{S}", "password": "pass123", "role": "admin", "branch_id": b1})
admin.post("/api/users", json={"username": f"l2{S}", "password": "pass123", "role": "admin", "branch_id": b2})
staffA, staffB, staffC = login(f"sa{S}", "pass123"), login(f"sb{S}", "pass123"), login(f"sc{S}", "pass123")
lead1, lead2 = login(f"l1{S}", "pass123"), login(f"l2{S}", "pass123")
check("setup ok", all([b1, b2, A.get("id"), B.get("id"), C.get("id")]))

# ── Credentials ────────────────────────────────────────────────────────────────
print("\n== credentials: CRUD, validation, scoping, privacy ==")
soon = (date.today() + timedelta(days=10)).isoformat()
past = (date.today() - timedelta(days=5)).isoformat()
far  = (date.today() + timedelta(days=200)).isoformat()

# Validation: a malformed date must 400, not 500.
bad_date = admin.post("/api/credentials", json={"staff_id": A["id"], "kind": "bls", "expiry_date": "not-a-date"})
check("malformed expiry_date is rejected (400, not 500)", bad_date.status_code == 400, bad_date.text)
miss = admin.post("/api/credentials", json={"staff_id": A["id"], "kind": "bls"})
check("missing expiry_date rejected (400)", miss.status_code == 400, miss.text)

# Manager creating for a NON-existent staff must 403, not crash with a FK 500.
ghost = admin.post("/api/credentials", json={"staff_id": 99999999, "kind": "bls", "expiry_date": soon})
check("credential for unknown staff is rejected (403, not 500)", ghost.status_code == 403, ghost.text)

# Special characters in label/number round-trip safely (no injection / no 500).
tricky = admin.post("/api/credentials", json={"staff_id": A["id"], "kind": "scfhs",
                    "label": "O'Brien <x> \"q\"", "number": "R'1<2", "expiry_date": soon})
check("special characters in label/number accepted", tricky.status_code == 200, tricky.text)
cidA = tricky.json().get("id")
listA = admin.get(f"/api/credentials?branch_id={b1}").json()
rowA = next((r for r in listA if r["id"] == cidA), None)
check("special characters preserved verbatim",
      rowA and rowA["label"] == "O'Brien <x> \"q\"" and rowA["number"] == "R'1<2", rowA)

# days_left is correct for past / soon / far.
admin.post("/api/credentials", json={"staff_id": B["id"], "kind": "iqama", "expiry_date": past})
admin.post("/api/credentials", json={"staff_id": B["id"], "kind": "passport", "expiry_date": far})
lst = admin.get(f"/api/credentials?branch_id={b1}").json()
soon_row = next((r for r in lst if r["id"] == cidA), None)
past_row = next((r for r in lst if r["staff_id"] == B["id"] and r["kind"] == "iqama"), None)
far_row  = next((r for r in lst if r["staff_id"] == B["id"] and r["kind"] == "passport"), None)
check("days_left positive for a future expiry", soon_row and soon_row["days_left"] == 10, soon_row)
check("days_left negative for an expired credential", past_row and past_row["days_left"] == -5, past_row)
check("list is ordered by expiry (expired first)", lst and lst[0]["days_left"] <= lst[-1]["days_left"], [r["days_left"] for r in lst])

# Expiring feed + days clamping.
exp30 = admin.get("/api/credentials/expiring?days=30").json()
check("expiring(30d) includes the 10-day one", any(i["id"] == cidA for i in exp30["items"]), exp30)
check("expiring(30d) excludes the 200-day one",
      not any(r["kind"] == "passport" for r in exp30["items"]), exp30)
check("expiring includes already-expired", any(i["days_left"] == -5 for i in exp30["items"]), exp30)
clamp = admin.get("/api/credentials/expiring?days=99999").json()
check("days param is clamped (<=365)", clamp["days"] == 365, clamp)
clamp2 = admin.get("/api/credentials/expiring?days=oops").json()
check("non-numeric days falls back to default", clamp2["days"] == 60, clamp2)

# Update: invalid kind coerced; bad date rejected.
upd = admin.put(f"/api/credentials/{cidA}", json={"kind": "banana", "expiry_date": far})
check("update with unknown kind coerced to 'other'", upd.status_code == 200, upd.text)
after = next((r for r in admin.get(f"/api/credentials?branch_id={b1}").json() if r["id"] == cidA), {})
check("coerced kind stored as 'other' + new expiry applied",
      after.get("kind") == "other" and after.get("expiry_date") == far, after)
check("update with bad date rejected (400)",
      admin.put(f"/api/credentials/{cidA}", json={"expiry_date": "13/13/2026"}).status_code == 400)
check("delete unknown credential → 404", admin.delete("/api/credentials/88888888").status_code == 404)

# Scoping + privacy.
credC = admin.post("/api/credentials", json={"staff_id": C["id"], "kind": "bls", "expiry_date": soon}).json()
check("team lead sees only their own branch",
      all(r["branch_id"] == b1 for r in lead1.get("/api/credentials").json()))
check("team lead can't widen scope via branch_id (still own branch)",
      all(r["branch_id"] == b1 for r in lead1.get(f"/api/credentials?branch_id={b2}").json()))
check("manager scoping to a branch shows only that branch",
      all(r["branch_id"] == b2 for r in admin.get(f"/api/credentials?branch_id={b2}").json()))
check("team lead can't manage another branch's staff (403)",
      lead1.post("/api/credentials", json={"staff_id": C["id"], "kind": "bls", "expiry_date": soon}).status_code == 403)
check("staff can view their own credentials",
      any(r["id"] == cidA for r in staffA.get(f"/api/staff/{A['id']}/credentials").json()))
check("staff can't view another staff's credentials (403)",
      staffA.get(f"/api/staff/{B['id']}/credentials").status_code == 403)
check("staff can't create credentials (403)",
      staffA.post("/api/credentials", json={"staff_id": A["id"], "kind": "bls", "expiry_date": soon}).status_code == 403)
check("staff blocked from the list endpoint (403)", staffA.get("/api/credentials").status_code == 403)

# ── Preferences ──────────────────────────────────────────────────────────────
print("\n== preferences: CRUD, upsert, validation, scoping ==")
PY, PM = 2026, 9
p1 = staffA.put("/api/preferences", json={"year": PY, "month": PM, "day": 10, "kind": "off", "note": "family"})
check("staff sets a prefer-off day with a note", p1.status_code == 200, p1.text)
# Upsert: same day flips kind + keeps single row.
staffA.put("/api/preferences", json={"year": PY, "month": PM, "day": 10, "kind": "unavailable"})
mine = staffA.get(f"/api/preferences?year={PY}&month={PM}").json()["preferences"]
day10 = [p for p in mine if p["day"] == 10]
check("upsert keeps a single row and flips the kind",
      len(day10) == 1 and day10[0]["kind"] == "unavailable", day10)
# Note round-trips on a fresh day.
staffA.put("/api/preferences", json={"year": PY, "month": PM, "day": 12, "kind": "off", "note": "exam"})
mine = staffA.get(f"/api/preferences?year={PY}&month={PM}").json()["preferences"]
check("note is stored", any(p["day"] == 12 and p["note"] == "exam" for p in mine), mine)

# Validation.
check("invalid day rejected (400)",
      staffA.put("/api/preferences", json={"year": PY, "month": PM, "day": 31, "kind": "off"}).status_code == 400)  # Sept has 30
check("non-numeric day rejected (400)",
      staffA.put("/api/preferences", json={"year": PY, "month": PM, "day": "x", "kind": "off"}).status_code == 400)
check("invalid kind rejected (400)",
      staffA.put("/api/preferences", json={"year": PY, "month": PM, "day": 5, "kind": "maybe"}).status_code == 400)
check("clearing a never-set day is a no-op (200)",
      staffA.put("/api/preferences", json={"year": PY, "month": PM, "day": 20, "kind": "none"}).status_code == 200)

# Privacy + scoping.
check("staff can't set another staff's preference (403)",
      staffA.put("/api/preferences", json={"year": PY, "month": PM, "day": 6, "kind": "off", "staff_id": B["id"]}).status_code == 403)
mlist = lead1.get(f"/api/preferences?branch_id={b1}&year={PY}&month={PM}").json()["preferences"]
check("team lead sees branch preferences with staff names",
      any(p["staff_id"] == A["id"] and p.get("staff_name") for p in mlist), mlist)
check("team lead doesn't see another branch's staff",
      not any(p["staff_id"] == C["id"] for p in lead1.get(f"/api/preferences?branch_id={b1}&year={PY}&month={PM}").json()["preferences"]))
# Lead may set a preference for their own branch staff; not another branch's.
ls = lead1.put("/api/preferences", json={"year": PY, "month": PM, "day": 8, "kind": "off", "staff_id": B["id"]})
check("team lead sets a preference for own-branch staff", ls.status_code == 200, ls.text)
check("team lead can't set a preference for another branch (403)",
      lead1.put("/api/preferences", json={"year": PY, "month": PM, "day": 8, "kind": "off", "staff_id": C["id"]}).status_code == 403)

print(f"\n=== RESULT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
