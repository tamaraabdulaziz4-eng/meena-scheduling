"""Enumerated scenario audit for REGISTRATION + MESSAGES (notifications/WhatsApp).
Run with DATABASE_URL set. Prints an inventory, then checks each scenario.

Env it sets: SADQ_MOCK (Nafath mock), WHATSAPP_CAPTURE (capture WA messages),
SMTP_CAPTURE (capture emails), and a tuned WHATSAPP_ONLY_TYPES.
"""
import os, sys, re, time
os.environ.setdefault("SADQ_MOCK", "1")
os.environ.setdefault("WHATSAPP_CAPTURE", "1")
os.environ.setdefault("SMTP_CAPTURE", "1")
os.environ.setdefault("COOKIE_SECURE", "0")
os.environ["WHATSAPP_ONLY_TYPES"] = "approved,rejected,leave,swap,reminder,activated"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server.main as M
from fastapi.testclient import TestClient

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

def wa_code(to_sub):
    for m in reversed(M._whatsapp_outbox):
        if "verification code" in m["message"].lower() and to_sub in m["to"]:
            mm = re.search(r"(\d{6})", m["message"]); return mm.group(1) if mm else None
    return None
def email_code(email):
    for e in reversed(M._email_outbox):
        if e.get("to") == email and "verification code" in (e.get("body") or "").lower():
            mm = re.search(r"(\d{6})", e["body"]); return mm.group(1) if mm else None
    return None
def notes(client):
    return [n["message"] for n in client.get("/api/notifications").json().get("notifications", [])]

admin = login("admin", "admin123")
bid = next(b["id"] for b in admin.get("/api/branches").json() if "NEST 3" in b["name"])
# A branch team lead (to observe lead-facing notifications).
sfx = str(int(time.time()))[-5:]
admin.post("/api/users", json={"username": f"lead{sfx}", "password": "leadpass1", "role": "admin", "branch_id": bid})
lead = login(f"lead{sfx}", "leadpass1")

def register_staff_full(name, emp, phone, email, username, section="General", nid="1098765432"):
    """Full real onboarding: Nafath → phone code → email code → register (auto-login)."""
    c = TestClient(app)
    s = c.post("/api/register/nafath/start", json={"national_id": nid})
    rid = s.json()["request_id"]
    TestClient(app).post("/api/nafath/webhook", json={"requestId": rid, "Status": 0,
        "usersInfo": [{"FirstNameEn": name.split()[0], "LastNameEn": name.split()[-1],
                       "FirstNameAr": "اسم", "LastNameAr": "رسمي", "NationalId": nid}]})
    c.post("/api/register/send-phone-code", json={"phone": phone})
    pc = wa_code(phone.replace("0", "966", 1))
    c.post("/api/register/send-code", json={"email": email})
    ec = email_code(email)
    r = c.post("/api/register", json={"name": name, "branch_id": bid, "section": section,
        "employee_id": emp, "email": email, "phone": phone, "username": username, "password": "staffpass1",
        "email_code": ec, "phone_code": pc, "nafath_request_id": rid})
    return c, r, pc, ec

print("""
================= SCENARIO INVENTORY =================
REGISTRATION
  R1  open registration exposes Nafath + phone verification
  R2  email code: send → wrong rejected → right accepted (no consume)
  R3  phone code over WhatsApp: send → wrong rejected → right accepted
  R4  Nafath: start → success webhook → verified; reuse blocked; failure; invalid ID
  R5  staff full sign-up auto-activates + auto-login + can sign in
  R6  validation guards: @meena email, mobile required, username taken, codes required
  R7  team-lead sign-up stays pending until a superadmin approves
  R8  official Nafath name + National ID stored on the staff record
MESSAGES / NOTIFICATIONS
  M1  activation → staff (in-app+WhatsApp+email); branch lead 'joined'; managers NOT
  M2  leave approved/rejected → staff notified (in-app + WhatsApp)
  M3  intermediate 'passed team lead' is NOT pushed to staff (noise removed)
  M4  sick leave → leads + managers 'find cover'
  M5  swap request → peer; swap approved → both
  M6  time-back decision → staff notified
  M7  WhatsApp type-filter: 'info' is NOT sent to WhatsApp; 'approved' is
  M8  removed noise: no 'daily cases complete' manager blast
  M9  WhatsApp number normalised (05… → 9665…)
=====================================================
""")

print("== R1: registration surface ==")
info = TestClient(app).get("/api/register/info").json()
check("R1 Nafath enabled", info.get("nafath_enabled") is True, info)
check("R1 phone verification enabled", info.get("phone_verify_enabled") is True, info)

print("== R2: email code ==")
em = f"r2_{sfx}@meena-health.com"
TestClient(app).post("/api/register/send-code", json={"email": em})
ec = email_code(em)
check("R2 email code emitted", bool(ec), ec)
check("R2 wrong email code rejected", TestClient(app).post("/api/register/check-email-code", json={"email": em, "email_code": "000000"}).status_code == 400)
check("R2 right email code accepted (no consume)", TestClient(app).post("/api/register/check-email-code", json={"email": em, "email_code": ec}).status_code == 200)

print("== R3: phone code over WhatsApp ==")
ph = "05011" + sfx
M._whatsapp_outbox.clear()
sp = TestClient(app).post("/api/register/send-phone-code", json={"phone": ph})
check("R3 send-phone-code ok", sp.status_code == 200, sp.text)
pc = wa_code("966" + ph[1:])
check("R3 WhatsApp code emitted to the number", bool(pc), M._whatsapp_outbox[-3:])
check("R3 wrong phone code rejected", TestClient(app).post("/api/register/check-phone-code", json={"phone": ph, "phone_code": "000000"}).status_code == 400)
check("R3 right phone code accepted", TestClient(app).post("/api/register/check-phone-code", json={"phone": ph, "phone_code": pc}).status_code == 200)

print("== R4: Nafath ==")
s = TestClient(app).post("/api/register/nafath/start", json={"national_id": "1234567890"})
check("R4 start returns a number", s.status_code == 200 and s.json().get("random"), s.text)
rid = s.json()["request_id"]
check("R4 status pending before approval", TestClient(app).get(f"/api/register/nafath/status?request_id={rid}").json()["status"] == "pending")
TestClient(app).post("/api/nafath/webhook", json={"requestId": rid, "Status": 0,
    "usersInfo": [{"FirstNameEn": "Test", "LastNameEn": "User", "NationalId": "1234567890"}]})
check("R4 verified after webhook", TestClient(app).get(f"/api/register/nafath/status?request_id={rid}").json()["status"] == "verified")
s2 = TestClient(app).post("/api/register/nafath/start", json={"national_id": "2123456789"})
rid2 = s2.json()["request_id"]
TestClient(app).post("/api/nafath/webhook", json={"requestId": rid2, "Status": 1, "nationalId": "2123456789"})
check("R4 failure webhook marks failed", TestClient(app).get(f"/api/register/nafath/status?request_id={rid2}").json()["status"] == "failed")
check("R4 invalid National ID rejected", TestClient(app).post("/api/register/nafath/start", json={"national_id": "123"}).status_code == 400)

print("== R5 + M1: staff full sign-up, auto-activate, activation messages ==")
M._whatsapp_outbox.clear(); M._email_outbox.clear()
lead_before = set(notes(lead))
sc, sr, pc5, ec5 = register_staff_full("Omar Alharbi", f"E{sfx}", "05022" + sfx, f"omar_{sfx}@meena-health.com", f"omar{sfx}")
check("R5 registration auto-activates + auto_login", sr.status_code == 200 and sr.json().get("auto_login") is True, sr.text)
check("R5 staff record created", bool(M.q("SELECT id FROM scheduling.staff WHERE employee_id=%s", (f"E{sfx}",), one=True)))
check("R5 new staff is signed in (cookie set)", sc.get("/api/auth/me").status_code == 200)
check("R5 can sign in with chosen credentials", TestClient(app).post("/api/auth/login", json={"username": f"omar{sfx}", "password": "staffpass1"}).status_code == 200)
staff_notes = notes(sc)
check("M1 staff in-app welcome/activation note", any("welcome" in n.lower() or "active" in n.lower() for n in staff_notes), staff_notes)
check("M1 staff WhatsApp activation message", any(x.get("type") == "activated" for x in M._whatsapp_outbox), [x['type'] for x in M._whatsapp_outbox])
check("M1 staff welcome email", any("welcome" in (e.get("subject") or "").lower() for e in M._email_outbox), [e.get('subject') for e in M._email_outbox])
lead_new = set(notes(lead)) - lead_before
check("M1 branch lead notified 'new staff joined'", any("new staff joined" in n.lower() for n in lead_new), lead_new)
mgr_notes = notes(admin)
check("M1 managers NOT pinged 'new staff joined'", not any("new staff joined" in n.lower() for n in mgr_notes))

print("== R8: official name + National ID stored ==")
st = M.q("SELECT name, national_id FROM scheduling.staff WHERE employee_id=%s", (f"E{sfx}",), one=True)
check("R8 official Nafath name stored", st and st["name"] == "Omar Alharbi", st)
check("R8 National ID stored", st and st["national_id"] == "1098765432", st)

print("== R6: validation guards ==")
base = {"branch_id": bid, "section": "General", "password": "x123456", "name": "X"}
check("R6 non-@meena email rejected", TestClient(app).post("/api/register", json={**base, "employee_id": f"G{sfx}", "email": "x@gmail.com", "phone": "0500000000", "username": f"g{sfx}"}).status_code == 400)
check("R6 missing mobile rejected", TestClient(app).post("/api/register", json={**base, "employee_id": f"NP{sfx}", "email": f"np{sfx}@meena-health.com", "username": f"np{sfx}"}).status_code == 400)
check("R6 taken username rejected", TestClient(app).post("/api/register", json={**base, "employee_id": f"DU{sfx}", "email": f"du{sfx}@meena-health.com", "phone": "0500000000", "username": "admin"}).status_code == 409)

print("== R7: team-lead sign-up needs approval ==")
M._whatsapp_outbox.clear()
tl = TestClient(app)
trid = tl.post("/api/register/nafath/start", json={"national_id": "2000000007"}).json()["request_id"]
TestClient(app).post("/api/nafath/webhook", json={"requestId": trid, "Status": 0, "usersInfo": [{"FirstNameEn": "Lead", "LastNameEn": "Cand", "NationalId": "2000000007"}]})
tlphone = "05033" + sfx
tl.post("/api/register/send-phone-code", json={"phone": tlphone})
tpc = wa_code(tlphone.replace("0", "966", 1))
tl.post("/api/register/send-code", json={"email": f"tl_{sfx}@meena-health.com"})
tec = email_code(f"tl_{sfx}@meena-health.com")
tr = tl.post("/api/register", json={"role": "admin", "name": "Lead Cand", "branch_id": bid,
    "email": f"tl_{sfx}@meena-health.com", "phone": tlphone, "username": f"tlc{sfx}", "password": "tlpass1",
    "email_code": tec, "phone_code": tpc, "nafath_request_id": trid})
check("R7 team-lead sign-up accepted but NOT auto-login", tr.status_code == 200 and not tr.json().get("auto_login"), tr.text)
check("R7 cannot sign in before approval", TestClient(app).post("/api/auth/login", json={"username": f"tlc{sfx}", "password": "tlpass1"}).status_code == 401)
reg = next((r for r in admin.get("/api/registrations").json() if r.get("username") == f"tlc{sfx}"), None)
check("R7 appears in superadmin approval queue", reg is not None and reg.get("requested_role") == "admin", reg)
check("R7 superadmin approves", admin.post(f"/api/registrations/{reg['id']}/approve", json={}).status_code == 200 if reg else False)
check("R7 can sign in after approval", TestClient(app).post("/api/auth/login", json={"username": f"tlc{sfx}", "password": "tlpass1"}).status_code == 200)

print("== M2/M3: leave decision messages ==")
M._whatsapp_outbox.clear()
from datetime import date
y = date.today().year; mo = date.today().month
# Leave for a month whose cutoff (day 15 of the previous month) hasn't passed yet.
m2 = mo + 2; y2 = y
if m2 > 12: m2 -= 12; y2 += 1
d1 = f"{y2}-{m2:02d}-20"
lv = sc.post("/api/leaves", json={"date_from": d1, "date_to": d1, "leave_type": "AL"})
check("M2 staff can request leave", lv.status_code == 200, lv.text)
staff_before = set(notes(sc))
# stage 1: team lead clears it (→ awaiting manager). Staff should NOT be pinged here.
lid = M.q("SELECT id FROM scheduling.leave_requests WHERE staff_id=(SELECT id FROM scheduling.staff WHERE employee_id=%s) AND date=%s", (f"E{sfx}", d1), one=True)["id"]
lead.put(f"/api/leaves/{lid}/status", json={"status": "approved"})
mid_staff = set(notes(sc)) - staff_before
check("M3 staff NOT pinged at 'awaiting manager' stage", not any("team lead" in n.lower() for n in mid_staff), mid_staff)
check("M3 managers see 'awaiting your final approval'", any("final approval" in n.lower() for n in notes(admin)))
# stage 2: manager approves → staff notified approved + WhatsApp.
M._whatsapp_outbox.clear()
admin.put(f"/api/leaves/{lid}/status", json={"status": "approved", "confirm": True})
check("M2 staff notified leave approved", any("approved" in n.lower() for n in notes(sc)))
check("M2 leave-approved sent to WhatsApp (type approved)", any(x.get("type") == "approved" for x in M._whatsapp_outbox), [x['type'] for x in M._whatsapp_outbox])

print("== M4: sick leave → cover alert to leads + managers ==")
lead_b4 = set(notes(lead)); mgr_b4 = set(notes(admin))
sld = f"{y2}-{m2:02d}-18"
slr = sc.post("/api/leaves", json={"date_from": sld, "date_to": sld, "leave_type": "SL"})
check("M4 sick leave accepted", slr.status_code == 200, slr.text)
check("M4 branch lead alerted to find cover", any("sick" in n.lower() or "cover" in n.lower() for n in (set(notes(lead)) - lead_b4)))
check("M4 managers alerted to find cover", any("sick" in n.lower() or "cover" in n.lower() for n in (set(notes(admin)) - mgr_b4)))

print("== M5: swap request → peer; approved → both ==")
scb, srb, _, _ = register_staff_full("Yara Saleh", f"EB{sfx}", "05044" + sfx, f"yara_{sfx}@meena-health.com", f"yara{sfx}", nid="1066778899")
aid = M.q("SELECT id FROM scheduling.staff WHERE employee_id=%s", (f"E{sfx}",), one=True)["id"]
bsid = M.q("SELECT id FROM scheduling.staff WHERE employee_id=%s", (f"EB{sfx}",), one=True)["id"]
# Seed an approved schedule with the two shifts so the swap can actually apply.
sch = M.q("""INSERT INTO scheduling.schedules (branch_id,year,month,status) VALUES (%s,%s,%s,'approved')
             ON CONFLICT (branch_id,year,month) DO UPDATE SET status='approved' RETURNING id""",
          (bid, y2, m2), one=True)["id"]
for stid, dt, code in [(aid, f"{y2}-{m2:02d}-22", "M"), (bsid, f"{y2}-{m2:02d}-23", "N")]:
    M.q("""INSERT INTO scheduling.schedule_entries (schedule_id,staff_id,date,shift_code)
           VALUES (%s,%s,%s,%s) ON CONFLICT (schedule_id,staff_id,date) DO UPDATE SET shift_code=EXCLUDED.shift_code""",
        (sch, stid, dt, code), exec_only=True)
b_before = set(notes(scb))
sw = sc.post("/api/swaps", json={"staff_b": bsid, "date_a": f"{y2}-{m2:02d}-22", "date_b": f"{y2}-{m2:02d}-23"})
check("M5 swap request accepted", sw.status_code == 200, sw.text)
check("M5 peer notified of swap request", any("swap" in n.lower() for n in (set(notes(scb)) - b_before)), set(notes(scb)) - b_before)
swid = sw.json().get("id")
scb.put(f"/api/swaps/{swid}/action", json={"action": "approve"})   # peer accepts
lead.put(f"/api/swaps/{swid}/action", json={"action": "approve"})  # team lead
M._whatsapp_outbox.clear()
fin = admin.put(f"/api/swaps/{swid}/action", json={"action": "approve"})  # manager final
check("M5 swap reaches approved", fin.status_code == 200 and fin.json().get("status") == "approved", fin.text)
check("M5 both staff notified of approved swap",
      any("swap" in n.lower() and "approv" in n.lower() for n in notes(sc)) and any("swap" in n.lower() for n in notes(scb)))

print("== M6: time-back decision → staff notified ==")
tb = sc.post("/api/timeback", json={"date": d1, "reason": "covered", "note": "covered an extra shift"})
check("M6 staff can submit time-back", tb.status_code == 200, tb.text)
tbid = tb.json().get("id")
lead.put(f"/api/timeback/{tbid}/status", json={"status": "approved"})
admin.put(f"/api/timeback/{tbid}/status", json={"status": "approved"})
check("M6 staff notified of time-back decision", any("time-back" in n.lower() for n in notes(sc)), notes(sc)[:6])

print("== M7: WhatsApp type filter ==")
# 'info' notifications must NOT reach WhatsApp (not in WHATSAPP_ONLY_TYPES).
M._whatsapp_outbox.clear()
M.notify(M.q("SELECT id FROM scheduling.users WHERE username=%s", (f"omar{sfx}",), one=True)["id"], "An info ping", ntype="info")
check("M7 'info' type NOT sent to WhatsApp", not any(x.get("type") == "info" for x in M._whatsapp_outbox), M._whatsapp_outbox)
M._whatsapp_outbox.clear()
M.notify(M.q("SELECT id FROM scheduling.users WHERE username=%s", (f"omar{sfx}",), one=True)["id"], "Approved ping", ntype="approved")
check("M7 'approved' type IS sent to WhatsApp", any(x.get("type") == "approved" for x in M._whatsapp_outbox), M._whatsapp_outbox)

print("== M9: WhatsApp number normalisation ==")
check("M9 05… normalised to 9665…", M._normalize_whatsapp_number("0512345678") == "966512345678")

print("== M8: removed-noise (daily cases complete) ==")
M._whatsapp_outbox.clear()
mgr_before = set(notes(admin))
for b in admin.get("/api/branches").json():
    admin.post("/api/daily-cases", json={"branch_id": b["id"], "date": f"{y}-{mo:02d}-16", "xray": 3, "submit": True})
check("M8 no 'daily cases complete' blast to managers", not any("daily cases complete" in n.lower() for n in (set(notes(admin)) - mgr_before)))

print(f"\n=== SCENARIO AUDIT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
