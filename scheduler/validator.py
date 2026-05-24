"""
Meena Health Radiology — Schedule Validator
Standalone function — call after generation AND after every manual edit.
"""

import calendar
from config import SHIFTS, WORK_SHIFTS, REST_SHIFTS, WEEKEND_DAYS_OF_WEEK, NESTS


def validate_schedule(schedule: dict, nest_name: str, year: int, month: int,
                      al_schedule: dict = None) -> dict:
    """
    Validate a generated or manually-edited schedule.

    Args:
        schedule:     { person_name: [shift_code, ...], ... }  (index 0 = day 1)
        nest_name:    e.g. "NEST1"
        year, month:  e.g. 2026, 5
        al_schedule:  { person_name: [day_numbers, ...] }  (1-based)

    Returns:
        { "errors": [...], "warnings": [...] }
        errors   → hard violations (must fix before save)
        warnings → soft violations (review, not blocking)
    """
    al_schedule = al_schedule or {}
    nest_cfg = NESTS[nest_name]
    n_days = calendar.monthrange(year, month)[1]

    errors   = []
    warnings = []

    def e(msg): errors.append(msg)
    def w(msg): warnings.append(msg)

    # Build helper maps
    # day_of_week: 0=Mon … 6=Sun  → Friday=4, Saturday=5
    def is_weekend(day):   # day is 1-based
        return calendar.weekday(year, month, day) in WEEKEND_DAYS_OF_WEEK

    # Flatten all staff → section map
    staff_section = {}
    for sec_name, sec in nest_cfg["sections"].items():
        for p in sec["staff"]:
            staff_section[p] = sec_name

    # ── 1. Completeness — every expected person has a schedule ───────────────
    for sec in nest_cfg["sections"].values():
        for p in sec["staff"]:
            if p not in schedule:
                e(f"MISSING: {p} has no schedule row")
            elif len(schedule[p]) != n_days:
                e(f"LENGTH: {p} has {len(schedule[p])} days, expected {n_days}")

    # ── 2. One shift per day, valid shift codes, AL consistency ──────────────
    al_days_map = {}   # person → set of 0-based indices
    for p, days in al_schedule.items():
        al_days_map[p] = {d - 1 for d in days}

    for p, row in schedule.items():
        sec_name = staff_section.get(p)
        if sec_name is None:
            w(f"UNKNOWN PERSON: {p} not in nest config — skipping validation")
            continue
        allowed = set(NESTS[nest_name]["sections"][sec_name]["allowed_shifts"])

        al_days = al_days_map.get(p, set())

        for i, code in enumerate(row):
            day = i + 1

            # Unknown shift code
            if code not in SHIFTS:
                e(f"{p} Day {day}: unknown shift code '{code}'")
                continue

            # AL input says this day is AL but schedule doesn't show AL
            if i in al_days and code != "AL":
                e(f"{p} Day {day}: AL in input but schedule shows '{code}'")

            # Schedule shows AL but it wasn't in AL input — hard error
            if code == "AL" and i not in al_days:
                e(f"{p} Day {day}: schedule shows AL but not in AL input")

            # Shift not allowed for this section
            if code not in allowed:
                e(f"{p} Day {day}: '{code}' not in allowed shifts for {sec_name}")

    # ── 3. No N → morning shift next day ─────────────────────────────────────
    MORNING_SHIFTS = {"M", "D", "D1", "A", "EV", "B", "Y3", "D_US"}
    for p, row in schedule.items():
        for i in range(len(row) - 1):
            if row[i] == "N" and row[i + 1] in MORNING_SHIFTS:
                e(f"{p} Day {i+1}→{i+2}: N followed by {row[i+1]} (rest required)")

    # ── 4. Max 5 consecutive working shifts ───────────────────────────────────
    for p, row in schedule.items():
        consec = 0
        for i, code in enumerate(row):
            if code in WORK_SHIFTS:
                consec += 1
                if consec > 5:
                    e(f"{p} Day {i+1}: {consec} consecutive working shifts (max 5)")
            else:
                consec = 0

    # ── 5. Coverage check per day ─────────────────────────────────────────────
    for day in range(1, n_days + 1):
        idx = day - 1
        is_wknd = is_weekend(day)
        day_type = "weekend" if is_wknd else "weekday"

        for sec_name, sec in nest_cfg["sections"].items():
            coverage_req = sec["coverage"].get(day_type, {})
            staff_list   = sec["staff"]

            shift_counts = {}
            for p in staff_list:
                if p in schedule and idx < len(schedule[p]):
                    code = schedule[p][idx]
                    shift_counts[code] = shift_counts.get(code, 0) + 1

            for shift_code, min_count in coverage_req.items():
                actual = shift_counts.get(shift_code, 0)
                if actual < min_count:
                    e(f"Day {day} ({day_type}) {sec_name}: needs {min_count}×{shift_code}, has {actual}")

    # ── 6. Soft: fairness — M/N distribution ─────────────────────────────────
    for sec_name, sec in nest_cfg["sections"].items():
        for shift_code in ["M", "N"]:
            counts = {}
            for p in sec["staff"]:
                if p in schedule:
                    counts[p] = sum(1 for c in schedule[p] if c == shift_code)
            if not counts:
                continue
            vals = list(counts.values())
            spread = max(vals) - min(vals)
            if spread > 3:
                low  = [p for p, v in counts.items() if v == min(vals)]
                high = [p for p, v in counts.items() if v == max(vals)]
                w(f"{sec_name} {shift_code} spread={spread}: "
                  f"low={low}({min(vals)}) high={high}({max(vals)})")

    # ── 7. Soft: rest days per week ───────────────────────────────────────────
    for p, row in schedule.items():
        # Check each 7-day window
        for week_start in range(0, n_days, 7):
            week = row[week_start:week_start + 7]
            al_count   = sum(1 for c in week if c == "AL")
            rest_count = sum(1 for c in week if c == "O")
            # Only warn if there are workable days (not all AL) and no O
            workable = len(week) - al_count
            if workable > 0 and rest_count < 1:
                w(f"{p} week starting day {week_start+1}: no O rest days ({al_count} AL days)")

    return {"errors": errors, "warnings": warnings}


def print_validation(result: dict):
    errors   = result["errors"]
    warnings = result["warnings"]

    if not errors and not warnings:
        print("✅ All validations passed — schedule is clean")
        return

    if errors:
        print(f"\n❌ ERRORS ({len(errors)}) — must fix before save:")
        for err in errors:
            print(f"   • {err}")

    if warnings:
        print(f"\n⚠️  WARNINGS ({len(warnings)}) — review recommended:")
        for warn in warnings:
            print(f"   • {warn}")
