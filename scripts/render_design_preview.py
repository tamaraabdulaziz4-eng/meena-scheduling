"""Preview of the splash-styled Home + Daily Cases heroes (.phero)."""
from PIL import Image, ImageDraw, ImageFont
F="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"; FB="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def fn(s,b=False): return ImageFont.truetype(FB if b else F, s)
LOGO="/home/user/meena-scheduling/dashboard/meena_logo.png"

def vgrad(d,box,c0,c1):
    x0,y0,x1,y1=box; h=y1-y0
    for i in range(h):
        t=i/max(1,h-1)
        d.line([(x0,y0+i),(x1,y0+i)],fill=tuple(int(c0[k]+(c1[k]-c0[k])*t) for k in range(3)))

def rrect_grad(img,d,box,r,c0,c1,outline):
    x0,y0,x1,y1=box; w,h=x1-x0,y1-y0
    g=Image.new("RGB",(w,h)); vgrad(ImageDraw.Draw(g),(0,0,w,h),c0,c1)
    m=Image.new("L",(w,h),0); ImageDraw.Draw(m).rounded_rectangle([0,0,w-1,h-1],r,fill=255)
    img.paste(g,(x0,y0),m); d.rounded_rectangle(box,r,outline=outline,width=1)

def phero(img,d,x,y,w,hi,title,sub):
    h=120
    rrect_grad(img,d,(x,y,x+w,y+h),26,(247,245,253),(233,229,250),"#e9e3fb")
    # orb
    orb=Image.new("RGBA",(220,220),(0,0,0,0)); od=ImageDraw.Draw(orb)
    od.ellipse([0,0,220,220],fill=(139,118,255,90)); img.paste(orb,(x+w-180,y-90),orb)
    # logo chip
    cw,ch=150,84; cx,cy=x+18,y+(h-ch)//2
    d.rounded_rectangle([cx,cy,cx+cw,cy+ch],18,fill="#ffffff")
    try:
        lg=Image.open(LOGO).convert("RGBA"); lw=110; lh=int(lg.height*lw/lg.width); lg=lg.resize((lw,lh))
        img.paste(lg,(cx+(cw-lw)//2,cy+(ch-lh)//2),lg)
    except Exception as e: print(e)
    tx=cx+cw+22
    d.text((tx,y+24),hi,font=fn(14,True),fill="#8585A8")
    d.text((tx,y+42),title,font=fn(34,True),fill="#7559FB")   # approximates gradient violet
    d.text((tx,y+92),sub,font=fn(13,True),fill="#6b5fa6")
    return y+h+18

def chip(d,x,y,n,label,on):
    w=128;h=46
    d.rounded_rectangle([x,y,x+w,y+h],14,fill="#fff7ee" if on else "#ffffff",
                        outline="#ffd9a8" if on else "#e9e3fb",width=1)
    d.text((x+16,y+11),n,font=fn(19,True),fill="#d98300" if on else "#9a93b5")
    d.text((x+40,y+15),label,font=fn(13,True),fill="#2b2450")
    return x+w+10

W,H=820,980
img=Image.new("RGB",(W,H),"#f4f1fd"); d=ImageDraw.Draw(img)
vgrad(d,(0,0,W,H),(239,234,254),(255,255,255))
M=30
d.text((M,16),"HOME — MANAGER",font=fn(12,True),fill="#8358FD")
y=phero(img,d,M,40,W-2*M,"Good morning,","Khalid","Thursday, 18 June 2026")
# action chips
cx=M
for n,l,on in [("3","Reviews",1),("0","Leave",0),("2","Registrations",1),("1","Swaps",0)]:
    cx=chip(d,cx,y,n,l,on)
y+=64
# today's cases card
ch_h=190
d.rounded_rectangle([M,y,W-M,y+ch_h],22,fill="#ffffff",outline="#ece7fb",width=1)
d.text((M+22,y+18),"Today's cases",font=fn(16,True),fill="#261E4F")
d.text((W-M-260,y+22),"3/4 submitted · 195 cases · 188 patients",font=fn(12),fill="#8585A8")
# progress bar
d.rounded_rectangle([M+22,y+50,W-M-22,y+59],5,fill="#eee7fb")
d.rounded_rectangle([M+22,y+50,M+22+int((W-2*M-44)*0.75),y+59],5,fill="#6B4EFF")
rows=[("NEST 1","41 cases · 62 pt","Submitted",1),("NEST 2","53 cases · 47 pt","Submitted",1),("NEST 4","—","Pending",0)]
ry=y+74
for nm,cs,st,ok in rows:
    d.text((M+22,ry+8),nm,font=fn(13,True),fill="#2b2450")
    d.text((M+200,ry+8),cs,font=fn(12),fill="#555" if ok else "#aaa")
    d.rounded_rectangle([W-M-118,ry+5,W-M-22,ry+27],11,fill="#e3f8f0" if ok else "#fdeccf")
    d.text((W-M-104,ry+9),st,font=fn(11,True),fill="#00A87D" if ok else "#c9880a")
    d.line([M+22,ry+38,W-M-22,ry+38],fill="#f0ecfa"); ry+=40
y+=ch_h+24

d.text((M,y),"DAILY CASES",font=fn(12,True),fill="#8358FD"); y+=24
y=phero(img,d,M,y,W-2*M,"Thursday · Radiology cases per branch","Daily Cases","18 June 2026 · 3/4 branches submitted · 195 cases")
# summary pills
px=M
for t in ["195 total cases","188 patients","3/4 branches submitted"]:
    w=len(t)*7+30
    d.rounded_rectangle([px,y,px+w,y+34],14,fill="#fbf9ff",outline="#e9e3fb",width=1)
    d.text((px+14,y+9),t,font=fn(12,True),fill="#3b3360"); px+=w+10
y+=46
# case cards
cw=(W-2*M-16)//2
for i,(nm,head,done) in enumerate([("NEST 1","✅ Sara",1),("NEST 4","● Pending",0)]):
    cx=M+i*(cw+16)
    d.rounded_rectangle([cx,y,cx+cw,y+120],20,fill="#ffffff",
                        outline="#bfeede" if done else "#ffd9a8",width=1)
    d.text((cx+16,y+14),nm,font=fn(15,True),fill="#261E4F")
    d.text((cx+cw-110,y+16),head,font=fn(12,True),fill="#00A87D" if done else "#c9880a")
    if done:
        d.text((cx+16,y+50),"41",font=fn(26,True),fill="#6B4EFF"); d.text((cx+58,y+62),"cases",font=fn(11),fill="#999")
        d.text((cx+120,y+50),"62",font=fn(26,True),fill="#6B4EFF"); d.text((cx+162,y+62),"patients",font=fn(11),fill="#999")
    else:
        d.text((cx+16,y+58),"No report filed yet",font=fn(13),fill="#999")
img.save("/home/user/meena-scheduling/design_preview.png"); print("saved design")
