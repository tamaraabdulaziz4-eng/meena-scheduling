"""Preview: white sidebar + clean Home (today's cases focus)."""
from PIL import Image, ImageDraw, ImageFont
F="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"; FB="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def fn(s,b=False): return ImageFont.truetype(FB if b else F, s)
def tw(d,s,f): return d.textbbox((0,0),s,font=f)[2]
TEXT="#2B2458"; MUTED="#8585A8"; BORDER="#DDD9F5"; ACCENT="#6B4EFF"; CARD="#EEF0FB"; CARDA="#ffffff"
GREEN="#00A87D"; OK_BG=(0,200,150,30); WAIT="#c9880a"; WAIT_BG=(255,167,60,36)
W,H=1000,620
img=Image.new("RGB",(W,H),"#eef0fb"); d=ImageDraw.Draw(img,"RGBA")
PAD=16
# ── white sidebar ──
sbx,sby,sbw=PAD,PAD,232; sbh=H-2*PAD
d.rounded_rectangle([sbx,sby,sbx+sbw,sby+sbh],26,fill="#ffffff",outline=BORDER,width=1)
# logo (purple M) — use transparent png
try:
    lg=Image.open("/home/user/meena-scheduling/dashboard/meena_logo_transparent.png").convert("RGBA")
    lw=120; lh=int(lg.height*lw/lg.width); lg=lg.resize((lw,lh))
    img.paste(lg,(sbx+20,sby+22),lg)
except Exception as e: print("logo",e)
d.text((sbx+20,sby+62),"STAFF SCHEDULING",font=fn(8,True),fill=TEXT)
d.line([sbx+16,sby+86,sbx+sbw-16,sby+86],fill=BORDER)
nav=[("Home",True),("Schedule",False),("Staff",False),("Leave",False),("Swaps",False),("Daily Cases",False),("Review",False)]
ny=sby+104
for name,active in nav:
    iy=ny
    if active:
        d.rounded_rectangle([sbx+12,iy,sbx+sbw-12,iy+36],12,fill=(107,78,255,30))
        d.rounded_rectangle([sbx,iy+7,sbx+4,iy+29],3,fill=ACCENT)
    col = ACCENT if active else "#5b5b78"
    d.ellipse([sbx+22,iy+12,sbx+34,iy+24],outline=col,width=2)
    d.text((sbx+46,iy+10),name,font=fn(13,active),fill=col)
    ny+=42
# bottom
d.line([sbx+16,sby+sbh-58,sbx+sbw-16,sby+sbh-58],fill=BORDER)
d.text((sbx+30,sby+sbh-44),"Dark Mode",font=fn(12),fill=MUTED)
d.text((sbx+30,sby+sbh-24),"Sign Out",font=fn(12),fill="#E25555")

# ── main panel ──
mx=sbx+sbw+16; my=PAD; mw=W-mx-PAD; mh=H-2*PAD
d.rounded_rectangle([mx,my,mx+mw,my+mh],26,fill="#ffffff",outline=BORDER,width=1)
# topbar
d.text((mx+24,my+18),"Home",font=fn(14,True),fill=ACCENT)
d.text((mx+24,my+38),"Your overview at a glance",font=fn(11),fill=MUTED)
d.line([mx+1,my+62,mx+mw-1,my+62],fill=BORDER)
ix=mx+24; y=my+82
# greeting
d.text((ix,y),"Good morning, Khalid",font=fn(20),fill=TEXT)
d.text((ix,y+30),"Thursday, 18 June 2026",font=fn(12),fill=MUTED); y+=66
# action chips
chips=[("2","Reviews",True),("3","Leave",True),("1","Registrations",True),("0","Swaps",False)]
cx=ix
for n,l,on in chips:
    label=f"{n}  {l}"; cw=tw(d,n,fn(16,True))+tw(d,l,fn(12,True))+34
    bg=WAIT_BG if on else CARDA; bc=(255,167,60,140) if on else BORDER
    d.rounded_rectangle([cx,y,cx+cw,y+38],12,fill=bg,outline=bc,width=1)
    d.text((cx+12,y+9),n,font=fn(16,True),fill=(WAIT if on else MUTED))
    d.text((cx+12+tw(d,n,fn(16,True))+8,y+12),l,font=fn(12,True),fill=TEXT)
    cx+=cw+10
y+=58
# today's cases card
d.rounded_rectangle([ix,y,mx+mw-24,y+250],18,fill=CARDA,outline=BORDER,width=1)
d.text((ix+18,y+16),"📊 Today's cases",font=fn(15,True),fill=TEXT)
meta="4/6 submitted · 287 cases · 227 patients"
d.text((mx+mw-24-18-tw(d,meta,fn(11.5)),y+20),meta,font=fn(11.5),fill=MUTED)
# bar
bx=ix+18; bw=mx+mw-24-18-bx
d.rounded_rectangle([bx,y+44,bx+bw,y+53],5,fill=CARD)
d.rounded_rectangle([bx,y+44,bx+int(bw*0.67),y+53],5,fill="#8B76FF")
# branch rows
rows=[("NEST 1","41 cases · 62 pt",True),("NEST 2","33 cases · 47 pt",True),
      ("NEST 3","52 cases · 79 pt",True),("NEST 4","—",False),
      ("NEST 5","28 cases · 39 pt",True),("NEST 6","—",False)]
ry=y+66
for nm,info,done in rows:
    d.text((ix+18,ry+8),nm,font=fn(13,True),fill=TEXT)
    d.text((ix+150,ry+8),info,font=fn(12),fill=(TEXT if done else MUTED))
    pill="Submitted" if done else "Pending"; pc=GREEN if done else WAIT; pb=OK_BG if done else WAIT_BG
    pw=tw(d,pill,fn(11,True))+20; px=mx+mw-24-18-pw
    d.rounded_rectangle([px,ry+4,px+pw,ry+26],20,fill=pb)
    d.text((px+10,ry+8),pill,font=fn(11,True),fill=pc)
    d.line([ix+18,ry+34,mx+mw-24-18,ry+34],fill=BORDER)
    ry+=30
img.save("/home/user/meena-scheduling/app_preview.png"); print("saved",img.size)
