"""
Meena Health Radiology — CP-SAT Schedule Generator
Start with NEST1, extend to others.

Usage:
    python generator.py --nest NEST1 --year 2026 --month 5
    python generator.py --nest NEST1 --year 2026 --month 5 --al MUHANNED:5-25
"""

import calendar
import json
import time
import argparse
import sys
from ortools.sat.python import cp_model

from config import SHIFTS, WORK_SHIFTS, REST_SHIFTS, WEEKEND_DAYS_OF_WEEK, NESTS
from validator import validate_schedule, print_validation


# ── Helpers ───────────────────────────────────────────────────────────────────

def is_weekend(year, month, day):
    """Friday=4, Saturday=5 in Python's weekday() (Mon=0)."""
    return calendar.weekday(year, month, day) in WEEKEND_DAYS_OF_WEEK


def day_type(year, month, day):
    return "weekend" if is_weekend(year, month, day) else "weekday"


def parse_al_arg(al_args):
    """Parse --al PERSON:d1,d2,d3 or PERSON:d1-d2 into dict."""
    al = {}
    if not al_args:
        return al
    for item in al_args:
        name, days_str = item.split(":")
        days = []
        for part in days_str.split(","):
            if "-" in part:
                a, b = part.split("-")
                days.extend(range(int(a), int(b) + 1))
            else:
                days.append(int(part))
        al[name.upper()] = sorted(set(days))
    return al


# ── Main solver ───────────────────────────────────────────────────────────────

def generate_schedule(nest_name: str, year: int, month: int,
                      al_schedule: dict = None, time_limit: int = 60) -> dict:
    """
    Generate a schedule for the given nest/month using CP-SAT.

    Returns:
        { "status": ..., "schedule": {...}, "stats": {...} }
    """
    al_schedule = al_schedule or {}
    nest_cfg    = NESTS[nest_name]
    n_days      = calendar.monthrange(year, month)[1]

    # Collect all staff and their sections
    all_staff   = []   # list of (person, section_name, section_cfg)
    for sec_name, sec in nest_cfg["sections"].items():
        for p in sec["staff"]:
            all_staff.append((p, sec_name, sec))

    # Build shift index maps
    # For each (person, section) we only allow their allowed_shifts
    # We need integer indices for CP-SAT
    ALL_CODES    = sorted(SHIFTS.keys())
    code_to_idx  = {c: i for i, c in enumerate(ALL_CODES)}
    idx_to_code  = {i: c for c, i in code_to_idx.items()}
    N_SHIFTS     = len(ALL_CODES)

    import sys as _sys
    print(f"\n{'='*60}", file=_sys.stderr)
    print(f"  Generating {nest_name} — {calendar.month_name[month]} {year}", file=_sys.stderr)
    print(f"  {n_days} days | {len(all_staff)} staff", file=_sys.stderr)
    print(f"  AL: { {k: v for k,v in al_schedule.items()} or 'none' }", file=_sys.stderr)
    print(f"{'='*60}\n", file=_sys.stderr)

    model = cp_model.CpModel()

    # ── Decision variables ────────────────────────────────────────────────────
    # shift_var[p][d] = integer index into ALL_CODES
    # AL  → only on pre-specified AL days
    # SL  → never auto-assigned (manual only)
    shift_var = {}
    al_idx = code_to_idx["AL"]
    for p, sec_name, sec in all_staff:
        # Allowed: remove AL and SL — solver never auto-assigns these
        auto_allowed = [code_to_idx[c] for c in sec["allowed_shifts"]
                        if c not in ("AL", "SL")]
        shift_var[p] = []
        for d in range(n_days):
            day = d + 1
            if p in al_schedule and day in al_schedule[p]:
                # Force AL on AL days
                v = model.new_int_var(al_idx, al_idx, f"s_{p}_{d}")
            else:
                v = model.new_int_var_from_domain(
                    cp_model.Domain.from_values(auto_allowed),
                    f"s_{p}_{d}"
                )
            shift_var[p].append(v)

    # ── Boolean helpers: is_shift[p][d][code] = 1 if person p on day d has code ──
    # We'll create these lazily only for shifts used in constraints/objectives
    is_shift = {}   # (p, d, code) → BoolVar

    def get_bool(p, d, code):
        key = (p, d, code)
        if key not in is_shift:
            b = model.new_bool_var(f"b_{p}_{d}_{code}")
            idx = code_to_idx[code]
            model.add(shift_var[p][d] == idx).only_enforce_if(b)
            model.add(shift_var[p][d] != idx).only_enforce_if(b.negated())
            is_shift[key] = b
        return is_shift[key]

    # ── Hard Constraint 1: Coverage ───────────────────────────────────────────
    for d in range(n_days):
        day  = d + 1
        dtype = day_type(year, month, day)
        for sec_name, sec in nest_cfg["sections"].items():
            coverage = sec["coverage"].get(dtype, {})
            for code, min_count in coverage.items():
                if min_count <= 0:
                    continue
                # sum of staff in this section with this code >= min_count
                bools = [get_bool(p, d, code)
                         for p, sn, _ in all_staff if sn == sec_name]
                model.add(sum(bools) >= min_count)

    # ── Hard Constraint 4: No N → morning shift next day ─────────────────────
    MORNING_CODES = ["M", "D", "D1", "A", "EV", "B", "Y3", "D_US"]
    for p, sec_name, sec in all_staff:
        allowed = set(sec["allowed_shifts"])
        morning_in_allowed = [c for c in MORNING_CODES if c in allowed]
        for d in range(n_days - 1):
            b_n = get_bool(p, d, "N")
            for mc in morning_in_allowed:
                b_m = get_bool(p, d + 1, mc)
                # b_n=1 AND b_m=1 is forbidden → b_n + b_m <= 1
                model.add(b_n + b_m <= 1)

    # ── Hard Constraint 5: Max 5 consecutive working shifts ───────────────────
    WORK_CODES = [c for c in ALL_CODES if c in WORK_SHIFTS]
    for p, sec_name, sec in all_staff:
        allowed = set(sec["allowed_shifts"])
        work_in_allowed = [c for c in WORK_CODES if c in allowed]
        for d in range(n_days - 5):
            # In any window of 6 days, at least 1 must be non-work
            work_bools = []
            for d2 in range(d, d + 6):
                for wc in work_in_allowed:
                    work_bools.append(get_bool(p, d2, wc))
            # sum of work bools in 6-day window <= 5 * (num_work_shifts_per_day)
            # But since each day has exactly 1 shift:
            # count of work days in window <= 5
            day_work = []
            for d2 in range(d, d + 6):
                day_w = model.new_bool_var(f"dw_{p}_{d2}")
                work_d = [get_bool(p, d2, wc) for wc in work_in_allowed]
                if work_d:
                    model.add_bool_or(work_d).only_enforce_if(day_w)
                    model.add(sum(work_d) == 0).only_enforce_if(day_w.negated())
                else:
                    model.add(day_w == 0)
                day_work.append(day_w)
            model.add(sum(day_work) <= 5)

    # ── Hard Constraint 6: Daily staffing balance (no mass-O days) ───────────
    # Goal: staff presence is spread evenly across the month.
    # For each section compute the expected work-days per person
    # (coverage shifts needed × days / staff available).
    # Then enforce: each day at least that many staff must be working.
    #
    # Formula:
    #   total_coverage_shifts = sum of min_per_day across all days
    #   avg_workers_per_day   = total_coverage_shifts / n_days  (already = coverage min)
    #   BUT we want more than just coverage min —
    #   we want total_work_budget / n_days where
    #   total_work_budget = n_staff × target_work_days_per_person
    #
    # target_work_days = (n_days - avg_al_days) * (5/7)
    # i.e. work 5 out of every 7 days (Islamic week: 5 work days, 2 off)

    WORK_CODES_SET = set(c for c in ALL_CODES if c in WORK_SHIFTS)

    for sec_name, sec in nest_cfg["sections"].items():
        sec_staff_names = [p for p, sn, _ in all_staff if sn == sec_name]
        work_in_sec     = [c for c in WORK_CODES_SET if c in sec["allowed_shifts"]]
        if not work_in_sec:
            continue

        n_sec = len(sec_staff_names)
        # Average AL days per person in this section
        avg_al = sum(len(al_schedule.get(p, [])) for p in sec_staff_names) / n_sec
        # Workable days per person ≈ (n_days - avg_al) × 5/7
        target_work_per_person = (n_days - avg_al) * (5 / 7)
        # Total work budget for section
        total_work_budget = n_sec * target_work_per_person
        # Min workers per day = floor(total_work_budget / n_days)
        min_workers_per_day = max(1, int(total_work_budget // n_days))

        for d in range(n_days):
            day = d + 1
            avail_today = [p for p in sec_staff_names
                           if not (p in al_schedule and day in al_schedule[p])]
            if len(avail_today) < min_workers_per_day:
                continue  # too few available (heavy AL period) — skip
            work_bools_today = []
            for p in avail_today:
                for wc in work_in_sec:
                    work_bools_today.append(get_bool(p, d, wc))
            model.add(sum(work_bools_today) >= min_workers_per_day)

    # ── Soft Constraint: Fairness — equal M and N distribution ───────────────
    # Minimize max deviation from mean for M and N counts
    FAIRNESS_SHIFTS = ["M", "N"]
    objective_terms = []

    for sec_name, sec in nest_cfg["sections"].items():
        sec_staff = [p for p, sn, _ in all_staff if sn == sec_name]
        for code in FAIRNESS_SHIFTS:
            if code not in sec["allowed_shifts"]:
                continue
            # Count of this shift per person
            counts = []
            for p in sec_staff:
                cnt = model.new_int_var(0, n_days, f"cnt_{p}_{code}")
                model.add(cnt == sum(get_bool(p, d, code) for d in range(n_days)))
                counts.append((p, cnt))

            if len(counts) < 2:
                continue

            # Penalize max - min (range of distribution)
            max_cnt = model.new_int_var(0, n_days, f"max_{sec_name}_{code}")
            min_cnt = model.new_int_var(0, n_days, f"min_{sec_name}_{code}")
            model.add_max_equality(max_cnt, [c for _, c in counts])
            model.add_min_equality(min_cnt, [c for _, c in counts])
            spread = model.new_int_var(0, n_days, f"spread_{sec_name}_{code}")
            model.add(spread == max_cnt - min_cnt)
            objective_terms.append(spread)

    # ── Soft Constraint: Weekend rest fairness ────────────────────────────────
    # Count weekend O per person — penalize high variance
    for sec_name, sec in nest_cfg["sections"].items():
        sec_staff = [p for p, sn, _ in all_staff if sn == sec_name]
        weekend_rest_counts = []
        for p in sec_staff:
            wknd_days = [d for d in range(n_days)
                         if is_weekend(year, month, d + 1)]
            if not wknd_days:
                continue
            cnt = model.new_int_var(0, len(wknd_days),
                                    f"wknd_rest_{p}")
            model.add(cnt == sum(get_bool(p, d, "O") for d in wknd_days))
            weekend_rest_counts.append(cnt)

        if len(weekend_rest_counts) >= 2:
            max_wknd = model.new_int_var(0, n_days, f"max_wknd_{sec_name}")
            min_wknd = model.new_int_var(0, n_days, f"min_wknd_{sec_name}")
            model.add_max_equality(max_wknd, weekend_rest_counts)
            model.add_min_equality(min_wknd, weekend_rest_counts)
            wknd_spread = model.new_int_var(0, n_days,
                                            f"wknd_spread_{sec_name}")
            model.add(wknd_spread == max_wknd - min_wknd)
            objective_terms.append(wknd_spread)

    # ── Soft Constraint: Maximize rest (O) days ──────────────────────────────
    # Each work day costs 1 point; each fairness spread costs 10 points.
    # This encourages ~2 O days/week while keeping fairness the priority.
    rest_penalty_terms = []
    for p, sec_name, sec in all_staff:
        for d in range(n_days):
            day = d + 1
            if p in al_schedule and day in al_schedule[p]:
                continue   # AL days already forced — skip
            if "O" not in sec["allowed_shifts"]:
                continue   # section doesn't use O (shouldn't happen)
            b_o = get_bool(p, d, "O")
            not_o = model.new_bool_var(f"notO_{p}_{d}")
            model.add(not_o == 1 - b_o)
            rest_penalty_terms.append(not_o)

    # ── Objective ─────────────────────────────────────────────────────────────
    # fairness spread terms (weight 10) + rest penalty (weight 1)
    total_obj = []
    for t in objective_terms:
        total_obj.append(10 * t)
    for t in rest_penalty_terms:
        total_obj.append(t)
    if total_obj:
        model.minimize(sum(total_obj))

    # ── Solve ─────────────────────────────────────────────────────────────────
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.log_search_progress = False
    solver.parameters.num_search_workers  = 8

    t0     = time.time()
    status = solver.solve(model)
    t1     = time.time()

    status_name = solver.status_name(status)
    elapsed     = t1 - t0

    import sys as _sys
    print(f"Status : {status_name}", file=_sys.stderr)
    print(f"Time   : {elapsed:.2f}s", file=_sys.stderr)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # Extract solution
        schedule = {}
        for p, sec_name, sec in all_staff:
            row = []
            for d in range(n_days):
                idx  = solver.value(shift_var[p][d])
                code = idx_to_code[idx]
                row.append(code)
            schedule[p] = row
        return {
            "status":   status_name,
            "schedule": schedule,
            "elapsed":  round(elapsed, 2),
        }
    else:
        # INFEASIBLE — diagnose
        print("\n❌ INFEASIBLE — diagnosing…")
        diagnose_infeasible(nest_name, year, month, al_schedule, n_days, all_staff)
        return {"status": status_name, "schedule": {}, "elapsed": round(elapsed, 2)}


# ── Infeasibility diagnosis ───────────────────────────────────────────────────

def diagnose_infeasible(nest_name, year, month, al_schedule, n_days, all_staff):
    """Print likely reasons for infeasibility."""
    nest_cfg = NESTS[nest_name]

    for d in range(n_days):
        day   = d + 1
        dtype = day_type(year, month, day)
        for sec_name, sec in nest_cfg["sections"].items():
            coverage = sec["coverage"].get(dtype, {})
            for code, min_count in coverage.items():
                if min_count <= 0:
                    continue
                # Count available staff (not on AL) who can do this shift
                available = 0
                for p, sn, _ in all_staff:
                    if sn != sec_name:
                        continue
                    if p in al_schedule and day in al_schedule[p]:
                        continue
                    if code in sec["allowed_shifts"]:
                        available += 1
                if available < min_count:
                    print(f"  ⚠ Day {day} {sec_name}: needs {min_count}×{code}, "
                          f"only {available} available → INFEASIBLE")


# ── Pretty printing ───────────────────────────────────────────────────────────

def print_schedule(result: dict, nest_name: str, year: int, month: int):
    schedule = result["schedule"]
    if not schedule:
        return

    nest_cfg = NESTS[nest_name]
    n_days   = calendar.monthrange(year, month)[1]

    # Build header
    day_labels = []
    for d in range(1, n_days + 1):
        dow = calendar.weekday(year, month, d)   # 0=Mon
        label = ["Mo","Tu","We","Th","Fr","Sa","Su"][dow]
        day_labels.append(f"{d:2d}")
    dow_labels = []
    for d in range(1, n_days + 1):
        dow = calendar.weekday(year, month, d)
        dow_labels.append(["Mo","Tu","We","Th","Fr","Sa","Su"][dow])

    print(f"\n{'─'*80}")
    print(f"  {nest_name}  {calendar.month_name[month]} {year}")
    print(f"{'─'*80}")

    name_w = 18
    print(f"{'Name':<{name_w}}", " ".join(f"{l:>2}" for l in day_labels))
    print(f"{'': <{name_w}}", " ".join(f"{l:>2}" for l in dow_labels))
    print(f"{'─'*80}")

    for sec_name, sec in nest_cfg["sections"].items():
        print(f"\n  ── {sec_name} ──")
        for p in sec["staff"]:
            if p not in schedule:
                continue
            row   = schedule[p]
            cells = []
            for d, code in enumerate(row):
                dow = calendar.weekday(year, month, d + 1)
                if dow in WEEKEND_DAYS_OF_WEEK:
                    cells.append(f"\033[90m{code:>2}\033[0m")   # grey for weekends
                elif code == "N":
                    cells.append(f"\033[34m{code:>2}\033[0m")   # blue for N
                elif code == "M":
                    cells.append(f"\033[32m{code:>2}\033[0m")   # green for M
                elif code in ("AL", "SL"):
                    cells.append(f"\033[33m{code:>2}\033[0m")   # yellow for leave
                elif code == "O":
                    cells.append(f"\033[90m{code:>2}\033[0m")   # grey for off
                else:
                    cells.append(f"{code:>2}")
            print(f"  {p:<{name_w-2}}", " ".join(cells))

    print(f"\n{'─'*80}")


def print_stats(result: dict, nest_name: str, year: int, month: int):
    schedule = result["schedule"]
    if not schedule:
        return

    nest_cfg = NESTS[nest_name]
    n_days   = calendar.monthrange(year, month)[1]

    print(f"\n  Fairness Summary ({nest_name})")
    print(f"  {'Name':<20} {'M':>4} {'N':>4} {'D':>4} {'O':>4} {'AL':>4} {'Work':>5}")
    print(f"  {'─'*50}")

    for sec_name, sec in nest_cfg["sections"].items():
        print(f"\n  {sec_name}:")
        for p in sec["staff"]:
            if p not in schedule:
                continue
            row = schedule[p]
            counts = {}
            for code in row:
                counts[code] = counts.get(code, 0) + 1
            work = sum(counts.get(c, 0) for c in WORK_SHIFTS)
            print(f"  {p:<20} "
                  f"{counts.get('M',0):>4} "
                  f"{counts.get('N',0):>4} "
                  f"{counts.get('D',0):>4} "
                  f"{counts.get('O',0):>4} "
                  f"{counts.get('AL',0):>4} "
                  f"{work:>5}")


def print_coverage(result: dict, nest_name: str, year: int, month: int):
    """Print daily coverage summary (compact — one line per day)."""
    schedule = result["schedule"]
    if not schedule:
        return

    nest_cfg = NESTS[nest_name]
    n_days   = calendar.monthrange(year, month)[1]

    print(f"\n  Coverage Check ({nest_name})")

    issues = []
    for d in range(n_days):
        day   = d + 1
        dtype = day_type(year, month, day)
        dow   = ["Mo","Tu","We","Th","Fr","Sa","Su"][calendar.weekday(year, month, day)]
        day_issues = []

        for sec_name, sec in nest_cfg["sections"].items():
            coverage = sec["coverage"].get(dtype, {})
            shift_counts = {}
            for p in sec["staff"]:
                if p in schedule:
                    code = schedule[p][d]
                    shift_counts[code] = shift_counts.get(code, 0) + 1

            for code, min_count in coverage.items():
                actual = shift_counts.get(code, 0)
                marker = "✅" if actual >= min_count else "❌"
                if actual < min_count:
                    day_issues.append(
                        f"{sec_name} {code}: need {min_count} got {actual}")

        if day_issues:
            issues.append(f"  Day {day:2d} {dow}: ❌ {', '.join(day_issues)}")

    if issues:
        print(f"  ❌ Coverage gaps found:")
        for line in issues:
            print(line)
    else:
        print(f"  ✅ All coverage requirements met every day")


# ── CLI entry point ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Meena Health Schedule Generator")
    parser.add_argument("--nest",    default="NEST1",
                        choices=list(NESTS.keys()), help="Which nest to schedule")
    parser.add_argument("--year",    type=int, default=2026)
    parser.add_argument("--month",   type=int, default=5)
    parser.add_argument("--al",      nargs="*", default=[],
                        help="AL entries: PERSON:d1,d2 or PERSON:d1-d2")
    parser.add_argument("--timeout", type=int, default=60,
                        help="Solver time limit in seconds")
    parser.add_argument("--json",    action="store_true",
                        help="Output schedule as JSON to stdout")
    args = parser.parse_args()

    al_schedule = parse_al_arg(args.al)

    result = generate_schedule(
        nest_name   = args.nest,
        year        = args.year,
        month       = args.month,
        al_schedule = al_schedule,
        time_limit  = args.timeout,
    )

    if args.json:
        print(json.dumps(result, indent=2))
        return

    print_schedule(result, args.nest, args.year, args.month)
    print_stats(result, args.nest, args.year, args.month)
    print_coverage(result, args.nest, args.year, args.month)

    # Run validator on the result
    if result["schedule"]:
        print(f"\n  Running validator…")
        val = validate_schedule(
            schedule    = result["schedule"],
            nest_name   = args.nest,
            year        = args.year,
            month       = args.month,
            al_schedule = al_schedule,
        )
        print_validation(val)


if __name__ == "__main__":
    main()
