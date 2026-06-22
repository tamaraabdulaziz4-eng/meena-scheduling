"""Build a landscape 'Platform Guide' deck (same style as Registration_guidelines)
covering ALL platform features — real screenshots where available, feature cards
where not."""
import os, base64
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SH = os.path.join(ROOT, "docs", "guide_shots")
OUTPDF = os.path.join(ROOT, "docs", "Meena_Platform_Guide.pdf")
CHROME = "/opt/cft/chrome-linux64/chrome"

def uri(name, d=SH):
    p = os.path.join(d, name)
    with open(p, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()

LOGO = uri("meena_logo.png", os.path.join(ROOT, "dashboard"))
_pageno = [0]

def header():
    return f"""<div class="hd">
      <img class="hd-logo" src="{LOGO}">
      <span class="hd-eyebrow">MEENA STAFF SCHEDULING</span></div>"""

def footer():
    _pageno[0] += 1
    return f"""<div class="ft"><span>Platform guide</span><span>Page {_pageno[0]}</span></div>"""

def blobs():
    return ('<div class="blob b1"></div><div class="blob b2"></div>'
            '<div class="blob b3"></div>')

def stage(img=None, icon=None, label=""):
    """The framed-screenshot panel (or a feature icon panel when no screenshot)."""
    if img:
        inner = f'<div class="frame"><img src="{uri(img)}"></div>'
        cls = "stage shot"
    else:
        inner = f'<div class="iconwrap"><div class="bigicon">{icon}</div><div class="iconlabel">{label}</div></div>'
        cls = "stage"
    return f'<div class="{cls}">{blobs()}{inner}</div>'

def card(title, bullets):
    lis = "".join(f"<li>{b}</li>" for b in bullets)
    return f"""<div class="whatcard"><h3>{title}</h3><div class="rule"></div><ul>{lis}</ul></div>"""

def page(title, subtitle, bullets, img=None, icon=None, label="", side="right", card_title="What this page does"):
    c = card(card_title, bullets)
    s = stage(img, icon, label)
    body = (f'<div class="col card-col">{c}</div><div class="col stage-col">{s}</div>'
            if side == "right" else
            f'<div class="col stage-col">{s}</div><div class="col card-col">{c}</div>')
    return f"""<div class="page">{header()}
      <h1>{title}</h1><p class="sub">{subtitle}</p><div class="hr"></div>
      <div class="body">{body}</div>{footer()}</div>"""

COVER = f"""<div class="page cover">
  <img class="cv-logo" src="{LOGO}">
  <div class="cv-eyebrow">PLATFORM GUIDE</div>
  <h1 class="cv-title">Meena Scheduling —<br>Features &amp; Capabilities</h1>
  <p class="cv-sub">A complete tour of the platform for managers — from Nafath
     onboarding to daily operations, scheduling, leaves and notifications.</p>
  <div class="cv-note">Prepared from the actual Meena Scheduling interface</div>
  <div class="cv-stage"><div class="cv-blob"></div>
     <div class="cv-frame"><img src="{uri('06_home.png')}"></div></div>
  <div class="ft ft-cover"><span>Platform guide</span><span>Page {(_pageno.__setitem__(0,_pageno[0]+1) or _pageno[0])}</span></div>
</div>"""

PAGES = [COVER]

PAGES.append(page("Overview — what Meena does",
    "An end-to-end staff scheduling platform for the radiology branches.",
    ["Verified onboarding with Nafath identity + WhatsApp + email.",
     "Automatic rota generation, fill-blanks, and cross-branch cover.",
     "Leave &amp; sick-leave management with smart cover suggestions.",
     "Shift swaps, daily-case reporting, and live notifications.",
     "Role-based access: staff, team lead, manager, admin."],
    icon=f'<img src="{LOGO}" style="height:74px">', label="Meena Scheduling", side="right", card_title="At a glance"))

PAGES.append(page("Onboarding — identity with Nafath",
    "New staff verify their real identity through Nafath before an account is created.",
    ["Enter National ID / Iqama; a request is pushed to the Nafath app.",
     "The official name is returned by Nafath and locked onto the record.",
     "No manual invite codes to share — identity is the gate.",
     "Backed by SDAIA — the National Single Sign-On."],
    img="03_nafath_verified.png", side="right"))

PAGES.append(page("A guided, step-by-step sign-up",
    "Onboarding is a clean wizard — each step is verified before the next.",
    ["Mobile number confirmed with a one-time code over WhatsApp.",
     "Work email confirmed with a 6-digit code (@meena only).",
     "Then staff details, then username &amp; password.",
     "Five clear steps with progress and back/continue."],
    img="04_mobile_step.png", side="left"))

PAGES.append(page("Instant activation &amp; sign-in",
    "On the last step the account is created and the staff member is signed in — no approval needed.",
    ["Staff land in the app immediately after sign-up.",
     "Team-lead &amp; manager sign-ups still require an admin (privileged).",
     "Sign in any time with the chosen username and password.",
     "Forgot-password recovery by email."],
    img="01_login.png", side="right"))

PAGES.append(page("Manager home",
    "The home screen surfaces what needs attention across all branches.",
    ["Tiles: today's cases, patients, branches reported, items awaiting you.",
     "Pending approvals grouped and actionable in one place.",
     "Live daily-cases progress bar.",
     "Clean overview; deeper tools one click away."],
    img="06_home.png", side="left"))

PAGES.append(page("Instant staff search",
    "Find any staff member by name or employee ID in one box.",
    ["Shows branch, section, contact, shifts &amp; leave this month, live balance.",
     "✓ Nafath badge confirms verified identity.",
     "Quick General / Ultrasound filters; recent staff chips.",
     "Jump straight to a staff member's rota."],
    img="07_home_search.png", side="right"))

PAGES.append(page("Schedules &amp; auto-generation",
    "Generate fair monthly rotas in seconds, or fill only the gaps around manual choices.",
    ["One-click generate per branch &amp; section using the solver.",
     "Fill-blanks: pin some cells, let the generator complete the rest.",
     "Cross-branch cover: pull surplus staff from sharing branches (Y3-aware) without touching rest days or exceeding shift counts.",
     "Submit → review → approve workflow between team lead and manager.",
     "Fridays-off targeting and per-shift (Morning/Night) balancing."],
    icon="📅", label="Schedule &amp; rota", side="left", card_title="What it does"))

PAGES.append(page("Leave management &amp; approvals",
    "Leave requests flow through the right approvers (team lead → manager).",
    ["Annual, sick and time-back requests in one place with day counts.",
     "Approve directly or open for review; coverage gaps flagged first.",
     "Leave balances accrue automatically (22 days/year).",
     "Bulk 'approve all pending' for fast clearing."],
    img="08_leaves.png", side="right"))

PAGES.append(page("Sick-leave cover suggestions",
    "When someone calls in sick, see who can cover that exact day and shift.",
    ["Only free, same-section staff for the missing shift (M / N).",
     "Grouped ✅ Same branch — preferred, then 🔁 Other branches.",
     "Lightest-workload first; one tap assigns the cover.",
     "The cover lands on the covering staff member's own rota."],
    img="09_cover.png", side="left"))

PAGES.append(page("Shift swaps",
    "Staff swap shifts through a safe, multi-stage approval chain.",
    ["Peer accepts → team lead approves → manager gives final approval.",
     "Both staff are notified at request, decline and final approval.",
     "Overlapping or conflicting swaps on the same cell are blocked.",
     "Applied automatically to both rotas once approved."],
    icon="🔁", label="Shift swaps", side="right", card_title="What it does"))

PAGES.append(page("Daily cases &amp; reporting",
    "Each branch submits daily case counts; managers see completion in real time.",
    ["Per-modality counts (X-ray, CT, US, mammo, BMD…) + patient totals.",
     "Live progress: how many branches reported today.",
     "Branches that haven't submitted are reminded automatically.",
     "Printable daily-cases report."],
    img="10_cases.png", side="left"))

PAGES.append(page("Notifications — in-app, WhatsApp &amp; email",
    "Everyone is kept in the loop on the channels that matter, tuned to stay high-signal.",
    ["Staff: leave approved/rejected, swap updates, cover assignments, account activation — via WhatsApp + in-app.",
     "Managers &amp; leads: items awaiting their approval (leave, time-back, swaps, schedules).",
     "Sick-leave alerts point straight to cover suggestions.",
     "Low-value noise is deliberately suppressed."],
    icon="🔔", label="Notifications", side="right", card_title="What it does"))

PAGES.append(page("Roles &amp; security",
    "Access is scoped to each role, and sessions are protected.",
    ["Staff see their own rota &amp; requests; team leads manage their branch; managers span branches; admins configure the system.",
     "Identity verified at sign-up (Nafath); work-email + mobile confirmed.",
     "Privileged sign-ups (team lead / manager) require admin activation.",
     "Sliding 30-day sessions; dates shown in English throughout."],
    icon="🔐", label="Roles &amp; security", side="left", card_title="What it does"))

HTML = f"""<!doctype html><html><head><meta charset="utf-8"><style>
  @page {{ size: A4 landscape; margin: 0; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #2B2450; }}
  .page {{ position: relative; width: 297mm; height: 210mm; padding: 12mm 15mm 14mm; overflow: hidden;
           background: #fff; page-break-after: always; }}
  .page:last-child {{ page-break-after: auto; }}
  /* header */
  .hd {{ display: flex; align-items: center; gap: 12px; }}
  .hd-logo {{ height: 30px; }}
  .hd-eyebrow {{ font-size: 11px; font-weight: 800; letter-spacing: 1.5px; color: #6B4EFF; }}
  h1 {{ font-size: 30px; color: #2B2450; margin: 14px 0 4px; }}
  .sub {{ font-size: 14px; color: #6a6490; margin: 0; }}
  .hr {{ height: 1px; background: #E6E0FA; margin: 12px 0 0; }}
  /* body */
  .body {{ display: flex; gap: 26px; align-items: stretch; margin-top: 16px; height: 128mm; }}
  .col {{ flex: 1; display: flex; align-items: center; }}
  .card-col {{ flex: 0 0 42%; }}
  .whatcard {{ width: 100%; background: #fff; border: 1px solid #ECE7FB; border-radius: 22px;
               box-shadow: 0 16px 44px rgba(80,60,160,.12); padding: 26px 28px; }}
  .whatcard h3 {{ font-size: 21px; color: #2B2450; margin: 0; }}
  .rule {{ width: 54px; height: 6px; border-radius: 6px; background: #6B4EFF; margin: 10px 0 14px; }}
  .whatcard ul {{ margin: 0; padding-left: 18px; }}
  .whatcard li {{ font-size: 13.5px; line-height: 1.7; color: #4a4470; margin-bottom: 9px; }}
  /* stage */
  .stage {{ position: relative; width: 100%; height: 118mm; border-radius: 24px;
            background: linear-gradient(160deg, #efe9fc, #f6f3fe); display: grid; place-items: center; overflow: hidden; }}
  .blob {{ position: absolute; border-radius: 50%; background: radial-gradient(closest-side, #cdbcff, #cdbcff00); opacity: .8; }}
  .b1 {{ width: 150px; height: 150px; left: -30px; top: 40px; }}
  .b2 {{ width: 120px; height: 120px; right: 30px; bottom: 30px; opacity: .6; }}
  .b3 {{ width: 90px; height: 90px; right: 80px; top: -20px; opacity: .5; }}
  .frame {{ position: relative; z-index: 2; background: #fff; border-radius: 16px; padding: 7px;
            box-shadow: 0 22px 50px rgba(60,40,130,.22); max-width: 86%; max-height: 86%; }}
  .frame img {{ display: block; max-width: 100%; max-height: 86mm; border-radius: 10px; }}
  .iconwrap {{ position: relative; z-index: 2; text-align: center; }}
  .bigicon {{ font-size: 86px; line-height: 1; filter: drop-shadow(0 12px 22px rgba(80,60,160,.25)); }}
  .iconlabel {{ margin-top: 14px; font-size: 15px; font-weight: 800; color: #6B4EFF; letter-spacing: .5px; }}
  /* footer */
  .ft {{ position: absolute; left: 15mm; right: 15mm; bottom: 8mm; display: flex; justify-content: space-between;
         font-size: 10.5px; color: #9a95ba; border-top: 1px solid #ECE7FB; padding-top: 6px; }}
  /* cover */
  .cover {{ background: linear-gradient(135deg, #2b2456, #3a2f7e); color: #fff; padding: 18mm 18mm; }}
  .cv-logo {{ height: 34px; filter: brightness(0) invert(1); opacity: .96; }}
  .cv-eyebrow {{ margin-top: 26mm; font-size: 13px; font-weight: 800; letter-spacing: 2px; color: #c9bdff; }}
  .cv-title {{ font-size: 44px; line-height: 1.12; margin: 12px 0 0; color: #fff; }}
  .cv-sub {{ font-size: 15px; line-height: 1.6; color: #d9d3f7; max-width: 150mm; margin-top: 16px; }}
  .cv-note {{ position: absolute; left: 18mm; bottom: 16mm; font-size: 11px; color: #b9b1e6; }}
  .cv-stage {{ position: absolute; right: 10mm; top: 30mm; width: 150mm; height: 150mm; }}
  .cv-blob {{ position: absolute; inset: 6mm 0 0 14mm; background: #7c63ff; border-radius: 30px; opacity: .55; }}
  .cv-frame {{ position: absolute; right: 6mm; top: 34mm; background: #fff; border-radius: 16px; padding: 7px;
               box-shadow: 0 30px 60px rgba(0,0,0,.3); width: 132mm; }}
  .cv-frame img {{ width: 100%; border-radius: 10px; display: block; }}
  .ft-cover {{ color: #b9b1e6; border-top-color: rgba(255,255,255,.18); left: 18mm; right: 18mm; }}
</style></head><body>{''.join(PAGES)}</body></html>"""

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME if os.path.exists(CHROME) else None, args=["--no-sandbox"])
    pg = b.new_page()
    pg.set_content(HTML, wait_until="load")
    pg.wait_for_timeout(900)
    pg.pdf(path=OUTPDF, landscape=True, format="A4", print_background=True,
           margin={"top": "0", "bottom": "0", "left": "0", "right": "0"})
    b.close()
print("PDF:", OUTPDF, os.path.getsize(OUTPDF), "bytes")
