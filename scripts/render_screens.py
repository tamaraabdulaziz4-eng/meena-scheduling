"""Render faithful, on-brand mockups of each app screen (PNG) for the user-guide
deck. No live browser available, so these reproduce the real UI with the actual
palette, sidebar, hero and components."""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "screens")
os.makedirs(OUT, exist_ok=True)
LOGO = os.path.join(ROOT, "dashboard", "meena_logo.png")
F = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def fn(s, b=False): return ImageFont.truetype(FB if b else F, s)
def tw(d, s, f): return d.textbbox((0, 0), s, font=f)[2]

VIOLET=(107,78,255); DEEP=(38,30,79); LAV=(244,241,253); BAND=(236,231,251)
MUTED=(133,133,168); PINK=(255,82,119); GREEN=(0,168,125); ORANGE=(217,131,0)
TEXT=(43,36,80); WHITE=(255,255,255)

def vgrad(d, box, c0, c1):
    x0,y0,x1,y1=box; h=y1-y0
    for i in range(h):
        t=i/max(1,h-1)
        d.line([(x0,y0+i),(x1,y0+i)],fill=tuple(int(c0[k]+(c1[k]-c0[k])*t) for k in range(3)))

def rrect(d, box, r, fill=None, outline=None, w=1):
    d.rounded_rectangle(box, r, fill=fill, outline=outline, width=w)

def paste_logo(img, x, y, h=26):
    try:
        lg=Image.open(LOGO).convert("RGBA"); wl=int(lg.width*h/lg.height); lg=lg.resize((wl,h))
        img.paste(lg,(x,y),lg); return wl
    except Exception: return 0

NAV = [("Home","home"),("Schedule","sched"),("Staff","staff"),("Leave","leave"),
       ("Swaps","swaps"),("Daily Cases","cases"),("Review","review")]

def frame(active, title, meta=""):
    """App chrome: sidebar + topbar. Returns (img, draw, cx, cy, cw)."""
    W,H=1200,740
    img=Image.new("RGB",(W,H),WHITE); d=ImageDraw.Draw(img)
    # content background (soft lavender)
    vgrad(d,(220,0,W,H),(239,234,254),(252,251,255))
    # sidebar
    d.rectangle([0,0,210,H],fill=WHITE); d.line([210,0,210,H],fill=(236,231,250),width=1)
    paste_logo(img,24,26,24)
    y=92
    for label,key in NAV:
        on = key==active
        if on: rrect(d,(14,y-6,196,y+26),10,fill=BAND)
        d.ellipse([28,y+2,44,y+18],fill=VIOLET if on else (210,205,230))
        d.text((56,y),label,font=fn(13,on),fill=DEEP if on else (110,104,140))
        y+=42
    # bottom items
    d.text((56,H-80),"Change password",font=fn(12),fill=MUTED)
    d.text((56,H-52),"Sign Out",font=fn(12),fill=(226,85,85))
    # topbar
    d.rectangle([211,0,W,58],fill=WHITE); d.line([211,58,W,58],fill=(236,231,250),width=1)
    d.text((234,12),title,font=fn(15,True),fill=DEEP)
    if meta: d.text((234,34),meta,font=fn(11),fill=MUTED)
    return img,d,234,78,W-234-24

def hero(img,d,x,y,w,eyebrow,title,sub=""):
    h=104; rrect(d,(x,y,x+w,y+h),22,fill=(244,241,252),outline=(233,227,250),w=1)
    orb=Image.new("RGBA",(200,200),(0,0,0,0)); ImageDraw.Draw(orb).ellipse([0,0,200,200],fill=(139,118,255,70))
    img.paste(orb,(x+w-150,y-70),orb)
    cw,ch=120,72; cx,cy=x+16,y+(h-ch)//2; rrect(d,(cx,cy,cx+cw,cy+ch),16,fill=WHITE)
    paste_logo(img,cx+22,cy+24,26)
    tx=cx+cw+20
    d.text((tx,y+22),eyebrow,font=fn(12,True),fill=MUTED)
    d.text((tx,y+38),title,font=fn(26,True),fill=VIOLET)
    if sub: d.text((tx,y+78),sub,font=fn(12,True),fill=(107,95,166))
    return y+h+16

def chip(d,x,y,text,fill,fg,r=11):
    wd=tw(d,text,fn(11,True))+20
    rrect(d,(x,y,x+wd,y+22),r,fill=fill); d.text((x+10,y+4),text,font=fn(11,True),fill=fg)
    return x+wd+8

def badge(d,x,y,text,fill,fg):
    wd=tw(d,text,fn(11,True))+20; rrect(d,(x,y,x+wd,y+24),12,fill=fill)
    d.text((x+10,y+5),text,font=fn(11,True),fill=fg); return wd

def save(img,name): img.save(os.path.join(OUT,name)); print("saved",name)

# ─── LOGIN ───
def screen_login():
    W,H=1200,740; img=Image.new("RGB",(W,H)); d=ImageDraw.Draw(img)
    vgrad(d,(0,0,W,H),(239,234,254),(233,229,250))
    # floating orbs
    for ox,oy,r,a in [(180,140,150,60),(980,560,180,55)]:
        orb=Image.new("RGBA",(r*2,r*2),(0,0,0,0)); ImageDraw.Draw(orb).ellipse([0,0,r*2,r*2],fill=(139,118,255,a))
        img.paste(orb,(ox,oy),orb)
    bx,by,bw,bh=410,150,380,440;
    # card shadow + card
    sh=Image.new("RGBA",(bw+60,bh+60),(0,0,0,0)); ImageDraw.Draw(sh).rounded_rectangle([30,30,bw+30,bh+30],28,fill=(107,78,255,40))
    img.paste(sh,(bx-30,by-20),sh)
    rrect(d,(bx,by,bx+bw,by+bh),24,fill=WHITE)
    paste_logo(img,bx+bw//2-44,by+34,30)
    d.text((bx+bw//2-tw(d,"Staff Scheduling",fn(20,True))//2,by+86),"Staff Scheduling",font=fn(20,True),fill=DEEP)
    d.text((bx+bw//2-tw(d,"Sign in to manage your rota",fn(12))//2,by+116),"Sign in to manage your rota",font=fn(12),fill=MUTED)
    # fields
    for i,(lbl,val) in enumerate([("Username","sara.h"),("Password","••••••••")]):
        fy=by+150+i*64
        d.text((bx+30,fy),lbl,font=fn(11,True),fill=TEXT)
        rrect(d,(bx+30,fy+18,bx+bw-30,fy+48),9,fill=(247,245,253),outline=(225,219,245),w=1)
        d.text((bx+42,fy+26),val,font=fn(12),fill=TEXT if i==0 else MUTED)
    by2=by+150+2*64+6
    rrect(d,(bx+30,by2,bx+bw-30,by2+38),9,fill=VIOLET)
    d.text((bx+bw//2-tw(d,"Sign In",fn(13,True))//2,by2+11),"Sign In",font=fn(13,True),fill=WHITE)
    d.text((bx+30,by2+52),"Forgot password?",font=fn(11),fill=VIOLET)
    su="New staff? Sign up →"; d.text((bx+bw-30-tw(d,su,fn(11,True)),by2+52),su,font=fn(11,True),fill=VIOLET)
    # annotation arrow to sign up
    d.line([bx+bw-40,by2+78,bx+bw+70,by2+120],fill=PINK,width=3)
    d.text((bx+bw+10,by2+124),"New staff start here",font=fn(12,True),fill=PINK)
    save(img,"login.png")

# ─── SIGNUP / ONBOARDING ───
def screen_signup():
    W,H=1200,740; img=Image.new("RGB",(W,H)); d=ImageDraw.Draw(img)
    vgrad(d,(0,0,W,H),(239,234,254),(233,229,250))
    bx,by,bw,bh=400,70,400,610
    sh=Image.new("RGBA",(bw+60,bh+60),(0,0,0,0)); ImageDraw.Draw(sh).rounded_rectangle([30,30,bw+30,bh+30],28,fill=(107,78,255,38))
    img.paste(sh,(bx-30,by-20),sh); rrect(d,(bx,by,bx+bw,by+bh),24,fill=WHITE)
    paste_logo(img,bx+bw//2-44,by+26,26)
    d.text((bx+bw//2-tw(d,"Staff Onboarding",fn(18,True))//2,by+70),"Staff Onboarding",font=fn(18,True),fill=DEEP)
    d.text((bx+bw//2-tw(d,"Fill in your details to join the team.",fn(11))//2,by+98),"Fill in your details to join the team.",font=fn(11),fill=MUTED)
    fields=[("Full name","Sara Al-Harbi"),("Branch","NEST 1 ▾"),("Section","General | US"),
            ("Employee ID","1043887"),("Email","sara@example.com")]
    fy=by+128
    for lbl,val in fields:
        d.text((bx+28,fy),lbl,font=fn(10,True),fill=TEXT)
        rrect(d,(bx+28,fy+15,bx+bw-28,fy+41),8,fill=(247,245,253),outline=(225,219,245),w=1)
        d.text((bx+38,fy+22),val,font=fn(11),fill=TEXT); fy+=52
    # divider "Create your login"
    d.line([bx+28,fy+8,bx+150,fy+8],fill=(225,219,245)); d.line([bx+bw-150,fy+8,bx+bw-28,fy+8],fill=(225,219,245))
    dl="CREATE YOUR LOGIN"; d.text((bx+bw//2-tw(d,dl,fn(9,True))//2,fy+2),dl,font=fn(9,True),fill=MUTED); fy+=22
    for lbl,val in [("Username","sara.h"),("Password","••••••••")]:
        d.text((bx+28,fy),lbl,font=fn(10,True),fill=TEXT)
        rrect(d,(bx+28,fy+15,bx+bw-28,fy+41),8,fill=(247,245,253),outline=(225,219,245),w=1)
        d.text((bx+38,fy+22),val,font=fn(11),fill=TEXT); fy+=52
    rrect(d,(bx+28,fy+4,bx+bw-28,fy+42),9,fill=VIOLET)
    d.text((bx+bw//2-tw(d,"Create account",fn(13,True))//2,fy+15),"Create account",font=fn(13,True),fill=WHITE)
    save(img,"signup.png")

# ─── HOME ───
def screen_home():
    img,d,cx,cy,cw=frame("home","Home","Your overview at a glance")
    y=hero(img,d,cx,cy,cw,"Good morning,","Khalid","Thursday, 18 June 2026")
    # KPI cards
    kw=(cw-3*14)//4
    for i,(lbl,num,sub,c) in enumerate([("Today's Cases","144","All branches",VIOLET),
        ("Patients","97","Registered today",VIOLET),("Submitted","3/4","Branches reported",VIOLET),
        ("Pending","6","Awaiting you",PINK)]):
        kx=cx+i*(kw+14); rrect(d,(kx,y,kx+kw,y+92),16,fill=WHITE,outline=(236,231,251),w=1)
        rrect(d,(kx+14,y+14,kx+38,y+38),8,fill=c)
        d.text((kx+46,y+18),lbl,font=fn(10,True),fill=(107,99,134))
        d.text((kx+14,y+44),num,font=fn(26,True),fill=DEEP)
        d.text((kx+14,y+78),sub,font=fn(9),fill=MUTED)
    y+=108
    # chips
    xx=cx
    for n,l,on in [("3","Reviews",1),("0","Leave",0),("2","Registrations",1),("1","Swaps",0)]:
        rrect(d,(xx,y,xx+128,y+42),13,fill=(255,247,238) if on else WHITE,outline=(255,217,168) if on else (233,227,250),w=1)
        d.text((xx+14,y+10),n,font=fn(17,True),fill=ORANGE if on else (154,147,181)); d.text((xx+38,y+14),l,font=fn(12,True),fill=TEXT); xx+=138
    y+=56
    rrect(d,(cx,y,cx+cw,y+150),20,fill=WHITE,outline=(236,231,251),w=1)
    d.text((cx+20,y+16),"Today's cases",font=fn(15,True),fill=DEEP)
    rrect(d,(cx+20,y+48,cx+cw-20,y+57),5,fill=(238,231,251)); rrect(d,(cx+20,y+48,cx+20+int((cw-40)*.75),y+57),5,fill=VIOLET)
    for ri,(nm,cs,ok) in enumerate([("NEST 1","41 cases · 62 pt",1),("NEST 2","53 cases · 47 pt",1),("NEST 4","—",0)]):
        ry=y+72+ri*24; d.text((cx+20,ry),nm[0:6],font=fn(12,True),fill=TEXT); d.text((cx+200,ry),cs,font=fn(11),fill=TEXT if ok else MUTED)
        badge(d,cx+cw-150,ry-2,"Submitted" if ok else "Pending",(227,248,240) if ok else (253,236,207),GREEN if ok else ORANGE)
    save(img,"home.png")

# ─── SCHEDULE ───
def screen_schedule():
    img,d,cx,cy,cw=frame("sched","Schedule")
    y=hero(img,d,cx,cy,cw,"Monthly staff rota","Schedule")
    # toolbar
    rrect(d,(cx,y,cx+200,y+34),8,fill=WHITE,outline=(225,219,245),w=1); d.text((cx+12,y+8),"NEST 1   ▾",font=fn(12,True),fill=DEEP)
    d.text((cx+230,y+8),"‹  August 2026  ›",font=fn(12,True),fill=DEEP)
    rrect(d,(cx+cw-300,y,cx+cw-190,y+34),8,fill=VIOLET); d.text((cx+cw-288,y+9),"⚡ Generate",font=fn(12,True),fill=WHITE)
    rrect(d,(cx+cw-180,y,cx+cw-95,y+34),8,fill=WHITE,outline=(225,219,245),w=1); d.text((cx+cw-168,y+9),"⚙ Settings",font=fn(11),fill=DEEP)
    rrect(d,(cx+cw-85,y,cx+cw,y+34),8,fill=WHITE,outline=(225,219,245),w=1); d.text((cx+cw-72,y+9),"🖨 Print",font=fn(11),fill=DEEP)
    # annotate Generate
    d.line([cx+cw-245,y+40,cx+cw-245,y+62],fill=PINK,width=3); d.text((cx+cw-330,y+64),"One click builds the rota",font=fn(11,True),fill=PINK)
    y+=80
    # rota grid
    SH={'M':(43,159,255),'E':(255,186,73),'N':(107,78,255),'D':(0,200,150),'O':(237,237,237),'AL':(253,121,168)}
    TX={'M':WHITE,'E':(0,0,0),'N':WHITE,'D':WHITE,'O':(136,136,136),'AL':WHITE}
    staff=["Sara Al-Harbi","M. Al-Otaibi","K. Al-Qahtani","A. Al-Zahrani","N. Al-Shehri"]
    days=22; namew=120; cellw=(cw-namew)/days; ch=30; gy=y
    rrect(d,(cx,gy,cx+namew,gy+22),0,fill=(237,235,249)); d.text((cx+6,gy+5),"Staff",font=fn(10,True),fill=DEEP)
    for i in range(days):
        x=int(cx+namew+i*cellw); d.rectangle([x,gy,int(x+cellw),gy+22],fill=(237,235,249),outline=WHITE); d.text((x+3,gy+6),str(i+1),font=fn(8,True),fill=DEEP)
    gy+=22; codes=['M','M','E','N','D','O','O','AL']
    for r,nm in enumerate(staff):
        yy=gy+r*ch; d.rectangle([cx,yy,cx+namew,yy+ch],outline=(229,229,229)); d.text((cx+6,yy+ch//2-6),nm,font=fn(9),fill=TEXT)
        for i in range(days):
            x=int(cx+namew+i*cellw); code=codes[(r+i)%len(codes)]
            d.rectangle([x,yy,int(x+cellw),yy+ch],fill=SH[code],outline=WHITE); d.text((x+cellw/2-4,yy+ch//2-6),code,font=fn(8,True),fill=TX[code])
    save(img,"schedule.png")

# ─── LEAVE (2-stage) ───
def screen_leave():
    img,d,cx,cy,cw=frame("leave","Leave Management","Annual leave, sick leave, time-back")
    y=hero(img,d,cx,cy,cw,"Annual leave · sick leave · time-back","Leave Management")
    cols=["#","Staff","From","To","Days","Type","Status","Actions"]; xs=[cx,cx+30,cx+220,cx+320,cx+420,cx+480,cx+560,cx+760]
    rrect(d,(cx,y,cx+cw,y+30),8,fill=VIOLET)
    for i,c in enumerate(cols): d.text((xs[i]+6,y+8),c,font=fn(10,True),fill=WHITE)
    rows=[("Sara Al-Harbi","10 Aug","12 Aug","3","AL","Awaiting team lead",(253,236,207),ORANGE,"Approve → manager  Reject"),
          ("M. Al-Otaibi","14 Aug","14 Aug","1","AL","Awaiting manager",(255,243,205),(176,118,10),"(manager)"),
          ("K. Al-Qahtani","02 Aug","04 Aug","3","SL","Approved",(227,248,240),GREEN,"—"),
          ("A. Al-Zahrani","20 Aug","20 Aug","1","AL","Rejected",(235,235,240),(120,120,120),"—")]
    ry=y+34
    for i,(nm,fr,to,dy,tp,st,sc,fg,act) in enumerate(rows):
        if i%2: rrect(d,(cx,ry,cx+cw,ry+34),6,fill=(243,240,252))
        d.text((xs[0]+6,ry+10),str(i+1),font=fn(10),fill=MUTED); d.text((xs[1]+6,ry+9),nm,font=fn(11,True),fill=DEEP)
        d.text((xs[2]+6,ry+10),fr,font=fn(10),fill=TEXT); d.text((xs[3]+6,ry+10),to,font=fn(10),fill=TEXT)
        d.text((xs[4]+6,ry+10),dy,font=fn(10),fill=TEXT); badge(d,xs[5]+4,ry+6,tp,(238,231,251),VIOLET)
        badge(d,xs[6]+4,ry+6,st,sc,fg); d.text((xs[7]+6,ry+11),act,font=fn(9,True),fill=VIOLET if "Approve" in act else MUTED)
        ry+=38
    d.text((cx,ry+8),"Two-stage chain: staff → team lead → manager. Everyone sees the status badge.",font=fn(11),fill=MUTED)
    save(img,"leave.png")

# ─── SWAPS ───
def screen_swaps():
    img,d,cx,cy,cw=frame("swaps","Shift Swaps","Request and approve shift exchanges")
    y=hero(img,d,cx,cy,cw,"Request & approve shift exchanges","Shift Swaps")
    steps=[("1","Colleague accepts",GREEN),("2","Team lead approves",VIOLET),("3","Manager approves → applied",PINK)]
    sx=cx
    for n,t,c in steps:
        rrect(d,(sx,y,sx+ (cw-40)//3,y+70),16,fill=WHITE,outline=(236,231,251),w=1)
        d.ellipse([sx+16,y+18,sx+44,y+46],fill=c); d.text((sx+25,y+24),n,font=fn(14,True),fill=WHITE)
        d.text((sx+54,y+28),t,font=fn(12,True),fill=DEEP); sx+= (cw-40)//3 + 20
    y+=90
    cards=[("Sara ⇄ Mohammed","Aug 1 ⇄ Aug 2","Awaiting manager",(255,243,205),(176,118,10)),
           ("Khalid ⇄ Noura","Aug 5 ⇄ Aug 7","Awaiting team lead",(253,236,207),ORANGE),
           ("Layan ⇄ Reem","Aug 9 ⇄ Aug 10","Approved",(227,248,240),GREEN)]
    for i,(t,dts,st,sc,fg) in enumerate(cards):
        ry=y+i*60; rrect(d,(cx,ry,cx+cw,ry+50),14,fill=WHITE,outline=(236,231,251),w=1)
        d.text((cx+18,ry+10),t,font=fn(13,True),fill=DEEP); d.text((cx+18,ry+28),dts,font=fn(11),fill=MUTED)
        badge(d,cx+cw-220,ry+15,st,sc,fg)
    save(img,"swaps.png")

# ─── DAILY CASES ───
def screen_cases():
    img,d,cx,cy,cw=frame("cases","Daily Cases","Radiology cases per branch")
    y=hero(img,d,cx,cy,cw,"Thursday · Radiology cases per branch","Daily Cases","18 June 2026 · 3/4 submitted · 144 cases")
    rrect(d,(cx+cw-150,cy+8,cx+cw,cy+38),8,fill=WHITE,outline=(225,219,245),w=1); d.text((cx+cw-138,cy+15),"🖨 Print / PDF",font=fn(10,True),fill=DEEP)
    # summary pills
    xx=cx
    for t in ["144 total cases","97 patients","3/4 branches submitted"]:
        xx=chip(d,xx,y,t,(251,249,255),(59,51,96))+6
    y+=40
    cw2=(cw-32)//3
    data=[("NEST 1","Sara",41,62,1),("NEST 2","Mohammed",53,47,1),("NEST 4","—",0,0,0)]
    for i,(nm,by_,cs,pt,done) in enumerate(data):
        kx=cx+(i%3)*(cw2+16); rrect(d,(kx,y,kx+cw2,y+150),18,fill=WHITE,outline=(190,238,222) if done else (255,217,168),w=1)
        d.text((kx+16,y+14),nm,font=fn(14,True),fill=DEEP)
        badge(d,kx+cw2-110,y+14,("✅ "+by_) if done else "● Pending",(227,248,240) if done else (253,236,207),GREEN if done else ORANGE)
        if done:
            d.text((kx+16,y+48),str(cs),font=fn(26,True),fill=VIOLET); d.text((kx+58,y+60),"cases",font=fn(10),fill=MUTED)
            d.text((kx+120,y+48),str(pt),font=fn(26,True),fill=VIOLET); d.text((kx+162,y+60),"patients",font=fn(10),fill=MUTED)
            for j,(cl,cv) in enumerate([("X-RAY","18"),("CT","9"),("US","14")]):
                bxx=kx+16+j*78; rrect(d,(bxx,y+92,bxx+70,y+114),8,fill=(246,244,253),outline=(233,227,250),w=1)
                d.text((bxx+8,y+97),f"{cl} {cv}",font=fn(9,True),fill=TEXT)
        else:
            d.text((kx+16,y+60),"No report filed yet",font=fn(12),fill=MUTED)
            rrect(d,(kx+16,y+100,kx+120,y+128),8,fill=VIOLET); d.text((kx+28,y+106),"✎ Fill report",font=fn(10,True),fill=WHITE)
    save(img,"cases.png")

# ─── REGISTRATION LINKS (settings) ───
def screen_links():
    W,H=1100,560; img=Image.new("RGB",(W,H)); d=ImageDraw.Draw(img); vgrad(d,(0,0,W,H),(244,241,253),(252,251,255))
    bx,by,bw=120,70,860; rrect(d,(bx,by,bx+bw,by+420),20,fill=WHITE,outline=(236,231,251),w=1)
    d.text((bx+30,by+26),"Self-registration links",font=fn(18,True),fill=DEEP)
    d.text((bx+30,by+58),"🟢 Open — send each link to the right people.",font=fn(12),fill=GREEN)
    rows=[("👤 Staff","https://…/?register=4821",VIOLET),
          ("🧑‍💼 Team Lead","https://…/?register=4821&as=admin",VIOLET),
          ("👔 Manager","https://…/?register=4821&as=manager",VIOLET)]
    yy=by+96
    for lbl,url,c in rows:
        d.text((bx+30,yy+10),lbl,font=fn(13,True),fill=DEEP)
        rrect(d,(bx+170,yy,bx+bw-140,yy+36),9,fill=(247,245,253),outline=(225,219,245),w=1)
        d.text((bx+182,yy+10),url,font=fn(11),fill=MUTED)
        rrect(d,(bx+bw-120,yy,bx+bw-30,yy+36),9,fill=WHITE,outline=(225,219,245),w=1); d.text((bx+bw-104,yy+10),"Copy",font=fn(11,True),fill=VIOLET)
        yy+=54
    d.text((bx+30,yy+10),"Staff sign-ups → branch team lead approves.",font=fn(11),fill=TEXT)
    d.text((bx+30,yy+30),"Team-lead & manager sign-ups → you (super admin) approve.",font=fn(11),fill=TEXT)
    save(img,"links.png")

# ─── REPORT (reuse style) ───
def screen_report():
    W,H=900,640; img=Image.new("RGB",(W,H)); d=ImageDraw.Draw(img); vgrad(d,(0,0,W,H),(247,243,252),(236,231,251))
    M=34; rrect(d,(M,24,M+150,96),18,fill=WHITE,outline=(239,234,254),w=1); paste_logo(img,M+20,44,30)
    d.text((M+170,36),"Radiology Daily Statistics",font=fn(24,True),fill=DEEP)
    d.text((M+172,72),"18 June 2026 — Meena Staff Scheduling",font=fn(12,True),fill=(107,95,166))
    ky=120; kw=(W-2*M-3*12)//4
    for i,(lbl,num,c) in enumerate([("Total Cases","144",VIOLET),("Patients","97",VIOLET),("Not Done","2",PINK),("Top Branch","NEST 1",VIOLET)]):
        kx=M+i*(kw+12); rrect(d,(kx,ky,kx+kw,ky+92),18,fill=WHITE,outline=(236,231,251),w=1)
        rrect(d,(kx+14,ky+14,kx+38,ky+38),8,fill=c); d.text((kx+46,ky+18),lbl,font=fn(10,True),fill=(107,99,134))
        d.text((kx+14,ky+44),num,font=fn(24 if len(num)<5 else 18,True),fill=DEEP)
    by=ky+108; rrect(d,(M,by,W-M,by+380),22,fill=WHITE,outline=(236,231,251),w=1)
    d.text((M+22,by+16),"Branch Breakdown",font=fn(18,True),fill=DEEP)
    cols=["Branch","X-RAY","CT","US","MAMO","BMD","Total","Patients"]; tx0=M+22; tw0=W-2*M-44
    cxs=[tx0+int(tw0*f) for f in [0,0.30,0.42,0.53,0.64,0.75,0.84,0.93]]
    hy=by+52; rrect(d,(tx0,hy,W-M-22,hy+28),10,fill=VIOLET)
    for i,c in enumerate(cols): d.text((cxs[i]+ (6 if i==0 else 4),hy+8),c,font=fn(10,True),fill=WHITE)
    rows=[("NEST 1","18","0","18","1","1","38","Missing"),("NEST 2","7","7","15","3","0","32","28"),
          ("NEST 3","18","5","10","1","1","35","35"),("NEST 4","4","1","4","2","0","11","10")]
    ry=hy+34
    for i,r in enumerate(rows):
        rrect(d,(tx0,ry,W-M-22,ry+30),8,fill=(243,240,252) if i%2 else (250,249,255))
        for j,v in enumerate(r):
            col=DEEP if j==0 else (VIOLET if j==6 else (PINK if v=="Missing" else TEXT))
            d.text((cxs[j]+(6 if j==0 else 4),ry+8),v,font=fn(11,True if j in(0,6) or v=="Missing" else False),fill=col)
        ry+=36
    rrect(d,(tx0,ry+2,W-M-22,ry+40),12,fill=(233,226,251)); d.text((tx0+14,ry+13),"Grand Total",font=fn(12,True),fill=(59,51,96))
    g="144 cases — 97 registered patients"; d.text((W-M-22-tw(d,g,fn(12,True))-14,ry+13),g,font=fn(12,True),fill=VIOLET)
    save(img,"report.png")

if __name__ == "__main__":
    screen_login(); screen_signup(); screen_home(); screen_schedule()
    screen_leave(); screen_swaps(); screen_cases(); screen_links(); screen_report()
    print("all screens rendered")
