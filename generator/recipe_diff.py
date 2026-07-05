#!/usr/bin/env python3
"""Bulletproof recipe detection by DIFFING text-filled vs clean background.

The clean export is the text-filled page minus the text, so
    |text_filled - clean|  ==  exactly the personalized text
with zero decoration/background confusion. We grid-split into the 8 cards and
cluster the diff pixels per card into title + 4 word slots.

  python3 generator/recipe_diff.py <text_svg> <clean_svg> <theme>
"""
import json
import os
import subprocess
import sys
import re
from collections import Counter
from PIL import Image, ImageDraw, ImageChops

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = os.path.dirname(os.path.abspath(__file__))
SCALE = 2


def dims(svg):
    head = open(svg, encoding="utf-8").read(2000)
    w = int(re.search(r'width="(\d+)"', head).group(1))
    h = int(re.search(r'height="(\d+)"', head).group(1))
    vb = [float(x) for x in re.search(r'viewBox="([^"]+)"', head).group(1).split()]
    return w, h, vb


def render(svg, png, w, h):
    subprocess.run([CHROME, "--headless", "--disable-gpu",
                    f"--force-device-scale-factor={SCALE}",
                    f"--screenshot={png}", f"--window-size={w},{h}", svg],
                   check=True, stderr=subprocess.DEVNULL)


def diff_mask(text_img, clean_img, thr=45):
    d = ImageChops.difference(text_img, clean_img).convert("L")
    return d.point(lambda v: 255 if v > thr else 0)


def bands(profile, lo_frac, min_run):
    hi = max(profile) or 1
    t = hi * lo_frac
    out = []
    i = 0
    n = len(profile)
    while i < n:
        if profile[i] > t:
            j = i
            while j < n and profile[j] > t:
                j += 1
            if j - i >= min_run:
                out.append((i, j))
            i = j
        else:
            i += 1
    return out


def grid_cells(clean, page_bg):
    w, h = clean.size
    px = clean.load()
    step = 2
    nx, ny = w // step, h // step
    sx = [0] * nx; sy = [0] * ny
    for yi in range(ny):
        y = yi * step
        for xi in range(nx):
            p = px[xi * step, y]
            if abs(p[0] - page_bg[0]) + abs(p[1] - page_bg[1]) + abs(p[2] - page_bg[2]) > 60:
                sx[xi] += 1; sy[yi] += 1
    cols = [(a * step, b * step) for a, b in bands(sx, 0.12, int(0.05 * nx))]
    rows = [(a * step, b * step) for a, b in bands(sy, 0.12, int(0.05 * ny))]
    return [(cx0, ry0, cx1, ry1) for ry0, ry1 in rows for cx0, cx1 in cols], cols, rows


def rows_in_cell(mask, cell):
    cx0, cy0, cx1, cy1 = cell
    sub = mask.crop(cell)
    w, h = sub.size
    px = sub.load()
    rowc = []
    xext = []
    for y in range(h):
        c = 0; xmn = 10**9; xmx = -1
        for x in range(w):
            if px[x, y]:
                c += 1
                if x < xmn: xmn = x
                if x > xmx: xmx = x
        rowc.append(c); xext.append((xmn, xmx))
    thr = max(2, int(0.01 * w))
    out = []
    y = 0
    while y < h:
        if rowc[y] > thr:
            y0 = y
            while y < h and rowc[y] > thr:
                y += 1
            y1 = y
            xs = [xext[k][0] for k in range(y0, y1) if xext[k][1] >= 0]
            xe = [xext[k][1] for k in range(y0, y1) if xext[k][1] >= 0]
            if xs and (y1 - y0) >= 0.015 * h:
                out.append([y0, y1, min(xs), max(xe)])
        else:
            y += 1
    return out


def group_words(rows, h):
    """4 word rows = the 4 evenly-spaced similar-height rows; title = the rest above."""
    import itertools
    feats = [dict(y0=r[0], y1=r[1], x0=r[2], x1=r[3],
                  cy=(r[0]+r[1])/2/h, bh=(r[1]-r[0])/h) for r in rows]
    feats.sort(key=lambda f: f["cy"])
    if len(feats) < 4:
        return None
    if len(feats) == 4:
        words = feats
    else:
        def sc(g):
            g = sorted(g, key=lambda f: f["cy"])
            gaps = [g[i+1]["cy"]-g[i]["cy"] for i in range(3)]
            mg = sum(gaps)/3
            return sum((x-mg)**2 for x in gaps)
        words = sorted(min(itertools.combinations(feats, 4), key=sc), key=lambda f: f["cy"])
    wtop = words[0]["cy"]
    title = [f for f in feats if f["cy"] < wtop - 0.02]
    return dict(words=words, title=title)


def color_of(text_img, cell, f):
    def lum(c): return 0.299*c[0]+0.587*c[1]+0.114*c[2]
    cx0, cy0 = cell[0], cell[1]
    crop = text_img.crop((cx0+f["x0"], cy0+f["y0"], cx0+f["x1"], cy0+f["y1"]))
    px = list(crop.getdata()); px.sort(key=lum)
    k = max(1, len(px)//8); s = px[:k]
    return "#%02x%02x%02x" % tuple(sum(p[i] for p in s)//len(s) for i in range(3))


def main():
    text_svg, clean_svg, theme = sys.argv[1], sys.argv[2], sys.argv[3]
    w, h, vb = dims(clean_svg)
    ppu = (w * SCALE) / vb[2]
    render(text_svg, "/tmp/gen/_t.png", w, h)
    render(clean_svg, "/tmp/gen/_c.png", w, h)
    tim = Image.open("/tmp/gen/_t.png").convert("RGB")
    cim = Image.open("/tmp/gen/_c.png").convert("RGB")
    if tim.size != cim.size:
        cim = cim.resize(tim.size)
    mask = diff_mask(tim, cim)
    page_bg = Counter(cim.crop((0, 0, 40, 40)).getdata()).most_common(1)[0][0]
    cells, cols, rows = grid_cells(cim, page_bg)
    print(f"grid {len(cols)}x{len(rows)} = {len(cells)} cells")

    vis = tim.copy(); d = ImageDraw.Draw(vis)
    recipe = {"theme": theme, "viewBox": vb, "cards": []}
    ok = 0
    for cell in cells:
        cx0, cy0, cx1, cy1 = cell
        d.rectangle(cell, outline=(0, 120, 255), width=2)
        g = group_words(rows_in_cell(mask, cell), cy1 - cy0)
        if not g:
            recipe["cards"].append(None); continue
        ok += 1

        def U(f):
            return dict(x0=(cx0+f["x0"])/ppu, y0=(cy0+f["y0"])/ppu,
                        x1=(cx0+f["x1"])/ppu, y1=(cy0+f["y1"])/ppu)
        entry = {"cell": [cx0/ppu, cy0/ppu, cx1/ppu, cy1/ppu], "words": [], "title": []}
        for f in g["words"]:
            u = U(f); u["color"] = color_of(tim, cell, f); entry["words"].append(u)
            d.rectangle([cx0+f["x0"], cy0+f["y0"], cx0+f["x1"], cy0+f["y1"]], outline=(255, 0, 0), width=3)
        for f in g["title"]:
            u = U(f); u["color"] = color_of(tim, cell, f); entry["title"].append(u)
            d.rectangle([cx0+f["x0"], cy0+f["y0"], cx0+f["x1"], cy0+f["y1"]], outline=(0, 200, 0), width=3)
        recipe["cards"].append(entry)

    print(f"cards ok (4 words): {sum(1 for c in recipe['cards'] if c and len(c['words'])==4)}/{len(cells)}")
    os.makedirs(os.path.join(HERE, "recipes"), exist_ok=True)
    json.dump(recipe, open(os.path.join(HERE, "recipes", f"{theme}.json"), "w"),
              ensure_ascii=False, indent=1)
    vis.save(f"/tmp/gen/{theme}_recipe.png")
    mask.save(f"/tmp/gen/{theme}_diffmask.png")
    print("wrote recipe + /tmp/gen/%s_recipe.png + _diffmask.png" % theme)


if __name__ == "__main__":
    main()
