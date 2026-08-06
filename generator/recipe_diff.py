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
import math
import os
import statistics
import sys
import re
import tempfile
from collections import Counter
from PIL import Image, ImageDraw, ImageChops

import chrome
import svg_register

CHROME = chrome.CHROME  # see generator/chrome.py — one owner for the browser
HERE = os.path.dirname(os.path.abspath(__file__))
SCALE = 2


def dims(svg):
    head = open(svg, encoding="utf-8").read(2000)
    w = int(re.search(r'width="(\d+)"', head).group(1))
    h = int(re.search(r'height="(\d+)"', head).group(1))
    vb = [float(x) for x in re.search(r'viewBox="([^"]+)"', head).group(1).split()]
    return w, h, vb


def render(svg, png, w, h):
    """Screenshot one SVG, raising an ACTIONABLE error when Chrome fails.

    The actionable-error handling this function used to carry by itself (name
    the binary when it can't be run, name the file and quote Chrome's own stderr
    when it fails, and check the screenshot actually EXISTS because Chrome can
    exit 0 and write nothing) now lives in ``chrome._run`` — detection is not
    the only path that reaches the owner as an opaque traceback in the admin
    panel, so every path gets it. font_wait is off: the original artwork's text
    is already outlined paths, so there is no webfont to wait for.
    """
    chrome.screenshot(svg, png, w, h, scale=SCALE, font_wait=False,
                      what=os.path.basename(svg))


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


def _marker_aligned(feats):
    """The largest run of rows whose RIGHT edge agrees — the numbered rows.

    Every word row on a card begins with its "N." marker pinned to the slot's
    right edge (see ``render_page.word_lines``), so the four word rows share a
    right edge to within a pixel or two. Two kinds of row do NOT: a title, which
    is set wider, and the CONTINUATION of a word that wrapped, which carries no
    marker and therefore stops a whole marker-width short.

    That makes the right edge the one signal that tells a real word row from a
    wrap, which even spacing cannot: a wrapped entry produces five evenly spaced
    rows for four words.
    """
    if not feats:
        return []
    # A marker is about as wide as a row is tall, so half a row height separates
    # "same column" from "a marker short of it" with room on both sides.
    heights = sorted(f["y1"] - f["y0"] for f in feats)
    tol = 0.5 * heights[len(heights) // 2]
    best = []
    for anchor in feats:
        group = [f for f in feats if abs(f["x1"] - anchor["x1"]) <= tol]
        if len(group) > len(best):
            best = group
    return sorted(best, key=lambda f: f["cy"])


def group_words(rows, h, whole_card=False):
    """4 word rows = the 4 marker-aligned rows; title = every band OUTSIDE them.

    The title used to be defined as "the bands above the topmost word row", which
    quietly encoded a layout assumption the designs do not share: מרקאנה puts
    ``Ben's B-day`` at the FOOT of front 9, under the four words. A title below
    the words yielded ``title == []``, the front was written with no title box,
    and ``config.recipe_front_title`` silently substituted the median of the
    other fronts — landing that card's title at the top, where the design has
    nothing.

    So position is not the signal; the number MARKER is. Every word row carries
    its ``N.`` pinned to the slot's right edge (``_marker_aligned``), and a title
    does not — on מרקאנה all four word slots end at x1 0.697 while the title
    boxes end at 0.5737 / 0.6557 / 0.7361. Whatever is not one of the four word
    rows is title ink, above them or below them, and ``plausible_box`` still
    screens decoration by area.

    ``whole_card`` is what makes "below" safe to read, and only the v2 path can
    set it. There, the cell IS the card, so ink under the last word is on this
    card by construction. A v1 cell is a CROP out of an 8-up sheet, where the
    card below bleeds over the cut line: every cell of טיימס סקוור's front sheet
    carries a band at its very bottom edge spanning the full cell width, which is
    the neighbouring card, not a title. So v1 keeps the old "above only" reading
    — no sheet design has its title under the words, and adopting a neighbour's
    ink as title would inflate the box on all eight cards.
    """
    import itertools
    feats = [dict(y0=r[0], y1=r[1], x0=r[2], x1=r[3],
                  cy=(r[0]+r[1])/2/h, bh=(r[1]-r[0])/h) for r in rows]
    feats.sort(key=lambda f: f["cy"])
    if len(feats) < 4:
        return None
    if len(feats) == 4:
        words = feats
    else:
        # Prefer the rows that actually carry a number marker. Picking the four
        # most EVENLY SPACED rows instead is what shifted every slot down a line
        # on a template whose filled sample wraps one entry: the wrap makes five
        # evenly spaced rows, and dropping the FIRST scores just as evenly as
        # dropping the wrap, so the real first word was discarded and the wrap
        # adopted as a slot.
        marked = _marker_aligned(feats)
        if len(marked) == 4:
            words = marked
        else:
            def sc(g):
                g = sorted(g, key=lambda f: f["cy"])
                gaps = [g[i+1]["cy"]-g[i]["cy"] for i in range(3)]
                mg = sum(gaps)/3
                return sum((x-mg)**2 for x in gaps)
            words = sorted(min(itertools.combinations(feats, 4), key=sc),
                           key=lambda f: f["cy"])
    chosen = {id(f) for f in words}
    # ...but NOT a band that sits between the first and last word rows. Ink
    # interleaved with the list is a wrap — the continuation of an entry too long
    # for its slot, which carries no "N." marker and so is not marker-aligned
    # either. A title is never threaded through the middle of the words, above or
    # below them, so this excludes exactly the wraps and nothing a design meant.
    # (סנטוריני's filled sample wraps its third entry; without this the wrap is
    # promoted to title ink and drags the title box down over the word list.)
    top, bottom = words[0]["cy"], words[-1]["cy"]
    if not whole_card:
        # A sheet cell: only ink ABOVE the words can be trusted as this card's.
        bottom = float("inf")
    title = [f for f in feats
             if id(f) not in chosen and not (top < f["cy"] < bottom)]
    return dict(words=words, title=title)


def _lum(c):
    return 0.299*c[0] + 0.587*c[1] + 0.114*c[2]


# How close in luminance a group has to be before it counts as ONE colour and
# ``color_of`` stops peeling. Wide enough to swallow the couple of levels a
# renderer's dithering adds to a flat fill, far narrower than the gap between
# glyph ink and any page it is legible against.
_INK_SPREAD = 12


def _ink_cut(lums):
    """Split a word box's luminances into INK and BACKGROUND, return the cut.

    Otsu: pick the threshold that maximises the variance BETWEEN the two groups,
    i.e. the split the pixels themselves argue for. Used instead of a fixed
    "darkest N%" because N is exactly what we cannot know in advance — see
    ``color_of``. Returns a luminance; pixels at or below it are the ink.
    """
    hist = [0] * 256
    for l in lums:
        hist[min(255, int(l))] += 1
    total = len(lums)
    sum_all = sum(i * hist[i] for i in range(256))
    sum_b = 0.0
    w_b = 0
    best, cut = -1.0, 0
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        m_b = sum_b / w_b
        m_f = (sum_all - sum_b) / w_f
        between = w_b * w_f * (m_b - m_f) ** 2
        if between > best:
            best, cut = between, t
    return cut


def color_of(text_img, cell, f):
    """The INK colour of one detected text box, as ``#rrggbb``.

    This used to average the darkest EIGHTH of the box. That silently assumed
    the glyphs cover at least 12.5% of their own bounding box — and a long entry
    in a thin script does not: its ink is spread over a wider box, so coverage
    falls below the eighth, the bucket fills up with page background, and the
    average drifts toward it. The recorded colour then prints WASHED OUT on every
    card, which is what put a pale third line on an otherwise uniform deck
    (bachelorette card 2 recorded #a37b87 for a #6b4d56 word).

    So the ink/background split is measured rather than assumed (``_ink_cut``),
    and only the ink side is averaged. Anti-aliased edge pixels sit in the light
    group by construction, so they no longer drag the answer up.
    """
    cx0, cy0 = cell[0], cell[1]
    crop = text_img.crop((cx0+f["x0"], cy0+f["y0"], cx0+f["x1"], cy0+f["y1"]))
    px = list(crop.getdata())
    if not px:
        return "#000000"
    # Bin ONCE and compare bins. Comparing a raw float luminance against a bin
    # index silently drops the whole ink group whenever it lands mid-bin (ink at
    # 86.99 binned to 86, then 86.99 <= 86 is false) — every pixel falls out and
    # the fallback averages the background back in.
    lums = [min(255, int(_lum(p))) for p in px]
    group = list(zip(px, lums))
    # Peel the lighter side off repeatedly. ONE split separates ink from page,
    # but a glyph also carries an anti-aliased fringe — pixels part-way between
    # the two — and against a sparse stem that fringe can outnumber the stem
    # itself, pulling a single split's average back toward the page. Each pass
    # drops the lighter half of what is left; it stops as soon as the group is
    # tight enough to be one colour, which pure glyph ink is immediately.
    for _ in range(4):
        spread = max(l for _, l in group) - min(l for _, l in group)
        if spread <= _INK_SPREAD:
            break
        cut = _ink_cut([l for _, l in group])
        darker = [(p, l) for p, l in group if l <= cut]
        # A group that will not split (every pixel one side) is already as pure
        # as this can get — averaging it is the answer, not an empty set.
        if not darker or len(darker) == len(group):
            break
        group = darker
    ink = [p for p, _ in group]
    return "#%02x%02x%02x" % tuple(sum(p[i] for p in ink)//len(ink) for i in range(3))


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
    text = _svg_text(svg_path)
    with open(svg_path, encoding="utf-8") as f:
        if f.read() == text:
            return svg_path
    out = os.path.join(workdir, tag)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    return out


def _svg_text(svg_path):
    """One card's markup, with any de-duplicated background made absolute."""
    try:
        import card_assets
    except ImportError:  # card_assets is optional for the v1 path
        with open(svg_path, encoding="utf-8") as f:
            return f.read()
    return card_assets.read_svg(svg_path)


def _clean_plate(clean_svg, reg, w, h, workdir, tag):
    """The clean half of a pair as Chrome should render it.

    Unregistered — the normal case, and every pair in the store but four — this
    is the file itself, untouched. When the pair needs registering it is the same
    markup nested inside ``svg_register.wrap``'s corrective transform, so Chrome
    RASTERISES the correction instead of us resampling a finished PNG: the plate
    lands on its twin's pixel grid with the crisp edges it was drawn with, which
    is the whole reason the diff comes back as text rather than as the design
    ghosted against itself by half a pixel.
    """
    if not reg:
        return _renderable(clean_svg, workdir, f"{tag}_clean.svg")
    out = os.path.join(workdir, f"{tag}_clean.svg")
    with open(out, "w", encoding="utf-8") as f:
        f.write(svg_register.wrap(_svg_text(clean_svg), reg, w, h))
    return out


# How far the two halves of a pair may disagree about their own viewBox before
# the diff between them stops being readable, as a fraction of the box.
#
# The two plates are the SAME artwork, so ``filled - clean`` is the text only
# while they register. They stop registering when the exports disagree about the
# coordinate space: both are drawn into the same window, so a viewBox that is
# 0.15% wider scales the art by 0.15% less and shifts it half a pixel, and EVERY
# high-contrast edge in the design — a border, a frame, an icon — then appears in
# the diff as a hairline ghost. That is not a subtle degradation: on מרקאנה's
# front 9 it turns a card's worth of text into ONE band spanning the whole page,
# and detection reports "no text measured" for a pair that is perfectly legible
# to a human.
#
# 1e-4 is far below the artifact and far above float noise: the four affected
# plates are off by 1.5e-3 (224.25 against 223.92) while a matching pair agrees
# to the last digit Canva prints.
#
# Tripping this is now a QUESTION rather than a verdict — ``detect_single_card``
# asks ``svg_register`` whether the two plates can be put back in register from
# the artwork they share, and only reports the mismatch when they cannot.
_VIEWBOX_TOL = 1e-4


def viewbox_mismatch(filled_svg, clean_svg):
    """A message when a pair's two plates disagree about their coordinate space.

    ``None`` when they agree, which is the normal case and the only one in which
    ``filled - clean`` is the personalized text and nothing else.

    This is a Canva export artifact, and a REAL one: of the eleven templates in
    the owner's store, four ship a ``clean/9.svg`` at viewBox 224.25x311.999995
    where its ``filled/9.svg`` twin — and every other plate in the same deck — is
    223.92x312. The artwork inside is scaled to match (0.747953 against
    0.749732), so the two plates genuinely draw the card at different sizes and
    no threshold, erosion or RASTER registration recovers a clean diff; the
    card's own border survives every one of them as a full-height ghost.

    What does recover it is not a search over the pixels but arithmetic on the
    files: both plates draw the same shapes, so the similarity between them
    falls out of their own path geometry, and re-rendering the clean plate
    through it puts them back on one grid (``svg_register``). This function's
    answer is therefore the input to that question, and its MESSAGE is what is
    reported only when the answer cannot be derived — a pair sharing no
    measurable artwork, where a guess would print the honoree's name in the
    wrong place.

    Checked BEFORE rendering because the cost is two file headers against two
    Chrome screenshots, and because the answer is more actionable: "these two
    exports disagree, re-export this plate" tells the owner what to do, where
    "no text measured" sent her looking at a card that is plainly fine.

    Worth stating plainly what this replaces. ``_TITLE_BOX_TOL`` blames the same
    four decks' front 9 on "a clean plate missing artwork its filled twin has".
    That was inferred from the symptom and it is not what the files show — the
    artwork is present in both, at two different scales. The size refusal is
    still a good backstop for a box that cannot be a title, but it is not this
    diagnosis, and it cannot say which file to fix.
    """
    try:
        _, _, fvb = dims(filled_svg)
        _, _, cvb = dims(clean_svg)
    except (AttributeError, OSError, ValueError):
        # A header this cannot parse is not a mismatch — it is a different fault,
        # and ``card_diff``/``chrome`` already report an unreadable SVG with an
        # actionable message. Never invent a diagnosis from a file not read: a
        # pre-flight that turns "I could not look" into a hard failure would
        # block detection on templates that render perfectly well.
        return None
    if all(abs(a - b) <= _VIEWBOX_TOL * max(1.0, abs(b))
           for a, b in zip(fvb, cvb)):
        return None
    def fmt(vb):
        return " ".join(f"{v:g}" for v in vb)

    return (f"filled/{os.path.basename(filled_svg)} draws this card at viewBox "
            f"[{fmt(fvb)}] but clean/{os.path.basename(clean_svg)} draws it at "
            f"[{fmt(cvb)}] — the same artwork at two different scales. Their "
            f"difference is therefore the whole design shifted against itself, "
            f"not the text, so this card cannot be measured. Re-export "
            f"clean/{os.path.basename(clean_svg)} from Canva at the same size as "
            f"the rest of the deck; until then this front falls back to the box "
            f"its siblings agree on.")


def card_diff(filled_svg, clean_svg, workdir, tag="card", reg=None):
    """Render one card's filled/clean pair and return the ink and its mapping.

    Returns ``(mask, filled_image, vb, ppu, ox, oy)``. ``mask`` is white exactly
    where the filled card differs from the clean one — i.e. the personalized
    text and nothing else.

    ``reg`` is ``svg_register.registration``'s answer for a pair Canva exported
    at two different scales, and passing it changes which plate defines the
    coordinate space: the FILLED one, because that is the space the clean plate
    is being drawn into and therefore the space the measured boxes come out in.
    That is also the space the rest of the deck is measured in, so front 9's
    title box becomes directly comparable with its siblings' — where reading it
    against the clean plate's own 224.25-wide viewBox would have put it in a
    coordinate system nothing else in the recipe uses.
    """
    w, h, vb = dims(filled_svg if reg else clean_svg)
    fp = os.path.join(workdir, f"{tag}_filled.png")
    cp = os.path.join(workdir, f"{tag}_clean.png")
    render(_renderable(filled_svg, workdir, f"{tag}_filled.svg"), fp, w, h)
    render(_clean_plate(clean_svg, reg, w, h, workdir, tag), cp, w, h)
    fim = Image.open(fp).convert("RGB")
    cim = Image.open(cp).convert("RGB")
    if fim.size != cim.size:
        cim = cim.resize(fim.size)
    ppu, ox, oy = viewport(vb, w, h)
    mask = diff_mask(fim, cim)
    if reg:
        mask = _both_plates_drawn(mask, reg, vb, dims(clean_svg), w, h)
    return mask, fim, vb, ppu, ox, oy


def _both_plates_drawn(mask, reg, fvb, clean_dims, w, h):
    """Blank the diff where only ONE of the two plates painted the card.

    A registered pair's two plates no longer cover the same window. מרקאנה's
    clean/9 declares a viewBox whose aspect matches the 299x416 window exactly,
    so its card is drawn edge to edge; its filled twin is a hair narrower and
    gets centred with 0.22px of paper down each side. Registering the clean plate
    onto the filled one keeps that difference — and the last pixel column is then
    solid card on one plate and part paper on the other, which the diff reports
    as a full-height line of "text" and which stretched every band on the card
    out to the right edge (a title 144 units wide where the deck's is 68).

    That column is not ink either plate disagrees about; it is the edge of the
    paper. So the comparison is restricted to the pixels BOTH plates fully
    painted — the intersection of the two page rectangles, rounded inward to
    whole pixels. Only reached for a registered pair: when the plates share a
    viewBox their pages coincide and this would be a no-op.
    """
    _cw, _ch, cvb = clean_dims
    a, dx, dy = reg
    fppu, fox, foy = viewport(fvb, w, h)
    cppu, cox, coy = viewport(cvb, w, h)
    # The clean page, in its own screenshot pixels, then through the correction.
    clean_page = (a * cox + dx * SCALE, a * coy + dy * SCALE,
                  a * (cox + cvb[2] * cppu) + dx * SCALE,
                  a * (coy + cvb[3] * cppu) + dy * SCALE)
    filled_page = (fox, foy, fox + fvb[2] * fppu, foy + fvb[3] * fppu)
    lo_x = max(clean_page[0], filled_page[0], 0.0)
    lo_y = max(clean_page[1], filled_page[1], 0.0)
    hi_x = min(clean_page[2], filled_page[2], float(mask.size[0]))
    hi_y = min(clean_page[3], filled_page[3], float(mask.size[1]))
    keep = (int(math.ceil(lo_x)), int(math.ceil(lo_y)),
            int(math.floor(hi_x)), int(math.floor(hi_y)))
    if keep[2] - keep[0] < 1 or keep[3] - keep[1] < 1:
        return mask               # nothing overlaps: leave the evidence alone
    out = Image.new("L", mask.size, 0)
    out.paste(mask.crop(keep), keep[:2])
    return out


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
    and ``group_words`` picks the four marker-aligned word rows out of the bands
    it finds, exactly as it does inside an 8-up cell. Every band that is NOT one
    of those four is the title — which may be SEVERAL bands, one per title line,
    and which may sit above the words or below them (מרקאנה's front 9 puts it at
    the foot of the card).

    None (rather than a partial answer) when the ink cannot be read as text at
    all: fewer than four bands, or a band so large the diff clearly caught the
    artwork. A front that reports nothing is dropped from the shared-slot vote
    and simply gets no ``card.title.<n>`` entry, which the renderer already has
    a fallback for.
    """
    cell = (0, 0) + mask.size
    grouped = group_words(rows_in_cell(mask, cell), mask.size[1], whole_card=True)
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


# How far a front's title box may differ from its siblings' before the reading
# is refused. Every front of a deck carries the SAME title — the same words in
# the same face at the same size — so the box around it is the same size on
# every front, wherever on the card it sits. A quarter is far beyond the couple
# of percent a descender or a swash moves it, and far below what a diff that
# caught artwork produces: card 9's clean plate is missing artwork its filled
# twin has on three unrelated designs, and `filled − clean` reads that as text —
# giving a box 2.3x wide (סיישל), 1.7x (פריז) and 2.3x (קליפורניה) with an
# identical runaway origin (y0 0.0721, x0 0.1089) on two designs that share
# nothing else.
_TITLE_BOX_TOL = 0.25


def _title_union(boxes):
    return {"x0": min(b["x0"] for b in boxes), "y0": min(b["y0"] for b in boxes),
            "x1": max(b["x1"] for b in boxes), "y1": max(b["y1"] for b in boxes)}


def _box_off(union, wide, tall):
    """How far a union is from the deck's typical title, as a fraction."""
    w, h = union["x1"] - union["x0"], union["y1"] - union["y0"]
    return max(abs(w / wide - 1) if wide else 0.0,
               abs(h / tall - 1) if tall else 0.0)


def _title_run(boxes, wide, tall):
    """The run of this front's title bands that measures like the deck's title.

    ``group_words`` hands over every band that is not one of the four word rows,
    which is what lets a title be found BELOW the words. The cost of dropping the
    position assumption is that stray ink now lands in the same bucket: on
    קליפורניה's front 5 the two real title lines sit at the top and a patch of
    artwork the diff caught sits near the foot, so the union of "everything that
    is not a word" spans 244 units where the deck's title measures 42.

    Position cannot separate those two — that is the whole point. The deck can:
    the same title is on every front, so on THIS front the title is the ink whose
    extent matches what the other fronts agree a title measures. Lines of one
    title are consecutive bands, so only contiguous runs are considered; the
    best-fitting one wins.

    ``None`` when no run matches, which leaves the caller to refuse the front
    exactly as before.
    """
    ordered = sorted(boxes, key=lambda b: (b["y0"], b["x0"]))
    best = None
    for i in range(len(ordered)):
        for j in range(i + 1, len(ordered) + 1):
            run = ordered[i:j]
            off = _box_off(_title_union(run), wide, tall)
            if off <= _TITLE_BOX_TOL and (best is None or off < best[0]):
                best = (off, run)
    return best[1] if best else None


def reconcile_front_titles(front_titles, log=None, declined=None):
    """Drop any front whose title box does not look like the rest of the deck's.

    Detection reads one front at a time and has, per front, no way to tell the
    honoree's name from a patch of artwork the clean export happens to be
    missing. Read together the fronts DO tell: the title is the same text on all
    eight, so a box half again wider or taller than the median is not a title.

    Two outcomes, not one. When only PART of a front's ink is unlike the deck's
    title, the rest of it still is: ``_title_run`` keeps the bands that measure
    like a title and sets the others aside, so a front that merely caught a patch
    of artwork alongside a perfectly good title keeps its own box. Only a front
    with no title-shaped ink at all is refused outright.

    Refusing is the whole point — a refused front falls back to the shape its
    siblings agree on (``config.recipe_front_title``), which is the design's own
    answer, where writing the runaway box printed the honoree's name at the wrong
    size in the wrong place on that card. Says so out loud, in ``declined``, so
    the owner is told rather than left to spot it on one card in eight.
    """
    usable = {i: b for i, b in front_titles.items() if b}
    if len(usable) < 3:
        return front_titles          # too few to have a consensus to differ from
    sizes = {i: _title_union(b) for i, b in usable.items()}
    wide = _median([u["x1"] - u["x0"] for u in sizes.values()])
    tall = _median([u["y1"] - u["y0"] for u in sizes.values()])
    out = dict(front_titles)
    for index, u in sorted(sizes.items(), key=lambda kv: str(kv[0])):
        w, h = u["x1"] - u["x0"], u["y1"] - u["y0"]
        off = _box_off(u, wide, tall)
        if off <= _TITLE_BOX_TOL:
            continue
        # Before refusing the front outright, ask whether PART of its ink is the
        # title. A front whose real title is fine but which also caught a patch
        # of artwork has a union that fails this check while the title itself is
        # perfectly good — dropping the whole front there would throw away a
        # correct measurement over a stray band.
        run = _title_run(usable[index], wide, tall)
        if run:
            out[index] = run
            dropped = len(usable[index]) - len(run)
            if log:
                log(f"front {index}: set aside {dropped} band(s) of ink that "
                    f"cannot be part of this title — its title box measures "
                    f"{_title_union(run)['x1'] - _title_union(run)['x0']:.1f}x"
                    f"{_title_union(run)['y1'] - _title_union(run)['y0']:.1f} "
                    f"against {wide:.1f}x{tall:.1f} on the rest of the deck, "
                    f"where all of its ink together measured {w:.1f}x{h:.1f}.")
            continue
        out.pop(index, None)
        why = (f"front {index}: its title box measures {w:.1f}x{h:.1f} against "
               f"{wide:.1f}x{tall:.1f} on the rest of the deck — the same title "
               f"cannot be {off * 100:.0f}% off its own size, so the diff caught "
               f"artwork rather than text. Refused; this front falls back to the "
               f"box its siblings agree on. Check clean/{index}.svg against "
               f"filled/{index}.svg — a clean plate missing artwork the filled "
               f"one has reads as text.")
        if log:
            log(why)
        if declined is not None:
            declined.append(why)
    return out


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


# ---- regularising what was measured ----------------------------------------
# Detection measures the ORIGIN's INK, i.e. where Canva's specimen words happened
# to land in the design the template was exported from. So it faithfully
# reproduces two things that are not design intent:
#
#   * the origin's own sloppiness — a text box nudged a pixel by hand;
#   * threshold noise — the diff mask's edge moves with the glyphs that happen to
#     sit on that line, and a word with a descender measures taller than one
#     without even when both lines are the same box.
#
# Measured on grapefruit, the four word-slot midpoints as a fraction of card
# height came out 0.377 / 0.472 / 0.582 / 0.673 — gaps of 0.095, 0.110, 0.091 for
# a design that plainly means four evenly spaced lines. That 0.110 reads as a
# visible break mid-list, and the owner was correcting it BY HAND in themes.json.
# Same story on the right edge (x1 of 0.7026 / 0.6993 / 0.7010 / 0.6959 — one
# intended edge measured four ways) and on the box heights.
#
# So: snap. But ONLY when the measurement is consistent enough that the snap is
# small. Some design really may put its lines at uneven intervals, and silently
# regularising THAT would be a worse bug than the one being fixed — hence
# consistent-or-leave-alone on each of the three axes independently.

# How far a midpoint may be dragged onto the even run before we conclude the
# design meant the unevenness, as a fraction of the run's own spacing.
#
# This was 0.15, chosen from a run on a developer laptop where grapefruit fitted
# to 6.8%. That number does not survive contact with the container. The SAME
# template and the SAME code measure differently depending on who rasterises it,
# because the mids come from ink boxes and Chrome's text rendering is not
# identical across platforms:
#
#   laptop     mids [117.56, 147.19, 181.50, 210.00]  ->  worst fit  7%  SNAPPED
#   container  mids [118.50, 144.38, 186.75, 213.00]  ->  worst fit 18%  DECLINED
#
# So in production the snap silently declined and wrote the raw ink boxes —
# grapefruit shipped gaps of 0.0829/0.1358/0.0841 where the design has one
# spacing, the owner pressed "זהה מחדש" and got the uneven card back, and
# nothing said why. A tolerance calibrated on one rasteriser is not a tolerance.
#
# 0.25 is set from the measurement that actually runs. It clears the container's
# 18% and still refuses a genuinely staggered layout: mids 0.20/0.30/0.55/0.70 —
# two pairs, not one progression — need a 32.5% drag and stay refused.
_SPACING_TOL = float(os.environ.get("DUGRI_SLOT_SPACING_TOL", "0.25"))

# How far one slot's right edge may sit from the others' median before they stop
# being one edge, as a fraction of card WIDTH. Grapefruit's four x1 values span
# 0.0067 of the width — 1.5 units on a 223.92-unit card, well under a millimetre
# in print and invisible. A deliberate stagger has to be several millimetres to
# read as a stagger at all, so 0.02 (4.5 units) separates the two comfortably.
_EDGE_TOL = float(os.environ.get("DUGRI_SLOT_EDGE_TOL", "0.02"))

# How far one slot's height may sit from the median before the design is taken to
# mean different heights, as a fraction of that median. Relative, not absolute,
# because this is an INK box: a line whose sample words carry a descender
# (ק ן ך ף ץ, or a Latin g/y) measures roughly a cap-height 0.72em against 0.95em
# with the descender — up to ~28% either side of the median for one single font
# size. A design that really steps the size up steps it by 1.25x at the very
# least. 0.35 is above the typography and below the smallest deliberate step.
_HEIGHT_TOL = float(os.environ.get("DUGRI_SLOT_HEIGHT_TOL", "0.35"))

# Below this many user units a "snap" is float dust on numbers that already
# agreed — worth applying, not worth a log line.
_NOOP = 1e-9


def _fmt(values):
    return "[" + ", ".join(f"{v:.2f}" for v in values) + "]"


def _even_run(mids):
    """The evenly spaced run closest to ``mids`` — mean spacing, centred on them.

    Two decisions, both about moving the slots as little as possible:

    SPACING is the mean gap, ``(last - first) / (n - 1)``, so the run spans
    exactly what was measured rather than inheriting whichever single gap the
    detector read best.

    CENTRING is on the mean midpoint, NOT anchored to slot 1. Anchoring would
    hold one slot still and pay for the whole correction with the others — on
    grapefruit, anchoring to slot 1 leaves slot 4 out by 0.011 of the card, where
    centring caps the worst move at 0.0067. Centring is also what makes the run
    symmetric: it minimises the sum of the squared moves for this spacing.
    """
    n = len(mids)
    step = (mids[-1] - mids[0]) / (n - 1)
    centre = sum(mids) / float(n)
    return [centre + (i - (n - 1) / 2.0) * step for i in range(n)], step


def _clamp_into_card(box, vb):
    """Keep a regularised box on the card — a snap must never push text off it.

    A cheap belt-and-braces: the snaps are small by construction (that is the
    whole consistency gate), so this normally does nothing at all. It exists so
    that no arithmetic here can emit a slot the renderer would have to clip.
    """
    x_lo, y_lo = vb[0], vb[1]
    x_hi, y_hi = vb[0] + vb[2], vb[1] + vb[3]
    for k in ("x0", "x1"):
        box[k] = min(max(box[k], x_lo), x_hi)
    for k in ("y0", "y1"):
        box[k] = min(max(box[k], y_lo), y_hi)
    return box


def regularise_word_slots(slots, vb, log=print, declined=None):
    """Turn measured word slots into the layout the design MEANT, where it can.

    Three independent snaps — even spacing, one shared right edge, one shared
    height — each applied only when the measurement is consistent enough that the
    snap is small (see the tolerance constants above). This is what removes the
    owner's hand-correction step from themes.json; "nothing should be hardcoded
    or manual" is the requirement it serves.

    Order matters: spacing is decided on the measured midpoints, then heights are
    grown or shrunk AROUND the snapped midpoints, so unifying the heights can
    never undo the even spacing.

    ``x0`` is never voted. Word lines are right-anchored — the renderer pins the
    marker digit to ``x1`` and flows left — so ``x0`` is not a position, it is the
    shrink guard's left bound. The honest bound is therefore the LEFTMOST extent
    any front measured: taking a median would squeeze the longest word for no
    reason. It moves only alongside the right edge, because if the edges are
    genuinely staggered then so is the box, and nothing here should be pooled.

    ``declined`` is an optional list. Every snap this REFUSES appends its reason
    to it, so a refusal can travel out of here instead of ending in a log nobody
    reads. That gap is not hypothetical: grapefruit's spacing snap declined on
    every container run ("worst fit 18% of the spacing, tolerance 15%"), the
    detector still reported success, and the owner pressed the button repeatedly
    against a card that kept coming back uneven with nothing explaining why.
    """
    def refuse(message):
        log(message)
        if declined is not None:
            declined.append(message)

    if len(slots) < 2:
        # One slot has no spacing, no shared edge and no median height to speak
        # of; zero has nothing at all. Detection only ever emits four, but this
        # is a pure function and a caller is entitled to hand it anything.
        return [dict(s) for s in slots]
    out = [dict(s) for s in slots]

    mids = [(s["y0"] + s["y1"]) / 2.0 for s in out]
    heights = [s["y1"] - s["y0"] for s in out]
    snapped, step = _even_run(mids)
    moves = [abs(a - b) for a, b in zip(snapped, mids)]
    if step > 0 and max(moves) <= _SPACING_TOL * step:
        log(f"word slots: even spacing {step:.2f}u — mids {_fmt(mids)} -> "
            f"{_fmt(snapped)} (largest move {max(moves):.2f}u, "
            f"{max(moves) / step:.0%} of the spacing)")
        mids = snapped
    else:
        worst = max(moves) / step if step > 0 else float("inf")
        refuse(f"word slots: mids {_fmt(mids)} are not one progression "
               f"(worst fit {worst:.0%} of the spacing, tolerance "
               f"{_SPACING_TOL:.0%}) — left as measured")

    median_h = _median(heights)
    off_h = max(abs(h - median_h) for h in heights)
    if off_h <= _HEIGHT_TOL * median_h:
        # _NOOP guards the log, not the snap: slots that already agree to the
        # last float bit are the common case on a clean export, and announcing a
        # "change" of 1e-14 units would only teach the owner to skim these lines.
        if off_h > _NOOP:
            log(f"word slots: one height {median_h:.2f}u — was {_fmt(heights)}")
        heights = [median_h] * len(heights)
    else:
        refuse(f"word slots: heights {_fmt(heights)} differ by more than "
               f"{_HEIGHT_TOL:.0%} of the median — left as measured")

    for slot, mid, height in zip(out, mids, heights):
        slot["y0"], slot["y1"] = mid - height / 2.0, mid + height / 2.0

    edges = [s["x1"] for s in out]
    median_x1 = _median(edges)
    left = min(s["x0"] for s in out)
    off_x = max(abs(e - median_x1) for e in edges)
    if off_x <= _EDGE_TOL * vb[2] and left < median_x1:
        if off_x > _NOOP or max(s["x0"] for s in out) - left > _NOOP:
            log(f"word slots: one right edge {median_x1:.2f}u — was "
                f"{_fmt(edges)}; left bound {left:.2f}u (the leftmost measured)")
        for slot in out:
            slot["x0"], slot["x1"] = left, median_x1
    else:
        refuse(f"word slots: right edges {_fmt(edges)} span more than "
               f"{_EDGE_TOL:.0%} of the card width — left as measured")

    return [_clamp_into_card(slot, vb) for slot in out]


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



def _diff_shape(mask):
    """Describe what the clean<->filled diff looks like, for an error message.

    The three failures are indistinguishable from "no text measured" alone, and
    they need opposite fixes: an EMPTY diff means the two exports are the same
    file (nothing personalized was in the filled one), a SATURATED diff means
    they differ everywhere (the pair does not correspond — different card,
    different export settings, or one of them re-rendered at another size), and
    a sparse-but-unstructured diff means there IS ink but not four evenly spaced
    word rows.
    """
    px = mask.load()
    w, h = mask.size
    step = max(1, min(w, h) // 200)
    on = total = 0
    for y in range(0, h, step):
        for x in range(0, w, step):
            total += 1
            if px[x, y]:
                on += 1
    frac = on / (total or 1)
    if frac < 0.0005:
        return ("the two exports are identical — filled/ carries no personalized "
                "text, so there is nothing to measure")
    if frac > _MAX_TEXT_AREA:
        return (f"the diff covers {frac * 100:.0f}% of the card — these two files "
                "differ everywhere, not just in the text, so they are not a "
                "matching clean/filled pair")
    return (f"ink covers {frac * 100:.1f}% of the card but does not form four "
            "evenly spaced word rows")

def detect_single_card(theme, template_dir, fronts=None,
                       back_index=DEFAULT_BACK_INDEX, workdir=None, log=print):
    """Detect a whole v2 deck: shared word slots, per-front titles, back, photo.

    The card's viewBox comes from the FIRST front, because that is the surface
    the shared word slots are measured against. Four decks' ``clean/9.svg`` is
    224.25x311.999995 where every other plate is 223.92x312; that front is
    registered onto its own filled twin before it is diffed
    (``svg_register``) and its boxes come out in the FILLED plate's space, which
    is the space this viewBox describes — so the odd plate contributes to the
    shared vote in the same coordinates as its siblings.
    """
    fronts = list(fronts or DEFAULT_FRONTS)
    own = workdir is None
    workdir = workdir or tempfile.mkdtemp(prefix="dugri-recipe-diff-")
    try:
        per_front, front_titles, vb0 = [], {}, None
        # Word rows read off a REGISTERED front are kept apart from the shared
        # vote, and used only if no front could be read directly. The word slots
        # are the same on all eight fronts by contract, so a registered front
        # tells the deck nothing about them its siblings have not already said
        # directly — while the title box is per-front and has no other source at
        # all, which is the whole reason this front is being read. Letting the
        # corrected reading into the vote moves the words on EVERY card of the
        # deck for no gain: ``_median`` of eight averages the two middle values
        # where seven takes the middle one, so the shared slots shift by ~0.7
        # units on סיישל and קליפורניה purely because the count went from odd to
        # even. A reconstructed measurement answers only the question nothing
        # else can.
        registered_words = []
        reasons = []
        declined = []
        first_render = None
        for index in fronts:
            clean = os.path.join(template_dir, "clean", f"{index}.svg")
            filled = os.path.join(template_dir, "filled", f"{index}.svg")
            if not (os.path.exists(clean) and os.path.exists(filled)):
                log(f"front {index}: missing filled/clean pair, skipped")
                continue
            # Before Chrome, not after: a pair whose two plates draw the card at
            # different scales cannot produce a readable diff as it stands, and
            # both file headers cost less than one screenshot to read.
            #
            # A mismatch is a question, not a verdict. The two plates draw the
            # SAME shapes, so the similarity between them is recoverable from
            # their own path geometry — and a clean plate re-rendered through it
            # lands back on its twin's pixel grid, which is how מרקאנה's front 9
            # yields its low title instead of one page-high band. Only when that
            # cannot be derived does the pair fall through to being reported,
            # because at that point there is genuinely nothing to measure and a
            # guess would print the honoree's name in the wrong place.
            reg = None
            off = viewbox_mismatch(filled, clean)
            if off:
                reg = svg_register.registration(
                    dims(filled), dims(clean), filled, clean)
                if not reg:
                    why = f"front {index}: {off}"
                    log(why)
                    declined.append(why)
                    continue
                log(f"front {index}: clean plate exported at a different scale "
                    f"— registered onto its filled twin (x{reg[0]:.6f}, "
                    f"{reg[1]:+.2f},{reg[2]:+.2f}px) from the artwork they share")
            mask, image, vb, ppu, ox, oy = card_diff(
                filled, clean, workdir, tag=f"f{index}", reg=reg)
            if vb0 is None:
                vb0, first_render = vb, (image, mask, ppu, ox, oy)
            got = detect_front(mask, image, vb, ppu, ox, oy)
            if not got:
                # WHY it measured nothing is the whole diagnosis, and it used to
                # go only to stdout — which the server drops, because it reports
                # stderr when a run fails. So the owner got "not one front
                # yielded four word slots" with no way to tell a blank diff (the
                # two exports are identical) from a saturated one (they differ
                # everywhere, so the pair does not correspond).
                why = _diff_shape(mask)
                reasons.append(f"front {index}: {why}")
                log(f"front {index}: no text measured — {why}")
                # ...and TELL THE OWNER. ``reasons`` is only ever raised when the
                # whole deck fails; a single front that measured nothing while
                # its siblings succeeded fell out of the loop into silence, got
                # no ``card.title`` entry, and was quietly handed the median of
                # the others by ``config.recipe_front_title``. That is how
                # מרקאנה shipped front 9 with its title at the top of the card
                # when the design puts it at the foot — nothing, anywhere,
                # reported that a front had been dropped.
                declined.append(
                    f"front {index}: no text could be measured — {why}. This "
                    f"front gets no title box of its own and falls back to the "
                    f"box its siblings agree on, which is WRONG wherever this "
                    f"card's title sits somewhere they do not. Check "
                    f"clean/{index}.svg against filled/{index}.svg.")
                continue
            (registered_words if reg else per_front).append(got["words"])
            front_titles[index] = got["title"]
            log(f"front {index}: 4 words + {len(got['title'])} title box(es)")
            if not got["title"]:
                # Four words but no title ink at all. Same silent fallback, a
                # different cause — worth its own sentence so the owner is not
                # sent looking for a broken export when the pair is fine.
                declined.append(
                    f"front {index}: 4 word slots read, but no title ink — this "
                    f"front falls back to the title box its siblings agree on. "
                    f"If clean/{index}.svg and filled/{index}.svg differ only in "
                    f"the words, that is correct; if this card carries a name, "
                    f"the two plates do not show it.")
        if vb0 is None:
            # Carry WHY into the exception. A deck whose every plate pair was
            # refused for a viewBox mismatch would otherwise be reported as
            # "must ship clean/ and filled/ copies", sending the owner to look
            # for files that are all present.
            raise RuntimeError(
                f"no front card could be rendered under {template_dir} — a v2 "
                f"template must ship clean/ and filled/ copies of "
                f"{fronts[0]}.svg..{fronts[-1]}.svg"
                + ("\n  " + "\n  ".join(declined) if declined else ""))

        front_titles = reconcile_front_titles(front_titles, log=log,
                                              declined=declined)
        words = reconcile_word_slots(per_front or registered_words)
        if not per_front and registered_words:
            log("word slots: no front could be read directly — voting the "
                f"{len(registered_words)} registered front(s) instead")
        if len(words) != 4:
            raise RuntimeError(
                "not one front yielded four word slots, so there is nothing to "
                "calibrate. The diff between clean/ and filled/ must be EXACTLY "
                "the personalized text. What each front actually produced:\n  "
                + "\n  ".join(reasons or ["(no front was measured at all)"]))
        # Straight after the vote and BEFORE anything is written: what goes into
        # the recipe is the layout the design meant, not the origin's ink boxes.
        words = regularise_word_slots(words, vb0, log=log, declined=declined)

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
        # Carry any REFUSED snap into the recipe. Detection returning "ok" while
        # having quietly left a layout as measured is how grapefruit's uneven
        # card survived repeated presses of "זהה מחדש": the reason existed, in a
        # log line on a container nobody was reading. Written only when there is
        # something to say, so a clean detection stays a clean recipe.
        if declined:
            recipe["declined"] = list(declined)
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
    """Write a recipe where the generator will actually READ it back.

    This used to write only to ``generator/recipes/`` — inside the container
    image, which on Railway is EPHEMERAL. So detection appeared to succeed, the
    template worked, and the next deploy silently wiped the recipe: the owner
    pressed "detect again", it reported success, and some time later the
    calibration screen was back to "recipe is missing". A shipped theme never
    showed it, because its recipe is committed to the repo and ships in the
    image; only owner-uploaded templates lost theirs.

    ``config.recipe_path`` has always READ the owner store first — its own
    docstring says "the recipe auto-detected for an owner-uploaded template is
    written to DATA_DIR/templates/recipes/", and server/templates.js says the
    same. Both described a behaviour this function never had. Now it does.
    """
    import config

    root = config.owner_store()
    base = os.path.join(root, "recipes") if root else os.path.join(HERE, "recipes")
    os.makedirs(base, exist_ok=True)
    path = os.path.join(base, f"{theme}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(recipe, f, ensure_ascii=False, indent=1)
    return path


def theme_fronts(theme):
    """The registered theme's own front list, or ``None`` when it has none.

    A template may declare FEWER fronts than the default eight — a deck where
    every card carries the SAME front design ships ``clean/1.svg`` and
    ``clean/2.svg`` and nothing else, and its themes.json entry says
    ``cards: {fronts: [2]}``. Walking 2..9 for it still works (missing pairs are
    skipped) but reports seven files as absent, which reads like a broken upload.

    Never fatal: detection must run for an UNREGISTERED theme too (that is how a
    template is measured before its entry exists), so anything unresolvable
    simply falls back to the default set.
    """
    try:
        import config

        return config.fronts(config.theme(theme))
    except Exception:
        return None


def main_single(template_dir, theme):
    recipe = detect_single_card(theme, template_dir, fronts=theme_fronts(theme))
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
    # Through ``write_recipe``, exactly as the v2 path does. This branch wrote
    # straight into ``generator/recipes/`` — inside the container image, which on
    # Railway is EPHEMERAL — so an 8-up template's re-detected recipe survived
    # until the next deploy and then silently reverted. That is the bug
    # ``write_recipe`` exists to fix; it was only ever wired into the single-card
    # branch, and the sheet templates kept losing theirs.
    path = write_recipe(theme, recipe)
    vis.save(f"/tmp/gen/{theme}_recipe.png")
    mask.save(f"/tmp/gen/{theme}_diffmask.png")
    print(f"wrote {path} + /tmp/gen/{theme}_recipe.png + _diffmask.png")
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
