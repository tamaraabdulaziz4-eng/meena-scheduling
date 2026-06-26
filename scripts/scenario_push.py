"""Scenarios for Web Push (browser notifications).

Run: COOKIE_SECURE=0 WEBPUSH_CAPTURE=1 DATABASE_URL=... python scripts/scenario_push.py
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

# A realistic browser subscription (matches what pushManager.subscribe returns).
import server.webpush as W
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
def fake_subscription(tag):
    pk = ec.generate_private_key(ec.SECP256R1(), default_backend())
    pub = pk.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return {"endpoint": f"https://push.example.com/{tag}",
            "keys": {"p256dh": W.b64u_encode(pub), "auth": W.b64u_encode(os.urandom(16))}}

print("\n== setup ==")
admin = login("admin", "admin123")
S = "push"
brs = admin.get("/api/branches").json(); b1 = brs[0]["id"]
A = admin.post("/api/staff", json={"name": "Push Alpha", "branch_id": b1, "phone": "0588888888", "speciality": ["General"]}).json()
admin.post("/api/users", json={"username": f"u{S}", "password": "pass123", "role": "staff", "staff_id": A["id"]})
staffA = login(f"u{S}", "pass123")
check("setup ok", bool(A.get("id")))

# ── VAPID public key ──────────────────────────────────────────────────────────
print("\n== vapid ==")
check("must be logged in for VAPID key (401)", TestClient(app).get("/api/push/vapid").status_code == 401)
vp = admin.get("/api/push/vapid").json()
check("VAPID public key is returned", isinstance(vp.get("public_key"), str) and len(vp["public_key"]) > 80, vp)

# ── Subscribe / validate ──────────────────────────────────────────────────────
print("\n== subscribe ==")
check("garbage subscription rejected (400)", staffA.post("/api/push/subscribe", json={"endpoint": "x"}).status_code == 400)
sub = fake_subscription("alpha-1")
check("valid subscription accepted", staffA.post("/api/push/subscribe", json=sub).json().get("ok") is True)
# Re-subscribing the same endpoint must not duplicate (upsert on endpoint).
staffA.post("/api/push/subscribe", json=sub)
cnt = M.q("SELECT COUNT(*) AS n FROM scheduling.push_subscriptions WHERE endpoint=%s", (sub["endpoint"],), one=True)["n"]
check("re-subscribe upserts (no duplicate)", cnt == 1, cnt)

# ── notify() fans out a web push ──────────────────────────────────────────────
print("\n== push on notify ==")
M._webpush_outbox.clear()
uid = M.q("SELECT id FROM scheduling.users WHERE username=%s", (f"u{S}",), one=True)["id"]
M.notify(uid, "Your schedule was approved", link="myschedule", ntype="approved")
pushed = [p for p in M._webpush_outbox if p["user_id"] == uid]
check("a web push was queued for the subscribed user", len(pushed) == 1, M._webpush_outbox)
check("push carries title + body + link", pushed and pushed[0]["body"] == "Your schedule was approved"
      and pushed[0]["link"] == "myschedule", pushed[:1])

# Off-shift night reminder (whatsapp=False) must NOT buzz the device either.
print("\n== off-shift suppression ==")
M._webpush_outbox.clear()
M.notify(uid, "Night reminder", link="home", ntype="reminder", whatsapp=False)
check("whatsapp=False also suppresses web push", not any(p["user_id"] == uid for p in M._webpush_outbox), M._webpush_outbox)

# ── Unsubscribe ───────────────────────────────────────────────────────────────
print("\n== unsubscribe ==")
staffA.post("/api/push/unsubscribe", json={"endpoint": sub["endpoint"]})
gone = M.q("SELECT COUNT(*) AS n FROM scheduling.push_subscriptions WHERE endpoint=%s", (sub["endpoint"],), one=True)["n"]
check("unsubscribe removes the device", gone == 0, gone)
M._webpush_outbox.clear()
M.notify(uid, "after unsub", link="home")
check("no push after unsubscribe", not any(p["user_id"] == uid for p in M._webpush_outbox))

# ── Encryption is real (end-to-end round-trip via the actual subscription) ────
print("\n== encryption ==")
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import struct, json as _json
pk = ec.generate_private_key(ec.SECP256R1(), default_backend())
ua_pub = pk.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
auth = os.urandom(16)
body = W._encrypt(_json.dumps({"body": "صباح الخير"}).encode(), W.b64u_encode(ua_pub), W.b64u_encode(auth))
salt = body[:16]; idlen = body[20]; as_pub = body[21:21+idlen]; ct = body[21+idlen:]
ecdh = pk.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
def hk(s, ikm, info, n): return HKDF(algorithm=hashes.SHA256(), length=n, salt=s, info=info, backend=default_backend()).derive(ikm)
ikm = hk(auth, ecdh, b"WebPush: info\x00" + ua_pub + as_pub, 32)
cek = hk(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
nonce = hk(salt, ikm, b"Content-Encoding: nonce\x00", 12)
pt = AESGCM(cek).decrypt(nonce, ct, None)
check("payload decrypts back on the client side", _json.loads(pt[:-1].decode())["body"] == "صباح الخير", pt)

print(f"\n=== RESULT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
