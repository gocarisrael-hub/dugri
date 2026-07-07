#!/usr/bin/env python3
"""Auto-detect a per-template RECIPE from a text-filled full-deck page.

A recipe captures, for each of the 8 card positions on the page, WHERE the
personalized text sits: the title slot and the 4 word slots (baseline,
right-edge, height, colour). It is detected once from the example page (which
still has text) and then reused to lay customer text onto the clean, text-free
background.

Everything is stored in SVG user units (the page viewBox), so it maps straight
onto the background SVG regardless of render resolution.

  python3 generator/recipe.py "resources/canva/full deck/דוגרי רווקות חדש/1.svg" רווקות
"""
import json
import os
import subprocess
import sys
from collections import Counter
from PIL import Image, ImageDraw, ImageFont, ImageFilter

CHROME = os.environ.get(
    "CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
HERE = os.path.dirname(os.path.abspath(__file__))
SCALE = 2


def page_dims(svg):
    head = open(svg, encoding="utf-8").read(2000)
    import re
    w = int(re.search(r'width="(\d+)"', head).group(1))
    h = int(re.search(r'height="(\d+)"', head).group(1))
    vb = re.search(r'viewBox="([^"]+)"', head).group(1).split()
    return w, h, [float(x) for x in vb]  # render w,h ; viewBox x,y,w,h


def render(svg, png, w, h):
    subprocess.run([CHROME, "--headless", "--disable-gpu",
                    f"--force-device-scale-factor={SCALE}",
                    f"--screenshot={png}", f"--window-size={w},{h}", svg],
                   check=True, stderr=subprocess.DEVNULL)


def dist(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])


def dominant(im):
    return Counter(im.resize((60, 60)).getdata()).most_common(1)[0][0]


def bands_from_profile(profile, lo_frac, min_run):
    """Given a 1-D count profile, return [ (start,end) ] runs above threshold."""
    hi = max(profile)
    thr = hi * lo_frac
    runs = []
    i = 0
    n = len(profile)
    while i < n:
        if profile[i] > thr:
            j = i
            while j < n and profile[j] > thr:
                j += 1
            if j - i >= min_run:
                runs.append((i, j))
            i = j
        else:
            i += 1
    return runs


def grid_cells(img, page_bg):
    """Split the page into card cells via card-pixel projection (gutters=white)."""
    w, h = img.size
    px = img.load()
    step = 2
    nx, ny = w // step, h // step
    sx = [0] * nx
    sy = [0] * ny
    for yi in range(ny):
        y = yi * step
        for xi in range(nx):
            if dist(px[xi * step, y], page_bg) > 60:
                sx[xi] += 1
                sy[yi] += 1
    cols = [(a * step, b * step) for (a, b) in bands_from_profile(sx, 0.12, int(0.05 * nx))]
    rows = [(a * step, b * step) for (a, b) in bands_from_profile(sy, 0.12, int(0.05 * ny))]
    cells = []
    for (ry0, ry1) in rows:
        for (cx0, cx1) in cols:
            cells.append((cx0, ry0, cx1, ry1))
    return cells, cols, rows


def ink_mask(card, delta=26):
    g = card.convert("L")
    bg = g.filter(ImageFilter.GaussianBlur(radius=max(5, card.width // 30)))
    gp, bp = g.load(), bg.load()
    w, h = card.size
    m = Image.new("1", (w, h), 0)
    mp = m.load()
    for y in range(h):
        for x in range(w):
            if abs(gp[x, y] - bp[x, y]) > delta:
                mp[x, y] = 1
    return m


def detect_rows(card):
    w, h = card.size
    m = ink_mask(card)
    px = m.load()
    ix0, ix1 = int(0.05 * w), int(0.95 * w)
    rowink = []
    xext = []
    for y in range(h):
        cnt = 0; xmin = 10 ** 9; xmax = -1
        for x in range(ix0, ix1):
            if px[x, y]:
                cnt += 1
                if x < xmin: xmin = x
                if x > xmax: xmax = x
        rowink.append(cnt)
        xext.append((xmin, xmax))
    thr = max(3, int(0.015 * (ix1 - ix0)))
    bands = []
    y = 0
    while y < h:
        if rowink[y] > thr:
            y0 = y
            while y < h and rowink[y] > thr:
                y += 1
            y1 = y
            if y1 - y0 >= 0.02 * h:
                xs = [xext[k][0] for k in range(y0, y1) if xext[k][1] > 0]
                xe = [xext[k][1] for k in range(y0, y1) if xext[k][1] > 0]
                if xs:
                    bands.append([y0, y1, min(xs), max(xe)])
        else:
            y += 1
    return bands


def classify(bands, w, h):
    """Pick 4 evenly-spaced word rows; title = extended band above OR below."""
    import itertools
    feats = [dict(y0=b[0], y1=b[1], x0=b[2], x1=b[3],
                  cy=(b[0] + b[1]) / 2 / h, bh=(b[1] - b[0]) / h, ww=(b[3] - b[2]) / w)
             for b in bands]
    cand = [f for f in feats if f["ww"] > 0.16 and 0.02 < f["bh"] < 0.16]
    cand.sort(key=lambda f: f["cy"])
    if len(cand) < 4:
        return None, cand

    def score(group):
        g = sorted(group, key=lambda f: f["cy"])
        gaps = [g[i + 1]["cy"] - g[i]["cy"] for i in range(3)]
        hs = [x["bh"] for x in g]
        mg = sum(gaps) / 3; mh = sum(hs) / 4
        return (sum((x - mg) ** 2 for x in gaps) / 3 +
                sum((x - mh) ** 2 for x in hs) / 4)

    words = sorted(min(itertools.combinations(cand, 4), key=score), key=lambda f: f["cy"])
    wtop, wbot = words[0]["cy"], words[-1]["cy"]
    # title = nearest extended band outside the word group (above preferred)
    above = [f for f in cand if f["cy"] < wtop - 0.03]
    below = [f for f in cand if f["cy"] > wbot + 0.03]
    title = above[-1:] if above else (below[:1] if below else [])
    return dict(words=words, title=title[0] if title else None), cand


def sample_color(card, f):
    """Darkest-avg colour inside a slot (its ink)."""
    def lum(c): return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    crop = card.crop((f["x0"], f["y0"], f["x1"], f["y1"]))
    px = list(crop.getdata()); px.sort(key=lum)
    k = max(1, len(px) // 8); sel = px[:k]
    return tuple(sum(p[i] for p in sel) // len(sel) for i in range(3))


def main():
    svg = sys.argv[1]
    theme = sys.argv[2] if len(sys.argv) > 2 else "theme"
    rw, rh, vb = page_dims(svg)
    RW, RH = rw * SCALE, rh * SCALE
    ppu = RW / vb[2]                       # render px per SVG user unit
    png = f"/tmp/gen/{theme}_page.png"
    os.makedirs("/tmp/gen", exist_ok=True)
    render(svg, png, rw, rh)
    img = Image.open(png).convert("RGB")
    page_bg = dominant(img.crop((0, 0, 40, 40)))
    cells, cols, rows = grid_cells(img, page_bg)
    print(f"grid: {len(cols)} cols x {len(rows)} rows = {len(cells)} cells")

    vis = img.copy(); d = ImageDraw.Draw(vis)
    recipe = {"theme": theme, "viewBox": vb, "cards": []}
    for (cx0, cy0, cx1, cy1) in cells:
        d.rectangle([cx0, cy0, cx1, cy1], outline=(0, 120, 255), width=2)
        card = img.crop((cx0, cy0, cx1, cy1))
        res, cand = classify(detect_rows(card), card.width, card.height)
        if not res:
            recipe["cards"].append(None)
            continue

        def to_user(f, absx=cx0, absy=cy0):
            return dict(x0=(absx + f["x0"]) / ppu, y0=(absy + f["y0"]) / ppu,
                        x1=(absx + f["x1"]) / ppu, y1=(absy + f["y1"]) / ppu)
        card_entry = {"cell": [cx0 / ppu, cy0 / ppu, cx1 / ppu, cy1 / ppu], "words": []}
        for wf in res["words"]:
            u = to_user(wf)
            u["color"] = "#%02x%02x%02x" % sample_color(card, wf)
            card_entry["words"].append(u)
            d.rectangle([cx0 + wf["x0"], cy0 + wf["y0"], cx0 + wf["x1"], cy0 + wf["y1"]],
                        outline=(255, 0, 0), width=3)
        if res["title"]:
            tf = res["title"]; u = to_user(tf)
            u["color"] = "#%02x%02x%02x" % sample_color(card, tf)
            card_entry["title"] = u
            d.rectangle([cx0 + tf["x0"], cy0 + tf["y0"], cx0 + tf["x1"], cy0 + tf["y1"]],
                        outline=(0, 170, 0), width=3)
        recipe["cards"].append(card_entry)

    ok = sum(1 for c in recipe["cards"] if c and len(c["words"]) == 4)
    print(f"cards with 4 words detected: {ok}/{len(cells)}")
    out = os.path.join(HERE, "recipes", f"{theme}.json")
    json.dump(recipe, open(out, "w"), ensure_ascii=False, indent=1)
    vis.save(f"/tmp/gen/{theme}_recipe.png")
    print("wrote", out, "and /tmp/gen/%s_recipe.png" % theme)


if __name__ == "__main__":
    main()
