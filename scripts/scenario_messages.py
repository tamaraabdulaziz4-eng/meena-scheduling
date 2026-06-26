"""Scenarios for direct messaging (custom WhatsApp / email to chosen staff).

Run: COOKIE_SECURE=0 SMTP_CAPTURE=1 WHATSAPP_CAPTURE=1 DATABASE_URL=... \
     python scripts/scenario_messages.py
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
admin = login("admin", "admin123")
S = "msg"
brs = admin.get("/api/branches").json()
b1, b2 = brs[0]["id"], brs[1]["id"]
A = admin.post("/api/staff", json={"name": "Msg Alpha", "branch_id": b1, "phone": "0511111111", "email": "alpha@x.com", "speciality": ["General"]}).json()
B = admin.post("/api/staff", json={"name": "Msg Beta", "branch_id": b1, "phone": "0522222222", "speciality": ["US"]}).json()  # phone only
C = admin.post("/api/staff", json={"name": "Msg Gamma", "branch_id": b2, "phone": "0533333333", "email": "gamma@x.com"}).json()
admin.post("/api/users", json={"username": f"ua{S}", "password": "pass123", "role": "staff", "staff_id": A["id"]})  # A has a login
admin.post("/api/users", json={"username": f"l1{S}", "password": "pass123", "role": "admin", "branch_id": b1})
staffA = login(f"ua{S}", "pass123")
leadA = login(f"l1{S}", "pass123")
check("setup ok", all([b1, b2, A.get("id"), B.get("id"), C.get("id")]) and b1 != b2)

# ── Recipients list ───────────────────────────────────────────────────────────
print("\n== recipients ==")
check("staff can't open the recipients list (403)", staffA.get("/api/messages/recipients").status_code == 403)
rec = leadA.get("/api/messages/recipients").json()["recipients"]
check("lead sees only their own branch", all(r["branch_id"] == b1 for r in rec) and any(r["id"] == A["id"] for r in rec), rec)
ra = next(r for r in rec if r["id"] == A["id"])
rb = next(r for r in rec if r["id"] == B["id"])
check("channel availability is reported", ra["has_phone"] and ra["has_email"] and ra["has_login"]
      and rb["has_phone"] and not rb["has_email"] and not rb["has_login"], [ra, rb])
check("section is computed", ra["section"] == "General" and rb["section"] == "US", [ra["section"], rb["section"]])

# ── Send across channels + personalisation ────────────────────────────────────
print("\n== send: channels + {name} ==")
M._whatsapp_outbox.clear(); M._email_outbox.clear()
r = leadA.post("/api/messages/send", json={"staff_ids": [A["id"]], "channels": ["whatsapp", "email", "app"],
                                           "subject": "Hello", "message": "Hi {name}, please check in."})
check("send to one over all channels", r.status_code == 200, r.text)
res = r.json()
check("delivered counts per channel", res["delivered"] == 1 and res["whatsapp"] == 1 and res["email"] == 1 and res["app"] == 1, res)
wa = " ".join(w["message"] for w in M._whatsapp_outbox)
check("WhatsApp went out personalised with {name}", "Hi Msg Alpha" in wa, wa)
check("email went out with the subject + body", any(e["subject"] == "Hello" and "Msg Alpha" in e["body"] for e in M._email_outbox), M._email_outbox)
napp = [n for n in staffA.get("/api/notifications").json()["notifications"] if "please check in" in (n["message"] or "")]
check("in-app notification created for the recipient with a login", len(napp) >= 1, napp[:1])

# ── Channel selection is honored ──────────────────────────────────────────────
print("\n== channel selection ==")
M._whatsapp_outbox.clear(); M._email_outbox.clear()
leadA.post("/api/messages/send", json={"staff_ids": [A["id"]], "channels": ["whatsapp"], "message": "ping"})
check("WhatsApp-only send: WhatsApp fired", any("ping" in w["message"] for w in M._whatsapp_outbox))
check("WhatsApp-only send: NO email", not any("ping" in e["body"] for e in M._email_outbox))

# ── Multiple recipients ───────────────────────────────────────────────────────
print("\n== multiple recipients ==")
M._whatsapp_outbox.clear()
r = leadA.post("/api/messages/send", json={"staff_ids": [A["id"], B["id"]], "channels": ["whatsapp"], "message": "team note"})
check("send to two → delivered 2, whatsapp 2", r.json()["delivered"] == 2 and r.json()["whatsapp"] == 2, r.json())
to = {w["to"] for w in M._whatsapp_outbox}
check("both numbers were messaged", any("511111111" in t for t in to) and any("522222222" in t for t in to), to)

# ── Validation + scope ────────────────────────────────────────────────────────
print("\n== validation + scope ==")
check("empty message rejected (400)", leadA.post("/api/messages/send", json={"staff_ids": [A["id"]], "channels": ["whatsapp"], "message": "  "}).status_code == 400)
check("no channel rejected (400)", leadA.post("/api/messages/send", json={"staff_ids": [A["id"]], "channels": [], "message": "x"}).status_code == 400)
check("no recipients rejected (400)", leadA.post("/api/messages/send", json={"staff_ids": [], "channels": ["whatsapp"], "message": "x"}).status_code == 400)
check("staff can't send (403)", staffA.post("/api/messages/send", json={"staff_ids": [A["id"]], "channels": ["app"], "message": "x"}).status_code == 403)
out = leadA.post("/api/messages/send", json={"staff_ids": [C["id"]], "channels": ["whatsapp"], "message": "x"})
check("lead can't message another branch's staff (filtered → 400)", out.status_code == 400, out.text)
mgr = admin.post("/api/messages/send", json={"staff_ids": [C["id"]], "channels": ["whatsapp"], "message": "x"})
check("manager CAN message any branch", mgr.status_code == 200 and mgr.json()["delivered"] == 1, mgr.text)

print(f"\n=== RESULT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
