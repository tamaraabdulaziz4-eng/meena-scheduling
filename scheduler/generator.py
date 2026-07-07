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
try:
    from config import TARGET_WEEKEND_OFF
except ImportError:        # older config without the knob
    TARGET_WEEKEND_OFF = 2
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
        if ":" not in item:
            raise ValueError(
                f"--al entry {item!r} must be PERSON:days (e.g. WAFA:1,2 or WAFA:1-3)"
            )
        name, days_str = item.split(":", 1)
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
    import random, math, calendar as _cal, hashlib as _hashlib
    if seed is None:
        # Stable (non-randomized) seed so dominant assignment is reproducible.
        seed = int(_hashlib.sha256(f"{nest_name}:{year}:{month}".encode("utf-8")).hexdigest()[:8], 16)
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
                      time_limit: int = 60,
                      max_consecutive: int = 5,
                      staff_limits: dict = None,
                      section_limits: dict = None,
                      nest_cfg: dict = None,
                      fixed_schedule: dict = None,
                      unavailable: dict = None,
                      pref_off: dict = None,
                      dominant_shifts: dict = None) -> dict:
    # dominant_shifts: accepted for backward-compat with the CLI / older callers.
    # The dominant-shift logic is now derived internally (see the hard domain
    # restriction below), so this argument is ignored — it just prevents a
    # TypeError when a caller still passes it.
    """
    staff_limits: { solver_key: {"min": int, "max": int} } — per-staff shift limits
    max_consecutive: max working days in a row (default 5)
    fixed_schedule: { solver_key: {day(int): code(str)} } — cells the manager set
        by hand and wants kept; the solver pins them and fills the rest.
    unavailable: { solver_key: [day(int), ...] } — staff-stated days they CANNOT
        work; forced Off (hard), ranking below leave and manager pins.
    pref_off: { solver_key: [day(int), ...] } — staff-stated days they'd PREFER
        off; honored as a soft penalty (coverage and safety still win).
    """
    """
    Generate a schedule for the given nest/month using CP-SAT.

    Returns:
        { "status": ..., "schedule": {...}, "elapsed": ... }
    """
    al_schedule     = al_schedule or {}
    prev_tail       = prev_tail   or {}
    staff_limits    = staff_limits or {}
    unavailable     = {k: set(v) for k, v in (unavailable or {}).items()}
    pref_off        = {k: set(v) for k, v in (pref_off or {}).items()}
    section_limits  = section_limits or {}
    # Prefer an explicitly-passed config (avoids mutating the shared NESTS global
    # — two concurrent requests would otherwise read each other's settings).
    nest_cfg        = nest_cfg if nest_cfg is not None else NESTS[nest_name]

    def eff_max_consec(p, sec_name):
        """Strictest max-consecutive among section, per-staff, and branch default.
        A tighter per-staff limit (e.g. 1) must win over a looser section limit."""
        sec_lim = section_limits.get(sec_name, {}) if isinstance(section_limits, dict) else {}
        vals = []
        for v in (sec_lim.get("max_consecutive"),
                  (staff_limits.get(p, {}) or {}).get("max_consecutive"),
                  max_consecutive):
            if v:
                vals.append(int(v))
        return min(vals) if vals else max_consecutive

    # Auto-generate only assigns M and N (plus O/AL/SL)
    # User can manually add other shifts after generation
    AUTO_WORK_SHIFTS = {"M", "N"}

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

    # If a section does not define allowed shifts, allow all known codes.
    # The app now treats shift types as global, so per-section allowed lists
    # are no longer required.
    #
    # Safety: strip any shift codes from nest config that aren't in SHIFTS.
    # This prevents KeyError if the DB has codes not yet in config.py.
    for _, _, sec in all_staff:
        if not sec.get("allowed_shifts"):
            sec["allowed_shifts"] = list(ALL_CODES)
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

    # "Free" sections are those with no explicit daily requirements at all.
    # For such sections, we enforce a per-person minimum work count (HC6b) to
    # prevent the solver from assigning everyone Off when staff min_shifts are 0.
    #
    # Sections with M/N min settings are NOT free (even if nest coverage/exact
    # are empty), because min_m/min_n already enforce daily staffing.
    free_sections = set()
    for sec_name, sec in nest_cfg["sections"].items():
        has_exact = bool(sec.get("exact"))
        cov = sec.get("coverage") or {}
        has_coverage = bool(cov.get("weekday")) or bool(cov.get("weekend"))
        mn_min_m = int(sec.get("min_m", 0) or 0)
        mn_min_n = int(sec.get("min_n", 0) or 0)
        has_mn_daily = (mn_min_m > 0) or (mn_min_n > 0)
        if not has_exact and not has_coverage and not has_mn_daily:
            free_sections.add(sec_name)

    # Codes that the hard coverage/exact constraints (HC1, below) can *require*.
    # Each person's decision-variable domain MUST be able to take these codes,
    # otherwise the coverage constraint is unsatisfiable and the whole nest is
    # INFEASIBLE (e.g. a section requiring "A:1" when the domain is only M/N/O).
    required_codes_by_section = {}
    for sec_name, sec in nest_cfg["sections"].items():
        req = set()
        for _dtype, code_map in (sec.get("coverage") or {}).items():
            if isinstance(code_map, dict):
                for code, cnt in code_map.items():
                    if cnt and int(cnt) > 0:
                        req.add(code)
        for code, cnt in (sec.get("exact") or {}).items():
            if cnt and int(cnt) > 0:
                req.add(code)
        # keep only codes that are real, configured shift types for this section
        allowed = set(sec.get("allowed_shifts") or [])
        required_codes_by_section[sec_name] = {
            c for c in req if c in code_to_idx and (not allowed or c in allowed)
        }

    for p, sec_name, sec in all_staff:
        shift_var[p] = []
        # Auto-generate assigns M, N, or O — plus any code that a hard
        # coverage/exact requirement forces, so those constraints stay solvable.
        auto_allowed = [c for c in sec["allowed_shifts"] if c in AUTO_WORK_SHIFTS]
        for c in required_codes_by_section.get(sec_name, ()):
            if c not in auto_allowed:
                auto_allowed.append(c)
        if not auto_allowed:
            auto_allowed = ["M", "N"]  # fallback if section has no M/N configured
        auto_indices = [code_to_idx[c] for c in auto_allowed] + [o_idx]
        auto_domain  = cp_model.Domain.from_values(auto_indices)
        pinned = (fixed_schedule or {}).get(p, {})

        for d in range(n_days):
            day = d + 1
            if p in al_schedule and day in al_schedule[p]:
                # Force AL on AL days
                v = model.new_int_var(al_idx, al_idx, f"s_{p}_{d}")
            elif day in pinned and pinned[day] in code_to_idx:
                # Manager pinned this cell — fix it and let the solver build around it.
                fi = code_to_idx[pinned[day]]
                v = model.new_int_var(fi, fi, f"s_{p}_{d}")
            elif day in unavailable.get(p, ()):
                # Staff said they can't work this day → forced Off (hard).
                v = model.new_int_var(o_idx, o_idx, f"s_{p}_{d}")
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

    # ── Soft Constraint 0b: Half-month M/N preference ────────────────────────
    # We PREFER each person to stay on a single shift type within each half of
    # the month (all-M or all-N per half) for circadian stability. This used to
    # be a HARD rule, but it is only a comfort preference — not a safety rule —
    # and as a hard constraint it routinely made normal months INFEASIBLE: a
    # 4-person section with a single member on a 1–2 week holiday couldn't bend
    # the rigid M-half/N-half split around the gap, so generation just failed.
    #
    # Now it's soft: we penalise a person working BOTH M and N inside the same
    # half. The solver still produces clean half-month blocks whenever it can,
    # but it will mix when that's the only way to keep the rota feasible. Safety
    # rules (no N→morning, rest after nights, max-consecutive) stay HARD below.
    half = (n_days + 1) // 2
    halfmix_penalties = []
    for p, sec_name, sec in all_staff:
        allowed = set(sec["allowed_shifts"])
        if "M" not in allowed or "N" not in allowed:
            continue
        for lo, hi in ((0, half), (half, n_days)):   # first half, second half
            days = range(lo, hi)
            wm = model.new_bool_var(f"halfM_{p}_{lo}")
            wn = model.new_bool_var(f"halfN_{p}_{lo}")
            m_bools = [get_bool(p, d, "M") for d in days]
            n_bools = [get_bool(p, d, "N") for d in days]
            # wm == (works any M in this half); wn similarly.
            model.add_bool_or(m_bools).only_enforce_if(wm)
            model.add(sum(m_bools) == 0).only_enforce_if(wm.negated())
            model.add_bool_or(n_bools).only_enforce_if(wn)
            model.add(sum(n_bools) == 0).only_enforce_if(wn.negated())
            mix = model.new_bool_var(f"halfmix_{p}_{lo}")   # works both M and N
            model.add_bool_and([wm, wn]).only_enforce_if(mix)
            model.add_bool_or([wm.negated(), wn.negated()]).only_enforce_if(mix.negated())
            halfmix_penalties.append(mix)

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
        # Section/staff max_consecutive (k) for cross-month logic — strictest wins.
        k = eff_max_consec(p, sec_name)

        last_code = tail[-1]   # the very last day of prev month

        # Rule: last day was N → day 1 of this month cannot be a morning shift
        if last_code == "N":
            for mc in MORNING_CODES_SET:
                if mc in allowed:
                    b_m = get_bool(p, 0, mc)
                    model.add(b_m == 0)

        # Rule (mirror of HC4d across the boundary): last day was a Morning (any
        # morning-type code, not just "M") → can't start a Night for two days (no
        # "morning end of last month, night first of this one"). Block N on day 1 & 2.
        if last_code in MORNING_CODES_SET and "N" in allowed:
            model.add(get_bool(p, 0, "N") == 0)
            if n_days >= 2:
                model.add(get_bool(p, 1, "N") == 0)

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

        # Cross-month max-consecutive workdays (counts M/N only).
        # If the previous month ended with t consecutive workdays (t in 1..k),
        # then the first part of this month may not extend that beyond k.
        # Additionally, if the boundary completes a full k-day work block,
        # enforce the 2-off-days rule at the start of the month.
        if k and k > 0:
            # Count ANY trailing work shift (morning variants, night, day, etc.) —
            # not just literal M/N — so a month that ended on a morning-variant run
            # still limits how far the new month can extend the streak.
            REST_CODES = {"O", "AL", "SL", "TB", "OC", "OFF", ""}
            trailing_work = 0
            for code in reversed(tail):
                if code and code not in REST_CODES:
                    trailing_work += 1
                else:
                    break

            if trailing_work > 0:
                # work[d] = 1 iff day d (0-indexed) is M or N
                work = []
                for d in range(n_days):
                    b_m = get_bool(p, d, "M")
                    b_n = get_bool(p, d, "N")
                    w = model.new_bool_var(f"work_{p}_{d}")
                    if p in al_schedule and (d + 1) in al_schedule[p]:
                        # Forced AL day: cannot be work
                        model.add(w == 0)
                    else:
                        model.add(w == b_m + b_n)
                    work.append((d, w))

                # Prevent k+1 consecutive workdays across boundary:
                # among first (k - trailing_work + 1) days, not all can be work.
                need_window = k - trailing_work + 1
                if need_window > 0 and n_days >= need_window:
                    ws = [w for d, w in work if d < need_window]
                    if ws:
                        model.add(sum(ws) <= need_window - 1)

                # If the previous month already ended at/over k consecutive workdays,
                # start this month with 2 off days (unless AL forces otherwise).
                if trailing_work >= k:
                    for d in (0, 1):
                        if d < n_days and not (p in al_schedule and (d + 1) in al_schedule[p]):
                            model.add(get_bool(p, d, "O") == 1)

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
            sec_allowed_codes = set(sec.get("allowed_shifts") or [])
            # The min_m/min_n defaults are the app's auto-M/N staffing model, used
            # only when a section declares no explicit coverage/exact (the server
            # always sends empty coverage and relies on these settings). When a
            # section DOES declare coverage/exact, that dict is its complete daily
            # spec — M/N are opt-in via coverage — so the default min of 1 must not
            # be layered on top. Doing so forced a morning/night shift the section
            # never asked for: it made coverage-only sections that omit M/N
            # INFEASIBLE (e.g. 2 staff owing D+EV can't also staff a 3rd M) and
            # silently over-staffed others with a phantom daily M.
            section_has_explicit_spec = bool(sec.get("coverage")) or bool(sec.get("exact"))
            mn_limits = {
                "M": (int(sec.get("min_m", 1)), int(sec.get("max_m", 2))),
                "N": (int(sec.get("min_n", 1)), int(sec.get("max_n", 2))),
            }
            for code, (mn_min, mn_max) in mn_limits.items():
                if section_has_explicit_spec:
                    continue
                # Only enforce M/N staffing on sections that actually run that
                # shift. Otherwise the code is absent from every person's
                # decision-variable domain (it's pinned to 0), so a default
                # min of 1 becomes 0 >= 1 and makes the whole nest INFEASIBLE.
                if code not in sec_allowed_codes:
                    continue
                # Min coverage is a HARD requirement: if too few staff are
                # available that day (e.g. due to leave) the model is INFEASIBLE
                # and the caller surfaces a clear diagnostic — we never silently
                # ship a day with no morning/night cover.
                if mn_min > 0 and code not in already_covered_codes:
                    model.add(sum(sec_bools(code)) >= mn_min)
                # Max: only cap if section has more staff than the cap, and skip
                # codes already governed by coverage/exact — otherwise the default
                # cap of 2 can contradict a coverage minimum (e.g. weekday M:3).
                if sec_staff_count > mn_max and code not in already_covered_codes:
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

    # ── Hard Constraint 4d: 2 days off before flipping M → N ─────────────────
    # Switching shift type must always include at least two rest days. The N→M
    # direction is already covered (HC4 forbids N→morning, HC4b forces 2 O days
    # after a night block). This is the mirror for M→N: after working a Morning
    # you can't start a Night until two days have passed — so no "morning today,
    # night tomorrow" (or with just a single day off between).
    # Encoding: M today ⇒ no N tomorrow and no N the day after.
    for p, sec_name, sec in all_staff:
        allowed = set(sec["allowed_shifts"])
        if "M" not in allowed or "N" not in allowed:
            continue
        for d in range(n_days - 1):
            b_m = get_bool(p, d, "M")
            model.add(b_m + get_bool(p, d + 1, "N") <= 1)
            if d + 2 < n_days:
                model.add(b_m + get_bool(p, d + 2, "N") <= 1)

    # ── Hard Constraint 4e: No Off touching Annual Leave ─────────────────────
    # Leave must be bounded by working days: a person works the day before their
    # leave starts and the day it ends — you can't glue rest days (O) onto a
    # leave block to stretch the time away. For every leave block, force the day
    # immediately before its start and immediately after its end to be a work
    # shift (not O). Days that fall off the month edge are simply skipped.
    for p, sec_name, sec in all_staff:
        p_al = set(al_schedule.get(p, []))
        if not p_al:
            continue
        allowed = set(sec["allowed_shifts"])
        if "M" not in allowed and "N" not in allowed:
            continue
        for day in p_al:                      # 1-indexed AL day
            # Block start: the prior day isn't AL → it must be worked.
            if (day - 1) not in p_al and (day - 1) >= 1:
                model.add(get_bool(p, day - 2, "O") == 0)
            # Block end: the following day isn't AL → it must be worked.
            if (day + 1) not in p_al and (day + 1) <= n_days:
                model.add(get_bool(p, day, "O") == 0)

    # ── Hard Constraint 5: Max consecutive working shifts (per-staff) ───────────
    # NOTE: counts M/N only. Rest rules do not currently apply to lighter shifts
    # (A/D/EV/B), so a person can be scheduled on many consecutive non-M/N days
    # without triggering this limit. See the project's validator, which counts
    # ALL work shifts — this is a known discrepancy pending a business decision.
    WORK_CODES = list(AUTO_WORK_SHIFTS)  # only M and N
    for p, sec_name, sec in all_staff:
        # Strictest max-consecutive among section / per-staff / branch.
        p_max_c = eff_max_consec(p, sec_name)
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

    # ── Hard Constraint 5a: After a full block, take 2 days off ──────────────
    # For each section, if a person works `k` consecutive days (k=max_consecutive),
    # the next 2 days must be Off (or AL). This encodes the "4 on, 2 off" rule.
    for p, sec_name, sec in all_staff:
        k = eff_max_consec(p, sec_name)
        if k <= 0:
            continue

        p_al = set(al_schedule.get(p, []))
        for start in range(0, n_days - (k + 2) + 1):
            # all_work = AND_{i=0..k-1} work(start+i)
            work_bools = []
            for i in range(k):
                d = start + i
                work_d = [get_bool(p, d, wc) for wc in WORK_CODES]
                w = model.new_bool_var(f"blkwork_{p}_{start}_{i}")
                model.add_bool_or(work_d).only_enforce_if(w)
                model.add(sum(work_d) == 0).only_enforce_if(w.negated())
                work_bools.append(w)
            all_work = model.new_bool_var(f"blkall_{p}_{start}")
            model.add_bool_and(work_bools).only_enforce_if(all_work)
            model.add_bool_or([b.negated() for b in work_bools]).only_enforce_if(all_work.negated())

            # Next two days must be O if not AL
            for j in (k, k + 1):
                d = start + j
                day_num = d + 1
                if day_num in p_al:
                    continue
                b_o = get_bool(p, d, "O")
                model.add(b_o == 1).only_enforce_if(all_work)

    # ── Hard Constraint 5d: Minimum Off (O) block length ─────────────────────
    # If enabled per section (`min_o_block` = L >= 2), scheduled Off days must
    # come in runs of at least L consecutive O's. We enforce this by forbidding
    # every O-run of length 1..L-1. AL/work days have O=0 so they naturally bound
    # a run, and month edges count as boundaries — so edge runs must also be ≥ L.
    for p, sec_name, sec in all_staff:
        L = int((sec.get("min_o_block", 2) or 2))
        if L < 2:
            continue
        o_bool = [get_bool(p, d, "O") for d in range(n_days)]
        for r in range(1, L):                      # forbidden run lengths
            for s in range(0, n_days - r + 1):
                terms = []                          # literals true iff a run of exactly r starts at s
                if s > 0:                           # left boundary: O(s-1) == 0
                    terms.append(o_bool[s - 1].negated())
                for i in range(r):                  # the run itself: O(s..s+r-1) == 1
                    terms.append(o_bool[s + i])
                if s + r < n_days:                  # right boundary: O(s+r) == 0
                    terms.append(o_bool[s + r].negated())
                # Forbid that exact pattern.
                model.add_bool_or([t.negated() for t in terms])

    # ── Hard Constraint 5e: Maximum Off (O) block length ─────────────────────
    # If enabled per section (`max_o_block` = U >= 1), no run of scheduled Off
    # days may exceed U in a row. We forbid every window of U+1 consecutive days
    # from being all-O. AL days carry O=0 here, so a leave block naturally splits
    # an O-run (the cap is about *scheduled* rest, not approved leave).
    for p, sec_name, sec in all_staff:
        U = int((sec.get("max_o_block", 0) or 0))
        if U < 1:
            continue
        o_bool = [get_bool(p, d, "O") for d in range(n_days)]
        win = U + 1
        for s in range(0, n_days - win + 1):
            model.add(sum(o_bool[s:s + win]) <= U)

    # ── Hard Constraint 5b: Per-staff min/max shifts per month ───────────────
    for p, sec_name, sec in all_staff:
        limits = staff_limits.get(p, {})
        min_s  = limits.get("min_shifts", 0)
        # Default is "no cap" (0). A hidden default of 17 silently capped every
        # staffer and contradicted HC6b's ~22-day minimum for free sections,
        # making those sections INFEASIBLE. Overwork is already bounded by the
        # max-consecutive rule (HC5); an explicit max_shifts still applies below.
        max_s  = limits.get("max_shifts", 0)
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

    # ── Hard Constraint 5c: Section must have enough M/N slots ───────────────
    # If staff have per-month minimums, the section must schedule enough M+N
    # assignments (within per-day min/max ranges) to satisfy them.
    for sec_name, sec in nest_cfg["sections"].items():
        sec_staff = [p for p, sn, _ in all_staff if sn == sec_name]
        if not sec_staff:
            continue
        required_total = sum(int((staff_limits.get(p, {}) or {}).get("min_shifts", 0) or 0) for p in sec_staff)
        if required_total <= 0:
            continue

        total_mn = []
        for d in range(n_days):
            for code in ("M", "N"):
                if code in (sec.get("allowed_shifts") or []):
                    for p in sec_staff:
                        total_mn.append(get_bool(p, d, code))
        if total_mn:
            model.add(sum(total_mn) >= required_total)

    # HC5c removed — max consecutive (HC5) already prevents overwork;
    # forced rest days on top caused excessive O chains.

    # HC6 removed: with exact M=1 and exact N=1 both enforced by HC1, daily
    # coverage is already guaranteed. Adding dominant-group balance constraints
    # on top of exact coverage pins M-shifts exclusively to M-dominant staff,
    # which combined with max_shifts caps causes infeasibility when the M-dominant
    # group is small (e.g. 2 staff × max 15 = 30 < 31 required M-days).

    WORK_CODES_SET = set(c for c in ALL_CODES if c in WORK_SHIFTS)

    # ── HC6b: Minimum total work days for free sections ───────────────────────
    # Free sections have no daily requirements, so we enforce a per-person
    # minimum work count (~5/7 of available days) to prevent everyone being O
    # when staff min_shifts are 0.
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
            lim = staff_limits.get(p, {}) or {}
            max_s = int(lim.get("max_shifts", 0) or 0)
            min_s = int(lim.get("min_shifts", 0) or 0)
            # If explicit min/max exist, HC5b already handles it.
            if min_s > 0 or max_s > 0:
                continue
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
    # Count weekend (Friday) O per person — balance them evenly AND aim to give
    # everyone TARGET_WEEKEND_OFF Fridays off when coverage allows.
    wknd_days = [d for d in range(n_days) if is_weekend(year, month, d + 1)]
    weekend_short_terms = []
    for sec_name, sec in nest_cfg["sections"].items():
        sec_staff = [p for p, sn, _ in all_staff if sn == sec_name]
        weekend_rest_counts = []
        for p in sec_staff:
            if not wknd_days:
                continue
            cnt = model.new_int_var(0, len(wknd_days),
                                    f"wknd_rest_{p}")
            model.add(cnt == sum(get_bool(p, d, "O") for d in wknd_days))
            weekend_rest_counts.append(cnt)

            # Shortfall below the target (e.g. 2): penalize so the solver hands
            # out a second Friday off whenever it can, not just one.
            target = min(TARGET_WEEKEND_OFF, len(wknd_days))
            if target > 0:
                short = model.new_int_var(0, target, f"wknd_short_{p}")
                model.add(short >= target - cnt)
                weekend_short_terms.append(short)

        if len(weekend_rest_counts) >= 2:
            max_wknd = model.new_int_var(0, n_days, f"max_wknd_{sec_name}")
            min_wknd = model.new_int_var(0, n_days, f"min_wknd_{sec_name}")
            model.add_max_equality(max_wknd, weekend_rest_counts)
            model.add_min_equality(min_wknd, weekend_rest_counts)
            wknd_spread = model.new_int_var(0, n_days,
                                            f"wknd_spread_{sec_name}")
            model.add(wknd_spread == max_wknd - min_wknd)
            objective_terms.append(wknd_spread)

    # ── Soft Constraint: staff "prefer off" day requests ─────────────────────
    # A staff member can flag days they'd rather not work. We penalise working on
    # those days so the solver hands them the day off whenever coverage allows.
    # Days that are already AL / pinned / unavailable are skipped (handled above).
    pref_off_penalties = []
    for p, sec_name, sec in all_staff:
        for day in sorted(pref_off.get(p, ())):
            d = day - 1
            if d < 0 or d >= n_days:
                continue
            if p in al_schedule and day in al_schedule[p]:
                continue
            if day in (fixed_schedule or {}).get(p, {}):
                continue
            if day in unavailable.get(p, ()):
                continue
            # works = not Off on that day → 1 when the preference is violated.
            pref_off_penalties.append(get_bool(p, d, "O").negated())

    # ── Objective ─────────────────────────────────────────────────────────────
    # Weights: M-block rest violations (500) > staff prefer-off requests (150) >
    #          half-month single-type preference (120) > Friday-off target (110)
    #          > fairness spread (100).
    # A staff member's explicit prefer-off request sits just above the comfort
    # and fairness niceties so it is generally honored, but stays well below the
    # hard safety rules and never overrides coverage (which is a hard constraint).
    total_obj  = [500 * t for t in rest_violation_terms]
    total_obj += [150 * t for t in pref_off_penalties]
    total_obj += [120 * t for t in halfmix_penalties]
    total_obj += [110 * t for t in weekend_short_terms]
    total_obj += [100 * t for t in objective_terms]

    if total_obj:
        model.minimize(sum(total_obj))

    # ── Solve ─────────────────────────────────────────────────────────────────
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.log_search_progress = False
    # 4 (not 8) search workers: with 2 gunicorn workers, two concurrent generates
    # at 8 threads each would oversubscribe a small instance's CPU and stall every
    # other request. 4 keeps the solver fast while leaving headroom.
    solver.parameters.num_search_workers  = 4

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
        # INFEASIBLE — diagnose (all output to stderr so JSON stdout stays clean)
        print("\n❌ INFEASIBLE — diagnosing…", file=sys.stderr)
        diagnose_infeasible(nest_name, year, month, al_schedule, n_days, all_staff)
        return {"status": status_name, "schedule": {}, "elapsed": round(elapsed, 2)}


# ── Infeasibility diagnosis ───────────────────────────────────────────────────

def diagnose_infeasible(nest_name, year, month, al_schedule, n_days, all_staff):
    """Print likely reasons for infeasibility (all output to stderr)."""
    nest_cfg = NESTS.get(nest_name)
    if nest_cfg is None:
        # DB-only branches (e.g. "BRANCH_5") aren't in the static NESTS map. The
        # server runs its own per-section diagnostics, so just skip the legacy
        # stderr probe instead of raising a KeyError (which would 500 the request).
        print(f"  (no static config for {nest_name}; skipping legacy diagnosis)", file=sys.stderr)
        return

    for d in range(n_days):
        day   = d + 1
        dtype = day_type(year, month, day)
        for sec_name, sec in nest_cfg["sections"].items():
            coverage = (sec.get("coverage") or {}).get(dtype, {})
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

    # Monthly capacity check: even when every single day has enough staff, a
    # section can still be infeasible if total coverage demand over the month
    # exceeds what the staff can supply once mandatory rest is subtracted (max
    # ~5 work-days in any 6-day window → each person works at most ~5/6 of days).
    MAX_CONSEC = 5
    for sec_name, sec in nest_cfg["sections"].items():
        cov = sec.get("coverage") or {}
        # Total staffed-days demanded across the whole month.
        demand = 0
        for d in range(n_days):
            dtype = day_type(year, month, d + 1)
            demand += sum(max(0, int(c)) for c in (cov.get(dtype) or {}).values())
        if demand <= 0:
            continue
        # Supply: for each staffer, available days (minus AL) capped by the rest rule.
        supply = 0
        for p, sn, _ in all_staff:
            if sn != sec_name:
                continue
            al_days = len(al_schedule.get(p, []))
            avail = max(0, n_days - al_days)
            supply += avail - (avail // (MAX_CONSEC + 1))  # subtract forced rest days
        if demand > supply:
            print(f"  ⚠ {sec_name}: needs {demand} staffed-days this month but "
                  f"{len([1 for _, sn, _ in all_staff if sn == sec_name])} staff can "
                  f"supply at most ~{supply} after mandatory rest → INFEASIBLE. "
                  f"Add staff or reduce daily coverage.", file=sys.stderr)


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
