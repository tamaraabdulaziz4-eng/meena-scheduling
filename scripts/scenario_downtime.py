"""Comprehensive adversarial scenarios for the Downtime registration feature.

This is patient-safety critical: a duplicated Accession Number would route one
patient's images onto another's study. So we hammer the accession minting under
real concurrency, plus validation / scoping / reconcile / robustness edge cases.

Run: COOKIE_SECURE=0 SMTP_CAPTURE=1 DATABASE_URL=... python scripts/scenario_downtime.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from concurrent.futures import ThreadPoolExecutor
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
S = "dt"
# Two branches whose names map to the SAME branch code "Z" (no digits) — this
# exercises the cross-branch collision path: they share the per-code counter, so
# accessions must still be globally unique.
bA = admin.post("/api/branches", json={"name": "ZZ Downtime A"}).json()
bB = admin.post("/api/branches", json={"name": "ZZ Downtime B"}).json()
bidA = bA.get("id") or (bA.get("branch") or {}).get("id")
bidB = bB.get("id") or (bB.get("branch") or {}).get("id")
A = admin.post("/api/staff", json={"name": "DT Staff A", "branch_id": bidA, "phone": "0533333333"}).json()
B = admin.post("/api/staff", json={"name": "DT Staff B", "branch_id": bidB}).json()   # no phone on purpose
for u, st in ((f"dta{S}", A), (f"dtb{S}", B)):
    admin.post("/api/users", json={"username": u, "password": "pass123", "role": "staff", "staff_id": st["id"]})
admin.post("/api/users", json={"username": f"dtlA{S}", "password": "pass123", "role": "admin", "branch_id": bidA})
admin.post("/api/users", json={"username": f"dtlB{S}", "password": "pass123", "role": "admin", "branch_id": bidB})
staffA, staffB = login(f"dta{S}", "pass123"), login(f"dtb{S}", "pass123")
leadA, leadB = login(f"dtlA{S}", "pass123"), login(f"dtlB{S}", "pass123")
check("setup: two same-code branches + staff/leads", all([bidA, bidB, A.get("id"), B.get("id")]) and bidA != bidB)

# ── Accession format + message ────────────────────────────────────────────────
print("\n== accession minting + message ==")
r = staffA.post("/api/downtime", json={"patient_name": "Patient One", "patient_id": "1000000001",
                                       "modality": "CT", "procedure": "CT Brain", "indication": "Headache", "ward": "ER"})
check("staff registers a study", r.status_code == 200, r.text)
study = r.json()["study"]; acc = study["accession"]
check("accession format DT<code>-<ymd>-<seq>, DICOM-safe (<=16)",
      acc.startswith("DTZ-") and len(acc) <= 16, acc)
check("copy message carries exam, accession, indication and patient ID",
      all(x in r.json()["message"] for x in [acc, "1000000001", "CT", "CT Brain", "Headache"]), r.json()["message"])
did = study["id"]

# ── Concurrency: the critical test — no duplicate accessions under load ────────
print("\n== concurrency: 30 parallel registrations must all be unique ==")
# 6 workers keeps us safely under the DB pool (maxconn=10) while still running
# genuinely in parallel — enough to expose any race in the accession counter.
N = 30
def fire(i):
    try:
        r = staffA.post("/api/downtime", json={"patient_name": f"Conc {i}",
                                               "patient_id": f"3{i:09d}", "modality": "US"})
        return (r.status_code, (r.json().get("study") or {}).get("accession") if r.status_code == 200 else None)
    except Exception as e:
        return (0, repr(e))
with ThreadPoolExecutor(max_workers=6) as ex:
    res = list(ex.map(fire, range(N)))
accs = [a for (sc, a) in res if sc == 200 and a]
check(f"all {N} concurrent registrations succeed", len(accs) == N, [sc for sc, _ in res][:8])
check("all concurrent accessions are UNIQUE (no collision)",
      len(set(accs)) == len(accs), f"{len(set(accs))} unique of {len(accs)}")
check("every concurrent accession stays within 16 chars", all(len(a) <= 16 for a in accs),
      [a for a in accs if len(a) > 16][:3])

# ── Cross-branch (same code) uniqueness ──────────────────────────────────────
print("\n== cross-branch same-code uniqueness ==")
rb = staffB.post("/api/downtime", json={"patient_name": "Patient B", "patient_id": "1000000002", "modality": "X-Ray"})
check("registration works without a phone (WhatsApp is best-effort)", rb.status_code == 200, rb.text)
accB = rb.json()["study"]["accession"]
allA = set(accs) | {acc}
check("a same-code OTHER branch never reuses branch A's accession",
      accB.startswith("DTZ-") and accB not in allA, accB)

# ── Validation ────────────────────────────────────────────────────────────────
print("\n== validation ==")
check("blank patient name rejected (400)",
      staffA.post("/api/downtime", json={"patient_name": "   ", "patient_id": "1", "modality": "CT"}).status_code == 400)
check("missing patient_id rejected (400)",
      staffA.post("/api/downtime", json={"patient_name": "X", "modality": "CT"}).status_code == 400)
check("missing modality rejected (400)",
      staffA.post("/api/downtime", json={"patient_name": "X", "patient_id": "1"}).status_code == 400)
rl = staffA.post("/api/downtime", json={"patient_name": "N" * 300, "patient_id": "9" * 100, "modality": "CT" * 50})
check("over-long fields are truncated, not rejected (400-free)",
      rl.status_code == 200 and len(rl.json()["study"]["patient_name"]) <= 120
      and len(rl.json()["study"]["patient_id"]) <= 40, rl.text)

# ── Permissions + scoping ─────────────────────────────────────────────────────
print("\n== permissions + scoping ==")
anon = TestClient(app)
check("anonymous can't register (401/403)",
      anon.post("/api/downtime", json={"patient_name": "X", "patient_id": "1", "modality": "CT"}).status_code in (401, 403))
rcross = staffA.post("/api/downtime", json={"branch_id": bidB, "patient_name": "Foreign", "patient_id": "1000000003", "modality": "CT"})
check("staff registration ignores a foreign branch_id (writes to own branch)", rcross.status_code == 200, rcross.text)
acc_cross = rcross.json()["study"]["accession"]
listA = staffA.get("/api/downtime").json()["studies"]
check("the foreign-branch attempt actually landed on staff A's own branch",
      any(s["accession"] == acc_cross and s["branch_id"] == bidA for s in listA))
check("team lead can't register for another branch (403)",
      leadA.post("/api/downtime", json={"branch_id": bidB, "patient_name": "X", "patient_id": "1", "modality": "CT"}).status_code == 403)
check("manager can register for any branch",
      admin.post("/api/downtime", json={"branch_id": bidB, "patient_name": "Mgr", "patient_id": "1000000004", "modality": "CT"}).status_code == 200)
check("staff A sees only their own branch's log", all(s["branch_id"] == bidA for s in listA), {s["branch_id"] for s in listA})
check("staff A never sees branch B's studies", not any(s["accession"] == accB for s in listA))
check("team lead B sees branch B's studies",
      any(s["accession"] == accB for s in leadB.get("/api/downtime").json()["studies"]))

# ── Reconcile flow ────────────────────────────────────────────────────────────
print("\n== reconcile flow ==")
check("invalid status rejected (400)",
      leadA.put(f"/api/downtime/{did}/status", json={"status": "done"}).status_code == 400)
check("reconcile a non-existent study (404)",
      leadA.put("/api/downtime/99999999/status", json={"status": "reconciled"}).status_code == 404)
check("staff can't reconcile (403)",
      staffA.put(f"/api/downtime/{did}/status", json={"status": "reconciled"}).status_code in (401, 403))
check("team lead of ANOTHER branch can't reconcile (403)",
      leadB.put(f"/api/downtime/{did}/status", json={"status": "reconciled"}).status_code == 403)
check("team lead reconciles their own branch's study",
      leadA.put(f"/api/downtime/{did}/status", json={"status": "reconciled"}).status_code == 200)
check("status now reconciled in the log",
      next((s for s in leadA.get("/api/downtime").json()["studies"] if s["id"] == did), {}).get("status") == "reconciled")
check("undo back to pending works",
      leadA.put(f"/api/downtime/{did}/status", json={"status": "pending"}).status_code == 200)

# ── Robustness ────────────────────────────────────────────────────────────────
print("\n== robustness ==")
check("malformed date filter is ignored, not a 500",
      leadA.get("/api/downtime?from=notadate&to=zzz").status_code == 200)
check("the log endpoint advertises the modality list",
      isinstance(staffA.get("/api/downtime").json().get("modalities"), list))

# ── Public no-login link ──────────────────────────────────────────────────────
print("\n== public no-login link ==")
check("staff can't fetch the public link (403)", staffA.get("/api/downtime/public-link").status_code == 403)
linkj = admin.get("/api/downtime/public-link").json()
tok = linkj.get("token")
check("manager gets a public link with a token", bool(tok) and "/dt?t=" in (linkj.get("url") or ""), linkj)
pub = TestClient(app)   # no login at all
check("public info without a token is blocked (403)", pub.get("/api/public/downtime/info").status_code == 403)
check("public info with a bad token is blocked (403)", pub.get("/api/public/downtime/info?token=nope").status_code == 403)
info = pub.get(f"/api/public/downtime/info?token={tok}")
check("public info with the token returns branches", info.status_code == 200 and any(b["id"] == bidA for b in info.json()["branches"]), info.text)
check("public submit without a token is blocked (403)",
      pub.post("/api/public/downtime", json={"branch_id": bidA, "patient_name": "X", "patient_id": "1", "modality": "CT", "specialist_id": "S1"}).status_code == 403)
ps = pub.post(f"/api/public/downtime?token={tok}", json={"branch_id": bidA, "patient_name": "Public Patient",
                "patient_id": "1077777777", "modality": "CT", "procedure": "CT Chest", "specialist_id": "SPEC-99"})
check("public submit with the token works", ps.status_code == 200, ps.text)
pacc = ps.json()["study"]["accession"]
check("public accession is unique + DICOM-safe", pacc.startswith("DTZ-") and len(pacc) <= 16 and pacc not in allA, pacc)
check("public message carries the specialist ID", "SPEC-99" in ps.json()["message"], ps.json()["message"])
check("public submit requires a specialist ID (400)",
      pub.post(f"/api/public/downtime?token={tok}", json={"branch_id": bidA, "patient_name": "X", "patient_id": "1", "modality": "CT"}).status_code == 400)
check("public submit still validates patient fields (400)",
      pub.post(f"/api/public/downtime?token={tok}", json={"branch_id": bidA, "specialist_id": "S", "modality": "CT"}).status_code == 400)
# The public study shows in the branch log, attributed to the specialist.
plog = next((s for s in leadA.get("/api/downtime").json()["studies"] if s["accession"] == pacc), {})
check("public study appears in the log as a public entry",
      plog.get("source") == "public" and plog.get("specialist_id") == "SPEC-99"
      and "Public" in (plog.get("created_by_name") or ""), plog)
# Regenerate rotates the token; the old one stops working.
newtok = admin.post("/api/downtime/public-link/regenerate").json()["token"]
check("regenerate returns a different token", newtok and newtok != tok, [tok, newtok])
check("the OLD token no longer works (403)", pub.get(f"/api/public/downtime/info?token={tok}").status_code == 403)
check("the NEW token works", pub.get(f"/api/public/downtime/info?token={newtok}").status_code == 200)

print(f"\n=== RESULT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
