#!/usr/bin/env python3
"""What colour is a card's PAPER — and repainting the pawn card onto it.

The pawn ("photo") card ships with the buyer's deck, so it has to look like it
belongs to that deck. Its paper is therefore not a constant and not one colour
for all templates: it is **the paper of that template's own front card**,
measured off the artwork.

Why it is MEASURED and not read out of the vector
-------------------------------------------------
The obvious shortcut — "take the fill of the full-bleed rectangle at the top of
the front SVG" — is wrong, and grapefruit is the counter-example that proves it.
Its ``clean/2.svg`` opens with two full-bleed paths, ``#ffffff`` then
``#f4f1eb``, and neither is the paper: both are Canva underlay, painted over by
a rounded panel that covers ~78% of the card in ``#fffdf1``. The vector rule
answers ``#f4f1eb``; the card a buyer holds is ``#fffdf1``.

So this asks the same question calibration asks, the same way. ``calibrate``'s
``_background`` is "the mode of the un-inked pixels" of a rendered crop — the
reasoning that stopped the title pass mistaking a card's own background for a
title paint. A ``clean/`` card is un-inked by definition (no personalisation has
been laid on it yet), so the whole card is the crop and the mode is the paper.
One rasterise, one ``Counter``.

That definition degrades honestly on a front that has no paper — a photographic
or heavily patterned one. A continuous-tone image has no colour holding a large
share of the card, so the mode is just the luckiest pixel. ``PAPER_MIN_SHARE``
is the line: below it this returns None and the pawn card keeps the background
it was drawn with, rather than being repainted an arbitrary sampled colour.
Measured across the nine shipped templates the real answers sit at 71.7%-92.8%
(flat, striped, and photographically bordered fronts alike), so the floor is
nowhere near any of them.

Everything here also degrades to None when Chrome is missing or fails. The pawn
card's own shipped background is always a valid answer, so a colour we could not
measure must never cost a customer their deck.
"""
import hashlib
import os
import re
import sys
import tempfile
from collections import Counter

import chrome
import config

# The smallest share of the card one colour must hold to count as its paper.
# Well under every shipped template (the lowest is 71.7%) and far above what any
# single colour reaches in a continuous-tone photograph.
PAPER_MIN_SHARE = 0.25

# Rendered at 1x: the mode of a flat area does not need resolution, and this runs
# once per deck. A 224x312 raster is ~70k pixels to count.
_SCALE = 1

_VIEWBOX = re.compile(r'\bviewBox="([^"]+)"')
_WIDTH = re.compile(r'\bwidth="([\d.]+)"')
_HEIGHT = re.compile(r'\bheight="([\d.]+)"')
_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

_cache = {}


def _dims(head):
    """The pixel size Chrome will lay a standalone SVG document out at.

    Its own ``width``/``height`` when it declares them — grapefruit's fronts are
    299x416 over a 223.92x312 viewBox, and a window sized from the viewBox would
    crop three quarters of the card away. The viewBox is the fallback.

    The window must not be BIGGER than the document either: the margin around it
    renders white and lands in the count as if it were paper.
    """
    # The ROOT tag only. A bare `width="…"` search would happily answer with the
    # first child rect's width on an SVG whose root sizes itself off its viewBox.
    root = re.search(r"<svg\b[^>]*>", head)
    head = root.group(0) if root else head
    w, h = _WIDTH.search(head), _HEIGHT.search(head)
    if w and h:
        return float(w.group(1)), float(h.group(1))
    vb = _VIEWBOX.search(head)
    if vb:
        nums = [float(n) for n in vb.group(1).replace(",", " ").split()]
        if len(nums) == 4:
            return nums[2], nums[3]
    raise ValueError("SVG declares neither width/height nor a viewBox")


def paper(svg_path, workdir=None):
    """``'#rrggbb'`` — the dominant colour of the card at ``svg_path``, or None.

    None means "this card has no paper": either the render failed, or no single
    colour holds ``PAPER_MIN_SHARE`` of it. Both are states a caller must handle
    by leaving whatever it already had alone.

    Cached on the artwork's CONTENT, not its path, so the same card measured
    through a dozen different template directories costs one render.
    """
    try:
        with open(svg_path, "rb") as f:
            blob = f.read()
    except OSError:
        return None
    key = hashlib.sha1(blob).hexdigest()
    if key in _cache:
        return _cache[key]
    _cache[key] = value = _measure(svg_path, blob, key, workdir)
    return value


def _measure(svg_path, blob, key, workdir):
    from PIL import Image
    try:
        w, h = _dims(blob[:2000].decode("utf-8", "ignore"))
        tmp = workdir or tempfile.gettempdir()
        os.makedirs(tmp, exist_ok=True)
        # Named for the artwork's CONTENT, not its basename. Every v1 template's
        # front sheet is called "fronts.svg", so a shared temp directory would
        # give them all one output file — and ``chrome._run`` treats "the file
        # exists" as success, so a failed render would quietly be read as the
        # PREVIOUS template's colours instead of raising.
        out = os.path.join(tmp, "paper-%s.png" % key[:16])
        # font_wait off: a clean card carries no personalised text, so there is
        # no @font-face to wait for and the virtual clock would only cost time.
        chrome.screenshot("file://" + os.path.abspath(svg_path), out, w, h,
                          scale=_SCALE, font_wait=False,
                          what="paper colour of %s" % os.path.basename(svg_path))
        with Image.open(out) as im:
            rgb = im.convert("RGB")
            total = rgb.size[0] * rgb.size[1]
            (top, n), = Counter(rgb.getdata()).most_common(1)
    except Exception as exc:  # noqa: BLE001 - every failure means "no measurement"
        # Degrade, but SAY SO. A silent None is indistinguishable from "this
        # front has no paper", and the two want opposite responses: one is a
        # design, the other is a broken browser. A Chrome timeout is not a
        # measurement, and nothing downstream can tell unless this line exists.
        _warn("could not render %s (%s: %s) — the pawn card keeps its own "
              "background" % (os.path.basename(svg_path), type(exc).__name__, exc))
        return None
    if not total or n / float(total) < PAPER_MIN_SHARE:
        _warn("%s has no dominant colour (best %.1f%%, floor %.0f%%) — it is "
              "patterned or photographic, so the pawn card keeps its own "
              "background" % (os.path.basename(svg_path),
                              100.0 * n / float(total or 1),
                              100.0 * PAPER_MIN_SHARE))
        return None
    return "#%02x%02x%02x" % top


def _warn(message):
    print("card_paper: " + message, file=sys.stderr)


def front_paper(theme_name, workdir=None):
    """The paper of ``theme_name``'s front card, or None when it has none.

    The first front the template actually ships. Every shipped template paints
    all eight of its fronts on one paper — they are colourways of one design, not
    eight designs — so the first is the deck's answer and measuring all eight
    would cost eight renders to confirm it.

    A v1 (8-up sheet) template has no numbered cards; its ``clean/fronts.svg``
    holds the same eight fronts on one sheet, and the cards cover enough of it
    that the mode is still the card paper rather than the gutter. That matters
    beyond tidiness: v1 templates are what the owner's store is being migrated
    FROM, and a half-migrated one must not answer "no paper".
    """
    for path in config.front_paths(theme_name):
        if os.path.exists(path):
            return paper(path, workdir=workdir)
    sheet = config.clean_path(theme_name, "fronts")
    if os.path.exists(sheet):
        return paper(sheet, workdir=workdir)
    return None


def own_paper(svg_text):
    """The colour a card is painted on, read from its own markup, or None.

    Read from the VECTOR here, unlike ``paper()`` — and legitimately so, because
    this is only ever asked of a pawn card, and those are authored by hand rather
    than exported from Canva (``docs/photo-card.md``, "Size discipline"). A
    hand-authored card opens with one full-bleed ``<rect>`` in its paper colour
    and nothing underneath it, so there is no underlay to be fooled by and no
    reason to spend a second render.
    """
    vb = _VIEWBOX.search(svg_text or "")
    if not vb:
        return None
    nums = [float(n) for n in vb.group(1).replace(",", " ").split()]
    if len(nums) != 4:
        return None
    x0, y0, w, h = nums
    # <defs> first: a full-bleed rect in there is a clip path or a mask, not
    # paint. grapefruit's card opens with exactly that — a bleed clip the same
    # size as the paper it is about to draw.
    body = re.sub(r"<defs\b.*?</defs>", "", svg_text, flags=re.S)
    for m in re.finditer(r"<rect\b[^>]*/>", body):
        el = m.group(0)
        try:
            box = (float(_attr(el, "x", x0)), float(_attr(el, "y", y0)),
                   float(_attr(el, "width", 0)), float(_attr(el, "height", 0)))
        except (TypeError, ValueError):
            continue
        if (abs(box[0] - x0) > 0.5 or abs(box[1] - y0) > 0.5
                or box[2] < w - 0.5 or box[3] < h - 0.5):
            continue
        # A full-bleed rect painted with a gradient, `none`, or nothing at all is
        # not a paper colour — keep looking rather than answering "no paper",
        # since the flat rect painted OVER it would be the real answer.
        fill = _attr(el, "fill", None)
        if fill and _HEX.match(fill):
            return fill.lower()
    return None


def _attr(el, name, default=None):
    m = re.search(r'\b%s="([^"]*)"' % name, el)
    return m.group(1) if m else default


def repaper(svg_text, colour):
    """``svg_text`` with its paper repainted ``colour``.

    Every element filled in the card's OWN paper colour moves, not just the
    full-bleed rectangle underneath. Grapefruit's pawn card is why: its paper
    appears twice, once as the full-bleed base and again as the rounded panel the
    pawns actually sit on, and repainting only the base would change a colour
    that is covered by stripes and fruit — a diff that renders identically.
    Anything sharing the paper colour IS the paper.

    Only ``fill`` attributes are touched. ``flood-color`` is left alone on
    purpose: the sticker halo is ``#ffffff`` by contract on every template, and
    on the generic card that is also the paper colour.

    Returns ``svg_text`` unchanged when ``colour`` is None (nothing was measured),
    when the card's own paper cannot be read, or when the two already agree.
    """
    if not colour or not _HEX.match(str(colour)):
        return svg_text
    current = own_paper(svg_text)
    if not current or current == colour.lower():
        return svg_text
    return re.sub(r'(\bfill=")(%s)(")' % re.escape(current),
                  lambda m: m.group(1) + colour.lower() + m.group(3),
                  svg_text, flags=re.IGNORECASE)
