#!/usr/bin/env python3
"""Register a clean plate onto its filled twin when Canva exported them apart.

``recipe_diff`` measures a card by subtracting the clean plate from the filled
one: what is left is the personalized text and nothing else. That only holds
while the two plates draw the artwork at the SAME size. Four of the owner's
decks (מרקאנה, סיישל, פריז, קליפורניה) ship a ``clean/9.svg`` Canva exported
from a different layout pass than its ``filled/9.svg`` twin — viewBox
224.25x311.999995 against 223.92x312, artwork matrix 0.747953 against 0.749732,
and the path coordinates inside scaled to match. Both are drawn into the same
299x416 window, so ``filled - clean`` came out as the whole design ghosted
against itself: every high-contrast edge — the card border, the bunting, the
footballs — survived as a hairline, the row profile never dropped to zero, and
the eight word/title bands collapsed into ONE band spanning the page. Detection
returned "no text measured" and מרקאנה's front 9 fell back to the box its
siblings agree on, printing the honoree's name at the TOP of a card whose design
puts it at the foot.

The fix is not a threshold and not a raster search. The two plates state their
own geometry, and they draw the SAME shapes: match those shapes across the two
files and the similarity between the plates falls out as arithmetic. Rendering
the clean plate through that similarity — as a transform Chrome rasterises,
never a resample of a finished PNG, which would re-introduce exactly the blur
being fought — puts the two plates back in register, and the diff is the text
again.

Two properties this leans on, both true of every Canva card export in the store:

  * the plates differ by a SIMILARITY (one uniform scale plus a translation).
    Canva never rotates or shears a page between exports; it re-lays it out at a
    slightly different scale.
  * the artwork is drawn as ``<path d="...">`` with absolute M/L/C/Z commands,
    so a path's outline in user units is recoverable by composing its ancestors'
    transforms — no font metrics, no rasteriser, no browser needed.

Nothing here runs for a pair whose plates already agree: ``recipe_diff`` only
asks after ``viewbox_mismatch`` has said they do not, so every deck that renders
correctly today renders byte-for-byte identically.
"""
import math
import re
import xml.etree.ElementTree as ET

# Every coordinate in a Canva path, in order. The exports use only absolute
# M/L/C/Z, so the numbers are x,y pairs and nothing else — an arc or a relative
# command would break that assumption, and ``_points`` refuses a path carrying
# one rather than measuring a shape that is not there.
_NUM = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")
_ABSOLUTE_ONLY = re.compile(r"^[MLCZ0-9eE\s.,+-]*$")

# How far the derived similarity may stray before it is refused as nonsense
# rather than applied. The real artifact is 0.24% of scale and half a user unit
# of shift; 5% of scale and 5% of the card are orders of magnitude beyond that,
# so they only ever trip on a pair that is not the same design at all — which
# must fall through to ``viewbox_mismatch``'s "re-export this plate", not be
# silently warped into agreement.
_MAX_SCALE_DRIFT = 0.05
_MAX_SHIFT_FRAC = 0.05

# A similarity closer to identity than this changes nothing a rasteriser can
# see: over a 416px window, 1e-5 of scale is four thousandths of a pixel.
_IDENTITY_EPS = 1e-5

# Shapes small enough that their bounding box pins the scale poorly are used to
# CONFIRM a reading, never to make one: the estimate comes from the shapes at
# least a quarter the size of the largest matched one, and is then required to
# predict this many shapes overall. Three is the smallest number that cannot be
# a coincidence between two unrelated pairs of boxes.
_BIG_FRAC = 0.25
_MIN_AGREE = 3

# How closely a matched shape must land where the estimate predicts, in user
# units, to count as agreeing with it. A tenth of a unit is a thirtieth of a
# millimetre on these cards — tight enough that a wrongly paired shape fails it,
# loose enough to absorb the rounding Canva prints its coordinates at.
_AGREE_TOL = 0.1


def _mul(A, B):
    """The SVG matrix product ``A x B`` on ``[a, b, c, d, e, f]`` sextuples."""
    a1, b1, c1, d1, e1, f1 = A
    a2, b2, c2, d2, e2, f2 = B
    return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1]


def parse_transform(text):
    """One ``transform`` attribute as a matrix sextuple.

    Handles the four forms Canva emits (``matrix``, ``translate``, ``scale``,
    ``rotate``); anything else is skipped rather than guessed at, which at worst
    costs a shape its match and never invents a wrong one.
    """
    m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    for name, args in re.findall(
            r"(matrix|translate|scale|rotate)\s*\(([^)]*)\)", text or ""):
        v = [float(x) for x in _NUM.findall(args)]
        if name == "matrix" and len(v) >= 6:
            t = v[:6]
        elif name == "translate" and v:
            t = [1.0, 0.0, 0.0, 1.0, v[0], v[1] if len(v) > 1 else 0.0]
        elif name == "scale" and v:
            t = [v[0], 0.0, 0.0, v[1] if len(v) > 1 else v[0], 0.0, 0.0]
        elif name == "rotate" and v:
            r = math.radians(v[0])
            t = [math.cos(r), math.sin(r), -math.sin(r), math.cos(r), 0.0, 0.0]
        else:
            continue
        m = _mul(m, t)
    return m


def _points(d, m):
    """One path's coordinates in user units, or ``[]`` when it cannot be read."""
    if not _ABSOLUTE_ONLY.match(d):
        return []
    v = [float(x) for x in _NUM.findall(d)]
    return [(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
            for x, y in zip(v[0::2], v[1::2])]


def shapes(svg_path):
    """Every drawn path in one SVG, as point lists in the file's user units.

    ``defs`` and ``clipPath`` are skipped deliberately: their geometry is not
    ink, and on the affected plates the clip rectangles are rounded to the
    drawing's bounds rather than the page's, so they do NOT correspond between
    the two exports — pairing them would pull the estimate off by a unit.
    """
    try:
        root = ET.parse(svg_path).getroot()
    except (ET.ParseError, OSError):
        return []
    out = []

    def walk(node, m):
        tag = node.tag.split("}")[-1]
        if tag in ("defs", "clipPath"):
            return
        t = node.get("transform")
        m2 = _mul(m, parse_transform(t)) if t else m
        if tag == "path" and node.get("d"):
            pts = _points(node.get("d"), m2)
            if pts:
                out.append(pts)
        for child in node:
            walk(child, m2)

    walk(root, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    return out


def bbox(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def _signature(points):
    """What makes a shape findable in the other plate, whatever its scale.

    The point COUNT and the bounding box's aspect ratio: both survive a uniform
    scale and a shift, and together they are specific enough that the artwork's
    shapes pair up one-to-one while the filled plate's extra glyph outlines pair
    with nothing. Only signatures unique in BOTH files are used, so an ambiguous
    match is dropped rather than resolved by guesswork.
    """
    x0, y0, x1, y1 = bbox(points)
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return None
    return len(points), round(w / h, 3)


def _pairs(clean_shapes, filled_shapes):
    """Shapes present exactly once in each plate, as ``(clean, filled)`` boxes."""
    def index(all_shapes):
        out = {}
        for pts in all_shapes:
            sig = _signature(pts)
            if sig:
                out.setdefault(sig, []).append(pts)
        return out

    ci, fi = index(clean_shapes), index(filled_shapes)
    return [(bbox(ci[s][0]), bbox(fi[s][0]))
            for s in ci if s in fi and len(ci[s]) == 1 and len(fi[s]) == 1]


def _median(values):
    values = sorted(values)
    n = len(values)
    return values[n // 2] if n % 2 else (values[n // 2 - 1] + values[n // 2]) / 2.0


def similarity(clean_shapes, filled_shapes):
    """``(scale, tx, ty)`` mapping clean user units onto filled ones, or None.

    Each paired shape gives the whole answer on its own — the ratio of the two
    bounding boxes is the scale, and where the clean box lands under it is the
    shift. The estimate is the median over the BIG shapes, because a box a
    quarter of the card wide pins a 0.24% scale to five digits where a 2-unit
    confetti squiggle pins it to two; it is then required to predict at least
    ``_MIN_AGREE`` of the paired shapes to within ``_AGREE_TOL``, which is what
    separates "the same artwork, re-scaled" from "two shapes that happened to
    have the same point count".
    """
    pairs = _pairs(clean_shapes, filled_shapes)
    if len(pairs) < _MIN_AGREE:
        return None
    sized = []
    for (cx0, cy0, cx1, cy1), (fx0, fy0, fx1, fy1) in pairs:
        cw, ch = cx1 - cx0, cy1 - cy0
        if cw <= 0 or ch <= 0:
            continue
        scale = ((fx1 - fx0) / cw + (fy1 - fy0) / ch) / 2.0
        sized.append((max(cw, ch), scale, fx0 - scale * cx0, fy0 - scale * cy0))
    if not sized:
        return None
    floor = _BIG_FRAC * max(s[0] for s in sized)
    big = [s for s in sized if s[0] >= floor]
    scale = _median([s[1] for s in big])
    tx = _median([s[2] for s in big])
    ty = _median([s[3] for s in big])
    agree = 0
    for (cx0, cy0, _cx1, _cy1), (fx0, fy0, _fx1, _fy1) in pairs:
        if (abs(scale * cx0 + tx - fx0) <= _AGREE_TOL
                and abs(scale * cy0 + ty - fy0) <= _AGREE_TOL):
            agree += 1
    if agree < _MIN_AGREE:
        return None
    return scale, tx, ty


def viewport(vb, w, h):
    """``(ppu, ox, oy)`` for ``preserveAspectRatio="xMidYMid meet"``, in CSS px.

    The same mapping ``recipe_diff.viewport`` computes, at scale 1 — this module
    works in the SVG's own pixel space because that is the space the wrapper it
    writes lives in, and the caller re-derives the screenshot mapping itself.
    """
    ppu = min(w / vb[2], h / vb[3])
    return ppu, (w - vb[2] * ppu) / 2.0, (h - vb[3] * ppu) / 2.0


def registration(filled_dims, clean_dims, filled_svg, clean_svg):
    """The transform that draws the clean plate into the filled plate's pixels.

    ``(scale, dx, dy)`` in the filled plate's CSS pixel space, or ``None`` when
    the two plates share too little artwork to be registered — in which case the
    caller must fall back to reporting the mismatch, never to a guess.

    Returns ``None`` for a correction too small to matter as well, so a pair that
    merely rounds its viewBox differently is rendered exactly as it is today.
    """
    fw, fh, fvb = filled_dims
    cw, ch, cvb = clean_dims
    got = similarity(shapes(clean_svg), shapes(filled_svg))
    if not got:
        return None
    scale, tx, ty = got
    if abs(scale - 1.0) > _MAX_SCALE_DRIFT:
        return None
    if (abs(tx) > _MAX_SHIFT_FRAC * fvb[2]
            or abs(ty) > _MAX_SHIFT_FRAC * fvb[3]):
        return None
    fppu, fox, foy = viewport(fvb, fw, fh)
    cppu, cox, coy = viewport(cvb, cw, ch)
    # clean px -> clean units -> filled units -> filled px, composed.
    a = fppu * scale / cppu
    dx = fppu * tx + fox - a * cox
    dy = fppu * ty + foy - a * coy
    if (abs(a - 1.0) <= _IDENTITY_EPS
            and abs(dx) <= _IDENTITY_EPS and abs(dy) <= _IDENTITY_EPS):
        return None
    return a, dx, dy


def wrap(svg_text, reg, width, height):
    """The clean plate re-drawn through ``reg``, as a standalone SVG document.

    The original document is NESTED whole rather than edited: an inner ``<svg>``
    establishes its own viewport and resolves its own ids, clip paths and
    gradients exactly as it does standing alone, so the only thing that changes
    is where its pixels land. Rewriting the outer element's viewBox and splicing
    a transform around its children would have to reason about which of its
    defs are in user space — this does not.
    """
    a, dx, dy = reg
    # A prologue is legal at the top of a document and illegal inside one, so it
    # goes: an XML declaration or a DOCTYPE left in place would make the nested
    # copy unparseable and Chrome would screenshot an error page, which the diff
    # would then read as a card's worth of "text".
    inner = re.sub(r"^\s*(<\?xml[^>]*\?>|<!DOCTYPE[^>]*>)+", "", svg_text).lstrip()
    return ('<svg xmlns="http://www.w3.org/2000/svg" '
            'xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}">'
            f'<g transform="matrix({a:.9f},0,0,{a:.9f},{dx:.6f},{dy:.6f})">'
            f'{inner}</g></svg>')
