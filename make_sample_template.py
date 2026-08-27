#!/usr/bin/env python3
"""Generate a placeholder 'star' lantern template so the app runs before the
designer delivers real art. Produces two PNGs in public/templates/:
  star_lines.png  - black outline, transparent inside (kids colour into this)
  star_mask.png   - solid white silhouette on transparent (clips paint to shape)
Replace both with real designed lanterns later, same names / same size.
"""
import math, os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), 'public', 'templates')
os.makedirs(OUT, exist_ok=True)
SIZE = 700

def star_points(cx, cy, outer, inner, n=5, rot=-math.pi/2):
    pts = []
    for i in range(n*2):
        r = outer if i % 2 == 0 else inner
        a = rot + i*math.pi/n
        pts.append((cx + r*math.cos(a), cy + r*math.sin(a)))
    return pts

cx = cy = SIZE//2
pts = star_points(cx, cy, SIZE*0.44, SIZE*0.18)

# --- mask: solid silhouette ---
mask = Image.new('RGBA', (SIZE, SIZE), (0,0,0,0))
ImageDraw.Draw(mask).polygon(pts, fill=(255,255,255,255))
mask.save(os.path.join(OUT, 'star_mask.png'))

# --- line art: thick black outline, transparent inside ---
lines = Image.new('RGBA', (SIZE, SIZE), (0,0,0,0))
d = ImageDraw.Draw(lines)
d.line(pts + [pts[0]], fill=(0,0,0,255), width=10, joint='curve')
# little tassel hint at the bottom point
d.line([(cx, cy+SIZE*0.44), (cx, cy+SIZE*0.49)], fill=(0,0,0,255), width=6)
lines.save(os.path.join(OUT, 'star_lines.png'))

print('wrote', os.path.join(OUT, 'star_lines.png'))
print('wrote', os.path.join(OUT, 'star_mask.png'))
