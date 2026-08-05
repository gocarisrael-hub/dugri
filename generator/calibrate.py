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

A deck whose eight styles each have their own back (#315) answers PER BACK
instead, under ``backs`` keyed by the card file number, with ``back`` left null::

    {"backs": {"10": {"frac": {...}, "fill": ..., "outline": ..., "size": 42},
               "11": null, ...}}

``null`` there is an ANSWER — that back carries no title — and never a gap. The
size moves inside the entry because eight separately drawn backs give the title
eight differently sized rooms, where one deck-wide ``back_size`` fits only the
box it was measured against.

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
import math
import os
import re
import statistics
import sys
import tempfile
from collections import Counter

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

import calibration_health
import chrome
import config
import recipe_diff
import render_page
import topup

CHROME = chrome.CHROME  # see generator/chrome.py — one owner for the browser
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
    # font_wait off: this screenshots the ORIGINAL artwork as-is to detect where
    # its text sits — the fonts are already outlined paths in the export, and
    # sitting out a virtual clock would only slow every calibration down.
    chrome.screenshot(svg, png, w, h, scale=SCALE, font_wait=False)


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


# ---- the OUTLINE RING, measured by depth ------------------------------------
#
# ``outline_w`` is the one style knob nothing measured. ``_fill_and_outline``
# returned it as a by-product of whichever colour path happened to run, and on a
# small front-card title that path is the CLUSTERING one — which, when the ring
# covers the fill, finds a single colour cluster and reports "no ring, 0.0". The
# vector source meanwhile knows perfectly well there are two paints. The two
# disagreed silently and the 0.0 won, so three shipped decks printed a pale fill
# with no ring at all against pale artwork: an unreadable title.
#
# The ring is not a colour question, it is a DEPTH one. The renderer strokes each
# glyph with ``2 * outline_w * size`` under a fill painted on top
# (``render_page.title_block``), so the painted ink is the glyph dilated by the
# ring and:
#
#     every RING pixel lies within the ring's thickness of the ink's outer edge
#     every FILL pixel lies deeper than that
#
# So the ring is ONE threshold on distance-to-background, and the honest value of
# that threshold is the one that best sorts the pixels that are the outline
# colour from the pixels that are the fill colour. Successive erosions of the ink
# mask give that distance directly — each erosion peels exactly one pixel — and
# the same pass answers WHICH paint is the ring, because the ring is by
# definition the paint that owns the outer shells. That is a stronger
# discriminator than ``assign_paints``' boundary count, which asks the same
# question one pixel deep.
#
# Expressed against the type SIZE, never against the ink height: ``outline_w`` is
# a fraction of the em in ``title_block``, and a Hebrew face's ink is anywhere
# from 0.46 to 1.13 of its em (measured across the ten shipped word faces), so
# dividing by the ink would be wrong by up to a factor of two either way.

# Ink shells to walk before giving up. A ring thicker than this share of the em
# is not a ring; the cap only stops the loop running away on a saturated diff.
_MAX_RING_SHELLS = 40


def _paint_class(colour, paints, bg):
    """Which of ``paints`` a pixel belongs to, or None for background/blend."""
    best, dist = None, None
    for i, p in enumerate(paints + [bg]):
        d = _rgb_dist(p, colour)
        if dist is None or d < dist:
            best, dist = i, d
    if best is None or best >= len(paints) or dist > _MIN_CLUSTER_DIST:
        return None
    return best


def solid_ink(region):
    """``region`` with any enclosed hole filled in — the glyph as a solid shape.

    The ink mask is ``|filled - clean|`` through a fixed threshold, so it only
    records ink that DIFFERS from the artwork by enough to see. A title painted
    as a light fill inside a dark ring breaks that assumption from the inside:
    the ring clears the threshold easily, and the fill — pale ink over pale
    artwork — does not. What comes back is a hollow outline with the fill missing
    from the mask entirely.

    Every measurement downstream then reads that title as a single-paint dark
    one: no fill pixels at any depth, so no ring, so the renderer paints the dark
    ring colour as a solid title. Two shipped decks (קליפורניה, סיישל) print a
    light title inside a dark ring and were coming out solid dark.

    A hole is not ambiguous, though — background reaches the edge of the crop and
    an enclosed pocket does not. So flood the background inward from the border
    and take everything it cannot reach as ink, whatever its contrast. The
    colours are then read from the ARTWORK at those pixels, which is where the
    fill has been all along.
    """
    w, h = region.size
    if w < 3 or h < 3:
        return region
    # Pad by one so the flood always has a border to start from, even for ink
    # that runs flush to the crop's edge.
    padded = Image.new("L", (w + 2, h + 2), 0)
    padded.paste(region, (1, 1))
    outside = padded.point(lambda v: 0 if v else 255)
    ImageDraw.floodfill(outside, (0, 0), 128)
    # 255 now marks background the flood could not reach: enclosed holes.
    holes = outside.point(lambda v: 255 if v == 255 else 0)
    filled = ImageChops.lighter(padded, holes)
    return filled.crop((1, 1, w + 1, h + 1))


def _depth_profile(image, mask, box, paints, bg):
    """Per-depth pixel counts for each paint: ``[[at depth 1], [at depth 2], ...]``.

    Depth is the chessboard distance from the ink's outer boundary, obtained by
    peeling the mask one erosion at a time — the shell that comes off at step
    ``k`` is exactly the ink at depth ``k + 1``. Padded, because ``box`` is the
    ink's tight bounding box and a bare crop has ink flush against the edge,
    where the filter replicates rather than erodes and the outermost shell would
    never come off at all.
    """
    pad = 2
    bw, bh = box[2] - box[0], box[3] - box[1]
    if bw < 4 or bh < 4:
        return []
    region = Image.new("L", (bw + 2 * pad, bh + 2 * pad), 0)
    region.paste(solid_ink(mask.crop(box)), (pad, pad))
    crop = Image.new("RGB", region.size, bg)
    crop.paste(image.crop(box), (pad, pad))
    px = crop.load()
    shells = []
    cur = region
    for _ in range(_MAX_RING_SHELLS):
        nxt = cur.filter(ImageFilter.MinFilter(3))
        shell = ImageChops.difference(cur, nxt)
        bbox = shell.getbbox()
        if not bbox:
            break
        sp = shell.load()
        counts = [0] * len(paints)
        for y in range(bbox[1], bbox[3]):
            for x in range(bbox[0], bbox[2]):
                if not sp[x, y]:
                    continue
                which = _paint_class(px[x, y], paints, bg)
                if which is not None:
                    counts[which] += 1
        shells.append(counts)
        if not nxt.getbbox():
            break
        cur = nxt
    return shells


def _best_depth_split(shells, outer, inner):
    """``(score, ring_depth)`` for reading paint ``outer`` as the ring.

    ``ring_depth`` is fractional: the whole shells that go to the ring, plus the
    ring's share of the shell the boundary falls in, so a ring is not quantised
    to whole pixels on a title only forty pixels tall.
    """
    total_inner = sum(s[inner] for s in shells)
    best, depth, run = None, 0.0, 0
    for k in range(len(shells) + 1):
        score = run + total_inner
        if best is None or score > best:
            hit = shells[k] if k < len(shells) else None
            share = 0.0
            if hit and (hit[outer] + hit[inner]):
                share = hit[outer] / float(hit[outer] + hit[inner])
            best, depth = score, k + share
        if k < len(shells):
            run += shells[k][outer]
            total_inner -= shells[k][inner]
    return best, depth


def ring_by_depth(image, mask, box, paints, bg, em_px):
    """``(fill, outline, outline_w)`` read off how deep each paint sits.

    ``paints`` are the two colours the title is painted in, in either order —
    this decides which is the ring. Returns ``(None, None, None)`` when there is
    too little classified ink to tell, and ``outline_w`` of ``0.0`` when the two
    paints are the same colour or no shell prefers the outer reading, which is a
    measured answer: that title has no ring.
    """
    if len(paints) == 1 or (len(paints) == 2 and paints[0] == paints[1]):
        return paints[0], paints[0], 0.0
    if len(paints) != 2:
        return None, None, None
    rgb = [_hex_to_rgb(p) for p in paints]
    shells = _depth_profile(image, mask, box, rgb, bg)
    total = sum(sum(s) for s in shells)
    if total < 40:
        return None, None, None
    # ONE PAINT SURVIVED. The other is not "underneath" — nothing can be said
    # about what is underneath — it is simply not in this rendering, so the
    # honest answer is the single visible colour with no ring, and the renderer
    # paints exactly what the original shows.
    #
    # This is the whole unreadable-title bug. On three decks the vector offers
    # two paints and the FRONT title uses only the dark one; ``assign_paints``
    # nonetheless nominated the light one as the fill, the ring measured zero, so
    # the renderer painted a pale fill and nothing else — on bachelorette in
    # #ffc6d7, which is the back­ground of its own card to the byte.
    for i in (0, 1):
        if sum(s[i] for s in shells) < _MIN_CLUSTER_SHARE * total:
            seen = paints[1 - i]
            return seen, seen, 0.0
    a_score, a_depth = _best_depth_split(shells, 0, 1)
    b_score, b_depth = _best_depth_split(shells, 1, 0)
    # A tie means the shells do not prefer either paint on the outside; take the
    # THINNER ring, because a ring is something the pixels have to demand.
    if (a_score, -a_depth) >= (b_score, -b_depth):
        outline, fill, depth = paints[0], paints[1], a_depth
    else:
        outline, fill, depth = paints[1], paints[0], b_depth
    if not em_px or em_px <= 0:
        return fill, outline, None
    return fill, outline, round(depth / em_px, 3)


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


# How close a candidate paint has to sit to the artwork UNDER the title before it
# is read as the background rather than as a paint. The same RGB radius the
# clustering uses, so "this pixel is that paint" and "that paint is the
# background" are decided on one scale.
_BG_PAINT_DIST = _MIN_CLUSTER_DIST


def artwork_around(image, mask, region):
    """The artwork colour the title sits ON, read OUTSIDE the glyphs.

    Not ``_background``: that one takes the mode of every un-inked pixel in the
    crop, and on a title whose pale fill is too close to the artwork to clear
    the diff threshold the mask is a hollow ring — so its "un-inked" pixels are
    mostly the title's own FILL, and the answer comes back as the very colour
    the caller is trying to identify. ``solid_ink`` already knows the
    difference: a hole is enclosed, the background is not. So fill the holes
    first and read what is left over.
    """
    im = image.crop(region)
    mk = solid_ink(mask.crop(region))
    px, mp = im.load(), mk.load()
    counts = Counter()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            if not mp[x, y]:
                counts[px[x, y]] += 1
    return counts.most_common(1)[0][0] if counts else None


def drop_background(candidates, bg):
    """``candidates`` without the colour of the artwork the title sits on.

    A Canva export re-emits the card's own background inside the personalized
    layer, so the background colour is one of the colours the filled sheet uses
    MORE than the clean one — it arrives as a candidate paint indistinguishable
    from the title's own. It then wins, because it is the most common fill on the
    card by a wide margin.

    That is not a tie-break the depth pass can settle either, and it is worse than
    it looks: ``solid_ink`` fills a glyph's enclosed counters (the hole in an 'a',
    the loop of a 'B') so a pale fill inside a dark ring survives into the mask,
    and those counters are BACKGROUND-coloured and sit at the deepest depth. A
    ringless title therefore reads as "background inside, text colour around it"
    — the two paints exactly inverted. Measured on bachelorette, whose front
    title came back filled in its own card's pink with the real ink demoted to a
    ring, and whose back did the same one shade darker.

    A title cannot be painted in the colour it is drawn ON — it would be
    invisible — so a candidate that matches the artwork under it is never one of
    its paints, whatever the vector's counts say.
    """
    if not bg:
        return list(candidates)
    kept = [(c, n) for c, n in candidates
            if _rgb_dist(_hex_to_rgb(c), bg) > _BG_PAINT_DIST]
    # Never strip the LAST candidate: a title genuinely drawn a shade off its
    # background still has to report the colour it is drawn in.
    return kept or list(candidates)


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


# How much better the winning alignment must fit than the runner-up, as a
# fraction of the title block's width, before it is believed.
#
# It used to be 2%, which is under the noise: a two-line title whose lines happen
# to be near the same width scores almost the same left, right and centre, and
# whichever wins is an accident of a few pixels of swash. Measured over every
# shipped front — the winner's margin is 28% where a design really does align its
# lines (טוקיו, whose title alternates right and left down the deck), 11-18%
# where they really are centred, and 0.4-6% on the fronts whose reading is noise
# (פריז, whose eight identical titles scored "left" on three and "centre" on
# four). A tenth of the width sits in the empty band between the two groups, so a
# design that means it is heard and a coin flip is not.
_ALIGN_MARGIN = 0.10


def _edges(region, y0, y1):
    """``(leftmost, rightmost)`` inked column over rows ``y0..y1``, or None."""
    px = region.load()
    w = region.size[0]
    xs = [x for y in range(y0, y1) for x in range(w) if px[x, y]]
    return (min(xs), max(xs)) if xs else None


def _line_bands(region, want):
    """The rows each title LINE occupies — even when two lines' ink touches.

    ``_row_runs`` finds a line boundary by a clear row, and a design is entitled
    not to leave one: טוקיו sets "TOMER'S" over "30S" with the second line's caps
    starting on the row the first line's ink ends, so the whole title reads as
    ONE band and every question asked per line (its alignment, above all) goes
    unanswered. Where the clear row is missing the boundary is still visible in
    the block's SHAPE — a new line starts where the ink's left or right edge
    jumps, which is precisely what having a different line there means.

    So: take the clear-row runs when they already account for every line (every
    template that reads today keeps exactly the bands it had), and otherwise
    split the tallest band at its biggest edge jump until the count is right.
    Returns whatever it could reach, so a caller still sees fewer bands than it
    asked for rather than a fabricated split.
    """
    bands = _row_runs(region)
    if not bands or want is None or len(bands) >= want:
        return bands
    guard = 0
    while len(bands) < want and guard < want:
        guard += 1
        tallest = max(range(len(bands)), key=lambda i: bands[i][1] - bands[i][0])
        y0, y1 = bands[tallest]
        margin = max(1, int(0.2 * (y1 - y0)))
        best, at = 0, None
        prev = _edges(region, y0, y0 + 1)
        for y in range(y0 + 1, y1):
            cur = _edges(region, y, y + 1)
            if prev and cur and y0 + margin <= y <= y1 - margin:
                jump = abs(cur[0] - prev[0]) + abs(cur[1] - prev[1])
                if jump > best:
                    best, at = jump, y
            prev = cur or prev
        if at is None:
            break
        bands = sorted(bands[:tallest] + [(y0, at), (at, y1)]
                       + bands[tallest + 1:])
    return bands


def _alignment(mask, box, want=None):
    """Infer the title's alignment from how its lines stack.

    Left-aligned lines share a left edge and ragged right; right-aligned the
    mirror; centred lines are ragged on both sides but share a midpoint. Needs
    at least two lines — a single-line title carries no alignment signal at all,
    so this returns None and the caller leaves the default in place.

    ``want`` is how many lines the template's title has, which lets the band
    split fall back on the block's shape when the design leaves no clear row
    between two of them.
    """
    region = mask.crop(box)
    runs = _line_bands(region, want)
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
    if others[1] - others[0] < _ALIGN_MARGIN * w:
        return None
    return {sl: "left", sr: "right", sm: "center"}[best]


# How far the ring's ink must sit below the fill's, as a fraction of the type
# size, before the title is taken to carry a drop shadow. A ring drawn around a
# glyph is concentric with it, so with no shadow this displacement is zero up to
# rasterising noise; the renderer's own shadow is offset by 0.06 of the size, so
# anything at a quarter of that is unambiguous.
_SHADOW_DROP = 0.015


def detect_shadow(image, mask, box, fill, outline, bg, em_px):
    """Whether the title carries a drop shadow — measured, or None if unknowable.

    A shadow is the glyph drawn AGAIN, below and to the right, in the outline's
    colour. So it shows up as the ring's ink sitting lower than the fill's: a
    plain ring is concentric with the glyph it encloses and the two centroids
    coincide, while a shadow drags the outline-coloured centroid down.

    This used to look for "a thin low-density tail in the bottom 12% of the ink",
    which is not a shadow — it is a DESCENDER, and almost every title has one.
    Turned on for a design with no shadow it prints an extra offset copy of the
    whole title, which is ink the original does not have anywhere on the card.

    None (not False) when the question cannot be put: a single-paint title has no
    ring to compare the fill against, so there is nothing to measure and the
    theme's existing answer should stand rather than be overwritten with a guess.
    """
    if not (fill and outline) or fill == outline or not em_px or em_px <= 0:
        return None
    rgb = [_hex_to_rgb(fill), _hex_to_rgb(outline)]
    pad = 2
    bw, bh = box[2] - box[0], box[3] - box[1]
    if bw < 4 or bh < 4:
        return None
    region = Image.new("L", (bw + 2 * pad, bh + 2 * pad), 0)
    region.paste(solid_ink(mask.crop(box)), (pad, pad))
    crop = Image.new("RGB", region.size, bg)
    crop.paste(image.crop(box), (pad, pad))
    px, mp = crop.load(), region.load()
    sums = [0.0, 0.0]
    counts = [0, 0]
    for y in range(region.size[1]):
        for x in range(region.size[0]):
            if not mp[x, y]:
                continue
            which = _paint_class(px[x, y], rgb, bg)
            if which is None:
                continue
            sums[which] += y
            counts[which] += 1
    if min(counts) < 30:
        return None
    drop = (sums[1] / counts[1]) - (sums[0] / counts[0])
    return drop > _SHADOW_DROP * em_px


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

# ---- THE LEADING, which the size fit must not be charged for ----------------
#
# ``render_page.title_block`` stacks a title's lines one FIXED step apart —
# 0.78 of the type size — while the design the title is copied from set its own.
# On a two-line title the two are simply added together in the ink:
#
#     block ink height  =  (lines - 1) * leading * size  +  ascent + descent
#
# so fitting the block's height with the renderer's step charges the WHOLE
# leading difference to the size. That is not a small correction. Measured
# against the owner's Canva numbers it is every one of the multi-line errors:
# קליפורניה came out +11% (its design leads at ~0.95, we assume 0.78),
# סנטוריני −16% (it leads TIGHTER than we assume), and טריפה +139%, where the
# theme's title template had gone stale at one line against artwork that plainly
# sets two — so the fit matched one line of ours against two of theirs.
#
# A single-line title has no leading, which is exactly why קופקבנה measures
# right to a third of a percent while its neighbours do not. So the leading is
# solved FOR, as a second unknown, against a second reading of the same ink.
RENDER_PITCH = 0.78
# The leadings a design can plausibly be set at. Canva's own spacing control
# spans well under one to well over two; above the top of this they read as
# separate blocks rather than one title.
#
# THE FLOOR IS NOT A PLAUSIBILITY GUARD ANY MORE. It used to stop at 0.50
# because "below half the type size the lines would overprint" — a physical
# constraint asserted inside the MEASUREMENT, where it cannot be checked. The
# renderer now enforces it where it can be: ``render_page.title_pitch`` opens
# any leading tighter than the glyphs about to be drawn can fit, proved on
# rendered pixels for every template. With the constraint moved to where it is
# actually enforceable, the search is free to report what the ink says.
#
# It matters, and only where it should: re-measured across every multi-line
# surface, lowering the floor to 0.30 changes exactly ONE answer — סנטוריני's
# back, whose optimum was sitting ON the old boundary and which comes back at
# 0.48 for a size of 25.69 against Canva's 25.3 (−3.4% -> +1.5%). Every other
# surface returns the identical size and the identical leading, because none of
# them was pressed against the rail. An optimum on the boundary is evidence
# about the boundary, not about the design.
_PITCH_GRID = [round(0.30 + 0.02 * i, 2) for i in range(86)]     # 0.30 .. 2.00
# How much of a vote the DENSITY profile gets beside the EXTENT one. The extent
# is the reading that decides: it is set by the first and last glyph's edges, so
# it survives the fact that PIL packs a line differently from the browser (no
# kerning, no shaping). The density corroborates and breaks the extent's ties,
# so it gets a minority say — anywhere from a fifth to a half picks the same
# leading on every shipped template, which is what "minority" has to mean for
# the number not to be a tuned constant.
_DENS_VOTE = 1 / 3.0


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


def word_rows(mask, slots, ppu, ox, oy):
    """One ink region per declared word slot — ``[region | None, ...]``.

    ``_ink_extent`` cannot do this job for the WORDS, and that is why the word
    size went unmeasured on most templates. It pads the slot by 30% of its own
    height and then REFUSES if ink reaches the pad's edge — a sound guard for the
    title, which sits alone at the top of the card, but the word rows are stacked
    a third of a slot-height apart, so the pad reaches into the neighbouring row
    on almost every deck and the neighbour's ink trips the guard. Three of four
    rows were refused, fewer than two survived, and the fit reported "the rows
    could not be isolated" on template after template.

    The declared slots already say where each row is, so the rows can be SPLIT
    instead of padded: give each slot the paper up to the midpoint between it and
    its neighbour, and no two rows can reach into each other by construction.
    Inside its own band, a row is the run of inked lines containing the densest
    one — so a stray mark elsewhere in the band cannot extend it either.
    """
    if not slots:
        return []
    mids = sorted(((s["y0"] + s["y1"]) / 2.0) for s in slots)
    order = sorted(range(len(slots)), key=lambda i: (slots[i]["y0"] + slots[i]["y1"]))
    span = ((mids[-1] - mids[0]) / (len(mids) - 1)) if len(mids) > 1 else None
    out = [None] * len(slots)
    for rank, i in enumerate(order):
        slot = slots[i]
        mid = (slot["y0"] + slot["y1"]) / 2.0
        half_up = ((mid - mids[rank - 1]) / 2.0 if rank > 0
                   else (span / 2.0 if span else (mid - slot["y0"])))
        half_dn = ((mids[rank + 1] - mid) / 2.0 if rank + 1 < len(mids)
                   else (span / 2.0 if span else (slot["y1"] - mid)))
        bw = (slot["x1"] - slot["x0"]) * ppu
        region = (max(0, int(slot["x0"] * ppu + ox - bw * 0.06)),
                  max(0, int((mid - half_up) * ppu + oy)),
                  min(mask.size[0], int(slot["x1"] * ppu + ox + bw * 0.06)),
                  min(mask.size[1], int((mid + half_dn) * ppu + oy)))
        if region[2] - region[0] < 4 or region[3] - region[1] < 6:
            continue
        sub = mask.crop(region)
        w, h = sub.size
        px = sub.load()
        rows = [sum(1 for x in range(w) if px[x, y]) for y in range(h)]
        peak = max(rows) if rows else 0
        if not peak:
            continue
        top = rows.index(peak)
        bottom = top
        while top > 0 and rows[top - 1]:
            top -= 1
        while bottom + 1 < h and rows[bottom + 1]:
            bottom += 1
        if bottom - top < 3:
            continue
        xs = [x for y in range(top, bottom + 1) for x in range(w) if px[x, y]]
        if not xs:
            continue
        out[i] = (region[0] + min(xs), region[1] + top,
                  region[0] + max(xs) + 1, region[1] + bottom + 1)
    return out


@functools.lru_cache(maxsize=64)
def _fit_font(path, px, weight=None):
    font = ImageFont.truetype(path, max(4, int(px)))
    if weight is not None and render_page.weight_axis(path):
        try:
            font.set_variation_by_axes([float(weight)])
        except (OSError, ValueError):
            pass
    return font


# The weight instances a variable face is offered at. The nine CSS steps, which
# is what a designer picking "Bold" in Canva actually chose from — a finer grid
# would only be reading the raster's noise (see ``fit_bold``).
_WEIGHT_GRID = (100, 200, 300, 400, 500, 600, 700, 800, 900)

# How far the height fit and the width fit may still disagree at the axis's best
# instance before the weight is refused (``fit_font_weight``). The same 12% at
# which ``fit_title_size`` already tells the owner the two axes cannot both be
# right — one threshold for one question, asked in two places. On a face that IS
# the design's there is nothing like this much left over: מרקאנה's winning cut
# reproduces its artwork's width exactly, and one STEP of the axis is worth
# about 2%.
_WEIGHT_DISAGREE = 0.12


def fit_font_weight(ink, font_path, samples, size, ppu, alpha, pitch=None,
                    ring=0.0):
    """Which cut of a VARIABLE title face the design was set in, or None.

    A variable font is nine weights in one file, and the file names one of them
    its default — League Spartan's is Thin, the lightest. Nothing chose, so
    every variable face an owner uploads printed at whatever the file happened
    to default to: מרקאנה's title is Bold in the design and drew as a hairline.

    THE WEIGHT AND THE SIZE ARE ONE ANSWER, and this solves them as one — the
    same reason the size and the LEADING leave ``fit_title_size`` together. What
    makes them inseparable is a property of the axis, measured on this file: as
    ``wght`` runs 100 -> 900 the ink's HEIGHT does not move at all (90px at size
    100 at every instance) and only its WIDTH does, by 19%. So:

      * the size fitted from the ink's HEIGHT cannot see the weight — which is
        why an earlier round measured the height across the axis, saw it flat,
        and concluded the weight did not matter to the size;
      * and the size fitted from the ink's WIDTH sees nothing BUT the weight.

    Two readings of one ink that must answer the same size, and exactly one knob
    that makes them agree. So the weight is the instance at which the height fit
    and the width fit converge, and the size is then re-solved at it. Neither
    number means anything without the other: pinning the size against the wrong
    cut charges the whole width error to the size, and pinning the cut at the
    wrong size does the reverse.

    NOT from the stroke weight, which is what this used to compare and what put
    מרקאנה at 800 against the artwork's 600. A ringed title's ink is mostly its
    OUTLINE; painting the candidate with the same ring was supposed to put the
    same ink on both sides, but the two rings are rasterised by different
    engines — the original's by Chrome out of a Canva vector, ours by Pillow's
    ``stroke_width`` — and the residue of that mismatch is far larger than one
    step of the axis. Measured on מרקאנה's own artwork, painting the ORIGINAL'S
    OWN two lines: the strokes say 700 and the samples' strokes say 800, while
    the ink geometry says 600 and reproduces the original's block to the pixel
    (182x122 against 182x122). Geometry survives the mismatch because a ring
    adds a couple of pixels to an extent of a couple of hundred, where a stroke
    reading is the ring almost entirely.

    ``ink`` is the ORIGIN's ink block — the same ``solid_ink`` crop the size is
    fitted against, so that both fits see one picture — and ``size`` is what the
    HEIGHT fit answered over it. So the question reduces to one width comparison
    at that size, which is the same answer as bisecting the width for a
    fortieth of the work: the painted extent is very nearly linear in the size
    (this module already leans on that twice), so the size the width would fit
    is the target width over the width painted at any one reference size, and
    the ratio of the two fits is just the ratio of the two widths. Bisecting
    both axes at all nine instances costs some 4,700 paintings per pass, which
    the owner waits on behind a button.

    ``size`` has to be the fitted size rather than an arbitrary reference: the
    RING is a fraction of the type size, so a reference far from the truth would
    compare widths carrying the wrong ring.

    MEASURED ON THE LINES THE HONOREE NAME DOES NOT TOUCH. The width of a line
    is a property of the type AND of what it says, and the artwork says another
    honoree's name than our samples do — the objection that demoted the width
    comparison in ``fit_title_size`` to a note. But a title is usually not all
    name: מרקאנה sets "{NAME}'s" over "B-day", and the second line says "B-day"
    in the artwork and in every sample alike. Those lines are found without
    knowing the template's placeholders — a line that reads the SAME in all four
    samples is a line no name reaches — and matching only them compares text we
    know the original's word for. It is worth the trouble: over the whole block
    the sample names' extra width drags מרקאנה's answer to 500, and over its
    literal line the cut that reproduces the artwork's 182px to the pixel is 600.

    The line SPLIT is used for the widths only, never for the heights. A ringed
    title's rows weld into one mass, so ``_line_bands`` places the boundary from
    the block's shape rather than from a clear row — good to a few rows, which
    a width does not care about (the band still holds that whole line) and a
    height very much does (67px against the 69 the line really occupies, which
    is a whole step of the axis).

    Falls back to the whole block where every line carries the name, since there
    is then nothing better to compare — still the geometry, and still far better
    than the strokes.

    Returns ``(weight, note)``. The weight is refused (None) when no instance
    reaches the original's width at the size its height fitted, because a face
    whose two axes agree at no cut at all is not the design's face and one of its
    cuts is not worth pinning.
    """
    axis = render_page.weight_axis(font_path)
    if not axis or not ink or not size or not samples:
        return None, None
    low, _default, high = axis
    kw = {} if pitch is None else {"pitch": pitch}
    em = size * ppu
    nlines = len(samples[0])
    if not nlines or not ink.size[0]:
        return None, None
    # Each entry is one width to reproduce and the candidate text that must
    # reproduce it: ``(origin width, [line groups to paint])``.
    targets = []
    literal = [i for i in range(nlines)
               if all(len(s) == nlines and s[i] == samples[0][i]
                      for s in samples)]
    if literal:
        bands = (_line_bands(ink, nlines) if nlines > 1
                 else [(0, ink.size[1])])
        if len(bands) == nlines:
            for i in literal:
                top, bot = bands[i]
                bb = ink.crop((0, top, ink.size[0], bot)).getbbox()
                if bb and bb[2] - bb[0] > 0:
                    targets.append((bb[2] - bb[0], [[samples[0][i]]]))
    on_literal = bool(targets)
    if not targets:
        targets = [(ink.size[0], samples)]
    # Only the instances this file actually offers. The grid is the nine CSS
    # steps a designer picks from in Canva; a file with a narrower axis simply
    # has fewer of them, and nothing here may name one the file does not carry.
    scored = []
    for wght in _WEIGHT_GRID:
        if not low <= wght <= high:
            continue
        errs = []
        for target_w, groups in targets:
            got = []
            for lines in groups:
                cand = _paint(font_path, lines, em, alpha, stroke=ring * em,
                              weight=wght, **kw)
                if cand and cand.size[0]:
                    got.append(cand.size[0])
            if got:
                # A MEDIAN over the group, for the reason every other fit here
                # takes one: where the text IS name-dependent, no single name
                # may decide the answer. A literal line is one painting and its
                # median is itself.
                errs.append(abs(target_w / statistics.median(got) - 1))
        if errs:
            scored.append((statistics.median(errs), wght))
    if not scored:
        return None, None
    off, best = min(scored)
    on = ("the lines of this title no honoree name reaches" if on_literal
          else "this title's ink")
    if off > _WEIGHT_DISAGREE:
        return None, (
            f"title font: this is a VARIABLE font and nothing had chosen a "
            f"weight, so it draws the file's own default. It was left alone: at "
            f"the size the original's title height fits ({size}), no cut of this "
            f"file sets {on} to the width the artwork has — the closest ({best}) "
            f"is still {off:.0%} out. That is a different typeface, not a "
            f"different weight. Check the title font against the design, and set "
            f"the weight by eye if the font is right.")
    return best, (f"title font: this is a VARIABLE font ({len(_WEIGHT_GRID)} "
                  f"weights in one file) and nothing had chosen one, so it was "
                  f"drawing the file's own default. Weight {best} is the cut "
                  f"that sets {on} to the width the artwork has, at the size its "
                  f"height fits ({size}) — matched to {off:.1%}. Check it in the "
                  f"preview.")


# ---- measuring a row of type without knowing what it says -------------------
#
# The origin's words are unknown text, so anything measured about them has to be
# a property of the TYPE and not of the letters that happen to appear. The ink's
# outer bounding box is not: a Hebrew line's bbox height swings by a third on
# whether the word carries a ל (ascender) or a final ק/ן/ך/ף/ץ (descender), and
# a four-row sample lands anywhere in that swing. Matching one such accident
# against another is why the word fit graded itself "low" by construction, was
# dropped every time, and left every deck's words auto-fitted from a hardcoded
# constant instead — up to 60% under the original.
#
# What IS a property of the type is where the BULK of the ink sits: Hebrew has no
# case, so essentially every letter occupies the band from the baseline to the
# letter height, and only the few extremes leave it. So measure the band that
# carries the bulk — the rows whose ink density is at least half the row's peak —
# and both sides are then measuring the same thing whatever they say.

# Share of the densest row's ink a row must carry to count as body rather than as
# one letter's ascender. A half cut needs at least two of a word's letters to
# reach a row before it counts, which no single ascender can do.
_BODY_SHARE = 0.5


def _band_height(ink, region=None):
    """Height of the band carrying the bulk of a text row's ink, in pixels.

    Works on any single-channel ink image — the diff mask cropped to an origin
    row, or our own painted candidate — so the origin and the candidate are put
    through exactly the same measurement.

    SUB-PIXEL, by interpolating where the row-density profile crosses the cut
    rather than counting whole rows. A card word's band is only ~16 pixels tall
    at the sizes these decks print, so a whole-row answer is a staircase with
    6% steps, and a fit bisecting against a staircase lands on the step EDGE —
    systematically under, by up to half a step. Interpolating costs nothing and
    makes the measurement continuous, which is what bisection assumes.
    """
    sub = ink.crop(region) if region else ink
    w, h = sub.size
    if w < 1 or h < 1:
        return None
    px = sub.load()
    rows = [sum(1 for x in range(w) if px[x, y]) for y in range(h)]
    peak = max(rows) if rows else 0
    if not peak:
        return None
    cut = _BODY_SHARE * peak
    live = [y for y, c in enumerate(rows) if c >= cut]
    if not live:
        return None
    top, bottom = live[0], live[-1]

    def cross(inside, outside):
        """Where the profile crosses ``cut`` between two neighbouring rows."""
        if outside < 0 or outside >= h:
            return float(inside)
        hi, lo = rows[inside], rows[outside]
        if hi <= lo:
            return float(inside)
        return outside + (cut - lo) / float(hi - lo)

    return cross(bottom, bottom + 1) - cross(top, top - 1)


def _extent_of(ink, axis):
    """One painted candidate's measurement: 0 height, 1 width, 2 body band."""
    if axis == 1:
        return ink.size[0]
    if axis == 2:
        return _band_height(ink)
    return ink.size[1]


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


def _paint(font_path, lines, em, alpha, stroke=0.0, marker=None,
           pitch=RENDER_PITCH, weight=None):
    """Our renderer's painted text at ``em`` DEVICE pixels, as an ink mask.

    Mirrors what ``render_page`` will draw: title lines stacked on the
    ``pitch * size`` baseline spacing (the renderer's own ``RENDER_PITCH`` by
    default), or one numbered word line with its marker at ``0.9 * size``
    (``word_text``'s own fractions). Cropped to the ink, so the caller measures
    the glyphs and never the canvas.

    ``pitch`` is a parameter and not the renderer's constant because the ORIGIN
    was not set with the renderer's leading — see ``fit_title_size``.
    """
    try:
        font = _fit_font(font_path, round(em), weight)
    except (OSError, ValueError):
        return None
    lines = [ln for ln in lines if ln and ln.strip()]
    if not lines:
        return None
    width = int(max(font.getlength(ln) for ln in lines)) + int(em * 3) + 80
    # Exactly the room the stack needs: the first baseline, the leading between
    # the lines, and the deepest descender under the last. Sized rather than
    # over-allocated because the leading search paints a few hundred of these.
    height = int(em * (2.0 + (len(lines) - 1) * pitch + 1.5)) + 80
    img = Image.new("L", (max(60, width), max(60, height)), 0)
    draw = ImageDraw.Draw(img)
    base = int(em * 2.0)
    for i, line in enumerate(lines):
        draw.text((40, base + i * pitch * em), line, font=font, fill=255,
                  anchor="ls", stroke_width=stroke, stroke_fill=255)
    if marker is not None:
        small = _fit_font(font_path, round(em * 0.9), weight)
        draw.text((40 + int(font.getlength(lines[0]) + em * 0.30), base),
                  f"{marker}.", font=small, fill=255, anchor="ls",
                  stroke_width=stroke, stroke_fill=255)
    ink = img.point(lambda v: 255 if v >= alpha else 0)
    box = ink.getbbox()
    return ink.crop(box) if box else None


def _painted(font_path, samples, size, ppu, alpha, marker=False, axis=0,
             ring=0.0, pitch=RENDER_PITCH, weight=None):
    """Median painted extent (0 = height, 1 = width) of ``samples`` at ``size``.

    ``ring`` is the outline thickness as a fraction of the size, and it is part
    of the measurement rather than an afterthought: the origin's ink INCLUDES its
    ring, so fitting a bare glyph against it inflates the size by twice the ring
    on every outlined title. That is most of why the one template with a measured
    ring drew half again too much ink.

    ``weight`` is the instance of a VARIABLE face to paint, and it is here for
    the same reason the ring is: it changes the ink being matched. A static face
    has no axis and takes None, which is the whole of what it ever did.
    """
    got = []
    for i, lines in enumerate(samples):
        ink = _paint(font_path, lines, size * ppu, alpha,
                     stroke=ring * size * ppu,
                     marker=(i % 4 + 1) if marker else None, pitch=pitch,
                     weight=weight)
        if ink:
            value = _extent_of(ink, axis)
            if value:
                got.append(value)
    return statistics.median(got) if got else None


def _fit_size(target_px, font_path, samples, ppu, alpha, marker=False, axis=0,
              ring=0.0, pitch=RENDER_PITCH, weight=None):
    """The size (in recipe user units) whose painted ink measures ``target_px``.

    Bisection rather than a closed form: the painted extent is very nearly linear
    in the size, but the threshold above makes it a step function at the pixel
    level, and bisection lands on the step that matches instead of extrapolating
    through it.
    """
    lo, hi = 3.0, 160.0
    if not target_px or target_px <= 0:
        return None
    if _painted(font_path, samples, lo, ppu, alpha, marker, axis, ring,
                pitch, weight) is None:
        return None
    for _ in range(22):
        mid = (lo + hi) / 2
        got = _painted(font_path, samples, mid, ppu, alpha, marker, axis, ring,
                       pitch, weight)
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


def stroke_per_size(ink, em_px):
    """``_mean_stroke`` per unit of TYPE SIZE — the weight, and nothing else.

    NOT per unit of ink height, which is what this used to divide by. On a
    single line the two agree closely enough; on a STACK they do not agree at
    all, because a block's ink height is mostly its LEADING. Dividing by it made
    the weight reading a reading of the line spacing: at the renderer's fixed
    0.78 our own unfattened טריפה measured heavier than its origin, and at the
    1.0 its design actually sets, lighter — same glyphs, same strokes, opposite
    verdicts. סנטוריני, which leads at 0.5, came out "bold" for the same reason
    and printed a title the owner could see was too fat.

    The type size is also the unit ``bold_w`` is expressed in, so the number
    this compares is the number the renderer will be handed.
    """
    if not ink or not em_px or em_px <= 0:
        return None
    return _mean_stroke(ink) / em_px


def fit_bold(mask, region, font_path, samples, size, ppu, alpha, pitch=None,
             weight=None):
    """``(bold, bold_w, note)`` for a title; ``bold`` is None when unmeasurable.

    Compares the ORIGIN's stroke weight against our own cut painted at the size
    AND the leading that were just fitted, and walks the synthetic-bold grid for
    the weight that reproduces it. ``bold`` comes back False — never True with a
    token weight — when our unfattened cut already carries that weight, because
    emboldening a design that is not bold is the one outcome this must never
    produce.

    It also comes back None when the raster cannot resolve the question. A card
    title is drawn at roughly one device pixel of stroke, and ``_mean_stroke``
    counts whole-pixel erosions — so on a light face one step of the grid can
    move the reading LESS than rasterising noise does, and the search then picks
    a weight out of that noise. The tell is a candidate curve that does not
    climb: a fatter stroke that measures thinner than a thinner one is not a
    measurement. טריפה is exactly that (0.0131, 0.0162, 0.0140, 0.0130, … for
    0.000, 0.005, 0.010, 0.015 of the size), and it is why a design whose title
    is not bold was shipped bold.
    """
    em = size * ppu
    origin = stroke_per_size(mask.crop(region), em)
    if not origin:
        return None, None, None
    kw = {} if pitch is None else {"pitch": pitch}

    def weigh(bold_w):
        # ``weight`` is the VARIABLE face's own cut — a real weight the file
        # carries — and the synthetic stroke is fattening applied ON TOP of it.
        # Weighing the fattening against a different cut than the one that will
        # be printed would charge the difference between the cuts to the stroke.
        got = [stroke_per_size(_paint(font_path, lines, em, alpha,
                                      stroke=bold_w * em, weight=weight, **kw), em)
               for lines in samples]
        return statistics.median([g for g in got if g]) if any(got) else None

    curve = [(w, weigh(w)) for w in _BOLD_W_GRID]
    scored = [(abs(got - origin), weight) for weight, got in curve if got]
    if not scored:
        return None, None, None
    live = [got for _w, got in curve if got]
    if any(b < a for a, b in zip(live, live[1:])):
        return (None, None,
                "bold: at this title's size the artwork is drawn about one "
                "device pixel of stroke wide, which is too coarse to tell one "
                "weight step from the next — fattening it more measured "
                "THINNER than fattening it less. Left unset; set it by eye "
                "against the original.")
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


# How much heavier the original's word strokes have to be before it is worth
# telling the owner. Below this the difference is rasterising, above it the font
# file is a different cut from the one the design was set in.
_WEIGHT_GAP = 0.10


def word_weight_gap(mask, regions, font_path, words, size, ppu, alpha):
    """A sentence naming the word STROKE WEIGHT gap, or None when there is none.

    There is no word-weight knob to set — the deck's words are drawn at the
    font's own weight, and only the title has a synthetic-bold option — so this
    cannot be fixed by calibration. That is exactly why it has to be SAID: the
    size can be measured perfectly and the words still print lighter than the
    original, and without a word for it the owner is left comparing two cards and
    unable to name what differs.

    Measured on the strokes alone (``_stroke_ratio``: mean distance from an ink
    pixel to the background, per unit of ink height), which is a property of the
    weight and not of how long the text is — the original's words are not ours.
    """
    if not (regions and words and size):
        return None
    origin = [_stroke_ratio(mask.crop(r)) for r in regions]
    origin = [v for v in origin if v]
    ours = []
    for i, word in enumerate(words):
        ink = _paint(font_path, [word], size * ppu, alpha, marker=i % 4 + 1)
        got = _stroke_ratio(ink) if ink else None
        if got:
            ours.append(got)
    if not origin or not ours:
        return None
    ratio = statistics.median(origin) / statistics.median(ours)
    if ratio <= 1 + _WEIGHT_GAP:
        return None
    return (f"The original's words are drawn about {ratio:.0%} of this font's "
            "stroke weight — i.e. the file this theme ships is a LIGHTER cut "
            "than the design was set in. Nothing here can correct that (the "
            "words carry no weight knob); the fix is to upload the right cut of "
            "the word font.")


def title_samples(cfg):
    """The sample titles a fit is measured over, as lists of lines.

    Shared with ``calibration_health`` on purpose: it already reasons about WHICH
    honoree names a title must be measured against (a spread with and without an
    ascender and a descender), and a fit that used a different spread than the
    health check would disagree with it on the very theme it just calibrated.
    """
    return [lines for lines, _name in calibration_health.sample_titles(cfg)]


def sample_words(cfg):
    """A sample of the words this theme actually prints, for the word-size fit.

    Resolved the way ``topup.fill`` resolves it, and for the same reason: a theme
    that names no wordlist is not a theme with no words, it is a theme whose deck
    is filled from ``generic-350`` — so that IS the pool its cards print. Reading
    ``cfg["wordlist"]`` alone returned an empty list for two of the shipped
    templates, the fit had nothing to measure against, and their word size went
    unpinned on artwork that measures perfectly well.
    """
    words = [w.strip() for w in topup._read_wordlist(cfg.get("wordlist"))]
    words = [w for w in words if w]
    if len(words) < _FIT_WORD_SAMPLE:
        seen = set(words)
        for w in topup._read_wordlist(topup.GENERIC):
            w = w.strip()
            if w and w not in seen:
                seen.add(w)
                words.append(w)
    return words[:_FIT_WORD_SAMPLE]


# How far the per-sample title fits may spread around their median before the
# answer is taken to depend on WHICH honoree name is set rather than on the
# design. The samples are chosen (by ``calibration_health.sample_titles``) to
# straddle the ascender/descender extremes on purpose, so a face whose ink height
# is a property of the FACE agrees across them to a couple of percent, and one
# whose is a property of the TEXT does not.
_FIT_STABLE = 0.06


def _row_ink(ink):
    """Per row: ``(ink coverage, horizontal extent)`` — the block's two profiles.

    The DENSITY says how much ink a row carries; the EXTENT says how wide the
    line at that row runs, which is the steadier of the two — it is set by the
    first and last glyph's edges, so it does not move with how tightly the
    letters in between happen to pack.

    Both come out of Pillow rather than a Python loop over the pixels: this runs
    once per candidate leading inside a search, and a per-pixel loop over a
    few hundred candidates is the difference between a calibration the owner
    waits a moment for and one they give up on. A box-resize to a single column
    IS the per-row mean, and a one-row crop's bounding box IS that row's extent.
    """
    w, h = ink.size
    if not w or not h:
        return [], []
    dens = list(ink.resize((1, h), Image.BOX).getdata())
    ext = []
    for y in range(h):
        bb = ink.crop((0, y, w, y + 1)).getbbox()
        ext.append((bb[2] - bb[0]) if bb else 0)
    return dens, ext


def _resample(v, n):
    m = len(v)
    if m == n or not m:
        return list(v)
    return [v[min(m - 1, int(i * m / n))] for i in range(n)]


def _profile_match(a, b):
    """How alike two row profiles are, 0..1, independent of their scale.

    Each is normalised by its own total (density) or peak (extent) first, so the
    comparison is of SHAPE — where down the block the ink sits — and not of how
    much ink there is. The origin's title says another honoree's name, so the
    amount can never agree; where the lines fall can.
    """
    n = max(len(a), len(b))
    if not n:
        return 0.0
    a, b = _resample(a, n), _resample(b, n)
    sa, sb = float(sum(a)) or 1.0, float(sum(b)) or 1.0
    return sum(min(p / sa, q / sb) for p, q in zip(a, b))


def _extent_match(a, b):
    n = max(len(a), len(b))
    if not n:
        return 0.0
    a, b = _resample(a, n), _resample(b, n)
    ma, mb = float(max(a)) or 1.0, float(max(b)) or 1.0
    return 1.0 - sum(abs(p / ma - q / mb) for p, q in zip(a, b)) / n


def _sample_scores(o_dens, o_ext, font_path, samples, size, ppu, alpha, ring,
                   pitch, weight=None):
    """How alike each sample's painted block is to the original's, or None."""
    out = []
    for one in samples:
        drawn = [ln for ln in one if ln and ln.strip()]
        cand = _paint(font_path, drawn, size * ppu, alpha,
                      stroke=ring * size * ppu, pitch=pitch, weight=weight)
        if not cand:
            out.append(None)
            continue
        c_dens, c_ext = _row_ink(cand)
        out.append(_extent_match(o_ext, c_ext)
                   + _DENS_VOTE * _profile_match(o_dens, c_dens))
    return out


def size_from_matching_samples(ink, font_path, samples, ppu, alpha, ring, pitch,
                               weight=None):
    """The size, fitted over the samples the original's own ink LOOKS like.

    THE SAMPLES ARE NOT INTERCHANGEABLE. ``sample_titles`` straddles the
    ascender/descender extremes on purpose, so that a face whose ink height is a
    property of the FACE can be told from one whose is a property of the TEXT.
    But the artwork carries ONE honoree name, not the spread, and its ink is
    exactly as tall as that name's letters make it — so a median over the whole
    spread charges the size with the difference between the original's name and
    ours. Measured on ברוקלין, whose artwork reads "חן בן 13" — a final nun and
    no lamed: the two sample names carrying a lamed fit 29.06, the two without
    fit 32.44, and the median splits the difference at 31.31, three percent under
    Canva's 32.3.

    Which of them the artwork is like is measurable, and by the reading this
    module already trusts to pick the leading: the row profile. So score every
    sample against the original's, keep the half that matches at least as well as
    the median sample does, and answer with the median of THEIR fits. Still a
    median — no single name may decide — it has simply stopped averaging in the
    names the artwork visibly is not. Re-measured across every shipped surface it
    moves ברוקלין −3.1% -> +0.4% and tightens קליפורניה, טריפה and סנטוריני
    besides; the templates whose title carries no name at all (קופקבנה) have four
    identical samples and cannot move.
    """
    kw = {} if pitch is None else {"pitch": pitch}
    kw["weight"] = weight
    target = ink.size[1]
    size = _fit_size(target, font_path, samples, ppu, alpha, ring=ring, **kw)
    if not size or len(samples) < 2:
        return size
    o_dens, o_ext = _row_ink(ink)
    scores = _sample_scores(o_dens, o_ext, font_path, samples, size, ppu, alpha,
                            ring, RENDER_PITCH if pitch is None else pitch,
                            weight)
    live = []
    for score, one in zip(scores, samples):
        if score is None:
            continue
        own = _fit_size(target, font_path, [one], ppu, alpha, ring=ring, **kw)
        if own:
            live.append((score, own))
    if len(live) < 2:
        return size
    cut = statistics.median([s for s, _ in live])
    keep = [v for s, v in live if s >= cut]
    return round(statistics.median(keep), 2) if keep else size


def leading_curve(ink, font_path, samples, ppu, alpha, ring=0.0, weight=None):
    """How well every candidate leading reproduces one title block's ink.

    ``[(pitch, size, score, per_sample_scores), ...]`` over the whole grid, in
    grid order — the landscape ``solve_size_and_leading`` takes its argmax of,
    and which ``couple_leadings`` needs WHOLE: a peak's height says which
    leading a surface prefers, but only the shape around it says how strongly,
    and the per-sample scores say how much of that shape is measurement noise.

    The WHOLE grid, not a coarse pass refined around its winner. The score is
    smooth in the leading but NOT unimodal — a two-line block scores a second,
    lower bump where our candidate's descender lands on the original's next
    line — so a coarse pass can settle in the wrong basin and a fine pass that
    only looks next door can never leave it. The flat sweep costs about twice
    what the two-stage one did, which is a few seconds inside a calibration
    that already spends most of its time in the browser.
    """
    target = ink.size[1]
    o_dens, o_ext = _row_ink(ink)
    out = []
    for pitch in _PITCH_GRID:
        # BOTH halves are taken over every sample. The score has to be: the
        # title's first line carries the name, so its width is the one part of
        # the profile our sample cannot reproduce, and letting a single name
        # decide is what chose a leading 16% out on סיישל. A median over names
        # that straddle the range cannot be swung by any one of them.
        #
        # The SIZE used to be bisected against ``samples[:1]`` alone, on the
        # argument that the leading does not move with which honoree name is set
        # and a four-fold bisection would pay four times for one answer. The
        # measurement says otherwise, and the argument was self-defeating
        # besides: the candidate block painted for the score is painted AT that
        # size, so scoring one name's size let that one name decide the spacing
        # after all — the very thing the median score exists to prevent. It also
        # scored a (size, leading) pair the fit would never return. Fitting the
        # size over the whole spread moves פריז's back from 0.76 to 0.72 (its
        # size −4.3% -> −1.8% against Canva), טריפה's back from 1.32 to 1.36
        # (+2.1% -> +0.3%) and סנטוריני's from 0.48 to 0.52 (+2.5% -> −0.1%),
        # and leaves every other shipped surface where it was.
        #
        # And it costs one painting per sample, not a bisection per sample: the
        # painted extent is very nearly linear in the size (``fit_title_size``
        # already leans on that for its stability grade), so bisecting ONE
        # sample and then rescaling by the samples' median extent lands on the
        # same answer the four-fold bisection would — for a twentieth of the
        # work, inside a grid that runs eighty-six times per surface.
        base = _fit_size(target, font_path, samples[:1], ppu, alpha, ring=ring,
                         pitch=pitch, weight=weight)
        if not base:
            continue
        spread = _painted(font_path, samples, base, ppu, alpha, axis=0,
                          ring=ring, pitch=pitch, weight=weight)
        if not spread:
            continue
        size = round(base * target / spread, 2)
        scored = [s for s in _sample_scores(o_dens, o_ext, font_path, samples,
                                            size, ppu, alpha, ring, pitch,
                                            weight)
                  if s is not None]
        if scored:
            out.append((pitch, size, statistics.median(scored), scored))
    return out


class Undetermined:
    """The answer "this artwork does not say", which is not the same as None.

    None means "nothing to measure" — a single-line title has no spacing at all.
    This means "there IS a spacing and the ink cannot show it", which is the one
    case where the owner has to be asked, and asking requires telling the two
    apart.

    It carries the argmax it declined to trust (``leading``, ``size``) and how
    wide the flat was (``plateau``), because declining is not the same as having
    nothing: with no owner value to use instead, the argmax is still the best
    available guess and is kept — with the flat SAID, so the owner knows there is
    a number only she can supply.
    """

    def __init__(self, leading=None, size=None, plateau=0.0):
        self.leading, self.size, self.plateau = leading, size, plateau

    def __repr__(self):
        return f"UNDETERMINED(leading={self.leading}, plateau={self.plateau:.0%})"

    def __bool__(self):
        return False


UNDETERMINED = Undetermined()


# How near the top of the score range still counts as "this leading fits too",
# as a fraction of the sweep's own range (best - worst). Relative to the range
# rather than absolute, because the range is set by how much structure the ink
# has and that differs by an order of magnitude between a crisp two-line title
# and a welded blob.
_PLATEAU_EPS = 0.02
# How wide that band of equally-good leadings may be, as a fraction of the
# winning leading, before the answer is refused. A design sets ONE spacing, so a
# measurement that scores a quarter-wide range of spacings equally has not found
# it — it has found that this artwork does not say.
_PLATEAU_MAX = 0.15


def leading_plateau(curve, leading):
    """How wide the band of equally-good leadings is, per unit of the winner.

    A leading is only measurable if the artwork's rows say where the lines are.
    On a title whose ring is thick enough that the lines WELD — סיישל's outline
    is 0.071 of the type size, the owner's Canva slider at 111 — there are no
    rows to read: the block is one mass whose height any (size, leading) pair on
    a whole diagonal reproduces, and the sweep comes back with a flat top a
    dozen grid steps wide. Picking its argmax is picking noise, and it picked
    0.70 where the design is set at three quarters.

    So the width of the flat is the measurement's own error bar, and this
    reports it. Every surface whose ink has row structure comes back well under
    a tenth; the one that has none comes back at a quarter.
    """
    scored = [(row[0], row[2]) for row in curve or () if row[2] is not None]
    if len(scored) < 3 or not leading:
        return 0.0
    hi = max(s for _p, s in scored)
    lo = min(s for _p, s in scored)
    if hi <= lo:
        return float("inf")            # a perfectly flat sweep says nothing
    bar = hi - _PLATEAU_EPS * (hi - lo)
    near = [p for p, s in scored if s >= bar]
    return (max(near) - min(near)) / leading if near else 0.0


def solve_size_and_leading(ink, font_path, samples, ppu, alpha, ring=0.0,
                           pitch=None, curve_out=None, weight=None):
    """``(size, leading, score)`` reproducing one title block's ink.

    Two unknowns, so two readings of the same ink:

      * its total HEIGHT pins the size once a leading is assumed — one bisection
        per candidate leading, because the painted height is monotone in the size;
      * its row PROFILE then says which of those (size, leading) pairs actually
        lays the lines out where the original has them.

    A single-line title has no leading to solve for, so it takes the renderer's
    own step and this is exactly the one-bisection fit that shipped before —
    which is why the shipped single-line templates do not move. It reports its
    leading as ``None``: there is nothing to say about the spacing of one line,
    and the renderer must be left on its own step rather than pinned to a number
    this never measured.

    ``pitch`` short-circuits the grid when the caller already knows the spacing
    and only wants the size fitted at it — which is how a surface coupled to its
    neighbours (``couple_leadings``) is re-fitted — and it returns the pitch it
    was given so the pair always leaves together.

    ``curve_out``, when a list, receives the landscape the argmax was taken of.
    It is handed out rather than recomputed because sweeping the grid is the
    whole cost of this module's title work, and the coupling pass needs the
    curve of every surface at once.
    """
    target = ink.size[1]
    lines = [ln for ln in (samples[0] if samples else []) if ln and ln.strip()]
    if len(lines) < 2:
        size = size_from_matching_samples(ink, font_path, samples, ppu, alpha,
                                          ring, None, weight)
        return size, None, None
    if pitch is not None:
        size = size_from_matching_samples(ink, font_path, samples, ppu, alpha,
                                          ring, pitch, weight)
        return size, pitch, None
    curve = leading_curve(ink, font_path, samples, ppu, alpha, ring, weight)
    if curve_out is not None:
        curve_out[:] = curve
    if not curve:
        return None, None, None
    best = max(curve, key=lambda row: row[2])
    leading = round(best[0], 3)
    size = size_from_matching_samples(ink, font_path, samples, ppu, alpha, ring,
                                      leading, weight)
    plateau = leading_plateau(curve, leading)
    if plateau > _PLATEAU_MAX:
        # The ink cannot tell one spacing from another here, so the argmax of
        # that flat is not an answer — it is a coin toss between a dozen grid
        # steps. Say so, and hand the argmax over as what it is: the best guess
        # available until somebody reads the real number off the design.
        return size, Undetermined(leading, size, plateau), best[2]
    return size, leading, best[2]


# ---- ONE TEXT BOX, SEVERAL SURFACES ----------------------------------------
#
# A design's front, board and card back are usually the SAME title laid out once
# and reused at three scales. It is visible in the ink: across the shipped set
# the three surfaces' ink aspect ratios agree to within half a percent
# (סיישל 1.6449 / 1.6463 / 1.6387; פריז 3.4217 / 3.4316 / 3.4000), and the
# owner's Canva sizes come out in the ratio of the ink HEIGHTS — סיישל's back
# over front is 147/138 = 1.065 in the ink against 22.7/21.3 = 1.066 in Canva.
# A block reused at another scale is stacked at the same leading, so those
# surfaces are several readings of ONE number and reading each in isolation
# throws the rest of the evidence away.
#
# It is worth the trouble because one step of the leading grid is worth about a
# percent of the size solved beside it. פריז's front settles at 0.72 and its
# back one step away at 0.74, and that one step is the whole of its back's
# error: 24.19 against Canva's 25.0 (−3.2%) at 0.74, 24.65 (−1.4%) at the
# front's 0.72.
#
# NOT every design reuses the block, and forcing one on those would be much
# worse than measuring them apart. טריפה's back really does stack its two lines
# a third further apart than its front (ink aspect 0.767 against 0.933 — a
# different block, not the same one scaled) and its two surfaces settle 20 grid
# steps apart; סנטוריני's board is a third reading that agrees with neither of
# the other two. So the surfaces are coupled only where the ink itself says
# they agree, and the agreement is tested rather than assumed.

# The standard error of a MEDIAN, for a normal population, is this multiple of
# the mean's — sqrt(pi/2). The score a surface reports IS a median over the
# sample honoree names, so this is the scale on which two of its scores are
# distinguishable at all, and it is arithmetic rather than a tuned tolerance.
_MEDIAN_SE = (math.pi / 2) ** 0.5


def _score_noise(sample_scores):
    """How finely one surface's median score can be read.

    The score is a median over the sample honoree names, so how much those
    names disagree IS the uncertainty of the number: a score difference smaller
    than this is not evidence about the leading, it is evidence about which name
    happens to be set.
    """
    n = len(sample_scores)
    if n < 2:
        return 0.0
    return _MEDIAN_SE * statistics.pstdev(sample_scores) / (n ** 0.5)


def couple_leadings(curves):
    """One leading for surfaces whose ink agrees on it. -> ``(leading, note)``.

    ``curves`` maps a surface label to its ``leading_curve``. The answer is the
    MEDIAN of the surfaces' own answers — the same device this module uses
    wherever several readings of one number are available, and the one that
    cannot be swung by any single surface's noise — snapped back onto the grid
    the curves were swept on.

    It is returned only when every surface's ink is content with it: the score
    the shared leading costs that surface, against its own best, has to be
    inside that surface's own noise (``_score_noise``). One surface that pays
    more than its ink can tell apart is a surface set at its own spacing, and
    the whole set is left alone — pinning a shared number on טריפה, whose back
    stacks a third wider than its front, would put a size 20 grid steps out on
    one of the two.

    ``note`` says why nothing was shared, for the owner, and is None when it was.
    """
    scored = {k: c for k, c in (curves or {}).items() if c}
    if len(scored) < 2:
        return None, None
    best = {k: max(c, key=lambda row: row[2]) for k, c in scored.items()}
    at = {k: {round(row[0], 3): row for row in c} for k, c in scored.items()}
    shared = sorted(set.intersection(*[set(a) for a in at.values()]))
    if not shared:
        return None, None
    want = statistics.median([b[0] for b in best.values()])
    # Snapped to the grid every curve was actually swept on — a median of an
    # even number of surfaces lands between two steps, and no score was measured
    # there. Ties to the step the surfaces score highest between them.
    step = min(shared, key=lambda p: (abs(p - want),
                                      -sum(at[k][p][2] for k in at)))
    for k, curve_best in best.items():
        noise = _score_noise(curve_best[3])
        if curve_best[2] - at[k][step][2] > noise:
            return None, (
                "leading: this design's title surfaces are NOT one block at "
                f"several scales — {k} is stacked at {curve_best[0]} of its type "
                f"size and cannot be read at the {step} the others share, so "
                "each surface keeps the spacing its own artwork was measured "
                "at.")
    return step, None


def refit_at_leading(fit, leading):
    """One surface's size, re-solved at a leading settled somewhere else.

    ``fit`` is what ``fit_title_size`` records into its ``fit_out``. Only the
    size is re-solved: the ink, the ring, the alpha and the weight are the same
    reading they always were, and the leading is the one thing coming from
    outside it.
    """
    if not fit or leading is None:
        return None
    return size_from_matching_samples(fit["ink"], fit["font"], fit["samples"],
                                      fit["ppu"], fit["alpha"], fit["ring"],
                                      leading, fit.get("weight"))


def fit_title_size(mask, image, box, ppu, ox, oy, font_path, samples, ink_hex,
                   ring=0.0, leading=None, fit_out=None, owner_leading=None,
                   weight=None):
    """Fit one surface's title size. -> ``(size, grade, note, ctx, leading)``.

    ``ctx`` is ``(ink_region, alpha)`` — what ``fit_bold`` needs to go on and
    weigh the same ink — or None when nothing was measured.

    ``fit_out``, when a dict, receives this surface's whole reading — the ink,
    what it was painted against, and the leading curve swept over it — so that
    ``couple_leadings`` can weigh it against the design's other surfaces and
    ``refit_at_leading`` can re-solve the size without measuring anything twice.

    The trailing ``leading`` is the line spacing this surface's ink was measured
    WITH, as a fraction of the type size, or None for a single-line title that
    has none. The size and the leading are inseparable in the ink, so they leave
    together: pinning the size without it would print the measured type at the
    wrong spacing, which is the whole defect this pair exists to fix. Each
    surface measures its own — טריפה's back stacks its two lines a third further
    apart than its front does.

    ``leading`` IN says the spacing is already known and only the size is
    wanted; it is then returned unchanged, so the caller still gets the pair.

    ``owner_leading`` is the spacing already on the theme — the number the owner
    set, or a previous pass measured. It is used ONLY where the artwork cannot
    decide the spacing itself (see ``leading_plateau``), and the size is then
    fitted at it, which is the whole point: a spacing without a size refitted to
    it prints type that was measured against a different picture. Where the ink
    CAN decide, the measurement wins — this can never freeze a template against
    a genuine reading.

    ``ring`` is the outline thickness the title is painted with, as a fraction of
    the size. The origin's ink includes its ring, so a bare-glyph candidate is
    fitted about two ring-widths too large on every outlined title.

    ``weight`` is the instance of a VARIABLE title face to fit against, and it
    belongs to the same family of arguments as the ring: the number this returns
    is only the size of the type that will actually be PRINTED, so the candidate
    has to be painted in the cut that will be printed. See ``fit_font_weight``
    for how the pair is solved together.

    THE GRADE IS STABILITY, NOT WIDTH. It used to come from a second fit against
    the ink's WIDTH, and that check cannot work: it compares OUR sample title's
    width against the width of the ORIGIN's own title, which is different text
    (the origin says one honoree's name, the sample says another). It agrees only
    when the two happen to set to the same length, so it graded five of the ten
    shipped templates "low" purely for having a different name in the artwork —
    and low fits are dropped, which is why those five titles were auto-fitted
    with no measurement at all and came back up to 2.1x off.

    What CAN be asked without knowing the origin's text is whether the answer
    depends on the text at all: fit each sample separately and see whether they
    agree. The samples deliberately straddle the ascender/descender extremes, so
    agreement across them means the ink height is a property of the face and the
    single number is safe to pin. The width comparison stays, demoted to a note,
    because a large disagreement still says something real about the font.
    """
    if not samples:
        return (None, None, "title: no sample title could be built for this theme.",
                None, None)
    extent = _ink_extent(mask, box, ppu, ox, oy)
    if not extent:
        return None, None, None, None, None
    ink_h, ink_w, region = extent
    alpha = _alpha_threshold(ink_hex, _background(image, mask, region))
    if not all(_covers(font_path, "".join(lines)) for lines in samples):
        return (None, None,
                "size: the theme's title font has no glyphs for this title's own "
                "text, so its size could not be measured — check the font.",
                None, None)
    ink = solid_ink(mask.crop(region))
    curve = []
    size, leading, _score = solve_size_and_leading(
        ink, font_path, samples, ppu, alpha, ring=ring, pitch=leading,
        curve_out=curve, weight=weight)
    undecided = None
    owner_set = False
    if isinstance(leading, Undetermined):
        # The sweep found a flat top: a band of spacings reproduces this ink
        # equally well, so the artwork does not say which one the design uses.
        # Whichever way out is taken, SAY so — the owner cannot supply a number
        # she is never told is missing.
        flat = (f"leading: this title's ink has no row structure to read the "
                f"line spacing off — a band of spacings {leading.plateau:.0%} "
                f"of the value wide reproduces it equally well, because a ring "
                f"thick enough welds the lines into one mass. ")
        if owner_leading:
            # Her reading of the design beats any inference from ink that cannot
            # tell one spacing from another — and the SIZE is refitted at it,
            # because a spacing without a size fitted to it prints type that was
            # measured against a different picture.
            size, leading, _score = solve_size_and_leading(
                ink, font_path, samples, ppu, alpha, ring=ring,
                pitch=float(owner_leading), curve_out=curve, weight=weight)
            owner_set = True
            undecided = flat + (
                f"The line spacing already set on this template, {leading}, was "
                f"used instead, and the size beside it is fitted AT it. Read it "
                f"off the design (Canva shows it in the text panel) if it is "
                f"wrong.")
        else:
            leading = leading.leading
            undecided = flat + (
                f"Nothing has been set on this template, so the best of the flat "
                f"({leading}) is kept — it is a guess, not a reading. Read the "
                f"line spacing off the design (Canva shows it in the text panel) "
                f"and set title_style.leading; the size is then fitted to it.")
    if fit_out is not None:
        fit_out.update({"ink": ink, "font": font_path, "samples": samples,
                        "ppu": ppu, "alpha": alpha, "ring": ring,
                        "weight": weight,
                        "curve": curve, "size": size, "leading": leading,
                        "box_h": box["y1"] - box["y0"],
                        # An OWNER-set spacing is not a reading to be weighed
                        # against the other surfaces' — it is the answer. The
                        # coupling pass leaves it exactly where she put it.
                        "owner_leading": owner_set})
    # Every measurement below repaints the same block, so it has to be repainted
    # at the spacing the block was fitted at. A single-line title has no spacing,
    # and the renderer's own step is what it will be drawn with.
    pitch = leading if leading is not None else RENDER_PITCH
    box_h = box["y1"] - box["y0"]
    if not _in_box(size, box_h):
        return (None, None,
                "size: the measured title ink is not a plausible size for its "
                "box, so nothing was pinned — the renderer auto-fits.", None, None)
    # How far the answer moves with the honoree's name, measured by painting each
    # sample ONCE at the fitted size rather than bisecting a fit per sample. The
    # painted extent is very nearly linear in the size, so the relative spread of
    # the extents IS the relative spread of the sizes they would fit — the same
    # signal for a twentieth of the work, which matters because this runs behind
    # a button the owner waits on.
    each = []
    for one in samples:
        ink = _paint(font_path, one, size * ppu, alpha, stroke=ring * size * ppu,
                     pitch=pitch, weight=weight)
        got = _extent_of(ink, 0) if ink else None
        if got:
            each.append(got)
    spread = ((max(each) - min(each)) / statistics.median(each)) if each else None
    wide = _fit_size(ink_w, font_path, samples, ppu, alpha, axis=1, ring=ring,
                     pitch=pitch, weight=weight)
    note = undecided
    if leading is not None and abs(leading - RENDER_PITCH) > 0.02:
        note = ((note + " ") if note else "") + (
                f"size: the original stacks its title lines {leading} of the type "
                f"size apart, where this renderer's default is {RENDER_PITCH}. "
                "The measured spacing is pinned alongside the size and printed "
                "with it, so the block matches the artwork — but the two were "
                "read off the same ink and only make sense together: changing "
                "one by hand without the other resizes the block.")
    if wide and abs(wide - size) / size > 0.12:
        wnote = (f"size: fitted from the height of the original's title ink. Its "
                 f"WIDTH says {wide}, not {size} — the title font is not quite the "
                 "one the design was made in (a lookalike, or Canva condensed the "
                 "text box), or the original's title is simply a different length "
                 "of text. Only one of the two axes can match; check the preview.")
        note = (note + " " + wnote) if note else wnote
    if spread is None:
        return size, "medium", note, (region, alpha), leading
    if spread <= _FIT_STABLE:
        return size, "high", note, (region, alpha), leading
    extra = (f"size: the fit moves {spread:.0%} across sample honoree names, so "
             f"{size} is the median rather than one exact answer — this face's "
             "ink height depends on which letters the name carries.")
    return (size, "medium", (note + " " + extra) if note else extra,
            (region, alpha), leading)


def fit_word_size(surfaces, font_path, words):
    """Fit the deck's single word size. -> ``(size, grade, note)``.

    ``surfaces`` is ``[(mask, image, slots, ppu, ox, oy), ...]`` — one entry per
    FRONT the deck prints, and that plural is the point. The origin sets every
    word in the deck at ONE size (Canva Bulk Create fills a fixed-size box, and
    fills the same one on all eight cards), so every row on every front is
    evidence about the same number. This used to read one card, which made the
    answer a median of FOUR rows — and the rows are not interchangeable samples:
    a numbered line is a marker set at 0.9 of the word size beside a word set at
    it, so how much the marker weighs in the row's body band depends on how LONG
    that row's entry happens to be. Four rows of the customer's own phrases land
    wherever that customer's phrases landed.

    Measured against the owner's Canva values, reading all eight fronts instead
    of one moves פריז from −4.5% to −1.2% and סיישל from −12.3% to −1.2%, and
    does not move a single other template by one step of the fit — because the
    templates it does not move are the ones whose one card already happened to
    be representative of their eight.

    WHICH words the origin printed is still unknown, and a Hebrew line's ink
    height swings ~30% on whether it happens to carry a lamed or a
    final-descender. So the match stays median-to-median: the median body band of
    the origin's rows against the median of a sample of the words this theme
    prints.
    """
    surfaces = [s for s in surfaces if s and s[2]]
    if not words or not surfaces:
        return None, None, None
    bands, regions = [], []
    first = None
    for mask, image, slots, ppu, ox, oy in surfaces:
        for region in word_rows(mask, slots, ppu, ox, oy):
            if not region:
                continue
            band = _band_height(mask, region)
            if not band:
                continue
            bands.append(band)
            if first is None:
                # The paints, the artwork under them and the render scale are
                # deck-wide, so the alpha cut and the stroke-weight comparison
                # are read off the first front that carried a row rather than
                # re-derived per surface.
                first = (mask, image, slots, ppu, ox, oy)
            if first[0] is mask:
                regions.append(region)
    if len(bands) < 2:
        return (None, None,
                "word_size: the original's word rows could not be isolated "
                "cleanly, so the words keep auto-fitting their slots.")
    if not _covers(font_path, "".join(words)):
        return (None, None,
                "word_size: the theme's word font has no glyphs for this theme's "
                "own wordlist — check the font.")
    mask, image, slots, ppu, ox, oy = first
    alpha = _alpha_threshold(slots[0].get("color") or "#000000",
                             _background(image, mask, regions[0]))
    samples = [[w] for w in words]
    size = _fit_size(statistics.median(bands), font_path, samples, ppu, alpha,
                     marker=True, axis=2)
    box_h = statistics.median([s["y1"] - s["y0"] for s in slots])
    if not _in_box(size, box_h):
        return (None, None,
                "word_size: the measured word ink is not a plausible size for its "
                "slots, so nothing was pinned — the words auto-fit.")
    # HOW MUCH THE ROWS AGREE is the confidence, and it is a real question rather
    # than a formality: the origin set them all at one size (Canva Bulk Create
    # fills fixed-size boxes), so bands that agree mean the measurement found the
    # type, and bands that scatter mean it found something else — a row that
    # merged with its neighbour, or a diff that caught artwork.
    #
    # Judged by the median deviation, NOT by the full spread. One row in four can
    # legitimately sit well off the others (a word of only short letters measures
    # a shorter body than one carrying a lamed), and a full-spread test lets that
    # single row veto a reading the other three agree on to within 3%. It did
    # exactly that on two templates.
    med = statistics.median(bands)
    scatter = statistics.median([abs(b - med) for b in bands]) / med if med else None
    note = ("word_size: fitted by matching the body band of the original's word "
            "rows — the part of the ink every letter occupies, so it does not "
            "move with whichever ascenders and descenders the original's own "
            "words happened to carry — against this theme's wordlist.")
    weight = word_weight_gap(mask, regions, font_path, words, size, ppu, alpha)
    if weight:
        note += " " + weight
    if scatter is None:
        return size, "medium", note
    if scatter <= 0.05:
        return size, "high", note
    if scatter <= 0.15:
        return size, "medium", (
            note + f" The rows scatter {scatter:.0%} around their median, so "
            f"{size} is a median rather than one exact answer.")
    return (None, None,
            note + f" But the rows scatter {scatter:.0%} around their median, "
            "which they cannot if the original set them all in one box — so "
            "nothing was pinned. Check that the clean and filled fronts differ "
            "ONLY in the words.")


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


def word_surfaces(theme_key, cfg, recipe, single, workdir, first):
    """Every front's ``(mask, image, slots, ppu, ox, oy)``, ``first`` included.

    The deck's word size is ONE number, so the honest sample for it is EVERY row
    the deck prints — thirty-two of them — not the four on whichever card the
    paints happened to be read off. See ``fit_word_size`` for what that buys.

    The two card structures pay very different prices for it, and neither pays
    one it need not:

      * a v1 SHEET already carries all eight cards in the single render this
        pass has in hand, so the extra rows cost nothing at all — the recipe
        just names a different set of slots per cell;
      * a v2 deck is eight separate files, so each extra front is one more
        filled/clean diff. That is the cost of the measurement being real.

    A front whose pair is missing, or whose render fails, is SKIPPED rather than
    fatal: the fit only needs two rows to answer, and losing one card of eight
    must not turn a measurable template into an unmeasured one.
    """
    if not single:
        mask, image, _slots, ppu, ox, oy = first
        out = []
        for card in recipe.get("cards") or []:
            slots = (card or {}).get("words") or []
            if slots:
                out.append((mask, image, slots, ppu, ox, oy))
        return out or [first]
    out = [first]
    slots = (recipe.get("card") or {}).get("words") or []
    if not slots:
        return out
    for index in config.fronts(cfg)[1:]:
        ff = config.card_path(theme_key, index, filled=True)
        fc = config.card_path(theme_key, index)
        if not (os.path.exists(ff) and os.path.exists(fc)):
            continue
        try:
            mask, image, vb = _diff(ff, fc, workdir)
        except (OSError, ValueError, chrome.ChromeTimeout):
            continue
        ppu, ox, oy = _viewport(mask, vb)
        out.append((mask, image, slots, ppu, ox, oy))
    return out


def _front_alignments(theme_key, cfg, recipe, single, workdir, first):
    """``{front index: alignment or None}`` read off each front's own artwork.

    ``first`` is the (mask, tight box) the caller already measured for the first
    front, so that surface is not rendered twice. A front whose diff cannot be
    made, or whose title box the recipe does not record, is simply absent.
    """
    want = len(cfg.get("title_lines") or []) or None
    fronts = config.fronts(cfg)
    out = {}
    if fronts:
        out[fronts[0]] = _alignment(first[0], first[1], want)
    if not single:
        return out
    titles = (recipe.get("card") or {}).get("title") or {}
    for index in fronts[1:]:
        boxes = titles.get(str(index)) or titles.get(index)
        ff = config.card_path(theme_key, index, filled=True)
        fc = config.card_path(theme_key, index)
        if not boxes or not (os.path.exists(ff) and os.path.exists(fc)):
            continue
        try:
            mask, _image, vb = _diff(ff, fc, workdir)
        except (OSError, ValueError, chrome.ChromeTimeout):
            continue
        ppu, ox, oy = _viewport(mask, vb)
        box = (int(min(b["x0"] for b in boxes) * ppu + ox),
               int(min(b["y0"] for b in boxes) * ppu + oy),
               int(max(b["x1"] for b in boxes) * ppu + ox),
               int(max(b["y1"] for b in boxes) * ppu + oy))
        out[index] = _alignment(mask, _bbox(mask, box) or box, want)
    return out


def _majority_alignment(per_front):
    """The alignment most of the fronts read, or None when none of them did.

    Ties go to the lowest-numbered front's answer, so the result does not depend
    on dict ordering — and on a deck that genuinely splits down the middle
    (טוקיו: four right, four left) the other half is recorded per front, so
    which way the tie falls changes nothing that prints.
    """
    votes = [v for v in per_front.values() if v]
    if not votes:
        return None
    best = max(Counter(votes).values())
    for index in sorted(per_front):
        v = per_front[index]
        if v and Counter(votes)[v] == best:
            return v
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



# Fitted values the calibrator is not confident about. Keyed by the confidence
# label it grades, mapped to where the value lives in the blob.
_FITTED_KEYS = (
    ("title_style.size", ("title_style", "size")),
    # Each leading is graded with the size it was solved beside, so a size the
    # calibrator does not believe takes its spacing down with it — the pair is
    # one reading and half of it is worse than neither.
    ("title_style.leading", ("title_style", "leading")),
    ("title_style.back_leading", ("title_style", "back_leading")),
    ("title_style.board_leading", ("title_style", "board_leading")),
    ("title_style.bold", ("title_style", "bold")),
    ("title_style.bold_w", ("title_style", "bold_w")),
    ("word_size", ("word_size",)),
)

# Values that may not be dropped alone. ``bold`` without ``bold_w`` is not a
# smaller answer, it is a DIFFERENT one: the renderer falls back to its house
# weight (0.035 of the size), and the house weight is another design's answer.
# Shipped that way, טריפה and סנטוריני printed titles fattened more than twice
# what calibration had measured for them (0.015 and 0.010), which is exactly the
# "too bold" the owner saw on both. So the weight leaving takes the flag with
# it, the way a leading leaves with the size it was solved beside.
_DROP_TOGETHER = {"title_style.bold_w": ("title_style.bold",)}


def _drop_low_confidence(out, confidence, notes):
    """Remove any fitted value the calibrator graded ``low``.

    Detection PROPOSES; it must not propose something it does not believe. A
    dropped key falls back to the renderer's own auto-fit, which is the
    behaviour that shipped for every theme before fitting existed.
    """
    # A value CARRIED forward from an existing calibration is graded "low" too —
    # it is inherited, not fresh, and the admin form flags exactly "low" for the
    # owner to check. It must never be shredded here, though: dropping it is the
    # regression the carry exists to prevent. Today the carry runs after this, so
    # the case cannot arise; naming it explicitly means a future reorder cannot
    # quietly reintroduce the bug.
    carried = set(out.get("carried") or ())
    doomed = [label for label, _p in _FITTED_KEYS
              if confidence.get(label) == "low" and label not in carried]
    for label in list(doomed):
        for partner in _DROP_TOGETHER.get(label, ()):
            if partner not in doomed and partner not in carried:
                doomed.append(partner)
    dropped = []
    for label, path in _FITTED_KEYS:
        if label not in doomed:
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

# Knobs a re-detect may never silently DROP. Each is a value the renderer prints
# with; losing one sends that surface back to auto-fit, which is a visible change
# to a template the owner had already signed off.
_CARRIED = (("title_style", "size"), ("title_style", "board_size"),
            ("title_style", "back_size"), ("title_style", "leading"),
            ("title_style", "back_leading"), ("title_style", "board_leading"),
            ("title_style", "outline_w"),
            ("title_style", "align"), ("word_size",))


def _carry_forward(out, cfg, notes, confidence):
    """Keep any calibrated value this pass could NOT measure. -> [labels kept].

    The regression guard on "זהה מחדש". Pressing it re-measures everything from
    the artwork, and a measurement can legitimately come back empty — a front
    whose diff caught the background, a font swapped for one without the glyphs,
    an export re-saved at another size. But ``title_style`` is written to the
    theme as a WHOLE dict, so a knob missing from the new blob does not stay as
    it was: it is erased, and that surface silently reverts to auto-fit. A button
    labelled "detect again" must not be able to make a template worse than it was
    before it was pressed.

    So a knob the pass could not measure is carried forward from the calibration
    already in place, and SAID so — the owner needs to know which numbers are
    fresh and which are inherited. A knob it COULD measure always wins: this
    guard only ever fills gaps, so it can never freeze a template against a
    genuine improvement.
    """
    kept = []
    for path in _CARRIED:
        source = cfg
        for key in path[:-1]:
            source = (source or {}).get(key) if isinstance(source, dict) else None
        old = (source or {}).get(path[-1]) if isinstance(source, dict) else None
        if old is None:
            continue
        target = out
        for key in path[:-1]:
            target = target.get(key) if isinstance(target, dict) else None
        if not isinstance(target, dict):
            continue
        if target.get(path[-1]) is None:
            target[path[-1]] = old
            label = ".".join(path)
            # Graded "low", not some new level of its own: the admin form flags
            # exactly "low" and "none" for the owner to check, and an inherited
            # value is precisely one to check. A level it does not recognise
            # would show as a confident reading. Safe because the low-confidence
            # drop runs BEFORE this, so nothing carried here is dropped again.
            confidence[label] = "low"
            out.setdefault("carried", []).append(label)
            kept.append(f"{label} = {old}")
    if kept:
        notes.append(
            "could not be measured this time, so the value already calibrated "
            "was KEPT rather than cleared: " + ", ".join(sorted(kept))
            + ". Re-detecting must never leave a template worse than it was, so "
            "these are inherited, not fresh — if the artwork has changed, clear "
            "them by hand.")
    return kept


def calibrate(theme_key, workdir=None):
    """Derive the calibration blob for a theme from its filled/clean art."""
    cfg = config.theme(theme_key)
    tdir = config.theme_dir(theme_key)
    own = workdir is None
    workdir = workdir or tempfile.mkdtemp(prefix="dugri-calibrate-")
    notes, confidence = [], {}
    out = {"title_style": {}, "board": None, "back": None, "word_size": None}
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

    # Every title surface's whole reading, kept so that the leadings can be
    # weighed against one another once they have all been measured
    # (``couple_leadings``). Each entry is ``(label, fit, write)``; ``write``
    # puts a re-solved (size, leading) pair back wherever that surface's pair
    # lives, which differs per surface and, for a deck with eight backs, per
    # back.
    surface_fits = []

    def couple():
        """Share one leading across the surfaces whose ink agrees on it."""
        # A surface whose spacing the OWNER set is not one more reading to be
        # weighed — it is the answer, and it neither votes nor moves. Coupling a
        # measurement over it would put back exactly the inference she was asked
        # for because the ink could not make it.
        curves = {label: (fit.get("curve") or [])
                  for label, fit, _write in surface_fits
                  if fit.get("size") and not fit.get("owner_leading")}
        shared, why = couple_leadings(curves)
        if why:
            notes.append(why)
        if shared is None:
            return
        moved = []
        for label, fit, write in surface_fits:
            if not fit.get("size") or not fit.get("curve"):
                continue
            if fit.get("owner_leading"):
                continue
            if fit["leading"] == shared:
                continue
            size = refit_at_leading(fit, shared)
            # The plausibility guard the first fit passed still has to hold: a
            # re-solved size is a size, and one that no longer suits its box is
            # not an improvement on the one that did.
            if size is None or not _in_box(size, fit["box_h"]):
                continue
            moved.append(f"{label} {fit['size']}->{size}")
            write(size, shared)
        if moved:
            notes.append(
                "leading: this design's title surfaces are one block used at "
                f"several sizes, so they share one line spacing ({shared} of "
                "the type size) instead of each reading its own out of its own "
                "ink. The sizes re-solved at it: " + ", ".join(moved)
                + ". The spacing and the sizes are one answer — changing either "
                "by hand without the other resizes the block.")

    try:
        recipe_path = config.recipe_path(cfg["recipe"])
        # --- FRONTS FIRST, and that ORDER is load-bearing --------------------
        # The fronts are where the deck's RING is measured, and the ring is not
        # only a style knob: the origin's ink on every surface is the glyph plus
        # its ring, so a size fitted against a bare-glyph candidate comes out
        # about two ring-widths too large. The board and the back are painted
        # with the same ring the fronts measured, so measuring them first — as
        # this used to — fitted both of them ringless against ringed ink. On
        # סיישל that alone put the back's size 20% over.
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

                # Read the title's paints from the VECTOR, not the pixels. The
                # front carries both the title and the words, so exclude the word
                # colours the recipe already recorded — what is left is the
                # title's own fill and ring.
                cands = drop_background(
                    candidate_paints(ff, fc, exclude=_word_colours(recipe)),
                    artwork_around(image, mask, tight))
                fill, outline = assign_paints(cands, image, mask, tight)
                source = "vector"
                # The raster reading is the FALLBACK for the ring, kept because
                # ``outline_w`` is part of the title_style contract and a blob
                # missing one field is rejected whole. The depth measurement
                # below replaces it whenever the size it must be expressed
                # against could be measured.
                rfill, routline, outline_w = _fill_and_outline(image, mask, tight)
                if not (fill and outline):
                    # The sheet encodes colour some other way (style block,
                    # inherited group fill). Fall back to reading the render.
                    fill, outline, source = rfill, routline, "raster"

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

                # --- the size, the ring and the WEIGHT, solved TOGETHER -------
                # None can be measured without the others. The origin's ink is
                # the glyph PLUS its ring, so a size fitted against a bare glyph
                # comes out about two ring-widths too large; and the ring is a
                # fraction of the size, so it cannot be expressed until the size
                # is known. Two passes settle it — the ring is small next to the
                # glyph, so the correction converges immediately — and the joint
                # answer is what both the ink mass and the colour depend on.
                #
                # The WEIGHT of a variable face joins them for the same reason
                # (``fit_font_weight``): the cut changes how wide the same type
                # sets, so a size fitted against the wrong cut charges that cut's
                # width error to the size. It is re-read on every pass at the
                # ring and leading that pass settled, and fed back into the next
                # pass's size fit. A STATIC face has no axis, answers None every
                # time, and this whole strand is a no-op over it.
                tbox = {"x0": min(b["x0"] for b in t), "y0": min(b["y0"] for b in t),
                        "x1": max(b["x1"] for b in t), "y1": max(b["y1"] for b in t)}
                ring = 0.0
                weight = used_weight = None
                fwnote = None
                size = tgrade = tnote = ctx = tlead = None
                front_fit = {}
                for _pass in range(3):
                    # The leading is re-solved on every pass rather than carried
                    # from the first: the candidate the profile is matched
                    # against is painted WITH the ring, so the ring the pass
                    # before measured changes what spacing best reproduces the
                    # original's rows. The last pass — the one whose ring has
                    # converged — is the answer both numbers come from.
                    used_weight = weight
                    size, tgrade, tnote, ctx, tlead = fit_title_size(
                        mask, image, tbox, ppu, ox, oy, title_font, samples,
                        (t[0].get("color") or fill), ring=ring, weight=weight,
                        fit_out=front_fit,
                        owner_leading=(cfg.get("title_style") or {}).get("leading"))
                    if not (size and fill and outline):
                        break
                    got, fwnote = fit_font_weight(
                        front_fit.get("ink"), title_font, samples, size, ppu,
                        front_fit.get("alpha"), pitch=tlead,
                        ring=(ring if fill != outline else 0.0))
                    dfill, doutline, dring = ring_by_depth(
                        image, mask, tight, [fill, outline],
                        _background(image, mask, tight), size * ppu)
                    if dring is None:
                        weight = got
                        break
                    # The depth pass sees the ring from the outside in, which is a
                    # stronger reading of which paint IS the ring than a
                    # one-pixel-deep boundary count — so it also settles the
                    # fill/outline order the vector left ambiguous.
                    fill, outline = dfill, doutline
                    if abs(dring - ring) < 0.002 and got == weight:
                        ring = dring
                        break
                    ring, weight = dring, got
                if size and weight != used_weight:
                    # The loop ran out of passes (or stopped on the ring) with
                    # the weight still moving, so the size in hand was fitted
                    # against a cut that is not the one being pinned. They only
                    # mean anything together — re-solve it at the answer.
                    used_weight = weight
                    size, tgrade, tnote, ctx, tlead = fit_title_size(
                        mask, image, tbox, ppu, ox, oy, title_font, samples,
                        (t[0].get("color") or fill), ring=ring, weight=weight,
                        fit_out=front_fit,
                        owner_leading=(cfg.get("title_style") or {}).get("leading"))
                if fill and outline:
                    ts["fill"], ts["outline"] = fill, outline
                    if fill == outline and confidence.get(
                            "title_style.fill") in ("high", "medium"):
                        # The vector offered two paints and the render shows only
                        # one of them. Say so — it is a real reading (that is what
                        # this title prints) but a weaker one than "two paints,
                        # and here is which encloses which".
                        confidence["title_style.fill"] = "medium"
                        confidence["title_style.outline"] = "medium"
                        notes.append(
                            "title: the design names two paints for this title "
                            "but only one of them survives into the artwork, so "
                            "the title is drawn in that one with no ring. If the "
                            "original really does have an outline here, it is "
                            "hidden underneath and has to be set by eye.")
                if size and fill and outline:
                    outline_w = 0.0 if fill == outline else ring
                if outline_w is not None:
                    ts["outline_w"] = outline_w
                    # Measured off the artwork's own depth profile rather than
                    # inferred from whichever colour path happened to run, so it
                    # is as good as the size it is expressed against.
                    confidence["title_style.outline_w"] = (
                        "high" if (size and fill and outline) else "low")
                else:
                    notes.append("title: ring thickness (outline_w) could not be "
                                 "measured — set it by eye against the original.")
                    confidence["title_style.outline_w"] = "none"
                # Flat unless the title genuinely curves. This USED to be left out
                # as "a visual call", but title_style is validated as a WHOLE and a
                # blob missing one field is rejected entirely — so omitting arch
                # silently discarded the fill, outline and ring width measured just
                # above it, and the template went on reporting itself as never
                # calibrated even though detection had succeeded.
                #
                # The default is the theme's OWN arch, not zero — the same way
                # the shadow one line below already inherits. Nothing here
                # MEASURES the curve, so writing a flat 0.0 over a template the
                # owner had curved is not a reading, it is an erasure: pressing
                # "detect again" straightened סיישל's graffiti title, whose
                # design plainly arcs (its top line's ink sits 44px higher in
                # the middle than at its ends, on a 138px block), and nothing
                # said so. A knob a pass cannot measure must be left as it was.
                ts.setdefault("arch", float((cfg.get("title_style") or {})
                                            .get("arch") or 0.0))
                confidence.setdefault("title_style.arch", "low")
                # The shadow is read AFTER the size, because it is measured as a
                # displacement in units of the type size.
                shadow = detect_shadow(image, mask, tight, fill, outline,
                                       _background(image, mask, tight),
                                       (size or 0) * ppu)
                if shadow is None:
                    ts.setdefault("shadow", bool((cfg.get("title_style") or {})
                                                 .get("shadow", False)))
                    confidence.setdefault("title_style.shadow", "none")
                else:
                    ts["shadow"] = bool(shadow)
                    confidence["title_style.shadow"] = "medium"
                # ALIGNMENT, per front. Every other title knob is one deck-wide
                # answer, and alignment looked like one too until the owner put
                # טוקיו's preview beside its original: its eight fronts carry the
                # same two lines aligned RIGHT on four of them and LEFT on the
                # other four, and one answer prints four cards wrong whichever
                # one it is. So each front is read on its own artwork; the
                # deck-wide value is the commonest of those readings, and it is
                # what a front whose own reading was not decisive falls back to.
                per_align = _front_alignments(theme_key, cfg, recipe, single,
                                              workdir, (mask, tight))
                align = _majority_alignment(per_align)
                if align:
                    ts["align"] = align
                    confidence["title_style.align"] = "medium"
                    odd = {str(k): v for k, v in per_align.items()
                           if v and v != align}
                    if odd:
                        ts["front_align"] = odd
                        confidence["title_style.front_align"] = "medium"
                        notes.append(
                            "align: this deck does not align its title the same "
                            "way on every front — "
                            + ", ".join(f"{k}:{v}" for k, v in sorted(odd.items()))
                            + f" against {align} elsewhere. Check those fronts in "
                            "the preview.")

                # --- the fitted size, and the synthetic-bold weight -----------
                record("size", size, tgrade, tnote)
                # The LEADING that size was measured with. It travels with the
                # size and never without it: the two are one reading of one
                # block of ink, and a size pinned without its spacing prints the
                # right type stacked at the wrong step — which is the defect
                # this pair was introduced to fix. Graded with the size for the
                # same reason, so a size the owner is asked to check comes with a
                # spacing flagged the same way, and the low-confidence drop takes
                # them out together.
                #
                # PER SURFACE, exactly like the size it belongs to — and then
                # coupled back together at the end of the pass, but only where
                # the ink says the surfaces are one block reused at several
                # scales (``couple_leadings``). Assuming they always are is
                # wrong: tarifa's back stacks its two lines a third further
                # apart than its front does, and fitting it at the front's
                # spacing put its size 21% over the Canva value it had been
                # matching to 2%.
                if size is not None:
                    record("leading", tlead, tgrade, None)

                    def _write_front(new_size, new_lead):
                        out["title_style"]["size"] = new_size
                        out["title_style"]["leading"] = new_lead

                    surface_fits.append(("front", front_fit, _write_front))
                if size and weight:
                    # A VARIABLE face's own cut comes first, because it is a
                    # real weight the file already carries and the synthetic
                    # stroke below is a fake one — reaching for the fake while
                    # eight real cuts sit unused in the same file is how a Bold
                    # design printed Thin. Already solved beside the size above,
                    # because neither is a reading on its own.
                    ts["font_weight"] = weight
                    confidence["title_style.font_weight"] = "medium"
                if size and fwnote:
                    # Said whether the cut was pinned or refused: a variable face
                    # left on the file's default is the defect the owner sees,
                    # and she cannot check a choice she is never told about.
                    notes.append(fwnote)
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
                        # At the leading the block was fitted at, not the
                        # renderer's own: the candidate has to be the same
                        # PICTURE as the original for its strokes to be
                        # comparable with the original's.
                        bold, bold_w, bnote = fit_bold(
                            mask, ctx[0], title_font, samples, size, ppu,
                            ctx[1], pitch=tlead, weight=weight)
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
                    word_surfaces(theme_key, cfg, recipe, single, workdir,
                                  (mask, image, wslots, ppu, ox, oy)),
                    config.resolve_word_font(theme_key), sample_words(cfg))
                if wnote:
                    notes.append(wnote)
                out["word_size"] = wsize
                confidence["word_size"] = wgrade or "none"
            if not t:
                notes.append("title: no card in the recipe carries a title slot.")
        else:
            notes.append("fronts: filled/clean pair or recipe missing, skipped.")

        # The ring the fronts just measured, as a fraction of the type size. It
        # is a DECK-wide knob (docs/card-structure-schema.md), so the board and
        # back titles are painted with it too and their sizes must be fitted
        # with it. 0.0 when the fronts said there is no ring, or could not be
        # read at all — which is the ringless fit these surfaces always got.
        deck_ring = out["title_style"].get("outline_w") or 0.0
        # The variable face's cut, likewise deck-wide: one text box reused at
        # several scales is one CUT at several scales, so the board and back
        # sizes must be fitted against the same instance the fronts pinned —
        # otherwise their widths are measured against a face that sets to a
        # different length and the error lands on their size. None for a static
        # face, which is every other shipped template.
        deck_weight = out["title_style"].get("font_weight")

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
                board_fit = {}
                bsize, bgrade, bnote, _bctx, blead = fit_title_size(
                    mask, image, units(box, ppu, ox, oy), ppu, ox, oy,
                    title_font, samples, fill, ring=deck_ring,
                    weight=deck_weight, fit_out=board_fit,
                    owner_leading=render_page.board_leading(
                        cfg.get("title_style") or {}))
                record("board_size", bsize, bgrade, bnote)
                if bsize is not None:
                    record("board_leading", blead, bgrade, None)

                    def _write_board(new_size, new_lead):
                        out["title_style"]["board_size"] = new_size
                        out["title_style"]["board_leading"] = new_lead

                    surface_fits.append(("board", board_fit, _write_board))
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
        #
        # A template whose eight styles each have their OWN back (#315) is
        # measured ONCE PER BACK. The knobs the fronts share (paints, ring,
        # alignment) genuinely are one deck-wide answer, but the back's title BOX
        # is not: each back is separate artwork, so the name may sit somewhere
        # else on each — or on none of them. Measuring one and repeating it is
        # how seven cards in eight get the name in the wrong place.

        def measure_back(kf, kc, label, fit_out=None):
            """One back's slot — ``(slot|None, size, grade, note, leading)``.

            ``label`` prefixes this back's notes and confidence keys so a deck
            with eight of them says WHICH one it could not read.
            """
            mask, image, vb = _diff(kf, kc, workdir)
            w, h = mask.size
            if single:
                cells = [(0.0, 0.0, float(w), float(h))]
            else:
                recipe = json.load(open(recipe_path, encoding="utf-8"))
                ppu = w / vb[2]
                cells = [tuple(v * ppu for v in card["cell"])
                         for card in recipe["cards"] if card]
            for cx0, cy0, cx1, cy1 in cells:
                region = _shrink_to_clean_border(
                    mask, (int(cx0), int(cy0), int(cx1), int(cy1)))
                box = _bbox(mask, region)
                if not box or not _plausible(box, region):
                    continue
                cw, ch = cx1 - cx0, cy1 - cy0
                # Prefer the paints named by the vector source; the backs sheet
                # carries ONLY the title, so nothing needs excluding — except
                # the artwork the title is drawn ON, which the export re-emits
                # inside the personalized layer and which no title is painted in.
                bg = artwork_around(image, mask, box)
                fill, outline = assign_paints(
                    drop_background(candidate_paints(kf, kc), bg),
                    image, mask, box)
                if fill and outline and fill != outline:
                    # Settle WHICH of the two is the ring by how deep each sits,
                    # the same reading the fronts get. It matters as much here:
                    # the back is drawn with the ring width the fronts measured,
                    # so a title whose two paints are the wrong way round paints
                    # its fill in the colour that was meant to enclose it — and
                    # on bachelorette that colour is the back's own background.
                    dfill, doutline, _dring = ring_by_depth(
                        image, mask, box, [fill, outline],
                        bg or _background(image, mask, box), None)
                    if dfill and doutline:
                        fill, outline = dfill, doutline
                if not (fill and outline):
                    fill, outline, _ = _fill_and_outline(image, mask, box)
                if fill and outline:
                    confidence[label + ".colors"] = "high" if fill != outline else "low"
                else:
                    fill = outline = fill or _dominant_color(image, mask, box)
                    notes.append(label + ": the title box is measured, but its two "
                                 "paints could not be told apart — fill and "
                                 "outline are both set to the dominant ink colour "
                                 "and need confirming.")
                    confidence[label + ".colors"] = "low"
                slot = {
                    "frac": {"x0": round((box[0] - cx0) / cw, 4),
                             "y0": round((box[1] - cy0) / ch, 4),
                             "x1": round((box[2] - cx0) / cw, 4),
                             "y1": round((box[3] - cy0) / ch, 4)},
                    "fill": fill, "outline": outline,
                }
                # The back's title is its own surface with its own box, so it
                # gets its own size — pinning the front's here would size the
                # back title to a box it was never measured against. Its own
                # LEADING to begin with, and for the same reason; whether that
                # spacing is really its own or the front's block reused is then
                # asked of the ink rather than assumed, once every surface has
                # been read (``couple_leadings``).
                bppu, box_, boy = _viewport(mask, vb)
                size, grade, note, _bctx, lead = fit_title_size(
                    mask, image, units(box, bppu, box_, boy), bppu, box_, boy,
                    title_font, samples, fill, ring=deck_ring,
                    weight=deck_weight, fit_out=fit_out,
                    owner_leading=render_page.back_leading(
                        cfg.get("title_style") or {}))
                return slot, size, grade, note, lead
            return None, None, None, None, None

        def back_pair(index):
            """The filled/clean pair for one back, sheet or single-card."""
            if single:
                return (config.card_path(theme_key, index, filled=True),
                        config.card_path(theme_key, index))
            return sheet("backs", "filled"), sheet("backs", "clean")

        def unreadable(label):
            notes.append(label + ": could not isolate a title — this design may "
                         "carry no title on the card back (several don't), or "
                         "its filled and clean backs differ across the whole "
                         "surface.")

        # Distinct backs, in printing order. A one-back deck yields exactly one,
        # so it takes the SAME path and writes the same `back` blob it always did.
        back_list = list(dict.fromkeys(config.back_indices(cfg))) if single else [None]
        paired = single and config.has_per_front_backs(cfg)
        if paired:
            out["backs"] = {}
        for bi in back_list:
            label = f"backs.{bi}" if paired else "back"
            kf, kc = back_pair(bi)
            if not (os.path.exists(kf) and os.path.exists(kc)
                    and (single or os.path.exists(recipe_path))):
                notes.append(label + ": filled/clean pair or recipe missing, skipped.")
                confidence[label] = "none"
                if paired:
                    out["backs"][str(bi)] = None
                continue
            back_fit = {}
            slot, size, grade, note, lead = measure_back(kf, kc, label, back_fit)
            confidence[label + ".frac"] = "high" if slot else "none"
            if not slot:
                unreadable(label)
            if paired:
                # Each back's size belongs to that back: eight separately drawn
                # backs give the title eight different rooms, and one shared pin
                # fits only the box it was measured against. Its spacing goes
                # with it — the size was fitted at that spacing and means
                # nothing away from it.
                if slot and size is not None:
                    slot["size"] = size
                    if lead is not None:
                        slot["leading"] = lead

                    def _write_paired(new_size, new_lead, slot=slot):
                        slot["size"] = new_size
                        slot["leading"] = new_lead

                    surface_fits.append((label, back_fit, _write_paired))
                if note:
                    notes.append(note)
                confidence[label + ".size"] = grade if size is not None else "none"
                out["backs"][str(bi)] = slot
            else:
                record("back_size", size, grade, note)
                if size is not None:
                    record("back_leading", lead, grade, None)

                    def _write_back(new_size, new_lead):
                        out["title_style"]["back_size"] = new_size
                        out["title_style"]["back_leading"] = new_lead

                    surface_fits.append(("back", back_fit, _write_back))
                out["back"] = slot

        # Every surface has now been read on its own. Ask the ink whether they
        # are one block used at several scales, and where they are, answer with
        # one spacing rather than three — BEFORE the confidence drop, so that a
        # size the coupling re-solves is the one that drop and the carry-forward
        # see.
        couple()

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
                # A snap detection REFUSED is the one thing the owner has to
                # know about this geometry, and it used to exist only as a log
                # line on the container: grapefruit's even-spacing snap declined
                # on every run, detection still reported success, and the card
                # kept coming back with uneven lines for no visible reason. Say
                # it here, where the form already shows what to check, and grade
                # the geometry down so it is flagged rather than presented as a
                # confident reading.
                for message in _declined_snaps(cfg):
                    confidence["card_slots"] = "low"
                    notes.append(
                        "card_slots: detection did NOT regularise this — "
                        + message
                        + ". The geometry below is the raw measurement, so "
                        "check the spacing on the preview before saving.")
            else:
                notes.append("card_slots: no single-card recipe detected yet, so "
                             "the form opens on its defaults. Re-run detection "
                             "for this template.")

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
        # AFTER the drop, never before: a value this pass declined to write is
        # exactly the gap the guard exists to fill.
        _carry_forward(out, cfg, notes, confidence)
        # Reported last so it reflects what actually survived both passes.
        unset = [name for name in ("size", "board_size", "back_size")
                 if name not in out["title_style"]]
        if unset:
            notes.append(", ".join(unset) + " left unset — the renderer auto-fits "
                         "the title to its box; pin one only if that over- or "
                         "under-shoots.")
        out["confidence"] = confidence
        out["notes"] = notes
        return out
    finally:
        if own:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)


def _declined_snaps(cfg):
    """The regularisations detection refused for this template, if any.

    Recorded by ``recipe_diff.regularise_word_slots`` into the recipe's
    ``declined`` list. Absent on a clean detection, and absent entirely on a
    recipe written before this was recorded — both mean "nothing to report", so
    the caller says nothing rather than inventing reassurance.
    """
    try:
        recipe = config.load_recipe(cfg.get("recipe"))
    except Exception:
        return []
    out = recipe.get("declined")
    return [m for m in out if isinstance(m, str)] if isinstance(out, list) else []


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
        backs = blob.get("backs")
        if isinstance(backs, dict):
            # A paired deck has no single back to report yes/no about; what the
            # owner needs to know is how many of the eight were actually read.
            got = sum(1 for v in backs.values() if v)
            back_state = f"{got}/{len(backs)} backs"
        else:
            back_state = "yes" if blob.get("back") else "no"
        print(f"calibrated {args.theme!r}: "
              f"board={'yes' if blob.get('board') else 'no'} "
              f"back={back_state} "
              f"title_fill={ts.get('fill') or '-'} -> {args.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
