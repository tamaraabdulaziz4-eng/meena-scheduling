"""Self-contained Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID).

We implement the encryption and VAPID signing directly on top of `cryptography`
(already a dependency via python-jose[cryptography]) instead of pulling in
`pywebpush`/`http-ece`, which fail to build in this environment.

Public surface:
  generate_vapid_keys()           -> (private_b64url, public_b64url)
  send(subscription, payload, *, vapid_private, vapid_public, subject)
                                  -> int HTTP status (404/410 => prune)

A `subscription` is the dict the browser hands back:
  {"endpoint": "...", "keys": {"p256dh": "...", "auth": "..."}}
or the flattened form {"endpoint","p256dh","auth"}.
"""
import os, json, time, struct, base64, urllib.request, urllib.error
from urllib.parse import urlparse

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_CURVE = ec.SECP256R1()


def b64u_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def b64u_decode(s) -> bytes:
    if isinstance(s, str):
        s = s.encode("ascii")
    return base64.urlsafe_b64decode(s + b"=" * (-len(s) % 4))


def generate_vapid_keys():
    """Return (private_b64url, public_b64url). Private is the 32-byte scalar;
    public is the 65-byte uncompressed point — both base64url (no padding)."""
    pk = ec.generate_private_key(_CURVE, default_backend())
    priv = pk.private_numbers().private_value.to_bytes(32, "big")
    pub = pk.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return b64u_encode(priv), b64u_encode(pub)


def _load_private(priv_b64):
    val = int.from_bytes(b64u_decode(priv_b64), "big")
    return ec.derive_private_key(val, _CURVE, default_backend())


def _hkdf(salt, ikm, info, length):
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt,
                info=info, backend=default_backend()).derive(ikm)


def _encrypt(payload: bytes, ua_public_b64: str, auth_b64: str) -> bytes:
    """aes128gcm content encoding (RFC 8188) with Web Push key derivation
    (RFC 8291). Returns the full message body (header + ciphertext)."""
    ua_public = b64u_decode(ua_public_b64)      # client public key, 65 bytes
    auth_secret = b64u_decode(auth_b64)          # client auth secret, 16 bytes

    as_priv = ec.generate_private_key(_CURVE, default_backend())   # server ephemeral
    as_public = as_priv.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    ua_pub_key = ec.EllipticCurvePublicKey.from_encoded_point(_CURVE, ua_public)
    ecdh_secret = as_priv.exchange(ec.ECDH(), ua_pub_key)

    salt = os.urandom(16)
    # RFC 8291: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info"||0||ua||as)
    key_info = b"WebPush: info\x00" + ua_public + as_public
    ikm = _hkdf(auth_secret, ecdh_secret, key_info, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)

    record = payload + b"\x02"          # single-record padding delimiter
    ciphertext = AESGCM(cek).encrypt(nonce, record, None)

    record_size = 4096
    header = salt + struct.pack(">I", record_size) + struct.pack("B", len(as_public)) + as_public
    return header + ciphertext


def _es256_jwt(claims: dict, priv_key) -> str:
    header = {"typ": "JWT", "alg": "ES256"}
    seg = (b64u_encode(json.dumps(header, separators=(",", ":")).encode()) + "." +
           b64u_encode(json.dumps(claims, separators=(",", ":")).encode()))
    der = priv_key.sign(seg.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return seg + "." + b64u_encode(raw)


def _vapid_authorization(endpoint, vapid_private_b64, vapid_public_b64, subject):
    u = urlparse(endpoint)
    claims = {"aud": f"{u.scheme}://{u.netloc}",
              "exp": int(time.time()) + 12 * 3600,
              "sub": subject}
    token = _es256_jwt(claims, _load_private(vapid_private_b64))
    return f"vapid t={token}, k={vapid_public_b64}"


def _flatten(subscription):
    keys = subscription.get("keys") or {}
    return (subscription["endpoint"],
            subscription.get("p256dh") or keys.get("p256dh"),
            subscription.get("auth") or keys.get("auth"))


def send(subscription, payload, *, vapid_private, vapid_public, subject, ttl=86400, timeout=20):
    """POST one encrypted push. Returns the HTTP status code (201 on success,
    404/410 when the subscription is gone and should be pruned)."""
    endpoint, p256dh, auth = _flatten(subscription)
    if not (endpoint and p256dh and auth):
        return 0
    body = _encrypt(json.dumps(payload, ensure_ascii=False).encode("utf-8"), p256dh, auth)
    headers = {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(ttl),
        "Urgency": "normal",
        "Authorization": _vapid_authorization(endpoint, vapid_private, vapid_public, subject),
    }
    req = urllib.request.Request(endpoint, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
