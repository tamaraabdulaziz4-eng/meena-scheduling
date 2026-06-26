"""Scenarios for the consumables inventory feature.

Run: COOKIE_SECURE=0 SMTP_CAPTURE=1 DATABASE_URL=... python scripts/scenario_inventory.py
"""
import os, sys
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
    assert r.status_code == 200, f"login {u}: {r.status_code} {r.text}"
    return c

print("\n== setup ==")
admin = login("admin", "admin123")          # superadmin
S = "inv"
brs = admin.get("/api/branches").json()
b1, b2 = brs[0]["id"], brs[1]["id"]
A = admin.post("/api/staff", json={"name": "INV Staff A", "branch_id": b1}).json()
C = admin.post("/api/staff", json={"name": "INV Staff C", "branch_id": b2}).json()
for u, st in ((f"ia{S}", A), (f"ic{S}", C)):
    admin.post("/api/users", json={"username": u, "password": "pass123", "role": "staff", "staff_id": st["id"]})
admin.post("/api/users", json={"username": f"il1{S}", "password": "pass123", "role": "admin", "branch_id": b1})
admin.post("/api/users", json={"username": f"il2{S}", "password": "pass123", "role": "admin", "branch_id": b2})
staffA, staffC = login(f"ia{S}", "pass123"), login(f"ic{S}", "pass123")
leadA, leadB = login(f"il1{S}", "pass123"), login(f"il2{S}", "pass123")
check("setup ok", all([b1, b2, A.get("id"), C.get("id")]) and b1 != b2)

# ── Create + defaults ─────────────────────────────────────────────────────────
print("\n== create item + reorder defaults to half ==")
it = admin.post("/api/inventory", json={"branch_id": b1, "name": "Contrast 100ml", "unit": "bottle", "full_qty": 10})
check("admin creates an item", it.status_code == 200 and "id" in it.json(), it.text)
iid = it.json()["id"]
check("reorder level defaults to half of full", float(it.json()["reorder_level"]) == 5, it.json())
lst = staffA.get("/api/inventory").json()["items"]
row = next((r for r in lst if r["id"] == iid), None)
check("item appears with qty=full, pct=100, not low",
      row and row["qty"] == 10 and row["full_qty"] == 10 and row["pct"] == 100 and row["low"] is False, row)
check("staff can't create items (403)",
      staffA.post("/api/inventory", json={"name": "X", "full_qty": 5}).status_code == 403)

# ── Taking stock decrements; low triggers an alert ────────────────────────────
print("\n== staff takes stock → decrements → low alert at reorder ==")
t1 = staffA.post(f"/api/inventory/{iid}/take", json={"amount": 3, "reason": "CT contrast"})
check("staff takes 3 → qty 7", t1.status_code == 200 and t1.json()["qty"] == 7, t1.text)
row = next(r for r in staffA.get("/api/inventory").json()["items"] if r["id"] == iid)
check("still above reorder, not low", row["low"] is False and row["qty"] == 7, row)
t2 = staffA.post(f"/api/inventory/{iid}/take", json={"amount": 3})
check("staff takes 3 more → qty 4 (≤ reorder 5)", t2.json()["qty"] == 4)
row = next(r for r in staffA.get("/api/inventory").json()["items"] if r["id"] == iid)
check("item is now flagged low", row["low"] is True, row)
notes = [n for n in leadA.get("/api/notifications").json()["notifications"] if "Low stock" in (n["message"] or "")]
check("branch lead got a low-stock alert", len(notes) >= 1, notes[:1])
check("the OTHER branch lead was NOT alerted",
      not any("Low stock" in (n["message"] or "") for n in leadB.get("/api/notifications").json()["notifications"]))

# ── Validation + edge cases ───────────────────────────────────────────────────
print("\n== validation + edges ==")
check("take 0 is rejected (400)", staffA.post(f"/api/inventory/{iid}/take", json={"amount": 0}).status_code == 400)
check("take negative is rejected (400)", staffA.post(f"/api/inventory/{iid}/take", json={"amount": -2}).status_code == 400)
over = staffA.post(f"/api/inventory/{iid}/take", json={"amount": 100})
check("taking more than available floors at 0 (no negative stock)", over.status_code == 200 and over.json()["qty"] == 0, over.text)
check("staff of another branch can't take from this item (403)",
      staffC.post(f"/api/inventory/{iid}/take", json={"amount": 1}).status_code == 403)

# ── Restock clears the low flag + re-alerts later ─────────────────────────────
print("\n== restock ==")
check("staff can't restock (403)", staffA.post(f"/api/inventory/{iid}/restock", json={"amount": 10}).status_code == 403)
rs = leadA.post(f"/api/inventory/{iid}/restock", json={"amount": 10})
check("lead restocks → qty 10", rs.status_code == 200 and rs.json()["qty"] == 10, rs.text)
# clearing low_notified: drain again should produce a NEW alert
leadA.get("/api/notifications")  # noop
staffA.post(f"/api/inventory/{iid}/take", json={"amount": 7})  # 10→3, below 5 again
again = [n for n in leadA.get("/api/notifications").json()["notifications"] if "Low stock" in (n["message"] or "")]
check("a fresh low-stock alert fires after restock+drain", len(again) >= 2, len(again))

# ── History + scoping + delete ────────────────────────────────────────────────
print("\n== history, scoping, delete ==")
hist = leadA.get(f"/api/inventory/{iid}/movements").json()["movements"]
check("movement history records the takes/restock", len(hist) >= 4 and any(m["delta"] < 0 for m in hist) and any(m["delta"] > 0 for m in hist), len(hist))
check("staff can't read history (403)", staffA.get(f"/api/inventory/{iid}/movements").status_code == 403)
# branch scoping: item on b2 not visible to staff A
admin.post("/api/inventory", json={"branch_id": b2, "name": "Gloves", "full_qty": 20})
check("staff A sees only their own branch's items",
      all(r["branch_id"] == b1 for r in staffA.get("/api/inventory").json()["items"]))
check("lead can't touch another branch's item (403)",
      leadB.put(f"/api/inventory/{iid}", json={"name": "X", "full_qty": 5}).status_code == 403)
ed = leadA.put(f"/api/inventory/{iid}", json={"name": "Contrast 100ml", "unit": "bottle", "full_qty": 12, "reorder_level": 4})
check("lead edits the item (new full + reorder)", ed.status_code == 200, ed.text)
row = next(r for r in leadA.get("/api/inventory").json()["items"] if r["id"] == iid)
check("edit reflected", row["full_qty"] == 12 and row["reorder_level"] == 4, row)
check("delete unknown item (404)", leadA.delete("/api/inventory/99999999").status_code == 404)
check("lead deletes the item", leadA.delete(f"/api/inventory/{iid}").status_code == 200)
check("item gone after delete", not any(r["id"] == iid for r in leadA.get("/api/inventory").json()["items"]))

print(f"\n=== RESULT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
