"""Render a side-by-side comparison of the 4 sidebar colour options."""
from PIL import Image, ImageDraw, ImageFont
F="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"; FB="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def fn(s,b=False): return ImageFont.truetype(FB if b else F, s)
def tw(d,s,f): return d.textbbox((0,0),s,font=f)[2]

NAV = ["Home","Schedule","Staff","Leave","Swaps","Daily Cases"]
# name, [grad top, grad bottom], text rgba, active bg rgba, active text, logobox
OPTS = [
  ("Navy",  [(36,48,92),(20,30,64)],   (255,255,255,180),(255,255,255,40),(255,255,255,255),(107,78,255)),
  ("Slate", [(46,52,64),(28,32,42)],   (255,255,255,170),(255,255,255,38),(255,255,255,255),(120,130,150)),
  ("Light", [(255,255,255),(245,246,252)],(70,68,110,255),(107,78,255,28),(43,36,88,255),(107,78,255)),
  ("Teal",  [(16,61,58),(9,40,38)],    (255,255,255,180),(0,200,150,55),(255,255,255,255),(0,168,124)),
]
SBW, GAP, PAD = 215, 22, 26
H = 470
W = PAD*2 + len(OPTS)*SBW + (len(OPTS)-1)*GAP
img=Image.new("RGB",(W,H),"#eceaf6"); d=ImageDraw.Draw(img,"RGBA")

for i,(name,grad,txt,abg,atxt,logo) in enumerate(OPTS):
    x=PAD+i*(SBW+GAP); y=46; h=H-72
    # gradient fill
    panel=Image.new("RGB",(SBW,h)); pd=ImageDraw.Draw(panel)
    for yy in range(h):
        t=yy/h
        c=tuple(int(grad[0][k]+(grad[1][k]-grad[0][k])*t) for k in range(3))
        pd.line([(0,yy),(SBW,yy)],fill=c)
    # round corners via mask
    mask=Image.new("L",(SBW,h),0); md=ImageDraw.Draw(mask); md.rounded_rectangle([0,0,SBW,h],22,fill=255)
    img.paste(panel,(x,y),mask)
    light = name=="Light"
    if light: d.rounded_rectangle([x,y,x+SBW,y+h],22,outline=(221,217,245,255),width=1)
    # label above
    d.text((x+4,y-30),name,font=fn(15,True),fill="#2B2458")
    # logo box
    d.rounded_rectangle([x+18,y+20,x+SBW-18,y+78],16,fill=logo)
    d.text((x+SBW//2-tw(d,"meena",fn(17,True))//2,y+38),"meena",font=fn(17,True),fill="#ffffff")
    d.text((x+18,y+92),"STAFF SCHEDULING",font=fn(8,True),fill=(txt[:3]+ (120,)) if len(txt)==4 else txt)
    # nav items
    ny=y+120
    for j,item in enumerate(NAV):
        active = (j==0)
        iy=ny+j*42
        if active:
            d.rounded_rectangle([x+12,iy,x+SBW-12,iy+34],11,fill=abg)
        # icon dot
        dotc = atxt if active else txt
        d.ellipse([x+22,iy+11,x+34,iy+23],outline=dotc,width=2)
        d.text((x+44,iy+9),item,font=fn(13, active),fill=(atxt if active else txt))

img.save("/home/user/meena-scheduling/sidebar_options.png")
print("saved",img.size)
