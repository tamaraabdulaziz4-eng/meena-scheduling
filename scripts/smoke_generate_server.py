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
import argparse
import calendar
from collections import defaultdict


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

    parser = argparse.ArgumentParser(description="Smoke test schedule generation + rule validation.")
    parser.add_argument("--branch", type=int, default=int(os.environ.get("SMOKE_BRANCH_ID", "1")))
    parser.add_argument("--year", type=int, default=int(os.environ.get("SMOKE_YEAR", "2026")))
    parser.add_argument("--month", type=int, default=int(os.environ.get("SMOKE_MONTH", "5")))
    args = parser.parse_args()
    branch_id = int(args.branch)
    year = int(args.year)
    month = int(args.month)

    username = os.environ.get("ADMIN_USER", "admin")
    password = os.environ.get("ADMIN_PASS", "admin123")

    from fastapi.testclient import TestClient
    from server.main import app

    def branch_name_to_nest_key(branch_name: str) -> str | None:
        if not branch_name:
            return None
        s = branch_name.strip().upper().replace(" ", "")
        if s.startswith("NEST"):
            return s  # e.g. NEST1, NEST4
        return None

    def validate_rules(payload: dict, entries: list[dict], nest_sections: list[dict], sec_month: dict) -> list[str]:
        errors: list[str] = []
        n_days = calendar.monthrange(year, month)[1]
        half = (n_days + 1) // 2

        # db_name_lower -> section_name
        name_to_section: dict[str, str] = {}
        for sec in nest_sections:
            sec_name = sec.get("section_name")
            for _solver_key, db_name in (sec.get("staff_db_names") or {}).items():
                if db_name:
                    name_to_section[db_name.lower().strip()] = sec_name

        # section_name -> max_consecutive
        sec_max_c: dict[str, int] = {}
        for _sid, row in (sec_month or {}).items():
            if row and row.get("section_name"):
                sec_max_c[row["section_name"]] = int(row.get("max_consecutive", 4) or 4)

        # staff_id -> [code_by_day] (1-indexed by day-of-month)
        by_staff: dict[int, list[str]] = defaultdict(lambda: ["O"] * (n_days + 1))
        for e in entries:
            sid = int(e["staff_id"])
            ds = (e.get("date") or "").strip()
            try:
                d = int(ds.split("-")[-1])
            except Exception:
                continue
            if 1 <= d <= n_days:
                by_staff[sid][d] = e.get("shift_code") or "O"

        # staff_id -> section_name (best effort via staff_name)
        staff_id_to_section: dict[int, str] = {}
        for s in payload.get("summary") or []:
            sid = int(s["staff_id"])
            nm = (s.get("staff_name") or "").lower().strip()
            sec = name_to_section.get(nm)
            if sec:
                staff_id_to_section[sid] = sec

        # Check each staff schedule against rules.
        for staff_id, codes in sorted(by_staff.items()):
            sec = staff_id_to_section.get(staff_id)
            k = sec_max_c.get(sec, 4)

            # Rule A: Half-month M/N locking (no mix within half; opposite across halves).
            first = {codes[d] for d in range(1, half + 1) if codes[d] in ("M", "N")}
            second = {codes[d] for d in range(half + 1, n_days + 1) if codes[d] in ("M", "N")}
            if len(first) > 1:
                errors.append(f"staff_id={staff_id}: mixed M/N in first half: {sorted(first)}")
            if len(second) > 1:
                errors.append(f"staff_id={staff_id}: mixed M/N in second half: {sorted(second)}")
            if len(first) == 1 and len(second) == 1:
                if next(iter(first)) == next(iter(second)):
                    errors.append(f"staff_id={staff_id}: did not switch M↔N across halves ({next(iter(first))} both halves)")

            # Rule B: After k consecutive workdays (M/N), next two non-AL days must be O.
            for start in range(1, n_days - (k + 2) + 2):
                window = codes[start : start + k]
                if all(c in ("M", "N") for c in window):
                    for d in (start + k, start + k + 1):
                        if d > n_days:
                            continue
                        if codes[d] == "AL":
                            continue
                        if codes[d] != "O":
                            errors.append(
                                f"staff_id={staff_id}: after {k} consecutive work days starting day {start}, day {d} must be O (got {codes[d]})"
                            )
        return errors

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
            return 1

        if r.status_code != 200:
            return 1

        schedule_id = (payload.get("schedule") or {}).get("id")
        if not schedule_id:
            print("ERROR: generate payload missing schedule.id", file=sys.stderr)
            return 1

        # Fetch entries for validation.
        r_entries = client.get(f"/api/schedules/{schedule_id}/entries")
        if r_entries.status_code != 200:
            print("ERROR: failed to fetch schedule entries:", r_entries.status_code, r_entries.text[:500], file=sys.stderr)
            return 1
        entries = r_entries.json() or []

        # Determine nest_key from branch name, then load nest config for staff→section mapping.
        r_br = client.get("/api/branches")
        branches = r_br.json() if r_br.status_code == 200 else []
        branch = next((b for b in branches if int(b.get("id")) == int(branch_id)), None)
        nest_key = branch_name_to_nest_key(branch.get("name") if branch else "")
        nest_sections = []
        if nest_key:
            r_nc = client.get(f"/api/nest-config/{nest_key}")
            if r_nc.status_code == 200:
                nest_sections = (r_nc.json() or {}).get("sections") or []

        r_sec = client.get("/api/section-month-settings", params={"branch_id": branch_id, "year": year, "month": month})
        sec_month = r_sec.json() if r_sec.status_code == 200 else {}

        rule_errors = validate_rules(payload, entries, nest_sections, sec_month)
        print(f"Rule violations: {len(rule_errors)}")
        for e in rule_errors[:20]:
            print(" -", e)

        return 0 if r.status_code == 200 else 1


if __name__ == "__main__":
    raise SystemExit(main())
