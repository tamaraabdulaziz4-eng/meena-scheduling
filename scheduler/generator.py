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

from config import SHIFTS, WORK_SHIFTS, REST_SHIFTS, WEEKEND_DAYS_OF_WEEK, NESTS as _NESTS_DEFAULT
from validator import validate_schedule, print_validation

# _NESTS will be set to a merged dict at startup (default from config.py,
# overridden by --config arg from DB at runtime).
NESTS = _NESTS_DEFAULT


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


# ── Smart random dominant shift assignment ────────────────────────────────────

def assign_dominant_shifts(nest_name: str, year: int = 2026, month: int = 6,
                           seed: int = None) -> dict:
    """
    Randomly assign one dominant shift per person per section.

    Because dominant is a HARD domain restriction (person can only work their
    dominant shift or O), the number of people assigned each dominant code must
    be carefully sized so every person achieves ~target_work_days/month.

    Target work days per person ≈ n_days × 5/7  (5-day Islamic work week).

    For a shift S required at k per day:
      - Total S-shifts available in the month = n_days × k
      - Max dominant-S people = floor(n_days × k / target_work_days)
        = floor(k × 7/5)  (independent of n_days)
      - For k=1 (exact N=1): max = floor(7/5) = 1... but that means only 1
        N-dominant person per section, which is too fragile (if they're on AL
        or rest, N can't be covered). So we use ceil(k × 7/5) = ceil(1.4) = 2.
      - For k=2: ceil(2 × 7/5) = ceil(2.8) = 3.

    Minimum dominant count (for feasibility on any day):
      Each person rests ~2/7 days. With `m` dominant-S people,
      expected available on any day = m × 5/7. Must be ≥ k.
      So m_min = ceil(k × 7/5).

    Since max = ceil(k × 7/5) = m_min, the count is exactly that number.
    Remaining staff are assigned other required shift codes (or M by default).

    Returns: { person_name: dominant_shift_code, ... }
    """
    import random, math, calendar as _cal
    rng = random.Random(seed)

    n_days   = _cal.monthrange(year, month)[1]
    nest_cfg = NESTS[nest_name]
    dominant = {}

    for sec_name, sec in nest_cfg["sections"].items():
        staff    = sec["staff"][:]
        n_staff  = len(staff)
        coverage = sec.get("coverage") or {}
        exact    = sec.get("exact") or {}

        weekday_cov = coverage.get("weekday", {})
        weekend_cov = coverage.get("weekend", {})

        # Raw coverage requirement per shift code (max of weekday/weekend)
        raw_required = {}
        for code, cnt in {**weekend_cov, **weekday_cov}.items():
            raw_required[code] = max(raw_required.get(code, 0), cnt)
        for code, cnt in exact.items():
            raw_required[code] = max(raw_required.get(code, 0), cnt)

        # Work shifts allowed in this section
        work_shifts = [c for c in sec["allowed_shifts"]
                       if c not in ("O", "AL", "SL", "OC")]

        # Separate exact-constrained codes from minimum-coverage codes.
        # - Exact codes (e.g. N=1): hard ceiling on slots per day.
        #   Total available = n_days × k.  Assign floor(n_days×k / target_w_5_7)
        #   people as dominant, but at least ceil(k×7/5) for feasibility.
        # - Min-coverage codes (e.g. M≥1): no ceiling on slots.
        #   People can work M every working day freely.
        #   Assign the remaining staff (after exact-dominant assignments) to M.
        exact_codes = set(exact.keys())
        target_w_5_7 = n_days * 5 / 7      # ideal work-days per person

        slot_budget = {}   # code → number of dominant people to assign

        # Weekday-only coverage (not required on weekends) — use weekday count
        weekday_only = {c for c in weekday_cov if c not in weekend_cov}

        for code, k in raw_required.items():
            if code not in work_shifts:
                continue
            if code in exact_codes:
                # With hard 2-O-after-N, each N-dominant person works ~4/6 days
                # (4 consecutive N + 2 forced O). Need ceil(k / (4/6)) = ceil(k*6/4)
                # = ceil(k*1.5) people to guarantee N is covered every day.
                # For k=1: ceil(1.5) = 2, but use 3 for safety margin.
                # For k=2: ceil(3) = 3.
                min_dom = max(math.ceil(k * 1.5) + 1, math.ceil(k * 7 / 5))
                max_dom = max(min_dom, int(n_days * k / target_w_5_7))
                slot_budget[code] = max(min_dom, min(max_dom, n_staff))
            # Min-coverage codes get no pre-budget — remaining staff fill them freely

        # Sort: exact codes first, then min-coverage, M last (M absorbs remainder)
        # so M-dominant people are the residual after all other shifts are covered.
        def budget_priority(c):
            if c in exact_codes: return 0
            if c == 'M': return 2
            return 1

        pool = staff[:]
        rng.shuffle(pool)
        assigned = {}

        # Assign budgeted shifts first (exact + capped min-coverage like D)
        for code in sorted(slot_budget, key=budget_priority):
            if code == 'M':
                continue   # M gets the remainder — skip for now
            needed  = slot_budget[code]
            already = sum(1 for v in assigned.values() if v == code)
            for _ in range(needed - already):
                if not pool:
                    break
                p = pool.pop(0)
                assigned[p] = code

        # Remaining staff → M (or fallback to any non-exact work shift)
        fallback_shifts = [c for c in work_shifts if c not in exact_codes] or work_shifts
        for p in pool:
            assigned[p] = 'M' if 'M' in fallback_shifts else fallback_shifts[0]

        dominant.update(assigned)

    return dominant


# ── Main solver ───────────────────────────────────────────────────────────────

def generate_schedule(nest_name: str, year: int, month: int,
                      al_schedule: dict = None, prev_tail: dict = None,
                      dominant_shifts: dict = None,
                      time_limit: int = 60,
                      max_consecutive: int = 4,
                      staff_limits: dict = None) -> dict:
    """
    staff_limits: { solver_key: {"min": int, "max": int} } — per-staff shift limits
    max_consecutive: max working days in a row (default 5)
    """
    """
    Generate a schedule for the given nest/month using CP-SAT.

    dominant_shifts: { person: shift_code } — preferred shift for each person
                     this month. Solver strongly prefers assigning this shift.
                     If None, assign_dominant_shifts() is called automatically.

    Returns:
        { "status": ..., "schedule": {...}, "dominant": {...} }
    """
    al_schedule     = al_schedule or {}
    prev_tail       = prev_tail   or {}
    staff_limits    = staff_limits or {}
    nest_cfg        = NESTS[nest_name]

    # Auto-generate only assigns M and N (plus O/AL/SL)
    # User can manually add other shifts after generation
    AUTO_WORK_SHIFTS = {"M", "N"}

    # Auto-assign dominant shifts if not provided, or fill in gaps for partial overrides
    import math as _math
    user_overrides = set(dominant_shifts.keys()) if dominant_shifts else set()

    if dominant_shifts is None:
        dominant_shifts = assign_dominant_shifts(nest_name, year, month)
    else:
        # Fill in any staff not covered by the override with auto-assignment.
        auto = assign_dominant_shifts(nest_name, year, month)
        for sec_name, sec in nest_cfg["sections"].items():
            for p in sec["staff"]:
                if p not in dominant_shifts:
                    dominant_shifts[p] = auto.get(p, "M")

        # Ensure minimum N-dominant count per section (for exact N coverage).
        # Only reassign non-user-pinned staff (those not in user_overrides).
        for sec_name, sec in nest_cfg["sections"].items():
            exact = sec.get("exact") or {}
            for code, k in exact.items():
                min_needed = _math.ceil(k * 7 / 5)  # e.g. N=1 → need 2
                sec_staff   = sec["staff"]
                n_dom_count = sum(1 for p in sec_staff if dominant_shifts.get(p) == code)
                if n_dom_count < min_needed:
                    # Reassign non-pinned M-dominant staff to this code
                    candidates = [p for p in sec_staff
                                  if dominant_shifts.get(p) == "M"
                                  and p not in user_overrides]
                    for p in candidates[:min_needed - n_dom_count]:
                        dominant_shifts[p] = code
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

    # Safety: strip any shift codes from nest config that aren't in SHIFTS.
    # This prevents KeyError if the DB has codes (e.g. TB) not yet in config.py.
    for _, _, sec in all_staff:
        sec["allowed_shifts"] = [c for c in sec.get("allowed_shifts", []) if c in code_to_idx]

    import sys as _sys
    print(f"\n{'='*60}", file=_sys.stderr)
    print(f"  Generating {nest_name} — {calendar.month_name[month]} {year}", file=_sys.stderr)
    print(f"  {n_days} days | {len(all_staff)} staff", file=_sys.stderr)
    print(f"  AL: { {k: v for k,v in al_schedule.items()} or 'none' }", file=_sys.stderr)
    print(f"{'='*60}\n", file=_sys.stderr)

    model = cp_model.CpModel()

    # ── Decision variables ────────────────────────────────────────────────────
    # shift_var[p][d] = integer index into ALL_CODES
    #
    # DOMINANT SHIFT HARD DOMAIN RESTRICTION:
    #   On non-AL days, each person may only be assigned:
    #     - their dominant shift (the one shift they "own" this month), OR
    #     - O (off/rest)
    #   This means WAFA with dominant=D can never appear as M or N — the solver
    #   simply cannot assign those codes to her variable.
    #   AL days are still forced to AL as before.
    #   SL is never auto-assigned (manual override only).
    #
    # This turns dominant from a soft preference into the actual shift structure.
    shift_var = {}
    al_idx = code_to_idx["AL"]
    o_idx  = code_to_idx["O"]

    # Sections with no exact constraints use free scheduling (no dominant lock)
    free_sections = {
        sec_name for sec_name, sec in nest_cfg["sections"].items()
        if not sec.get("exact")
    }

    for p, sec_name, sec in all_staff:
        shift_var[p] = []
        # Auto-generate only assigns M, N, or O — user adds other shifts manually
        auto_allowed = [c for c in sec["allowed_shifts"] if c in AUTO_WORK_SHIFTS]
        if not auto_allowed:
            auto_allowed = ["M", "N"]  # fallback if section has no M/N configured
        auto_indices = [code_to_idx[c] for c in auto_allowed] + [o_idx]
        auto_domain  = cp_model.Domain.from_values(auto_indices)

        for d in range(n_days):
            day = d + 1
            if p in al_schedule and day in al_schedule[p]:
                # Force AL on AL days
                v = model.new_int_var(al_idx, al_idx, f"s_{p}_{d}")
            else:
                v = model.new_int_var_from_domain(auto_domain, f"s_{p}_{d}")
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

    # ── Hard Constraint 0: Cross-month boundary ──────────────────────────────
    # Apply rest-day rules across the month boundary using prev_tail.
    # prev_tail[person] = list of shift codes for last 1-3 days of prev month.
    # We treat these as "virtual days -2, -1, 0" before day 1.
    #
    # Rules carried over:
    #   - If prev month ended with N → day 1 cannot be a morning shift
    #     AND if day 1 is O → day 2 must also be O
    #   - If prev month ended with D → same 2-O rule
    #   - If prev month ended with M×3+ → if day 1 is O → day 2 must also be O

    MORNING_CODES_SET = {"M", "D", "D1", "A", "EV", "B", "Y3", "D_US"}

    for p, sec_name, sec in all_staff:
        tail = prev_tail.get(p, [])
        if not tail:
            continue
        allowed = set(sec["allowed_shifts"])

        last_code = tail[-1]   # the very last day of prev month

        # Rule: last day was N → day 1 of this month cannot be a morning shift
        if last_code == "N":
            for mc in MORNING_CODES_SET:
                if mc in allowed:
                    b_m = get_bool(p, 0, mc)
                    model.add(b_m == 0)

        # Rule: last was N or D → if day 1 is O, day 2 must also be O
        if last_code in ("N", "D") and n_days >= 2:
            b_o1 = get_bool(p, 0, "O")
            b_o2 = get_bool(p, 1, "O")
            # last=N/D, day1=O → day2 must be O  ⟹  b_o1 <= b_o2
            model.add(b_o1 <= b_o2)

        # Rule: prev month ended with M×3+ → if day 1 is O, day 2 must also be O
        # Count trailing M's in tail
        trailing_m = 0
        for code in reversed(tail):
            if code == "M":
                trailing_m += 1
            else:
                break
        if trailing_m >= 3 and n_days >= 2:
            b_o1 = get_bool(p, 0, "O")
            b_o2 = get_bool(p, 1, "O")
            model.add(b_o1 <= b_o2)

        # Rule: last was N or D but day 1 is NOT O (person works day 1)
        # → this is only valid if the shift is compatible (N→N is ok, not N→M)
        # Already handled by the no-N→morning constraint above for N.
        # For D: D→D is allowed, D→M is allowed (different rest pattern)
        # Actually per the brief: after D block, 2 O's required.
        # But if person works day 1 (not O), that's a continuation, not a rest.
        # The 2-O rule only fires when O appears. So no extra constraint needed here.

    # ── Hard Constraint 1: Coverage ───────────────────────────────────────────
    for d in range(n_days):
        day  = d + 1
        dtype = day_type(year, month, day)
        for sec_name, sec in nest_cfg["sections"].items():
            sec_bools_cache = {}  # code → list of bools for this section/day

            def sec_bools(code):
                if code not in sec_bools_cache:
                    sec_bools_cache[code] = [get_bool(p, d, code)
                                             for p, sn, _ in all_staff if sn == sec_name]
                return sec_bools_cache[code]

            # Minimum coverage from config
            coverage = (sec["coverage"] or {}).get(dtype, {})
            for code, min_count in coverage.items():
                if min_count <= 0:
                    continue
                model.add(sum(sec_bools(code)) >= min_count)

            # Exact coverage (applies every day, weekday and weekend)
            for code, exact_count in (sec.get("exact") or {}).items():
                model.add(sum(sec_bools(code)) == exact_count)

            # Per-section per-month min/max M and N per day (configurable, default min=1 max=2)
            sec_staff_count = sum(1 for p, sn, _ in all_staff if sn == sec_name)
            already_covered_codes = set((sec.get("exact") or {}).keys()) | set(coverage.keys())
            mn_limits = {
                "M": (int(sec.get("min_m", 1)), int(sec.get("max_m", 2))),
                "N": (int(sec.get("min_n", 1)), int(sec.get("max_n", 2))),
            }
            for code, (mn_min, mn_max) in mn_limits.items():
                if sec_staff_count >= mn_min:
                    # Min: only enforce if not already covered by exact/coverage
                    if code not in already_covered_codes:
                        avail = [p for p, sn, _ in all_staff
                                 if sn == sec_name
                                 and not (p in al_schedule and day in al_schedule[p])]
                        if len(avail) >= mn_min:
                            model.add(sum(sec_bools(code)) >= mn_min)
                    # Max: only cap if section has more staff than the cap
                    if sec_staff_count > mn_max:
                        model.add(sum(sec_bools(code)) <= mn_max)

    # ── Hard Constraint 4: No N → morning shift next day ─────────────────────
    MORNING_CODES = ["M", "D", "D1", "A", "EV", "B", "Y3", "D_US"]
    for p, sec_name, sec in all_staff:
        allowed = set(sec["allowed_shifts"])
        morning_in_allowed = [c for c in MORNING_CODES if c in allowed]
        for d in range(n_days - 1):
            b_n = get_bool(p, d, "N")
            for mc in morning_in_allowed:
                b_m = get_bool(p, d + 1, mc)
                model.add(b_n + b_m <= 1)

    # ── Hard Constraint 4b: 2 O days after end of N block ────────────────────
    # N on day D, not-N on D+1 → O on D+1 AND O on D+2
    # Safe as hard because: dominant system ensures each person does at most one
    # N-block per month, and auto-calc ensures enough N-dominant staff are assigned
    # so staggered rest windows never leave N uncovered.
    # Linear encoding: N_today - N_tomorrow - O_d1 <= 0
    rest_violation_terms = []  # kept empty — 4b is now hard, 4c stays soft below
    for p, sec_name, sec in all_staff:
        allowed = set(sec["allowed_shifts"])
        if "N" not in allowed:
            continue
        p_al = set(al_schedule.get(p, []))
        for d in range(n_days - 1):
            day_d1 = d + 2  # 1-indexed
            day_d2 = d + 3
            b_n_today    = get_bool(p, d,     "N")
            b_n_tomorrow = get_bool(p, d + 1, "N")
            # If d+1 is an AL day the person is already off — constraint satisfied
            if day_d1 not in p_al:
                b_o_d1 = get_bool(p, d + 1, "O")
                model.add(b_n_today - b_n_tomorrow - b_o_d1 <= 0)
            if d + 2 < n_days and day_d2 not in p_al:
                b_o_d2 = get_bool(p, d + 2, "O")
                model.add(b_n_today - b_n_tomorrow - b_o_d2 <= 0)

    # ── Soft Constraint 4c: 1 O day after end of M block ─────────────────────
    for p, sec_name, sec in all_staff:
        allowed = set(sec["allowed_shifts"])
        if "M" not in allowed or "N" not in allowed:
            continue
        p_al = set(al_schedule.get(p, []))
        for d in range(n_days - 1):
            day_d1 = d + 2  # 1-indexed
            if day_d1 in p_al:
                continue  # AL day counts as rest — skip
            b_m_today    = get_bool(p, d,     "M")
            b_m_tomorrow = get_bool(p, d + 1, "M")
            b_n_tomorrow = get_bool(p, d + 1, "N")
            b_o_d1       = get_bool(p, d + 1, "O")
            viol = model.new_bool_var(f"mrest_{p}_{d}")
            model.add(b_m_today - b_m_tomorrow - b_n_tomorrow - b_o_d1 <= viol)
            rest_violation_terms.append(viol)

    # ── Hard Constraint 5: Max consecutive working shifts (per-staff) ───────────
    WORK_CODES = list(AUTO_WORK_SHIFTS)  # only M and N
    for p, sec_name, sec in all_staff:
        limits  = staff_limits.get(p, {})
        p_max_c = limits.get("max_consecutive", max_consecutive)  # per-staff, fallback to branch default
        window  = p_max_c + 1
        work_in_allowed = [c for c in WORK_CODES if c in AUTO_WORK_SHIFTS]
        for d in range(n_days - p_max_c):
            day_work = []
            for d2 in range(d, d + window):
                day_w  = model.new_bool_var(f"dw_{p}_{d2}_{d}")
                work_d = [get_bool(p, d2, wc) for wc in work_in_allowed]
                if work_d:
                    model.add_bool_or(work_d).only_enforce_if(day_w)
                    model.add(sum(work_d) == 0).only_enforce_if(day_w.negated())
                else:
                    model.add(day_w == 0)
                day_work.append(day_w)
            model.add(sum(day_work) <= p_max_c)

    # ── Hard Constraint 5b: Per-staff min/max shifts per month ───────────────
    for p, sec_name, sec in all_staff:
        limits = staff_limits.get(p, {})
        min_s  = limits.get("min_shifts", 0)
        max_s  = limits.get("max_shifts", 17)
        # Count total work days (M or N) for this person
        work_days = []
        for d in range(n_days):
            work_d = [get_bool(p, d, wc) for wc in WORK_CODES if wc in (sec["allowed_shifts"] or AUTO_WORK_SHIFTS)]
            if work_d:
                dw = model.new_bool_var(f"ms_{p}_{d}")
                model.add_bool_or(work_d).only_enforce_if(dw)
                model.add(sum(work_d) == 0).only_enforce_if(dw.negated())
                work_days.append(dw)
        if work_days:
            if min_s > 0:
                model.add(sum(work_days) >= min_s)
            if max_s > 0:
                model.add(sum(work_days) <= max_s)

    # HC5c removed — max consecutive (HC5) already prevents overwork;
    # forced rest days on top caused excessive O chains.

    # ── Hard Constraint 6: Per-shift-group daily balance (no mass-O days) ───────
    # With hard domain restriction, each person can only work their dominant shift
    # or be on O.
    #
    # For groups whose shift is already covered by an `exact` constraint (e.g. N),
    # the coverage constraint itself guarantees at least 1 person on that shift
    # every day — no additional balance constraint is needed.
    #
    # For groups whose shift is NOT exact-constrained (e.g. M when only minimum
    # coverage is set), we enforce: at least max(1, n_dom - max_rest_window) must
    # be working on any day, where max_rest_window = 2 (the post-shift O count).
    # This prevents mass-O days while remaining feasible with HC5b.
    #
    # Formula: min_w = max(1, n_dom - 2)
    # i.e. at most 2 people in the group can be on O simultaneously (rest window).

    WORK_CODES_SET = set(c for c in ALL_CODES if c in WORK_SHIFTS)

    # Collect shift codes covered by exact constraints per section
    exact_codes_per_sec = {}
    for sec_name, sec in nest_cfg["sections"].items():
        exact_codes_per_sec[sec_name] = set((sec.get("exact") or {}).keys())

    for sec_name, sec in nest_cfg["sections"].items():
        # Free sections have no dominant lock — HC6 doesn't apply
        if sec_name in free_sections:
            continue

        sec_staff_names = [p for p, sn, _ in all_staff if sn == sec_name]
        exact_here      = exact_codes_per_sec[sec_name]

        # Group staff by their dominant shift
        dom_groups = {}  # shift_code → [person, ...]
        for p in sec_staff_names:
            dom = dominant_shifts.get(p)
            if dom and dom in WORK_CODES_SET:
                dom_groups.setdefault(dom, []).append(p)

        for dom_code, dom_staff in dom_groups.items():
            n_dom = len(dom_staff)
            if n_dom == 0:
                continue

            if dom_code in exact_here:
                # Exact-constrained: coverage constraint already guarantees this
                # shift is covered. No extra balance needed (and adding it would
                # over-constrain since we can't exceed the exact count anyway).
                continue

            # Min-coverage (non-exact): no upper limit on how many can work this
            # shift per day. Force enough people to work to ensure coverage.
            # For large groups: floor(n_dom × 5/7) ensures ~5/7 utilisation.
            # For small groups (≤3): use 1 to avoid over-constraining rest days.
            if n_dom <= 3:
                min_w = 1
            else:
                min_w = max(1, int(n_dom * 5 / 7))

            for d in range(n_days):
                day = d + 1
                avail = [p for p in dom_staff
                         if not (p in al_schedule and day in al_schedule[p])]
                if len(avail) < min_w:
                    continue  # AL-heavy day — skip
                work_bools = [get_bool(p, d, dom_code) for p in avail]
                model.add(sum(work_bools) >= min_w)

    # ── HC6b: Minimum total work days for free sections ───────────────────────
    # Free sections have no dominant lock, so we enforce a per-person minimum
    # work count (~5/7 of days) to prevent the solver from giving everyone O.
    import math as _math2
    for sec_name, sec in nest_cfg["sections"].items():
        if sec_name not in free_sections:
            continue
        sec_staff_names = [p for p, sn, _ in all_staff if sn == sec_name]
        work_codes_here = [c for c in sec["allowed_shifts"]
                           if c not in ("O", "AL", "SL", "OC")]
        if not work_codes_here:
            continue
        for p in sec_staff_names:
            # Count AL days for this person
            al_days = len(al_schedule.get(p, []))
            avail_days = n_days - al_days
            # Target: ~5/7 of available days working
            min_work = max(1, _math2.floor(avail_days * 5 / 7))
            work_bools = []
            for d in range(n_days):
                day = d + 1
                if p in al_schedule and day in al_schedule[p]:
                    continue
                for wc in work_codes_here:
                    work_bools.append(get_bool(p, d, wc))
            if work_bools:
                model.add(sum(work_bools) >= min_work)

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

    # ── Objective ─────────────────────────────────────────────────────────────
    # Weights: M-block rest violations (500) > fairness spread (100)
    total_obj  = [500 * t for t in rest_violation_terms]
    total_obj += [100 * t for t in objective_terms]
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
            "dominant": dominant_shifts,
            "elapsed":  round(elapsed, 2),
        }
    else:
        # INFEASIBLE — diagnose (all output to stderr so JSON stdout stays clean)
        print("\n❌ INFEASIBLE — diagnosing…", file=sys.stderr)
        diagnose_infeasible(nest_name, year, month, al_schedule, n_days, all_staff)
        return {"status": status_name, "schedule": {}, "dominant": dominant_shifts, "elapsed": round(elapsed, 2)}


# ── Infeasibility diagnosis ───────────────────────────────────────────────────

def diagnose_infeasible(nest_name, year, month, al_schedule, n_days, all_staff):
    """Print likely reasons for infeasibility (all output to stderr)."""
    nest_cfg = NESTS[nest_name]

    for d in range(n_days):
        day   = d + 1
        dtype = day_type(year, month, day)
        for sec_name, sec in nest_cfg["sections"].items():
            coverage = (sec["coverage"] or {}).get(dtype, {})
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
                          f"only {available} available → INFEASIBLE", file=sys.stderr)


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
            coverage = (sec["coverage"] or {}).get(dtype, {})
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
    global NESTS

    parser = argparse.ArgumentParser(description="Meena Health Schedule Generator")
    parser.add_argument("--nest",    default="NEST1",
                        help="Which nest to schedule (e.g. NEST1)")
    parser.add_argument("--year",    type=int, default=2026)
    parser.add_argument("--month",   type=int, default=5)
    parser.add_argument("--al",        nargs="*", default=[],
                        help="AL entries: PERSON:d1,d2 or PERSON:d1-d2")
    parser.add_argument("--prev-tail", default=None,
                        help='JSON dict of last 3 days of prev month: {"WAFA":["M","O","N"]}')
    parser.add_argument("--dominant", default=None,
                        help='Override dominant shifts: "WAFA:M,CHERYL:N,MUHANNED:D"')
    parser.add_argument("--config",   default=None,
                        help='JSON string: nest config override from DB. '
                             'Format: {"sections": {"General": {...}, ...}}')
    parser.add_argument("--timeout",   type=int, default=60,
                        help="Solver time limit in seconds")
    parser.add_argument("--json",      action="store_true",
                        help="Output schedule as JSON to stdout")
    args = parser.parse_args()

    # ── Apply --config override ───────────────────────────────────────────────
    if args.config:
        try:
            cfg_override = json.loads(args.config)
            # cfg_override is the nest config dict for this specific nest
            # i.e. { "sections": { "General": {...}, "US": {...} } }
            NESTS = dict(_NESTS_DEFAULT)   # shallow copy
            NESTS[args.nest] = cfg_override
        except Exception as e:
            print(f"[generator] Warning: --config parse error: {e}", file=sys.stderr)

    al_schedule = parse_al_arg(args.al)
    prev_tail   = json.loads(args.prev_tail) if args.prev_tail else {}

    dominant_shifts = None
    if args.dominant:
        dominant_shifts = {}
        for item in args.dominant.split(","):
            item = item.strip()
            if ":" in item:
                k, v = item.split(":", 1)
                dominant_shifts[k.strip().upper()] = v.strip().upper()

    result = generate_schedule(
        nest_name       = args.nest,
        year            = args.year,
        month           = args.month,
        al_schedule     = al_schedule,
        prev_tail       = prev_tail,
        dominant_shifts = dominant_shifts,
        time_limit      = args.timeout,
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
            schedule        = result["schedule"],
            nest_name       = args.nest,
            year            = args.year,
            month           = args.month,
            al_schedule     = al_schedule,
            dominant_shifts = result.get("dominant"),
        )
        print_validation(val)


if __name__ == "__main__":
    main()
