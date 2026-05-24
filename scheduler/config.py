"""
Meena Health Radiology — Schedule Generator Config
All nest/section/staff/shift definitions live here.
"""

# ── Shift definitions ─────────────────────────────────────────────────────────
SHIFTS = {
    "M":    {"start": "08:00", "end": "20:00", "hours": 12},
    "N":    {"start": "20:00", "end": "08:00", "hours": 12},
    "D":    {"start": "08:00", "end": "17:00", "hours":  9},
    "D1":   {"start": "08:00", "end": "17:30", "hours": 9.5},
    "EV":   {"start": "14:00", "end": "22:00", "hours":  8},
    "A":    {"start": "08:00", "end": "16:00", "hours":  8},
    "B":    {"start": "15:00", "end": "23:00", "hours":  8},
    "C":    {"start": "00:00", "end": "08:00", "hours":  8},
    "Y3":   {"start": "09:00", "end": "21:00", "hours": 12},
    "D_US": {"start": "10:00", "end": "22:00", "hours": 12},
    "R":    {"start": "20:00", "end": "02:00", "hours":  6},
    "R1":   {"start": "20:00", "end": "04:00", "hours":  8},
    "O":    {"start": None,    "end": None,    "hours":  0},   # Off
    "AL":   {"start": None,    "end": None,    "hours":  0},   # Annual Leave
    "SL":   {"start": None,    "end": None,    "hours":  0},   # Sick Leave
    "OC":   {"start": None,    "end": None,    "hours":  0},   # On Call
}

# Shifts that count as "working" (not rest/leave)
WORK_SHIFTS = {"M", "N", "D", "D1", "EV", "A", "B", "C", "Y3", "D_US", "R", "R1", "OC"}

# Shifts that count as "off/absent" — person unavailable
REST_SHIFTS = {"O", "AL", "SL"}

# Islamic weekend
WEEKENDS = {4, 5}   # 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu... wait — Fri=4, Sat=5
# Actually: weekday() in Python: Mon=0 ... Sun=6
# We define weekend as Friday=4 and Saturday=5
WEEKEND_DAYS_OF_WEEK = {4, 5}   # Friday, Saturday

# ── Nest definitions ──────────────────────────────────────────────────────────
NESTS = {
    "NEST1": {
        "sections": {
            "General": {
                "staff": ["WAFA", "CHERYL", "MUHANNED", "ELHAM", "AMINAH", "MNAYER"],
                # Maps solver key → exact DB name (for web app integration)
                "staff_db_names": {
                    "WAFA":    "Wafa Assiri",
                    "CHERYL":  "Cheryl",
                    "MUHANNED":"Muhanned",
                    "ELHAM":   "Elham",
                    "AMINAH":  "Aminah",
                    "MNAYER":  "Mnayer",
                },
                "allowed_shifts": ["D", "M", "N", "O", "AL", "SL"],
                "coverage": {
                    "weekday": {"M": 1, "N": 1},
                    "weekend": {"M": 1, "N": 1},
                },
                "exact": {        # exactly this many per day (all days)
                    "N": 1,
                }
            },
            "US": {
                "staff": ["RAWAN", "ALANOOD", "ALNOUD", "TAGREED", "SADEEM"],
                "staff_db_names": {
                    "RAWAN":   "Rawan",
                    "ALANOOD": "Alanood",
                    "ALNOUD":  "Alnoud Alrashdi",
                    "TAGREED": "Tagreed",
                    "SADEEM":  "Sadeem",
                },
                "allowed_shifts": ["M", "N", "O", "AL", "SL"],
                "coverage": {
                    "weekday": {"M": 1, "N": 1},
                    "weekend": {"M": 1, "N": 1},
                },
                "exact": {        # exactly this many per day (all days)
                    "N": 1,
                }
            }
        }
    },
    "NEST2": {
        "sections": {
            "General": {
                "staff": ["BADRIH", "DALAL", "WEDAD", "LAYAN", "FATIN", "NAIF", "MOHAMMED_BATT"],
                "allowed_shifts": ["M", "N", "D1", "Y3", "O", "AL", "SL", "OC"],
                "coverage": {
                    "weekday": {"M": 1, "N": 1},
                    "weekend": {"M": 1, "N": 1},
                }
            },
            "US": {
                "staff": ["ALHANOUF_BIN_AMMAR", "HAJER", "JOY", "ALHANOUF_ALAZMI"],
                "allowed_shifts": ["D", "M", "N", "D_US", "O", "AL", "SL", "OC"],
                "coverage": {
                    "weekday": {"M": 1, "N": 1, "D": 1},
                    "weekend": {"M": 1, "N": 1},
                }
            }
        }
    },
    "NEST3": {
        "sections": {
            "General": {
                "staff": ["DUAA", "RAWAN", "NOURAH", "ABDULAZIZ", "BUSHRA"],
                "allowed_shifts": ["M", "N", "A", "O", "AL", "SL"],
                "coverage": {
                    "weekday": {"M": 1, "N": 1},
                    "weekend": {"M": 1, "N": 1},
                }
            },
            "US": {
                "staff": ["ALMA", "MANAR", "QAMRAA", "REEM"],
                "allowed_shifts": ["D", "M", "N", "EV", "D1", "O", "AL", "SL"],
                "coverage": {
                    "weekday": {"M": 1, "N": 1, "D": 1},
                    "weekend": {"M": 1, "N": 1},
                }
            }
        }
    },
    "NEST4": {
        "sections": {
            "General": {
                "staff": ["SARAH", "AROB"],
                "allowed_shifts": ["D", "EV", "M", "O", "AL", "SL", "OC"],
                "coverage": {
                    "weekday": {"D": 1, "EV": 1},
                    "weekend": {"D": 1, "EV": 1},
                }
            },
            "US": {
                "staff": ["RANA", "AESHAH", "TAIF", "ALAA"],
                "allowed_shifts": ["M", "N", "B", "O", "AL", "SL", "OC"],
                "coverage": {
                    "weekday": {"M": 1, "N": 1},
                    "weekend": {"M": 1, "N": 1},
                }
            }
        }
    },
    "NEST6": {
        "sections": {
            "General": {
                "staff": ["MOHAMMED", "NAIF", "RUBA", "SHAHAD", "WEDAD", "NAIF_ALMUTARI", "LAYAN", "DALAL"],
                "allowed_shifts": ["D", "M", "N", "O", "AL", "SL", "OC"],
                "coverage": {
                    "weekday": {"D": 1, "M": 1, "N": 1},
                    "weekend": {"M": 1, "N": 1},
                }
            },
            "US": {
                "staff": ["RANA", "MEYAN", "ALANOUD", "HAJER", "ALMA"],
                "allowed_shifts": ["A", "B", "C", "M", "N", "D", "EV", "O", "AL", "SL", "OC"],
                "coverage": {
                    "weekday": {"A": 1, "B": 1, "N": 1},
                    "weekend": {"A": 1, "B": 1, "N": 1},
                }
            }
        }
    },
    "Y5": {
        "sections": {
            "General": {
                "staff": ["MANAL"],
                "allowed_shifts": ["A", "O", "OC", "AL", "SL"],
                "coverage": {
                    "weekday": {"A": 1},
                    "weekend": {"A": 1},
                }
            }
        }
    }
}
