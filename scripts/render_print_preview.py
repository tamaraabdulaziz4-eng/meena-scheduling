"""Preview of the branded PRINT output — now styled to match the welcome splash
(lavender gradient banner, white logo chip, deep-violet titles)."""
from PIL import Image, ImageDraw, ImageFont
F="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"; FB="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def fn(s,b=False): return ImageFont.truetype(FB if b else F, s)
def tw(d,s,f): return d.textbbox((0,0),s,font=f)[2]
LOGO="/home/user/meena-scheduling/dashboard/meena_onboarding_logo.jpeg"
SH={'M':'#2B9FFF','E':'#FFBA49','N':'#6B4EFF','D':'#00C896','O':'#EDEDED','AL':'#FD79A8'}
TX={'M':'#fff','E':'#000','N':'#fff','D':'#fff','O':'#888','AL':'#fff'}

def _hgrad(d, box, c0, c1):
    """Horizontal lavender gradient inside box (x0,y0,x1,y1)."""
    x0,y0,x1,y1=box; w=x1-x0
    r0,g0,b0=c0; r1,g1,b1=c1
    for i in range(w):
        t=i/max(1,w-1)
        d.line([(x0+i,y0),(x0+i,y1)],fill=(int(r0+(r1-r0)*t),int(g0+(g1-g0)*t),int(b0+(b1-b0)*t)))

def header(d,img,x,y,w,title,sub):
    """Splash-style banner: lavender gradient panel, white logo chip, violet text."""
    bh=86
    # gradient panel with rounded corners (draw on a mask for rounding)
    panel=Image.new("RGB",(w,bh),"#fff"); pd=ImageDraw.Draw(panel)
    _hgrad(pd,(0,0,w,bh),(255,255,255),(233,229,250))
    mask=Image.new("L",(w,bh),0); ImageDraw.Draw(mask).rounded_rectangle([0,0,w-1,bh-1],20,fill=255)
    img.paste(panel,(x,y),mask)
    d.rounded_rectangle([x,y,x+w-1,y+bh-1],20,outline="#e3ddfa",width=1)
    # white logo chip
    cx,cy=x+16,y+16; cw,chh=170,bh-32
    d.rounded_rectangle([cx,cy,cx+cw,cy+chh],14,fill="#ffffff")
    try:
        lg=Image.open(LOGO).convert("RGB"); lw=130; lh=int(lg.height*lw/lg.width); lg=lg.resize((lw,lh))
        img.paste(lg,(cx+(cw-lw)//2,cy+(chh-lh)//2))
    except Exception as e: print(e)
    tx=cx+cw+24
    d.text((tx,y+24),title,font=fn(24,True),fill="#261E4F")
    d.text((tx,y+56),sub,font=fn(14,True),fill="#6b5fa6")
    return y+bh+18

# ── Schedule roster (landscape, FULL month) ──
W,H=1240,700
img=Image.new("RGB",(W,H),"#fff"); d=ImageDraw.Draw(img)
top=header(d,img,40,28,W-80,"Monthly Roster","NEST 3  ·  August 2026")
staff=["Sara Al-Harbi","M. Al-Otaibi","K. Al-Qahtani","A. Al-Zahrani","N. Al-Shehri","R. Al-Dosari"]
days=list(range(1,32))   # full month
codes=['M','M','E','N','D','O','O','AL']
namew=120; cellw=(W-80-namew)/len(days); ch=34; gy=top+6
d.rectangle([40,gy,40+namew,gy+22],fill="#EDEBF9"); d.text((46,gy+5),"Staff",font=fn(10,True),fill="#261E4F")
for i,day in enumerate(days):
    x=int(40+namew+i*cellw)
    d.rectangle([x,gy,int(x+cellw),gy+22],fill="#EDEBF9",outline="#fff")
    d.text((x+cellw/2-5,gy+6),str(day),font=fn(8,True),fill="#261E4F")
gy+=22
for r,nm in enumerate(staff):
    y=gy+r*ch
    d.rectangle([40,y,40+namew,y+ch],outline="#e5e5e5"); d.text((46,y+ch//2-6),nm,font=fn(9),fill="#222")
    for i in range(len(days)):
        x=int(40+namew+i*cellw); code=codes[(r+i)%len(codes)]
        d.rectangle([x,y,int(x+cellw),y+ch],fill=SH[code],outline="#ffffff")
        d.text((x+cellw/2-5,y+ch//2-6),code,font=fn(8,True),fill=TX[code])
ly=gy+len(staff)*ch+14; lx=40
for code in ['M','E','N','D','O','AL']:
    d.rectangle([lx,ly,lx+16,ly+16],fill=SH[code]); d.text((lx+22,ly+1),code,font=fn(10),fill="#444"); lx+=70
# ── signature footer (splash-style lavender card) ──
fy=ly+40; fh=96
fpanel=Image.new("RGB",(W-80,fh),"#fff"); fpd=ImageDraw.Draw(fpanel)
_hgrad(fpd,(0,0,W-80,fh),(250,249,255),(241,237,252))
fmask=Image.new("L",(W-80,fh),0); ImageDraw.Draw(fmask).rounded_rectangle([0,0,W-81,fh-1],18,fill=255)
img.paste(fpanel,(40,fy),fmask)
d.rounded_rectangle([40,fy,W-41,fy+fh-1],18,outline="#e7e1fa",width=1)
px=64; py=fy+16
d.text((px,py),"Prepared by",font=fn(11,True),fill="#8a7fbf")
d.text((px,py+34),"Abdulaziz Alanazi",font=fn(15,True),fill="#261E4F"); d.line([px,py+60,px+190,py+60],fill="#8358FD",width=2)
d.text((px,py+64),"Team Lead",font=fn(11),fill="#777")
px2=px+300
d.text((px2,py),"Approved by",font=fn(11,True),fill="#8a7fbf")
d.text((px2,py+34),"Khalid Al-Manager",font=fn(15,True),fill="#261E4F"); d.line([px2,py+60,px2+200,py+60],fill="#8358FD",width=2)
d.text((px2,py+64),"Manager",font=fn(11),fill="#777")
# approved stamp
d.rounded_rectangle([W-240,py+18,W-90,py+52],8,outline="#00875a",width=3)
d.text((W-226,py+25),"✔ APPROVED",font=fn(15,True),fill="#00875a")
d.text((W-240,py+62),"Printed 18 Jun 2026",font=fn(9),fill="#999")
img.save("/home/user/meena-scheduling/print_schedule_preview.png"); print("saved schedule")

# ── Daily cases report (portrait-ish) ──
W2,H2=760,560
im2=Image.new("RGB",(W2,H2),"#fff"); d2=ImageDraw.Draw(im2)
top2=header(d2,im2,40,30,W2-80,"Daily Radiology Cases","18 Jun 2026")
rows=[("NEST 1","Sara",41,62,True),("NEST 2","Mohammed",53,47,True),("NEST 3","Khalid",101,79,True),("NEST 4","—",0,0,False)]
y=top2+8
d2.text((48,y),"Branch",font=fn(12,True),fill="#261E4F"); d2.text((320,y),"Cases",font=fn(12,True),fill="#261E4F")
d2.text((440,y),"Patients",font=fn(12,True),fill="#261E4F"); d2.text((600,y),"Status",font=fn(12,True),fill="#261E4F")
y+=26
for nm,by,cs,pt,done in rows:
    d2.line([40,y,W2-40,y],fill="#eee")
    d2.text((48,y+10),nm,font=fn(13,True),fill="#222")
    d2.text((320,y+10),str(cs) if done else "—",font=fn(13),fill="#222")
    d2.text((440,y+10),str(pt) if done else "—",font=fn(13),fill="#222")
    d2.rounded_rectangle([600,y+8,700,y+30],8,fill="#d6f5ea" if done else "#fdeccf")
    d2.text((612,y+12),"Submitted" if done else "Pending",font=fn(11,True),fill="#00875a" if done else "#b9760a")
    y+=46
im2.save("/home/user/meena-scheduling/print_cases_preview.png"); print("saved cases")
