from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

sizes = [16, 32, 64, 128, 256, 512, 1024]
out = Path('build/icon.iconset')
out.mkdir(parents=True, exist_ok=True)

bg = (255, 111, 0)
fg = (255, 255, 255)

for s in sizes:
    im = Image.new('RGBA', (s, s), bg)
    d = ImageDraw.Draw(im)
    r = int(s * 0.22)
    d.rounded_rectangle((0,0,s-1,s-1), radius=r, fill=bg)
    text = 'D'
    # fallback font
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', int(s*0.62))
    except Exception:
        font = ImageFont.load_default()
    bbox = d.textbbox((0,0), text, font=font)
    tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
    d.text(((s-tw)/2, (s-th)/2 - s*0.03), text, font=font, fill=fg)

    if s <= 512:
        im.save(out / f'icon_{s}x{s}.png')
        if s in [16,32,128,256,512]:
            im2 = im.resize((s*2, s*2), Image.Resampling.LANCZOS)
            im2.save(out / f'icon_{s}x{s}@2x.png')

# ensure 512@2x from 1024
im1024 = Image.new('RGBA', (1024,1024), bg)
d = ImageDraw.Draw(im1024)
r = int(1024*0.22)
d.rounded_rectangle((0,0,1023,1023), radius=r, fill=bg)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', int(1024*0.62))
except Exception:
    font = ImageFont.load_default()
bbox = d.textbbox((0,0), 'D', font=font)
tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
d.text(((1024-tw)/2, (1024-th)/2 - 1024*0.03), 'D', font=font, fill=fg)
im1024.save(out / 'icon_512x512@2x.png')

print('iconset generated')
