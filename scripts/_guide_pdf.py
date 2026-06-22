"""Build the English Manager Guide PDF embedding the REAL app screenshots."""
import os, base64
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SH = os.path.join(ROOT, "docs", "guide_shots")
OUTPDF = os.path.join(ROOT, "docs", "Meena_Manager_Platform_Guide.pdf")
CHROME = "/opt/cft/chrome-linux64/chrome"

def uri(name, d=SH):
    with open(os.path.join(d, name), "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()

LOGO = uri("meena_logo.png", os.path.join(ROOT, "dashboard"))

def fig(name, caption):
    return f'<figure><img src="{uri(name)}"><figcaption>{caption}</figcaption></figure>'

def feature(num, title, lead, figs_html, bullets):
    lis = "".join(f"<li>{b}</li>" for b in bullets)
    return f"""
    <section class="feat">
      <div class="feat-head"><span class="num">{num}</span><h2>{title}</h2></div>
      <p class="lead">{lead}</p>
      <ul>{lis}</ul>
      <div class="figs">{figs_html}</div>
    </section>"""

HTML = f"""<!doctype html><html><head><meta charset="utf-8">
<style>
  @page {{ size: A4; margin: 16mm 14mm; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #2B2450; margin: 0; }}
  h1,h2,h3 {{ margin: 0; }}
  .cover {{ height: 247mm; display: flex; flex-direction: column; justify-content: center; align-items: center;
            text-align: center; background: linear-gradient(160deg, #6B4EFF, #4B3F8F); color: #fff; border-radius: 18px; }}
  .cover img {{ height: 64px; background: #fff; padding: 14px 20px; border-radius: 16px; }}
  .cover h1 {{ font-size: 38px; margin-top: 30px; letter-spacing: .5px; }}
  .cover p {{ font-size: 16px; opacity: .9; margin-top: 12px; }}
  .cover .tag {{ margin-top: 26px; font-size: 12px; letter-spacing: 3px; text-transform: uppercase; opacity: .8; }}
  .page-break {{ page-break-before: always; }}
  .intro {{ padding: 6mm 0; }}
  .intro h2 {{ font-size: 22px; color: #4B3F8F; }}
  .intro p {{ font-size: 13.5px; line-height: 1.7; color: #4a4470; }}
  .kpis {{ display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }}
  .kpi {{ flex: 1; min-width: 150px; background: #F4F1FD; border: 1px solid #E6E0FA; border-radius: 12px; padding: 12px 14px; }}
  .kpi b {{ display: block; color: #6B4EFF; font-size: 13px; }}
  .kpi span {{ font-size: 11.5px; color: #6a6490; }}
  .feat {{ page-break-inside: avoid; margin: 0 0 14px; }}
  .feat-head {{ display: flex; align-items: center; gap: 12px; border-bottom: 2px solid #ECE7FB; padding-bottom: 8px; margin-bottom: 8px; }}
  .num {{ width: 30px; height: 30px; border-radius: 9px; background: linear-gradient(135deg,#8B76FF,#6B4EFF); color: #fff;
          display: grid; place-items: center; font-weight: 800; font-size: 15px; flex: 0 0 auto; }}
  .feat h2 {{ font-size: 18px; color: #2B2450; }}
  .lead {{ font-size: 13px; line-height: 1.6; color: #4a4470; margin: 4px 0 6px; }}
  ul {{ margin: 4px 0 10px; padding-left: 18px; }}
  li {{ font-size: 12.5px; line-height: 1.6; color: #50496f; margin-bottom: 3px; }}
  .figs {{ display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }}
  figure {{ margin: 6px 0; flex: 1; min-width: 240px; max-width: 100%; text-align: center; }}
  figure.half {{ max-width: 49%; }}
  img {{ width: 100%; border: 1px solid #E6E0FA; border-radius: 12px; box-shadow: 0 8px 22px rgba(80,60,160,.12); }}
  figcaption {{ font-size: 11px; color: #8a85ad; margin-top: 5px; }}
  .foot {{ text-align: center; font-size: 10.5px; color: #9a95ba; margin-top: 18px; }}
</style></head><body>

  <div class="cover">
    <img src="{LOGO}">
    <h1>Manager Guide</h1>
    <p>Meena Staff Scheduling Platform — features &amp; capabilities</p>
    <div class="tag">From Nafath onboarding to daily operations</div>
  </div>

  <div class="page-break intro">
    <h2>What is Meena Scheduling?</h2>
    <p>Meena is an end-to-end staff scheduling platform for the radiology branches. It covers the full lifecycle:
    secure staff onboarding with national-identity verification (Nafath), automatic rota generation, leave and
    sick-leave management with cover suggestions, shift swaps, daily-case reporting, and real-time notifications
    over in-app, WhatsApp and email. This guide walks a manager through every capability with screenshots from
    the live platform.</p>
    <div class="kpis">
      <div class="kpi"><b>Verified onboarding</b><span>Nafath identity + WhatsApp + email</span></div>
      <div class="kpi"><b>Smart scheduling</b><span>Auto-generate, fill-blanks, cross-branch cover</span></div>
      <div class="kpi"><b>Leaves &amp; cover</b><span>Approvals + same-branch-first suggestions</span></div>
      <div class="kpi"><b>Live notifications</b><span>In-app · WhatsApp · email</span></div>
    </div>
  </div>

  {feature("1", "Secure onboarding with Nafath",
    "New staff verify their real identity through Nafath (the Saudi national single sign-on) before an account is created — no manual invites or codes to share.",
    f'<figure class="half">{("")}</figure>', [])}
  <div style="margin-top:-14px"></div>
  <div class="figs">{fig("02_nafath.png","Step 1 — enter National ID / Iqama")}{fig("03_nafath_verified.png","Identity verified via the Nafath app")}</div>

  {feature("2", "A guided, step-by-step sign-up",
    "Onboarding is a clean wizard — each step is verified before the next. Identity, then mobile, then email, then details, then login.",
    "", [
      "Mobile number confirmed with a one-time code sent over WhatsApp.",
      "Work email confirmed with a 6-digit code (must be an @meena address).",
      "The official name comes straight from Nafath and is locked in.",
      "On the final step the account is created and the staff member is signed in instantly — no approval needed."])}
  <div class="figs">{fig("04_mobile_step.png","Mobile verified via WhatsApp").replace('figure>','figure class=half>',1)}{fig("05_email_step.png","Work-email verification")}</div>
  <div class="figs">{fig("05b_details.png","Details — name pre-filled from Nafath")}{fig("01_login.png","Secure sign-in")}</div>

  {feature("3", "Manager home & instant staff search",
    "The home screen surfaces what needs attention and lets a manager find any staff member by name or ID in one box.",
    "", [
      "At-a-glance tiles: today's cases, patients, branches reported, items awaiting you.",
      "Search returns the person's branch, section, contact, shifts this month, leave taken and live leave balance.",
      "A ✓ Nafath badge shows the identity was verified; quick General/Ultrasound filters.",
      "Jump straight to a staff member's rota with one click."])}
  <div class="figs">{fig("06_home.png","Manager home — attention &amp; cases")}{fig("07_home_search.png","Instant staff search with live details")}</div>

  {feature("4", "Leave management & approvals",
    "Leave requests flow through the right approvers (team lead → manager). Pending items are grouped and actionable.",
    "", [
      "Annual, sick and time-back requests in one place, with status and day counts.",
      "Approve directly, or open for review; coverage gaps are flagged before approval.",
      "Leave balances accrue automatically (22 days/year) from each staff member's recorded balance."])}
  <div class="figs">{fig("08_leaves.png","Leave management")}</div>

  {feature("5", "Sick-leave cover suggestions",
    "When someone calls in sick, the platform instantly suggests who can cover that exact day and shift — same branch first, then other branches.",
    "", [
      "Only free, same-section staff are suggested for the missing shift (e.g. Morning / Night).",
      "Grouped as ✅ Same branch — preferred, then 🔁 Other branches, lightest workload first.",
      "One tap assigns the cover onto the covering staff member's own rota."])}
  <div class="figs">{fig("09_cover.png","Cover suggestions — same branch first, then others")}</div>

  {feature("6", "Daily cases & reporting",
    "Each branch submits its daily case counts; managers see completion and totals across all branches in real time.",
    "", [
      "Per-modality counts (X-ray, CT, US, mammo, BMD…) plus patient totals.",
      "Branches that haven't submitted are reminded automatically.",
      "Live progress: how many branches have reported today."])}
  <div class="figs">{fig("10_cases.png","Daily cases overview")}</div>

  {feature("7", "Notifications — in-app, WhatsApp &amp; email",
    "Staff and managers are kept in the loop on the channels that matter, tuned to stay high-signal.",
    "", [
      "Staff get WhatsApp + in-app alerts for: leave approved/rejected, swap updates, cover assignments, and account activation.",
      "Managers &amp; team leads are alerted for items awaiting their approval (leave, time-back, swaps, schedules).",
      "Low-value noise is deliberately suppressed so the important alerts stand out."])}

  <div class="foot">Meena Staff Scheduling — Manager Guide · Generated from the live platform</div>

</body></html>"""

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME if os.path.exists(CHROME) else None, args=["--no-sandbox"])
    pg = b.new_page()
    pg.set_content(HTML, wait_until="load")
    pg.wait_for_timeout(800)
    pg.pdf(path=OUTPDF, format="A4", print_background=True,
           margin={"top": "0", "bottom": "0", "left": "0", "right": "0"})
    b.close()
print("PDF:", OUTPDF, os.path.getsize(OUTPDF), "bytes")
