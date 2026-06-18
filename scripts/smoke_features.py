"""End-to-end smoke test for the new features, run against a real Postgres.

Covers: leave approval + schedule sync, in-app notifications, the multi-stage
shift-swap chain (peer→lead→manager) incl. race/overlap/permission guards, the
staff portal, and manager-edits-locked-schedule.

Run with DATABASE_URL pointing at a throwaway DB.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient
import server.main as M

# Trigger the same startup the server runs (idempotent).
M.init_schema(); M.seed_defaults(); M.seed_nest_config(); M.seed_admin()

app = M.app
PASS, FAIL = 0, 0
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
admin = login("admin", "admin123")           # superadmin (acts as manager too)
branches = admin.get("/api/branches").json()
nest3 = next(b for b in branches if "NEST 3" in b["name"] or "NEST3" in b["name"].upper())
bid = nest3["id"]

# two fresh staff in NEST 3
A = admin.post("/api/staff", json={"name": "ZZ Tester A", "branch_id": bid}).json()
B = admin.post("/api/staff", json={"name": "ZZ Tester B", "branch_id": bid}).json()
check("create staff A", "id" in A, A)
check("create staff B", "id" in B, B)

import time
sfx = str(int(time.time()))[-5:]
# user accounts: staff A, staff B, and a branch team lead
ua = admin.post("/api/users", json={"username": f"zza{sfx}", "password": "pass123", "role": "staff", "staff_id": A["id"]})
ub = admin.post("/api/users", json={"username": f"zzb{sfx}", "password": "pass123", "role": "staff", "staff_id": B["id"]})
ul = admin.post("/api/users", json={"username": f"zzlead{sfx}", "password": "pass123", "role": "admin", "branch_id": bid})
check("create staff-user A", ua.status_code == 200, ua.text)
check("create staff-user B", ub.status_code == 200, ub.text)
check("staff-user A branch follows staff record", ua.json().get("branch_id") == bid, ua.json())
check("create team lead", ul.status_code == 200, ul.text)

staffA = login(f"zza{sfx}", "pass123")
staffB = login(f"zzb{sfx}", "pass123")
lead   = login(f"zzlead{sfx}", "pass123")

YEAR, MONTH = 2026, 8
sched = admin.post("/api/schedules/open", json={"branch_id": bid, "year": YEAR, "month": MONTH}).json()
sid = sched["schedule"]["id"]
# seed two cells we will later swap
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": f"{YEAR}-08-01", "shift_code": "M"})
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": B["id"], "date": f"{YEAR}-08-02", "shift_code": "N"})

print("\n== scenario 1: leave request -> approve -> lands on rota + notifications ==")
# staff A requests AL on 2026-08-10
lr = staffA.post("/api/leaves", json={"date_from": f"{YEAR}-08-10", "date_to": f"{YEAR}-08-10", "leave_type": "AL"})
check("staff can request leave", lr.status_code == 200, lr.text)
check("staff leave is pending", lr.json().get("status") == "pending", lr.json())
# manager notified
notes = admin.get("/api/notifications").json()
check("manager notified of leave request", any("leave" in (n["message"] or "").lower() for n in notes["notifications"]), notes)
# find the leave id and approve
leaves = admin.get(f"/api/leaves?branch_id={bid}&year={YEAR}&month={MONTH}").json()
lv = next((l for l in leaves if l["staff_id"] == A["id"] and l["date"] == f"{YEAR}-08-10"), None)
check("leave visible to manager", lv is not None, leaves)
ap = admin.put(f"/api/leaves/{lv['id']}/status", json={"status": "approved"})
check("manager approves leave", ap.status_code == 200, ap.text)
# the AL should now be on the schedule
ents = admin.get(f"/api/schedules/{sid}/entries").json()
al = next((e for e in ents if e["staff_id"] == A["id"] and e["date"] == f"{YEAR}-08-10"), None)
check("approved leave written to rota as AL", al and al["shift_code"] == "AL", al)
# staff A notified of approval
na = staffA.get("/api/notifications").json()
check("staff notified leave approved", any("approved" in (n["message"] or "").lower() for n in na["notifications"]), na)

print("\n== scenario 2: staff portal + privacy ==")
mys = staffA.get(f"/api/my-schedule?year={YEAR}&month={MONTH}")
check("staff can read my-schedule", mys.status_code == 200, mys.text)
check("my-schedule only own rows", all(True for _ in [0]) and isinstance(mys.json().get("entries"), list), mys.text)
leak = staffA.get(f"/api/schedules/{sid}/entries")
check("staff blocked from full team rota (403)", leak.status_code == 403, leak.status_code)

print("\n== scenario 3: multi-stage swap (peer -> lead -> manager) ==")
sw = staffA.post("/api/swaps", json={"staff_b": B["id"], "date_a": f"{YEAR}-08-01", "date_b": f"{YEAR}-08-02"})
check("staff A requests swap", sw.status_code == 200, sw.text)
swid = sw.json()["id"]
# peer B notified
nb = staffB.get("/api/notifications").json()
check("peer B notified of swap request", any("swap" in (n["message"] or "").lower() for n in nb["notifications"]), nb)
# wrong actor: lead can't approve while still pending_peer
bad = lead.put(f"/api/swaps/{swid}/action", json={"action": "approve"})
check("lead can't approve before peer accepts (403)", bad.status_code == 403, bad.status_code)
# staff can't jump to manager approval
bad2 = staffA.put(f"/api/swaps/{swid}/action", json={"action": "approve"})
check("requester can't self-approve peer step (403)", bad2.status_code == 403, bad2.status_code)
# peer accepts
r = staffB.put(f"/api/swaps/{swid}/action", json={"action": "accept"})
check("peer accepts -> pending_lead", r.status_code == 200 and r.json()["status"] == "pending_lead", r.text)
# lead approves
r = lead.put(f"/api/swaps/{swid}/action", json={"action": "approve"})
check("lead approves -> pending_manager", r.status_code == 200 and r.json()["status"] == "pending_manager", r.text)
# manager final approve -> applied
r = admin.put(f"/api/swaps/{swid}/action", json={"action": "approve"})
check("manager approves -> approved", r.status_code == 200 and r.json()["status"] == "approved", r.text)
ents = admin.get(f"/api/schedules/{sid}/entries").json()
ca = next((e for e in ents if e["staff_id"] == A["id"] and e["date"] == f"{YEAR}-08-01"), None)
cb = next((e for e in ents if e["staff_id"] == B["id"] and e["date"] == f"{YEAR}-08-02"), None)
check("cells exchanged: A 08-01 now N", ca and ca["shift_code"] == "N", ca)
check("cells exchanged: B 08-02 now M", cb and cb["shift_code"] == "M", cb)
# double-finalise is a no-op
again = admin.put(f"/api/swaps/{swid}/action", json={"action": "approve"})
check("re-approving finished swap rejected", again.status_code == 400, again.status_code)

print("\n== scenario 4: swap guards ==")
# overlap: A requests another swap reusing 08-01
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": f"{YEAR}-08-05", "shift_code": "M"})
# first reset 08-01 to a workable shift for a new swap attempt
ov = staffA.post("/api/swaps", json={"staff_b": B["id"], "date_a": f"{YEAR}-08-01", "date_b": f"{YEAR}-08-05"})
# 08-01 is not in a pending swap anymore (previous one approved), so this should succeed;
# now immediately request another touching 08-01 again -> overlap 409
ov2 = staffA.post("/api/swaps", json={"staff_b": B["id"], "date_a": f"{YEAR}-08-01", "date_b": f"{YEAR}-08-05"})
check("overlapping pending swap on same cell rejected (409)", ov2.status_code == 409, f"{ov2.status_code} {ov2.text}")
# cross-month rejected
xm = staffA.post("/api/swaps", json={"staff_b": B["id"], "date_a": f"{YEAR}-08-20", "date_b": f"{YEAR}-09-20"})
check("cross-month swap rejected", xm.status_code == 400, xm.status_code)
# swap with self rejected
xs = staffA.post("/api/swaps", json={"staff_b": A["id"], "date_a": f"{YEAR}-08-21", "date_b": f"{YEAR}-08-22"})
check("swap with self rejected", xs.status_code == 400, xs.status_code)

print("\n== scenario 5: manager edits a locked schedule; team lead blocked ==")
admin.put(f"/api/schedules/{sid}/status", json={"status": "submitted"})  # locks it
le = lead.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": f"{YEAR}-08-15", "shift_code": "M"})
check("team lead blocked on locked schedule (403)", le.status_code == 403, le.status_code)
me = admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": f"{YEAR}-08-15", "shift_code": "D"})
check("manager can edit locked schedule", me.status_code == 200, me.text)

print("\n== scenario 6: a real 'manager'-role account can manage/approve ==")
um = admin.post("/api/users", json={"username": f"zzmgr{sfx}", "password": "pass123", "role": "manager"})
check("create manager user", um.status_code == 200, um.text)
mgr = login(f"zzmgr{sfx}", "pass123")
# manager can add staff (any branch)
ms = mgr.post("/api/staff", json={"name": "ZZ Mgr Added", "branch_id": bid})
check("manager can add staff", ms.status_code == 200, ms.text)
# manager can approve a pending leave (request one from staff B first)
lrB = staffB.post("/api/leaves", json={"date_from": f"{YEAR}-08-12", "date_to": f"{YEAR}-08-12", "leave_type": "AL"})
lvs = mgr.get(f"/api/leaves?branch_id={bid}&year={YEAR}&month={MONTH}").json()
lvB = next((l for l in lvs if l["staff_id"] == B["id"] and l["status"] == "pending"), None)
check("manager sees pending leave", lvB is not None, lvs)
apm = mgr.put(f"/api/leaves/{lvB['id']}/status", json={"status": "approved"}) if lvB else None
check("manager approves leave", apm is not None and apm.status_code == 200, getattr(apm, "text", None))
# manager cannot generate (editor-only)
gen = mgr.post("/api/generate", json={"branch_id": bid, "year": YEAR, "month": MONTH})
check("manager blocked from generate (403)", gen.status_code == 403, gen.status_code)

print("\n== scenario 7: coverage-gap warning on late leave approval ==")
# Put A as the only person on shift M on 08-25, then request leave that day.
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": f"{YEAR}-08-25", "shift_code": "M"})
staffA.post("/api/leaves", json={"date_from": f"{YEAR}-08-25", "date_to": f"{YEAR}-08-25", "leave_type": "AL"})
lvs = admin.get(f"/api/leaves?branch_id={bid}&year={YEAR}&month={MONTH}").json()
g = next((l for l in lvs if l["staff_id"] == A["id"] and l["date"] == f"{YEAR}-08-25"), None)
r1 = admin.put(f"/api/leaves/{g['id']}/status", json={"status": "approved"})
check("gap leave warns before approving (409)", r1.status_code == 409, f"{r1.status_code} {r1.text}")
check("warning flags coverage_gap", (r1.json().get("detail") or {}).get("confirm_required") == "coverage_gap", r1.text)
r2 = admin.put(f"/api/leaves/{g['id']}/status", json={"status": "approved", "confirm": True})
check("approve-anyway with confirm succeeds", r2.status_code == 200, r2.text)
ents = admin.get(f"/api/schedules/{sid}/entries").json()
gal = next((e for e in ents if e["staff_id"] == A["id"] and e["date"] == f"{YEAR}-08-25"), None)
check("gap day now AL", gal and gal["shift_code"] == "AL", gal)
# team lead notified of the gap
nl = lead.get("/api/notifications").json()
check("team lead notified of coverage gap", any("gap" in (n["message"] or "").lower() for n in nl["notifications"]), nl)

print("\n== scenario 8: generate warns when leaves are still pending ==")
# leave a pending request on the books for this month
staffB.post("/api/leaves", json={"date_from": f"{YEAR}-08-26", "date_to": f"{YEAR}-08-26", "leave_type": "AL"})
# (schedule is currently locked from scenario 5; unlock so generate reaches the leave check)
admin.put(f"/api/schedules/{sid}/status", json={"status": "draft"})
g1 = admin.post("/api/generate", json={"branch_id": bid, "year": YEAR, "month": MONTH})
check("generate warns on pending leaves (409)", g1.status_code == 409, f"{g1.status_code} {g1.text}")
check("warning flags pending_leaves", (g1.json().get("detail") or {}).get("confirm_required") == "pending_leaves", g1.text)

print("\n== scenario 9: leave cutoff for future months ==")
from datetime import date as _date
check("window open before cutoff",  M.leave_window_open("2026-09-10", 15, today=_date(2026,8,10))[0] is True)
check("window closed after cutoff", M.leave_window_open("2026-09-10", 15, today=_date(2026,8,20))[0] is False)
check("far-future window open",     M.leave_window_open("2026-12-10", 15, today=_date(2026,8,20))[0] is True)
check("same-month request blocked", M.leave_window_open("2026-08-10", 15, today=_date(2026,8,20))[0] is False)
check("next-month before cutoff open", M.leave_window_open("2026-07-10", 15, today=_date(2026,6,10))[0] is True)
check("next-month after cutoff blocked", M.leave_window_open("2026-07-10", 15, today=_date(2026,6,16))[0] is False)
# API: with cutoff=1, next month is closed for staff but a manager can override
admin.put("/api/settings", json={"leave_cutoff_day": 1})
import datetime as _dt
t = _dt.date.today()
nm = (t.month % 12) + 1; nmy = t.year + (1 if t.month == 12 else 0)
nd = f"{nmy}-{nm:02d}-10"
mgrL = mgr.post("/api/leaves", json={"staff_id": A["id"], "date_from": nd, "date_to": nd, "leave_type": "AL"})
check("manager bypasses cutoff", mgrL.status_code == 200, mgrL.text)
stL = staffA.post("/api/leaves", json={"date_from": nd, "date_to": nd, "leave_type": "AL"})
if t.day > 1:
    check("staff blocked past cutoff", stL.status_code == 400, f"{stL.status_code} {stL.text}")
else:
    check("staff cutoff (today is day 1 — skipped)", True)
admin.put("/api/settings", json={"leave_cutoff_day": 15})
# Same-month request from a staff member is always blocked (deadline long past)
cm = f"{t.year}-{t.month:02d}-{min(t.day, 28):02d}"
stCM = staffA.post("/api/leaves", json={"date_from": cm, "date_to": cm, "leave_type": "AL"})
check("staff blocked for current month", stCM.status_code == 400, f"{stCM.status_code} {stCM.text}")
# A malformed date must be a clean 400 (the cutoff check used to 500 before the
# date-format validation could run).
stBad = staffA.post("/api/leaves", json={"date_from": "not-a-date", "date_to": "not-a-date", "leave_type": "AL"})
check("malformed leave date → 400 (not 500)", stBad.status_code == 400, f"{stBad.status_code} {stBad.text}")

print("\n== scenario 9b: staff withdraws own pending request ==")
staffA.post("/api/leaves", json={"date_from": f"{YEAR}-08-22", "date_to": f"{YEAR}-08-22", "leave_type": "AL"})
wlv = next((l for l in staffA.get(f"/api/leaves?year={YEAR}&month={MONTH}").json() if l["date"] == f"{YEAR}-08-22"), None)
check("withdrawable request visible to staff", wlv is not None, wlv)
xb = staffB.delete(f"/api/leaves/{wlv['id']}")
check("staff can't withdraw another's request", xb.status_code == 403, xb.status_code)
wd = staffA.delete(f"/api/leaves/{wlv['id']}")
check("staff withdraws own pending request", wd.status_code == 200, wd.text)
gone = staffA.get(f"/api/leaves?year={YEAR}&month={MONTH}").json()
check("withdrawn request removed", not any(l["date"] == f"{YEAR}-08-22" for l in gone), gone)
appr = next((l for l in admin.get(f"/api/leaves?branch_id={bid}&year={YEAR}&month={MONTH}").json()
             if l["staff_id"] == A["id"] and l["status"] == "approved"), None)
if appr:
    wa = staffA.delete(f"/api/leaves/{appr['id']}")
    check("staff can't withdraw an approved leave", wa.status_code == 400, wa.status_code)

print("\n== scenario 10: Phase-1 security hardening ==")
# another branch + a staff member in it
branchB = next(b for b in branches if b["id"] != bid)
bidB = branchB["id"]
sB = admin.post("/api/staff", json={"name": "ZZ Other-Branch", "branch_id": bidB}).json()
# C-04: cell validation (independent of who edits)
admin.put(f"/api/schedules/{sid}/status", json={"status": "draft"})  # ensure unlocked
e_wrongbranch = admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": sB["id"], "date": f"{YEAR}-08-03", "shift_code": "M"})
check("reject staff from another branch", e_wrongbranch.status_code == 400, e_wrongbranch.text)
e_wrongmonth = admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": f"{YEAR}-09-03", "shift_code": "M"})
check("reject date outside schedule month", e_wrongmonth.status_code == 400, e_wrongmonth.text)
e_badcode = admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": f"{YEAR}-08-03", "shift_code": "XYZ"})
check("reject unknown shift code", e_badcode.status_code == 400, e_badcode.text)
# C-03: team lead can't unlock an approved schedule; a reviewer can
admin.put(f"/api/schedules/{sid}/status", json={"status": "approved"})
u_lead = lead.put(f"/api/schedules/{sid}/lock", json={"locked": False})
check("team lead can't unlock approved schedule", u_lead.status_code == 403, u_lead.status_code)
u_mgr = admin.put(f"/api/schedules/{sid}/lock", json={"locked": False})
check("reviewer can unlock", u_mgr.status_code == 200, u_mgr.text)
admin.put(f"/api/schedules/{sid}/status", json={"status": "draft"})
# H-05: team lead can't move their staff to a branch they don't manage
mv = lead.put(f"/api/staff/{A['id']}", json={"branch_id": bidB})
check("team lead can't move staff to another branch", mv.status_code == 403, mv.status_code)
# H-03: team lead can't read another branch's settings
bs = lead.get(f"/api/branch-settings/{bidB}")
check("team lead blocked from another branch's settings", bs.status_code == 403, bs.status_code)
# C-01: seed_admin is idempotent (won't reset an existing password)
M.q("UPDATE scheduling.users SET password='SENTINEL' WHERE username='admin'", exec_only=True)
M.seed_admin()
pw = M.q("SELECT password FROM scheduling.users WHERE username='admin'", one=True)["password"]
check("seed_admin does not reset existing password", pw == "SENTINEL", pw)
# H-02: login throttle kicks in after repeated failures
from fastapi.testclient import TestClient as _TC
tc = _TC(app)
codes = [tc.post("/api/auth/login", json={"username": "nobody", "password": "x"}).status_code for _ in range(9)]
check("login throttle returns 429 after many fails", codes[-1] == 429, codes)

print("\n== scenario 11: session invalidation (H-01) ==")
admin.post("/api/users", json={"username": f"zzvic{sfx}", "password": "pass123", "role": "admin", "branch_id": bid})
vic = login(f"zzvic{sfx}", "pass123")
check("victim session works", vic.get("/api/auth/me").status_code == 200)
uid = next(u["id"] for u in admin.get("/api/users").json() if u["username"] == f"zzvic{sfx}")
# password change bumps epoch → old token rejected
admin.put(f"/api/users/{uid}", json={"password": "newpass123"})
check("old token rejected after password change", vic.get("/api/auth/me").status_code == 401)
# deleted account → token rejected
vic2 = login(f"zzvic{sfx}", "newpass123")
admin.delete(f"/api/users/{uid}")
check("token rejected after account deleted", vic2.get("/api/auth/me").status_code == 401)
# role downgrade takes effect immediately (live role, not token role)
admin.post("/api/users", json={"username": f"zzdg{sfx}", "password": "pass123", "role": "admin", "branch_id": bid})
dg = login(f"zzdg{sfx}", "pass123")
uiddg = next(u["id"] for u in admin.get("/api/users").json() if u["username"] == f"zzdg{sfx}")
admin.put(f"/api/users/{uiddg}", json={"role": "viewer"})
check("downgraded user blocked from admin action", dg.post("/api/staff", json={"name": "x", "branch_id": bid}).status_code == 403)

print("\n== scenario 12: reviewer reopens an approved schedule ==")
admin.put(f"/api/schedules/{sid}/status", json={"status": "approved"})
le = lead.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": f"{YEAR}-08-07", "shift_code": "M"})
check("team lead blocked while approved", le.status_code == 403, le.status_code)
rb = admin.put(f"/api/schedules/{sid}/status", json={"status": "returned", "note": "reopen"})
check("reviewer reopened (returned)", rb.status_code == 200 and rb.json().get("status") == "returned", rb.text)
le2 = lead.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": f"{YEAR}-08-07", "shift_code": "M"})
check("team lead can edit after reopen", le2.status_code == 200, le2.text)

print("\n== scenario 13: daily radiology cases report ==")
CD = f"{YEAR}-08-28"
r = lead.post("/api/daily-cases", json={"branch_id": bid, "date": CD, "xray": 23, "ct": 0,
              "us": 14, "mamo": 0, "bmd": 0, "insert_cd": 0, "total_pt": 29,
              "bmd_not_done": 0, "mamo_not_done": 1, "submit": True})
check("team lead submits cases", r.status_code == 200, r.text)
check("total_cases auto-computed (37)", r.json().get("total_cases") == 37, r.json())
check("locked after submit", r.json().get("locked") is True, r.json())
nmgr = mgr.get("/api/notifications").json()
check("manager notified the branch submitted its report",
      any("report submitted" in (n["message"] or "").lower() for n in nmgr["notifications"]), nmgr)
r2 = lead.post("/api/daily-cases", json={"branch_id": bid, "date": CD, "xray": 1, "submit": False})
check("locked report rejects edit", r2.status_code == 403, r2.status_code)
ov = admin.get(f"/api/daily-cases/overview?date={CD}").json()
n3 = next(b for b in ov["branches"] if b["branch_id"] == bid)
check("overview shows the branch case", n3["case"] and n3["case"]["total_cases"] == 37, n3)
check("overview counts submitted", ov["summary"]["submitted"] >= 1, ov["summary"])
check("manager reopens", admin.put("/api/daily-cases/reopen", json={"branch_id": bid, "date": CD}).status_code == 200)
r3 = lead.post("/api/daily-cases", json={"branch_id": bid, "date": CD, "xray": 10, "ct": 0, "us": 0,
              "mamo": 0, "bmd": 0, "insert_cd": 0, "total_pt": 5, "submit": False})
check("editable after reopen", r3.status_code == 200 and r3.json()["total_cases"] == 10, r3.text)
rs = staffA.post("/api/daily-cases", json={"branch_id": bid, "date": CD, "xray": 1, "submit": False})
check("ineligible staff blocked (not night / no flag)", rs.status_code == 403, rs.status_code)
admin.put(f"/api/staff/{A['id']}", json={"can_report": True})
rs2 = staffA.post("/api/daily-cases", json={"branch_id": bid, "date": CD, "xray": 2, "ct": 1, "us": 0,
              "mamo": 0, "bmd": 0, "insert_cd": 0, "total_pt": 2, "submit": False})
check("can_report staff allowed", rs2.status_code == 200, rs2.text)

print("\n== scenario 13c: daily-cases reminders ==")
# CD (2026-08-28) for NEST 3 was reopened + saved as draft above → still pending.
lead_b4 = {n["id"] for n in lead.get("/api/notifications").json()["notifications"]}
rem = admin.post(f"/api/daily-cases/remind?date={CD}", json={})
check("remind endpoint ok", rem.status_code == 200, rem.text)
check("NEST 3 reminded (no locked report)", nest3["name"] in (rem.json().get("reminded") or []), rem.json())
lead_after = [n for n in lead.get("/api/notifications").json()["notifications"] if n["id"] not in lead_b4]
check("team lead got a fill-in reminder", any("hasn't been submitted" in (n["message"] or "").lower() for n in lead_after), lead_after)
check("reminder deduped within 6h", (admin.post(f"/api/daily-cases/remind?date={CD}", json={}).json() or {}).get("skipped"), "expected skipped")
rfx = lead.post(f"/api/daily-cases/remind?date={CD}", json={})
check("remind is superadmin/cron only", rfx.status_code in (401, 403), rfx.status_code)
# auto-reminder hour setting round-trips (and "off" disables)
sr = admin.put("/api/settings", json={"cases_remind_hour": 6})
check("set cases_remind_hour=6", sr.status_code == 200 and str(sr.json().get("cases_remind_hour")) == "6", sr.text)
sroff = admin.put("/api/settings", json={"cases_remind_hour": "off"})
check("cases_remind_hour can be turned off", sroff.json().get("cases_remind_hour") == "off", sroff.text)
admin.put("/api/settings", json={"cases_remind_hour": 7})  # restore default

print("\n== scenario 16: home dashboard summary ==")
dash = admin.get("/api/dashboard")
check("dashboard ok for superadmin", dash.status_code == 200, dash.text)
dj = dash.json()
check("dashboard has the action counters", all(k in dj for k in ("pending_reviews", "pending_leaves", "pending_swaps", "cases_today")), dj)
check("cases_today has submitted/total", "submitted" in dj["cases_today"] and "total" in dj["cases_today"], dj["cases_today"])
dl = lead.get("/api/dashboard")
check("dashboard ok for team lead", dl.status_code == 200, dl.text)
check("team lead sees no schedule-review queue", dl.json().get("pending_reviews") == 0, dl.json())

print("\n== scenario 13b: cases edge cases (regressions) ==")
# Reviewer plain-Save on a locked report must NOT silently unlock it or wipe
# who submitted it — only an actual Submit changes lock/submission state.
CD2 = f"{YEAR}-08-27"
lead.post("/api/daily-cases", json={"branch_id": bid, "date": CD2, "xray": 5, "ct": 0, "us": 0,
          "mamo": 0, "bmd": 0, "insert_cd": 0, "total_pt": 3, "submit": True})
before = lead.get(f"/api/daily-cases?branch_id={bid}&date={CD2}").json()["case"]
check("locked before reviewer save", before["locked"] is True, before)
rsave = admin.post("/api/daily-cases", json={"branch_id": bid, "date": CD2, "xray": 9, "submit": False})
check("reviewer plain-save ok", rsave.status_code == 200, rsave.text)
after = admin.get(f"/api/daily-cases?branch_id={bid}&date={CD2}").json()["case"]
check("reviewer save kept it locked", after["locked"] is True, after)
check("reviewer save kept submitter", after["submitted_by"] == before["submitted_by"], after)
check("reviewer save kept submitted_at", after["submitted_at"] == before["submitted_at"], after)
check("reviewer save applied the edit", after["xray"] == 9, after)
# Non-numeric branch_id is a clean 400, not a 500.
rbad = admin.get("/api/daily-cases?branch_id=abc&date=" + CD2)
check("non-numeric branch_id → 400", rbad.status_code == 400, rbad.status_code)

print("\n== scenario 14: email notifications (SMTP_CAPTURE) ==")
um1 = admin.post("/api/users", json={"username": f"zzmail{sfx}", "password": "pass123",
                 "role": "admin", "branch_id": bid, "email": "mail@example.com"}).json()
M._email_outbox.clear()
M.notify(um1["id"], "Test message")
check("email queued for opted-in user", any(e["to"] == "mail@example.com" for e in M._email_outbox), M._email_outbox)
_h = (M._email_outbox[0].get("html") if M._email_outbox else "") or ""
check("email uses branded HTML template", "Test message" in _h and "Meena" in _h, _h[:120])
admin.put(f"/api/users/{um1['id']}", json={"email_notifications": False})
M._email_outbox.clear()
M.notify(um1["id"], "Should not email")
check("no email when opted out", len(M._email_outbox) == 0, M._email_outbox)
um2 = admin.post("/api/users", json={"username": f"zznomail{sfx}", "password": "pass123",
                 "role": "admin", "branch_id": bid}).json()
M._email_outbox.clear()
M.notify(um2["id"], "x")
check("no email when no address on file", len(M._email_outbox) == 0, M._email_outbox)

print("\n== scenario 14b: Resend payload ==")
import os as _os
_os.environ["RESEND_FROM"] = "Abdulaziz Alanazi <Abdulaziz.alanazi@meena-health.com>"
pl = M._resend_payload("nurse@example.com", "Meena Scheduling", "Your shift swap was approved")
check("resend 'to' is a list", pl["to"] == ["nurse@example.com"], pl["to"])
check("resend 'from' is the verified-domain identity", pl["from"] == _os.environ["RESEND_FROM"], pl["from"])
check("resend includes html + text", "Your shift swap" in pl["html"] and "Your shift swap" in pl["text"], list(pl))
check("resend sets reply_to", pl.get("reply_to") == M._sig_email(), pl.get("reply_to"))
check("resend subject passthrough", pl["subject"] == "Meena Scheduling", pl["subject"])
_os.environ.pop("RESEND_FROM", None)

# email-config diagnostics + a synchronous test send (captured, not real).
ec = admin.get("/api/email-config")
check("email-config readable by superadmin", ec.status_code == 200 and "from" in ec.json(), ec.text)
M._email_outbox.clear()
et = admin.post("/api/email-test", json={"to": "boss@example.com"})
check("email-test sends + returns recipient", et.status_code == 200 and et.json().get("sent_to") == "boss@example.com", et.text)
check("email-test actually delivered (captured)", any(e["to"] == "boss@example.com" for e in M._email_outbox), M._email_outbox)
etf = lead.post("/api/email-test", json={"to": "x@example.com"})
check("email-test is superadmin-only", etf.status_code in (401, 403), etf.status_code)

print("\n== scenario 15: notification hygiene (no dup / no self-notify) ==")
# (a) Batch-approving an N-day leave range → ONE summary notification, not N.
lead_before = {n["id"] for n in lead.get("/api/notifications").json()["notifications"]}
lead.post("/api/leaves", json={"staff_id": B["id"], "date_from": f"{YEAR}-08-15",
          "date_to": f"{YEAR}-08-17", "leave_type": "AL"})   # created_by = team lead
lvls = admin.get(f"/api/leaves?branch_id={bid}&year={YEAR}&month={MONTH}").json()
bids3 = [l["id"] for l in lvls if l["staff_id"] == B["id"]
         and l["date"] in (f"{YEAR}-08-15", f"{YEAR}-08-16", f"{YEAR}-08-17") and l["status"] == "pending"]
check("3-day pending leave created", len(bids3) == 3, bids3)
rb = admin.put("/api/leaves/status", json={"ids": bids3, "status": "approved", "confirm": True})
check("batch approve ok", rb.status_code == 200 and rb.json().get("updated") == 3, rb.text)
lead_new = [n for n in lead.get("/api/notifications").json()["notifications"] if n["id"] not in lead_before]
summary = [n for n in lead_new if "leave day" in (n["message"] or "").lower()]
check("batch approval sends ONE summary (not one per day)", len(summary) == 1, summary)
check("summary mentions the day count", "3 leave day" in (summary[0]["message"] if summary else ""), summary)

# (b) Submitting a schedule does NOT self-notify the submitter, but DOES notify a manager.
s11 = admin.post("/api/schedules/open", json={"branch_id": bid, "year": YEAR, "month": 11}).json()
sid11 = s11["schedule"]["id"]
a_before = {n["id"] for n in admin.get("/api/notifications").json()["notifications"]}
m_before = {n["id"] for n in mgr.get("/api/notifications").json()["notifications"]}
admin.put(f"/api/schedules/{sid11}/status", json={"status": "submitted"})
a_new = [n for n in admin.get("/api/notifications").json()["notifications"] if n["id"] not in a_before]
m_new = [n for n in mgr.get("/api/notifications").json()["notifications"] if n["id"] not in m_before]
check("submitter gets no self 'submitted' notification",
      not any("submitted for review" in (n["message"] or "").lower() for n in a_new), a_new)
check("a manager IS notified of the submission",
      any("submitted for review" in (n["message"] or "").lower() for n in m_new), m_new)

print("\n== scenario 17: forgot / reset password ==")
import re
anon = TestClient(app)
admin.post("/api/users", json={"username": f"zzreset{sfx}", "password": "oldpass123",
           "role": "admin", "branch_id": bid, "email": "reset@example.com"})
M._email_outbox.clear()
fr = anon.post("/api/auth/forgot", json={"username": f"zzreset{sfx}"})
check("forgot returns generic ok", fr.status_code == 200 and fr.json().get("ok") is True, fr.text)
mail = [e for e in M._email_outbox if e["to"] == "reset@example.com"]
check("reset email sent to the address on file", len(mail) == 1, M._email_outbox)
mtok = re.search(r"/\?reset=([A-Za-z0-9_\-]+)", mail[-1]["body"] if mail else "")
check("reset email carries a token link", bool(mtok), mail[-1]["body"] if mail else None)
token = mtok.group(1) if mtok else ""
bad = anon.post("/api/auth/reset", json={"token": "not-a-real-token", "password": "whatever123"})
check("invalid reset token rejected", bad.status_code == 400, bad.status_code)
rr = anon.post("/api/auth/reset", json={"token": token, "password": "newpass456"})
check("reset succeeds with a valid token", rr.status_code == 200, rr.text)
check("old password no longer works",
      anon.post("/api/auth/login", json={"username": f"zzreset{sfx}", "password": "oldpass123"}).status_code == 401)
check("new password works",
      anon.post("/api/auth/login", json={"username": f"zzreset{sfx}", "password": "newpass456"}).status_code == 200)
check("reset token is single-use",
      anon.post("/api/auth/reset", json={"token": token, "password": "another789"}).status_code == 400)
M._email_outbox.clear()
fr2 = anon.post("/api/auth/forgot", json={"username": "nobody-here-9999"})
check("forgot hides non-existent accounts (generic + no email)",
      fr2.status_code == 200 and len(M._email_outbox) == 0, M._email_outbox)

print("\n== scenario 18: staff self-registration ==")
anon2 = TestClient(app)
# Closed by default → the public form is blocked.
check("registration closed by default", anon2.get("/api/register/info?code=whatever").status_code == 403)
# Superadmin enables it and gets a shareable link with a code.
en = admin.put("/api/settings", json={"registration": "on"})
check("superadmin can open registration", en.status_code == 200 and en.json().get("registration_open") is True, en.text)
link = en.json().get("registration_link") or ""
code = link.split("register=")[-1]
check("registration link carries a code", bool(code), link)
check("team lead can't see the registration code", "registration_link" not in lead.get("/api/settings").json())
# Valid code → the form can load branches and submit.
info = anon2.get(f"/api/register/info?code={code}")
check("valid code unlocks the form", info.status_code == 200 and len(info.json().get("branches", [])) >= 1, info.text)
reg = anon2.post("/api/register", json={"code": code, "name": "ZZ Self Signup",
                 "branch_id": bid, "employee_id": f"EID{sfx}", "email": "self@example.com", "phone": "0500000000"})
check("self-registration accepted (pending)", reg.status_code == 200, reg.text)
# It does NOT create a staff record yet — it waits for the team lead.
made_now = next((s for s in admin.get(f"/api/staff?branch_id={bid}").json() if s.get("employee_id") == f"EID{sfx}"), None)
check("registration is pending, no staff record yet", made_now is None, made_now)
# Re-submit same ID → still one pending entry (replaces).
anon2.post("/api/register", json={"code": code, "name": "ZZ Self Renamed", "branch_id": bid, "employee_id": f"EID{sfx}"})
# The branch team lead sees it in their queue.
regs = lead.get("/api/registrations").json()
mine = [r for r in regs if r.get("employee_id") == f"EID{sfx}"]
check("team lead sees one pending registration", len(mine) == 1 and mine[0]["name"] == "ZZ Self Renamed", regs)
# Team lead approves → the staff record is created now.
ap = lead.post(f"/api/registrations/{mine[0]['id']}/approve", json={})
check("team lead approves the registration", ap.status_code == 200, ap.text)
made = next((s for s in admin.get(f"/api/staff?branch_id={bid}").json() if s.get("employee_id") == f"EID{sfx}"), None)
check("approval creates the staff record", made and made["name"] == "ZZ Self Renamed" and made.get("self_registered") is True, made)
check("approved registration leaves the queue", not any(r.get("employee_id") == f"EID{sfx}" for r in lead.get("/api/registrations").json()))
# Wrong code is rejected.
check("wrong code rejected", anon2.post("/api/register", json={"code": "nope", "name": "x", "branch_id": bid, "employee_id": "y"}).status_code == 403)
# Manager can't set a duplicate Employee ID on another record.
dupset = admin.put(f"/api/staff/{B['id']}", json={"employee_id": f"EID{sfx}"})
check("duplicate Employee ID rejected on edit", dupset.status_code == 409, dupset.status_code)
admin.put("/api/settings", json={"registration": "off"})
check("registration can be closed again", admin.get("/api/settings").json().get("registration_open") is False)

print(f"\n=== RESULT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
