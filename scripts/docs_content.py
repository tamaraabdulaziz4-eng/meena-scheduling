# Content for the Meena PDF docs (English). Imported by build_docs_pdf.py.

# ─────────────────────────── 1) PROJECT OVERVIEW ───────────────────────────
OVERVIEW = [
    ("h1", "1. Overview"),
    ("p", "Meena Radiology Scheduling is a single web platform that runs the whole "
          "scheduling life-cycle for the radiology department across all branches "
          "(NESTS): building the monthly rota, approvals, leave, shift swaps, and "
          "the daily case reports — replacing scattered Excel files and chat groups."),
    ("callout", "Goal: turn scheduling into one organised, secure, fast system with "
                "clear permissions for every role."),

    ("h1", "2. The problem before"),
    ("bullets", [
        "Excel rotas edited by hand — repeated mistakes.",
        "Leave and swap requests lost in chat threads.",
        "No record of who approved what, and when.",
        "Hard to see each branch's daily cases.",
        "Reports built manually, costing time.",
    ]),

    ("h1", "3. The solution — key features"),
    ("table",
     ["Feature", "What it does"],
     [["Auto-generate rota", "A smart engine (OR-Tools) builds the monthly rota respecting shifts, approved leave and limits."],
      ["Clear approval chains", "Schedule: create -> review -> approve -> lock. Leave: staff -> team lead -> manager."],
      ["Leave on the rota", "Approved leave lands on the schedule automatically, with a warning if it leaves a shift uncovered."],
      ["Shift swaps", "Colleague -> team lead -> manager approval, then applied to the rota automatically."],
      ["Daily case reports", "Each branch logs its cases (X-ray/CT/US/...); exported as a branded PDF report."],
      ["Self sign-up", "Role-based invite links (staff / team lead / manager) with approval."],
      ["Notifications + email", "In-app and email alerts on every important step."],
      ["Professional PDFs", "Rota and case reports in Meena's brand, ready to print and archive."]],
     [55, 135]),

    ("h1", "4. Roles & permissions"),
    ("table",
     ["Role", "Can do"],
     [["Super Admin", "Full control: branches, shift types, users, audit log, invite links, data reset."],
      ["Manager", "Reviews & approves schedules, final leave approval, sees all branches."],
      ["Team Lead", "Runs their own branch: build/generate rota, first leave approval, approve their staff sign-ups."],
      ["Staff", "Personal portal: own schedule, request leave, request swaps, fill cases (if eligible)."],
      ["Viewer", "Read-only."]],
     [40, 150]),
    ("callout", "Permissions are branch-scoped: a team lead can't see or edit another branch's data."),

    ("h1", "5. Security"),
    ("bullets", [
        "Passwords hashed (bcrypt); sessions secured with JWT.",
        "Idle auto-logout and safe session expiry.",
        "Audit log of every sensitive action: who did what, when.",
        "Every permission enforced on the server (not just the UI).",
        "240+ automated tests guarding the permissions and flows.",
    ]),

    ("h1", "6. Benefits for management"),
    ("bullets", [
        "Time saved: the rota is built in one click instead of hours.",
        "Governance: every approval is recorded with a name and date.",
        "Live visibility: each branch's cases, the rota and leave in one dashboard.",
        "Ready reports: branded PDF for printing and official archiving.",
        "Works on phone and desktop.",
    ]),

    ("h1", "7. Suggested next steps"),
    ("bullets", [
        "Optional WhatsApp notifications.",
        "Monthly aggregated performance reports.",
        "Historical case-statistics dashboard.",
    ]),
]

# ─────────────────────────── 2) MANAGER GUIDE ───────────────────────────
MANAGER = [
    ("h1", "Welcome, Manager"),
    ("p", "As a manager you are the department reviewer: you give final approval on "
          "schedules and leave, oversee every branch, and keep the daily case reports "
          "on track. This guide walks through your day-to-day flow."),

    ("h1", "1. Signing in"),
    ("steps", [
        "Open the platform link and enter your username and password.",
        "You land on the Home dashboard with a snapshot of what needs you.",
        "Forgot your password? Use 'Forgot password?' on the sign-in screen.",
        "Change your password anytime from the sidebar -> Change password.",
    ]),

    ("h1", "2. Home dashboard"),
    ("p", "The Home page shows KPI cards (today's cases, patients, branches submitted, "
          "pending items) and quick action chips. The numbers are live — click a chip "
          "to jump straight to what needs action."),

    ("h1", "3. Reviewing & approving schedules"),
    ("steps", [
        "Open Review from the sidebar — it lists every branch's schedule for the month.",
        "A schedule submitted by a team lead shows as 'Pending'.",
        "Open it, check the rota, then Approve (locks it as the official rota) or Return it for changes.",
        "You can also fix individual cells directly if needed.",
    ]),
    ("callout", "Tip: the review badge in the sidebar shows how many schedules await you."),

    ("h1", "4. Leave — final approval (stage 2)"),
    ("p", "Leave approval is a two-stage chain. The branch team lead approves first; "
          "the request then arrives to you for the FINAL decision, which is what places "
          "the leave on the rota."),
    ("steps", [
        "Open Leave. Requests waiting on you show as 'Awaiting manager'.",
        "Click Approve to finalise (it lands on the rota) or Reject.",
        "If approving would leave a shift uncovered, you'll get a warning to confirm.",
        "You can also record leave directly — as a manager it's approved immediately.",
    ]),

    ("h1", "5. Shift swaps — final approval"),
    ("p", "A swap goes: colleague accepts -> team lead approves -> manager approves. "
          "Your approval applies the swap to the rota. Open Swaps and act on items "
          "marked 'Awaiting manager'."),

    ("h1", "6. Daily cases"),
    ("steps", [
        "Open Daily Cases to see every branch's numbers for the day.",
        "Use 'Remind pending' to nudge branches that haven't submitted yet.",
        "Need to fix a locked report? Open it and use Reopen (manager only).",
        "Use Print / PDF for the branded 'Radiology Daily Statistics' report.",
    ]),

    ("h1", "7. Reports (PDF)"),
    ("bullets", [
        "Schedule: open a rota and click Print -> a branded landscape roster with a "
        "Prepared by / Approved by signature block.",
        "Daily Cases: Print / PDF -> KPI cards, branch breakdown, modality mix and key notes.",
        "Both export as PDF (use your browser's 'Save as PDF').",
    ]),

    ("h1", "8. Staff & registrations"),
    ("p", "You can view and manage staff across branches, and approve staff self-"
          "registrations. (Creating branches, shift types, user accounts and the invite "
          "links are handled by the Super Admin / owner.)"),
]

# ─────────────────────────── 3) TEAM LEAD GUIDE ───────────────────────────
TEAMLEAD = [
    ("h1", "Welcome, Team Lead"),
    ("p", "You run the scheduling for YOUR branch: build and generate the monthly rota, "
          "give the first approval on your staff's leave, and submit the rota for the "
          "manager to approve. You only see and act on your own branch."),

    ("h1", "1. Signing in"),
    ("steps", [
        "Open the platform link and sign in with your username and password.",
        "Change your password anytime from the sidebar -> Change password.",
    ]),

    ("h1", "2. Building the monthly rota"),
    ("steps", [
        "Open Schedule. Your branch and the month are shown at the top.",
        "Click Generate to auto-build the rota (it respects approved leave and limits).",
        "Adjust any cell by clicking it and picking a shift.",
        "Use Settings (gear) to set per-section limits (min/max mornings & nights).",
    ]),
    ("callout", "Generate only counts APPROVED leave. Approve leave first so it shows on the rota."),

    ("h1", "3. Submitting for approval"),
    ("steps", [
        "When the rota is ready, click Submit — it goes to the manager as 'Pending'.",
        "The manager Approves (locks it) or Returns it to you with notes.",
        "While a schedule is approved/locked you can't edit it — ask a manager to reopen.",
    ]),

    ("h1", "4. Leave — first approval (stage 1)"),
    ("p", "When your staff request leave, it comes to you first."),
    ("steps", [
        "Open Leave — requests show as 'Awaiting team lead'.",
        "Click 'Approve -> manager' to pass it up, or Reject.",
        "After your approval it shows 'Awaiting manager' until the manager finalises it.",
    ]),

    ("h1", "5. Approving your staff's sign-ups"),
    ("steps", [
        "When you share the staff invite link, new sign-ups appear on the Staff page.",
        "Review the details and Approve — this creates their account and rota record.",
        "Reject if the details are wrong; the person can re-submit.",
    ]),

    ("h1", "6. Shift swaps for your branch"),
    ("p", "After two colleagues agree a swap, it comes to you. Open Swaps and Approve "
          "the items marked 'Awaiting team lead'; it then goes to the manager for the "
          "final step."),

    ("h1", "7. Daily cases"),
    ("bullets", [
        "Open Daily Cases and fill your branch's report for the day.",
        "Save keeps a draft; Submit locks it. A manager can reopen if needed.",
        "Night reports filed after midnight still count for the day they covered.",
    ]),
]

# ─────────────────────────── 4) STAFF GUIDE ───────────────────────────
STAFF = [
    ("h1", "Welcome to your portal"),
    ("p", "Your personal area lets you see your shifts, request leave, ask to swap a "
          "shift, and (if you're eligible) fill the daily case report. Everything you "
          "submit is tracked so you always see where it stands."),

    ("h1", "1. Creating your account"),
    ("steps", [
        "Open the sign-up link your manager shared (or click 'New staff? Sign up' on the login screen and enter the invite code).",
        "Fill your name, branch, section, Employee ID and email.",
        "Choose a username and password — this is your login.",
        "Submit. Your team lead approves it, then you can sign in.",
    ]),
    ("callout", "You can change your password anytime from the sidebar -> Change password."),

    ("h1", "2. Your schedule"),
    ("steps", [
        "Sign in — you land on My Schedule.",
        "Use the arrows to move between months.",
        "Your shifts, leave and any swaps show on your calendar.",
    ]),

    ("h1", "3. Requesting leave"),
    ("steps", [
        "Open Leave and click Request Leave.",
        "Pick the dates and the leave type, then submit.",
        "Track the status: 'Awaiting team lead' -> 'Awaiting manager' -> 'Approved'.",
        "You can Withdraw a request while it's still pending.",
    ]),
    ("callout", "Note: there's a cut-off day each month for next-month leave — submit early."),

    ("h1", "4. Swapping a shift"),
    ("steps", [
        "Open Swaps and request a swap, choosing the colleague and the two dates.",
        "Your colleague accepts, then your team lead and the manager approve.",
        "Once fully approved, the swap is applied to the rota automatically.",
        "You can cancel your own request while it's still pending.",
    ]),

    ("h1", "5. Daily cases (if eligible)"),
    ("p", "If you have reporting rights or you're on the Night shift that day, the Daily "
          "Cases page lets you fill your branch's report. Enter the numbers and Submit "
          "to lock it. If you're not eligible, the form is view-only."),

    ("h1", "6. Notifications"),
    ("p", "The bell icon shows updates — when your leave or swap moves a stage, or is "
          "approved. If you added an email, you'll also get notified there."),
]

DOCS = [
    {"file": "01_Project_Overview.pdf", "title": "Meena Radiology Scheduling",
     "subtitle": "Project Overview", "tagline": "An all-in-one platform for the radiology "
     "department's monthly rota, approvals, leave, swaps and daily case reports.",
     "blocks": OVERVIEW},
    {"file": "02_Manager_Guide.pdf", "title": "Manager Guide",
     "subtitle": "Meena Radiology Scheduling", "tagline": "Your day-to-day flow: reviewing "
     "schedules, final leave approval, daily cases and reports.", "blocks": MANAGER},
    {"file": "03_TeamLead_Guide.pdf", "title": "Team Lead Guide",
     "subtitle": "Meena Radiology Scheduling", "tagline": "Running your branch: building the "
     "rota, first leave approval, sign-ups and swaps.", "blocks": TEAMLEAD},
    {"file": "04_Staff_Guide.pdf", "title": "Staff Guide",
     "subtitle": "Meena Radiology Scheduling", "tagline": "Your portal: schedule, leave, "
     "swaps and daily cases.", "blocks": STAFF},
]
