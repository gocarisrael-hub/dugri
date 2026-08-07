#!/usr/bin/env python3
"""Tests for the pawn card's WHITE STICKER OUTLINE — where it lands, and its shape.

The owner, looking at a printed pawn sheet: *"i think the pawns dont overflow but
the white borderline around them does, and it also not good."*

Both halves are true, and #359 had only checked the first. The pawns' own ink
reaches r 28.3 – 29.3 against a dotted cut-line at r = 33, comfortably inside.
The white halo is what crosses: measured off a real render at 10 px per card
unit, it reached **32.84** on a fallback pawn and **33.38** on a customer photo —
i.e. a photo's ring was drawn OUTSIDE the line it is meant to sit inside, which
is why the dashes vanished under it instead of showing through.

#359 quoted the halo as "≈ 97 of 100" because it added the dilation radius once.
``feMorphology`` dilates with a SQUARE structuring element: a shape grows by
``radius`` along the axes but by ``radius × √2`` at any convex corner — and a
disc, which is nothing but corners, grows by ``radius × √2`` in every direction.
That factor is the whole of the miss, and it is also the second half of her
complaint: an un-smoothed square kernel leaves visible right-angled white corners
at the foot of every pawn.

``tests/unit/photo-card.test.js`` bounds the same thing from the filter's numbers
alone, so CI catches a regression without a browser. This file is the check that
the model is not fiction: it RENDERS the card and measures the pixels.

Run: python3 -m pytest generator/test_photo_card_halo.py
"""
import math
import os
import re
import tempfile

import pytest

import build
import card_paper
import config
import render_page as rp

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
GENERIC = os.path.join(REPO, "resources", "canva", "templates", "_shared",
                       "photo-card", "photo.svg")
GRAPEFRUIT = os.path.join(REPO, "resources", "canva", "templates", "grapefruit",
                          "clean", "photo.svg")
CARDS = {"generic": GENERIC, "grapefruit": GRAPEFRUIT}

CUT_R = 33.0                      # the dashed cut-line, in card units
SLOTS = [(72.93, 120.0), (150.93, 120.0), (72.93, 198.0), (150.93, 198.0)]
PPU = 10                          # render scale: px per card unit
W, H = 223.92, 312.0

# How much paper must stay between the white ring and the dashes. 1 card unit is
# 0.28 mm. Not zero, because this is a physical cut with a physical tolerance: a
# ring ending exactly on the line is a ring the scissors take off.
MIN_RING_CLEARANCE = 1.0
# The shadow is fainter and cast downward, so it is allowed nearer the line — but
# still not across it.
MIN_SHADOW_CLEARANCE = 0.25


def _filter(path):
    with open(path, encoding="utf-8") as f:
        return re.search(r'<filter id="sticker-halo".*?</filter>', f.read(), re.S).group(0)


def test_both_photo_cards_halo_identically_bar_the_shadow_colour():
    """One filter, two cards. A photo card that haloed differently from the
    generic one would print a different product depending on the template."""
    strip = lambda s: re.sub(r'flood-color="#[0-9a-fA-F]{6}"', "", s)  # noqa: E731
    assert strip(_filter(GENERIC)) == strip(_filter(GRAPEFRUIT))


def test_the_halo_is_still_built_from_the_images_own_alpha():
    """Not a disc behind the photo — the ring follows the subject's silhouette."""
    f = _filter(GENERIC)
    assert 'in="SourceAlpha"' in f and 'operator="dilate"' in f
    assert 'flood-color="#ffffff"' in f, "the ring is white by contract"


# --------------------------------------------------------------------------
# the real thing, with a real browser
# --------------------------------------------------------------------------

def _has_chrome():
    import shutil
    exe = card_paper.chrome.binary()
    return os.path.exists(exe) or shutil.which(os.path.basename(exe))


needs_chrome = pytest.mark.skipif(not _has_chrome(), reason="no Chrome")

MAGENTA = (255, 0, 255)


def _render(theme, images, workdir, name):
    """The pawn card on a MAGENTA ground with its cut-lines removed.

    Magenta because the halo is white and four of the eight shipped papers are
    near-white: on those the ring cannot be separated from the paper at all, and
    the sticker's geometry is identical on every template anyway. The cut-lines
    come out so that what is measured is the sticker and nothing else — the
    dashed circle is itself ink at r = 33.3.
    """
    svg = rp.photo_card_svg(theme, images, paper="#ff00ff")
    svg = re.sub(r'<circle class="cut-line"[^>]*/>', "", svg)
    svg = re.sub(r'(<svg\b[^>]*?)\swidth="[^"]*"', r"\1", svg, count=1)
    svg = re.sub(r'(<svg\b[^>]*?)\sheight="[^"]*"', r"\1", svg, count=1)
    svg = svg.replace("<svg", f'<svg width="{W * PPU}" height="{H * PPU}"', 1)
    src = os.path.join(workdir, name + ".svg")
    with open(src, "w", encoding="utf-8") as f:
        f.write(svg)
    png = os.path.join(workdir, name + ".png")
    card_paper.chrome.screenshot(src, png, W * PPU + 40, H * PPU + 40, scale=1,
                                 font_wait=False)
    from PIL import Image
    return Image.open(png).convert("RGB")


def _reach(im):
    """(white ring, ring + shadow) — the furthest either gets from a slot centre.

    Worst case over all four slots, in card units.
    """
    px = im.load()
    ring = shade = 0.0
    for cx, cy in SLOTS:
        CX, CY = cx * PPU, cy * PPU
        for y in range(int(CY - 40 * PPU), int(CY + 40 * PPU)):
            for x in range(int(CX - 40 * PPU), int(CX + 40 * PPU)):
                if not (0 <= x < im.width and 0 <= y < im.height):
                    continue
                r, g, b = px[x, y]
                d = math.hypot(x + 0.5 - CX, y + 0.5 - CY) / PPU
                if d > 40:
                    continue
                if min(r, g, b) > 200:
                    ring = max(ring, d)
                # anything that darkened the magenta by more than ~6%
                if (255 - r) + (255 - b) < 30 and g < 40:
                    continue
                shade = max(shade, d)
    return ring, shade


def _opaque_photo(workdir):
    """A customer photo through the generator's own prep — the WORST case.

    Opaque, so there is no subject alpha to frame on and ``square_photo`` falls
    through to the disc clip, filling the slot's disc edge to edge. That disc is
    the largest thing any slot ever receives, and being a disc it is also the
    shape a square dilation kernel treats worst.
    """
    from PIL import Image
    src = os.path.join(workdir, "src.png")
    Image.new("RGB", (900, 1200), (20, 90, 200)).save(src)
    return build.square_photo(src, workdir, index=0)


@needs_chrome
def test_no_fallback_pawns_white_border_reaches_the_cut_line():
    with tempfile.TemporaryDirectory() as tmp:
        im = _render("bachelorette", config.photo_fallback_paths("bachelorette"),
                     tmp, "pawns")
    ring, shade = _reach(im)
    assert ring > 20, "no white ring rendered at all — the halo has been lost"
    assert ring <= CUT_R - MIN_RING_CLEARANCE, f"pawn ring reaches {ring:.2f}"
    assert shade <= CUT_R - MIN_SHADOW_CLEARANCE, f"pawn shadow reaches {shade:.2f}"


@needs_chrome
def test_no_customer_photos_white_border_reaches_the_cut_line():
    """The binding case, and the one that was actually over the line at 33.38."""
    with tempfile.TemporaryDirectory() as tmp:
        im = _render("bachelorette", [_opaque_photo(tmp)] * 4, tmp, "photo")
    ring, shade = _reach(im)
    assert ring > 20, "no white ring rendered at all — the halo has been lost"
    assert ring <= CUT_R - MIN_RING_CLEARANCE, f"photo ring reaches {ring:.2f}"
    assert shade <= CUT_R - MIN_SHADOW_CLEARANCE, f"photo shadow reaches {shade:.2f}"


@needs_chrome
def test_a_photos_white_border_is_round_not_square_cornered():
    """The other half of "it also not good".

    A disc dilated by a square kernel is a rounded SQUARE: it reaches ``radius``
    along the axes and ``radius × √2`` on the diagonals, so the white ring is
    visibly fatter at four o'clock than at three.

    **The blur does not fix this one, and it is worth saying why.** Dilating a
    disc by a square is a Minkowski sum, so the result's "corners" are arcs of
    the original disc — radius 29.7, not sharp — and blur-and-threshold only
    erodes sharp curvature. A broad, low-curvature bulge survives any σ (measured
    per degree: σ = 1.2, 1.5, 1.8 and 2.2 all give the same 0.70). What the blur
    DOES round off is the genuinely sharp corners the same kernel leaves on a
    silhouette, which is what used to print as right-angled white blocks at the
    foot of every pawn.

    So a disc's ring can only be made rounder by dilating it LESS. Measured, at
    the top of one slot, per degree:

        as shipped (dilate 2.4)   ring 32.30 – 33.40   out-of-round 1.10
        now        (dilate 1.5)   ring 31.10 – 31.80   out-of-round 0.70
        no dilation at all        ring 29.80 – 30.00   out-of-round 0.20

    — the 0.20 floor being the raster grid, since the slot's 512 px cutout is
    scaled into 66 card units. The bound below is therefore a bound on the
    DILATION, expressed where it is visible.
    """
    with tempfile.TemporaryDirectory() as tmp:
        im = _render("bachelorette", [_opaque_photo(tmp)] * 4, tmp, "photo")
    px = im.load()
    cx, cy = SLOTS[0]
    CX, CY = cx * PPU, cy * PPU
    edges = []
    for deg in range(360):
        a = math.radians(deg)
        far = 0.0
        for step in range(int(40 * PPU)):
            d = step / PPU
            x = int(CX + math.cos(a) * step)
            y = int(CY + math.sin(a) * step)
            if not (0 <= x < im.width and 0 <= y < im.height):
                break
            if min(px[x, y]) > 200:
                far = d
        edges.append(far)
    spread = max(edges) - min(edges)
    assert spread <= 0.75, (
        f"the ring is {spread:.2f} units fatter on one bearing than another — "
        "the square dilation kernel is showing through"
    )


@needs_chrome
def test_every_shipped_template_keeps_its_pawns_ring_inside_the_cut_line():
    """Shared artwork checked on one deck is not checked.

    The sticker geometry is identical on every card by contract, but the FRAME
    and the PAPER are redrawn per deck at composition time, so the composed card
    is not the same file twice.
    """
    bad = {}
    with tempfile.TemporaryDirectory() as tmp:
        for theme in sorted(config.load_themes()):
            im = _render(theme, config.photo_fallback_paths(theme), tmp,
                         theme.replace(" ", "-"))
            ring, shade = _reach(im)
            if ring > CUT_R - MIN_RING_CLEARANCE or shade > CUT_R - MIN_SHADOW_CLEARANCE:
                bad[theme] = (round(ring, 2), round(shade, 2))
    assert not bad, f"ring/shadow crosses the cut-line on {bad}"
