#!/usr/bin/env python3
"""Clean up mis-registered "sticker outline" discs in a Canva-exported board SVG.

Some Canva board exports (e.g. birthday-boys-basketball) draw each game tile as a
red outline disc *behind* a white tile disc. But the export's red shape is a messy
vector outline: offset a couple of viewBox units from the white tile, of uneven
thickness, and often emitted twice with a small offset between the copies.
Rendered, every tile shows a red crescent / doubled ring that reads like bad print
registration ("ghosting"). Because it all lives in the SVG geometry (viewBox
units), it scales with any render size, so raising resolution never fixes it — and
a rigid translate can't make an intrinsically lumpy outline look even.

``align_ring_discs`` replaces each red tile shape with a clean geometric
``<circle>`` concentric to its tile:

  * ring tiles  — a red disc sitting (nearly) on top of a white tile disc becomes a
    red circle centred on the white disc, a hair larger than it, so the white disc
    (drawn on top) leaves an even red border ring.
  * solid tiles — start / end / logo tiles have no white disc; the doubled red copy
    is redrawn concentric so the double edge collapses to one clean disc.

The transform is deliberately conservative: it only touches a red path that is
disc-shaped AND either sits on a white tile disc or has a near-duplicate red disc
beside it — the exact signature of the sticker-outline defect. A board without
that pattern is returned byte-for-byte unchanged, so it is safe to run on every
theme's board. Each red disc lives in the SVG as exactly
``<g clip-path="url(#ID)"><path fill="RED" .../></g>`` and is drawn *behind* its
white tile, so swapping the whole group for a same-position ``<circle>`` keeps the
paint order (white disc and number stay on top).
"""
import math
import re

RED = "#e9062a"
WHITE = "#ffffff"

# A white *tile* disc is this size range (viewBox units); excludes the full-canvas
# background rect and any tiny glyph paths.
_TILE_MIN, _TILE_MAX = 40.0, 130.0
# A red shape is only treated as a tile disc when its bbox is roughly square.
_SQUARE_LO, _SQUARE_HI = 0.8, 1.25
# How close a red disc must be to a white disc (fraction of the white diameter) to
# be treated as that tile's outline ring.
_RING_FRAC = 0.6
# Red border thickness as a fraction of the white tile radius.
_RING_BORDER = 0.08
# Two red discs within this many units (and similar size) are a doubled export.
_DUP_DIST = 10.0
_DUP_SIZE_TOL = 0.35


def _bbox(d):
    nums = [float(x) for x in re.findall(r"-?\d+\.?\d*(?:e-?\d+)?", d)]
    xs, ys = nums[0::2], nums[1::2]
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def _disc(d):
    """Return (cx, cy, w, h) for a path's bounding box, or None."""
    b = _bbox(d)
    if not b:
        return None
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, b[2] - b[0], b[3] - b[1])


def _is_square(w, h):
    return h > 0 and _SQUARE_LO <= w / h <= _SQUARE_HI


def _red_group_re(red):
    # <g clip-path="url(#ID)"><path fill="RED" ... d="..." ... /></g>
    return re.compile(
        r'(<g clip-path="url\(#[0-9a-fA-F]+\)"><path fill="'
        + re.escape(red)
        + r'"[^>]*?\bd="([^"]+)"[^>]*?/></g>)'
    )


def _white_discs(svg, white):
    out = []
    for m in re.finditer(
        r'<path fill="' + re.escape(white) + r'"[^>]*?\bd="([^"]+)"[^>]*?/>', svg
    ):
        c = _disc(m.group(1))
        if c and _TILE_MIN < c[2] < _TILE_MAX and _TILE_MIN < c[3] < _TILE_MAX and _is_square(c[2], c[3]):
            out.append(c)
    return out


def plan_circles(svg, red=RED, white=WHITE):
    """Return a list of ``(cx, cy, r, kind)`` (or ``None``) per red disc, in
    document order — the clean shape each red outline should become, or ``None`` to
    leave it untouched. ``kind`` is ``"ring"`` (a stroked outline around a white
    tile, centre left transparent so the tile + number show through regardless of
    paint order) or ``"fill"`` (a solid red disc for a start/end/logo tile). ``r``
    is the outer radius. Exposed for tests so geometry can be asserted without
    rendering.
    """
    reds = [_disc(m.group(2)) for m in _red_group_re(red).finditer(svg)]
    whites = _white_discs(svg, white)
    plan = []
    for i, r in enumerate(reds):
        if r is None or not _is_square(r[2], r[3]):
            plan.append(None)
            continue
        rx, ry, rw, rh = r
        # (a) ring tile: nearest white disc it sits on top of -> a clean ring
        # around it, centred on the white disc.
        if whites:
            w = min(whites, key=lambda w: math.hypot(rx - w[0], ry - w[1]))
            if math.hypot(rx - w[0], ry - w[1]) <= _RING_FRAC * w[2]:
                rr = (w[2] / 2) * (1 + _RING_BORDER)
                plan.append((w[0], w[1], rr, "ring"))
                continue
        # (b) solid tile: redraw a filled disc concentric on the largest
        # near-duplicate copy (collapses the doubled red edge to one disc).
        cluster = [
            o
            for j, o in enumerate(reds)
            if o is not None
            and j != i
            and math.hypot(rx - o[0], ry - o[1]) <= _DUP_DIST
            and abs(o[2] - rw) <= _DUP_SIZE_TOL * max(o[2], rw)
        ]
        if cluster:
            anchor = max([r] + cluster, key=lambda o: o[2] * o[3])
            plan.append((anchor[0], anchor[1], rw / 2, "fill"))
        else:
            plan.append(None)
    return plan


def align_ring_discs(svg, red=RED, white=WHITE):
    """Return ``svg`` with messy red tile discs replaced by clean concentric
    shapes. A board with no ring/doubled-disc pattern comes back unchanged.
    """
    groups = list(_red_group_re(red).finditer(svg))
    plan = plan_circles(svg, red=red, white=white)
    for m, shape in reversed(list(zip(groups, plan))):
        if shape is None:
            continue
        cx, cy, rr, kind = shape
        if kind == "ring":
            # A white tile disc (dia = 2*rr/(1+border)) is centred here and paints
            # on top; stroke a ring in the border band so the centre stays clear.
            border = rr * _RING_BORDER / (1 + _RING_BORDER)
            mid = rr - border / 2
            el = (
                f'<circle cx="{cx:.4f}" cy="{cy:.4f}" r="{mid:.4f}" '
                f'fill="none" stroke="{red}" stroke-width="{border:.4f}"/>'
            )
        else:
            el = f'<circle cx="{cx:.4f}" cy="{cy:.4f}" r="{rr:.4f}" fill="{red}"/>'
        svg = svg[: m.start()] + el + svg[m.end() :]
    return svg
