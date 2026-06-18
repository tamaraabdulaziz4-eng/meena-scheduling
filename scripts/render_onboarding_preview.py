"""Preview of the premium staff onboarding screen."""
from PIL import Image, ImageDraw, ImageFont

BG="#f3f1fc"; CARD_ALT="#ffffff"; TEXT="#2B2458"; MUTED="#8585A8"; BORDER="#DDD9F5"
ACCENT="#6B4EFF"; PURPLE="#8B76FF"; FIELD="#ffffff"
F="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"; FB="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def fn(s,b=False): return ImageFont.truetype(FB if b else F, s)
def tw(d,s,f): return d.textbbox((0,0),s,font=f)[2]

W,H=440,720
img=Image.new("RGB",(W,H),BG); d=ImageDraw.Draw(img,"RGBA")
# card
cx,cy,cw=24,24,W-48
d.rounded_rectangle([cx,cy,cx+cw,H-24],22,fill=CARD_ALT,outline=BORDER,width=1)
ix=cx+28; x2=cx+cw-28; y=cy+26

# logo (the real Meena lockup)
try:
    logo=Image.open("/home/user/meena-scheduling/dashboard/meena_onboarding_logo.jpeg").convert("RGB")
    lw=190; lh=int(logo.height*lw/logo.width); logo=logo.resize((lw,lh))
    img.paste(logo,(W//2-lw//2,y))
    y+=lh+14
except Exception as e:
    print("logo", e); y+=20

d.text((W//2-tw(d,"Staff Onboarding",fn(20,True))//2,y),"Staff Onboarding",font=fn(20,True),fill=TEXT); y+=30
sub="Welcome! Fill in your details to join the team."
d.text((W//2-tw(d,sub,fn(12))//2,y),sub,font=fn(12),fill=MUTED); y+=30

def label(t):
    global y; d.text((ix,y),t,font=fn(11.5),fill=MUTED); y+=18
def field(ph, val=False):
    global y
    d.rounded_rectangle([ix,y,x2,y+40],10,fill=FIELD,outline=BORDER,width=1)
    d.text((ix+12,y+12),ph,font=fn(13),fill=(TEXT if val else MUTED)); y+=52

label("Full name"); field("Wafa Al-Harbi", True)
label("Branch");
d.rounded_rectangle([ix,y,x2,y+40],10,fill=FIELD,outline=BORDER,width=1)
d.text((ix+12,y+12),"NEST 3",font=fn(13),fill=TEXT); d.text((x2-22,y+13),"▾",font=fn(13),fill=MUTED); y+=52
# section pills
label("Section")
pw=(x2-ix-8)//2
d.rounded_rectangle([ix,y,ix+pw,y+42],12,fill=None,outline=None)
# active pill (gradient approximated)
d.rounded_rectangle([ix,y,ix+pw,y+42],12,fill=PURPLE)
d.text((ix+pw//2-tw(d,"General",fn(13,True))//2,y+13),"General",font=fn(13,True),fill="#ffffff")
d.rounded_rectangle([ix+pw+8,y,x2,y+42],12,fill=CARD_ALT,outline=BORDER,width=1)
d.text((ix+pw+8+(pw)//2-tw(d,"Ultrasound (US)",fn(12,True))//2,y+14),"Ultrasound (US)",font=fn(12,True),fill=TEXT); y+=54
label("Employee / National ID"); field("1098xxxxxx", True)
label("Email"); field("wafa@example.com", True)

# submit
d.rounded_rectangle([ix,y,x2,y+46],12,fill=ACCENT)
d.text((W//2-tw(d,"Submit",fn(14,True))//2,y+13),"Submit",font=fn(14,True),fill="#ffffff")

img.save("/home/user/meena-scheduling/onboarding_preview.png")
print("saved", img.size)
