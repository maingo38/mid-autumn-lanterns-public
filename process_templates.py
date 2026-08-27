#!/usr/bin/env python3
"""Turn dropped lantern art in templates-incoming/ into app templates.

For each PNG/JPG/SVG in templates-incoming/, writes two files to
public/templates/:
  <name>_lines.png  - the artwork with a transparent background (kids colour this)
  <name>_mask.png   - solid white silhouette (clips paint to the lantern shape)

Mask is derived by:
  - transparent-background images  -> the non-transparent region
  - white/solid-background images  -> everything that isn't near-white
Then the silhouette is filled solid so paint can't leak outside the outline.

Usage:
    python3 process_templates.py            # process everything
    python3 process_templates.py ca-chep    # process one file (any extension)

SVG: needs cairosvg (`pip install cairosvg`). If missing, the file is skipped
with a note.
"""
import os, sys
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
IN_DIR = os.path.join(HERE, 'templates-incoming')
OUT_DIR = os.path.join(HERE, 'public', 'templates')
os.makedirs(OUT_DIR, exist_ok=True)

WHITE_CUTOFF = 238          # pixels brighter than this (on white bg) = background
TARGET_MAX = 900            # normalise big art down to this on the long edge


def load_rgba(path):
    """Load any input as RGBA. SVG via cairosvg if available."""
    ext = os.path.splitext(path)[1].lower()
    if ext == '.svg':
        try:
            import cairosvg, io
            png_bytes = cairosvg.svg2png(url=path, output_width=TARGET_MAX)
            return Image.open(io.BytesIO(png_bytes)).convert('RGBA')
        except ImportError:
            print(f"  ! {os.path.basename(path)}: SVG needs cairosvg — run: pip install cairosvg  (skipped)")
            return None
    return Image.open(path).convert('RGBA')


def make_mask(img):
    """Return an L-mode silhouette (255 = inside lantern)."""
    w, h = img.size
    px = img.load()
    mask = Image.new('L', (w, h), 0)
    mpx = mask.load()

    # does the image actually use transparency?
    alphas = img.getchannel('A').getextrema()
    has_transparency = alphas[0] < 250

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if has_transparency:
                inside = a > 40
            else:
                # white/near-white background = outside
                inside = not (r >= WHITE_CUTOFF and g >= WHITE_CUTOFF and b >= WHITE_CUTOFF)
            mpx[x, y] = 255 if inside else 0

    # clean up: close small gaps, then fill so the whole shape is solid
    mask = mask.filter(ImageFilter.MaxFilter(5))    # dilate a touch
    mask = _flood_fill_interior(mask)
    mask = mask.filter(ImageFilter.MinFilter(5))    # erode back
    return mask


def _flood_fill_interior(mask):
    """Fill holes: anything NOT reachable from the border becomes inside."""
    from collections import deque
    w, h = mask.size
    mpx = mask.load()
    outside = Image.new('L', (w, h), 0)
    opx = outside.load()
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if mpx[x, y] == 0 and opx[x, y] == 0:
                opx[x, y] = 255; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if mpx[x, y] == 0 and opx[x, y] == 0:
                opx[x, y] = 255; q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < w and 0 <= ny < h and mpx[nx,ny] == 0 and opx[nx,ny] == 0:
                opx[nx,ny] = 255; q.append((nx,ny))
    # inside = background pixels the border flood could NOT reach + original shape
    filled = Image.new('L', (w, h), 0)
    fpx = filled.load()
    for y in range(h):
        for x in range(w):
            fpx[x, y] = 255 if (mpx[x,y] == 255 or opx[x,y] == 0) else 0
    return filled


def make_lines(img, has_white_bg):
    """Artwork with transparent background so kids colour underneath the outline."""
    if not has_white_bg:
        return img            # already transparent bg
    w, h = img.size
    px = img.load()
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    opx = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r >= WHITE_CUTOFF and g >= WHITE_CUTOFF and b >= WHITE_CUTOFF:
                opx[x, y] = (0, 0, 0, 0)          # drop white bg
            else:
                opx[x, y] = (r, g, b, a)
    return out


def fit(img):
    w, h = img.size
    scale = TARGET_MAX / max(w, h)
    if scale < 1:
        img = img.resize((round(w*scale), round(h*scale)), Image.LANCZOS)
    return img


def process(path):
    name = os.path.splitext(os.path.basename(path))[0]
    img = load_rgba(path)
    if img is None:
        return False
    img = fit(img)
    alphas = img.getchannel('A').getextrema()
    has_white_bg = alphas[0] >= 250     # no transparency -> assume white bg

    mask = make_mask(img)
    lines = make_lines(img, has_white_bg)

    mask_rgba = Image.new('RGBA', mask.size, (255, 255, 255, 0))
    mask_rgba.putalpha(mask)            # white where inside, transparent outside

    lines.save(os.path.join(OUT_DIR, f'{name}_lines.png'))
    mask_rgba.save(os.path.join(OUT_DIR, f'{name}_mask.png'))
    print(f"  ✓ {name}  ->  {name}_lines.png + {name}_mask.png"
          f"   ({'transparent bg' if not has_white_bg else 'white bg removed'})")
    return True


def main():
    if not os.path.isdir(IN_DIR):
        sys.exit(f"no folder: {IN_DIR}")
    only = sys.argv[1] if len(sys.argv) > 1 else None
    exts = ('.png', '.jpg', '.jpeg', '.svg')
    files = [f for f in sorted(os.listdir(IN_DIR))
             if f.lower().endswith(exts)
             and (only is None or os.path.splitext(f)[0] == only)]
    if not files:
        print("Nothing to process. Drop PNG/JPG/SVG lantern files into templates-incoming/ first.")
        return
    print(f"Processing {len(files)} file(s) from templates-incoming/ ...")
    done = sum(process(os.path.join(IN_DIR, f)) for f in files)
    print(f"\nDone: {done} template(s) ready in public/templates/")
    print("Open one on a phone with  ?t=<name>  e.g.  http://<laptop-ip>:3000/?t=" +
          os.path.splitext(files[0])[0])


if __name__ == '__main__':
    main()
