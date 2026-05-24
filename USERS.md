# Meena Health Scheduling — User Accounts

## Access Levels

| Role | Description |
|---|---|
| `superadmin` | Full access — all branches, user management, nest config |
| `admin` (no branch) | All branches — can generate, edit, review schedules |
| `admin` (branch-locked) | Own branch only — cannot access or generate other nests |

---

## Accounts

### Management

| Name | Username | Password | Role | Access |
|---|---|---|---|---|
| Khalid Alanazi (Manager) | `khalid` | `khalid1234` | superadmin | All branches |
| Mohammed Batt (Supervisor) | `mbatt` | `mbatt1234` | admin | All branches |
| System Admin | `admin` | `admin123` | superadmin | All branches |

### Team Leaders (Branch-Locked)

| Name | Username | Password | Branch |
|---|---|---|---|
| Wafa Assiri | `wafa` | `wafa1234` | NEST 1 |
| Hajer AL Mutiri | `hajer` | `hajer1234` | NEST 2 |
| Abdulaziz Alanazi | `abdulaziz` | `abdulaziz1234` | NEST 3 |
| Sara Halawani | `sara` | `sara1234` | NEST 4 |
| Mohammed | `mohammed` | `mohammed1234` | NEST 6 |
| Manal Salem | `manal` | `manal1234` | Al-Jubail (Y5) |

---

## What Each Role Can Do

| Feature | Team Leader | Supervisor (mbatt) | Manager (khalid) |
|---|---|---|---|
| View own branch schedule | ✅ | ✅ | ✅ |
| View all branches | ❌ | ✅ | ✅ |
| Generate schedule | ✅ (own branch) | ✅ | ✅ |
| Edit cells | ✅ (own branch) | ✅ | ✅ |
| Lock/Unlock schedule | ✅ | ✅ | ✅ |
| Submit for review | ✅ | ✅ | ✅ |
| Manage staff | ✅ (own branch) | ✅ | ✅ |
| Manage leaves | ✅ (own branch) | ✅ | ✅ |
| Manage users | ❌ | ❌ | ✅ |
| Nest Config | ❌ | ❌ | ✅ |
| Audit Log | ❌ | ❌ | ✅ |

---

## Notes

- Passwords should be changed after first login (via Users page in admin panel)
- Team leaders are blocked at the API level — they cannot generate or edit another branch even if they know the URL
- `superadmin` role bypasses all branch restrictions
