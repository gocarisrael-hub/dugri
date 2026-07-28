#!/usr/bin/env python3
"""Auto-derive a template's CALIBRATION blob by diffing filled vs clean art.

Onboarding a template used to need a hand pass in themes.json: where the honoree
title sits on the board and on the card back, and what colours it is painted in.
Those are all *measurable*, because the upload flow already requires both halves
of every sheet — ``filled/*.svg`` (the Canva original, text and all) and
``clean/*.svg`` (the same artwork with the personalized text removed). Subtract
one from the other and what is left is exactly the text:

    |filled - clean|  ==  the personalized ink, with zero background confusion

which is the same primitive ``recipe_diff.py`` already uses to find the front
card's word/title slots on upload. This module points it at the two sheets
nobody had automated — the board and the backs — and reads the title's colours
off the fronts.

Output is the SAME blob shape the admin calibration form edits and
``preview.py --calibration`` renders::

    {"title_style": {...}, "board": {...}, "back": {...}, "word_size": null,
     "confidence": {...}, "notes": [...]}

``confidence`` and ``notes`` are advisory extras for the admin UI (the server's
validator ignores unknown keys). Values this pass CANNOT measure are left out
rather than guessed, so the form shows them as the owner's remaining work:

  size / board_size / back_size   the auto-fit in render_page.title_block sizes
                                  the title to its box; a pinned size is only
                                  needed where auto-fit over/undershoots, which
                                  is a visual call
  arch                            only meaningful on a genuinely curved title
  offset                          a nudge that CORRECTS a mis-detected box; if
                                  detection is right it is zero by definition
  word_size                       the words auto-fit their slots from the recipe

Deliberately NOT flipped: ``calibrated``. This pass pre-fills the numbers; a
human confirms them in the admin preview before the template can be ordered.

SINGLE-CARD (v2) TEMPLATES. A migrated template ships one portrait card per file
— ``clean/1.svg`` (the back) and ``clean/2.svg``..``9.svg`` (eight fronts) —
instead of the 8-up ``backs.svg`` / ``fronts.svg`` sheets. Every measurement
below is unchanged; only WHERE it reads from moves, because the whole page is
now one card and there is no cell to pick out of a grid. The board keeps its own
named file in both structures, so that branch is shared verbatim.

The split of responsibilities is the schema's (docs/card-structure-schema.md): the
per-front title BOX is geometry and belongs to the recipe, which
``recipe_diff.py`` writes; this module keeps owning the STYLE knobs — the
title's paints, ring thickness, alignment, shadow — and those are SHARED across
all eight fronts, so one front is measured and the answer stands for the deck.

  python3 generator/calibrate.py <theme-key> [--out FILE]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter

from PIL import Image, ImageChops, ImageFilter

import config
import recipe_diff

CHROME = os.environ.get(
    "CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
HERE = os.path.dirname(os.path.abspath(__file__))
SCALE = 2
# Per-channel delta above which a pixel counts as "the text changed here". Same
# threshold recipe_diff uses — high enough to ignore antialiasing noise between
# two renders of the same background, low enough to catch pale title ink.
DIFF_THRESHOLD = 45


def _dims(svg):
    """(render width, render height, viewBox) for an SVG, read from its header."""
    import re
    head = open(svg, encoding="utf-8").read(2000)
    w = int(re.search(r'width="(\d+)"', head).group(1))
    h = int(re.search(r'height="(\d+)"', head).group(1))
    vb = [float(x) for x in re.search(r'viewBox="([^"]+)"', head).group(1).split()]
    return w, h, vb


def _render(svg, png, w, h):
    subprocess.run([CHROME, "--headless", "--disable-gpu",
                    f"--force-device-scale-factor={SCALE}",
                    f"--screenshot={png}", f"--window-size={w},{h}", svg],
                   check=True, stderr=subprocess.DEVNULL)


def _diff(filled_svg, clean_svg, workdir):
    """Render both sheets and return (ink_mask, filled_image, viewBox).

    ``ink_mask`` is white exactly where the filled sheet differs from the clean
    one — i.e. the personalized text and nothing else.
    """
    w, h, vb = _dims(clean_svg)
    fp = os.path.join(workdir, "filled.png")
    cp = os.path.join(workdir, "clean.png")
    # Re-inline a deduped background before rasterizing. A migrated template
    # keeps its multi-megabyte artwork once per theme and leaves a marker in each
    # card; Chrome cannot resolve that, and two backgroundless cards would diff
    # to whatever the missing artwork was covering. No-op when there is no
    # marker, so every v1 sheet renders from its own file exactly as before.
    _render(recipe_diff._renderable(filled_svg, workdir, "_filled.svg"), fp, w, h)
    _render(recipe_diff._renderable(clean_svg, workdir, "_clean.svg"), cp, w, h)
    fim = Image.open(fp).convert("RGB")
    cim = Image.open(cp).convert("RGB")
    if fim.size != cim.size:
        cim = cim.resize(fim.size)
    d = ImageChops.difference(fim, cim).convert("L")
    return d.point(lambda v: 255 if v > DIFF_THRESHOLD else 0), fim, vb


def _bbox(mask, region=None):
    """Bounding box of the ink in ``mask`` (optionally within ``region``)."""
    sub = mask.crop(region) if region else mask
    box = sub.getbbox()
    if not box:
        return None
    if region:
        return (box[0] + region[0], box[1] + region[1],
                box[2] + region[0], box[3] + region[1])
    return box


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(int(c) for c in rgb)


def _dominant_color(image, mask, box):
    """The single most common colour under ``mask`` inside ``box``.

    Deliberately the MODE and not the mean: these are flat vector fills, so the
    design's exact colour is the most frequent pixel value, while averaging
    would fold in the antialiased rim where fill, ring and background blend and
    return a colour that appears nowhere in the artwork.
    """
    im = image.crop(box)
    mk = mask.crop(box)
    px, mp = im.load(), mk.load()
    w, h = im.size
    counts = Counter()
    for y in range(h):
        for x in range(w):
            if mp[x, y]:
                counts[px[x, y]] += 1
    if not counts:
        return None
    return _hex(counts.most_common(1)[0][0])


def _shrink_to_clean_border(mask, region, max_frac=0.10, step_frac=0.01):
    """Shrink ``region`` until no ink touches its border, or the cap is hit.

    A filled and a clean sheet can differ across the whole page MARGIN (crop
    marks, a page background one export carries and the other doesn't), which
    puts ink along the edge of every card cell and makes a naive bounding box
    swallow the entire cell. Pulling the region in until its rim is clean
    isolates the title actually sitting inside the card.

    Adaptive rather than a fixed inset: a sheet whose margins already match is
    clean on the first check and is not shrunk at all, so a title that genuinely
    runs close to the card edge keeps its true extent.
    """
    x0, y0, x1, y1 = region
    w, h = x1 - x0, y1 - y0
    dx, dy = max(1, int(w * step_frac)), max(1, int(h * step_frac))
    for _ in range(int(max_frac / step_frac)):
        if x1 - x0 < 4 * dx or y1 - y0 < 4 * dy:
            break
        rim = [(x0, y0, x1, y0 + dy), (x0, y1 - dy, x1, y1),
               (x0, y0, x0 + dx, y1), (x1 - dx, y0, x1, y1)]
        if not any(mask.crop(r).getbbox() for r in rim):
            break
        x0, y0, x1, y1 = x0 + dx, y0 + dy, x1 - dx, y1 - dy
    return (x0, y0, x1, y1)


# A colour cluster must hold at least this share of the title's ink to count as
# one of its two paints, and the two must sit at least this far apart in RGB.
# Below the share, what we are looking at is antialiasing, not a second paint.
_MIN_CLUSTER_SHARE = 0.05
_MIN_CLUSTER_DIST = 60


def _rgb_dist(a, b):
    return sum(abs(p - q) for p, q in zip(a, b))


_FILL_ATTR_RE = re.compile(r'fill="(#[0-9a-fA-F]{3,6})"')


def _svg_fill_counts(path):
    """How many times each ``fill="#rrggbb"`` appears in an SVG."""
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            return Counter(m.lower() for m in _FILL_ATTR_RE.findall(f.read()))
    except OSError:
        return None


def _hex_to_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def candidate_paints(filled_svg, clean_svg, exclude=()):
    """The paints the personalized text ADDS to a sheet, read from the vector.

    Rasterizing loses this. On a small front-card title the ring covers the fill
    so completely that the fill colour does not survive into the pixels at all —
    on 'birthday-girls' it is absent from the render entirely, so no amount of
    image analysis can recover it. The SVG source still carries it exactly, as a
    ``fill`` attribute.

    A plain set difference is not enough either: a title's colours usually also
    appear elsewhere in the background artwork, so they are present in BOTH
    sheets. What distinguishes the text is that the filled sheet uses those
    colours MORE — each added glyph carries its own fill attribute. So compare
    counts and keep what went up.

    ``exclude`` drops known-irrelevant colours; on the fronts sheet that is the
    recipe's word-slot colours, leaving the title's own paints. Returns
    ``[(hex, count_delta), ...]`` most-added first, and an empty list when the
    sheet encodes colour some other way (a style block, inherited group fills) —
    in which case the caller falls back to reading pixels.
    """
    f = _svg_fill_counts(filled_svg)
    c = _svg_fill_counts(clean_svg)
    if not f or c is None:
        return []
    skip = {str(e).lower() for e in exclude}
    out = []
    for colour, n in f.items():
        if colour in skip:
            continue
        delta = n - c.get(colour, 0)
        if delta > 0:
            out.append((colour, delta))
    out.sort(key=lambda kv: -kv[1])
    return out


def assign_paints(candidates, image, mask, box):
    """Decide which of two KNOWN paints is the fill and which is the outline.

    ``candidates`` come from the SVG, so this only has to answer which is which
    — a far easier question than recovering them from pixels. The ring is the
    paint that borders the background; the fill is the one it encloses.

    Prevalence deliberately is NOT the discriminator: which paint dominates
    flips with the title's size (the ring covers the fill on a small front-card
    title, while the fill dominates on a large board one), so counting pixels
    would give opposite answers on the same design.

    Returns ``(fill, outline)``; ``(colour, colour)`` for a single-paint title;
    ``(None, None)`` when they cannot be told apart.
    """
    picks = [c for c, _ in candidates[:2]]
    if not picks:
        return None, None
    if len(picks) == 1:
        return picks[0], picks[0]
    rgb = {p: _hex_to_rgb(p) for p in picks}
    # Pad with background. ``box`` is the ink's tight bounding box, so a bare
    # crop has ink flush against every edge and the title's true OUTER boundary
    # — the thing that identifies the ring — falls outside the scan entirely.
    pad = 2
    bw, bh = box[2] - box[0], box[3] - box[1]
    region = Image.new("L", (bw + 2 * pad, bh + 2 * pad), 0)
    region.paste(mask.crop(box), (pad, pad))
    crop = Image.new("RGB", region.size, (0, 0, 0))
    crop.paste(image.crop(box), (pad, pad))
    px, mp = crop.load(), region.load()
    w, h = region.size
    edge = {p: 0 for p in picks}
    tot = {p: 0 for p in picks}
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if not mp[x, y]:
                continue
            here = px[x, y]
            near = min(picks, key=lambda p: _rgb_dist(rgb[p], here))
            if _rgb_dist(rgb[near], here) > _MIN_CLUSTER_DIST:
                continue
            tot[near] += 1
            if not (mp[x - 1, y] and mp[x + 1, y] and mp[x, y - 1] and mp[x, y + 1]):
                edge[near] += 1
    seen = [p for p in picks if tot[p]]
    if not seen:
        return None, None
    if len(seen) == 1:
        # Only one paint survives into the render; the other is fully covered.
        # What covers is the ring, so the visible one is the outline.
        other = [p for p in picks if p != seen[0]][0]
        return other, seen[0]
    # Count the ink's OUTER boundary by colour and take the majority owner as the
    # ring. Deliberately an absolute count, not a per-paint ratio: a paint that is
    # mostly covered contributes few pixels, so its ratio is computed over a tiny
    # sample and swings wildly — that is what put 'birthday-girls' the wrong way
    # round (its pale fill barely survives the render, and its handful of stray
    # boundary pixels outscored the black ring that genuinely encloses it).
    if edge[seen[0]] == edge[seen[1]]:
        return None, None
    outline = max(seen, key=lambda p: edge[p])
    fill = min(seen, key=lambda p: edge[p])
    return fill, outline


def _fill_and_outline(image, mask, box):
    """Separate a painted title into its FILL and its OUTLINE colour.

    The shipped titles are a fill inside a contrasting ring. Erosion looks like
    the obvious way to split them, but it fails exactly where it matters: on the
    small FRONT-card titles the ring covers so much of each glyph that the fill
    is a minority at every erosion depth (on 'trip comeback' the fill colour does
    not appear in the top eight ink colours at all). So cluster instead — the two
    paints are the two dominant colours of the ink — and tell them apart by
    ADJACENCY: the outline is the paint that borders the background, the fill is
    the one enclosed by it.

    Returns ``(fill, outline, outline_w)``, any of which may be None. None means
    "could not measure", never a guess: a single-paint title, or ink too small to
    read, leaves the value for the owner rather than inventing one.
    """
    region = mask.crop(box)
    w, h = region.size
    if w < 4 or h < 4:
        return None, None, None

    # LARGE ink (the board title, and most card backs) separates cleanly by
    # erosion: peel the glyphs inward and the ring is exactly what comes off.
    # This is the most accurate path when the title is big enough for it — it
    # reproduces the shipped themes' paints exactly — so try it first and fall
    # through to clustering only on ink too small to erode.
    if min(w, h) >= 40:
        # Erode on a PADDED copy. ``box`` is the ink's tight bounding box, so in a
        # bare crop the ink sits flush against the edge — and the filter
        # replicates edge pixels, so the outermost ring would never be eaten and
        # the band would come back empty. A margin of background gives the
        # erosion something to bite from on all four sides.
        pad = 2
        pregion = Image.new("L", (w + 2 * pad, h + 2 * pad), 0)
        pregion.paste(region, (pad, pad))
        pimage = Image.new("RGB", pregion.size, (0, 0, 0))
        pimage.paste(image.crop(box), (pad, pad))
        pbox = (0, 0, pregion.size[0], pregion.size[1])
        eroded, steps = pregion, 0
        area0 = sum(pregion.point(lambda v: 1 if v else 0).getdata())
        while steps < 6:
            nxt = eroded.filter(ImageFilter.MinFilter(3))
            area = sum(nxt.point(lambda v: 1 if v else 0).getdata())
            if not nxt.getbbox() or area < 0.05 * area0:
                break
            eroded, steps = nxt, steps + 1
        if steps:
            band = ImageChops.difference(pregion, eroded)
            f = _dominant_color(pimage, eroded, pbox)
            o = _dominant_color(pimage, band, pbox)
            if f and o and _rgb_dist(
                    tuple(int(f[i:i + 2], 16) for i in (1, 3, 5)),
                    tuple(int(o[i:i + 2], 16) for i in (1, 3, 5))) > _MIN_CLUSTER_DIST:
                lines = max(1, _line_count(region))
                gh = h / lines
                ow = round(steps / gh, 3) if gh else None
                return f, o, (ow if ow and 0 < ow < 0.5 else None)

    crop = image.crop(box)
    px, mp = crop.load(), region.load()
    counts = Counter()
    for y in range(h):
        for x in range(w):
            if mp[x, y]:
                counts[px[x, y]] += 1
    total = sum(counts.values())
    if not total:
        return None, None, None
    picks = []
    for colour, n in counts.most_common(60):
        if n / total < _MIN_CLUSTER_SHARE:
            break
        if all(_rgb_dist(colour, p) > _MIN_CLUSTER_DIST for p in picks):
            picks.append(colour)
        if len(picks) == 2:
            break
    if len(picks) < 2:
        # ONE paint: this title has no ring at all. That is a real, measurable
        # answer rather than a failure — several shipped themes are exactly this,
        # and encode it as fill == outline with outline_w 0. Return it that way so
        # an un-outlined title calibrates automatically instead of landing on the
        # owner's desk as "couldn't measure".
        if not picks:
            return None, None, None
        only = _hex(picks[0])
        return only, only, 0.0

    # Which paint touches the background? Count, per cluster, the share of its
    # pixels that sit on the ink boundary.
    edge = {p: 0 for p in picks}
    tot = {p: 0 for p in picks}
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if not mp[x, y]:
                continue
            near = min(picks, key=lambda q: _rgb_dist(q, px[x, y]))
            if _rgb_dist(near, px[x, y]) > _MIN_CLUSTER_DIST:
                continue
            tot[near] += 1
            if not (mp[x - 1, y] and mp[x + 1, y] and mp[x, y - 1] and mp[x, y + 1]):
                edge[near] += 1
    share = {p: edge[p] / max(1, tot[p]) for p in picks}
    outline = max(share, key=share.get)
    fill = min(share, key=share.get)
    if share[outline] - share[fill] < 0.05:
        # Neither paint is clearly the one on the outside — don't guess which.
        return None, None, None
    # Ring thickness: its pixel count spread over the ink's perimeter, expressed
    # against the height of ONE title line (the glyph size title_block scales by).
    lines = max(1, _line_count(region))
    glyph_h = h / lines
    perim = max(1, edge[outline])
    outline_w = round((tot[outline] / perim) / glyph_h, 3) if glyph_h else None
    if outline_w is not None and not (0 < outline_w < 0.5):
        outline_w = None
    return _hex(fill), _hex(outline), outline_w


# A detected title box larger than this share of its surface is not a title —
# it means the filled/clean pair differs across the whole sheet (a background one
# export carries and the other doesn't) and the diff caught the artwork itself.
_MAX_SLOT_AREA = 0.45


def _plausible(box, region):
    """Whether a detected box is small enough to actually be a title slot."""
    bw, bh = box[2] - box[0], box[3] - box[1]
    rw, rh = region[2] - region[0], region[3] - region[1]
    if bw <= 0 or bh <= 0 or rw <= 0 or rh <= 0:
        return False
    return (bw * bh) / (rw * rh) <= _MAX_SLOT_AREA


def _row_runs(region, min_frac=0.01):
    """Vertical runs of inked rows in a mask crop — one run per title line."""
    w, h = region.size
    px = region.load()
    thr = max(1, int(min_frac * w))
    runs = []
    y = 0
    while y < h:
        if sum(1 for x in range(w) if px[x, y]) > thr:
            y0 = y
            while y < h and sum(1 for x in range(w) if px[x, y]) > thr:
                y += 1
            runs.append((y0, y))
        else:
            y += 1
    return runs


def _line_count(region):
    return len(_row_runs(region))


def _alignment(mask, box):
    """Infer the title's alignment from how its lines stack.

    Left-aligned lines share a left edge and ragged right; right-aligned the
    mirror; centred lines are ragged on both sides but share a midpoint. Needs
    at least two lines — a single-line title carries no alignment signal at all,
    so this returns None and the caller leaves the default in place.
    """
    region = mask.crop(box)
    runs = _row_runs(region)
    if len(runs) < 2:
        return None
    px = region.load()
    w = region.size[0]
    lefts, rights = [], []
    for y0, y1 in runs:
        xs = [x for y in range(y0, y1) for x in range(w) if px[x, y]]
        if not xs:
            continue
        lefts.append(min(xs))
        rights.append(max(xs))
    if len(lefts) < 2:
        return None

    def spread(v):
        return max(v) - min(v)

    mids = [(a + b) / 2 for a, b in zip(lefts, rights)]
    sl, sr, sm = spread(lefts), spread(rights), spread(mids)
    best = min(sl, sr, sm)
    # Require a clear winner; near-ties mean the lines happen to be similar
    # widths and the signal is meaningless.
    others = sorted([sl, sr, sm])
    if others[1] - others[0] < 0.02 * w:
        return None
    return {sl: "left", sr: "right", sm: "center"}[best]


def _has_shadow(image, mask, box):
    """Whether the title carries a drop shadow.

    A shadow shows up as ink offset DOWN from the glyph body in a colour close
    to the outline's — so the ink mask's bottom band holds pixels that the
    eroded body does not. Cheap heuristic; reported at low confidence.
    """
    region = mask.crop(box)
    w, h = region.size
    if h < 8:
        return None
    px = region.load()
    rows = [sum(1 for x in range(w) if px[x, y]) for y in range(h)]
    if not any(rows):
        return None
    peak = max(rows)
    # A shadow leaves a thin, low-density tail under the glyph body.
    tail = rows[int(h * 0.88):]
    return bool(tail) and 0 < max(tail) < 0.25 * peak


def _slot(filled_svg, clean_svg, workdir, cell=None):
    """Detect one title slot (board or one card back).

    ``cell`` optionally restricts detection to a single card cell, in RENDER
    pixels — needed for the backs sheet, whose slot fractions are expressed
    relative to the card cell rather than the page.
    """
    mask, image, vb = _diff(filled_svg, clean_svg, workdir)
    region = _shrink_to_clean_border(mask, cell or (0, 0) + mask.size)
    box = _bbox(mask, region)
    if not box or not _plausible(box, region):
        return None, None, vb, mask, image
    fill, outline, outline_w = _fill_and_outline(image, mask, box)
    return ({"box": box, "fill": fill, "outline": outline, "outline_w": outline_w},
            box, vb, mask, image)


def is_single_card(cfg, template_dir):
    """Whether this template calibrates as a v2 single-card deck.

    The theme's own ``card_layout`` wins — it is the discriminator the schema
    locks and the one the renderer obeys. The ART is only the fallback, for the
    window in which a template has been uploaded but its entry not yet flipped:
    without it every surface would report "filled/clean pair missing, skipped"
    and the owner would be handed an empty calibration for a template that is
    perfectly measurable.
    """
    if config.is_single_card(cfg):
        return True
    return recipe_diff.template_layout(template_dir) == "single"


def _viewport(mask, vb):
    """``(ppu, ox, oy)`` for a rendered card — the exact xMidYMid-meet mapping.

    Shared with ``recipe_diff`` on purpose: the recipe's boxes and this pass's
    crops must land on the same pixels, and a width-only scale is 0.15% out on a
    portrait card — enough to clip the foot of a title box before its paints are
    read.
    """
    w, h = mask.size
    return recipe_diff.viewport(vb, w / SCALE, h / SCALE)


def _front_title_boxes(recipe, cfg, single):
    """The first front title recorded in a recipe, in recipe units, or None.

    The paints are SHARED across the eight fronts, so one measured surface
    settles them for the whole deck — which front it came from does not matter,
    only that it carries ink.
    """
    if single:
        for index in config.fronts(cfg):
            boxes = config.recipe_front_title(recipe, index)
            if boxes:
                return boxes
        return None
    for card in recipe.get("cards") or []:
        if card and card.get("title"):
            return card["title"]
    return None


def _word_colours(recipe):
    """Every word-slot colour a recipe records, lowercased, either structure."""
    cards = recipe.get("cards")
    if not cards:
        card = recipe.get("card")
        cards = [card] if isinstance(card, dict) else []
    return {(slot.get("color") or "").lower()
            for c in cards if c
            for slot in c.get("words", []) if slot.get("color")}


def calibrate(theme_key, workdir=None):
    """Derive the calibration blob for a theme from its filled/clean art."""
    cfg = config.theme(theme_key)
    tdir = config.theme_dir(theme_key)
    own = workdir is None
    workdir = workdir or tempfile.mkdtemp(prefix="dugri-calibrate-")
    notes, confidence = [], {}
    out = {"title_style": {}, "board": None, "back": None, "word_size": None}
    board_paints = None
    single = is_single_card(cfg, tdir)

    def sheet(kind, half):
        return os.path.join(tdir, half, kind + ".svg")

    try:
        # --- BOARD: one title on the page; fractions are of the page viewBox ---
        bf, bc = sheet("board", "filled"), sheet("board", "clean")
        if os.path.exists(bf) and os.path.exists(bc):
            slot, box, vb, mask, image = _slot(bf, bc, workdir)
            if slot:
                w, h = mask.size
                # Geometry and colour are graded SEPARATELY: the box is measured
                # far more reliably than the paints, and a design whose colours
                # can't be read still gets its slot placed correctly.
                fill, outline = slot["fill"], slot["outline"]
                if fill and outline and fill != outline:
                    confidence["board.colors"] = "high"
                    # The board title is the LARGEST rendering of this design's
                    # title, so it is the one surface where both paints are
                    # reliably legible — the fronts can borrow from it below.
                    board_paints = (fill, outline, slot["outline_w"])
                else:
                    fill = outline = fill or _dominant_color(image, mask, box)
                    notes.append("board: the title box is measured, but its two "
                                 "paints could not be told apart — fill and "
                                 "outline are both set to the dominant ink colour "
                                 "and need confirming.")
                    confidence["board.colors"] = "low"
                out["board"] = {
                    "frac": {"x0": round(box[0] / w, 4), "y0": round(box[1] / h, 4),
                             "x1": round(box[2] / w, 4), "y1": round(box[3] / h, 4)},
                    "fill": fill, "outline": outline,
                }
                confidence["board.frac"] = "high"
            else:
                notes.append("board: could not isolate a title — either this "
                             "design carries no board title, or the filled and "
                             "clean boards differ across the whole sheet. Set the "
                             "board slot by hand.")
                confidence["board"] = "none"
        else:
            notes.append("board: filled/clean pair missing, skipped.")
            confidence["board"] = "none"

        # --- BACKS: one title per card; fractions are of the CARD CELL ---
        # v2 needs NO recipe to find that cell: the back is one whole card
        # (``clean/1.svg``), so the cell IS the page. Everything downstream — the
        # shrink-to-clean-border guard, the plausibility check, the vector-first
        # paint reading — is the v1 body unchanged, just handed one cell instead
        # of eight.
        recipe_path = config.recipe_path(cfg["recipe"])
        if single:
            kf = config.card_path(theme_key, config.back_index(cfg), filled=True)
            kc = config.card_path(theme_key, config.back_index(cfg))
        else:
            kf, kc = sheet("backs", "filled"), sheet("backs", "clean")
        if (os.path.exists(kf) and os.path.exists(kc)
                and (single or os.path.exists(recipe_path))):
            mask, image, vb = _diff(kf, kc, workdir)
            w, h = mask.size
            if single:
                cells = [(0.0, 0.0, float(w), float(h))]
            else:
                recipe = json.load(open(recipe_path, encoding="utf-8"))
                ppu = w / vb[2]
                cells = [tuple(v * ppu for v in card["cell"])
                         for card in recipe["cards"] if card]
            got = None
            for cx0, cy0, cx1, cy1 in cells:
                region = _shrink_to_clean_border(
                    mask, (int(cx0), int(cy0), int(cx1), int(cy1)))
                box = _bbox(mask, region)
                if not box or not _plausible(box, region):
                    continue
                cw, ch = cx1 - cx0, cy1 - cy0
                # Prefer the paints named by the vector source; the backs sheet
                # carries ONLY the title, so nothing needs excluding.
                fill, outline = assign_paints(
                    candidate_paints(kf, kc), image, mask, box)
                if not (fill and outline):
                    fill, outline, _ = _fill_and_outline(image, mask, box)
                if fill and outline:
                    confidence["back.colors"] = "high" if fill != outline else "low"
                else:
                    fill = outline = fill or _dominant_color(image, mask, box)
                    notes.append("back: the title box is measured, but its two "
                                 "paints could not be told apart — fill and "
                                 "outline are both set to the dominant ink colour "
                                 "and need confirming.")
                    confidence["back.colors"] = "low"
                got = {
                    "frac": {"x0": round((box[0] - cx0) / cw, 4),
                             "y0": round((box[1] - cy0) / ch, 4),
                             "x1": round((box[2] - cx0) / cw, 4),
                             "y1": round((box[3] - cy0) / ch, 4)},
                    "fill": fill, "outline": outline,
                }
                break
            out["back"] = got
            confidence["back.frac"] = "high" if got else "none"
            if not got:
                notes.append("back: could not isolate a title — this design may "
                             "carry no title on the card back (several don't), or "
                             "its filled and clean backs differ across the whole "
                             "surface.")
        else:
            notes.append("back: filled/clean pair or recipe missing, skipped.")
            confidence["back"] = "none"

        # --- FRONTS: the title's paint colours, ring thickness and alignment ---
        # These knobs are SHARED across the whole deck (docs/card-structure-schema.md),
        # so ONE front settles them — v1 already worked that way, taking the first
        # card on the sheet that carries a title. v2 just reads its title box out
        # of the per-front recipe entry instead of out of a card cell.
        if single:
            front_index = config.fronts(cfg)[0]
            ff = config.card_path(theme_key, front_index, filled=True)
            fc = config.card_path(theme_key, front_index)
        else:
            ff, fc = sheet("fronts", "filled"), sheet("fronts", "clean")
        if os.path.exists(ff) and os.path.exists(fc) and os.path.exists(recipe_path):
            recipe = json.load(open(recipe_path, encoding="utf-8"))
            mask, image, vb = _diff(ff, fc, workdir)
            w, _h = mask.size
            # v1 geometry is page-relative at a width-only scale; a v2 card is
            # letterboxed inside its window, so it needs the real viewport map.
            ppu, ox, oy = _viewport(mask, vb) if single else (w / vb[2], 0.0, 0.0)
            t = _front_title_boxes(recipe, cfg, single)
            if t:
                box = (int(min(b["x0"] for b in t) * ppu + ox),
                       int(min(b["y0"] for b in t) * ppu + oy),
                       int(max(b["x1"] for b in t) * ppu + ox),
                       int(max(b["y1"] for b in t) * ppu + oy))
                tight = _bbox(mask, box) or box
                ts = out["title_style"]
                _, _, outline_w = _fill_and_outline(image, mask, tight)

                # Read the title's paints from the VECTOR, not the pixels. The
                # front carries both the title and the words, so exclude the word
                # colours the recipe already recorded — what is left is the
                # title's own fill and ring.
                cands = candidate_paints(ff, fc, exclude=_word_colours(recipe))
                fill, outline = assign_paints(cands, image, mask, tight)
                source = "vector"
                if not (fill and outline):
                    # The sheet encodes colour some other way (style block,
                    # inherited group fill). Fall back to reading the render.
                    fill, outline, _ow = _fill_and_outline(image, mask, tight)
                    source = "raster"
                    if outline_w is None:
                        outline_w = _ow

                if fill and outline:
                    ts["fill"], ts["outline"] = fill, outline
                    # A two-paint reading taken from the vector source is exact:
                    # the only question it had to answer was which of two KNOWN
                    # colours is the ring. A single-paint one is weaker — "this
                    # title has no ring" and "the ring covered the fill" look the
                    # same — and a raster-derived one weaker still, since on a
                    # small title the fill may not survive into the pixels at all.
                    if fill != outline and source == "vector":
                        grade = "high"
                    elif fill != outline:
                        grade = "medium"
                    else:
                        grade = "low"
                    confidence["title_style.fill"] = grade
                    confidence["title_style.outline"] = grade
                    if grade == "low":
                        notes.append("title: only one paint was found for the front "
                                     "title. If this design's title actually has an "
                                     "outline, the colour below is that OUTLINE and "
                                     "the fill still needs setting.")
                else:
                    notes.append("title: could not read the front title's colours "
                                 "— set fill and outline by hand.")
                    confidence["title_style.fill"] = "none"
                    confidence["title_style.outline"] = "none"
                if outline_w is not None:
                    ts["outline_w"] = outline_w
                    confidence["title_style.outline_w"] = "low"
                else:
                    notes.append("title: ring thickness (outline_w) could not be "
                                 "measured — set it by eye against the original.")
                    confidence["title_style.outline_w"] = "none"
                shadow = _has_shadow(image, mask, tight)
                if shadow is not None:
                    ts["shadow"] = bool(shadow)
                    confidence["title_style.shadow"] = "low"
                align = _alignment(mask, tight)
                if align:
                    ts["align"] = align
                    confidence["title_style.align"] = "medium"
            if not out["title_style"]:
                notes.append("title: no card in the recipe carries a title slot.")
        else:
            notes.append("fronts: filled/clean pair or recipe missing, skipped.")

        notes.append("size / board_size / back_size left unset — the renderer "
                     "auto-fits the title to its box; pin one only if that "
                     "over- or under-shoots.")
        notes.append("arch and offset are visual calls and stay manual.")
        out["confidence"] = confidence
        out["notes"] = notes
        return out
    finally:
        if own:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(
        description="Auto-derive a template's calibration blob from its art")
    ap.add_argument("theme", help="a key in generator/themes.json")
    ap.add_argument("--out", default=None, metavar="FILE",
                    help="write the blob here (default: stdout as JSON)")
    args = ap.parse_args()

    blob = calibrate(args.theme)
    text = json.dumps(blob, ensure_ascii=False, indent=1)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        ts = blob.get("title_style") or {}
        print(f"calibrated {args.theme!r}: "
              f"board={'yes' if blob.get('board') else 'no'} "
              f"back={'yes' if blob.get('back') else 'no'} "
              f"title_fill={ts.get('fill') or '-'} -> {args.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
