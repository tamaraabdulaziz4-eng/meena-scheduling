#!/usr/bin/env python3
"""Trigger a single Nafath (Sadq) verification so the Nafath app push arrives on
the phone of the given National ID. For sandbox testing only.

Usage:
    SADQ_ACCOUNT_ID=...  SADQ_THUMBPRINT=...  python3 scripts/nafath_test.py <national_id> [webhook_url]

Reads credentials from env (never hard-code them):
    SADQ_BASE_URL   default https://api-sandbox.sadq-sa.com
    SADQ_ACCOUNT_ID required
    SADQ_THUMBPRINT required

Prints the per-ID result, including the `random` number you must pick in the
Nafath app. The final auth result is only delivered to the webhook URL (not
needed just to receive the push).
"""
import os, sys, json, uuid, urllib.request, urllib.error

base   = os.environ.get("SADQ_BASE_URL", "https://api-sandbox.sadq-sa.com").rstrip("/")
acct   = os.environ.get("SADQ_ACCOUNT_ID", "").strip()
thumb  = os.environ.get("SADQ_THUMBPRINT", "").strip()

if len(sys.argv) < 2:
    sys.exit("Usage: python3 scripts/nafath_test.py <national_id> [webhook_url]")
nid = sys.argv[1].strip()
webhook = sys.argv[2].strip() if len(sys.argv) > 2 else "https://example.com/nafath-webhook"

if not (acct and thumb):
    sys.exit("Set SADQ_ACCOUNT_ID and SADQ_THUMBPRINT in the environment first.")
if not (nid.isdigit() and len(nid) == 10 and nid[0] in "12"):
    sys.exit("National ID must be 10 digits and start with 1 or 2.")

request_id = str(uuid.uuid4())
payload = {"nationalIds": [nid], "requestId": request_id, "accountId": acct, "webHookUrl": webhook}
req = urllib.request.Request(
    f"{base}/Authentication/Authority/IntegrationNafathAuth",
    data=json.dumps(payload).encode("utf-8"), method="POST",
    headers={"thumbPrint": thumb, "accountId": acct,
             "Content-Type": "application/json", "Accept": "application/json",
             "User-Agent": "MeenaScheduling/1.0 (+https://meena-health.com)"})
print(f"→ POST {base}/Authentication/Authority/IntegrationNafathAuth")
print(f"  requestId: {request_id}")
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8", "replace")
        print(f"← HTTP {resp.status}")
except urllib.error.HTTPError as e:
    print(f"← HTTP {e.code}\n{e.read().decode('utf-8', 'replace')}")
    raise SystemExit(1)
except Exception as e:
    print(f"✗ Could not reach Sadq: {type(e).__name__}: {e}")
    raise SystemExit(1)

try:
    data = json.loads(raw)
except ValueError:
    print("Non-JSON response:", raw[:400]); raise SystemExit(1)

print(json.dumps(data, indent=2, ensure_ascii=False))
items = data if isinstance(data, list) else [data]
for it in items:
    rnd = it.get("random")
    if rnd:
        print(f"\n✅ Open the Nafath app and choose number: {rnd}")
