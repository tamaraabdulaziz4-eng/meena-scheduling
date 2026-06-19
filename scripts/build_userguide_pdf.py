"""Landscape user-guide deck (matches the uploaded showcase style): one feature
per slide with a REAL app screenshot, title and a short description."""
import os
from fpdf import FPDF
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SC = os.path.join(ROOT, "docs", "screens")
LOGO = os.path.join(ROOT, "dashboard", "meena_logo.png")
FREG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FBLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

VIOLET=(107,78,255); DEEP=(38,30,79); LAV=(244,241,253); BAND=(233,227,250)
MUTED=(120,114,150); TEXT=(60,54,92); WHITE=(255,255,255)
W,H = 254, 143   # 16:9 landscape (mm)

def aspect(p):
    im=Image.open(p); return im.width/im.height

class Deck(FPDF):
    def __init__(self):
        super().__init__("P","mm",(W,H))   # tuple kept as-is: 254 wide x 143 tall
        self.set_auto_page_break(False)
        self.add_font("DJ","",FREG); self.add_font("DJ","B",FBLD)
    def rrect(self,x,y,w,h,r,fill):
        self.set_fill_color(*fill)
        try: self.rect(x,y,w,h,round_corners=True,style="F")
        except Exception: self.rect(x,y,w,h,style="F")
    def fit(self,img,bx,by,bw,bh):
        """Place image fit within box, centered; lavender blob + soft shadow."""
        a=aspect(img);
        w=bw; h=w/a
        if h>bh: h=bh; w=h*a
        x=bx+(bw-w)/2; y=by+(bh-h)/2
        # blob behind (offset)
        self.rrect(x-6, y-6, w+12, h+12, 7, BAND)
        # shadow
        self.set_fill_color(220,214,240);
        try: self.rect(x+2,y+2,w,h,round_corners=True,style="F")
        except Exception: self.rect(x+2,y+2,w,h,style="F")
        # image with thin border frame
        self.set_fill_color(*WHITE)
        try: self.rect(x-1.5,y-1.5,w+3,h+3,round_corners=True,style="F")
        except Exception: pass
        self.image(img,x,y,w)
        self.set_draw_color(225,219,245); self.set_line_width(0.3)
        self.rect(x,y,w,h)
    def cover(self):
        self.add_page()
        self.set_fill_color(*LAV); self.rect(0,0,W,H,style="F")
        self.image(LOGO,20,18,40)
        self.set_xy(20,54); self.set_font("DJ","B",29); self.set_text_color(*DEEP)
        self.cell(0,15,"Meena Scheduling")
        self.set_xy(20,72); self.set_font("DJ","B",16); self.set_text_color(*VIOLET)
        self.cell(0,9,"User Guide")
        self.set_xy(20,90); self.set_font("DJ","",12); self.set_text_color(*MUTED)
        self.multi_cell(108,6.5,"The radiology department's rota, leave, shift swaps and daily "
                        "case reports — in one place. This guide walks through every screen and "
                        "where to click.")
        # screenshot on the right
        self.fit(os.path.join(SC,"home.png"),140,30,98,84)
        # swoosh
        self.set_draw_color(*VIOLET); self.set_line_width(1.2)
        pts=[(20,128),(70,134),(120,122),(170,134),(232,124)]
        for i in range(len(pts)-1):
            self.line(pts[i][0],pts[i][1],pts[i+1][0],pts[i+1][1])
        self.set_xy(0,132); self.set_font("DJ","",9); self.set_text_color(*MUTED)
        self.cell(0,6,"Meena Health  ·  Radiology Department",align="C")
    def slide(self,img,eyebrow,title,desc,img_left=True):
        self.add_page()
        self.set_fill_color(*WHITE); self.rect(0,0,W,H,style="F")
        # logo accent
        self.image(LOGO,W-44,10,30)
        imgbox=(14,18,128,108) if img_left else (112,18,128,108)
        txtx = 150 if img_left else 16
        self.fit(img,*imgbox)
        self.set_xy(txtx,40); self.set_font("DJ","B",11); self.set_text_color(*VIOLET)
        self.cell(0,6,eyebrow)
        self.set_xy(txtx,48); self.set_font("DJ","B",24); self.set_text_color(*DEEP)
        self.multi_cell(92,11,title,align="L")
        self.set_xy(txtx,self.get_y()+4); self.set_font("DJ","",12); self.set_text_color(*TEXT)
        self.multi_cell(92,6.4,desc,align="L")

SLIDES=[
 ("login.png","GETTING IN","Sign in",
  "Everyone signs in with their username and password. New staff tap "
  "\"New staff? Sign up\" to create their account from the invite link.",True),
 ("signup.png","ONBOARDING","Create your account",
  "Open the invite link your manager shares, fill your details, and choose a "
  "username and password. Your team lead approves it, then you can sign in.",False),
 ("home.png","OVERVIEW","Home dashboard",
  "A live snapshot: today's cases, patients, branches submitted and anything "
  "pending. The KPI cards and chips jump you straight to what needs action.",True),
 ("schedule.png","ROTA","Build the schedule",
  "Pick the branch and month, then Generate to auto-build the rota (it respects "
  "approved leave). Click any cell to adjust, then submit for approval.",False),
 ("leave.png","TIME OFF","Leave approval",
  "Two-stage chain: a request goes to the team lead first, then to the manager "
  "for final approval. The status badge shows exactly where it stands.",True),
 ("swaps.png","EXCHANGES","Shift swaps",
  "A swap flows colleague -> team lead -> manager. Once fully approved it's "
  "applied to the rota automatically — no manual edits.",False),
 ("cases.png","REPORTING","Daily cases",
  "Each branch logs its cases for the day (X-ray, CT, US, MAMO, BMD). Save keeps "
  "a draft; Submit locks it. Managers see every branch at a glance.",True),
 ("report.png","EXPORT","Daily report PDF",
  "One click turns the day's numbers into a branded \"Radiology Daily "
  "Statistics\" PDF — KPIs, branch breakdown, modality mix and key notes.",False),
 ("links.png","INVITES","Role sign-up links",
  "Three invite links — staff, team lead, manager. Send the right one to the "
  "right people; the role is granted only after approval.",True),
 ("changepw.png","ACCOUNT","Change password",
  "Anyone can change their own password anytime from the sidebar — no need to "
  "wait for an admin or an email reset.",False),
]

def main():
    d=Deck(); d.cover()
    for img,eb,ti,de,left in SLIDES:
        p=os.path.join(SC,img)
        if os.path.exists(p): d.slide(p,eb,ti,de,left)
    out=os.path.join(ROOT,"docs","Meena_User_Guide.pdf")
    d.output(out); print("saved",out)

if __name__=="__main__":
    main()
