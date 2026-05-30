#!/usr/bin/env python3
"""
Server-style smoke test for schedule generation.

Runs the FastAPI app (including startup schema/seed) and calls:
  1) POST /api/auth/login
  2) POST /api/generate

Requires:
  - DATABASE_URL set to a real Postgres database
  - requirements installed (pip install -r requirements.txt)
"""

import os
import sys
import json


def main() -> int:
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    sys.path.insert(0, repo_root)

    # Load .env the same way server/main.py does (setdefault semantics).
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip())

    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        print("ERROR: DATABASE_URL is not set.", file=sys.stderr)
        return 2

    branch_id = int(os.environ.get("SMOKE_BRANCH_ID", "1"))
    year = int(os.environ.get("SMOKE_YEAR", "2026"))
    month = int(os.environ.get("SMOKE_MONTH", "5"))

    username = os.environ.get("ADMIN_USER", "admin")
    password = os.environ.get("ADMIN_PASS", "admin123")

    from fastapi.testclient import TestClient
    from server.main import app

    with TestClient(app) as client:
        r = client.post("/api/auth/login", json={"username": username, "password": password})
        if r.status_code != 200:
            print("Login failed:", r.status_code, r.text, file=sys.stderr)
            return 1

        r = client.post("/api/generate", json={"branch_id": branch_id, "year": year, "month": month})
        print("Generate status:", r.status_code)
        try:
            payload = r.json()
            print(json.dumps(payload, indent=2)[:4000])
        except Exception:
            print(r.text[:4000])

        return 0 if r.status_code == 200 else 1


if __name__ == "__main__":
    raise SystemExit(main())
