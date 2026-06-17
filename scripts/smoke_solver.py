"""Solver-correctness checks for the report's confirmed bugs C-08, C-09, H-13.
Runs the real OR-Tools solver on tiny synthetic nests."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scheduler"))
import generator as G

PASS = FAIL = 0
def check(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  PASS {name}")
    else:    FAIL += 1; print(f"  FAIL {name}  {extra}")

def nest(staff, **secopts):
    sec = {"staff": staff, "allowed_shifts": ["M", "N", "O", "AL"],
           "coverage": {}, "exact": {}, "min_m": 0, "min_n": 0, "min_o_block": 2}
    sec.update(secopts)
    return {"sections": {"General": dict(sec)}}

def longest_run(codes, pred):
    best = cur = 0
    for c in codes:
        cur = cur + 1 if pred(c) else 0
        best = max(best, cur)
    return best

YEAR, MONTH = 2026, 9  # 30 days

print("== C-08: min coverage that can't be met → INFEASIBLE (not silent) ==")
G.NESTS["T8"] = nest(["P1"], min_m=2)   # 1 person can never give 2 morning
r8 = G.generate_schedule("T8", YEAR, MONTH,
        staff_limits={"P1": {"min_shifts": 0, "max_shifts": 31, "max_consecutive": 4}},
        section_limits={"General": {}}, time_limit=10)
check("understaffed min coverage is INFEASIBLE", r8["status"] == "INFEASIBLE", r8["status"])

print("== C-09: per-staff max_consecutive=1 beats section=4 ==")
G.NESTS["T9"] = nest(["A", "B", "C", "D"], min_m=0, min_n=0)
sl = {p: {"min_shifts": 8, "max_shifts": 20, "max_consecutive": 1} for p in ["A","B","C","D"]}
r9 = G.generate_schedule("T9", YEAR, MONTH, staff_limits=sl,
        section_limits={"General": {"max_consecutive": 4}}, time_limit=20)
check("C-09 produced a schedule", r9["status"] in ("OPTIMAL", "FEASIBLE"), r9["status"])
if r9["schedule"]:
    worst = max(longest_run(codes, lambda c: c in ("M", "N")) for codes in r9["schedule"].values())
    check("no staff works more than 1 consecutive day", worst <= 1, f"worst run={worst}")

print("== H-13: min_o_block=3 → every Off run ≥ 3 ==")
G.NESTS["T13"] = nest(["P1"], min_m=0, min_n=0, min_o_block=3)
r13 = G.generate_schedule("T13", YEAR, MONTH,
        staff_limits={"P1": {"min_shifts": 9, "max_shifts": 18, "max_consecutive": 4}},
        section_limits={"General": {}}, time_limit=20)
check("H-13 produced a schedule", r13["status"] in ("OPTIMAL", "FEASIBLE"), r13["status"])
if r13["schedule"]:
    codes = r13["schedule"]["P1"]
    # find every maximal O-run length
    runs, cur = [], 0
    for c in codes:
        if c == "O": cur += 1
        else:
            if cur: runs.append(cur)
            cur = 0
    if cur: runs.append(cur)
    check("no Off run shorter than 3", all(r >= 3 for r in runs), f"runs={runs}")
    # sanity: default min_o_block=2 still allows 2-blocks (regression guard)

print("== H-13 regression: default min_o_block=2 still allows 2-blocks ==")
G.NESTS["T2"] = nest(["P1"], min_m=0, min_n=0, min_o_block=2)
r2 = G.generate_schedule("T2", YEAR, MONTH,
        staff_limits={"P1": {"min_shifts": 15, "max_shifts": 15, "max_consecutive": 4}},
        section_limits={"General": {}}, time_limit=20)
check("default block schedule feasible", r2["status"] in ("OPTIMAL", "FEASIBLE"), r2["status"])
if r2["schedule"]:
    runs, cur = [], 0
    for c in r2["schedule"]["P1"]:
        if c == "O": cur += 1
        else:
            if cur: runs.append(cur); cur = 0
    if cur: runs.append(cur)
    check("no isolated Off (all runs ≥ 2)", all(r >= 2 for r in runs), f"runs={runs}")

print(f"\n=== SOLVER RESULT: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
