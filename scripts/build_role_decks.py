"""Build four branded showcase decks (real screenshots): project overview,
manager guide (+ benefits), team-lead guide, staff guide."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_userguide_pdf import Deck, SC
ROOT = os.path.dirname(HERE)

def img(name): return os.path.join(SC, name)

def overview():
    d = Deck()
    d.cover("Meena Scheduling", "Project Overview",
            "An all-in-one platform for the radiology department's monthly rota, approvals, "
            "leave, shift swaps and daily case reports — replacing scattered Excel files and "
            "chat groups with one secure system.", "home.png")
    d.slide(img("home.png"), "OVERVIEW", "One live dashboard",
            "Today's cases, patients, submissions and pending actions at a glance — the whole department in one screen.", True)
    d.slide(img("schedule.png"), "ROTA", "Auto-built rota",
            "A smart engine builds the monthly rota respecting shifts and approved leave; edit any cell, then submit for approval.", False)
    d.slide(img("leave.png"), "APPROVALS", "Leave that flows",
            "Two-stage approval (team lead then manager) lands leave straight on the rota — no requests lost in chat.", True)
    d.slide(img("swaps.png"), "EXCHANGES", "Shift swaps, tracked",
            "Colleague then team lead then manager — applied to the rota automatically once approved.", False)
    d.slide(img("cases.png"), "REPORTING", "Daily case reports",
            "Every branch logs its cases each day; managers see all branches live.", True)
    d.slide(img("report.png"), "EXPORT", "Branded PDF reports",
            "One click turns the day into a polished Radiology Daily Statistics report, ready to print and archive.", False)
    d.cards_slide("WHY IT HELPS", "Benefits", [
        ("Time saved", "The rota builds in one click instead of hours on Excel."),
        ("Governance", "Every approval is recorded with a name and timestamp."),
        ("Live visibility", "Cases, rota and leave for every branch in one place."),
        ("Ready reports", "Branded PDFs for printing and official archiving."),
        ("Secure", "Encrypted logins, role permissions, full audit log."),
        ("Anywhere", "Works on phone and desktop."),
    ])
    d.cards_slide("ACCESS", "Roles", [
        ("Super Admin", "Full control — branches, shifts, users, links, audit."),
        ("Manager", "Reviews & approves schedules and leave, all branches."),
        ("Team Lead", "Runs their own branch: rota, first leave approval, sign-ups."),
        ("Staff", "Personal portal: schedule, leave, swaps, cases."),
        ("Viewer", "Read-only access."),
    ])
    d.output(os.path.join(ROOT, "docs", "Meena_Overview.pdf")); print("Meena_Overview.pdf")

def manager():
    d = Deck()
    d.cover("Manager Guide", "Meena Scheduling",
            "You are the department reviewer — final approvals on schedules and leave, oversight "
            "of every branch, and the daily case reports.", "mgr_home.png")
    d.slide(img("mgr_home.png"), "OVERVIEW", "Your dashboard",
            "KPI cards and action chips show what needs you — reviews, leave, swaps and registrations.", True)
    d.slide(img("mgr_review.png"), "REVIEW", "Approve schedules",
            "Open Review, check a branch's submitted rota, then Approve (locks it as official) or Return it for changes.", False)
    d.slide(img("mgr_leave.png"), "TIME OFF", "Final leave approval",
            "Requests cleared by the team lead arrive as 'Awaiting manager' — your Approve lands them on the rota.", True)
    d.slide(img("mgr_swaps.png"), "EXCHANGES", "Final swap approval",
            "Approve the 'Awaiting manager' swaps; they apply to the rota automatically.", False)
    d.slide(img("mgr_cases.png"), "REPORTING", "Daily cases",
            "See every branch's numbers, remind branches that haven't submitted, and reopen a locked report if needed.", True)
    d.slide(img("report.png"), "EXPORT", "Daily report PDF",
            "Print / PDF turns the day into a branded statistics report for management and archiving.", False)
    d.cards_slide("WHY IT HELPS", "Benefits for you", [
        ("Full oversight", "Every branch's rota, leave and cases in one view."),
        ("Fast approvals", "Two-stage chains reach you ready to finalise."),
        ("Governance", "The audit log records who approved what, and when."),
        ("Live KPIs", "Submissions and pending counts update in real time."),
        ("Ready reports", "Branded PDFs at one click."),
        ("Control", "Reopen, return or correct anything when needed."),
    ])
    d.output(os.path.join(ROOT, "docs", "Meena_Manager_Guide.pdf")); print("Meena_Manager_Guide.pdf")

def teamlead():
    d = Deck()
    d.cover("Team Lead Guide", "Meena Scheduling",
            "You run scheduling for your branch — build the rota, give the first approval on "
            "leave, and submit for the manager. You only see your own branch.", "tl_schedule.png")
    d.slide(img("tl_schedule.png"), "ROTA", "Build & generate",
            "Pick the month and click Generate to auto-build your branch's rota; adjust any cell, then Submit for approval.", True)
    d.slide(img("tl_leave.png"), "TIME OFF", "First leave approval",
            "Your staff's requests come to you first — Approve to pass them to the manager, or Reject.", False)
    d.slide(img("tl_swaps.png"), "EXCHANGES", "Approve branch swaps",
            "After two colleagues agree a swap, approve it; it then goes to the manager for the final step.", True)
    d.slide(img("tl_cases.png"), "REPORTING", "Daily cases",
            "Fill your branch's report for the day; Save keeps a draft, Submit locks it.", False)
    d.slide(img("tl_home.png"), "OVERVIEW", "Branch at a glance",
            "Your home shows pending leave, swaps and staff sign-ups for your branch.", True)
    d.cards_slide("WHY IT HELPS", "Benefits", [
        ("One-click rota", "Generate builds a fair rota in seconds."),
        ("Clear queue", "Pending leave, swaps and sign-ups in one place."),
        ("Branch-scoped", "You only see and manage your own branch."),
        ("Sign-ups", "Approve new staff from your invite link."),
        ("Less back-and-forth", "Approvals and statuses are tracked, not in chat."),
        ("Reports", "Print your rota and daily cases anytime."),
    ])
    d.output(os.path.join(ROOT, "docs", "Meena_TeamLead_Guide.pdf")); print("Meena_TeamLead_Guide.pdf")

def staff():
    d = Deck()
    d.cover("Staff Guide", "Meena Scheduling",
            "Your personal portal — see your shifts, request leave, swap a shift, and fill the "
            "daily case report. Everything you submit is tracked.", "myschedule.png")
    d.slide(img("signup.png"), "GET STARTED", "Create your account",
            "Open the invite link your manager shares, fill your details, and choose a username & password. Your team lead approves it.", True)
    d.slide(img("myschedule.png"), "YOUR ROTA", "See your schedule",
            "My Schedule shows your shifts, leave and swaps for the month, with the shift legend.", False)
    d.slide(img("staff_leave.png"), "TIME OFF", "Request leave & track it",
            "Request leave, then watch the status: Awaiting team lead, then Awaiting manager, then Approved.", True)
    d.slide(img("staff_swaps.png"), "SWAPS", "Swap a shift",
            "Request a swap with a colleague; once you, your team lead and the manager approve, it's applied to the rota.", False)
    d.slide(img("staff_cases.png"), "CASES", "Daily cases",
            "If you're eligible (reporting rights or on the Night shift), fill your branch's case report.", True)
    d.slide(img("staff_changepw.png"), "ACCOUNT", "Change your password",
            "Update your password anytime from the sidebar — no admin or email needed.", False)
    d.output(os.path.join(ROOT, "docs", "Meena_Staff_Guide.pdf")); print("Meena_Staff_Guide.pdf")

if __name__ == "__main__":
    overview(); manager(); teamlead(); staff()
