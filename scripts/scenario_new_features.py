"""Edge-case scenarios for the features added this session:
  - Support tickets (scoping, privacy, permissions, thread, status flow)
  - Announcements / circulars (permissions, branch privacy, ack, broadcast)
  - Employee of the Month
  - Per-shift equipment checks (eligibility, sharing, reopen, cross-branch)

Run against a throwaway Postgres:
  COOKIE_SECURE=0 SMTP_CAPTURE=1 DATABASE_URL=... python scripts/scenario_new_features.py
"""
import os, sys, re
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
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": u, "password": p})
    assert r.status_code == 200, f"login {u}: {r.status_code} {r.text}"
    return c

print("\n== setup ==")
admin = login("admin", "admin123")
S = "nf"
brs = admin.get("/api/branches").json()
b1, b2 = brs[0]["id"], brs[1]["id"]
A  = admin.post("/api/staff", json={"name": "NF A", "branch_id": b1, "phone": "0501112233", "email": "nfa@x.com"}).json()
B  = admin.post("/api/staff", json={"name": "NF B", "branch_id": b1}).json()
C  = admin.post("/api/staff", json={"name": "NF C", "branch_id": b2}).json()
for u, st in ((f"sa{S}", A), (f"sb{S}", B), (f"sc{S}", C)):
    admin.post("/api/users", json={"username": u, "password": "pass123", "role": "staff", "staff_id": st["id"]})
admin.post("/api/users", json={"username": f"l1{S}", "password": "pass123", "role": "admin", "branch_id": b1})
admin.post("/api/users", json={"username": f"l2{S}", "password": "pass123", "role": "admin", "branch_id": b2})
staffA, staffB, staffC = login(f"sa{S}", "pass123"), login(f"sb{S}", "pass123"), login(f"sc{S}", "pass123")
lead1, lead2 = login(f"l1{S}", "pass123"), login(f"l2{S}", "pass123")
check("setup: two branches + staff/leads", all([b1, b2, A.get("id"), B.get("id"), C.get("id")]))

# ── Tickets ───────────────────────────────────────────────────────────────────
print("\n== tickets: scoping, privacy, permissions, flow ==")
bad = staffA.post("/api/tickets", json={"subject": "   "})
check("empty subject rejected", bad.status_code == 400, bad.text)
tk = staffA.post("/api/tickets", json={"subject": "CT scanner down", "category": "device_fault",
                                       "priority": "high", "description": "No power"})
check("staff raises a ticket", tk.status_code == 200, tk.text)
tid = tk.json().get("id")
check("branch lead sees the ticket", any(t["id"] == tid for t in lead1.get("/api/tickets").json()))
check("OTHER branch lead does NOT see it", not any(t["id"] == tid for t in lead2.get("/api/tickets").json()))
check("unrelated staff can't view detail", staffC.get(f"/api/tickets/{tid}").status_code == 403)
check("unrelated staff can't change status",
      staffC.put(f"/api/tickets/{tid}/status", json={"status": "resolved"}).status_code == 403)
check("unrelated staff can't delete", staffC.delete(f"/api/tickets/{tid}").status_code == 403)
check("staff can't change own ticket status",
      staffA.put(f"/api/tickets/{tid}/status", json={"status": "resolved"}).status_code == 403)
# Escalate → creator can no longer delete (only while open)
esc = lead1.put(f"/api/tickets/{tid}/status", json={"status": "escalated", "note": "to facilities"})
check("lead escalates", esc.status_code == 200 and esc.json().get("status") == "escalated", esc.text)
check("creator can't delete after it's escalated", staffA.delete(f"/api/tickets/{tid}").status_code == 403)
an = staffA.get("/api/notifications").json()
check("creator notified of escalation", any("escalat" in (n["message"] or "").lower() for n in an["notifications"]))
# Reply both directions
staffA.post(f"/api/tickets/{tid}/updates", json={"body": "Still down"})
check("lead notified of staff reply", any("reply" in (n["message"] or "").lower() for n in lead1.get("/api/notifications").json()["notifications"]))
lead1.post(f"/api/tickets/{tid}/updates", json={"body": "Technician on the way"})
check("creator notified of lead reply", any("reply" in (n["message"] or "").lower() for n in staffA.get("/api/notifications").json()["notifications"]))
# Resolve with resolution
res = lead1.put(f"/api/tickets/{tid}/status", json={"status": "resolved", "note": "Swapped PSU"})
det = staffA.get(f"/api/tickets/{tid}").json()
check("resolution stored", "psu" in (det.get("resolution") or "").lower(), det)
check("thread has >=2 status-change entries", sum(1 for u in det.get("updates", []) if u.get("is_status_change")) >= 2)
check("invalid status rejected", lead1.put(f"/api/tickets/{tid}/status", json={"status": "weird"}).status_code == 400)
check("resolved drops out of the active filter",
      not any(t["id"] == tid for t in staffA.get("/api/tickets?status=active").json()))
check("manager (admin) can delete any ticket", admin.delete(f"/api/tickets/{tid}").status_code == 200)

# ── Announcements ─────────────────────────────────────────────────────────────
print("\n== announcements: permissions, branch privacy, ack, broadcast ==")
check("staff can't post", staffA.post("/api/announcements", json={"title": "x", "body": "y"}).status_code == 403)
check("team lead can't post to ALL staff",
      lead1.post("/api/announcements", json={"title": "x", "body": "y", "audience": "all"}).status_code == 403)
lb = lead1.post("/api/announcements", json={"title": "B1 only", "body": "hi", "audience": "branch"})
check("team lead posts to own branch", lb.status_code == 200, lb.text)
lbid = lb.json().get("id")
check("branch-1 staff sees the branch circular", any(a["id"] == lbid for a in staffA.get("/api/announcements").json()))
check("branch-2 staff does NOT see it (privacy)", not any(a["id"] == lbid for a in staffC.get("/api/announcements").json()))
# Manager all-staff action-required + ack
mp = admin.post("/api/announcements", json={"title": "Policy", "body": "Read please", "kind": "action_required"})
maid = mp.json().get("id")
check("all-staff circular visible to branch-2 too", any(a["id"] == maid for a in staffC.get("/api/announcements").json()))
check("ack works", staffA.post(f"/api/announcements/{maid}/ack", json={}).status_code == 200)
check("ack reflected", next((a for a in staffA.get("/api/announcements").json() if a["id"] == maid), {}).get("acked") is True)
acks = admin.get(f"/api/announcements/{maid}/acks").json()
check("manager sees acks list", any(r["username"] == f"sa{S}" for r in acks))
check("staff can't read the acks list", staffA.get(f"/api/announcements/{maid}/acks").status_code == 403)
check("non-owner staff can't delete", staffA.delete(f"/api/announcements/{maid}").status_code == 403)
# Broadcast personalisation
os.environ["WHATSAPP_CAPTURE"] = "1"; os.environ["WHATSAPP_ONLY_TYPES"] = "approved"  # excludes 'announcement'
M._whatsapp_outbox.clear(); M._email_outbox.clear()
try:
    br = admin.post("/api/announcements", json={"title": "Drill", "body": "Hi {name}", "kind": "announcement", "broadcast": True})
    check("broadcast delivered", br.status_code == 200 and br.json().get("delivered", 0) > 0, br.text)
    wamsg = [m for m in M._whatsapp_outbox if m["to"] == "966501112233"]   # NF A's phone
    check("broadcast forced past type filter (WhatsApp)", any("drill" in (m["message"] or "").lower() for m in wamsg), M._whatsapp_outbox)
    check("broadcast personalised with name", any("NF A" in (m["message"] or "") and "{name}" not in (m["message"] or "") for m in wamsg), wamsg)
finally:
    os.environ.pop("WHATSAPP_CAPTURE", None); os.environ.pop("WHATSAPP_ONLY_TYPES", None)

# ── Employee of the Month ─────────────────────────────────────────────────────
print("\n== employee of the month ==")
check("staff can't set EOTM", staffA.put("/api/employee-of-month", json={"staff_id": B["id"]}).status_code == 403)
check("invalid staff id 404", admin.put("/api/employee-of-month", json={"staff_id": 99999999}).status_code == 404)
check("manager sets EOTM", admin.put("/api/employee-of-month", json={"staff_id": A["id"], "note": "Great"}).status_code == 200)
check("everyone reads EOTM", (staffC.get("/api/employee-of-month").json().get("staff") or {}).get("id") == A["id"])
admin.put("/api/employee-of-month", json={"staff_id": None})
check("EOTM cleared", admin.get("/api/employee-of-month").json().get("staff") is None)

# ── Shift checks ──────────────────────────────────────────────────────────────
print("\n== per-shift equipment checks ==")
YEAR, MONTH = 2026, 9
sid = admin.post("/api/schedules/open", json={"branch_id": b1, "year": YEAR, "month": MONTH}).json()["schedule"]["id"]
D = f"{YEAR}-09-10"
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": D, "shift_code": "M"})
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": B["id"], "date": D, "shift_code": "N"})
check("off-shift staff can't confirm morning", staffB.post("/api/shift-checks", json={"branch_id": b1, "date": D, "shift": "M"}).status_code == 403)
check("cross-branch staff can't confirm", staffC.post("/api/shift-checks", json={"branch_id": b1, "date": D, "shift": "M"}).status_code == 403)
ca = staffA.post("/api/shift-checks", json={"branch_id": b1, "date": D, "shift": "M"})
check("on-shift morning confirm", ca.status_code == 200 and ca.json().get("done") is True, ca.text)
check("re-confirm idempotent", staffA.post("/api/shift-checks", json={"branch_id": b1, "date": D, "shift": "M"}).json().get("done") is True)
st = staffA.get(f"/api/shift-checks?branch_id={b1}&date={D}").json()
check("status: morning done, night pending",
      next(c for c in st["checks"] if c["shift"] == "M")["done"] is True
      and next(c for c in st["checks"] if c["shift"] == "N")["done"] is False, st)
check("night staff confirms night", staffB.post("/api/shift-checks", json={"branch_id": b1, "date": D, "shift": "N"}).status_code == 200)
check("invalid shift rejected", admin.post("/api/shift-checks", json={"branch_id": b1, "date": D, "shift": "Z"}).status_code == 400)
check("lead can reopen", lead1.put("/api/shift-checks/reopen", json={"branch_id": b1, "date": D, "shift": "M"}).status_code == 200)
check("reopened is pending again",
      next(c for c in admin.get(f"/api/shift-checks?branch_id={b1}&date={D}").json()["checks"] if c["shift"] == "M")["done"] is False)
check("cross-branch staff can't read another branch's checks", staffC.get(f"/api/shift-checks?branch_id={b1}&date={D}").status_code == 403)
ov = admin.get(f"/api/shift-checks/overview?date={D}").json()
check("overview lists branches", any(b["branch_id"] == b1 for b in ov["branches"]))

# ── Notification targeting: only on-duty staff get the cases reminder ──────────
print("\n== cases reminder targets only on-duty staff ==")
D2 = f"{YEAR}-09-20"
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": B["id"], "date": D2, "shift_code": "N"})
M.q("UPDATE scheduling.staff SET can_report=true WHERE id=%s", (A["id"],), exec_only=True)  # A is can_report but OFF on D2
rd = admin.post(f"/api/daily-cases/remind?date={D2}&force=1", json={})
check("cases reminder runs", rd.status_code == 200, rd.text)
key = "daily case numbers"
na = [n for n in staffA.get("/api/notifications").json()["notifications"] if key in (n["message"] or "")]
nb = [n for n in staffB.get("/api/notifications").json()["notifications"] if key in (n["message"] or "")]
check("off-duty can_report staff is NOT reminded", len(na) == 0, na)
check("on-duty night staff IS reminded", len(nb) >= 1, nb)

print(f"\n=== RESULT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
