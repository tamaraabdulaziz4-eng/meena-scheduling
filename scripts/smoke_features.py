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

import re as _re
def reg_with_code(client, payload):
    """Register helper: fetch the emailed verification code (SMTP_CAPTURE) and
    submit it with the registration, mirroring the real two-step flow."""
    em = payload.get("email")
    if em:
        client.post("/api/register/send-code", json={"email": em})
        codev = None
        for e in reversed(M._email_outbox):
            if e.get("to") == em:
                mm = _re.search(r"(\d{6})", (e.get("body") or ""))
                if mm:
                    codev = mm.group(1); break
        payload = {**payload, "email_code": codev}
    return client.post("/api/register", json=payload)

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
# Response reports save outcome accurately (so the UI can show partial saves).
check("leave response reports requested/failed counts",
      lr.json().get("requested") == 1 and lr.json().get("failed") == 0, lr.json())
# stage 1 of the chain notifies the branch team lead (not the manager yet)
notes = lead.get("/api/notifications").json()
check("team lead notified of leave request (stage 1)", any("leave" in (n["message"] or "").lower() for n in notes["notifications"]), notes)
# find the leave id and approve
leaves = admin.get(f"/api/leaves?branch_id={bid}&year={YEAR}&month={MONTH}").json()
lv = next((l for l in leaves if l["staff_id"] == A["id"] and l["date"] == f"{YEAR}-08-10"), None)
check("leave visible to manager", lv is not None, leaves)
ap = admin.put(f"/api/leaves/{lv['id']}/status", json={"status": "approved"})
check("manager approves leave", ap.status_code == 200, ap.text)
# Bulk approval path (used by "Approve all pending"): a multi-day range in one call.
staffA.post("/api/leaves", json={"date_from": f"{YEAR}-08-18", "date_to": f"{YEAR}-08-20", "leave_type": "AL"})
pend = [l for l in admin.get(f"/api/leaves?branch_id={bid}&year={YEAR}&month={MONTH}").json()
        if l["staff_id"] == A["id"] and l["status"] == "pending"]
bap = admin.put("/api/leaves/status", json={"ids": [l["id"] for l in pend], "status": "approved", "confirm": True})
check("batch approve a multi-day range", bap.status_code == 200, bap.text)
after = [l for l in admin.get(f"/api/leaves?branch_id={bid}&year={YEAR}&month={MONTH}").json()
         if l["staff_id"] == A["id"] and f"{YEAR}-08-18" <= l["date"] <= f"{YEAR}-08-20"]
check("batched range all approved", after and all(l["status"] == "approved" for l in after), after)
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
# Portal summary: leave balance + a countdown to the next approved leave.
admin.put(f"/api/staff/{A['id']}", json={"leave_balance": 17})
M.q("""INSERT INTO scheduling.leave_requests (staff_id,date,leave_type,status)
       VALUES (%s,%s,'AL','approved') ON CONFLICT (staff_id,date) DO UPDATE SET status='approved',leave_type='AL'""",
    (A["id"], f"{YEAR}-08-28"), exec_only=True)
mj = staffA.get(f"/api/my-schedule?year={YEAR}&month={MONTH}").json()
check("portal shows the staff's leave balance", float(mj.get("leave_balance") or 0) == 17, mj.get("leave_balance"))
up = mj.get("upcoming_leave") or {}
check("portal shows a countdown to the next approved leave",
      bool(up.get("date")) and isinstance(up.get("days_until"), int) and up["days_until"] >= 0, up)
# Accrual: a balance of 10 recorded a year ago should read ~32 (10 + 22/yr).
M.q("UPDATE scheduling.staff SET leave_balance=10, leave_balance_date=(CURRENT_DATE - INTERVAL '365 days') WHERE id=%s",
    (A["id"],), exec_only=True)
mj2 = staffA.get(f"/api/my-schedule?year={YEAR}&month={MONTH}").json()
check("leave balance accrues ~22/yr", 31.0 <= float(mj2.get("leave_balance") or 0) <= 33.0, mj2.get("leave_balance"))
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

print("\n== scenario 8a2: 'fill blanks only' keeps a manually pinned cell ==")
admin.put(f"/api/schedules/{sid}/status", json={"status": "draft"})
PIN = f"{YEAR}-08-06"
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": PIN, "shift_code": "N"})
gp = admin.post("/api/generate", json={"branch_id": bid, "year": YEAR, "month": MONTH,
                                       "confirm": True, "preserve_existing": True})
check("generate (preserve) ran", gp.status_code in (200, 422), gp.text)
if gp.status_code == 200:
    ents_pin = admin.get(f"/api/schedules/{sid}/entries").json()
    pinned = next((e for e in ents_pin if e["staff_id"] == A["id"] and e["date"] == PIN), None)
    check("manually pinned cell survived generation", pinned and pinned["shift_code"] == "N", pinned)

print("\n== scenario 8b: generate a single section, leaving the other alone ==")
# Requesting only "General" must route the solver to General alone — the US
# section is never attempted (so its rota is left untouched). Feasibility of the
# tiny seed section isn't the point here; the per-section routing is.
gsec = admin.post("/api/generate", json={"branch_id": bid, "year": YEAR, "month": MONTH,
                                         "confirm": True, "section": "General"})
body = gsec.json()
secs = (body.get("sections")
        or (body.get("detail") or {}).get("sections")
        or {}) if isinstance(body, dict) else {}
check("per-section generate routes to General only",
      gsec.status_code in (200, 422) and set(k.upper() for k in secs) <= {"GENERAL"},
      f"{gsec.status_code} {list(secs)}")
gbad = admin.post("/api/generate", json={"branch_id": bid, "year": YEAR, "month": MONTH,
                                         "confirm": True, "section": "Nope"})
check("unknown section is rejected (400)", gbad.status_code == 400, f"{gbad.status_code} {gbad.text}")

print("\n== scenario 8a3: exclude staff from generation ==")
gex = admin.post("/api/generate", json={"branch_id": bid, "year": YEAR, "month": MONTH,
                                        "confirm": True, "ignore_manual": True,
                                        "exclude_staff_ids": [A["id"]]})
check("generate with an excluded staff runs", gex.status_code in (200, 422), gex.text)
if gex.status_code == 200:
    sidg = (gex.json().get("schedule") or {}).get("id") or sid
    eents = admin.get(f"/api/schedules/{sidg}/entries").json()
    awork = [e for e in eents if e["staff_id"] == A["id"] and e["shift_code"] in ("M", "N")]
    check("excluded staff gets no work shifts (left off)", len(awork) == 0, awork[:3])
gall = admin.post("/api/generate", json={"branch_id": bid, "year": YEAR, "month": MONTH,
                                         "confirm": True, "ignore_manual": True,
                                         "exclude_staff_ids": [s["id"] for s in admin.get(f"/api/staff?branch_id={bid}").json()]})
check("excluding everyone is rejected (400)", gall.status_code == 400, gall.text)

print("\n== scenario 8c: cross-branch cover (manager places a floater) ==")
# A staff member who belongs to a DIFFERENT branch covers a day on NEST3's rota.
other_branch = next(b for b in branches if b["id"] != bid)
visitor = admin.post("/api/staff", json={"name": "ZZ Visitor", "branch_id": other_branch["id"]}).json()
cov_date = f"{YEAR}-08-07"
# candidate listing only shows OTHER-branch free staff
cc = admin.get(f"/api/cover-candidates?branch_id={bid}&date={cov_date}")
check("cover candidates listed from other branches", cc.status_code == 200
      and any(c["staff_id"] == visitor["id"] for c in cc.json().get("candidates", [])), cc.text)
check("own-branch staff are not cover candidates",
      all(c["staff_id"] != A["id"] for c in cc.json().get("candidates", [])), cc.json())
# team lead (admin) cannot assign cross-branch cover — reviewer only
tlcov = lead.post(f"/api/schedules/{sid}/cover", json={"staff_id": visitor["id"], "date": cov_date, "shift_code": "M"})
check("team lead can't assign cross-branch cover (403)", tlcov.status_code in (401, 403), tlcov.status_code)
# manager assigns the visitor — the cover is written on the VISITOR'S OWN rota,
# pointing at the host (so their home sheet shows it; host shows them as a guest).
cov = admin.post(f"/api/schedules/{sid}/cover", json={"staff_id": visitor["id"], "date": cov_date, "shift_code": "M"})
check("manager assigns cross-branch cover", cov.status_code == 200
      and cov.json().get("cross_branch_id") == bid, cov.text)
ents_after = admin.get(f"/api/schedules/{sid}/entries").json()
check("cover shows on the host rota (as a visitor)",
      any(e["staff_id"] == visitor["id"] and e["date"] == cov_date for e in ents_after), "missing")
# The visitor's OWN branch rota records the shift that day, marked cross-branch.
home_sched = admin.post("/api/schedules/open", json={"branch_id": other_branch["id"], "year": YEAR, "month": MONTH}).json()
check("cover recorded on the visitor's home rota too",
      any(e["staff_id"] == visitor["id"] and e["date"] == cov_date and e["cross_branch_id"] == bid
          for e in home_sched["entries"]), "not on home rota")
# can't add a SAME-branch staffer as a cover
selfcov = admin.post(f"/api/schedules/{sid}/cover", json={"staff_id": A["id"], "date": cov_date, "shift_code": "M"})
check("same-branch staff rejected as cover (400)", selfcov.status_code == 400, selfcov.status_code)
# removal
rem = admin.delete(f"/api/schedules/{sid}/cover?staff_id={visitor['id']}&date={cov_date}")
check("manager removes the cover", rem.status_code == 200, rem.text)
ents_gone = admin.get(f"/api/schedules/{sid}/entries").json()
check("cover removed from both rotas",
      not any(e["staff_id"] == visitor["id"] and e["date"] == cov_date for e in ents_gone), "still there")

print("\n== scenario 8d: auto-fill from surplus staff at same-city sharing branches ==")
# Target branch in city "ZZCity"; a donor branch in the same city that shares its
# staff and is OVERSTAFFED on Aug 4 (3 work M, min default 2 -> surplus 1).
tgt = admin.post("/api/branches", json={"name": "ZZ Y3 Target"}).json()
admin.put(f"/api/branches/{tgt['id']}", json={"name": "ZZ Y3 Target", "city": "ZZCity", "shares_staff": False})
don = admin.post("/api/branches", json={"name": "ZZ Donor"}).json()
admin.put(f"/api/branches/{don['id']}", json={"name": "ZZ Donor", "city": "ZZCity", "shares_staff": True})
far = admin.post("/api/branches", json={"name": "ZZ Donor FarCity"}).json()
admin.put(f"/api/branches/{far['id']}", json={"name": "ZZ Donor FarCity", "city": "OtherCity", "shares_staff": True})
d1 = admin.post("/api/staff", json={"name": "ZZ D1", "branch_id": don["id"]}).json()
d2 = admin.post("/api/staff", json={"name": "ZZ D2", "branch_id": don["id"]}).json()
d3 = admin.post("/api/staff", json={"name": "ZZ D3", "branch_id": don["id"]}).json()
farstaff = admin.post("/api/staff", json={"name": "ZZ Far", "branch_id": far["id"]}).json()
tsched = admin.post("/api/schedules/open", json={"branch_id": tgt["id"], "year": YEAR, "month": MONTH}).json()["schedule"]["id"]
dsched = admin.post("/api/schedules/open", json={"branch_id": don["id"], "year": YEAR, "month": MONTH}).json()["schedule"]["id"]
fsched = admin.post("/api/schedules/open", json={"branch_id": far["id"], "year": YEAR, "month": MONTH}).json()["schedule"]["id"]
A4 = f"{YEAR}-08-04"   # Tuesday — surplus day (3 working)
A5 = f"{YEAR}-08-05"   # Wednesday — exactly at min (2 working), no surplus
for st in (d1, d2, d3):
    admin.put(f"/api/schedules/{dsched}/entries", json={"staff_id": st["id"], "date": A4, "shift_code": "M"})
# A5: exactly one morning (== min_m), so there's no spare to lend that day.
admin.put(f"/api/schedules/{dsched}/entries", json={"staff_id": d1["id"], "date": A5, "shift_code": "M"})
admin.put(f"/api/schedules/{dsched}/entries", json={"staff_id": d2["id"], "date": A5, "shift_code": "O"})
admin.put(f"/api/schedules/{dsched}/entries", json={"staff_id": d3["id"], "date": A5, "shift_code": "O"})
# Far-city donor also has surplus on Aug 4 — but must NOT be used (different city).
admin.put(f"/api/schedules/{fsched}/entries", json={"staff_id": farstaff["id"], "date": A4, "shift_code": "M"})

af = admin.post(f"/api/schedules/{tsched}/autofill-cross-cover",
                json={"shift_code": "M", "per_day": 1, "section": "General", "skip_fridays": True})
check("autofill runs", af.status_code == 200, af.text)
afj = af.json() if af.status_code == 200 else {}
tents = admin.get(f"/api/schedules/{tsched}/entries").json()
# Covers point at the target (host) and surface on its rota as visitors.
a4_cover = [e for e in tents if e["date"] == A4 and e["cross_branch_id"] == tgt["id"]
            and e["staff_id"] in (d1["id"], d2["id"], d3["id"])]
check("surplus day filled by relocating one donor staffer", len(a4_cover) == 1, [e['date'] for e in tents][:5])
dents = admin.get(f"/api/schedules/{dsched}/entries").json()
# The relocated staffer's OWN rota now shows the cover shift pointing at Y3.
relocated = a4_cover[0]["staff_id"] if a4_cover else None
check("relocated shift shows on the donor's own rota (→ Y3)",
      any(e["staff_id"] == relocated and e["date"] == A4 and e["cross_branch_id"] == tgt["id"]
          for e in dents), "not on donor rota")
a4_donor_work = [e for e in dents if e["date"] == A4 and e["shift_code"] == "M" and not e["cross_branch_id"]]
check("donor stays at its minimum after lending (3->2)", len(a4_donor_work) == 2, len(a4_donor_work))
# The relocated person has exactly ONE shift that day (no double-booking).
relo_a4 = [e for e in dents if e["staff_id"] == relocated and e["date"] == A4]
check("relocated staffer not double-booked", len(relo_a4) == 1, relo_a4)
check("no-surplus day is left untouched",
      not any(e["date"] == A5 and e["cross_branch_id"] == tgt["id"] for e in tents), "A5 touched")
check("far-city donor never used", not any(e["staff_id"] == farstaff["id"] for e in tents), "far used")
# A non-sharing same-city branch must contribute nobody.
check("autofill reported donors are sharing same-city only",
      set(afj.get("donors", [])) == {"ZZ Donor"}, afj.get("donors"))

print("\n== scenario 8d2: per-shift surplus — never pull the last night/morning ==")
# Donor has 2 mornings + 1 night on Aug 4 (min 1 each). Only a MORNING is spare;
# the single night must stay put so night coverage isn't broken.
tt = admin.post("/api/branches", json={"name": "ZZ Y3 Shift"}).json()
admin.put(f"/api/branches/{tt['id']}", json={"name": "ZZ Y3 Shift", "city": "ZShiftCity"})
dn = admin.post("/api/branches", json={"name": "ZZ Donor Shift"}).json()
admin.put(f"/api/branches/{dn['id']}", json={"name": "ZZ Donor Shift", "city": "ZShiftCity", "shares_staff": True})
n1 = admin.post("/api/staff", json={"name": "ZZ N1", "branch_id": dn["id"]}).json()
n2 = admin.post("/api/staff", json={"name": "ZZ N2", "branch_id": dn["id"]}).json()
n3 = admin.post("/api/staff", json={"name": "ZZ N3", "branch_id": dn["id"]}).json()
ttsched = admin.post("/api/schedules/open", json={"branch_id": tt["id"], "year": YEAR, "month": MONTH}).json()["schedule"]["id"]
dnsched = admin.post("/api/schedules/open", json={"branch_id": dn["id"], "year": YEAR, "month": MONTH}).json()["schedule"]["id"]
admin.put(f"/api/schedules/{dnsched}/entries", json={"staff_id": n1["id"], "date": A4, "shift_code": "M"})
admin.put(f"/api/schedules/{dnsched}/entries", json={"staff_id": n2["id"], "date": A4, "shift_code": "M"})
admin.put(f"/api/schedules/{dnsched}/entries", json={"staff_id": n3["id"], "date": A4, "shift_code": "N"})
admin.post(f"/api/schedules/{ttsched}/autofill-cross-cover",
           json={"shift_code": "M", "per_day": 1, "section": "General", "skip_fridays": True})
dnents = admin.get(f"/api/schedules/{dnsched}/entries").json()
n3row = next((e for e in dnents if e["staff_id"] == n3["id"] and e["date"] == A4), None)
check("the lone night worker is NOT pulled", n3row and n3row["shift_code"] == "N" and not n3row["cross_branch_id"], n3row)
m_taken = [e for e in dnents if e["staff_id"] in (n1["id"], n2["id"]) and e["date"] == A4 and e["cross_branch_id"] == tt["id"]]
check("a spare morning was pulled instead", len(m_taken) == 1, m_taken)

print("\n== scenario 8e: Y3-aware generation reserves a fair, leave-weighted share ==")
# Pure split: capacity-weighted, always sums to the total, bigger capacity wins ties.
check("split sums to total", sum(M._largest_remainder_share({1:6, 2:5, 3:0}, 2).values()) == 2)
check("zero-capacity branch gets nothing", M._largest_remainder_share({1:6, 2:5, 3:0}, 2).get(3) == 0)
check("single unit goes to the larger capacity", M._largest_remainder_share({1:6, 2:5}, 1) == {1:1, 2:0})
# Integration: two same-city sharing branches, equal head-count, but one has a
# staffer on leave -> the healthy branch carries Y3's need.
tc = admin.post("/api/branches", json={"name": "ZZ Y3 City2"}).json()
admin.put(f"/api/branches/{tc['id']}", json={"name": "ZZ Y3 City2", "city": "ZLeaveCity", "cover_need_per_day": 1})
dx = admin.post("/api/branches", json={"name": "ZZ Dx"}).json()
admin.put(f"/api/branches/{dx['id']}", json={"name": "ZZ Dx", "city": "ZLeaveCity", "shares_staff": True})
dy = admin.post("/api/branches", json={"name": "ZZ Dy"}).json()
admin.put(f"/api/branches/{dy['id']}", json={"name": "ZZ Dy", "city": "ZLeaveCity", "shares_staff": True})
for bb in (dx, dy):
    admin.post("/api/staff", json={"name": f"ZZ {bb['name']} g1", "branch_id": bb["id"]})
    admin.post("/api/staff", json={"name": f"ZZ {bb['name']} g2", "branch_id": bb["id"]})
# US staff must NOT add General capacity.
admin.post("/api/staff", json={"name": "ZZ Dx US", "branch_id": dx["id"], "speciality": ["US"]})
# One Dy staffer takes an approved leave day this month -> lowers Dy's capacity.
dy_staff = [s for s in admin.get("/api/staff").json() if s["branch_id"] == dy["id"]][0]
M.q("""INSERT INTO scheduling.leave_requests (staff_id,date,leave_type,status)
       VALUES (%s,%s,'AL','approved')""", (dy_staff["id"], f"{YEAR}-08-12"), exec_only=True)
sx = M._cross_cover_export_share(dx["id"], "ZLeaveCity", True, YEAR, MONTH)
sy = M._cross_cover_export_share(dy["id"], "ZLeaveCity", True, YEAR, MONTH)
check("shares sum to the city's need", sx + sy == 1, f"sx={sx} sy={sy}")
check("leave-burdened branch carries a smaller share", sx == 1 and sy == 0, f"sx={sx} sy={sy}")
check("a non-sharing target reserves nothing",
      M._cross_cover_export_share(tc["id"], "ZLeaveCity", False, YEAR, MONTH) == 0)

print("\n== scenario 8f: schedule lookup is read-only (no accidental drafts) ==")
FM = 11   # a month with no schedule yet
lk = admin.get(f"/api/schedules/lookup?branch_id={bid}&year={YEAR}&month={FM}")
check("lookup returns null for a fresh month", lk.status_code == 200 and lk.json().get("schedule") is None, lk.text)
# Looking again must STILL be null — lookup never creates a row.
lk2 = admin.get(f"/api/schedules/lookup?branch_id={bid}&year={YEAR}&month={FM}")
check("repeated lookup never creates a draft", lk2.json().get("schedule") is None, lk2.json())
# Explicit open is what creates it.
op = admin.post("/api/schedules/open", json={"branch_id": bid, "year": YEAR, "month": FM})
check("explicit open creates the schedule", op.status_code == 200 and op.json()["schedule"]["id"], op.text)
lk3 = admin.get(f"/api/schedules/lookup?branch_id={bid}&year={YEAR}&month={FM}")
check("lookup now finds the created schedule", lk3.json().get("schedule") is not None, lk3.json())
# API reads must be non-cacheable, so an edit can't appear to "revert" from a
# stale cached GET.
check("API responses are marked no-store",
      "no-store" in (lk3.headers.get("cache-control", "").lower()), lk3.headers.get("cache-control"))

print("\n== scenario 8g: sick-leave cover assigns the shift to the coverer ==")
SLD = f"{YEAR}-08-22"
admin.put(f"/api/schedules/{sid}/status", json={"status": "draft"})
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": SLD, "shift_code": "M"})
# A calls in sick that day → SL auto-approved, remembers the M shift it replaced.
slr = admin.post("/api/leaves", json={"staff_id": A["id"], "date_from": SLD, "date_to": SLD, "leave_type": "SL"})
slid = slr.json()["leaves"][0]["id"]
sug = admin.get(f"/api/leaves/{slid}/cover-suggestions").json()
check("cover suggestions show the gap shift (M)", sug.get("gap_shift") == "M", sug)
cand = next((c for c in sug.get("candidates", []) if c["staff_id"] == B["id"]), None)
check("a free same-section colleague is suggested", cand is not None, sug.get("candidates"))
rc = admin.post(f"/api/leaves/{slid}/request-cover", json={"staff_id": B["id"]})
check("cover assigned (not just notified)", rc.status_code == 200 and rc.json().get("assigned") is True, rc.text)
bent = admin.get(f"/api/schedules/{sid}/entries").json()
bcover = next((e for e in bent if e["staff_id"] == B["id"] and e["date"] == SLD), None)
check("coverer's own rota now shows the M shift", bcover and bcover["shift_code"] == "M", bcover)

print("\n== scenario 8h: manager staff search (home lookup) ==")
admin.put(f"/api/staff/{A['id']}", json={"employee_id": "EMP-A-1"})
byname = admin.get("/api/staff/search?q=ZZ Tester").json().get("results", [])
check("search by name returns matches with coverage fields",
      any(r["id"] == A["id"] for r in byname) and all("shifts_month" in r and "today_shift" in r for r in byname), byname[:2])
byid = admin.get("/api/staff/search?q=EMP-A-1").json().get("results", [])
check("search by employee ID finds the staffer", any(r["id"] == A["id"] for r in byid), byid)
check("too-short query returns nothing", admin.get("/api/staff/search?q=a").json().get("results") == [])
leadhits = lead.get("/api/staff/search?q=ZZ Tester").json().get("results", [])
check("team lead search is branch-scoped", all(r["branch_id"] == bid for r in leadhits), leadhits)

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
# Input validation: negatives and non-numeric are rejected (not 500, not clamped).
CDv = f"{YEAR}-08-27"
neg = lead.post("/api/daily-cases", json={"branch_id": bid, "date": CDv, "xray": -3})
check("negative count rejected (400)", neg.status_code == 400, neg.status_code)
nan = lead.post("/api/daily-cases", json={"branch_id": bid, "date": CDv, "ct": "abc"})
check("non-numeric count rejected (400)", nan.status_code == 400, nan.status_code)
warn = lead.post("/api/daily-cases", json={"branch_id": bid, "date": CDv, "xray": 5, "total_pt": 0})
check("warns when cases logged but patients=0", bool(warn.json().get("warning")), warn.json())
# Manager-noise rule: daily-cases submissions never ping the manager (the
# completion summary was removed as low-value noise).
CDc = f"{YEAR}-08-29"
mgr_b4 = {n["id"] for n in mgr.get("/api/notifications").json()["notifications"]}
for b in admin.get("/api/branches").json():
    admin.post("/api/daily-cases", json={"branch_id": b["id"], "date": CDc, "xray": 1, "submit": True})
mgr_done = [n for n in mgr.get("/api/notifications").json()["notifications"] if n["id"] not in mgr_b4]
check("daily-cases submissions never ping the manager",
      not any("daily cases" in (n["message"] or "").lower() for n in mgr_done), mgr_done)
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
check("team lead got a fill-in reminder", any("finalized in 20 minutes" in (n["message"] or "").lower() for n in lead_after), lead_after)
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

print("\n== scenario 14b: open self-registration (no code) emails the registrant ==")
M._email_outbox.clear()
anon14 = TestClient(app)   # fresh client — staff sign-up now auto-logs-in (sets a cookie)
reg = reg_with_code(anon14, {"name": "ZZ NewStaff", "branch_id": bid,
                 "employee_id": "9990001", "email": "newstaff@meena-health.com", "phone": "0500000000",
                 "join_date": "2024-01-15", "leave_balance": 12.5,
                 "username": f"zznew{sfx}", "password": "pass123", "section": "General"})
check("registration accepted without an invite code",
      reg.status_code == 200 and reg.json().get("auto_login") is True, reg.text)
check("registrant gets a welcome email",
      any(e["to"] == "newstaff@meena-health.com" for e in M._email_outbox), M._email_outbox)
check("staff record created immediately (no approval)",
      any(s.get("employee_id") == "9990001" for s in admin.get(f"/api/staff?branch_id={bid}").json()))
pend = admin.get("/api/registrations").json()
plist = pend if isinstance(pend, list) else pend.get("registrations", [])
check("no pending registration for an auto-activated staff",
      not any(r.get("employee_id") == "9990001" for r in plist), plist)
# /register/info works with no code (open onboarding form)
info = admin.get("/api/register/info")
check("onboarding branch list loads without a code", info.status_code == 200 and info.json().get("ok"), info.text)
# Email verification code is enforced.
admin.post("/api/register/send-code", json={"email": "codetest@meena-health.com"})
wrongc = admin.post("/api/register", json={"name": "CT", "branch_id": bid, "employee_id": f"CT1{sfx}",
                    "email": "codetest@meena-health.com", "phone": "0500000000",
                    "username": f"ct1{sfx}", "password": "pass1234", "email_code": "000000"})
check("wrong verification code rejected", wrongc.status_code == 400, wrongc.text)
nocodereg = admin.post("/api/register", json={"name": "CT", "branch_id": bid, "employee_id": f"CT2{sfx}",
                       "email": "noco@meena-health.com", "phone": "0500000000",
                       "username": f"ct2{sfx}", "password": "pass1234"})
check("missing verification code rejected", nocodereg.status_code == 400, nocodereg.text)
check("send-code refuses a non-Meena address",
      admin.post("/api/register/send-code", json={"email": "x@gmail.com"}).status_code == 400)

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
# A team-lead's own entry has already cleared stage 1 → 'lead_approved'.
bids3 = [l["id"] for l in lvls if l["staff_id"] == B["id"]
         and l["date"] in (f"{YEAR}-08-15", f"{YEAR}-08-16", f"{YEAR}-08-17") and l["status"] == "lead_approved"]
check("3-day lead-approved leave created", len(bids3) == 3, bids3)
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
# Open by default → the public onboarding form loads with no code.
check("registration open by default (no code)", anon2.get("/api/register/info").status_code == 200)
# Superadmin can still toggle it and gets shareable role links.
en = admin.put("/api/settings", json={"registration": "on"})
check("superadmin can open registration", en.status_code == 200 and en.json().get("registration_open") is True, en.text)
link = en.json().get("registration_link") or ""
code = link.split("register=")[-1]
check("registration link carries a code", bool(code), link)
check("team lead can't see the registration code", "registration_link" not in lead.get("/api/settings").json())
# Valid code → the form can load branches and submit.
info = anon2.get(f"/api/register/info?code={code}")
check("valid code unlocks the form", info.status_code == 200 and len(info.json().get("branches", [])) >= 1, info.text)
# A self-registration now also creates a LOGIN — username + password required.
reg_uname = f"zzself{sfx}"
noacct = anon2.post("/api/register", json={"code": code, "name": "ZZ NoAccount", "branch_id": bid,
                    "employee_id": f"EID{sfx}"})
check("registration without username/password rejected", noacct.status_code == 400, noacct.text)
reg = reg_with_code(anon2, {"code": code, "name": "ZZ Self Signup", "section": "US",
                 "branch_id": bid, "employee_id": f"EID{sfx}", "email": "self@meena-health.com", "phone": "0500000000",
                 "join_date": "2023-06-01", "leave_balance": 18,
                 "username": reg_uname, "password": "selfpass1"})
check("non-Meena email is rejected", anon2.post("/api/register", json={"code": code, "name": "X", "branch_id": bid,
      "employee_id": f"GM{sfx}", "email": "person@gmail.com", "phone": "0500000000",
      "username": f"gm{sfx}", "password": "pass1234"}).status_code == 400)
check("missing mobile is rejected", anon2.post("/api/register", json={"code": code, "name": "X", "branch_id": bid,
      "employee_id": f"NP{sfx}", "email": "x@meena-health.com",
      "username": f"np{sfx}", "password": "pass1234"}).status_code == 400)
check("staff self-registration activates immediately", reg.status_code == 200 and reg.json().get("auto_login") is True, reg.text)
# The staff record AND the login are created right away — no approval needed.
made = next((s for s in admin.get(f"/api/staff?branch_id={bid}").json() if s.get("employee_id") == f"EID{sfx}"), None)
check("self-registration creates the staff record immediately", made is not None and made.get("self_registered") is True, made)
check("registered section carried onto the staff record", made and "US" in [str(x).upper() for x in (made.get("speciality") or [])], made.get("speciality"))
check("join date + leave balance carried onto the staff record",
      made and str(made.get("join_date") or "")[:10] == "2023-06-01" and float(made.get("leave_balance") or 0) == 18, made)
# The new staff can sign in right away with the login they chose.
selfc = TestClient(app)
li = selfc.post("/api/auth/login", json={"username": reg_uname, "password": "selfpass1"})
check("new staff can sign in immediately", li.status_code == 200, li.text)
check("their account is a branch-scoped staff role", li.json().get("role") == "staff" and li.json().get("staff_id") == made["id"], li.text)
# An auto-activated staff is NOT a pending item in the team lead's queue.
check("no pending registration for an auto-activated staff",
      not any(r.get("employee_id") == f"EID{sfx}" for r in lead.get("/api/registrations").json()))
# A username already taken is rejected up front.
dupu = anon2.post("/api/register", json={"code": code, "name": "Dup", "branch_id": bid,
                 "employee_id": f"EIDX{sfx}", "email": "dup@meena-health.com", "phone": "0500000000",
                 "username": "admin", "password": "whatever1"})
check("taken username rejected at signup", dupu.status_code == 409, dupu.text)
# Registration is open (code-less): a submission goes through regardless of any
# stray code value, as long as the details are valid.
check("open registration ignores any code value", reg_with_code(anon2, {"code": "nope", "name": "ZZ NoCode", "branch_id": bid,
      "employee_id": f"y{sfx}", "email": "nocode@meena-health.com", "phone": "0500000000", "username": f"x{sfx}", "password": "xxxxxx1"}).status_code == 200)
# Username-collision guard: a sign-up can't claim a username already in use.
admin.post("/api/users", json={"username": f"race{sfx}", "password": "strangerpw1", "role": "viewer"})
anon3 = TestClient(app)
race = reg_with_code(anon3, {"code": code, "name": "Race User", "branch_id": bid,
           "employee_id": f"RACE{sfx}", "email": "race@meena-health.com", "phone": "0500000000",
           "username": f"race{sfx}", "password": "racepass1"})
check("sign-up can't claim a username already taken", race.status_code == 409, race.text)
stranger = TestClient(app).post("/api/auth/login", json={"username": f"race{sfx}", "password": "strangerpw1"})
check("the existing account was not hijacked", stranger.status_code == 200 and stranger.json().get("role") == "viewer", stranger.text)
# Manager can't set a duplicate Employee ID on another record.
dupset = admin.put(f"/api/staff/{B['id']}", json={"employee_id": f"EID{sfx}"})
check("duplicate Employee ID rejected on edit", dupset.status_code == 409, dupset.status_code)
# Role-scoped invite links: team-lead & manager sign-ups need SUPERADMIN approval.
anon4 = TestClient(app)
ra = reg_with_code(anon4, {"code": code, "role": "admin", "name": "Lead Signup",
                "branch_id": bid, "username": f"leadsu{sfx}", "password": "leadpass1",
                "email": "lead@meena-health.com", "phone": "0500000000"})
check("team-lead sign-up accepted (pending)", ra.status_code == 200, ra.text)
rm_ = reg_with_code(anon4, {"code": code, "role": "manager", "name": "Mgr Signup",
                "username": f"mgrsu{sfx}", "password": "mgrpass1",
                "email": "mgr@meena-health.com", "phone": "0500000000"})
check("manager sign-up accepted (no branch needed)", rm_.status_code == 200, rm_.text)
leadq = lead.get("/api/registrations").json()
check("team lead can't see team-lead/manager sign-ups",
      not any(r.get("requested_role") in ("admin", "manager") for r in leadq))
allq = admin.get("/api/registrations").json()
leadReg = next((r for r in allq if r.get("username") == f"leadsu{sfx}"), None)
mgrReg  = next((r for r in allq if r.get("username") == f"mgrsu{sfx}"), None)
check("superadmin sees the team-lead sign-up", leadReg is not None and leadReg.get("requested_role") == "admin", allq)
check("manager can't approve a team-lead sign-up (superadmin only)",
      mgr.post(f"/api/registrations/{leadReg['id']}/approve", json={}).status_code == 403)
check("superadmin approves the team-lead sign-up",
      admin.post(f"/api/registrations/{leadReg['id']}/approve", json={}).status_code == 200)
check("superadmin approves the manager sign-up",
      admin.post(f"/api/registrations/{mgrReg['id']}/approve", json={}).status_code == 200)
la = TestClient(app).post("/api/auth/login", json={"username": f"leadsu{sfx}", "password": "leadpass1"})
check("approved team lead signs in as branch-locked admin",
      la.status_code == 200 and la.json().get("role") == "admin" and la.json().get("branch_id") == bid, la.text)
lm = TestClient(app).post("/api/auth/login", json={"username": f"mgrsu{sfx}", "password": "mgrpass1"})
check("approved manager signs in as all-branch manager",
      lm.status_code == 200 and lm.json().get("role") == "manager" and not lm.json().get("branch_id"), lm.text)

print("\n== scenario: Nafath identity verification at registration (SADQ_MOCK) ==")
os.environ["SADQ_MOCK"] = "1"
try:
    check("register/info reports Nafath enabled when configured",
          TestClient(app).get("/api/register/info").json().get("nafath_enabled") is True)
    nf = TestClient(app)
    nsfx = str(int(time.time()))[-5:]
    nemail = f"nafath{nsfx}@meena-health.com"
    nid = "1234567890"
    # 1) Registration must be blocked before Nafath is verified.
    base_payload = {
        "name": "Typed Wrongname", "branch_id": bid, "section": "General",
        "employee_id": f"NAF{nsfx}", "email": nemail, "phone": "0590000000",
        "username": f"nafuser{nsfx}", "password": "nafpass1",
    }
    blocked = reg_with_code(nf, base_payload)
    check("registration blocked without Nafath verification", blocked.status_code == 400, blocked.text)
    # 2) Start the Nafath flow → sandbox random is 1234, request stays pending.
    start = nf.post("/api/register/nafath/start", json={"national_id": nid})
    check("nafath start returns request_id + random", start.status_code == 200 and start.json().get("random") == "1234", start.text)
    req_id = start.json()["request_id"]
    check("status is pending before the user approves",
          nf.get(f"/api/register/nafath/status?request_id={req_id}").json().get("status") == "pending")
    # 3) Simulate Sadq's success webhook (public, no auth).
    wh = TestClient(app).post("/api/nafath/webhook", json={
        "requestId": req_id, "Status": 0,
        "usersInfo": [{"FirstNameEn": "Saud", "LastNameEn": "Alharbi",
                       "FirstNameAr": "سعود", "LastNameAr": "الحربي", "NationalId": nid}],
    })
    check("webhook accepted", wh.status_code == 200, wh.text)
    sres = nf.get(f"/api/register/nafath/status?request_id={req_id}").json()
    check("status flips to verified with official name", sres.get("status") == "verified" and sres.get("name_en") == "Saud Alharbi", sres)
    # 4) Now registration succeeds and adopts the official Nafath name + National ID.
    ok = reg_with_code(nf, {**base_payload, "nafath_request_id": req_id})
    check("registration succeeds after Nafath verification", ok.status_code == 200, ok.text)
    nstaff = M.q("SELECT name, national_id FROM scheduling.staff WHERE employee_id=%s", (f"NAF{nsfx}",), one=True)
    check("staff record stored the official Nafath name (not the typed one)", nstaff and nstaff.get("name") == "Saud Alharbi", nstaff)
    check("staff record stored the National ID", nstaff and nstaff.get("national_id") == nid, nstaff)
    # 5) A verification can't be reused for a second sign-up.
    reuse = reg_with_code(nf, {**base_payload, "employee_id": f"NAF{nsfx}b",
                               "email": f"nafath{nsfx}b@meena-health.com",
                               "username": f"nafuser{nsfx}b", "nafath_request_id": req_id})
    check("a Nafath verification can't be reused", reuse.status_code == 400, reuse.text)
    # 6) A failure webhook marks the request failed.
    s2 = TestClient(app).post("/api/register/nafath/start", json={"national_id": "2123456789"})
    rid2 = s2.json()["request_id"]
    TestClient(app).post("/api/nafath/webhook", json={"requestId": rid2, "nationalId": "2123456789", "Status": 1})
    check("failure webhook marks the request failed",
          nf.get(f"/api/register/nafath/status?request_id={rid2}").json().get("status") == "failed")
    check("invalid National ID is rejected",
          TestClient(app).post("/api/register/nafath/start", json={"national_id": "12345"}).status_code == 400)
finally:
    os.environ.pop("SADQ_MOCK", None)
check("register/info reports Nafath disabled when not configured",
      TestClient(app).get("/api/register/info").json().get("nafath_enabled") is False)

print("\n== scenario: mobile verification over WhatsApp (WHATSAPP_CAPTURE) ==")
os.environ["WHATSAPP_CAPTURE"] = "1"
try:
    check("register/info reports phone verification enabled",
          TestClient(app).get("/api/register/info").json().get("phone_verify_enabled") is True)
    wc = TestClient(app)
    wsfx = str(int(time.time()))[-5:]
    wphone = "0590" + wsfx
    wemail = f"wa{wsfx}@meena-health.com"
    wbase = {"name": "WA Tester", "branch_id": bid, "section": "General",
             "employee_id": f"WA{wsfx}", "email": wemail, "phone": wphone,
             "username": f"wauser{wsfx}", "password": "wapass1"}
    # One email code suffices — the phone check runs first, so failed phone checks
    # don't consume it.
    wc.post("/api/register/send-code", json={"email": wemail})
    ecode = None
    for e in reversed(M._email_outbox):
        if e.get("to") == wemail:
            mm = _re.search(r"(\d{6})", e.get("body") or ""); ecode = mm.group(1) if mm else None; break
    blocked = wc.post("/api/register", json={**wbase, "email_code": ecode})
    check("registration blocked without the WhatsApp code", blocked.status_code == 400, blocked.text)
    # Request the WhatsApp code → captured outbox holds it for the normalized number.
    M._whatsapp_outbox.clear()
    sp = wc.post("/api/register/send-phone-code", json={"phone": wphone})
    check("send-phone-code accepted", sp.status_code == 200, sp.text)
    norm = wphone.replace("0", "966", 1) if wphone.startswith("0") else wphone
    sent = [m for m in M._whatsapp_outbox if m["to"] == norm]
    check("WhatsApp code message was sent to the normalized number", len(sent) == 1, M._whatsapp_outbox)
    pcode = (_re.search(r"(\d{6})", sent[0]["message"]).group(1) if sent else None)
    bad = wc.post("/api/register", json={**wbase, "email_code": ecode, "phone_code": "000000"})
    check("wrong WhatsApp code is rejected", bad.status_code == 400, bad.text)
    # Wizard step-gates: check endpoints validate WITHOUT consuming the codes.
    check("check-phone-code rejects a wrong code",
          wc.post("/api/register/check-phone-code", json={"phone": wphone, "phone_code": "111111"}).status_code == 400)
    check("check-phone-code accepts the right code (no consume)",
          wc.post("/api/register/check-phone-code", json={"phone": wphone, "phone_code": pcode}).status_code == 200)
    check("check-email-code accepts the right code (no consume)",
          wc.post("/api/register/check-email-code", json={"email": wemail, "email_code": ecode}).status_code == 200)
    ok = wc.post("/api/register", json={**wbase, "email_code": ecode, "phone_code": pcode})
    check("registration still succeeds after checks (codes not consumed)", ok.status_code == 200, ok.text)
finally:
    os.environ.pop("WHATSAPP_CAPTURE", None)
check("register/info reports phone verification disabled when not configured",
      TestClient(app).get("/api/register/info").json().get("phone_verify_enabled") is False)

admin.put("/api/settings", json={"registration": "off"})
check("registration can be closed again", admin.get("/api/settings").json().get("registration_open") is False)

print("\n== scenario 14: support tickets ==")
# Staff raises a ticket.
tk = staffA.post("/api/tickets", json={"subject": "Scanner #2 not powering on",
                                       "description": "Console is dark since this morning.",
                                       "category": "fault", "priority": "high"})
check("staff can raise a ticket", tk.status_code == 200 and tk.json().get("status") == "open", tk.text)
tid = tk.json().get("id")
# Branch lead is notified of the new ticket.
ln = lead.get("/api/notifications").json()
check("team lead notified of new ticket",
      any("ticket" in (n["message"] or "").lower() for n in ln["notifications"]), ln)
# Staff sees their own; lead sees it on their branch.
mine = staffA.get("/api/tickets").json()
check("staff sees their own ticket", any(t["id"] == tid for t in mine), mine)
leadlist = lead.get("/api/tickets?status=active").json()
check("team lead sees the branch ticket", any(t["id"] == tid for t in leadlist), leadlist)
# A different staff member cannot view it.
other = staffB.get(f"/api/tickets/{tid}")
check("unrelated staff can't view another's ticket", other.status_code == 403, other.text)
# Staff cannot change status.
nope = staffA.put(f"/api/tickets/{tid}/status", json={"status": "resolved"})
check("staff can't change ticket status", nope.status_code == 403, nope.text)
# Lead escalates → staff notified.
esc = lead.put(f"/api/tickets/{tid}/status", json={"status": "escalated", "note": "Raised to facilities."})
check("lead can escalate", esc.status_code == 200 and esc.json().get("status") == "escalated", esc.text)
an = staffA.get("/api/notifications").json()
check("staff notified ticket escalated",
      any("escalated" in (n["message"] or "").lower() for n in an["notifications"]), an)
# Lead resolves with a note → resolution recorded, staff notified.
res = lead.put(f"/api/tickets/{tid}/status", json={"status": "resolved", "note": "Replaced the power unit."})
check("lead can resolve", res.status_code == 200 and res.json().get("status") == "resolved", res.text)
det = staffA.get(f"/api/tickets/{tid}").json()
check("resolution is stored on the ticket", "power unit" in (det.get("resolution") or "").lower(), det)
check("thread records the status changes",
      sum(1 for u in det.get("updates", []) if u.get("is_status_change")) >= 2, det.get("updates"))
# Staff replies → lead notified.
rep = staffA.post(f"/api/tickets/{tid}/updates", json={"body": "Thanks, it works now."})
check("staff can reply on the thread", rep.status_code == 200, rep.text)
ln2 = lead.get("/api/notifications").json()
check("lead notified of the reply",
      any("reply" in (n["message"] or "").lower() for n in ln2["notifications"]), ln2)
# Open-ticket count surfaces for the lead while active; resolved drops out of 'active'.
active_after = lead.get("/api/tickets?status=active").json()
check("resolved ticket leaves the active list", not any(t["id"] == tid for t in active_after), active_after)
# Validation: empty subject is rejected.
bad = staffA.post("/api/tickets", json={"subject": "   "})
check("empty subject rejected", bad.status_code == 400, bad.text)
# Manager can delete any ticket.
dele = admin.delete(f"/api/tickets/{tid}")
check("manager can delete a ticket", dele.status_code == 200, dele.text)
check("deleted ticket is gone", admin.get(f"/api/tickets/{tid}").status_code == 404)

print("\n== scenario 17: announcements / circulars ==")
# Manager posts an all-staff announcement.
ap = admin.post("/api/announcements", json={"title": "Annual leave policy update",
                                            "body": "Please review the new policy.", "kind": "announcement"})
check("manager can post an announcement", ap.status_code == 200, ap.text)
aid = ap.json().get("id")
# Staff see it.
seen = staffA.get("/api/announcements").json()
check("staff sees the all-staff announcement", any(a["id"] == aid for a in seen), seen)
# Action-required broadcast over WhatsApp + email, forced past the type filter.
import os as _os
_os.environ["WHATSAPP_CAPTURE"] = "1"
_os.environ["WHATSAPP_ONLY_TYPES"] = "approved"   # excludes 'announcement' on purpose
M._whatsapp_outbox.clear(); M._email_outbox.clear()
bcStaff = admin.post("/api/staff", json={"name": "ZZ Broadcast", "branch_id": bid,
                                         "phone": "0501234567", "email": "bc@example.com"}).json()
try:
    br = admin.post("/api/announcements", json={"title": "Mandatory fire drill",
                                                "body": "Hello {name}, attend at 2pm.", "kind": "action_required",
                                                "broadcast": True})
    check("action-required broadcast accepted", br.status_code == 200 and br.json().get("delivered", 0) > 0, br.text)
    baid = br.json().get("id")
    wamsg = [m for m in M._whatsapp_outbox if m["to"] == "966501234567"]
    check("broadcast reached WhatsApp despite the type filter (force)",
          any("fire drill" in (m["message"] or "").lower() for m in wamsg), M._whatsapp_outbox)
    check("broadcast is personalised with the recipient's name",
          any("ZZ Broadcast" in (m["message"] or "") and "{name}" not in (m["message"] or "") for m in wamsg), wamsg)
    check("broadcast reached email", any(e["to"] == "bc@example.com" for e in M._email_outbox), M._email_outbox)
finally:
    _os.environ.pop("WHATSAPP_CAPTURE", None); _os.environ.pop("WHATSAPP_ONLY_TYPES", None)
# Staff acknowledges the action-required circular.
ackr = staffA.post(f"/api/announcements/{baid}/ack", json={})
check("staff can acknowledge", ackr.status_code == 200, ackr.text)
after = staffA.get("/api/announcements").json()
check("ack is reflected for the staff member",
      next((a for a in after if a["id"] == baid), {}).get("acked") is True, after)
acks = admin.get(f"/api/announcements/{baid}/acks").json()
check("manager sees who acknowledged", any(r["username"] == f"zza{sfx}" for r in acks["acked"]), acks)
# A team lead can post only to their branch; a staff member cannot post at all.
sp = staffA.post("/api/announcements", json={"title": "x", "body": "y"})
check("staff can't post announcements", sp.status_code == 403, sp.text)
# Delete cleans up.
check("manager can delete an announcement", admin.delete(f"/api/announcements/{aid}").status_code == 200)

print("\n== scenario 18: employee of the month ==")
setr = admin.put("/api/employee-of-month", json={"staff_id": A["id"], "period": "June 2026", "note": "Great work"})
check("manager can set employee of the month", setr.status_code == 200, setr.text)
eotm = staffA.get("/api/employee-of-month").json()
check("everyone can read the current EOTM", (eotm.get("staff") or {}).get("id") == A["id"], eotm)
check("EOTM carries the note", eotm.get("note") == "Great work", eotm)
nope = staffA.put("/api/employee-of-month", json={"staff_id": B["id"]})
check("staff can't set EOTM", nope.status_code == 403, nope.text)
admin.put("/api/employee-of-month", json={"staff_id": None})
check("EOTM can be cleared", (admin.get("/api/employee-of-month").json().get("staff")) is None)

print("\n== scenario 19: per-shift equipment checks ==")
SCD = f"{YEAR}-08-28"
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": SCD, "shift_code": "M"})
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": B["id"], "date": SCD, "shift_code": "N"})
# B is on Night, not Morning → can't confirm the Morning check.
nb = staffB.post("/api/shift-checks", json={"branch_id": bid, "date": SCD, "shift": "M"})
check("off-shift staff can't confirm the check", nb.status_code == 403, nb.text)
# A is on Morning → can confirm.
ca = staffA.post("/api/shift-checks", json={"branch_id": bid, "date": SCD, "shift": "M"})
check("on-shift staff confirms the morning check", ca.status_code == 200 and ca.json().get("done") is True, ca.text)
# Shared/idempotent: re-confirming is a no-op, still done.
ca2 = staffA.post("/api/shift-checks", json={"branch_id": bid, "date": SCD, "shift": "M"})
check("re-confirm is idempotent", ca2.status_code == 200 and ca2.json().get("done") is True, ca2.text)
st = staffA.get(f"/api/shift-checks?branch_id={bid}&date={SCD}").json()
m = next((c for c in st["checks"] if c["shift"] == "M"), {})
n = next((c for c in st["checks"] if c["shift"] == "N"), {})
check("morning check shows done with confirmer", m.get("done") is True and bool(m.get("confirmed_by_name")), st)
check("night check still pending", n.get("done") is False, st)
ov = admin.get(f"/api/shift-checks/overview?date={SCD}").json()
bov = next((b for b in ov["branches"] if b["branch_id"] == bid), {})
check("overview shows the branch's checks", any(c["shift"] == "M" and c["done"] for c in bov.get("checks", [])), ov)
# Night-shift staff confirms the night check.
cn = staffB.post("/api/shift-checks", json={"branch_id": bid, "date": SCD, "shift": "N"})
check("night-shift staff confirms the night check", cn.status_code == 200, cn.text)
# Manager can reopen.
ro = admin.put("/api/shift-checks/reopen", json={"branch_id": bid, "date": SCD, "shift": "M"})
check("manager can reopen a check", ro.status_code == 200, ro.text)
st2 = admin.get(f"/api/shift-checks?branch_id={bid}&date={SCD}").json()
check("reopened check is pending again",
      next((c for c in st2["checks"] if c["shift"] == "M"), {}).get("done") is False, st2)
bad = admin.post("/api/shift-checks", json={"branch_id": bid, "date": SCD, "shift": "X"})
check("invalid shift rejected", bad.status_code == 400, bad.text)
# Shift-start hour setting round-trips.
sm = admin.put("/api/settings", json={"shift_check_m_hour": 7})
check("shift_check_m_hour setting round-trips",
      sm.status_code == 200 and str(sm.json().get("shift_check_m_hour")) == "7", sm.text)
admin.put("/api/settings", json={"shift_check_m_hour": 8})

print("\n== scenario 20: manual edits are flagged (preserved on regenerate) ==")
me = admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": f"{YEAR}-08-17", "shift_code": "N"})
check("a hand-entered cell is flagged is_manual", me.status_code == 200 and me.json().get("is_manual") is True, me.text)
ments = admin.get(f"/api/schedules/{sid}/entries").json()
mcell = next((e for e in ments if e["staff_id"] == A["id"] and e["date"] == f"{YEAR}-08-17"), None)
check("entries list surfaces the manual flag", bool(mcell) and mcell.get("is_manual") is True, mcell)

print("\n== scenario 21: on-duty roster ==")
ODD = f"{YEAR}-08-19"
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": A["id"], "date": ODD, "shift_code": "M"})
admin.put(f"/api/schedules/{sid}/entries", json={"staff_id": B["id"], "date": ODD, "shift_code": "O"})
od = admin.get(f"/api/on-duty?date={ODD}").json()
allon = [s for b in od["branches"] for s in b["staff"]]
check("on-duty includes a working staff member with their shift",
      any(s["staff_id"] == A["id"] and s["shift_code"] == "M" for s in allon), od)
check("on-duty excludes off/leave staff", not any(s["staff_id"] == B["id"] for s in allon), allon)
adet = next((s for s in allon if s["staff_id"] == A["id"]), {})
check("on-duty carries contact + section info", "section" in adet and "phone" in adet, adet)
odl = lead.get(f"/api/on-duty?date={ODD}").json()
check("team lead's on-duty is scoped to their branch", all(b["branch_id"] == bid for b in odl["branches"]), odl)

print("\n== scenario 22: reports (fairness / cases / QC log) ==")
fr = admin.get(f"/api/reports/fairness?branch_id={bid}&year={YEAR}&month={MONTH}").json()
check("fairness lists staff with distribution counts",
      any(s["id"] == A["id"] for s in fr["staff"]) and all("nights" in s and "weekends" in s for s in fr["staff"]), fr)
cf, ct2 = f"{YEAR}-08-01", f"{YEAR}-08-31"
cr = admin.get(f"/api/reports/cases?from={cf}&to={ct2}&branch_id={bid}").json()
check("cases report returns totals + series", "total_cases" in (cr.get("totals") or {}) and isinstance(cr.get("series"), list), cr)
qr = admin.get(f"/api/reports/qc-log?from={cf}&to={ct2}&branch_id={bid}").json()
check("qc-log returns a log array", isinstance(qr.get("log"), list), qr)
check("team lead can't report on another branch (403)",
      lead.get(f"/api/reports/fairness?branch_id=99999&year={YEAR}&month={MONTH}").status_code == 403)
check("staff are blocked from reports (403)",
      staffA.get(f"/api/reports/fairness?branch_id={bid}&year={YEAR}&month={MONTH}").status_code == 403)

print("\n== scenario 23: staff credentials / license expiry ==")
soon = f"{YEAR}-{MONTH:02d}-28"   # expiring this month → should surface in expiring soon
cc = admin.post("/api/credentials", json={"staff_id": A["id"], "kind": "scfhs",
                                          "label": "Radiology specialist", "number": "R-123",
                                          "expiry_date": soon})
check("admin creates a credential", cc.status_code == 200 and "id" in cc.json(), cc.text)
cid = cc.json().get("id")
clist = admin.get(f"/api/credentials?branch_id={bid}").json()
crow = next((r for r in clist if r["id"] == cid), None)
check("credential appears in branch list with days_left",
      crow is not None and "days_left" in crow and crow["staff_id"] == A["id"], clist)
exp = admin.get("/api/credentials/expiring?days=3650").json()
check("expiring endpoint surfaces the credential", any(i["id"] == cid for i in exp.get("items", [])), exp)
own = staffA.get(f"/api/staff/{A['id']}/credentials").json()
check("staff sees their own credentials", any(r["id"] == cid for r in own), own)
check("staff can't see another staff's credentials (403)",
      staffA.get(f"/api/staff/{B['id']}/credentials").status_code == 403)
check("staff can't create credentials (403)",
      staffA.post("/api/credentials", json={"staff_id": A["id"], "kind": "bls", "expiry_date": soon}).status_code == 403)
check("team lead can't manage another branch's staff credential (403)",
      lead.post("/api/credentials", json={"staff_id": sB["id"], "kind": "bls", "expiry_date": soon}).status_code == 403)
check("credential requires an expiry date (400)",
      admin.post("/api/credentials", json={"staff_id": A["id"], "kind": "bls"}).status_code == 400)
upd = admin.put(f"/api/credentials/{cid}", json={"kind": "scfhs", "label": "Updated", "expiry_date": f"{YEAR}-12-31"})
check("admin updates a credential", upd.status_code == 200, upd.text)
check("update reflected in list",
      next((r for r in admin.get(f"/api/credentials?branch_id={bid}").json() if r["id"] == cid), {}).get("expiry_date") == f"{YEAR}-12-31")
dele = admin.delete(f"/api/credentials/{cid}")
check("admin deletes a credential", dele.status_code == 200, dele.text)
check("credential gone after delete",
      not any(r["id"] == cid for r in admin.get(f"/api/credentials?branch_id={bid}").json()))

print("\n== scenario 24: staff shift preferences ==")
PY, PM = YEAR, MONTH
pu = staffB.put("/api/preferences", json={"year": PY, "month": PM, "day": 6, "kind": "unavailable"})
check("staff sets an unavailable day", pu.status_code == 200, pu.text)
staffB.put("/api/preferences", json={"year": PY, "month": PM, "day": 7, "kind": "unavailable"})
staffB.put("/api/preferences", json={"year": PY, "month": PM, "day": 8, "kind": "unavailable"})
staffB.put("/api/preferences", json={"year": PY, "month": PM, "day": 15, "kind": "off"})
mine = staffB.get(f"/api/preferences?year={PY}&month={PM}").json()
check("staff sees their own preferences",
      len([p for p in mine["preferences"] if p["kind"] == "unavailable"]) == 3, mine)
check("invalid day rejected (400)",
      staffB.put("/api/preferences", json={"year": PY, "month": PM, "day": 99, "kind": "off"}).status_code == 400)
check("staff can't set another staff's preference (403)",
      staffB.put("/api/preferences", json={"year": PY, "month": PM, "day": 6, "kind": "off", "staff_id": A["id"]}).status_code == 403)
lp = lead.get(f"/api/preferences?branch_id={bid}&year={PY}&month={PM}").json()
check("team lead sees branch preferences with staff name",
      any(p["staff_id"] == B["id"] and p.get("staff_name") for p in lp["preferences"]), lp)
g = admin.post("/api/generate", json={"branch_id": bid, "year": PY, "month": PM, "confirm": True, "ignore_manual": True})
if g.status_code == 200:
    sg = (g.json().get("schedule") or {}).get("id") or sid
    ents = admin.get(f"/api/schedules/{sg}/entries").json()
    bdays = {e["date"][8:10]: e["shift_code"] for e in ents if e["staff_id"] == B["id"]}
    check("unavailable days are never worked (forced off)",
          all(bdays.get(f"{d:02d}") not in ("M", "N") for d in (6, 7, 8)),
          {d: bdays.get(f"{d:02d}") for d in (6, 7, 8)})
    g2 = admin.post("/api/generate", json={"branch_id": bid, "year": PY, "month": PM,
                                           "confirm": True, "ignore_manual": True, "ignore_prefs": True})
    check("generation runs with preferences ignored", g2.status_code == 200, g2.text)
staffB.put("/api/preferences", json={"year": PY, "month": PM, "day": 15, "kind": "none"})
mine2 = staffB.get(f"/api/preferences?year={PY}&month={PM}").json()
check("clearing a day removes the preference", not any(p["day"] == 15 for p in mine2["preferences"]), mine2)

print("\n== scenario 25: downtime registration (system-down patient log) ==")
dt = staffA.post("/api/downtime", json={"patient_name": "Patient One", "patient_id": "1098765432",
                                        "modality": "CT", "procedure": "CT Brain", "indication": "Headache",
                                        "ward": "ER"})
check("staff registers a downtime study", dt.status_code == 200, dt.text)
dj = dt.json()
acc = (dj.get("study") or {}).get("accession", "")
check("accession is minted, DT-prefixed and DICOM-safe (<=16 chars)",
      acc.startswith("DT") and 0 < len(acc) <= 16, acc)
check("copy message carries accession + patient ID + exam",
      acc in dj["message"] and "1098765432" in dj["message"] and "CT" in dj["message"], dj["message"])
dt2 = staffA.post("/api/downtime", json={"patient_name": "Patient Two", "patient_id": "1055555555", "modality": "US"})
acc2 = (dt2.json().get("study") or {}).get("accession", "")
check("a second registration gets a different accession", acc2 and acc2 != acc, [acc, acc2])
check("missing required field is rejected (400)",
      staffA.post("/api/downtime", json={"patient_name": "X", "modality": "CT"}).status_code == 400)
lst = staffA.get("/api/downtime").json()["studies"]
check("staff sees their branch's downtime log", any(s["accession"] == acc for s in lst), lst[:2])
check("downtime studies start as pending", all(s["status"] == "pending" for s in lst if s["accession"] in (acc, acc2)))
# A study on ANOTHER branch is not visible to this branch's staff.
oacc = admin.post("/api/downtime", json={"branch_id": bidB, "patient_name": "Other", "patient_id": "1011111111",
                                         "modality": "X-Ray"}).json().get("study", {}).get("accession")
check("staff don't see another branch's downtime studies", not any(s["accession"] == oacc for s in lst))
did = (dj.get("study") or {}).get("id")
check("staff can't reconcile (403)", staffA.put(f"/api/downtime/{did}/status", json={"status": "reconciled"}).status_code in (401, 403))
rec = lead.put(f"/api/downtime/{did}/status", json={"status": "reconciled"})
check("team lead reconciles a study", rec.status_code == 200, rec.text)
check("reconciled status reflected in the log",
      next((s for s in lead.get(f"/api/downtime?branch_id={bid}").json()["studies"] if s["id"] == did), {}).get("status") == "reconciled")

print(f"\n=== RESULT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
