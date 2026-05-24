# Meena Health Radiology — Schedule Generator

CP-SAT constraint solver for generating monthly shift rotas.

## Setup

```bash
pip install ortools
```

## Usage

```bash
# Generate NEST1 schedule for May 2026
python generator.py --nest NEST1 --year 2026 --month 5

# With annual leave
python generator.py --nest NEST1 --year 2026 --month 5 --al "MUHANNED:5-25"

# Multiple people, ranges and individual days
python generator.py --nest NEST2 --year 2026 --month 6 --al "PERSON1:1-7" "PERSON2:15,16,17"

# JSON output (for API integration)
python generator.py --nest NEST1 --year 2026 --month 5 --json

# Longer time limit for harder nests
python generator.py --nest NEST6 --year 2026 --month 5 --timeout 120
```

## Hard Constraints

1. **Coverage** — every day meets minimum staffing per shift type per section
2. **One shift per person per day**
3. **AL days are locked** — pre-specified leave days get `AL`, no other shift
4. **No N → morning** — Night shift must be followed by O or N, never M/D/A/EV/B
5. **Max 5 consecutive work days** — at least 1 `O` in any 6-day window
6. **Allowed shifts only** — each section has its own allowed shift list

## Soft Constraints (optimised)

- Equal M distribution across staff in same section (weight: 10×)
- Equal N distribution across staff in same section (weight: 10×)
- Weekend rest fairness (weight: 10×)
- Maximise O (rest) days — encourages ~2 off/week (weight: 1×)

## Files

| File | Purpose |
|------|---------|
| `config.py` | All nest/section/staff/shift definitions |
| `generator.py` | CP-SAT solver + CLI entry point |
| `validator.py` | Standalone validation — call after generation or manual edit |

## Supported Nests

- `NEST1` — General (6 staff: D/M/N) + US (5 staff: M/N)
- `NEST2` — General (7 staff: M/N/D1/Y3) + US (4 staff: D/M/N/D_US)
- `NEST3` — General (5 staff: M/N/A) + US (4 staff: D/M/N/EV/D1)
- `NEST4` — General (2 staff: D/EV) + US (4 staff: M/N/B)
- `NEST6` — General (8 staff: D/M/N) + US (5 staff: A/B/C/M/N/D/EV)
- `Y5`    — General (1 staff: A)

## Output Format

```json
{
  "status": "OPTIMAL",
  "elapsed": 0.65,
  "schedule": {
    "WAFA":   ["M", "O", "N", "O", "M", ...],
    "CHERYL": ["N", "O", "O", "M", "N", ...]
  }
}
```

## Shift Codes

| Code | Hours | Description |
|------|-------|-------------|
| `M`  | 08:00–20:00 | Morning (12h) |
| `N`  | 20:00–08:00 | Night (12h) |
| `D`  | 08:00–17:00 | Day (9h) |
| `D1` | 08:00–17:30 | Day extended |
| `EV` | 14:00–22:00 | Evening (8h) |
| `A`  | 08:00–16:00 | Morning (8h) |
| `B`  | 15:00–23:00 | Afternoon (8h) |
| `C`  | 00:00–08:00 | Night short (8h) |
| `Y3` | 09:00–21:00 | Long day (12h) |
| `O`  | —           | Off / Rest |
| `AL` | —           | Annual Leave |
| `SL` | —           | Sick Leave (manual only) |
| `OC` | —           | On Call |
