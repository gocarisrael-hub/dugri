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

  arch                            only meaningful on a genuinely curved title
  offset                          a nudge that CORRECTS a mis-detected box; if
                                  detection is right it is zero by definition

THE SIZES AND THE BOLD WEIGHT are measured too — see "AUTO-FIT" below. They used
to be left unset "because auto-fit handles it", which in practice meant the owner
read them off Canva's UI by hand. They are derivable from the very artwork this
pass already renders, so it derives them; anything that cannot be measured with
confidence still comes back unset, because the renderer's auto-fit is a good
fallback and a wrong pin is worse than none.

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
import functools
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
from collections import Counter

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

import calibration_health
import config
import recipe_diff
import topup

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


# ---- AUTO-FIT: the sizes, and the synthetic-bold weight ---------------------
#
# The mask above is the ORIGIN's own ink, so it also records how TALL that ink is
# and how HEAVY its strokes are. Both answer knobs that were previously read off
# Canva's UI by hand: ``size``/``board_size``/``back_size``, ``word_size``, and
# ``bold``/``bold_w``. The method is the same for all of them — measure the
# origin's ink, paint OUR text with the THEME's font at a candidate value, and
# keep the candidate whose ink matches.
#
# The candidate side is PIL, not Chrome. PIL opens the very font file the
# renderer hands the browser, and paints it to within a pixel of what headless
# Chrome does at the same em: verified on grapefruit's card, where 'עורך דין' at
# word size 21.3 measured 58px through PIL and 59px through the real render. So a
# fit costs milliseconds and needs no browser, while still predicting what the
# generator will actually print.

# How many wordlist entries a word-size fit probes. The origin's four words are
# unknown text, so the fit matches the MEDIAN of their ink heights against the
# median of a sample of the words this theme actually prints; a few dozen is
# plenty for a median and keeps the fit well under a second.
_FIT_WORD_SAMPLE = 40

# A fitted size must stay in a sane band around the box it was measured in.
# Outside it the "ink" was never text (the diff caught artwork), and pinning the
# number would be worse than leaving auto-fit alone.
_FIT_SIZE_BOX = (0.25, 4.0)

# Synthetic-bold search: the grid, and the weight below which the face is
# declared already-heavy-enough. Capped well under the point where a Hebrew
# counter would close up (render_page ships 0.035 as its default step).
_BOLD_W_GRID = [i / 200.0 for i in range(0, 17)]        # 0 .. 0.08 by 0.005
_BOLD_W_MIN = 0.01


def _alpha_threshold(ink_hex, bg_rgb):
    """The alpha at which OUR raster carries as much ink as the diff mask shows.

    The mask is ``|filled - clean|`` put through ``DIFF_THRESHOLD``, so the faint
    antialiased rim of every glyph is thresholded AWAY and never reaches it.
    Measuring a full-alpha raster against that would compare a taller glyph than
    the mask can physically show — and the error grows as the render shrinks,
    because the rim is roughly a constant number of PIXELS wide. Converting the
    diff threshold into the equivalent coverage for this ink-on-background pair
    (the same luminance conversion ``_diff`` applies) puts both sides through the
    same cut.
    """
    try:
        ink = _hex_to_rgb(ink_hex)
    except (AttributeError, TypeError, ValueError):
        return 128
    delta = [abs(a - b) for a, b in zip(ink, bg_rgb)]
    lum = 0.299 * delta[0] + 0.587 * delta[1] + 0.114 * delta[2]
    if lum <= 0:
        return 128
    return max(20, min(160, int(255 * DIFF_THRESHOLD / lum)))


def _background(image, mask, region):
    """The artwork colour UNDER the text: the mode of the un-inked pixels."""
    im = image.crop(region)
    mk = mask.crop(region)
    px, mp = im.load(), mk.load()
    counts = Counter()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            if not mp[x, y]:
                counts[px[x, y]] += 1
    return counts.most_common(1)[0][0] if counts else (255, 255, 255)


def _ink_extent(mask, box, ppu, ox, oy, pad=0.3):
    """``(h, w, region)`` of the ink inside ``box``, in mask pixels, or None.

    ``box`` is a recipe slot in user units — a region the origin's text sits in,
    not a hard clip: the origin's own ink overruns it by ~10% (render_page
    documents the same tolerance), so the crop is padded before the ink is
    measured or the glyphs' extremes would be sliced off and every fit would come
    back small.

    Returns None when the ink TOUCHES the padded crop's top or bottom edge. That
    means the band did not end inside the crop — a neighbouring line bled in, or
    the filled/clean pair differs across the whole surface — and its height is
    then the crop's height rather than the text's. A refusal here is what keeps a
    contaminated diff from being written out as a confident size.
    """
    bh = (box["y1"] - box["y0"]) * ppu
    bw = (box["x1"] - box["x0"]) * ppu
    if bh <= 0 or bw <= 0:
        return None
    region = (max(0, int(box["x0"] * ppu + ox - bw * 0.06)),
              max(0, int(box["y0"] * ppu + oy - bh * pad)),
              min(mask.size[0], int(box["x1"] * ppu + ox + bw * 0.06)),
              min(mask.size[1], int(box["y1"] * ppu + oy + bh * pad)))
    if region[2] - region[0] < 4 or region[3] - region[1] < 4:
        return None
    sub = mask.crop(region)
    ink = sub.getbbox()
    if not ink or ink[3] - ink[1] < 6:
        return None
    if ink[1] <= 0 or ink[3] >= sub.size[1]:
        return None
    return (ink[3] - ink[1], ink[2] - ink[0],
            (region[0] + ink[0], region[1] + ink[1],
             region[0] + ink[2], region[1] + ink[3]))


@functools.lru_cache(maxsize=64)
def _fit_font(path, px):
    return ImageFont.truetype(path, max(4, int(px)))


def _covers(font_path, text):
    """Whether this font can actually draw ``text``.

    A theme's title font is frequently a Latin display face while the honoree
    name is Hebrew (or the other way round). Chrome silently falls back to a
    system face for the missing glyphs — PIL draws them blank — so a fit against
    such a sample measures the wrong typeface entirely and must be refused.
    Detected as "a non-space character with no ink of its own", which is exactly
    how a font without the glyph reports it (measured on MrDafoe + Hebrew:
    getbbox returns a zero-height box).
    """
    try:
        font = _fit_font(font_path, 200)
    except (OSError, ValueError):
        return False
    for ch in set(text):
        if ch.isspace():
            continue
        box = font.getbbox(ch)
        if box[3] - box[1] <= 0:
            return False
    return True


def _paint(font_path, lines, em, alpha, stroke=0.0, marker=None):
    """Our renderer's painted text at ``em`` DEVICE pixels, as an ink mask.

    Mirrors what ``render_page`` will draw: title lines stacked on the same
    ``0.78 * size`` baseline spacing, or one numbered word line with its marker
    at ``0.9 * size`` (``word_text``'s own fractions). Cropped to the ink, so the
    caller measures the glyphs and never the canvas.
    """
    try:
        font = _fit_font(font_path, round(em))
    except (OSError, ValueError):
        return None
    lines = [ln for ln in lines if ln and ln.strip()]
    if not lines:
        return None
    width = int(max(font.getlength(ln) for ln in lines)) + int(em * 3) + 80
    height = int(em * (len(lines) + 3) * 1.4) + 80
    img = Image.new("L", (max(60, width), max(60, height)), 0)
    draw = ImageDraw.Draw(img)
    base = int(em * 1.6)
    for i, line in enumerate(lines):
        draw.text((40, base + i * 0.78 * em), line, font=font, fill=255,
                  anchor="ls", stroke_width=stroke, stroke_fill=255)
    if marker is not None:
        small = _fit_font(font_path, round(em * 0.9))
        draw.text((40 + int(font.getlength(lines[0]) + em * 0.30), base),
                  f"{marker}.", font=small, fill=255, anchor="ls",
                  stroke_width=stroke, stroke_fill=255)
    ink = img.point(lambda v: 255 if v >= alpha else 0)
    box = ink.getbbox()
    return ink.crop(box) if box else None


def _painted(font_path, samples, size, ppu, alpha, marker=False, axis=0):
    """Median painted extent (0 = height, 1 = width) of ``samples`` at ``size``."""
    got = []
    for i, lines in enumerate(samples):
        ink = _paint(font_path, lines, size * ppu, alpha,
                     marker=(i % 4 + 1) if marker else None)
        if ink:
            got.append(ink.size[1 - axis] if axis == 0 else ink.size[0])
    return statistics.median(got) if got else None


def _fit_size(target_px, font_path, samples, ppu, alpha, marker=False, axis=0):
    """The size (in recipe user units) whose painted ink measures ``target_px``.

    Bisection rather than a closed form: the painted extent is very nearly linear
    in the size, but the threshold above makes it a step function at the pixel
    level, and bisection lands on the step that matches instead of extrapolating
    through it.
    """
    lo, hi = 3.0, 160.0
    if not target_px or target_px <= 0:
        return None
    if _painted(font_path, samples, lo, ppu, alpha, marker, axis) is None:
        return None
    for _ in range(22):
        mid = (lo + hi) / 2
        got = _painted(font_path, samples, mid, ppu, alpha, marker, axis)
        if got is None:
            return None
        if got < target_px:
            lo = mid
        else:
            hi = mid
    return round((lo + hi) / 2, 2)


def _in_box(size, box_h):
    """Whether a fitted size is a plausible one for the box it was measured in."""
    if not size or not box_h or box_h <= 0:
        return False
    return _FIT_SIZE_BOX[0] <= size / box_h <= _FIT_SIZE_BOX[1]


def _mean_stroke(ink):
    """Mean distance from an ink pixel to the background — a stroke-width proxy.

    Deliberately NOT ink coverage over the text's bounding box: coverage moves
    with how LONG the text is and how tightly the face sets, and the honoree's
    name is not the origin's name. The mean distance-to-edge is a property of the
    strokes alone, so a title set in the same weight scores the same whatever it
    says. Computed as the erosion integral (sum of the areas that survive each
    successive erosion, over the original area), which IS the mean of the
    chessboard distance transform without needing one.
    """
    area0 = sum(ink.point(lambda v: 1 if v else 0).getdata())
    if not area0:
        return 0.0
    total, cur = 0.0, ink
    for _ in range(12):
        cur = cur.filter(ImageFilter.MinFilter(3))
        area = sum(cur.point(lambda v: 1 if v else 0).getdata())
        if not area:
            break
        total += area
    return total / area0


def _stroke_ratio(ink):
    """``_mean_stroke`` per unit of ink height — size-independent glyph weight."""
    if not ink or ink.size[1] <= 0:
        return None
    return _mean_stroke(ink) / ink.size[1]


def fit_bold(mask, region, font_path, samples, size, ppu, alpha):
    """``(bold, bold_w, note)`` for a title; ``bold`` is None when unmeasurable.

    Compares the ORIGIN's stroke weight against our own cut painted at the size
    that was just fitted, and walks the synthetic-bold grid for the weight that
    reproduces it. ``bold`` comes back False — never True with a token weight —
    when our unfattened cut already carries that weight, because emboldening a
    design that is not bold is the one outcome this must never produce.
    """
    origin = _stroke_ratio(mask.crop(region))
    if not origin:
        return None, None, None

    def weigh(weight):
        got = [_stroke_ratio(_paint(font_path, lines, size * ppu, alpha,
                                    stroke=weight * size * ppu))
               for lines in samples]
        return statistics.median([g for g in got if g]) if any(got) else None

    scored = [(abs(got - origin), weight)
              for weight, got in ((w, weigh(w)) for w in _BOLD_W_GRID) if got]
    if not scored:
        return None, None, None
    if weigh(_BOLD_W_GRID[-1]) < origin:
        # The origin is heavier than this face can be fattened to. That is not a
        # weight step, it is the wrong CUT (measured on 'anniversary': its own
        # font paints hairline strokes where the original is a solid brush), and
        # closing the gap with stroke alone would only thicken a hairline into a
        # blob. Leave it for the owner rather than pin a number that cannot help.
        return (None, None,
                "bold: the original's title is much heavier than this theme's "
                "title font can be fattened to — that usually means the font "
                "file is a lighter cut than the design's. Left unset.")
    best = min(scored)[1]
    if best < _BOLD_W_MIN:
        return False, None, None
    return True, round(best, 3), None


def title_samples(cfg):
    """The sample titles a fit is measured over, as lists of lines.

    Shared with ``calibration_health`` on purpose: it already reasons about WHICH
    honoree names a title must be measured against (a spread with and without an
    ascender and a descender), and a fit that used a different spread than the
    health check would disagree with it on the very theme it just calibrated.
    """
    return [lines for lines, _name in calibration_health.sample_titles(cfg)]


def sample_words(cfg):
    """A sample of the words this theme actually prints, for the word-size fit."""
    words = [w.strip() for w in topup._read_wordlist(cfg.get("wordlist"))]
    return [w for w in words if w][:_FIT_WORD_SAMPLE]


def fit_title_size(mask, image, box, ppu, ox, oy, font_path, samples, ink_hex):
    """Fit one surface's title size. -> ``(size, grade, note, ctx)``.

    ``ctx`` is ``(ink_region, alpha)`` — what ``fit_bold`` needs to go on and
    weigh the same ink — or None when nothing was measured.

    The grade comes from a SECOND, independent fit against the ink's WIDTH. The
    two agree to within a couple of percent when the theme's font really is the
    one the design was made in (measured: bachelorette 20.91 tall / 20.80 wide,
    trip comeback 24.63 / 24.55). They diverge when it is a lookalike or when
    Canva condensed the text box (grapefruit: 27.56 / 21.19), and that is worth
    telling the owner, because then only one of the two axes can match.
    """
    if not samples:
        return None, None, "title: no sample title could be built for this theme.", None
    extent = _ink_extent(mask, box, ppu, ox, oy)
    if not extent:
        return None, None, None, None
    ink_h, ink_w, region = extent
    alpha = _alpha_threshold(ink_hex, _background(image, mask, region))
    if not all(_covers(font_path, "".join(lines)) for lines in samples):
        return (None, None,
                "size: the theme's title font has no glyphs for this title's own "
                "text, so its size could not be measured — check the font.", None)
    size = _fit_size(ink_h, font_path, samples, ppu, alpha)
    box_h = box["y1"] - box["y0"]
    if not _in_box(size, box_h):
        return (None, None,
                "size: the measured title ink is not a plausible size for its "
                "box, so nothing was pinned — the renderer auto-fits.", None)
    wide = _fit_size(ink_w, font_path, samples, ppu, alpha, axis=1)
    if wide and abs(wide - size) / size <= 0.12:
        return size, "high", None, (region, alpha)
    note = ("size: fitted from the height of the original's title ink. Its WIDTH "
            f"says {wide}, not {size} — the title font is not quite the one the "
            "design was made in (a lookalike, or Canva condensed the text box), "
            "so check the preview." if wide else
            "size: fitted from the height of the original's title ink; its width "
            "could not be cross-checked.")
    return size, "low", note, (region, alpha)


def fit_word_size(mask, image, slots, ppu, ox, oy, font_path, words):
    """Fit the deck's single word size. -> ``(size, grade, note)``.

    The origin prints every word on a card at ONE size (Canva Bulk Create fills a
    fixed-size box), so one number settles the card — but WHICH words it printed
    is unknown, and a Hebrew line's ink height swings ~30% on whether it happens
    to carry a lamed or a final-descender. So the match is median-to-median: the
    median ink height of the origin's rows against the median of a sample of the
    words this theme prints. Verified on bachelorette, whose 19 was pinned by
    hand against its original: this fit returns 18.93.
    """
    if not words or not slots:
        return None, None, None
    heights, regions = [], []
    for slot in slots:
        extent = _ink_extent(mask, slot, ppu, ox, oy)
        if extent:
            heights.append(extent[0])
            regions.append(extent[2])
    if len(heights) < 2:
        return (None, None,
                "word_size: the original's word rows could not be isolated "
                "cleanly, so the words keep auto-fitting their slots.")
    if not _covers(font_path, "".join(words)):
        return (None, None,
                "word_size: the theme's word font has no glyphs for this theme's "
                "own wordlist — check the font.")
    alpha = _alpha_threshold(slots[0].get("color") or "#000000",
                             _background(image, mask, regions[0]))
    size = _fit_size(statistics.median(heights), font_path, [[w] for w in words],
                     ppu, alpha, marker=True)
    box_h = statistics.median([s["y1"] - s["y0"] for s in slots])
    if not _in_box(size, box_h):
        return (None, None,
                "word_size: the measured word ink is not a plausible size for its "
                "slots, so nothing was pinned — the words auto-fit.")
    # Graded "low" by construction, never higher: unlike the title, whose text is
    # known up to the honoree's name, the origin's words are unknown text, so the
    # match rests on the theme's wordlist being typical of what it printed.
    return size, "low", ("word_size: fitted by matching the original's word-row "
                         "ink heights against this theme's own wordlist — check "
                         "one card in the preview before trusting it.")


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

    v2 keeps the per-front boxes inside the card, as ``card.title["<n>"]``, and
    this reads them straight out of the recipe exactly as the v1 branch below
    reads ``cards[]``. Deliberately NOT through the renderer's accessor: that one
    substitutes a FALLBACK box (the union of the other fronts') for a front that
    measured nothing, which is right for printing a name but wrong here — this
    pass would then read the deck's paints off a rectangle no export has ink in.
    """
    if single:
        titles = (recipe.get("card") or {}).get("title") or {}
        for index in config.fronts(cfg):
            boxes = titles.get(str(index))
            if boxes:
                return boxes
        return None
    for card in recipe.get("cards") or []:
        if card and card.get("title"):
            return card["title"]
    return None


def _front_word_slots(recipe, cfg, single):
    """The word slots of the front the paints were read off, or ``[]``.

    Same selection rule as ``_front_title_boxes`` — the first front that measured
    something — so the word size is fitted on the SAME surface whose title was,
    and both describe one real card rather than a mix of two.
    """
    if single:
        return (recipe.get("card") or {}).get("words") or []
    for card in recipe.get("cards") or []:
        if card and card.get("title"):
            return card.get("words") or []
    return []


def _word_colours(recipe):
    """Every word-slot colour a recipe records, lowercased, either structure."""
    cards = recipe.get("cards")
    if not cards:
        card = recipe.get("card")
        cards = [card] if isinstance(card, dict) else []
    return {(slot.get("color") or "").lower()
            for c in cards if c
            for slot in c.get("words", []) if slot.get("color")}



# Fitted values the calibrator is not confident about. Keyed by the confidence
# label it grades, mapped to where the value lives in the blob.
_FITTED_KEYS = (
    ("title_style.size", ("title_style", "size")),
    ("title_style.bold", ("title_style", "bold")),
    ("title_style.bold_w", ("title_style", "bold_w")),
    ("word_size", ("word_size",)),
)


def _drop_low_confidence(out, confidence, notes):
    """Remove any fitted value the calibrator graded ``low``.

    Detection PROPOSES; it must not propose something it does not believe. A
    dropped key falls back to the renderer's own auto-fit, which is the
    behaviour that shipped for every theme before fitting existed.
    """
    dropped = []
    for label, path in _FITTED_KEYS:
        if confidence.get(label) != "low":
            continue
        target = out
        for key in path[:-1]:
            target = target.get(key) if isinstance(target, dict) else None
            if not isinstance(target, dict):
                break
        if isinstance(target, dict) and path[-1] in target:
            target.pop(path[-1], None)
            confidence.pop(label, None)
            dropped.append(label)
    if dropped:
        notes.append(
            "not measured confidently, left for the renderer's auto-fit: "
            + ", ".join(sorted(dropped))
            + ". A wrong pinned value prints on every card; an unset one does not."
        )
    return dropped

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
    # The size fits need the two things the renderer itself renders with: the
    # theme's own title font, and the titles this theme actually prints.
    try:
        title_font = config.font_path(theme_key, cfg.get("title_font") or "")
    except (KeyError, RuntimeError):
        title_font = ""
    samples = title_samples(cfg)

    def sheet(kind, half):
        return os.path.join(tdir, half, kind + ".svg")

    def units(box, ppu, ox=0.0, oy=0.0):
        """A detected PIXEL box back in the recipe's user units."""
        return {"x0": (box[0] - ox) / ppu, "y0": (box[1] - oy) / ppu,
                "x1": (box[2] - ox) / ppu, "y1": (box[3] - oy) / ppu}

    def record(key, size, grade, note):
        """Store one fitted size, or say why it stayed unset."""
        if note:
            notes.append(note)
        if size is None:
            confidence[f"title_style.{key}"] = "none"
            return
        out["title_style"][key] = size
        confidence[f"title_style.{key}"] = grade

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
                # The board is the LARGEST rendering of this title, so its ink is
                # the cleanest size measurement of the three surfaces.
                ppu, ox, oy = _viewport(mask, vb)
                record("board_size", *fit_title_size(
                    mask, image, units(box, ppu, ox, oy), ppu, ox, oy,
                    title_font, samples, fill)[:3])
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
                # The back's title is its own surface with its own box, so it
                # gets its own size — pinning the front's here would size the
                # back title to a box it was never measured against.
                bppu, box_, boy = _viewport(mask, vb)
                record("back_size", *fit_title_size(
                    mask, image, units(box, bppu, box_, boy), bppu, box_, boy,
                    title_font, samples, fill)[:3])
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
        # of the card's per-front ``card.title`` map instead of out of a card cell.
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
                # Flat unless the title genuinely curves. This USED to be left out
                # as "a visual call", but title_style is validated as a WHOLE and a
                # blob missing one field is rejected entirely — so omitting arch
                # silently discarded the fill, outline and ring width measured just
                # above it, and the template went on reporting itself as never
                # calibrated even though detection had succeeded. Straight is also
                # the honest reading: nothing measured here bulges. The owner still
                # overrides it in the form for a curved title.
                ts.setdefault("arch", 0.0)
                confidence.setdefault("title_style.arch", "low")
                ts.setdefault("shadow", False)
                confidence.setdefault("title_style.shadow", "low")
                align = _alignment(mask, tight)
                if align:
                    ts["align"] = align
                    confidence["title_style.align"] = "medium"

                # --- the fitted sizes and the synthetic-bold weight ----------
                tbox = {"x0": min(b["x0"] for b in t), "y0": min(b["y0"] for b in t),
                        "x1": max(b["x1"] for b in t), "y1": max(b["y1"] for b in t)}
                size, grade, note, ctx = fit_title_size(
                    mask, image, tbox, ppu, ox, oy, title_font, samples,
                    (t[0].get("color") or fill))
                record("size", size, grade, note)
                if size and ctx:
                    # WEIGHT, only where the title has no visible ring. A ringed
                    # title's ink is mostly its OUTLINE, and the candidate painted
                    # here carries no ring — so the comparison would read the ring
                    # as stroke weight and embolden a design that is not bold.
                    if outline_w and fill != outline:
                        notes.append("bold: this title is painted with an outline "
                                     "ring, whose ink would be read as weight — "
                                     "bold was left alone. Set it by eye.")
                        confidence["title_style.bold"] = "none"
                    else:
                        bold, bold_w, bnote = fit_bold(
                            mask, ctx[0], title_font, samples, size, ppu, ctx[1])
                        if bold is None:
                            if bnote:
                                notes.append(bnote)
                            confidence["title_style.bold"] = "none"
                        elif not bold:
                            ts["bold"] = False
                            confidence["title_style.bold"] = "medium"
                        else:
                            ts["bold"], ts["bold_w"] = True, bold_w
                            # Low by construction: the synthetic stroke is painted
                            # in WHOLE device pixels, so at a card-sized title one
                            # step of the grid is worth ~0.014 of the glyph size —
                            # the value is the right neighbourhood, not a decimal.
                            confidence["title_style.bold"] = "medium"
                            confidence["title_style.bold_w"] = "low"
                            notes.append(
                                "bold: the original's title strokes are heavier "
                                f"than this font's own cut, so bold is on at "
                                f"bold_w {bold_w} — compare it against the "
                                "original before shipping.")

                wslots = _front_word_slots(recipe, cfg, single)
                wsize, wgrade, wnote = fit_word_size(
                    mask, image, wslots, ppu, ox, oy,
                    config.resolve_word_font(theme_key), sample_words(cfg))
                if wnote:
                    notes.append(wnote)
                out["word_size"] = wsize
                confidence["word_size"] = wgrade or "none"
            if not t:
                notes.append("title: no card in the recipe carries a title slot.")
        else:
            notes.append("fronts: filled/clean pair or recipe missing, skipped.")

        # --- card_slots: hand the DETECTED geometry back to the admin form ---
        # The form pre-fills from this blob, but it reads slot geometry from
        # themes.json "card_slots" while detection writes the RECIPE — so with
        # nothing bridging them the form opened on hardcoded generic defaults
        # (evenly-spaced boxes spanning most of the card). Auto-fit then sized
        # the text to THOSE boxes, and the preview came back with giant words and
        # a title clipped off both card edges, on a template whose real geometry
        # had already been measured correctly.
        #
        # Fractions, not user units, because that is what the form stores and
        # what survives a re-export at a different pixel size.
        if single:
            slots = _card_slots_from_recipe(cfg)
            if slots:
                out["card_slots"] = slots
                confidence["card_slots"] = "high"
                notes.append("card_slots pre-filled from the detected geometry "
                             "— check the preview, then save.")
            else:
                notes.append("card_slots: no single-card recipe detected yet, so "
                             "the form opens on its defaults. Re-run detection "
                             "for this template.")

        # Say which sizes stayed unset, and only those: "left unset" used to be
        # printed unconditionally, which read as "this pass never measures them"
        # and sent the owner to Canva's UI even for the ones it now measures.
        unset = [name for name in ("size", "board_size", "back_size")
                 if name not in out["title_style"]]
        if unset:
            notes.append(", ".join(unset) + " left unset — the renderer auto-fits "
                         "the title to its box; pin one only if that over- or "
                         "under-shoots.")
        notes.append("arch is set flat (0) — raise it in the form only if this "
                     "title genuinely curves. offset stays a visual call.")
        # NEVER write a low-confidence fit. "Leave it unset when you cannot
        # measure it confidently" is the whole safety property here: the renderer
        # auto-fits a missing size perfectly well, while a WRONG pinned size is
        # printed on all 104 cards of a paid order.
        #
        # This is not hypothetical. Measured against grapefruit's Canva original:
        #
        #   title size   fitted 27.56  vs 28     — good, but graded low
        #   bold         fitted True   vs True   — correct, graded medium
        #   word_size    fitted 14.81  vs 21.3   — 30% under, and WORSE than the
        #                                          existing box-height heuristic,
        #                                          which gives 20.72
        #   bold_w       fitted 0.015  vs 0.05   — 3x under
        #
        # Two of the four fitters are not good enough yet, and they grade
        # themselves low — so honour that grade rather than shipping the number.
        # A fitter earns its way in by grading medium or better.
        _drop_low_confidence(out, confidence, notes)
        out["confidence"] = confidence
        out["notes"] = notes
        return out
    finally:
        if own:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)


def _card_slots_from_recipe(cfg):
    """The detected single-card geometry as the form's ``card_slots`` fractions.

    Converts the recipe's viewBox user units into fractions of the card:
    ``{"words": [4 boxes], "titles": {"<front>": box}}``. Returns None when the
    template has no usable single-card recipe, so the caller can say so rather
    than writing half a calibration.
    """
    try:
        recipe = config.load_recipe(cfg.get("recipe"))
    except Exception:
        return None
    card = recipe.get("card")
    if not isinstance(card, dict):
        return None
    words = card.get("words") or []
    if len(words) < 4:
        return None
    vb = recipe.get("viewBox") or [0, 0, 0, 0]
    w, h = vb[2], vb[3]
    if not w or not h:
        return None

    def frac(b):
        return {"x0": round(b["x0"] / w, 4), "y0": round(b["y0"] / h, 4),
                "x1": round(b["x1"] / w, 4), "y1": round(b["y1"] / h, 4)}

    titles = {}
    for front, boxes in (card.get("title") or {}).items():
        if not boxes:
            continue
        # A title may be recorded as one box PER LINE; the form holds a single
        # box per front, so hand it the union the renderer would fit into anyway.
        union = {"x0": min(b["x0"] for b in boxes), "y0": min(b["y0"] for b in boxes),
                 "x1": max(b["x1"] for b in boxes), "y1": max(b["y1"] for b in boxes)}
        titles[str(front)] = frac(union)
    if not titles:
        return None
    return {"words": [frac(b) for b in words[:4]], "titles": titles}


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
