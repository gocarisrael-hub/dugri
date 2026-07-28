#!/usr/bin/env python3
"""Bulletproof recipe detection by DIFFING text-filled vs clean background.

The clean export is the text-filled page minus the text, so
    |text_filled - clean|  ==  exactly the personalized text
with zero decoration/background confusion. We cluster the diff pixels into
title + 4 word slots.

Two template STRUCTURES are supported, and the detector is the same one for
both — only what it is fed changes:

  v1 "sheet"   one landscape A4 ``fronts.svg`` holding 8 cards. Grid-split into
               the 8 cells, then cluster each cell. Emits a ``cards[]`` recipe.
  v2 "single"  a portrait card per file — ``clean/1.svg`` (the back) and
               ``clean/2.svg``..``9.svg`` (8 fronts differing only by a small
               icon), each with a text-filled twin in ``filled/``. There is no
               grid: the whole page IS the card, so the cell is the viewBox and
               the same banding machinery is handed the entire render. Emits a
               ``format: 2`` recipe — the shape locked in
               docs/card-structure-schema.md ("Recipe format v2").

  python3 generator/recipe_diff.py <text_svg> <clean_svg> <theme>   # v1 sheet
  python3 generator/recipe_diff.py --single <template_dir> <theme>  # v2 deck
"""
import json
import os
import statistics
import subprocess
import sys
import re
import tempfile
from collections import Counter
from PIL import Image, ImageDraw, ImageChops

CHROME = os.environ.get(
    "CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
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


# ---- v2: single-card deck --------------------------------------------------
# Everything below detects the PORTRAIT SINGLE CARD layout. It deliberately
# reuses ``diff_mask`` / ``rows_in_cell`` / ``group_words`` / ``color_of``
# unchanged: those already work, they were simply being fed one cell of an 8-up
# grid. Feed them the whole card and the same clustering applies. What is new is
# the reconciliation ACROSS the eight fronts, which the sheet layout never had
# to do because it only ever saw one surface.

DEFAULT_FRONTS = [2, 3, 4, 5, 6, 7, 8, 9]
DEFAULT_BACK_INDEX = 1

# A detected text box larger than this share of the card is not text — it means
# the filled and clean exports differ across the whole page (a background one
# carries and the other doesn't) and the diff caught the artwork itself. Same
# constant, and the same reasoning, as ``calibrate._MAX_SLOT_AREA``: reporting
# nothing beats writing a confident, wrong slot into the recipe.
_MAX_TEXT_AREA = 0.45


def template_layout(template_dir):
    """``"single"`` when a template ships the v2 numbered deck, else ``"sheet"``.

    STRUCTURE, not configuration. Detection runs at UPLOAD time, before anything
    has written ``card_layout`` into themes.json, so the only thing that can be
    asked is what the folder actually contains. v1 wins a tie: a folder that
    somehow ships both keeps rendering through the path its recipe describes
    today, so no migrated-by-accident template changes shape underneath a
    calibrated theme.
    """
    clean = os.path.join(template_dir, "clean")
    if os.path.exists(os.path.join(clean, "fronts.svg")):
        return "sheet"
    if (os.path.exists(os.path.join(clean, f"{DEFAULT_BACK_INDEX}.svg"))
            and os.path.exists(os.path.join(clean, f"{DEFAULT_FRONTS[0]}.svg"))):
        return "single"
    return "sheet"


def viewport(vb, w, h):
    """``(ppu, ox, oy)`` mapping viewBox user units onto the screenshot pixels.

    Every Canva export carries ``preserveAspectRatio="xMidYMid meet"``, so the
    art is scaled by the SMALLER of the two axis ratios and centred in the
    window — it never stretches to fill it. The v1 sheets got away with a plain
    ``w*SCALE/vb[2]`` because an A4 window matches an A4 viewBox to within a
    rounding error. A 299x416 window against a 223.92x312 card does not: the
    two ratios differ by 0.15%, which is half a user unit by the foot of the
    card and lands entirely on the bottom word slot. So do the real mapping —
    one uniform scale plus the centring offset — and convert with
    ``(px - o) / ppu``.
    """
    ppu = min(w * SCALE / vb[2], h * SCALE / vb[3])
    return ppu, (w * SCALE - vb[2] * ppu) / 2.0, (h * SCALE - vb[3] * ppu) / 2.0


def _renderable(svg_path, workdir, tag):
    """The path to hand Chrome, with any de-duplicated background resolved.

    A migrated template stores its multi-megabyte background ONCE per theme and
    references it from each card as ``../assets/<sha>.png``
    (docs/card-structure-schema.md 4). That relative href resolves against the
    SVG's own directory, so it survives being handed to Chrome in place — but
    NOT being copied elsewhere. ``card_assets.read_svg`` absolutizes it, which is
    what makes a temp copy safe; without that, detection would diff two
    backgroundless cards and happily "measure" whatever the missing artwork
    exposed.

    A temp copy is only written when reading actually changed something, so an
    unmigrated template still hands Chrome the original file untouched.
    """
    try:
        import card_assets
    except ImportError:  # card_assets is optional for the v1 path
        return svg_path
    text = card_assets.read_svg(svg_path)
    with open(svg_path, encoding="utf-8") as f:
        if f.read() == text:
            return svg_path
    out = os.path.join(workdir, tag)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    return out


def card_diff(filled_svg, clean_svg, workdir, tag="card"):
    """Render one card's filled/clean pair and return the ink and its mapping.

    Returns ``(mask, filled_image, vb, ppu, ox, oy)``. ``mask`` is white exactly
    where the filled card differs from the clean one — i.e. the personalized
    text and nothing else.
    """
    w, h, vb = dims(clean_svg)
    fp = os.path.join(workdir, f"{tag}_filled.png")
    cp = os.path.join(workdir, f"{tag}_clean.png")
    render(_renderable(filled_svg, workdir, f"{tag}_filled.svg"), fp, w, h)
    render(_renderable(clean_svg, workdir, f"{tag}_clean.svg"), cp, w, h)
    fim = Image.open(fp).convert("RGB")
    cim = Image.open(cp).convert("RGB")
    if fim.size != cim.size:
        cim = cim.resize(fim.size)
    ppu, ox, oy = viewport(vb, w, h)
    return diff_mask(fim, cim), fim, vb, ppu, ox, oy


def to_units(f, ppu, ox, oy):
    """One detected band, from screenshot pixels to SVG user units."""
    return {"x0": (f["x0"] - ox) / ppu, "y0": (f["y0"] - oy) / ppu,
            "x1": (f["x1"] - ox) / ppu, "y1": (f["y1"] - oy) / ppu}


def plausible_box(box, vb):
    """Whether a detected box is small enough to actually be text on this card."""
    bw = max(0.0, box["x1"] - box["x0"])
    bh = max(0.0, box["y1"] - box["y0"])
    return bw > 0 and bh > 0 and (bw * bh) <= _MAX_TEXT_AREA * vb[2] * vb[3]


def detect_front(mask, image, vb, ppu, ox, oy):
    """One front's ``{"words": [4], "title": [...]}``, or None when unmeasured.

    The whole page is the card, so ``rows_in_cell`` is handed the full render
    and ``group_words`` picks the four evenly-spaced word rows out of the bands
    it finds, exactly as it does inside an 8-up cell. Anything above the topmost
    word is the title — which may be SEVERAL bands, one per title line.

    None (rather than a partial answer) when the ink cannot be read as text at
    all: fewer than four bands, or a band so large the diff clearly caught the
    artwork. A front that reports nothing is dropped from the shared-slot vote
    and simply gets no ``card.title.<n>`` entry, which the renderer already has
    a fallback for.
    """
    cell = (0, 0) + mask.size
    grouped = group_words(rows_in_cell(mask, cell), mask.size[1])
    if not grouped:
        return None

    def boxed(f):
        u = to_units(f, ppu, ox, oy)
        u["color"] = color_of(image, cell, f)
        return u

    out = {"words": [boxed(f) for f in grouped["words"]],
           "title": [boxed(f) for f in grouped["title"]]}
    if not all(plausible_box(b, vb) for b in out["words"] + out["title"]):
        return None
    return out


def detect_back_title(mask, image, vb, ppu, ox, oy):
    """The card back's title boxes — one per title line; ``[]`` when it has none.

    A back carries no words, so ``group_words`` (which needs at least four
    bands) cannot be used here: every band of ink on this surface IS a title
    line. An empty list is a real, measured answer and not a failure — the
    grapefruit reference export's ``clean/1.svg`` is a full-bleed pattern whose
    clean and filled renders are pixel-identical, i.e. that design simply prints
    no honoree name on the back. The schema records that as ``back: null`` for
    exactly that reason, and the renderer falls back to the theme's
    ``back.frac``.
    """
    cell = (0, 0) + mask.size
    out = []
    for r in rows_in_cell(mask, cell):
        f = dict(y0=r[0], y1=r[1], x0=r[2], x1=r[3])
        box = to_units(f, ppu, ox, oy)
        box["color"] = color_of(image, cell, f)
        if plausible_box(box, vb):
            out.append(box)
    return out


def detect_photo_slots(mask, vb, ppu, ox, oy):
    """The four photo boxes of the photo card, in reading order, or None.

    The photo card's filled twin carries the customer's four pawn photos over
    the same clean art, so its diff is four solid blocks rather than text — a
    2x2 grid, which falls straight out of the row/column profiles the ``bands``
    helper already computes. Anything other than exactly two rows by two columns
    means the pair does not show what the schema describes, and returning None
    lets ``config.photo_slots`` lay out its default inset grid instead of
    writing a guessed geometry into the recipe.
    """
    w, h = mask.size
    px = mask.load()
    colp, rowp = [0] * w, [0] * h
    for y in range(h):
        for x in range(w):
            if px[x, y]:
                colp[x] += 1
                rowp[y] += 1
    rows = bands(rowp, 0.15, int(0.05 * h))
    cols = bands(colp, 0.15, int(0.05 * w))
    if len(rows) != 2 or len(cols) != 2:
        return None
    out = []
    for y0, y1 in rows:
        for x0, x1 in cols:
            box = to_units(dict(x0=x0, y0=y0, x1=x1, y1=y1), ppu, ox, oy)
            out.append(box)
    return out


def _median(values):
    return float(statistics.median(values))


def reconcile_word_slots(per_front):
    """Fold the fronts' word slots into the ONE shared set the deck prints with.

    The word slots, the word font and every size are SHARED across the eight
    fronts by contract (docs/card-structure-schema.md) — only the title moves per
    front. So eight independent measurements of the same four boxes have to
    collapse into one answer, and the only real question is which central value
    to take.

    MEDIAN, not mean. Each front is rasterized and thresholded independently, so
    a single one can be wrong outright: a stray mark that merges two bands, a
    front whose clean export does not quite match its filled twin, or the ~0.15%
    viewBox rounding Canva left on the reference export's ``9.svg``. A mean
    moves by an eighth of whatever that one front is wrong by and silently
    shifts the words on all 104 printed cards; a median does not move at all
    until half the fronts agree with the outlier. Fronts that measured nothing
    are dropped BEFORE the vote rather than counted as zeros, which would drag
    the answer far harder than any mis-detection.

    Colours are voted, not averaged, for the same reason ``calibrate`` takes the
    mode: these are flat vector fills, so the right answer is a value that
    actually occurs, never a blend of two.
    """
    usable = [slots for slots in per_front if slots and len(slots) == 4]
    if not usable:
        return []
    out = []
    for i in range(4):
        boxes = [slots[i] for slots in usable]
        slot = {k: _median([b[k] for b in boxes])
                for k in ("x0", "y0", "x1", "y1")}
        colours = [b.get("color") for b in boxes if b.get("color")]
        if colours:
            slot["color"] = Counter(colours).most_common(1)[0][0]
        out.append(slot)
    return out


def assemble_single_recipe(theme, vb, words, front_titles,
                           back_title=None, photo_slots=None):
    """Build the v2 recipe dict — the shape docs/card-structure-schema.md locks.

    ``format: 2`` is the era marker (absent or 1 means the legacy 8-up sheet), so
    a consumer can branch on one explicit key rather than sniff for a section
    that happens to be present.

    ``front_titles`` maps a front index to its own detected title boxes, and they
    live INSIDE the card as ``card.title["<n>"]`` — beside the word slots they
    share a surface with, so one card block describes one printed card instead of
    a reader having to join two top-level sections. Keyed by front number because
    the title is the ONE thing that moves per front; the four word slots are
    shared, which is what ``reconcile_word_slots`` above votes them down to.

    A front that measured none is OMITTED rather than written as an empty list:
    the schema gives a missing front a defined fallback (the union of the other
    fronts' boxes), and an empty list would only take the same path while
    pretending something was recorded.

    ``back`` is always written, as ``null`` when the back carries no title. That
    is a MEASURED answer, not a gap — grapefruit's ``clean/1.svg`` is a
    full-bleed pattern whose clean and filled renders are pixel-identical, so the
    honest record is "asked, and there is nothing there". A bogus box would put
    the honoree's name on a back that was never designed to carry it.
    """
    recipe = {
        "theme": theme,
        "format": 2,
        "viewBox": [float(v) for v in vb],
        "card": {
            "cell": [vb[0], vb[1], vb[0] + vb[2], vb[1] + vb[3]],
            "words": words,
            "title": {},
        },
        "back": {"title": back_title} if back_title else None,
    }
    for index in sorted(front_titles, key=int):
        boxes = front_titles[index]
        if boxes:
            recipe["card"]["title"][str(index)] = boxes
    if photo_slots:
        recipe["photo"] = {"slots": photo_slots}
    return recipe


def detect_single_card(theme, template_dir, fronts=None,
                       back_index=DEFAULT_BACK_INDEX, workdir=None, log=print):
    """Detect a whole v2 deck: shared word slots, per-front titles, back, photo.

    The card's viewBox comes from the FIRST front, because that is the surface
    the shared word slots are measured against. The reference export's ``9.svg``
    is 224.25x312 where the rest are 223.92x312 — a Canva rounding artifact the
    schema already calls harmless, and it stays harmless here because it moves a
    slot by well under a fifth of a user unit.
    """
    fronts = list(fronts or DEFAULT_FRONTS)
    own = workdir is None
    workdir = workdir or tempfile.mkdtemp(prefix="dugri-recipe-diff-")
    try:
        per_front, front_titles, vb0 = [], {}, None
        first_render = None
        for index in fronts:
            clean = os.path.join(template_dir, "clean", f"{index}.svg")
            filled = os.path.join(template_dir, "filled", f"{index}.svg")
            if not (os.path.exists(clean) and os.path.exists(filled)):
                log(f"front {index}: missing filled/clean pair, skipped")
                continue
            mask, image, vb, ppu, ox, oy = card_diff(
                filled, clean, workdir, tag=f"f{index}")
            if vb0 is None:
                vb0, first_render = vb, (image, mask, ppu, ox, oy)
            got = detect_front(mask, image, vb, ppu, ox, oy)
            if not got:
                log(f"front {index}: no text measured")
                continue
            per_front.append(got["words"])
            front_titles[index] = got["title"]
            log(f"front {index}: 4 words + {len(got['title'])} title box(es)")
        if vb0 is None:
            raise RuntimeError(
                f"no front card could be rendered under {template_dir} — a v2 "
                f"template must ship clean/ and filled/ copies of "
                f"{fronts[0]}.svg..{fronts[-1]}.svg")

        words = reconcile_word_slots(per_front)
        if len(words) != 4:
            raise RuntimeError(
                "not one front yielded four word slots — the clean export may "
                "not match the filled one (the diff must be exactly the text)")

        back_title = []
        bclean = os.path.join(template_dir, "clean", f"{back_index}.svg")
        bfilled = os.path.join(template_dir, "filled", f"{back_index}.svg")
        if os.path.exists(bclean) and os.path.exists(bfilled):
            mask, image, vb, ppu, ox, oy = card_diff(
                bfilled, bclean, workdir, tag="back")
            back_title = detect_back_title(mask, image, vb, ppu, ox, oy)
            log(f"back {back_index}: {len(back_title)} title box(es)"
                + ("" if back_title else " — this design prints no title on the back"))
        else:
            log(f"back {back_index}: missing filled/clean pair, skipped")

        photo = None
        pclean = os.path.join(template_dir, "clean", "photo.svg")
        pfilled = os.path.join(template_dir, "filled", "photo.svg")
        if os.path.exists(pclean) and os.path.exists(pfilled):
            mask, _image, vb, ppu, ox, oy = card_diff(
                pfilled, pclean, workdir, tag="photo")
            photo = detect_photo_slots(mask, vb, ppu, ox, oy)
            log(f"photo card: {'4 slots' if photo else 'not a 2x2 grid, left to the default'}")

        recipe = assemble_single_recipe(theme, vb0, words, front_titles,
                                        back_title, photo)
        if first_render:
            _save_single_preview(theme, recipe, vb0, *first_render)
        return recipe
    finally:
        if own:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)


def _save_single_preview(theme, recipe, vb, image, mask, ppu, ox, oy):
    """Draw the detected slots over the first front — the human's sanity check.

    Same convention as the v1 path: a picture in /tmp/gen is how a person
    confirms in one glance that the numbers landed on the actual text.
    """
    try:
        os.makedirs("/tmp/gen", exist_ok=True)
        vis = image.copy()
        draw = ImageDraw.Draw(vis)

        def rect(box, colour):
            draw.rectangle([box["x0"] * ppu + ox, box["y0"] * ppu + oy,
                            box["x1"] * ppu + ox, box["y1"] * ppu + oy],
                           outline=colour, width=3)

        for slot in recipe["card"]["words"]:
            rect(slot, (255, 0, 0))
        for boxes in recipe["card"]["title"].values():
            for box in boxes:
                rect(box, (0, 200, 0))
        vis.save(f"/tmp/gen/{theme}_recipe.png")
        mask.save(f"/tmp/gen/{theme}_diffmask.png")
    except OSError:
        pass  # a missing scratch dir must never fail a detection run


def write_recipe(theme, recipe):
    """Write a recipe to ``generator/recipes/<theme>.json`` and return the path."""
    os.makedirs(os.path.join(HERE, "recipes"), exist_ok=True)
    path = os.path.join(HERE, "recipes", f"{theme}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(recipe, f, ensure_ascii=False, indent=1)
    return path


def main_single(template_dir, theme):
    recipe = detect_single_card(theme, template_dir)
    path = write_recipe(theme, recipe)
    print(f"single-card recipe: {len(recipe['card']['words'])} shared word slots, "
          f"{len(recipe['card']['title'])} front title(s), "
          f"back {'yes' if recipe.get('back') else 'no'}, "
          f"photo {'detected' if recipe.get('photo') else 'default grid'}")
    print(f"wrote {path} + /tmp/gen/{theme}_recipe.png + _diffmask.png")
    return 0


USAGE = ("usage: recipe_diff.py <text_svg> <clean_svg> <theme>   # v1 8-up sheet\n"
         "       recipe_diff.py --single <template_dir> <theme> # v2 card deck")


def main_sheet(text_svg, clean_svg, theme):
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
    return 0


def main():
    args = sys.argv[1:]
    single = False
    if args and args[0] == "--single":
        single, args = True, args[1:]
    # A bare ``<dir> <theme>`` is unambiguous — the sheet path always takes two
    # FILES — so it is accepted as the v2 form without the flag.
    if single or (len(args) == 2 and os.path.isdir(args[0])):
        if len(args) != 2:
            print(USAGE, file=sys.stderr)
            return 2
        return main_single(args[0], args[1])
    if len(args) != 3:
        print(USAGE, file=sys.stderr)
        return 2
    # A v2 template ships no ``fronts.svg`` at all, so the sheet path cannot even
    # start. Rather than fail the upload with a missing-file error, notice the
    # numbered deck next to where the sheet was expected and detect THAT — which
    # keeps the server's existing three-argument invocation working for a
    # migrated template without it having to know which structure it just got.
    template_dir = os.path.dirname(os.path.dirname(os.path.abspath(args[1])))
    if not os.path.exists(args[1]) and template_layout(template_dir) == "single":
        print(f"no {os.path.basename(args[1])} — this template ships the v2 "
              f"single-card deck; detecting that instead")
        return main_single(template_dir, args[2])
    return main_sheet(*args)


if __name__ == "__main__":
    sys.exit(main())
