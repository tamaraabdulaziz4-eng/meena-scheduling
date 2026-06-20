# Meena Health Scheduling — User Accounts

> ⚠️ **Security note:** This file intentionally contains **no passwords**.
> Credentials are set at deploy time and must never be committed to the repo.
> Rotate any password that was previously published here, and change every
> account's password on first login (Users page → Reset).

## Access Levels

| Role | Description |
|---|---|
| `superadmin` | Full access — all branches, user management, shift types, audit log |
| `manager` | All branches — review/approve schedules and leave |
| `admin` (no branch) | All branches — can generate, edit, review schedules |
| `admin` (branch-locked) | Own branch only — cannot access or generate other nests |
| `staff` | Own schedule + leave/swap/time-back requests |

---

## Accounts

Accounts are provisioned by the system administrator. Usernames follow the
person's first name; **passwords are issued privately and are not listed here.**

### Management
| Name | Username | Role | Access |
|---|---|---|---|
| Khalid Alanazi (Manager) | `khalid` | superadmin | All branches |
| Mohammed Batt (Supervisor) | `mbatt` | admin | All branches |
| System Admin | `admin` | superadmin | All branches |

### Team Leaders (Branch-Locked)
| Name | Username | Branch |
|---|---|---|
| Wafa Assiri | `wafa` | NEST 1 |
| Hajer AL Mutiri | `hajer` | NEST 2 |
| Abdulaziz Alanazi | `abdulaziz` | NEST 3 |
| Sara Halawani | `sara` | NEST 4 |
| Mohammed | `mohammed` | NEST 6 |
| Manal Salem | `manal` | Al-Jubail (Y5) |

---

## What Each Role Can Do

| Feature | Team Leader | Supervisor | Manager | Superadmin |
|---|---|---|---|---|
| View own branch schedule | ✅ | ✅ | ✅ | ✅ |
| View all branches | ❌ | ✅ | ✅ | ✅ |
| Generate schedule | ✅ (own) | ✅ | — | ✅ |
| Edit cells | ✅ (own) | ✅ | ✅ | ✅ |
| Submit for review | ✅ | ✅ | — | ✅ |
| Review / approve / return | ❌ | ❌ | ✅ | ✅ |
| Manage staff | ✅ (own) | ✅ | ✅ | ✅ |
| Manage leaves | ✅ (own) | ✅ | ✅ | ✅ |
| Manage users | ❌ | ❌ | ❌ | ✅ |
| Branches / Shift types | ❌ | ❌ | ❌ | ✅ |
| Audit Log | ❌ | ❌ | ❌ | ✅ |

---

## Notes

- **Change every default password on first login**, and never store passwords in
  the repository or any shared doc.
- Team leaders are blocked at the API level — they cannot generate or edit
  another branch even if they know the URL.
- `superadmin` bypasses all branch restrictions.
