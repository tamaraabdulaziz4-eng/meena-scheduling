"""Preview of the branded PRINT output (schedule roster + daily cases)."""
from PIL import Image, ImageDraw, ImageFont
F="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"; FB="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def fn(s,b=False): return ImageFont.truetype(FB if b else F, s)
def tw(d,s,f): return d.textbbox((0,0),s,font=f)[2]
LOGO="/home/user/meena-scheduling/dashboard/meena_onboarding_logo.jpeg"
SH={'M':'#2B9FFF','E':'#FFBA49','N':'#6B4EFF','D':'#00C896','O':'#EDEDED','AL':'#FD79A8'}
TX={'M':'#fff','E':'#000','N':'#fff','D':'#fff','O':'#888','AL':'#fff'}

def header(d,img,x,y,w,title,sub):
    try:
        lg=Image.open(LOGO).convert("RGB"); lw=150; lh=int(lg.height*lw/lg.width); lg=lg.resize((lw,lh))
        img.paste(lg,(x,y))
    except Exception as e: print(e); lw=0
    d.text((x+lw+20,y+6),title,font=fn(22,True),fill="#261E4F")
    d.text((x+lw+20,y+36),sub,font=fn(13),fill="#666")
    d.line([x,y+lh+12,x+w,y+lh+12],fill="#6B4EFF",width=2)
    return y+lh+24

# ── Schedule roster (landscape, FULL month) ──
W,H=1240,680
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
# ── signature footer ──
fy=ly+44; d.line([40,fy,W-40,fy],fill="#ddd")
d.text((40,fy+12),"Prepared by",font=fn(10),fill="#777")
d.text((40,fy+30),"Abdulaziz Alanazi",font=fn(14,True),fill="#261E4F"); d.line([40,fy+52,230,fy+52],fill="#261E4F",width=2)
d.text((40,fy+56),"Team Lead",font=fn(10),fill="#777")
d.text((320,fy+12),"Approved by",font=fn(10),fill="#777")
d.text((320,fy+30),"Khalid Al-Manager",font=fn(14,True),fill="#261E4F"); d.line([320,fy+52,520,fy+52],fill="#261E4F",width=2)
d.text((320,fy+56),"Manager",font=fn(10),fill="#777")
# approved stamp
d.rounded_rectangle([W-230,fy+18,W-90,fy+50],8,outline="#00875a",width=3)
d.text((W-215,fy+24),"✔ APPROVED",font=fn(14,True),fill="#00875a")
d.text((W-230,fy+58),"Printed 18 Jun 2026",font=fn(9),fill="#999")
img.save("/home/user/meena-scheduling/print_schedule_preview.png"); print("saved schedule")

# ── Daily cases print (portrait-ish) ──
W2,H2=720,560
im2=Image.new("RGB",(W2,H2),"#fff"); d2=ImageDraw.Draw(im2)
top2=header(d2,im2,40,30,W2-80,"Daily Radiology Cases","18 Jun 2026")
rows=[("NEST 1","Sara",41,62,True),("NEST 2","Mohammed",53,47,True),("NEST 3","Khalid",101,79,True),("NEST 4","—",0,0,False)]
y=top2+8
d2.text((48,y),"Branch",font=fn(12,True),fill="#261E4F"); d2.text((300,y),"Cases",font=fn(12,True),fill="#261E4F")
d2.text((420,y),"Patients",font=fn(12,True),fill="#261E4F"); d2.text((560,y),"Status",font=fn(12,True),fill="#261E4F")
y+=26
for nm,by,cs,pt,done in rows:
    d2.line([40,y,W2-40,y],fill="#eee")
    d2.text((48,y+10),nm,font=fn(13,True),fill="#222")
    d2.text((300,y+10),str(cs) if done else "—",font=fn(13),fill="#222")
    d2.text((420,y+10),str(pt) if done else "—",font=fn(13),fill="#222")
    d2.rounded_rectangle([560,y+8,660,y+30],8,fill="#d6f5ea" if done else "#fdeccf")
    d2.text((572,y+12),"Submitted" if done else "Pending",font=fn(11,True),fill="#00875a" if done else "#b9760a")
    y+=46
im2.save("/home/user/meena-scheduling/print_cases_preview.png"); print("saved cases")
