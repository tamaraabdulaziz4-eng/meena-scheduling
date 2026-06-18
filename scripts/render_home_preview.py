"""Faithful PNG preview of the redesigned Home dashboard (hero + KPI cards +
today's cases bar), using the real palette from dashboard/style.css."""
from PIL import Image, ImageDraw, ImageFont

BG="#f3f1fc"; CARD="#EEF0FB"; CARD_ALT="#ffffff"; TEXT="#2B2458"; MUTED="#8585A8"
BORDER="#DDD9F5"; ACCENT="#6B4EFF"; GREEN="#00A87C"; ORANGE="#d98300"; PURPLE="#8B76FF"
F="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"; FB="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def fn(s,b=False): return ImageFont.truetype(FB if b else F, s)
def tw(d,s,f): return d.textbbox((0,0),s,font=f)[2]

W,H=1000,640
img=Image.new("RGB",(W,H),BG); d=ImageDraw.Draw(img,"RGBA")
PAD=32

# ── hero ──
hx,hy,hw,hh=PAD,28,W-2*PAD,128
d.rounded_rectangle([hx,hy,hx+hw,hy+hh],22,fill="#2B2458")
d.ellipse([hx+hw-230,hy-90,hx+hw+40,hy+150],fill=(139,118,255,70))
d.text((hx+28,hy+24),"Good morning,",font=fn(15),fill=(255,255,255,210))
d.text((hx+28,hy+44),"Khalid",font=fn(28,True),fill="#ffffff")
d.text((hx+28,hy+90),"Administrator · Thursday, 18 June 2026 · 2 ذو الحجة 1447 هـ",font=fn(12),fill=(255,255,255,180))
# logo chip
d.rounded_rectangle([hx+hw-92,hy+38,hx+hw-28,hy+90],14,fill=(255,255,255,32))
d.text((hx+hw-78,hy+55),"MEENA",font=fn(11,True),fill="#ffffff")

# ── section label ──
ly=hy+hh+22
d.text((PAD+2,ly),"NEEDS YOUR ATTENTION",font=fn(12,True),fill=MUTED)

# ── KPI cards ──
cards=[("Schedules to review","2",ACCENT,True),
       ("Leave requests","3",GREEN,True),
       ("New registrations","1",PURPLE,True),
       ("Swaps awaiting you","0",ORANGE,False)]
cy=ly+26; cw=(W-2*PAD-3*16)//4; ch=132
for i,(label,val,color,alert) in enumerate(cards):
    cx=PAD+i*(cw+16)
    d.rounded_rectangle([cx,cy,cx+cw,cy+ch],18,fill=CARD_ALT,outline=(217,217,245,255),width=1)
    # icon chip
    def hx2(c): return tuple(int(c[j:j+2],16) for j in (1,3,5))
    r,g,b=hx2(color)
    d.rounded_rectangle([cx+18,cy+18,cx+18+42,cy+18+42],12,fill=(r,g,b,26))
    d.text((cx+30,cy+28),"●",font=fn(20,True),fill=color)
    if alert:
        d.ellipse([cx+cw-30,cy+24,cx+cw-22,cy+32],fill="#FF6B6B")
    d.text((cx+18,cy+72),val,font=fn(32,True),fill=TEXT if not alert else (ORANGE if i==3 else TEXT))
    d.text((cx+18,cy+110),label,font=fn(12.5,True),fill=TEXT)

# ── today's cases bar ──
by=cy+ch+22; bw=W-2*PAD; bh=110
d.rounded_rectangle([PAD,by,PAD+bw,by+bh],18,fill=CARD_ALT,outline=(217,217,245,255),width=1)
d.text((PAD+22,by+20),"📊 Today's cases",font=fn(15,True),fill=TEXT)
d.text((PAD+22,by+44),"4 of 6 branches submitted — 2 pending",font=fn(12),fill=MUTED)
d.text((PAD+bw-92,by+22),"67%",font=fn(26,True),fill=ACCENT)
# progress bar
pbx,pby,pbw=PAD+22,by+76,bw-44
d.rounded_rectangle([pbx,pby,pbx+pbw,pby+10],5,fill=CARD)
d.rounded_rectangle([pbx,pby,pbx+int(pbw*0.67),pby+10],5,fill=PURPLE)

img.save("/home/user/meena-scheduling/home_preview.png")
print("saved", img.size)
