#!/usr/bin/env python3
"""What SHAPE is a card — and cutting the pawn card to that shape.

The pawn ("photo") card ships inside the buyer's deck, so it has to look like it
belongs there. ``card_paper`` answered that for COLOUR: the pawn card prints on
the paper of the template's own front card, measured rather than assumed. This
answers the same question for GEOMETRY, the owner's words being "the card with
the pawns should be exactly same size and roundness as the rest of the cards in
this template".

What actually differs, and what does not
---------------------------------------
The OUTER dimensions never differed and must not start: every card in a v2 deck
is drawn on the same ``0 0 223.92 312`` viewBox, the deck document inlines each
design into one shared page box (``deck_html.DeckDocument``), and the printed
page is that viewBox in points. A card's own ``width``/``height`` attributes are
not used by the deck at all. So "same size" is already true of the paper — and
``test_card_frame`` pins it so it stays true.

What differed is the FRAME: the rounded outline every one of these designs draws
just inside the card, which is the shape a buyer reads as "the card". The shared
generic pawn card (``_shared/photo-card/photo.svg``, used by every template that
ships no ``clean/photo.svg`` of its own) drew a SHARP-cornered rectangle at
grapefruit's frame box — 24.34, 22.44, 175.18 x 266.93, r = 0 — on every deck.
Measured off the shipped artwork, the real frames are:

    grapefruit                24.34, 22.44   175.18 x 266.93   r 7.50   1.50 #711d20
    bachelorette               9.14, 10.60   190.79 x 276.00   r 27.72  4.00 #6b4d56
    birthday-girls             9.14, 10.60   190.79 x 276.00   r 27.72  14.0 #ff7aa9
    birthday-boys-basketball   9.14, 10.60   190.79 x 276.00   r 27.72  14.0 #e9062a
    anniversary                9.14, 10.60   190.79 x 276.00   r 27.72  4.00 #004aad
    japanese                   9.14, 10.60   190.79 x 276.00   r 27.72  6.00 #d42a2a
    trip comeback              9.14, 10.60   190.79 x 276.00   r 27.72  12.0 #7dac9b

Two radii — 7.5 and 27.7 — over eight shipped designs, and the six that share a
radius are the ones cut from one Canva master. **One shared photo.svg therefore
cannot match them all**, which is why this is applied at COMPOSITION time, per
deck, instead of being drawn into the file. The artwork only has to mark which
element is its frame (``class="card-frame"``); the geometry is the deck's.

Read off the VECTOR, not a render
---------------------------------
Unlike the paper colour, this needs no browser. A frame is a STROKED outline
(``fill="none"`` plus a ``stroke``) spanning most of the card — the same test
``render_page.frame_box`` already uses to find the printed frame for word
layout, and the same transform-resolving reader, reused here rather than
rewritten. Two differences, both deliberate:

  * ``frame_box`` answers with the frame's INTERIOR (it is deciding how much
    paper the words may use, so it takes the whole stroke off each side). This
    answers with the stroke's CENTRELINE plus its width, because the pawn card
    has to redraw the same stroke in the same place, not sit inside it.
  * ``frame_box`` requires the frame to be INSET from the card edge. That is
    right for text, and wrong here: six of the eight shipped designs draw their
    frame flush with the trim, and rejecting those would no-op the fix on
    exactly the templates that need it. A full-bleed FILLED rect is still never
    mistaken for a frame — it has no stroke.

The path reader is the one thing that is genuinely new, and it is new because a
coordinate-pair reading of ``d`` gets the radius WRONG. Canva writes a rounded
corner as a cubic, and a cubic's control point sits on the same horizontal as
the corner's on-curve point: reading every number in ``d`` as a point reports
grapefruit's radius as 3.36 instead of 7.50, because the control point at
0.4477 x r looks like the start of the top edge. So ``_on_curve`` walks the path
commands and keeps only the points the curve actually passes through.

Refusing beats guessing
-----------------------
Everything here degrades to "leave the pawn card exactly as it shipped":
a template with no measurable frame, a pawn card that marks none, a frame that
would not contain the card's own pawns and copy. An unmeasurable shape must
never cost a customer their deck — and a frame drawn THROUGH the pawn grid is
worse than one that merely does not match.
"""
import hashlib
import os
import re
import sys

import config

# How much of the card a stroked outline must span to be its frame. Same figure
# render_page uses; a decoration is a fraction of the card wide, a frame is not.
FRAME_MIN_SPAN = 0.50

# How far past the card edge a frame may reach and still be one, as a fraction of
# the card. A frame drawn at the trim rounds to the edge and its stroke is
# centred on it, so a little overhang is the normal case, not a red flag.
FRAME_MAX_OVERHANG = 0.02

# Two frames within this many card units of each other are the same frame
# (0.05 units is 0.014 mm — a hundredth of a printer dot). Below it, rewriting
# the artwork would churn the file to redraw a line in the same place.
FRAME_TOL = 0.05

# How far the sticker halo spreads past a slot: feMorphology dilates 2.4 and the
# drop shadow blurs a little past that (docs/photo-card.md, "The sticker").
HALO = 3.0

_FRAME_CLASS = "card-frame"
_RULE_CLASS = "card-frame-rule"

_ATTR_OF = lambda el, name: (  # noqa: E731 - a one-liner reader, not a policy
    (re.search(r'\b%s\s*=\s*"([^"]*)"' % re.escape(name), el) or [None, None])[1]
)

# The class must be a whole token: ``\bcard-frame\b`` also matches
# ``card-frame-rule``, which is a different element with the opposite job.
_CLASS = r'class="(?:[^"]*\s)?%s(?:\s[^"]*)?"'
# A ``<rect>`` specifically. The frame is redrawn by SETTING ATTRIBUTES, so it
# has to be a shape whose geometry is its attributes; an outlined path would have
# to be re-emitted, and a pawn card is hand-authored, so it can simply use a rect.
_FRAME_EL = re.compile(r'<rect\b[^>]*\b%s[^>]*/\s*>' % (_CLASS % _FRAME_CLASS))
_RULE_EL = re.compile(r'<path\b[^>]*\b%s[^>]*/\s*>' % (_CLASS % _RULE_CLASS))
_SELF_CLOSE = re.compile(r"\s*/\s*>\s*$")
_SLOT_EL = re.compile(r'<image\b[^>]*\bid="photo-slot-[1-9]"[^>]*/\s*>')

# Path commands and how many numbers each takes. "Z" takes none and returns to
# the subpath start, which is a real on-curve point.
_CMD = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)")
_NUM = re.compile(r"-?\d*\.?\d+(?:[eE][-+]?\d+)?")
_ARGC = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7,
         "Z": 0}
# Which of a command's numbers is its END point — the point the curve passes
# through. Everything before it is a control point and must not be read as
# geometry (see the module docstring: this is what the radius depends on).
_ENDPOINT = {"M": 0, "L": 0, "C": 4, "S": 2, "Q": 2, "T": 0, "A": 5}

_cache = {}


def _warn(message):
    print("card_frame: " + message, file=sys.stderr)


def _on_curve(d):
    """The points a path passes THROUGH, in order, or None if it cannot be read.

    Control points are dropped — reading them as geometry is what makes a
    coordinate-pair parse report the wrong corner radius (module docstring).
    Arcs are read for their endpoint only; their bulge is not part of any frame
    we measure, and a template that draws one gets a slightly tight box rather
    than a wrong one.
    """
    if not d:
        return None
    pts = []
    cur = start = (0.0, 0.0)
    for cmd, argtext in _CMD.findall(d):
        upper, relative = cmd.upper(), cmd.islower()
        argc = _ARGC[upper]
        if argc == 0:                       # Z — back to where this subpath began
            cur = start
            pts.append(cur)
            continue
        values = [float(v) for v in _NUM.findall(argtext)]
        if not values or len(values) % argc:
            return None                     # ragged arguments: do not guess
        for i in range(0, len(values), argc):
            args = values[i:i + argc]
            if upper == "H":
                point = (cur[0] + args[0] if relative else args[0], cur[1])
            elif upper == "V":
                point = (cur[0], cur[1] + args[0] if relative else args[0])
            else:
                j = _ENDPOINT[upper]
                point = (args[j], args[j + 1])
                if relative:
                    point = (cur[0] + point[0], cur[1] + point[1])
            cur = point
            pts.append(point)
            if upper == "M":
                start = point
    return pts or None


def _corner_radius(xs, ys, box):
    """How far in from the corner the straight top/left edge begins.

    A rounded rectangle's top edge runs from ``x0 + r`` and its left edge from
    ``y0 + r``, so either one answers, and the SMALLER is taken: a shape that is
    not a rounded rectangle (a wavy border, a torn edge) then reports a small
    radius rather than a fictitious large one. Sharp corners put a point at the
    corner itself and answer 0, which is the truth.
    """
    tol = FRAME_TOL
    top = [x for x, y in zip(xs, ys) if abs(y - box[1]) <= tol]
    left = [y for x, y in zip(xs, ys) if abs(x - box[0]) <= tol]
    candidates = []
    if top:
        candidates.append(min(top) - box[0])
    if left:
        candidates.append(min(left) - box[1])
    return max(0.0, min(candidates)) if candidates else 0.0


def frame(svg_text, cell):
    """The card's printed frame, or None when it draws none.

    ``cell`` is the card, ``[x0, y0, x1, y1]``. The answer is the stroke's
    CENTRELINE box plus how it is painted::

        {"x", "y", "w", "h", "r", "stroke", "stroke_width"}

    all in card units, so a caller can redraw the same stroke in the same place.
    The INNERMOST qualifying outline wins (smallest bottom), matching
    ``render_page.frame_box``: a design that draws two borders means the inner.
    """
    # Imported here, not at module scope: render_page imports THIS module to
    # compose the pawn card, so a top-level import each way is a cycle. By the
    # time anything calls in, render_page is fully loaded.
    import render_page as rp

    if not svg_text or not cell:
        return None
    x0c, y0c, x1c, y1c = cell
    w, h = x1c - x0c, y1c - y0c
    if w <= 0 or h <= 0:
        return None
    slack_x, slack_y = FRAME_MAX_OVERHANG * w, FRAME_MAX_OVERHANG * h
    body = rp._DEFS_BLOCK.sub("", svg_text)
    stack = [rp._IDENTITY]
    best = None
    for m in rp._GEOM_TAG.finditer(body):
        close, name, attrs, selfclose = m.groups()
        if name == "g":
            if close:
                if len(stack) > 1:
                    stack.pop()
            elif not selfclose:
                stack.append(rp._mat_mul(stack[-1], rp._parse_transform(attrs)))
            continue
        if close:
            continue
        a = dict(rp._ATTR.findall(attrs))
        # A frame is a STROKE, not a fill — which is also what keeps the
        # full-bleed background rect out of the running now that this no longer
        # requires an inset from the card edge.
        if (a.get("fill") or "").strip() != "none":
            continue
        stroke = (a.get("stroke") or "").strip()
        if not stroke or stroke == "none":
            continue
        t = rp._mat_mul(stack[-1], rp._parse_transform(attrs))
        radius = None
        if name == "rect":
            try:
                rx, ry = float(a.get("x", 0)), float(a.get("y", 0))
                rw, rh = float(a["width"]), float(a["height"])
            except (KeyError, ValueError):
                continue
            pts = [(rx, ry), (rx + rw, ry), (rx, ry + rh), (rx + rw, ry + rh)]
            try:
                radius = float(a.get("rx") or a.get("ry") or 0)
            except ValueError:
                radius = 0.0
        else:
            pts = _on_curve(a.get("d"))
            if not pts:
                continue
        xs = [t[0] * x + t[2] * y + t[4] for x, y in pts]
        ys = [t[1] * x + t[3] * y + t[5] for x, y in pts]
        box = [min(xs), min(ys), max(xs), max(ys)]
        if box[2] - box[0] < FRAME_MIN_SPAN * w or box[3] - box[1] < FRAME_MIN_SPAN * h:
            continue
        if (box[0] < x0c - slack_x or box[1] < y0c - slack_y
                or box[2] > x1c + slack_x or box[3] > y1c + slack_y):
            continue
        scale = abs(t[0] * t[3] - t[1] * t[2]) ** 0.5
        radius = radius * scale if radius is not None else _corner_radius(xs, ys, box)
        try:
            stroke_width = float(a.get("stroke-width", 1))
        except ValueError:
            stroke_width = 1.0
        found = {"x": box[0], "y": box[1], "w": box[2] - box[0],
                 "h": box[3] - box[1], "r": radius, "stroke": stroke,
                 "stroke_width": stroke_width * scale}
        if best is None or box[3] < best["y"] + best["h"]:
            best = found
    return best


def front_frame(theme_name):
    """The frame of ``theme_name``'s front card, or None when it has none.

    The first front the template actually ships, for the same reason
    ``card_paper.front_paper`` measures only the first: the eight fronts are
    colourways of one design, not eight designs, so they share a frame.

    A v1 (8-up sheet) template answers None, and correctly so — it has no
    numbered cards, and the v2 deck is the only thing that prints a pawn card at
    all (``build.deck_document``). There is no card of theirs to match.
    """
    cfg = config.theme(theme_name)
    if not config.is_single_card(cfg):
        return None
    for path in config.front_paths(theme_name):
        if os.path.exists(path):
            return _frame_of_file(path)
    return None


def _frame_of_file(path):
    """``frame()`` of the card at ``path``, cached on the file's bytes.

    Cached on CONTENT, like ``card_paper.paper``: the same artwork reached
    through an owner overlay and through the image costs one parse, and a deck
    that asks per card asks once.
    """
    import deck_html

    try:
        with open(path, "rb") as f:
            blob = f.read()
    except OSError:
        return None
    key = hashlib.sha1(blob).hexdigest()
    if key in _cache:
        return _cache[key]
    svg = blob.decode("utf-8", "replace")
    try:
        vb = deck_html.view_box(svg)
        answer = frame(svg, [vb[0], vb[1], vb[0] + vb[2], vb[1] + vb[3]])
        # Degrade, but SAY WHICH. "Broken artwork" and "a design that draws no
        # border" both leave the pawn card alone, and only one of them is a bug.
        if answer is None:
            _warn("%s draws no frame this can measure — the pawn card keeps its "
                  "own" % os.path.basename(path))
    except Exception as exc:  # noqa: BLE001 - any failure means "no measurement"
        _warn("could not read %s (%s: %s) — the pawn card keeps its own frame"
              % (os.path.basename(path), type(exc).__name__, exc))
        answer = None
    _cache[key] = answer
    return answer


def own_frame(svg_text):
    """The pawn card's OWN frame — the element it marked ``card-frame`` — or None.

    Read straight off the marked element rather than searched for, because a
    pawn card is authored by hand (docs/photo-card.md, "Size discipline") and can
    simply say which element is its frame. A card that marks none is left alone.
    """
    m = _FRAME_EL.search(svg_text or "")
    if not m:
        return None
    el = m.group(0)
    try:
        box = {"x": float(_ATTR_OF(el, "x") or 0), "y": float(_ATTR_OF(el, "y") or 0),
               "w": float(_ATTR_OF(el, "width")), "h": float(_ATTR_OF(el, "height")),
               "r": float(_ATTR_OF(el, "rx") or _ATTR_OF(el, "ry") or 0),
               "stroke": (_ATTR_OF(el, "stroke") or "").strip(),
               "stroke_width": float(_ATTR_OF(el, "stroke-width") or 1)}
    except (TypeError, ValueError):
        return None
    return box


def content_box(svg_text):
    """``[x0, y0, x1, y1]`` the pawn card's own content occupies, or None.

    The four slots — grown by the halo, which prints and therefore counts — and
    every outlined copy path. What a frame has to CONTAIN to be usable: a frame
    measured off a front card is the right shape for the deck, but a frame drawn
    through the pawn grid is worse than one that merely does not match.

    Rects are excluded on purpose. The only rects on a pawn card are its paper
    and its frame — both full-bleed or near it — and grapefruit's stripes, which
    are decoration running the full height. Including any of them would make the
    box the whole card and refuse every frame.
    """
    import render_page as rp

    body = rp._DEFS_BLOCK.sub("", svg_text or "")
    boxes = []
    for m in _SLOT_EL.finditer(body):
        el = m.group(0)
        try:
            x, y = float(_ATTR_OF(el, "x")), float(_ATTR_OF(el, "y"))
            w, h = float(_ATTR_OF(el, "width")), float(_ATTR_OF(el, "height"))
        except (TypeError, ValueError):
            continue
        boxes.append([x - HALO, y - HALO, x + w + HALO, y + h + HALO])
    rule = set(m.group(0) for m in _RULE_EL.finditer(body))
    for m in re.finditer(r"<path\b[^>]*/\s*>", body):
        el = m.group(0)
        if el in rule:                      # the rule is anchored TO the frame
            continue
        pts = _on_curve(_ATTR_OF(el, "d"))
        if not pts:
            continue
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        boxes.append([min(xs), min(ys), max(xs), max(ys)])
    if not boxes:
        return None
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _same(a, b):
    return (a is not None and b is not None
            and all(abs(a[k] - b[k]) <= FRAME_TOL
                    for k in ("x", "y", "w", "h", "r", "stroke_width"))
            and (a["stroke"] or "").lower() == (b["stroke"] or "").lower())


def reframe(svg_text, target):
    """``svg_text`` with its ``card-frame`` redrawn as ``target``.

    The frame's box, its corner radius, its stroke width and its stroke colour
    all move, because all four are what "the same card" means: a hairline black
    rectangle at a 14-unit pink band's centreline is neither the same size nor
    recognisably the same design. The card's FILL does not move — grapefruit
    fills its frame with the paper and the generic card leaves it open, and that
    is each card's own decision. ``card_paper.repaper`` owns colour of paper;
    this owns shape of frame.

    Anything the artwork anchors to the frame moves with it: a
    ``card-frame-rule`` path is re-spanned across the new frame's width at its
    own height.

    Returns ``svg_text`` UNCHANGED when there is nothing to measure, nothing
    marked, the two already agree, or the new frame would not contain the card's
    pawns and copy.
    """
    if not target or not svg_text:
        return svg_text
    current = own_frame(svg_text)
    if current is None or _same(current, target):
        return svg_text
    # HALF the stroke, because a stroke is centred on its path: the border's
    # inner painted edge is half a width in from the box. (``frame_box`` takes the
    # WHOLE width off for word layout, which is deliberate conservatism about how
    # much paper the words may use. The question here is narrower — does the
    # border land ON the pawns — and half is the honest answer to that one. On a
    # 14-unit band the difference decides it.)
    inner = target["stroke_width"] / 2.0
    interior = [target["x"] + inner, target["y"] + inner,
                target["x"] + target["w"] - inner, target["y"] + target["h"] - inner]
    content = content_box(svg_text)
    if content and (content[0] < interior[0] or content[1] < interior[1]
                    or content[2] > interior[2] or content[3] > interior[3]):
        _warn("the deck's frame (%.2f %.2f %.2f x %.2f) does not contain the pawn "
              "card's own content (%.2f %.2f %.2f %.2f) — keeping the card's own "
              "frame" % (target["x"], target["y"], target["w"], target["h"],
                         content[0], content[1], content[2], content[3]))
        return svg_text
    return _RULE_EL.sub(lambda m: _respan(m.group(0), target),
                        _FRAME_EL.sub(lambda m: _redraw(m.group(0), target), svg_text,
                                      count=1))


def _num(value):
    """A card coordinate as the artwork writes them: two decimals, no trailing 0s."""
    return ("%.2f" % round(value, 2)).rstrip("0").rstrip(".") or "0"


def _set(el, name, value):
    """``el`` with attribute ``name`` set to ``value``, added if it had none."""
    pattern = re.compile(r'(\b%s\s*=\s*")[^"]*(")' % re.escape(name))
    if pattern.search(el):
        return pattern.sub(lambda m: m.group(1) + value + m.group(2), el, count=1)
    return _SELF_CLOSE.sub("", el) + ' %s="%s"/>' % (name, value)


def _redraw(el, target):
    for name, value in (("x", target["x"]), ("y", target["y"]),
                        ("width", target["w"]), ("height", target["h"]),
                        ("rx", target["r"]), ("ry", target["r"]),
                        ("stroke-width", target["stroke_width"])):
        el = _set(el, name, _num(value))
    if target["stroke"]:
        el = _set(el, "stroke", target["stroke"])
    return el


def _respan(el, target):
    """A horizontal rule re-drawn across the new frame, keeping its own height."""
    d = _ATTR_OF(el, "d") or ""
    y = re.match(r"\s*M\s*[-\d.]+[ ,]+([-\d.]+)", d)
    if not y:
        return el
    return _set(el, "d", "M%s %sH%s" % (_num(target["x"]), y.group(1),
                                        _num(target["x"] + target["w"])))
